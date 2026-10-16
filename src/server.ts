import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { decodePrompt, imageLink } from "./content.js";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { InitializeResponse, StopReason } from "@agentclientprotocol/sdk";
import { discoverModels, modelConfigOptions } from "./models.js";
import { createToolUpdates } from "./tool-updates.js";
import { availableCommands, createWorkspaceSession, type BridgeSession } from "./sessions.js";
import packageInfo from "../package.json" with { type: "json" };
import { SessionIndex } from "./session-index.js";
import { replayHistory } from "./history.js";

export interface ServerOptions {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  modelsPath?: string;
  artifactDir?: string;
  sessionIndexPath?: string;
  createSession?: (cwd: string, sessionFile?: string) => Promise<BridgeSession>;
}

interface ActivePrompt {
  cancelled: boolean;
  unsubscribe: () => void;
}
interface ManagedSession {
  session: BridgeSession;
  cwd: string;
  active?: ActivePrompt;
  changingModel?: boolean;
}

export function startServer({ input, output, modelsPath, artifactDir = join(homedir(), "workspace/storage/media/pi-acp-bridge"), sessionIndexPath, createSession = createWorkspaceSession }: ServerOptions) {
  const sessions = new Map<string, ManagedSession>();
  const loading = new Set<string>();
  const index = new SessionIndex(sessionIndexPath);
  let closed = false;
  function getSession(id: string) {
    const entry = sessions.get(id);
    if (!entry) throw RequestError.invalidParams("Unknown or closed session");
    return entry;
  }
  function dispose(entry: ManagedSession) {
    if (entry.active) {
      entry.active.cancelled = true;
      entry.active.unsubscribe();
    }
    entry.session.dispose();
  }
  const connection = new AgentSideConnection((client) => ({
    async initialize(): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "pi-acp-bridge", version: packageInfo.version },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {} } },
        authMethods: [],
        _meta: { "pi-acp-bridge/models": await discoverModels(modelsPath) },
      };
    },
    async newSession(params) {
      if (!isAbsolute(params.cwd)) throw RequestError.invalidParams("cwd must be absolute");
      if (params.mcpServers.length || params.additionalDirectories?.length) {
        throw RequestError.invalidParams("MCP servers and additional directories are not supported");
      }
      let session: BridgeSession;
      try { session = await createSession(params.cwd); }
      catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(-32603, "Unable to create Pi session; check workspace and Pi configuration");
      }
      if (closed) {
        session.dispose();
        throw new RequestError(-32603, "Connection closed");
      }
      const sessionId = randomUUID();
      try {
        if (session.sessionFile) await index.set(sessionId, { cwd: params.cwd, sessionFile: session.sessionFile });
        if (closed) throw new Error("Connection closed");
        if (session.resourceLoader) await client.sessionUpdate({ sessionId, update: {
          sessionUpdate: "available_commands_update", availableCommands: availableCommands(session),
        } });
        if (closed) throw new Error("Connection closed");
        sessions.set(sessionId, { session, cwd: params.cwd });
        return { sessionId, configOptions: modelConfigOptions(session) };
      } catch {
        sessions.delete(sessionId);
        session.dispose();
        throw new RequestError(-32603, "Unable to persist or advertise Pi session");
      }
    },
    async loadSession(params) {
      const { sessionId, cwd } = params;
      if (!isAbsolute(cwd) || params.mcpServers.length || params.additionalDirectories?.length) throw RequestError.invalidParams("Unsupported workspace configuration");
      if (sessions.has(sessionId) || loading.has(sessionId)) throw new RequestError(-32600, "Session already loaded");
      loading.add(sessionId);
      let session: BridgeSession | undefined;
      try {
        const record = await index.get(sessionId);
        if (!record || record.cwd !== cwd) throw RequestError.invalidParams("Unknown session or workspace mismatch");
        session = await createSession(cwd, record.sessionFile);
        if (closed) throw new Error("Connection closed");
        for (const update of replayHistory(session)) {
          await client.sessionUpdate({ sessionId, update });
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "image") {
            await client.sessionUpdate({ sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: await imageLink(update.content, artifactDir),
            } });
          }
        }
        if (session.resourceLoader) await client.sessionUpdate({ sessionId, update: {
          sessionUpdate: "available_commands_update", availableCommands: availableCommands(session),
        } });
        if (closed) throw new Error("Connection closed");
        sessions.set(sessionId, { session, cwd });
        return { configOptions: modelConfigOptions(session) };
      } catch (error) {
        session?.dispose();
        if (error instanceof RequestError) throw error;
        throw new RequestError(-32603, "Unable to load Pi session; check session index and JSONL file");
      } finally { loading.delete(sessionId); }
    },
    async setSessionConfigOption(params) {
      const entry = getSession(params.sessionId);
      if (entry.active || entry.changingModel) throw new RequestError(-32600, "Session is busy");
      if (params.configId !== "model" || typeof params.value !== "string") {
        throw RequestError.invalidParams("Unsupported session configuration option");
      }
      const session = entry.session;
      const model = session.modelRuntime?.getModels().find((candidate) => `${candidate.provider}/${candidate.id}` === params.value);
      if (!model || !session.setModel) throw RequestError.invalidParams("Unknown model");
      entry.changingModel = true;
      try {
        await session.setModel(model);
        return { configOptions: modelConfigOptions(session) };
      } catch {
        throw new RequestError(-32603, "Unable to switch Pi model; check credentials");
      } finally { entry.changingModel = false; }
    },
    async authenticate() { throw RequestError.methodNotFound("authenticate"); },
    async prompt(params) {
      const entry = getSession(params.sessionId);
      if (entry.active || entry.changingModel) throw new RequestError(-32600, "Session is busy");
      const { text, images } = decodePrompt(params.prompt);
      const active: ActivePrompt = { cancelled: false, unsubscribe: () => {} };
      entry.active = active;
      let stopReason: StopReason = "end_turn";
      let failed = false;
      let deliveryFailed = false;
      // Pi listeners are synchronous; serialize writes and drain before responding.
      let updates = Promise.resolve();
      const toolUpdates = createToolUpdates(entry.cwd);
      try {
        active.unsubscribe = entry.session.subscribe((event) => {
          if (active.cancelled) return;
          if (event.type === "message_update" && (
            event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta"
          )) {
            const sessionUpdate = event.assistantMessageEvent.type === "thinking_delta"
              ? "agent_thought_chunk" as const : "agent_message_chunk" as const;
            const text = event.assistantMessageEvent.delta;
            updates = updates.then(async () => {
              if (active.cancelled) return;
              await client.sessionUpdate({ sessionId: params.sessionId, update: {
                sessionUpdate, content: { type: "text", text },
              } });
            }).catch(() => { deliveryFailed = true; });
          }
          for (const update of toolUpdates(event)) {
            updates = updates.then(async () => {
              if (!active.cancelled) await client.sessionUpdate({ sessionId: params.sessionId, update });
            }).catch(() => { deliveryFailed = true; });
          }
          if (event.type === "tool_execution_end") {
            for (const block of event.result.content ?? []) {
              if (block.type !== "image") continue;
              updates = updates.then(async () => {
                if (active.cancelled) return;
                await client.sessionUpdate({ sessionId: params.sessionId, update: {
                  sessionUpdate: "agent_message_chunk", content: block,
                } });
                const link = await imageLink(block, artifactDir);
                if (!active.cancelled) await client.sessionUpdate({ sessionId: params.sessionId, update: {
                  sessionUpdate: "agent_message_chunk", content: link,
                } });
              }).catch(() => { deliveryFailed = true; });
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            failed = event.message.stopReason === "error";
            stopReason = event.message.stopReason === "aborted" ? "cancelled"
              : event.message.stopReason === "length" ? "max_tokens" : "end_turn";
          }
        });
        if (images.length) await entry.session.prompt(text, { images });
        else await entry.session.prompt(text);
        await updates;
        if (active.cancelled) return { stopReason: "cancelled" as const };
        if (failed || deliveryFailed) throw new Error("Prompt failed");
        return { stopReason };
      } catch {
        if (active.cancelled) return { stopReason: "cancelled" as const };
        throw new RequestError(-32603, "Pi prompt failed; check model configuration and credentials");
      } finally {
        active.unsubscribe();
        await updates;
        if (entry.active === active) entry.active = undefined;
      }
    },
    async cancel({ sessionId }) {
      const entry = getSession(sessionId);
      if (entry.active) {
        entry.active.cancelled = true;
        await entry.session.abort();
      }
    },
    async closeSession({ sessionId }) {
      const entry = getSession(sessionId);
      sessions.delete(sessionId);
      dispose(entry);
      return {};
    },
  }), ndJsonStream(output, input));
  void connection.closed.then(() => {
    closed = true;
    for (const entry of sessions.values()) dispose(entry);
    sessions.clear();
  });
  return connection;
}
