import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { clientMcpExtension } from "./client-mcp.js";

export type BridgeSession = Pick<AgentSession,
  "prompt" | "subscribe" | "abort" | "dispose" | "setModel" | "setThinkingLevel" |
  "getAvailableThinkingLevels" | "setSessionName" | "getSessionStats" | "getContextUsage" | "reload" | "compact" | "bindExtensions"
> & Partial<Pick<AgentSession,
  "sessionFile" | "sessionManager" | "messages" | "resourceLoader" | "promptTemplates" |
  "settingsManager" | "extensionRunner" | "model" | "thinkingLevel" | "sessionName" | "modelRuntime"
>>;

export function availableCommands(session: BridgeSession) {
  const commands = new Map<string, { name: string; description: string }>();
  const add = (name: string, description = "") => {
    if (!commands.has(name)) commands.set(name, { name, description });
  };
  add("session", "显示当前会话、历史路径与用量统计");
  add("reload", "重新加载扩展、技能与模板（不刷新聊天历史）");
  add("name", "查看或修改 Pi 会话标题");
  add("compact", "压缩当前上下文；可附加摘要要求，会调用模型");
  for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) add(command.invocationName, command.description);
  for (const template of session.promptTemplates ?? []) add(template.name, template.description);
  if (session.settingsManager?.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader?.getSkills().skills ?? []) add(`skill:${skill.name}`, skill.description);
  }
  return [...commands.values()];
}

export async function createWorkspaceSession(cwd: string, sessionFile?: string, mcpServers: McpServer[] = [], sessionId?: string): Promise<BridgeSession> {
  if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw RequestError.invalidParams("cwd must be an existing absolute directory");
  }
  let sessionManager: SessionManager;
  if (sessionFile) {
    if (!(await stat(sessionFile)).isFile()) throw RequestError.invalidParams("Session file is missing");
    sessionManager = SessionManager.open(sessionFile);
    if (sessionManager.getCwd() !== resolve(cwd)) throw RequestError.invalidParams("Session workspace mismatch");
  } else {
    // Keep setup-only sessions off disk, as Pi does. Pending ACP IDs live in the index.
    sessionManager = SessionManager.create(cwd, undefined, sessionId ? { id: sessionId } : undefined);
  }
  const resourceLoader = mcpServers.length ? new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), extensionFactories: [clientMcpExtension(mcpServers)],
  }) : undefined;
  if (resourceLoader) await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, sessionManager, resourceLoader });
  return session;
}
