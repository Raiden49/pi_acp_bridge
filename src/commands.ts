import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";

export function parseBridgeCommand(blocks: ContentBlock[]) {
  // Only text blocks invoke commands; attached editor resources are context, not arguments.
  // Air/CLion append editor context after a blank line inside the same text block.
  const text = blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim()
    .replace(/\r?\n[ \t]*\r?\ncontext: renderer=[\s\S]*$/, "").trim();
  const match = /^\/(session|doctor|reload|compact|name)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  const name = match[1]!;
  const args = match[2]?.trim() || undefined;
  if (name !== "compact" && name !== "name" && args) throw RequestError.invalidParams({}, `Usage: /${name}`);
  return { name, args };
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
