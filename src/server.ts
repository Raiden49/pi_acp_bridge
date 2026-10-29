import { join } from "node:path";
import { homedir } from "node:os";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { InitializeResponse, McpServer } from "@agentclientprotocol/sdk";
import type { ApprovalGate } from "./approvals.js";
import type { ClientFileSystem } from "./client-filesystem.js";
import type { BridgeSession } from "./sessions.js";
import { discoverModels } from "./models.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { createTurnRunner } from "./turn-runner.js";
import { createSteeringHandler } from "./steering.js";
import packageInfo from "../package.json" with { type: "json" };

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

export function startServer({
  input, output, modelsPath,
  artifactDir = join(homedir(), "workspace/storage/media/pi-acp-bridge"),
  trace = () => {}, ...options
}: ServerOptions) {
  let lifecycle: ReturnType<typeof createSessionLifecycle>;
  const connection = new AgentSideConnection(client => {
    lifecycle = createSessionLifecycle({ ...options, client, artifactDir, trace });
    const { host, configuration, index, methods } = lifecycle;
    const prompt = createTurnRunner({ ...host, configuration, artifactDir, index });
    return {
      ...methods,
      async initialize(params): Promise<InitializeResponse> {
        lifecycle.configureClient(params.clientCapabilities);
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: "pi-acp-bridge", version: packageInfo.version },
          agentCapabilities: {
            loadSession: true, mcpCapabilities: { http: true },
            promptCapabilities: { image: true, embeddedContext: true },
            sessionCapabilities: { list: {}, close: {}, delete: {}, fork: {} },
          },
          authMethods: [],
          _meta: { "pi-acp-bridge/models": await discoverModels(modelsPath), steering: { supported: true } },
        };
      },
      setSessionMode: configuration.setSessionMode,
      setSessionConfigOption: configuration.setSessionConfigOption,
      async authenticate() { throw RequestError.methodNotFound("authenticate"); },
      extMethod: createSteeringHandler(host, prompt),
      prompt,
    };
  }, ndJsonStream(output, input));
  const shutdown = () => lifecycle.shutdown();
  return { closed: connection.closed.then(shutdown), shutdown };
}
