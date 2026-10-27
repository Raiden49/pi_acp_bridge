import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { bridgeBuiltinExtensions } from "./client-mcp.js";
import { applyInitialModelScope } from "./models.js";
import type { ClientFileSystem } from "./client-filesystem.js";
import type { ApprovalGate } from "./approvals.js";

export interface BridgeDiagnostics {
  agentDir: string;
  startupNotices: string[];
  modelRefresh?: { at: string; status: "success" | "failed"; detail?: string };
}

export type BridgeSession = Pick<AgentSession,
  "prompt" | "subscribe" | "abort" | "dispose" | "setModel" | "setThinkingLevel" |
  "getAvailableThinkingLevels" | "setSessionName" | "getSessionStats" | "getContextUsage" | "reload" | "compact" | "bindExtensions"
> & Partial<Pick<AgentSession,
  "sessionFile" | "sessionManager" | "messages" | "resourceLoader" | "promptTemplates" |
  "settingsManager" | "extensionRunner" | "model" | "thinkingLevel" | "sessionName" | "modelRuntime" | "isIdle" | "clearQueue"
>> & { bridgeDiagnostics?: BridgeDiagnostics; bridgeApproval?: ApprovalGate };

export function availableCommands(session: BridgeSession) {
  const commands = new Map<string, { name: string; description: string }>();
  const add = (name: string, description = "") => {
    if (!commands.has(name)) commands.set(name, { name, description });
  };
  add("session", "显示当前会话、历史路径与用量统计");
  add("doctor", "只读诊断运行版本、配置来源、模型与 MCP 入口（不调用模型）");
  add("reload", "重新加载模型配置、扩展、技能与模板（保留当前模型与聊天历史）");
  add("name", "查看或修改 Pi 会话标题");
  add("compact", "压缩当前上下文；可附加摘要要求，会调用模型");
  for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) add(command.invocationName, command.description);
  for (const template of session.promptTemplates ?? []) add(template.name, template.description);
  if (session.settingsManager?.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader?.getSkills().skills ?? []) add(`skill:${skill.name}`, skill.description);
  }
  return [...commands.values()];
}

export async function createWorkspaceSession(cwd: string, sessionFile?: string, mcpServers: McpServer[] = [], sessionId?: string, fileSystem?: ClientFileSystem, approval?: ApprovalGate): Promise<BridgeSession> {
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
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, extensionFactories: [...bridgeBuiltinExtensions(mcpServers), ...(fileSystem?.extensions() ?? []), ...(approval?.extensions() ?? [])],
  });
  await resourceLoader.reload();
  const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, settingsManager, sessionManager, resourceLoader });
  const bridge: BridgeSession = session;
  bridge.bridgeDiagnostics = { agentDir, startupNotices: modelFallbackMessage ? [modelFallbackMessage] : [] };
  try {
    // Preserve a successfully restored selection, not an SDK fallback that ignored scope.
    if (!sessionManager.buildSessionContext().messages.length || modelFallbackMessage) {
      await applyInitialModelScope(session);
    }
    if (modelFallbackMessage && session.model) {
      bridge.bridgeDiagnostics.startupNotices = [
        `SDK 启动恢复记录（历史事件）：${modelFallbackMessage}`,
        `Bridge 启动选择：${session.model.provider}/${session.model.id}；模型范围未扩大。`,
      ];
    }
    return bridge;
  } catch (error) {
    session.dispose();
    throw error;
  }
}
