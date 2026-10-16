import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { InitializeResponse, StopReason } from "@agentclientprotocol/sdk";
import { discoverModels } from "./models.js";
import { createWorkspaceSession, type BridgeSession } from "./sessions.js";
import packageInfo from "../package.json" with { type: "json" };

export interface ServerOptions {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  modelsPath?: string;
  createSession?: (cwd: string) => Promise<BridgeSession>;
}

interface ActivePrompt {
  cancelled: boolean;
  unsubscribe: () => void;
}
interface ManagedSession {
  session: BridgeSession;
  active?: ActivePrompt;
}

export function startServer({ input, output, modelsPath, createSession = createWorkspaceSession }: ServerOptions) {
  const sessions = new Map<string, ManagedSession>();
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
        agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
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
      sessions.set(sessionId, { session });
      return { sessionId };
    },
    async authenticate() { throw RequestError.methodNotFound("authenticate"); },
    async prompt(params) {
      const entry = getSession(params.sessionId);
      if (entry.active) throw new RequestError(-32600, "Session already has an active prompt");
      if (params.prompt.some((block) => block.type !== "text")) {
        throw RequestError.invalidParams("Only text prompts are supported");
      }
      const text = params.prompt.map((block) => block.type === "text" ? block.text : "").join("\n");
      const active: ActivePrompt = { cancelled: false, unsubscribe: () => {} };
      entry.active = active;
      let stopReason: StopReason = "end_turn";
      let failed = false;
      let deliveryFailed = false;
      // Pi listeners are synchronous; serialize writes and drain before responding.
      let updates = Promise.resolve();
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
          if (event.type === "message_end" && event.message.role === "assistant") {
            failed = event.message.stopReason === "error";
            stopReason = event.message.stopReason === "aborted" ? "cancelled"
              : event.message.stopReason === "length" ? "max_tokens" : "end_turn";
          }
        });
        await entry.session.prompt(text);
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
