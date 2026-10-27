import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { decodePrompt, imageLink, toolImageLinks } from "./content.js";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { Agent, InitializeResponse, StopReason, McpServer, SessionUpdate, FileSystemCapabilities } from "@agentclientprotocol/sdk";
import { discoverModels, refreshSessionModels, sessionConfiguration, selectableModels, setThinking } from "./models.js";
import { bridgeError, errorDetail } from "./errors.js";
import { doctorReport } from "./diagnostics.js";
import { createToolUpdates } from "./tool-updates.js";
import { steeringRequest } from "./steering.js";
import { ApprovalGate, type ApprovalMode } from "./approvals.js";
import { ClientFileSystem } from "./client-filesystem.js";
import { availableCommands, createWorkspaceSession, type BridgeSession } from "./sessions.js";
import packageInfo from "../package.json" with { type: "json" };
import { SessionIndex, type SessionRecord } from "./session-index.js";
import { SessionCatalog } from "./session-catalog.js";
import { SessionLease } from "./session-lease.js";
import { customMessageUpdates, replayHistory } from "./history.js";
import { clientMcpEntries } from "./client-mcp.js";
import { ImageLinkStream } from "./image-links.js";
import { parseBridgeCommand, sessionReport } from "./commands.js";
import { bindExtensionUI } from "./extension-ui.js";
import { nativeQuestions, Questions } from "./questions.js";

export interface ServerOptions {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  modelsPath?: string;
  artifactDir?: string;
  sessionIndexPath?: string;
  sessionDir?: string;
  trace?: (event: Record<string, string | number | boolean>) => void;
  createSession?: (cwd: string, sessionFile?: string, mcpServers?: McpServer[], sessionId?: string, fileSystem?: ClientFileSystem, approval?: ApprovalGate) => Promise<BridgeSession>;
}

interface ActivePrompt {
  cancelled: boolean;
  acceptingInputs: boolean;
  inputs: Set<Promise<void>>;
  inputError?: unknown;
  flush?: () => Promise<void>;
  unsubscribe: () => void;
  notify?: (text: string) => void;
  update?: (update: SessionUpdate) => Promise<void>;
  settled: Promise<void>;
}
interface ManagedSession {
  session: BridgeSession;
  cwd: string;
  active?: ActivePrompt;
  changingConfiguration?: Promise<void>;
  notices?: string[];
  questions?: Questions;
  unsubscribeMetadata?: () => void;
  lastWarning?: string;
  configurationSignature?: string;
  fileSystem?: ClientFileSystem;
  lease?: SessionLease;
}

