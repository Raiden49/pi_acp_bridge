import { RequestError, type PromptRequest, type PromptResponse, type StopReason, type SessionUpdate } from "@agentclientprotocol/sdk";
import { decodePrompt, imageLink, toolImageLinks } from "./content.js";
import { bridgeError } from "./errors.js";
import { createToolUpdates } from "./tool-updates.js";
import { ImageLinkStream } from "./image-links.js";
import { customMessageUpdates } from "./history.js";
import { parseBridgeCommand } from "./commands.js";
import { executeBridgeCommand } from "./command-handlers.js";
import { availableCommands } from "./sessions.js";
import type { ActivePrompt, SessionHost } from "./managed-session.js";
import type { ConfigCoordinator } from "./config-coordinator.js";
import type { SessionIndex } from "./session-index.js";

interface TurnRunnerOptions extends SessionHost {
  configuration: ConfigCoordinator;
  artifactDir: string;
  index: SessionIndex;
}

export function createTurnRunner({
  sessions, deleting, getSession, isClosed, sendUpdate, trace, indexSession,
  artifactDir, index, configuration,
}: TurnRunnerOptions) {
  const { usageUpdate, publishUsage, syncConfiguration } = configuration;
  return async function prompt(params: PromptRequest): Promise<PromptResponse> {
    const started = Date.now();
    trace({ event: "prompt_received", sessionId: params.sessionId, blocks: params.prompt.length });
    const entry = getSession(params.sessionId);
    if (entry.active || entry.waitingPrompt) throw new RequestError(-32600, "Session is busy");
    if (entry.changingConfiguration) {
      const waiting = new AbortController();
      entry.waitingPrompt = waiting;
      const cancelled = new Promise<void>(resolve => waiting.signal.addEventListener("abort", () => resolve(), { once: true }));
      try {
        while (entry.changingConfiguration) {
          await Promise.race([entry.changingConfiguration, cancelled]);
          if (waiting.signal.aborted) {
            trace({ event: "prompt_cancelled_before_dispatch", sessionId: params.sessionId });
            return { stopReason: "cancelled" };
          }
          if (getSession(params.sessionId) !== entry) throw new RequestError(-32600, "Session was replaced");
        }
      } finally {
        if (entry.waitingPrompt === waiting) entry.waitingPrompt = undefined;
      }
    }
    if (entry.active) throw new RequestError(-32600, "Session is busy");
    const command = parseBridgeCommand(params.prompt);
    let decoded: ReturnType<typeof decodePrompt>;
    // Local commands ignore attached context, including images that need not be read or decoded.
    try {
      decoded = decodePrompt(command ? params.prompt.filter((block) => block.type === "text") : params.prompt);
    } catch (error) {
      trace({ event: "prompt_rejected", sessionId: params.sessionId, code: error instanceof RequestError ? error.code : -32603 });
      throw error;
    }
    const { text, images } = decoded;
    trace({ event: "prompt_decoded", sessionId: params.sessionId, textLength: text.length,
      images: images.length, imageBase64Length: images.reduce((total, image) => total + image.data.length, 0) });
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const active: ActivePrompt = { cancelled: false, command: Boolean(command), acceptingInputs: true, inputs: new Set(), unsubscribe: () => {}, settled };
    entry.active = active;
    let stopReason: StopReason = "end_turn";
    let failed = false;
    let failureDetail: string | undefined;
    let deliveryFailed = false;
    // Pi listeners are synchronous; serialize writes and drain before responding.
    let updates = Promise.resolve();
    entry.fileSystem?.changes.clear();
    const toolUpdates = createToolUpdates(entry.cwd, entry.fileSystem?.changes);
    const imageLinks = new ImageLinkStream(entry.cwd);
    // Track only calls actually published to the client, not merely queued.
    const openTools = new Set<string>();
    active.flush = async () => {
      await updates;
      if (deliveryFailed) throw new Error("Unable to deliver session updates to the ACP client");
    };
    entry.session.bridgeApproval?.beginTurn(async toolCallId => {
      await active.flush!();
      if (!openTools.has(toolCallId)) throw new Error("Unable to publish tool call before requesting approval");
    });
    function enqueue(task: () => Promise<void>, settleTool = false) {
      updates = updates.then(async () => {
        if (!isClosed() && sessions.get(params.sessionId) === entry && (!active.cancelled || settleTool)) await task();
      }).catch(() => { deliveryFailed = true; });
      return updates;
    }
    function enqueueUpdate(update: SessionUpdate) {
      const terminal = update.sessionUpdate === "tool_call_update" && ["completed", "failed"].includes(update.status ?? "");
      return enqueue(async () => {
        if (terminal && !openTools.has(update.toolCallId)) return;
        let presented = await toolImageLinks(update, artifactDir);
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "image") {
          presented = { ...update, content: await imageLink(update.content, artifactDir) };
        }
        if (active.cancelled && !terminal) return;
        await sendUpdate({ sessionId: params.sessionId, update: presented });
        if (update.sessionUpdate === "tool_call") openTools.add(update.toolCallId);
        if (terminal) openTools.delete(update.toolCallId);
      }, terminal);
    }
    function enqueueText(text: string, sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk") {
      return text ? enqueueUpdate({ sessionUpdate, content: { type: "text", text } }) : updates;
    }
    let lastUsage: { used: number; size: number } | undefined;
    async function refreshUsage(estimatedTokens?: number) {
      if (isClosed() || sessions.get(params.sessionId) !== entry || deleting.has(params.sessionId)) return;
      const update = usageUpdate(entry.session, estimatedTokens);
      if (!update || update.sessionUpdate !== "usage_update") return;
      if (lastUsage?.used === update.used && lastUsage.size === update.size) return;
      await sendUpdate({ sessionId: params.sessionId, update });
      lastUsage = update;
    }
    active.notify = enqueueText;
    active.update = enqueueUpdate;
    for (const notice of entry.notices?.splice(0) ?? []) enqueueText(notice);
    try {
      active.unsubscribe = entry.session.subscribe((event) => {
        // Metadata only: distinguish provider/tool/retry waits without logging prompts or arguments.
        if (["agent_start", "message_start", "tool_execution_start", "tool_execution_end", "auto_retry_start", "agent_settled"].includes(event.type)) {
          trace({ event: "sdk_event", sessionId: params.sessionId, type: event.type });
        }
        if (active.cancelled) {
          if (event.type === "tool_execution_end") {
            for (const update of toolUpdates(event)) enqueueUpdate(update);
          }
          return;
        }
        if (event.type === "compaction_start") {
          enqueueText(`正在压缩上下文（${event.reason === "manual" ? "手动" : event.reason === "overflow" ? "上下文超限，准备重试" : "接近上下文上限"}）……\n`);
        } else if (event.type === "compaction_end") {
          enqueueText(event.result
            ? `压缩完成：${event.result.tokensBefore} → 约 ${event.result.estimatedTokensAfter ?? "未知"} token。${event.willRetry ? "继续处理当前请求。" : ""}\n`
            : event.aborted ? "上下文压缩已取消。\n" : "上下文压缩未完成。\n");
          enqueue(() => refreshUsage(event.result?.estimatedTokensAfter));
        } else if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
          enqueueText(`请求暂时失败，准备重试（${event.attempt}/${event.maxAttempts}，约 ${Math.ceil(event.delayMs / 1000)} 秒后）。\n`);
        }
        if (event.type === "message_update" && (
          event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta"
        )) {
          const sessionUpdate = event.assistantMessageEvent.type === "thinking_delta"
            ? "agent_thought_chunk" as const : "agent_message_chunk" as const;
          const text = event.assistantMessageEvent.delta;
          enqueueText(sessionUpdate === "agent_message_chunk" ? imageLinks.push(text) : text, sessionUpdate);
        }
        for (const update of toolUpdates(event)) enqueueUpdate(update);
        if (event.type === "message_end" && event.message.role === "custom") {
          for (const update of customMessageUpdates(event.message)) enqueueUpdate(update);
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          enqueueText(imageLinks.finish());
          // Pi persists message_end after notifying listeners; read usage from the queued task.
          if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
            enqueue(() => refreshUsage());
          }
          failed = event.message.stopReason === "error";
          failureDetail = failed ? event.message.errorMessage : undefined;
          stopReason = event.message.stopReason === "aborted" ? "cancelled"
            : event.message.stopReason === "length" ? "max_tokens" : "end_turn";
        }
      });
      trace({ event: "prompt_dispatched", sessionId: params.sessionId, command: command?.name ?? "model" });
      if (command) {
        await executeBridgeCommand(command, {
          session: entry.session, sessionId: params.sessionId, cwd: entry.cwd,
          notify: enqueueText, enqueue, trace,
          async syncConfiguration(force = false) {
            const published = await syncConfiguration(params.sessionId, entry, { force });
            if (published) await publishUsage(params.sessionId, entry.session);
            return published;
          },
          publishCommands: () => sendUpdate({ sessionId: params.sessionId, update: {
            sessionUpdate: "available_commands_update", availableCommands: availableCommands(entry.session),
          } }),
        });
      } else if (images.length) {
        await entry.session.prompt(text, { images });
      } else {
        await entry.session.prompt(text);
      }
      while (active.inputs.size) await Promise.all([...active.inputs]);
      active.acceptingInputs = false;
      if (active.inputError) throw active.inputError;
      enqueueText(imageLinks.finish());
      await updates;
      if (active.cancelled) return { stopReason: "cancelled" as const };
      if (failed) throw new Error(failureDetail || "Model returned an error without details");
      if (deliveryFailed) throw new Error("Unable to deliver session updates to the ACP client");
      return { stopReason };
    } catch (error) {
      trace({ event: "prompt_failed", sessionId: params.sessionId,
        code: error instanceof RequestError ? error.code : -32603, cancelled: active.cancelled });
      if (active.cancelled) return { stopReason: "cancelled" as const };
      if (command?.name === "compact" && error instanceof Error) {
        if (error.message === "Compaction cancelled") return { stopReason: "cancelled" as const };
        if (["Already compacted", "Nothing to compact (session too small)"].includes(error.message)) {
          enqueueText("当前没有需要压缩的历史；可以继续对话。\n");
          await updates;
          if (!deliveryFailed) return { stopReason: "end_turn" as const };
        }
      }
      throw bridgeError(command ? `Pi /${command.name} failed` : "Pi prompt failed", error);
    } finally {
      active.acceptingInputs = false;
      entry.session.bridgeApproval?.cancelTurn();
      while (active.inputs.size) await Promise.all([...active.inputs]);
      if (active.cancelled) entry.session.clearQueue?.();
      active.unsubscribe();
      entry.fileSystem?.changes.clear();
      await updates;
      // Like Claude ACP, settle published foreground tools before ending the
      // prompt. A missing result is explicitly unknown, never a success.
      for (const toolCallId of openTools) enqueueUpdate({ sessionUpdate: "tool_call_update", toolCallId, status: "failed",
        content: [{ type: "content", content: { type: "text", text: active.cancelled
          ? "操作已取消；工具未报告最终结果，已发生的文件变更不会自动撤销。"
          : "本轮已结束，但工具未报告最终结果。" } }],
      });
      await updates;
      // Extensions can change configuration outside the bridge's setter paths.
      // Compare only at settlement, including failed/cancelled turns, not on deltas.
      if (!isClosed() && sessions.get(params.sessionId) === entry && !deleting.has(params.sessionId)) {
        // Do not put this wait in the content queue: model_select hooks may flush UI updates.
        try {
          await syncConfiguration(params.sessionId, entry, { settled: true });
          await refreshUsage();
        } catch {
          deliveryFailed = true;
        }
      }
      await updates;
      try {
        if (entry.session.sessionFile && (await index.get(params.sessionId))?.pending) await indexSession(params.sessionId, entry);
      } finally {
        entry.session.bridgeApproval?.finishTurn();
        if (entry.active === active) entry.active = undefined;
        finish();
        trace({ event: "prompt_settled", sessionId: params.sessionId, durationMs: Date.now() - started,
          cancelled: active.cancelled });
      }
    }
  };
}
