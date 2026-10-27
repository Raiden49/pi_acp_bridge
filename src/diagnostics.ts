import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, VERSION as piVersion } from "@earendil-works/pi-coding-agent";
import packageInfo from "../package.json" with { type: "json" };
import { errorDetail } from "./errors.js";
import type { BridgeSession } from "./sessions.js";

// Capture once at process startup; rebuilding the file must not make an old
// process claim to be the newly built agent. In a bundle this hashes index.js.
const identity = readFile(new URL(import.meta.url)).then(bytes => createHash("sha256").update(bytes).digest("hex"), () => "不可读取");

export async function doctorReport(session: BridgeSession, cwd: string): Promise<string> {
  const agentDir = session.bridgeDiagnostics?.agentDir ?? getAgentDir();
  const settings = session.settingsManager;
  const project = settings?.getProjectSettings();
  const source = (field: "defaultProvider" | "defaultModel") => settings?.isProjectTrusted() && project?.[field] !== undefined
    ? join(cwd, ".pi/settings.json") : join(agentDir, "settings.json");
  const model = session.model;
  const runtime = session.modelRuntime;
  const auth = model && runtime?.getProviderAuthStatus(model.provider);
  const refresh = session.bridgeDiagnostics?.modelRefresh;
  const extensions = session.resourceLoader?.getExtensions();
  const commands = session.extensionRunner?.getRegisteredCommands() ?? [];
  return errorDetail([
    "### Pi Bridge 只读诊断",
    `Bridge：${packageInfo.version}；Pi SDK：${piVersion}；Node：${process.version}`,
    `Node 路径：\`${process.execPath}\``,
    `启动入口：\`${process.argv[1] ?? "未知"}\``,
    `运行模块：\`${import.meta.url}\`；SHA-256：${await identity}`,
    `Pi profile：\`${agentDir}\`；工作区：\`${cwd}\``,
    `模型配置：\`${join(agentDir, "models.json")}\`；认证存储：\`${join(agentDir, "auth.json")}\`（不读取或展示凭证）`,
    `当前模型：${model ? `${model.provider}/${model.id}` : "未选择"}；Thinking：${session.thinkingLevel ?? "不可用"}`,
    `默认 Provider：${settings?.getDefaultProvider() ?? "SDK 回退"}（来源：${source("defaultProvider")}）`,
    `默认模型：${settings?.getDefaultModel() ?? "SDK 回退"}（来源：${source("defaultModel")}）`,
    `模型范围：${JSON.stringify(settings?.getEnabledModels() ?? [])}（空范围表示全部可用模型）`,
    `可用模型快照：${runtime?.getAvailableSnapshot().length ?? "未知"}；当前认证配置：${auth ? `${auth.configured ? "已配置" : "未配置"}，来源 ${auth.source ?? "未知"}` : "未知"}（不保证远端有效）`,
    `最近模型刷新：${refresh ? `${refresh.at} ${refresh.status}${refresh.detail ? `：${refresh.detail}` : ""}` : "尚未执行 /reload"}`,
    `模型配置/可用性错误：${runtime?.getError() ? "存在；检查 models.json 与认证配置（不输出配置内容）" : "快照未报告错误"}`,
    `文件工具委托：${extensions?.extensions.some(extension => extension.path === "<inline:ide-filesystem>")
      ? "已启用工作区文本编辑器读写；图片、工作区外及 Pi profile 仍使用本地文件系统"
      : "未启用 Bridge 编辑器委托；由本地/用户扩展工具处理"}。bash、grep 等仍访问磁盘；这不是只读或权限模式。`,
    `工具策略：${session.bridgeApproval?.mode ?? "未加载审批适配"}；默认 direct，approval 配置可选 ask/plan。Plan 拦截 shell 与未知工具；可信扩展不是沙箱隔离。`,
    "会话分叉：仅持久化当前分支末尾；不支持指定消息位置，不回滚工作区。追加输入：_session/steering，空闲时支持 promptRequired 交回普通提示。",
    `扩展加载错误：${extensions?.errors.length ?? "未知"}`,
    ...(extensions?.errors.map(({ path, error }) => `${path}：${errorDetail(error)}`) ?? []),
    ...(session.bridgeDiagnostics?.startupNotices ?? []),
    `MCP：${commands.some(command => command.invocationName === "mcp") ? "已加载管理命令；使用 /mcp 查看连接状态、覆盖来源，/mcp reconnect <name> 重连" : "未加载 /mcp 管理命令"}。原生配置优先于 IDE 注册。`,
    `MCP 配置来源：\`${join(agentDir, "mcp.json")}\` 与受信任项目的 \`${join(cwd, ".pi/mcp.json")}\`；原生/IDE 值分别遵循 Pi 模板/ACP 字面值规则。`,
    "删除策略：session/delete 永久删除 Pi JSONL；不会自动撤销文件修改，也不删除生成的图片。",
    "本命令不刷新配置、不调用模型、不验证远端凭证。更新代码后需真正重启 agent；/reload 不加载新版 Bridge。",
  ].join("\n\n"), 12000) + "\n";
}
