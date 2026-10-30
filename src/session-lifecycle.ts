import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { imageLink, toolImageLinks } from "./content.js";
import { RequestError, type AgentSideConnection, type ClientCapabilities } from "@agentclientprotocol/sdk";
import type { Agent, McpServer, SessionUpdate, FileSystemCapabilities } from "@agentclientprotocol/sdk";
import { sessionConfiguration } from "./models.js";
import { sessionBusy, bridgeError, errorDetail, sessionNotFound, SESSION_ACTIVE_WRITER } from "./errors.js";
import { ApprovalGate, type ApprovalMode } from "./approvals.js";
import { ClientFileSystem } from "./client-filesystem.js";
import { availableCommands, createWorkspaceSession, type BridgeSession } from "./sessions.js";
import { SessionIndex, type SessionRecord } from "./session-index.js";
import { SessionCatalog } from "./session-catalog.js";
import { SessionLease } from "./session-lease.js";
import { replayHistory } from "./history.js";
import { clientMcpEntries } from "./client-mcp.js";
import { ImageLinkStream } from "./image-links.js";
import { bindExtensionUI } from "./extension-ui.js";
import { nativeQuestions, Questions } from "./questions.js";

import { createConfigCoordinator } from "./config-coordinator.js";
import type { ManagedSession, SessionHost } from "./managed-session.js";

import type { ServerOptions } from "./server.js";

type LifecycleOptions = Pick<ServerOptions, "sessionIndexPath" | "sessionDir" | "createSession"> & {
  client: AgentSideConnection;
  artifactDir: string;
  trace: SessionHost["trace"];
};