export function startServer({ input, output, modelsPath, artifactDir = join(homedir(), "workspace/storage/media/pi-acp-bridge"), sessionIndexPath, sessionDir, trace = () => {}, createSession = createWorkspaceSession }: ServerOptions) {
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
    if (!entry || deleting.has(id)) throw RequestError.invalidParams("Unknown or closed session");
    if (forking.has(id)) throw new RequestError(-32600, "Session is being forked");
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
    const approval = new ApprovalGate(connection);
    const session = await createSession(cwd, file, servers, id, fs, approval);
    // Custom factories that omit the policy must not advertise unenforced modes.
    if (approval.installed) session.bridgeApproval = approval;
    return session;
  }
  async function bind(entry: ManagedSession, sessionId: string, fallbackPolicy?: ApprovalMode) {
    entry.session.bridgeApproval?.bind(sessionId, entry.session.sessionManager, fallbackPolicy);
    entry.notices = (entry.session.bridgeDiagnostics?.startupNotices ?? []).map(notice => `${errorDetail(notice)}\n`);
    const elicit = elicitationForm ? nativeQuestions(connection, sessionId) : undefined;
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
      else void connection.sessionUpdate({ sessionId, update }).catch(() => {});
    });
  }
  function dispose(entry: ManagedSession) {
    const pending = disposeSession(entry);
    disposing.add(pending);
    void pending.then(() => disposing.delete(pending), () => disposing.delete(pending));
    return pending;
  }
  async function disposeSession(entry: ManagedSession) {
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
    try { await entry.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
    finally {
      try { entry.session.dispose(); }
      finally { entry.lease?.release(); }
    }
  }
  function closeManaged(sessionId: string) {
    const entry = sessions.get(sessionId);
    if (!entry) return closing.get(sessionId) ?? Promise.resolve();
    sessions.delete(sessionId);
    const pending = dispose(entry);
    closing.set(sessionId, pending);
    const file = entry.session.sessionFile;
    if (file) closingFiles.set(file, pending);
    const remove = () => { closing.delete(sessionId); if (file) closingFiles.delete(file); };
    void pending.then(remove, remove);
    return pending;
  }
  function usageUpdate(session: BridgeSession, estimatedTokens?: number): SessionUpdate | undefined {
    const usage = session.getContextUsage();
    // Compaction supplies a temporary estimate until post-compaction model usage is available.
    const tokens = usage?.tokens ?? estimatedTokens;
    if (!usage || tokens == null) return;
    return { sessionUpdate: "usage_update", used: tokens, size: usage.contextWindow };
  }
  async function publishUsage(sessionId: string, session: BridgeSession) {
    const update = usageUpdate(session);
    if (update && !closed) await connection.sessionUpdate({ sessionId, update });
  }
  async function warnConfiguration(sessionId: string, entry: ManagedSession, warning?: string) {
    if (warning === entry.lastWarning) return;
    entry.lastWarning = warning;
    if (warning && !closed) await connection.sessionUpdate({ sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${warning}\n` },
    } });
  }
  async function publishConfiguration(sessionId: string, session: BridgeSession,
    configuration?: Awaited<ReturnType<typeof sessionConfiguration>>, settled = false) {
    const state = configuration ?? await sessionConfiguration(session);
    const { configOptions, modes, warning } = state;
    const entry = sessions.get(sessionId);
    if (!closed && entry?.session === session && (!entry.active?.cancelled || settled)) {
      if (!entry.active?.cancelled) await warnConfiguration(sessionId, entry, warning);
      if (modes) await connection.sessionUpdate({ sessionId, update: {
        sessionUpdate: "current_mode_update", currentModeId: modes.currentModeId,
      } });
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions } });
      entry.configurationSignature = JSON.stringify(state);
    }
    return configOptions;
  }
  async function changeConfiguration(sessionId: string, change: (session: BridgeSession) => void | Promise<void>) {
    const entry = getSession(sessionId);
    if (entry.active || entry.changingConfiguration) throw new RequestError(-32600, "Session is busy");
    const changing = Promise.resolve().then(() => change(entry.session)).then(async () => {
      if (entry.session.bridgeApproval) await indexSession(sessionId, entry);
      const configOptions = await publishConfiguration(sessionId, entry.session);
      if (sessions.get(sessionId) === entry && !deleting.has(sessionId)) await publishUsage(sessionId, entry.session);
      return configOptions;
    });
    entry.changingConfiguration = changing.then(() => {}, () => {});
    try { return await changing; }
    catch (error) {
      throw bridgeError("Unable to update Pi session configuration", error);
    } finally { entry.changingConfiguration = undefined; }
  }
  async function leaseRecord(record: SessionRecord & { id: string }, lease: SessionLease) {
    for (;;) {
      await lease.acquire(record.sessionFile);
      const latest = await index.get(record.id);
      if (!latest) return record;
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
    await index.set(sessionId, { cwd: entry.cwd, sessionFile, ...(pending ? { pending: true } : {}),
      ...(entry.session.bridgeApproval ? { approvalMode: entry.session.bridgeApproval.mode } : {}),
    });
  }
  async function advertiseSession(sessionId: string, entry: ManagedSession) {
    const { session } = entry;
    const state = await sessionConfiguration(session);
    const { warning, ...configuration } = state;
    if (closed) throw new Error("Connection closed");
    if (session.sessionName) await connection.sessionUpdate({ sessionId, update: {
      sessionUpdate: "session_info_update", title: session.sessionName,
    } });
    await warnConfiguration(sessionId, entry, warning);
    await publishUsage(sessionId, session);
    if (session.resourceLoader) await connection.sessionUpdate({ sessionId, update: {
      sessionUpdate: "available_commands_update", availableCommands: availableCommands(session),
    } });
    if (closed) throw new Error("Connection closed");
    entry.configurationSignature = JSON.stringify(state);
    sessions.set(sessionId, entry);
    trace({ event: "session_ready", sessionId });
    return configuration;
  }
  let agent: Agent;
  const connection = new AgentSideConnection((client) => (agent = {
    async initialize(params): Promise<InitializeResponse> {
      elicitationForm = Boolean(params.clientCapabilities?.elicitation?.form);
      fileSystemCapabilities = params.clientCapabilities?.fs ?? {};
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "pi-acp-bridge", version: packageInfo.version },
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {}, close: {}, delete: {}, fork: {} } },
        authMethods: [],
        _meta: { "pi-acp-bridge/models": await discoverModels(modelsPath), steering: { supported: true } },
      };
    },
    newSession: (params) => openSession(async () => {
      trace({ event: "session_open", method: "session/new" });
      if (!isAbsolute(params.cwd)) throw RequestError.invalidParams("cwd must be absolute");
      if (params.additionalDirectories?.length) {
        throw RequestError.invalidParams("Additional directories are not supported");
      }
      clientMcpEntries(params.mcpServers);
      const fileSystem = new ClientFileSystem(params.cwd, getAgentDir(), client, fileSystemCapabilities);
      let session: BridgeSession;
      try { session = await createWithPolicy(params.cwd, undefined, params.mcpServers, undefined, fileSystem); }
      catch (error) {
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
      if (cwd && !isAbsolute(cwd)) throw RequestError.invalidParams("cwd must be absolute");
      try { return await catalog.list(cwd, cursor); }
      catch (error) {
        throw bridgeError("Unable to list Pi sessions", error);
      }
    },
    unstable_forkSession: (params) => openSession(async () => {
      if (!isAbsolute(params.cwd) || params.additionalDirectories?.length) throw RequestError.invalidParams("Unsupported fork workspace");
      const air = (params._meta?.jetbrains as { air?: { fork?: unknown } } | undefined)?.air;
      if (air?.fork !== undefined) throw RequestError.invalidParams("Only branch-tip forks are supported; selected-message fork points are not supported");
      clientMcpEntries(params.mcpServers ?? []);
      if (loading.has(params.sessionId) || deleting.has(params.sessionId) || forking.has(params.sessionId) || closing.has(params.sessionId)) {
        throw new RequestError(-32600, "Session is busy");
      }
      const lockedIds = new Set([params.sessionId]);
      forking.add(params.sessionId);
      const sourceLease = new SessionLease(leaseDirectory);
      const forkLease = new SessionLease(leaseDirectory);
      let forkFile: string | undefined;
      let forkId: string | undefined;
      let entry: ManagedSession | undefined;
      let ownsFork = false;
      let retained = false;
      try {
        let record = await catalog.resolve(params.sessionId);
        if (!record || record.cwd !== params.cwd) throw RequestError.invalidParams("Unknown session or workspace mismatch");
        if (record.id !== params.sessionId && (forking.has(record.id) || loading.has(record.id) || deleting.has(record.id) || closing.has(record.id))) {
          throw new RequestError(-32600, "Session is busy");
        }
        lockedIds.add(record.id); forking.add(record.id);
        const live = [...sessions.entries()].find(([, candidate]) => candidate.session.sessionFile === record!.sessionFile);
        if (live) {
          if (live[1].active || live[1].changingConfiguration) throw new RequestError(-32600, "Source session is busy");
          lockedIds.add(live[0]); forking.add(live[0]);
        } else {
          await closingFiles.get(record.sessionFile);
          record = await leaseRecord(record, sourceLease);
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
        await forkLease.acquire(forkFile); ownsFork = true;
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
        // Keep the fork lease during cleanup; never remove the source or a fork
        // whose lease belongs to another process.
        if (entry) { entry.lease = undefined; await dispose(entry); }
        if (ownsFork && forkId && forkFile) {
          try {
            await index.delete(forkId);
            await unlink(forkFile).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
          } catch { trace({ event: "fork_cleanup_failed" }); }
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
      if (sessions.has(sessionId) || loading.has(sessionId) || forking.has(sessionId) || deleting.has(sessionId) || closing.has(sessionId)) throw new RequestError(-32600, "Session already loaded");
      loading.add(sessionId);
      let session: BridgeSession | undefined;
      let entry: ManagedSession | undefined;
      let canonicalId: string | undefined;
      const lease = new SessionLease(leaseDirectory);
      try {
        const resolved = await catalog.resolve(sessionId);
        if (!resolved || resolved.cwd !== cwd) throw RequestError.invalidParams("Unknown session or workspace mismatch");
        if ((resolved.id !== sessionId && loading.has(resolved.id)) || forking.has(resolved.id) || deleting.has(resolved.id) || closing.has(resolved.id) || closingFiles.has(resolved.sessionFile) ||
          [...sessions.values()].some((entry) => entry.session.sessionFile === resolved.sessionFile)) {
          throw new RequestError(-32600, "Session already loaded");
        }
        canonicalId = resolved.id;
        loading.add(canonicalId);
        const record = await leaseRecord(resolved, lease);
        if (record.cwd !== cwd) throw RequestError.invalidParams("Session workspace mismatch");
        const pending = record.pending && await stat(record.sessionFile).then(() => false, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return true;
          throw error;
        });
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
      } finally { loading.delete(sessionId); if (canonicalId) loading.delete(canonicalId); }
    }),
    async setSessionMode(params) {
      await changeConfiguration(params.sessionId, (session) => setThinking(session, params.modeId));
      return {};
    },
    async setSessionConfigOption(params) {
      const configOptions = await changeConfiguration(params.sessionId, async (session) => {
        if (params.configId === "approval") {
          if (!session.bridgeApproval) throw RequestError.invalidParams("Tool policy adapter is not loaded");
          session.bridgeApproval.setMode(params.value);
          return;
        }
        // Air Desktop may persist its legacy modes selector as configId "mode".
        if (params.configId === "thinking" || params.configId === "mode") {
          setThinking(session, params.value);
          return;
        }
        if (params.configId !== "model" || typeof params.value !== "string") {
          throw RequestError.invalidParams("Unsupported session configuration option");
        }
        const { models } = await selectableModels(session);
        const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === params.value);
        if (!model) throw RequestError.invalidParams("Unknown, unavailable or out-of-scope model");
        await session.setModel(model);
      });
      return { configOptions };
    },
    async authenticate() { throw RequestError.methodNotFound("authenticate"); },
    async extMethod(method, params) {
      if (method !== "_session/steering") throw new RequestError(-32601, "Unsupported extension method");
      const request = steeringRequest(params);
      const entry = getSession(request.sessionId);
      const active = entry.active;
      if (!active) {
        if (entry.changingConfiguration) throw new RequestError(-32600, "Session configuration is changing");
        if (request.idleBehavior === "promptRequired") return { outcome: "promptRequired", reason: "noRunningTurn" };
        parseBridgeCommand(request.prompt);
        void Promise.resolve(agent.prompt({ sessionId: request.sessionId, prompt: request.prompt })).catch(async (error) => {
          trace({ event: "steered_prompt_failed" });
          if (sessions.get(request.sessionId) === entry) {
            await connection.sessionUpdate({ sessionId: request.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Steered prompt failed: ${errorDetail(error)}` },
            } }).catch(() => undefined);
          }
        });
        return { outcome: "startedNewTurn" };
      }
      if (active.cancelled || !active.acceptingInputs || entry.session.isIdle === true) throw new RequestError(-32600, "Session is cancelling, running a command, or settling");
      if (parseBridgeCommand(request.prompt)) throw RequestError.invalidParams("Bridge commands cannot be injected into a running turn");
      const { text, images } = request.decode();
      // Pi RPC uses this public prompt/preflight hook, including the race where
      // asynchronous input handlers finish after the previous SDK run settles.
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        let accepted = false;
        const operation = Promise.resolve().then(() => entry.session.prompt(text, {
          images, streamingBehavior: "steer", source: "rpc", expandPromptTemplates: false,
          preflightResult: () => {
            if (active.cancelled || !active.acceptingInputs) { reject(new RequestError(-32600, "Turn is no longer accepting input")); return; }
            accepted = true; resolve({ outcome: "injected" });
          },
        })).catch((error) => {
          if (accepted) active.inputError = error;
          reject(bridgeError("Unable to steer Pi session", error));
        }).finally(() => { active.inputs.delete(operation); });
        active.inputs.add(operation);
      });
    },
    async prompt(params) {
      const started = Date.now();
      trace({ event: "prompt_received", sessionId: params.sessionId, blocks: params.prompt.length });
      const entry = getSession(params.sessionId);
      if (entry.active || entry.changingConfiguration) throw new RequestError(-32600, "Session is busy");
      const command = parseBridgeCommand(params.prompt);
      let decoded: ReturnType<typeof decodePrompt>;
      // Local commands ignore attached context, including images that need not be read or decoded.
      try { decoded = decodePrompt(command ? params.prompt.filter((block) => block.type === "text") : params.prompt); }
      catch (error) {
        trace({ event: "prompt_rejected", sessionId: params.sessionId, code: error instanceof RequestError ? error.code : -32603 });
        throw error;
      }
      const { text, images } = decoded;
      trace({ event: "prompt_decoded", sessionId: params.sessionId, textLength: text.length,
        images: images.length, imageBase64Length: images.reduce((total, image) => total + image.data.length, 0) });
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => { finish = resolve; });
      const active: ActivePrompt = { cancelled: false, acceptingInputs: true, inputs: new Set(), unsubscribe: () => {}, settled };
      entry.active = active;
      let stopReason: StopReason = "end_turn";
      let failed = false;
      let failureDetail: string | undefined;
      let deliveryFailed = false;
      // Pi listeners are synchronous; serialize writes and drain before responding.
      let updates = Promise.resolve();
      entry.fileSystem?.changes.clear();
      const toolUpdates = createToolUpdates(entry.cwd, entry.fileSystem?.changes);
      const imageLinks = new ImageLinkStream(entry.cwd);
      // Track only calls actually published to the client, not merely queued.
      const openTools = new Set<string>();
      active.flush = async () => {
        await updates;
        if (deliveryFailed) throw new Error("Unable to deliver session updates to the ACP client");
      };
      entry.session.bridgeApproval?.beginTurn(async toolCallId => {
        await active.flush!();
        if (!openTools.has(toolCallId)) throw new Error("Unable to publish tool call before requesting approval");
      });
      function enqueue(task: () => Promise<void>, settleTool = false) {
        updates = updates.then(async () => {
          if (!closed && sessions.get(params.sessionId) === entry && (!active.cancelled || settleTool)) await task();
        }).catch(() => { deliveryFailed = true; });
        return updates;
      }
      function enqueueUpdate(update: SessionUpdate) {
        const terminal = update.sessionUpdate === "tool_call_update" && ["completed", "failed"].includes(update.status ?? "");
        return enqueue(async () => {
          if (terminal && !openTools.has(update.toolCallId)) return;
          let presented = await toolImageLinks(update, artifactDir);
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "image") {
            presented = { ...update, content: await imageLink(update.content, artifactDir) };
          }
          if (active.cancelled && !terminal) return;
          await client.sessionUpdate({ sessionId: params.sessionId, update: presented });
          if (update.sessionUpdate === "tool_call") openTools.add(update.toolCallId);
          if (terminal) openTools.delete(update.toolCallId);
        }, terminal);
      }
      function enqueueText(text: string, sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk") {
        return text ? enqueueUpdate({ sessionUpdate, content: { type: "text", text } }) : updates;
      }
      let lastUsage: { used: number; size: number } | undefined;
      async function refreshUsage(estimatedTokens?: number) {
        if (closed || sessions.get(params.sessionId) !== entry || deleting.has(params.sessionId)) return;
        const update = usageUpdate(entry.session, estimatedTokens);
        if (!update || update.sessionUpdate !== "usage_update") return;
        if (lastUsage?.used === update.used && lastUsage.size === update.size) return;
        await client.sessionUpdate({ sessionId: params.sessionId, update });
        lastUsage = update;
      }
      active.notify = enqueueText;
      active.update = enqueueUpdate;
      for (const notice of entry.notices?.splice(0) ?? []) enqueueText(notice);
      try {
        active.unsubscribe = entry.session.subscribe((event) => {
          if (active.cancelled) {
            if (event.type === "tool_execution_end") for (const update of toolUpdates(event)) enqueueUpdate(update);
            return;
          }
          if (event.type === "compaction_start") {
            enqueueText(`正在压缩上下文（${event.reason === "manual" ? "手动" : event.reason === "overflow" ? "上下文超限，准备重试" : "接近上下文上限"}）……\n`);
          } else if (event.type === "compaction_end") {
            enqueueText(event.result
              ? `压缩完成：${event.result.tokensBefore} → 约 ${event.result.estimatedTokensAfter ?? "未知"} token。${event.willRetry ? "继续处理当前请求。" : ""}\n`
              : event.aborted ? "上下文压缩已取消。\n" : "上下文压缩未完成。\n");
            enqueue(() => refreshUsage(event.result?.estimatedTokensAfter));
          } else if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
            enqueueText(`请求暂时失败，准备重试（${event.attempt}/${event.maxAttempts}，约 ${Math.ceil(event.delayMs / 1000)} 秒后）。\n`);
          }
          if (event.type === "message_update" && (
            event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta"
          )) {
            const sessionUpdate = event.assistantMessageEvent.type === "thinking_delta"
              ? "agent_thought_chunk" as const : "agent_message_chunk" as const;
            const text = event.assistantMessageEvent.delta;
            enqueueText(sessionUpdate === "agent_message_chunk" ? imageLinks.push(text) : text, sessionUpdate);
          }
          for (const update of toolUpdates(event)) enqueueUpdate(update);
          if (event.type === "message_end" && event.message.role === "custom") {
            for (const update of customMessageUpdates(event.message)) enqueueUpdate(update);
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            enqueueText(imageLinks.finish());
            // Pi persists message_end after notifying listeners; read usage from the queued task.
            if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
              enqueue(() => refreshUsage());
            }
            failed = event.message.stopReason === "error";
            failureDetail = failed ? event.message.errorMessage : undefined;
            stopReason = event.message.stopReason === "aborted" ? "cancelled"
              : event.message.stopReason === "length" ? "max_tokens" : "end_turn";
          }
        });
        trace({ event: "prompt_dispatched", sessionId: params.sessionId, command: command?.name ?? "model" });
        if (command?.name === "session") {
          enqueueText(sessionReport(entry.session, params.sessionId, entry.cwd));
        } else if (command?.name === "doctor") {
          enqueueText(await doctorReport(entry.session, entry.cwd));
        } else if (command?.name === "name") {
          if (command.args) entry.session.setSessionName(command.args);
          enqueueText(entry.session.sessionName ? `会话标题：${entry.session.sessionName}\n` : "用法：/name <标题>\n");
        } else if (command?.name === "reload") {
          enqueueText("正在重新加载模型配置、扩展、技能与模板……\n");
          await refreshSessionModels(entry.session);
          await entry.session.reload();
          enqueueText("重新加载完成；当前聊天历史未切换。\n");
          enqueue(async () => {
            await client.sessionUpdate({ sessionId: params.sessionId, update: {
              sessionUpdate: "available_commands_update", availableCommands: availableCommands(entry.session),
            } });
            await publishConfiguration(params.sessionId, entry.session);
          });
        } else if (command?.name === "compact") {
          await entry.session.compact(command.args);
        } else if (images.length) await entry.session.prompt(text, { images });
        else await entry.session.prompt(text);
        while (active.inputs.size) await Promise.all([...active.inputs]);
        active.acceptingInputs = false;
        if (active.inputError) throw active.inputError;
        enqueueText(imageLinks.finish());
        await updates;
        if (active.cancelled) return { stopReason: "cancelled" as const };
        if (failed) throw new Error(failureDetail || "Model returned an error without details");
        if (deliveryFailed) throw new Error("Unable to deliver session updates to the ACP client");
        return { stopReason };
      } catch (error) {
        trace({ event: "prompt_failed", sessionId: params.sessionId,
          code: error instanceof RequestError ? error.code : -32603, cancelled: active.cancelled });
        if (active.cancelled) return { stopReason: "cancelled" as const };
        if (command?.name === "compact" && error instanceof Error) {
          if (error.message === "Compaction cancelled") return { stopReason: "cancelled" as const };
          if (["Already compacted", "Nothing to compact (session too small)"].includes(error.message)) {
            enqueueText("当前没有需要压缩的历史；可以继续对话。\n");
            await updates;
            if (!deliveryFailed) return { stopReason: "end_turn" as const };
          }
        }
        throw bridgeError(command ? `Pi /${command.name} failed` : "Pi prompt failed", error);
      } finally {
        active.acceptingInputs = false;
        entry.session.bridgeApproval?.cancelTurn();
        while (active.inputs.size) await Promise.all([...active.inputs]);
        if (active.cancelled) entry.session.clearQueue?.();
        active.unsubscribe();
        entry.fileSystem?.changes.clear();
        await updates;
        // Like Claude ACP, settle published foreground tools before ending the
        // prompt. A missing result is explicitly unknown, never a success.
        for (const toolCallId of openTools) enqueueUpdate({ sessionUpdate: "tool_call_update", toolCallId, status: "failed",
          content: [{ type: "content", content: { type: "text", text: active.cancelled
            ? "操作已取消；工具未报告最终结果，已发生的文件变更不会自动撤销。"
            : "本轮已结束，但工具未报告最终结果。" } }],
        });
        await updates;
        // Extensions can change configuration outside the bridge's setter paths.
        // Compare only at settlement, including failed/cancelled turns, not on deltas.
        if (!closed && sessions.get(params.sessionId) === entry && !deleting.has(params.sessionId)) {
          updates = updates.then(async () => {
            const state = await sessionConfiguration(entry.session);
            if (JSON.stringify(state) !== entry.configurationSignature) {
              await publishConfiguration(params.sessionId, entry.session, state, true);
            }
            await refreshUsage();
          }).catch(() => { deliveryFailed = true; });
        }
        await updates;
        try {
          if (entry.session.sessionFile && (await index.get(params.sessionId))?.pending) await indexSession(params.sessionId, entry);
        } finally {
          entry.session.bridgeApproval?.finishTurn();
          if (entry.active === active) entry.active = undefined;
          finish();
          trace({ event: "prompt_settled", sessionId: params.sessionId, durationMs: Date.now() - started,
            cancelled: active.cancelled });
        }
      }
    },
    async cancel({ sessionId }) {
      const entry = getSession(sessionId);
      if (entry.active) {
        entry.active.cancelled = true;
        entry.session.bridgeApproval?.cancelTurn();
        entry.questions?.cancel();
        await entry.session.abort();
      }
    },
    async closeSession({ sessionId }) {
      getSession(sessionId);
      await closeManaged(sessionId);
      return {};
    },
    deleteSession: ({ sessionId }) => openSession(async () => {
      if (loading.has(sessionId) || forking.has(sessionId) || deleting.has(sessionId)) throw new RequestError(-32600, "Session is busy");
      deleting.add(sessionId);
      const lease = new SessionLease(leaseDirectory);
      let canonicalId: string | undefined;
      try {
        const record = await catalog.resolve(sessionId);
        const resolvedId = record?.id ?? sessionId;
        if (resolvedId !== sessionId && (loading.has(resolvedId) || forking.has(resolvedId) || deleting.has(resolvedId))) {
          throw new RequestError(-32600, "Session is busy");
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
        if (record) await index.delete(canonicalId);
        return {};
      } catch (error) {
        throw bridgeError("Unable to permanently delete Pi session", error);
      } finally {
        lease.release();
        deleting.delete(sessionId);
        if (canonicalId) deleting.delete(canonicalId);
      }
    }),
  }), ndJsonStream(output, input));
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
  return { closed: connection.closed.then(shutdown), shutdown };
}
