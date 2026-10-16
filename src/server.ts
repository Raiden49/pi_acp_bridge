import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { discoverModels } from "./models.js";
import packageInfo from "../package.json" with { type: "json" };

export interface ServerOptions {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  modelsPath?: string;
}

export function startServer({ input, output, modelsPath }: ServerOptions) {
  return new AgentSideConnection(() => ({
    async initialize(): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "pi-acp-bridge", version: packageInfo.version },
        agentCapabilities: { loadSession: false },
        authMethods: [],
        _meta: { "pi-acp-bridge/models": await discoverModels(modelsPath) },
      };
    },
    async newSession() { throw RequestError.methodNotFound("session/new"); },
    async authenticate() { throw RequestError.methodNotFound("authenticate"); },
    async prompt() { throw RequestError.methodNotFound("session/prompt"); },
    async cancel() {},
  }), ndJsonStream(output, input));
}
