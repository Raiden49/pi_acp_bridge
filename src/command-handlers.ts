import type { BridgeSession } from "./sessions.js";
import { bridgeCommands, sessionReport, type parseBridgeCommand } from "./commands.js";
import { doctorReport } from "./diagnostics.js";
import { refreshSessionModels } from "./models.js";

interface CommandContext {
  session: BridgeSession;
  sessionId: string;
  cwd: string;
  notify(text: string): void;
  enqueue(task: () => Promise<void>): Promise<void>;
  syncConfiguration(force?: boolean): Promise<boolean>;
  publishCommands(): Promise<void>;
  trace(event: Record<string, string | number | boolean>): void;
}

type Command = NonNullable<ReturnType<typeof parseBridgeCommand>>;
type Handler = (context: CommandContext, args?: string) => void | Promise<void>;

async function reload(context: CommandContext) {
  const { session, sessionId, notify, enqueue, trace } = context;
  notify("正在重新加载模型配置、扩展、技能与模板……\n");
  let configurationPublished = false;
  const sync = async (force = false) => {
    if (await context.syncConfiguration(force)) configurationPublished = true;
  };
  // Pi must reload settings itself to compute changes to defaultTools.
  trace({ event: "reload_stage", sessionId, stage: "resources" });
  await session.reload({ beforeSessionStart: async () => {
    // Providers are registered; publish refreshed choices before slow MCP startup.
    await refreshSessionModels(session);
    await enqueue(sync);
    notify("模型配置与资源已刷新；正在启动扩展与连接 MCP……\n");
    trace({ event: "reload_stage", sessionId, stage: "session_start" });
  } });
  trace({ event: "reload_stage", sessionId, stage: "complete" });
  notify("重新加载完成；当前聊天历史未切换。\n");
  void enqueue(async () => {
    await context.publishCommands();
    await sync(!configurationPublished);
  });
}

const handlers: Record<(typeof bridgeCommands)[number]["name"], Handler> = {
  session: ({ session, sessionId, cwd, notify }) => notify(sessionReport(session, sessionId, cwd)),
  doctor: async ({ session, cwd, notify }) => notify(await doctorReport(session, cwd)),
  name: ({ session, notify }, args) => {
    if (args) session.setSessionName(args);
    notify(session.sessionName ? `会话标题：${session.sessionName}\n` : "用法：/name <标题>\n");
  },
  compact: async ({ session }, args) => { await session.compact(args); },
  reload,
};

export async function executeBridgeCommand(command: Command, context: CommandContext) {
  await handlers[command.name](context, command.args);
}
