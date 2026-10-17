import { stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { clientMcpExtension } from "./client-mcp.js";

export type BridgeSession = Pick<AgentSession, "prompt" | "subscribe" | "abort" | "dispose"> &
  Partial<Pick<AgentSession, "sessionFile" | "sessionManager" | "messages" | "resourceLoader" | "promptTemplates" | "settingsManager" | "extensionRunner" | "model" | "modelRuntime" | "setModel" | "thinkingLevel" | "setThinkingLevel" | "getAvailableThinkingLevels" | "sessionName" | "setSessionName" | "getSessionStats" | "reload" | "compact" | "bindExtensions">>;

export function availableCommands(session: BridgeSession) {
  const commands = new Map<string, { name: string; description: string }>();
  const add = (name: string, description = "") => {
    if (!commands.has(name)) commands.set(name, { name, description });
  };
  if (session.getSessionStats) add("session", "显示当前会话、历史路径与用量统计");
  if (session.reload) add("reload", "重新加载扩展、技能与模板（不刷新聊天历史）");
  if (session.setSessionName) add("name", "查看或修改 Pi 会话标题");
  if (session.compact) add("compact", "压缩当前上下文；可附加摘要要求，会调用模型");
  for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) add(command.invocationName, command.description);
  for (const template of session.promptTemplates ?? []) add(template.name, template.description);
  if (session.settingsManager?.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader?.getSkills().skills ?? []) add(`skill:${skill.name}`, skill.description);
  }
  return [...commands.values()];
}

export async function createWorkspaceSession(cwd: string, sessionFile?: string, mcpServers: McpServer[] = []): Promise<BridgeSession> {
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
  const resourceLoader = mcpServers.length ? new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), extensionFactories: [clientMcpExtension(mcpServers)],
  }) : undefined;
  if (resourceLoader) await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, sessionManager, resourceLoader });
  return session;
}
