import { stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RequestError } from "@agentclientprotocol/sdk";

export type BridgeSession = Pick<AgentSession, "prompt" | "subscribe" | "abort" | "dispose"> &
  Partial<Pick<AgentSession, "sessionFile" | "messages" | "resourceLoader" | "promptTemplates" | "settingsManager" | "extensionRunner" | "model" | "modelRuntime" | "setModel">>;

export function availableCommands(session: BridgeSession) {
  const commands = new Map<string, { name: string; description: string }>();
  const add = (name: string, description = "") => {
    if (!commands.has(name)) commands.set(name, { name, description });
  };
  for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) add(command.invocationName, command.description);
  for (const template of session.promptTemplates ?? []) add(template.name, template.description);
  if (session.settingsManager?.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader?.getSkills().skills ?? []) add(`skill:${skill.name}`, skill.description);
  }
  return [...commands.values()];
}

export async function createWorkspaceSession(cwd: string, sessionFile?: string): Promise<BridgeSession> {
  if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw RequestError.invalidParams("cwd must be an existing absolute directory");
  }
  let sessionManager: SessionManager;
  if (sessionFile) {
    if (!(await stat(sessionFile)).isFile()) throw RequestError.invalidParams("Session file is missing");
    sessionManager = SessionManager.open(sessionFile);
    if (sessionManager.getCwd() !== resolve(cwd)) throw RequestError.invalidParams("Session workspace mismatch");
  } else {
    sessionManager = SessionManager.create(cwd);
    // Pi defers the file until conversation starts. Persist a header so even an
    // unused ACP session ID can be resumed, then let Pi own all subsequent writes.
    const path = sessionManager.getSessionFile()!;
    await writeFile(path, JSON.stringify(sessionManager.getHeader()) + "\n", { flag: "wx", mode: 0o600 });
    sessionManager = SessionManager.open(path);
  }
  const { session } = await createAgentSession({ cwd, sessionManager });
  return session;
}
