import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RequestError } from "@agentclientprotocol/sdk";

export type BridgeSession = Pick<AgentSession, "prompt" | "subscribe" | "abort" | "dispose">;

export async function createWorkspaceSession(cwd: string): Promise<BridgeSession> {
  if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw RequestError.invalidParams("cwd must be an existing absolute directory");
  }
  const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) });
  return session;
}