export function createSessionLifecycle({
  client, artifactDir, sessionIndexPath, sessionDir, trace, createSession = createWorkspaceSession,
}: LifecycleOptions) {
  const sessions = new Map<string, ManagedSession>();
  const loading = new Set<string>();
  const forking = new Set<string>();
  const deleting = new Set<string>();
  const closing = new Map<string, Promise<void>>();
  const closingFiles = new Map<string, Promise<void>>();
  const opening = new Set<Promise<unknown>>();
  const disposing = new Set<Promise<void>>();
  const index = new SessionIndex(sessionIndexPath);
  const catalog = new SessionCatalog(index, sessionDir);
  const leaseDirectory = join(sessionIndexPath ? dirname(sessionIndexPath) : getAgentDir(), "acp-session-locks");
  let closed = false;
  let elicitationForm = false;
  let fileSystemCapabilities: FileSystemCapabilities = {};
  function getSession(id: string) {
    const entry = sessions.get(id);
    if (!entry || deleting.has(id) || closing.has(id)) throw sessionNotFound(id);
    if (forking.has(id)) throw sessionBusy("Session is being forked");
    return entry;
  }
  function openSession<T>(work: () => Promise<T>): Promise<T> {
    if (closed) throw new RequestError(-32603, "Connection closed");
    const pending = work();
    opening.add(pending);
    const remove = () => opening.delete(pending);
    void pending.then(remove, remove);
    return pending;
  }
  async function createWithPolicy(cwd: string, file: string | undefined, servers: McpServer[] | undefined, id: string | undefined, fs: ClientFileSystem) {
    const approval = new ApprovalGate(client);
    const session = await createSession(cwd, file, servers, id, fs, approval);
    // Custom factories that omit the policy must not advertise unenforced modes.
    if (approval.installed) session.bridgeApproval = approval;
    return session;
  }
  async function bind(entry: ManagedSession, sessionId: string, fallbackPolicy?: ApprovalMode) {
    entry.session.bridgeApproval?.bind(sessionId, entry.session.sessionManager, fallbackPolicy);
    entry.notices = (entry.session.bridgeDiagnostics?.startupNotices ?? []).map(notice => `${errorDetail(notice)}\n`);
    const elicit = elicitationForm ? nativeQuestions(client, sessionId) : undefined;
    entry.questions = new Questions(elicit && (async (...args) => {
      const active = entry.active;
      if (!active || active.cancelled) throw new Error("Forms require an active prompt");
      await active.flush?.();
      if (entry.active !== active || active.cancelled) throw new Error("Form cancelled");
      return elicit(...args);
    }));
    await bindExtensionUI(entry.session, (text) => {
      if (entry.active?.notify) entry.active.notify(text);
      else entry.notices!.push(text);
    }, entry.questions);
    entry.unsubscribeMetadata = entry.session.subscribe((event) => {
      if (event.type !== "session_info_changed" || entry.active?.cancelled) return;
      const update: SessionUpdate = { sessionUpdate: "session_info_update", title: event.name ?? null };
      if (entry.active?.update) void entry.active.update(update);
      else void client.sessionUpdate({ sessionId, update }).catch(() => {});
    });
  }
  function dispose(entry: ManagedSession) {
    const pending = disposeSession(entry);
    disposing.add(pending);
    void pending.then(() => disposing.delete(pending), () => disposing.delete(pending));
    return pending;
  }
  async function disposeSession(entry: ManagedSession) {
    entry.waitingPrompt?.abort();
    if (entry.active) {
      entry.active.cancelled = true;
      entry.session.bridgeApproval?.cancelTurn();
      entry.active.unsubscribe();
      entry.questions?.cancel();
      const settled = entry.active.settled;
      await entry.session.abort().catch(() => {});
      // Reload cannot be interrupted; dispose its replacement runner, not the old one.
      await settled;
    }
    await entry.changingConfiguration;
    entry.unsubscribeMetadata?.();
    try {
      await entry.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      try {
        entry.session.dispose();
      } finally {
        entry.lease?.release();
      }
    }
  }
  function closeManaged(sessionId: string) {
    const entry = sessions.get(sessionId);
    if (!entry) return closing.get(sessionId) ?? Promise.resolve();
    if (closing.has(sessionId)) return closing.get(sessionId)!;
    // Keep the entry reachable until its cancelled prompt drains tool updates.
    const pending = dispose(entry);
    closing.set(sessionId, pending);
    const file = entry.session.sessionFile;
    if (file) closingFiles.set(file, pending);
    const remove = () => {
      if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
      closing.delete(sessionId);
      if (file) closingFiles.delete(file);
    };
    void pending.then(remove, remove);
    return pending;
  }
  async function leaseRecord(record: SessionRecord & { id: string }, lease: SessionLease) {
    for (;;) {
      await lease.acquire(record.sessionFile);
      const latest = await index.get(record.id);
      if (!latest) return record;
      if (latest.deleted) throw sessionNotFound(record.id);
      if (latest.sessionFile === record.sessionFile) return { id: record.id, ...latest };
      // A pending session may have moved while this operation was resolving it.
      record = { id: record.id, ...latest };
    }
  }
  async function indexSession(sessionId: string, entry: ManagedSession) {
    const sessionFile = entry.session.sessionFile;
    if (!sessionFile) return;
    const pending = await stat(sessionFile).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    });
    await index.set(sessionId, { cwd: entry.cwd, sessionFile, nativeId: entry.session.sessionManager?.getSessionId(), ...(pending ? { pending: true } : {}),
      ...(entry.session.bridgeApproval ? { approvalMode: entry.session.bridgeApproval.mode } : {}),
    });
  }
  async function advertiseSession(sessionId: string, entry: ManagedSession) {
    const { session } = entry;
    const state = await sessionConfiguration(session);
    const { warning, ...configuration } = state;
    if (closed) throw new Error("Connection closed");
    if (session.sessionName) await client.sessionUpdate({ sessionId, update: {
      sessionUpdate: "session_info_update", title: session.sessionName,
    } });
    await warnConfiguration(sessionId, entry, warning);
    await publishUsage(sessionId, session);
    if (session.resourceLoader) await client.sessionUpdate({ sessionId, update: {
      sessionUpdate: "available_commands_update", availableCommands: availableCommands(session),
    } });
    if (closed) throw new Error("Connection closed");
    entry.configurationSignature = JSON.stringify(state);
    sessions.set(sessionId, entry);
    trace({ event: "session_ready", sessionId });
    return configuration;
  }
  const host: SessionHost = {
    sessions, deleting, forking, getSession, indexSession, trace,
    isClosed: () => closed,
    sendUpdate: params => client.sessionUpdate(params),
  };
  const configuration = createConfigCoordinator(host);
  const { warnConfiguration, publishUsage } = configuration;
  const methods: Pick<Agent, "newSession" | "loadSession" | "listSessions" | "unstable_forkSession" | "cancel" | "closeSession" | "deleteSession"> = {
    newSession: (params) => openSession(async () => {
      trace({ event: "session_open", method: "session/new" });
      if (!isAbsolute(params.cwd)) throw RequestError.invalidParams("cwd must be absolute");
      if (params.additionalDirectories?.length) {
        throw RequestError.invalidParams("Additional directories are not supported");
      }
      clientMcpEntries(params.mcpServers);
      const fileSystem = new ClientFileSystem(params.cwd, getAgentDir(), client, fileSystemCapabilities);
      let session: BridgeSession;
      try {
        session = await createWithPolicy(params.cwd, undefined, params.mcpServers, undefined, fileSystem);
      } catch (error) {
        throw bridgeError("Unable to create Pi session", error);
      }
      if (closed) {
        await dispose({ session, cwd: params.cwd });
        throw new RequestError(-32603, "Connection closed");
      }
      const sessionId = session.sessionManager?.getSessionId() ?? randomUUID();
      fileSystem.bindSession(sessionId);
      const entry: ManagedSession = { session, cwd: params.cwd, fileSystem, lease: new SessionLease(leaseDirectory) };
      try {
        if (session.sessionFile) await entry.lease!.acquire(session.sessionFile);
        await bind(entry, sessionId);
        await indexSession(sessionId, entry);
        return { sessionId, ...await advertiseSession(sessionId, entry) };
      } catch (error) {
        sessions.delete(sessionId);
        await dispose(entry);
        throw bridgeError("Unable to persist or advertise Pi session", error);
      }
    }),
    async listSessions({ cwd, cursor }) {
      if (cwd != null && !isAbsolute(cwd)) throw RequestError.invalidParams("cwd must be absolute");
      try {
        return await catalog.list(cwd, cursor);
      } catch (error) {
        throw bridgeError("Unable to list Pi sessions", error);
      }
    },
    unstable_forkSession: (params) => openSession(async () => {
      if (!isAbsolute(params.cwd) || params.additionalDirectories?.length) throw RequestError.invalidParams("Unsupported fork workspace");
      const air = (params._meta?.jetbrains as { air?: { fork?: unknown } } | undefined)?.air;
      if (air?.fork !== undefined) throw RequestError.invalidParams("Only branch-tip forks are supported; selected-message fork points are not supported");
      clientMcpEntries(params.mcpServers ?? []);
      if (loading.has(params.sessionId) || deleting.has(params.sessionId) || forking.has(params.sessionId) || closing.has(params.sessionId)) {
        throw sessionBusy("Session is busy");
      }
      const lockedIds = new Set([params.sessionId]);
      forking.add(params.sessionId);
      const sourceLease = new SessionLease(leaseDirectory);
      const forkLease = new SessionLease(leaseDirectory);
      let forkFile: string | undefined;
      let forkId: string | undefined;
      let entry: ManagedSession | undefined;
      let retained = false;
      try {
        let record = await catalog.resolve(params.sessionId, params.cwd);
        if (!record) throw sessionNotFound(params.sessionId);
        if (record.cwd !== params.cwd) throw RequestError.invalidParams("Session workspace mismatch");
        if (record.id !== params.sessionId && (forking.has(record.id) || loading.has(record.id) || deleting.has(record.id) || closing.has(record.id))) {
          throw sessionBusy("Session is busy");
        }
        lockedIds.add(record.id);
        forking.add(record.id);
        const live = [...sessions.entries()].find(([, candidate]) => candidate.session.sessionFile === record!.sessionFile);
        if (live) {
          if (live[1].active || live[1].waitingPrompt || live[1].changingConfiguration) throw sessionBusy("Source session is busy");
          lockedIds.add(live[0]);
          forking.add(live[0]);
        } else {
          await closingFiles.get(record.sessionFile);
          record = await leaseRecord(record, sourceLease);
        }
        const exists = await stat(record.sessionFile).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (!exists) {
          if (record.pending) throw RequestError.invalidParams("Cannot fork a session without conversation history");
          throw sessionNotFound(params.sessionId);
        }
        // Open a separate manager: the runtime fork API replaces the source.
        const snapshot = SessionManager.open(record.sessionFile);
        const leaf = snapshot.getLeafId();
        if (!leaf || !snapshot.getBranch().some(item => item.type === "message" && ["user", "assistant"].includes(item.message.role))) {
          throw RequestError.invalidParams("Cannot fork a session without conversation history");
        }
        forkFile = snapshot.createBranchedSession(leaf);
        forkId = snapshot.getSessionId();
        if (!forkFile) throw new Error("Pi did not create a persistent fork");
        await forkLease.acquire(forkFile);
        const fileSystem = new ClientFileSystem(params.cwd, getAgentDir(), client, fileSystemCapabilities);
        const session = await createWithPolicy(params.cwd, forkFile, params.mcpServers ?? [], undefined, fileSystem);
        fileSystem.bindSession(forkId);
        entry = { session, cwd: params.cwd, fileSystem, lease: forkLease };
        await bind(entry, forkId);
        await indexSession(forkId, entry);
        const configuration = await advertiseSession(forkId, entry);
        retained = true;
        return { sessionId: forkId, ...configuration };
      } catch (error) {
        if (forkId) sessions.delete(forkId);
        // Keep any acquired lease during cleanup. A competing writer owns its
        // history; other setup failures must also clean up the newly created file.
        if (entry) {
          entry.lease = undefined;
          await dispose(entry);
        }
        const activeWriter = error instanceof RequestError &&
          (error.data as { reason?: string } | undefined)?.reason === SESSION_ACTIVE_WRITER;
        if (!activeWriter && forkId && forkFile) {
          try {
            try {
              await index.delete(forkId);
            } finally {
              await unlink(forkFile).catch((cause: NodeJS.ErrnoException) => {
                if (cause.code !== "ENOENT") throw cause;
              });
            }
          } catch {
            trace({ event: "fork_cleanup_failed" });
          }
        }
        throw bridgeError("Unable to fork Pi session", error);
      } finally {
        sourceLease.release();
        if (!retained) forkLease.release();
        for (const id of lockedIds) forking.delete(id);
      }
    }),
    loadSession: (params) => openSession(async () => {
      const { sessionId, cwd } = params;
      trace({ event: "session_open", method: "session/load", sessionId });
      if (!isAbsolute(cwd) || params.additionalDirectories?.length) throw RequestError.invalidParams("Unsupported workspace configuration");
      clientMcpEntries(params.mcpServers);
      if (sessions.has(sessionId) || loading.has(sessionId) || forking.has(sessionId) || deleting.has(sessionId) || closing.has(sessionId)) throw sessionBusy("Session already loaded");
      loading.add(sessionId);
      let session: BridgeSession | undefined;
      let entry: ManagedSession | undefined;
      let canonicalId: string | undefined;
      const lease = new SessionLease(leaseDirectory);
      try {
        const resolved = await catalog.resolve(sessionId, cwd);
        if (!resolved) throw sessionNotFound(sessionId);
        if (resolved.cwd !== cwd) throw RequestError.invalidParams("Session workspace mismatch");
        if ((resolved.id !== sessionId && loading.has(resolved.id)) || forking.has(resolved.id) || deleting.has(resolved.id) || closing.has(resolved.id) || closingFiles.has(resolved.sessionFile) ||
          [...sessions.values()].some((entry) => entry.session.sessionFile === resolved.sessionFile)) {
          throw sessionBusy("Session already loaded");
        }
        canonicalId = resolved.id;
        loading.add(canonicalId);
        const record = await leaseRecord(resolved, lease);
        if (record.cwd !== cwd) throw RequestError.invalidParams("Session workspace mismatch");
        const missing = await stat(record.sessionFile).then(() => false, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return true;
          throw error;
        });
        if (missing && !record.pending) throw sessionNotFound(sessionId);
        const pending = record.pending && missing;
        const fileSystem = new ClientFileSystem(cwd, getAgentDir(), client, fileSystemCapabilities);
        session = await createWithPolicy(cwd, pending ? undefined : record.sessionFile, params.mcpServers, pending ? canonicalId : undefined, fileSystem);
        fileSystem.bindSession(sessionId);
        if (closed) throw new Error("Connection closed");
        entry = { session, cwd, lease, fileSystem };
        // Restoring a pending ID can select a new timestamped path. Hold both until close.
        if (session.sessionFile) await lease.acquire(session.sessionFile);
        await bind(entry, sessionId, record.approvalMode);
        await indexSession(canonicalId, entry);
        for (const update of replayHistory(session)) {
          let presented = await toolImageLinks(update, artifactDir);
          if (update.sessionUpdate === "agent_message_chunk") {
            if (update.content.type === "image") presented = { ...update, content: await imageLink(update.content, artifactDir) };
            else if (update.content.type === "text") {
              const links = new ImageLinkStream(cwd);
              presented = { ...update, content: { ...update.content, text: links.push(update.content.text) + links.finish() } };
            }
          }
          await client.sessionUpdate({ sessionId, update: presented });
        }
        return await advertiseSession(sessionId, entry);
      } catch (error) {
        if (session) await dispose(entry ?? { session, cwd, lease });
        else lease.release();
        throw bridgeError("Unable to load Pi session", error);
      } finally {
        loading.delete(sessionId);
        if (canonicalId) loading.delete(canonicalId);
      }
    }),
    async cancel({ sessionId }) {
      const entry = getSession(sessionId);
      entry.waitingPrompt?.abort();
      if (entry.active) {
        entry.active.cancelled = true;
        entry.session.bridgeApproval?.cancelTurn();
        entry.questions?.cancel();
        await entry.session.abort();
      }
    },
    async closeSession({ sessionId }) {
      if (forking.has(sessionId) || loading.has(sessionId)) throw sessionBusy("Session is busy");
      await closeManaged(sessionId);
      return {};
    },
    deleteSession: ({ sessionId }) => openSession(async () => {
      if (loading.has(sessionId) || forking.has(sessionId) || deleting.has(sessionId)) throw sessionBusy("Session is busy");
      deleting.add(sessionId);
      const lease = new SessionLease(leaseDirectory);
      let canonicalId: string | undefined;
      try {
        const record = await catalog.resolve(sessionId);
        const resolvedId = record?.id ?? sessionId;
        if (resolvedId !== sessionId && (loading.has(resolvedId) || forking.has(resolvedId) || deleting.has(resolvedId))) {
          throw sessionBusy("Session is busy");
        }
        canonicalId = resolvedId;
        deleting.add(canonicalId);
        if (record) {
          await closingFiles.get(record.sessionFile);
          for (const [id, entry] of sessions) {
            if (entry.session.sessionFile === record.sessionFile) await closeManaged(id);
          }
        }
        await closeManaged(canonicalId);
        await closeManaged(sessionId);
        if (record) await leaseRecord(record, lease);
        // Native histories need a mapping so deletion uses the same locked index path.
        if (record && !await index.get(canonicalId)) await index.set(canonicalId, { cwd: record.cwd, sessionFile: record.sessionFile });
        if (record) await index.delete(canonicalId, record.nativeId);
        catalog.invalidate();
        return {};
      } catch (error) {
        throw bridgeError("Unable to permanently delete Pi session", error);
      } finally {
        lease.release();
        deleting.delete(sessionId);
        if (canonicalId) deleting.delete(canonicalId);
      }
    }),
  };
  let shuttingDown: Promise<void> | undefined;
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    closed = true;
    for (const sessionId of sessions.keys()) void closeManaged(sessionId);
    // Include close requests that already removed their session from the live map.
    shuttingDown = Promise.allSettled([...opening])
      .then(() => Promise.allSettled([...disposing])).then(() => {});
    return shuttingDown;
  }
  return {
    host, configuration, index, methods, shutdown,
    configureClient(capabilities: ClientCapabilities = {}) {
      elicitationForm = Boolean(capabilities.elicitation?.form);
      fileSystemCapabilities = capabilities.fs ?? {};
    },
  };
}
