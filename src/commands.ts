import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";

export const bridgeCommands = [
  { name: "session", description: "显示当前会话、历史路径与用量统计", acceptsArgs: false },
  { name: "doctor", description: "只读诊断运行版本、配置来源、模型与 MCP 入口（不调用模型）", acceptsArgs: false },
  { name: "reload", description: "重新加载模型配置、扩展、技能与模板（保留当前模型与聊天历史）", acceptsArgs: false },
  { name: "name", description: "查看或修改 Pi 会话标题", acceptsArgs: true },
  { name: "compact", description: "压缩当前上下文；可附加摘要要求，会调用模型", acceptsArgs: true },
] as const;

export function parseBridgeCommand(blocks: ContentBlock[]) {
  // Only text blocks invoke commands; attached editor resources are context, not arguments.
  // Air/CLion append editor context after a blank line inside the same text block.
  const text = blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim()
    .replace(/\r?\n[ \t]*\r?\ncontext: renderer=[\s\S]*$/, "").trim();
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const command = bridgeCommands.find(({ name }) => name === match?.[1]);
  if (!command) return undefined;
  const args = match?.[2]?.trim() || undefined;
  if (!command.acceptsArgs && args) throw RequestError.invalidParams({}, `Usage: /${command.name}`);
  return { name: command.name, args };
}

export function sessionReport(session: BridgeSession, acpId: string, cwd: string): string {
  const stats = session.getSessionStats();
  return ["### Pi 会话", `标题：${session.sessionName ?? "未命名"}`, `Thinking：${session.thinkingLevel ?? "不可用"}`, `ACP ID：\`${acpId}\``, `Pi ID：\`${stats.sessionId}\``,
    `工作区：\`${cwd}\``, `历史文件：\`${stats.sessionFile ?? "内存会话"}\``,
    `模型：${session.model ? `${session.model.provider}/${session.model.id}` : "未选择"}`,
    `消息：${stats.totalMessages}（用户 ${stats.userMessages}，助手 ${stats.assistantMessages}，工具结果 ${stats.toolResults}）`,
    `累计 token：${stats.tokens.total}（输入 ${stats.tokens.input}，输出 ${stats.tokens.output}，缓存读 ${stats.tokens.cacheRead}，缓存写 ${stats.tokens.cacheWrite}）`,
    `累计费用估计：$${stats.cost.toFixed(4)}`,
    stats.contextUsage
      ? `当前上下文：${stats.contextUsage.tokens ?? "暂不可估算"} / ${stats.contextUsage.contextWindow} token${stats.contextUsage.percent == null ? "" : `（${stats.contextUsage.percent.toFixed(1)}%）`}`
      : "当前上下文占用暂不可估算。",
    "累计 token 不等于当前上下文占用。",
  ].join("\n\n") + "\n";
}
