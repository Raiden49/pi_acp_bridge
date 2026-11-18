import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import {
  asRecord,
  type JsonRecord,
  nonBlank,
  parseSubagentLaunchMetadata,
  stripWrappedQuotes,
  type SubagentProtocolTracker,
  type SubagentTerminalState,
  withAirToolMeta,
} from "./subagents.js";

type JsonRpcId = string | number | null;

const CHILD_FINISH_GRACE_POLLS = 5;

export function defaultAgyBrainBaseDir(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".gemini", "antigravity-cli", "brain");
}

interface IncrementalTranscript {
  filePath: string;
  byteOffset: number;
  remainder: string;
  steps: JsonRecord[];
}

function createIncrementalTranscript(filePath: string): IncrementalTranscript {
  return { filePath, byteOffset: 0, remainder: "", steps: [] };
}

function syncIncrementalTranscript(reader: IncrementalTranscript): JsonRecord[] {
  let size: number;
  try {
    size = statSync(reader.filePath).size;
  } catch {
    return reader.steps;
  }

  if (size < reader.byteOffset) {
    reader.byteOffset = 0;
    reader.remainder = "";
    reader.steps.length = 0;
  }
  if (size === reader.byteOffset) {
    return reader.steps;
  }

  const delta = size - reader.byteOffset;
  let fd: number | undefined;
  try {
    fd = openSync(reader.filePath, "r");
    const buffer = Buffer.allocUnsafe(delta);
    const bytesRead = readSync(fd, buffer, 0, delta, reader.byteOffset);
    reader.byteOffset += bytesRead;
    const chunk = reader.remainder + buffer.toString("utf8", 0, bytesRead);
    const lines = chunk.split("\n");
    reader.remainder = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        reader.steps.push(asRecord(JSON.parse(trimmed)));
      } catch {}
    }
  } catch {
    // Ignore transient read errors on actively written log files.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  return reader.steps;
}

function stripToolResultTimestamps(content: string): string {
  return content
    .replace(/^(?:(?:Created|Completed) At: [^\n]+\n)+/g, "")
    .trim();
}

function shortPath(rawPath: unknown): string {
  const p = stripWrappedQuotes(rawPath) ?? "";
  return p.split("/").slice(-2).join("/") || p || "file";
}

function cleanToolArgs(args: JsonRecord): JsonRecord {
  const clean: JsonRecord = {};
  for (const [k, v] of Object.entries(args)) {
    clean[k] = typeof v === "string" ? (stripWrappedQuotes(v) ?? v) : v;
  }
  return clean;
}

const CHILD_TOOL_DESCRIPTORS: Record<string, (name: string, args: JsonRecord) => { kind: string; title: string }> = {
  read_file: (_n, args) => ({ kind: "read", title: `Read ${shortPath(args.Path ?? args.path)}` }),
  edit_file: (_n, args) => ({ kind: "edit", title: `Edit ${shortPath(args.Path ?? args.path)}` }),
  write_file: (_n, args) => ({ kind: "edit", title: `Write ${shortPath(args.Path ?? args.path)}` }),
  run_command: (_n, args) => {
    const summary = stripWrappedQuotes(args.toolSummary);
    const cmd = stripWrappedQuotes(args.CommandLine) ?? "";
    return { kind: "execute", title: summary || (cmd ? `Run ${cmd.slice(0, 60)}` : "Run command") };
  },
  search_web: (_n, args) => {
    const q = stripWrappedQuotes(args.query) ?? "";
    return { kind: "search", title: q ? `Search web: ${q}` : "Search web" };
  },
};

function describeChildToolCall(name: string, args: JsonRecord): { kind: string; title: string; rawInput: JsonRecord } {
  const descriptor = CHILD_TOOL_DESCRIPTORS[name.toLowerCase()];
  const { kind, title } = descriptor ? descriptor(name, args) : { kind: "other", title: `Run ${name}` };
  return { kind, title, rawInput: cleanToolArgs(args) };
}

function consumeReplayPrefix(buffer: string, incoming: string): { matched: boolean; nextBuffer: string } {
  const trimmedIncoming = incoming.trim();
  if (!trimmedIncoming || !buffer) return { matched: false, nextBuffer: buffer };
  if (!buffer.startsWith(trimmedIncoming)) {
    return { matched: false, nextBuffer: "" };
  }
  return { matched: true, nextBuffer: buffer.slice(trimmedIncoming.length).trimStart() };
}

interface ChildCursor {
  conversationId: string;
  subagentSessionId: string;
  reader: IncrementalTranscript;
  processedSteps: number;
  pendingToolCalls: Array<{ toolCallId: string; name: string; title: string; kind: string }>;
  finishedInTranscript: boolean;
  terminalStatus: SubagentTerminalState;
  idleAfterFinishPolls: number;
}

interface SessionTranscriptMonitorState {
  parentReader: IncrementalTranscript;
  parentProcessedSteps: number;
  liveTurnMaxStepIndex: number;
  wakeupSeenInTurn: boolean;
  childCursors: Map<string, ChildCursor>;
  deliveredSenders: Set<string>;
  pendingReplayMessages: string;
  pendingReplayThoughts: string;
}

interface HeldPromptState {
  id: JsonRpcId;
  sessionId: string;
  responseMsg: JsonRecord;
  timer?: ReturnType<typeof setInterval>;
}

export interface AgySubagentRuntimeOptions {
  brainBaseDir?: string;
  pollIntervalMs?: number;
  getTracker: (sessionId: string) => SubagentProtocolTracker;
  sendToClient: (message: AnyMessage) => Promise<void>;
}

/**
 * Bridges Antigravity CLI (`agy acp`) asynchronous background subagents into a single coherent ACP turn:
 * 1. Binds `invoke_subagent` tool calls to their spawned child `conversationId` and transcript.
 * 2. Streams child subagent thoughts and tool calls into Air under `_meta.jetbrains.air.subagentSessionId`.
 * 3. Holds premature `end_turn` responses while background subagents are still running, then streams
 *    the parent agent's post-wakeup synthesis before completing the turn.
 */
export class AgySubagentRuntime {
  private readonly brainBaseDir: string;
  private readonly pollIntervalMs: number;
  private readonly getTracker: (sessionId: string) => SubagentProtocolTracker;
  private readonly sendToClient: (message: AnyMessage) => Promise<void>;
  private readonly monitorStates = new Map<string, SessionTranscriptMonitorState>();
  private readonly heldPrompts = new Map<string, HeldPromptState>();
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(options: AgySubagentRuntimeOptions) {
    this.brainBaseDir = options.brainBaseDir ?? defaultAgyBrainBaseDir();
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.getTracker = options.getTracker;
    this.sendToClient = options.sendToClient;
  }

  private runSerialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const marker = run.then(() => {}, () => {});
    this.sessionLocks.set(sessionId, marker);
    void marker.finally(() => {
      if (this.sessionLocks.get(sessionId) === marker) {
        this.sessionLocks.delete(sessionId);
      }
    });
    return run;
  }

  private transcriptPath(conversationId: string): string {
    return join(this.brainBaseDir, conversationId, ".system_generated", "logs", "transcript.jsonl");
  }

  private getMonitorState(sessionId: string): SessionTranscriptMonitorState {
    let state = this.monitorStates.get(sessionId);
    if (!state) {
      state = {
        parentReader: createIncrementalTranscript(this.transcriptPath(sessionId)),
        parentProcessedSteps: 0,
        liveTurnMaxStepIndex: -1,
        wakeupSeenInTurn: false,
        childCursors: new Map(),
        deliveredSenders: new Set(),
        pendingReplayMessages: "",
        pendingReplayThoughts: "",
      };
      this.monitorStates.set(sessionId, state);
    }
    return state;
  }

  private ensureChildCursor(
    state: SessionTranscriptMonitorState,
    conversationId: string,
    subagentSessionId: string,
    logPath?: string,
  ): void {
    if (state.childCursors.has(conversationId)) return;
    state.childCursors.set(conversationId, {
      conversationId,
      subagentSessionId,
      reader: createIncrementalTranscript(logPath ?? this.transcriptPath(conversationId)),
      processedSteps: 0,
      pendingToolCalls: [],
      finishedInTranscript: false,
      terminalStatus: "completed",
      idleAfterFinishPolls: 0,
    });
  }

  private async emitSessionUpdate(sessionId: string, update: JsonRecord): Promise<void> {
    await this.sendToClient({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    } as AnyMessage);
  }

  clearHeldPrompt(sessionId: string): HeldPromptState | undefined {
    const held = this.heldPrompts.get(sessionId);
    if (!held) return undefined;
    if (held.timer) clearInterval(held.timer);
    this.heldPrompts.delete(sessionId);
    return held;
  }

  disposeAll(): void {
    for (const sessionId of [...this.heldPrompts.keys()]) {
      this.clearHeldPrompt(sessionId);
    }
  }

  /**
   * Filters out duplicate `PendingText` / `PendingThoughts` chunks that `agy acp` flushes at the
   * beginning of the next `session/prompt` turn when we already streamed them during a held turn.
   */
  shouldSuppressDuplicateUpdate(sessionId: string, update: JsonRecord): boolean {
    const state = this.monitorStates.get(sessionId);
    if (!state) return false;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return false;
    const text = typeof asRecord(update.content).text === "string" ? String(asRecord(update.content).text) : "";
    if (!text.trim()) return false;

    if (kind === "agent_message_chunk") {
      const res = consumeReplayPrefix(state.pendingReplayMessages, text);
      state.pendingReplayMessages = res.nextBuffer;
      return res.matched;
    }
    const res = consumeReplayPrefix(state.pendingReplayThoughts, text);
    state.pendingReplayThoughts = res.nextBuffer;
    return res.matched;
  }

  async onPromptStart(sessionId: string, onReleasePreviousPrompt: (heldId: JsonRpcId) => void): Promise<void> {
    await this.runSerialized(sessionId, async () => {
      const existingHeld = this.clearHeldPrompt(sessionId);
      if (existingHeld) {
        onReleasePreviousPrompt(existingHeld.id);
        for (const update of this.getTracker(sessionId).settleTurn(false)) {
          await this.emitSessionUpdate(sessionId, update);
        }
        await this.sendToClient(existingHeld.responseMsg as AnyMessage);
      }
      const state = this.getMonitorState(sessionId);
      const existingSteps = syncIncrementalTranscript(state.parentReader);
      state.parentProcessedSteps = existingSteps.length;
      state.liveTurnMaxStepIndex = existingSteps.length - 1;
      state.wakeupSeenInTurn = false;
    });
  }

  async onCancel(sessionId: string, onCancelHeldPrompt: (heldId: JsonRpcId) => void): Promise<void> {
    await this.runSerialized(sessionId, async () => {
      const held = this.clearHeldPrompt(sessionId);
      if (held) {
        onCancelHeldPrompt(held.id);
        await this.sendToClient({
          jsonrpc: "2.0",
          id: held.id,
          result: { stopReason: "cancelled" },
        } as AnyMessage);
      }
    });
  }

  onClose(sessionId: string): void {
    this.clearHeldPrompt(sessionId);
    this.monitorStates.delete(sessionId);
  }

  async onLiveSessionUpdate(sessionId: string): Promise<void> {
    await this.runSerialized(sessionId, async () => {
      if (this.getTracker(sessionId).hasOpenSubagents()) {
        await this.syncTranscriptsUnlocked(sessionId, false);
      }
    });
  }

  async maybeHoldPromptTurn(
    id: JsonRpcId,
    sessionId: string,
    responseMsg: JsonRecord,
    onHeldPromptFinished: (finishedId: JsonRpcId) => void,
  ): Promise<boolean> {
    return this.runSerialized(sessionId, async () => {
      const tracker = this.getTracker(sessionId);
      const state = this.getMonitorState(sessionId);
      await this.syncTranscriptsUnlocked(sessionId, false);
      if (!tracker.hasOpenSubagents()) {
        // Flush post-wakeup synthesis if a subagent completed just before end_turn arrived.
        if (state.wakeupSeenInTurn) {
          await this.syncTranscriptsUnlocked(sessionId, true);
        }
        return false;
      }
      if (state.parentReader.steps.length === 0) {
        return false;
      }

      this.clearHeldPrompt(sessionId);
      const held: HeldPromptState = { id, sessionId, responseMsg };
      this.heldPrompts.set(sessionId, held);

      const tick = async () => {
        await this.runSerialized(sessionId, async () => {
          if (!this.heldPrompts.has(sessionId)) return;
          const { readyToFinishHeldPrompt } = await this.syncTranscriptsUnlocked(sessionId, true);
          if (readyToFinishHeldPrompt && this.heldPrompts.has(sessionId)) {
            this.clearHeldPrompt(sessionId);
            onHeldPromptFinished(id);
            for (const update of tracker.settleTurn(false)) {
              await this.emitSessionUpdate(sessionId, update);
            }
            await this.sendToClient(responseMsg as AnyMessage);
          }
        });
      };

      held.timer = setInterval(() => {
        void tick();
      }, this.pollIntervalMs);
      held.timer.unref?.();
      void tick();
      return true;
    });
  }

  async syncTranscripts(sessionId: string, allowPostTurnParentSynthesis: boolean): Promise<{
    readyToFinishHeldPrompt: boolean;
  }> {
    return this.runSerialized(sessionId, () => this.syncTranscriptsUnlocked(sessionId, allowPostTurnParentSynthesis));
  }

  private async syncTranscriptsUnlocked(
    sessionId: string,
    allowPostTurnParentSynthesis: boolean,
  ): Promise<{ readyToFinishHeldPrompt: boolean }> {
    const tracker = this.getTracker(sessionId);
    const state = this.getMonitorState(sessionId);
    const parentSteps = syncIncrementalTranscript(state.parentReader);

    await this.syncParentSteps(sessionId, state, tracker, parentSteps, allowPostTurnParentSynthesis);

    for (const spawnEntry of tracker.getSpawnEntries()) {
      if (spawnEntry.conversationId) {
        this.ensureChildCursor(state, spawnEntry.conversationId, spawnEntry.subagentSessionId, spawnEntry.logPath);
      }
    }

    await this.syncChildCursors(sessionId, state, tracker, allowPostTurnParentSynthesis);

    if (!allowPostTurnParentSynthesis || tracker.hasOpenSubagents()) {
      return { readyToFinishHeldPrompt: false };
    }
    return { readyToFinishHeldPrompt: this.isParentTurnSettled(state, parentSteps) };
  }

  private async syncParentSteps(
    sessionId: string,
    state: SessionTranscriptMonitorState,
    tracker: SubagentProtocolTracker,
    parentSteps: JsonRecord[],
    allowPostTurnParentSynthesis: boolean,
  ): Promise<void> {
    if (!allowPostTurnParentSynthesis && !state.wakeupSeenInTurn && parentSteps.length > 0) {
      // Only treat steps before the first post-wakeup SYSTEM_MESSAGE as already streamed via ACP.
      let cutoff = parentSteps.length - 1;
      for (let k = state.parentProcessedSteps; k < parentSteps.length; k++) {
        if (parentSteps[k]?.type === "SYSTEM_MESSAGE") {
          cutoff = k - 1;
          break;
        }
      }
      if (cutoff > state.liveTurnMaxStepIndex) {
        state.liveTurnMaxStepIndex = cutoff;
      }
    }

    for (let i = state.parentProcessedSteps; i < parentSteps.length; i++) {
      const step = parentSteps[i]!;
      const stepType = typeof step.type === "string" ? step.type : "";
      const content = typeof step.content === "string" ? step.content : "";

      this.bindSubagentsFromParentStep(state, tracker, stepType, content);

      if (stepType === "SYSTEM_MESSAGE") {
        state.wakeupSeenInTurn = true;
        const senderId = content.match(/sender=([0-9a-fA-F-]{8,})/)?.[1]?.trim();
        if (senderId) {
          state.deliveredSenders.add(senderId);
          for (const update of tracker.completeSubagentByIdOrAlias(senderId, "completed")) {
            await this.emitSessionUpdate(sessionId, update);
          }
        }
      }

      if (i <= state.liveTurnMaxStepIndex) {
        state.parentProcessedSteps = i + 1;
        continue;
      }
      if (!allowPostTurnParentSynthesis) {
        // Leave post-wakeup steps unprocessed so maybeHoldPromptTurn / polling flushes them once held.
        break;
      }

      if (stepType === "PLANNER_RESPONSE") {
        await this.emitParentPlannerStep(sessionId, state, tracker, step, i);
      }
      state.parentProcessedSteps = i + 1;
    }
  }

  private bindSubagentsFromParentStep(
    state: SessionTranscriptMonitorState,
    tracker: SubagentProtocolTracker,
    stepType: string,
    content: string,
  ): void {
    if (stepType !== "GENERIC") return;
    if (content.includes("Created the following subagent:")) {
      const meta = parseSubagentLaunchMetadata(content);
      if (!meta.conversationId) return;
      const bound = tracker.bindNextUnboundSpawn(meta.conversationId, meta.logPath ?? this.transcriptPath(meta.conversationId));
      if (bound) {
        this.ensureChildCursor(state, meta.conversationId, bound.subagentSessionId, bound.logPath);
      }
      return;
    }
    if (!content.includes("active subagent(s):")) return;
    const bracketStart = content.indexOf("[");
    const bracketEnd = content.lastIndexOf("]");
    if (bracketStart < 0 || bracketEnd <= bracketStart) return;
    try {
      const list = JSON.parse(content.slice(bracketStart, bracketEnd + 1)) as unknown[];
      for (const item of list) {
        const rec = asRecord(item);
        const convId = stripWrappedQuotes(rec.conversationId);
        const transcriptUri = stripWrappedQuotes(rec.transcript);
        const logPath = transcriptUri?.startsWith("file://")
          ? decodeURIComponent(transcriptUri.slice("file://".length))
          : (convId ? this.transcriptPath(convId) : undefined);
        if (!convId) continue;
        const bound = tracker.bindNextUnboundSpawn(convId, logPath);
        if (bound) {
          this.ensureChildCursor(state, convId, bound.subagentSessionId, bound.logPath);
        }
      }
    } catch {}
  }

  private async emitParentPlannerStep(
    sessionId: string,
    state: SessionTranscriptMonitorState,
    tracker: SubagentProtocolTracker,
    step: JsonRecord,
    stepIndex: number,
  ): Promise<void> {
    const thinking = typeof step.thinking === "string" ? step.thinking : "";
    if (thinking) {
      state.pendingReplayThoughts = [state.pendingReplayThoughts, thinking.trim()].filter(Boolean).join(" ").trim();
      await this.emitSessionUpdate(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: thinking.endsWith("\n") ? thinking : `${thinking}\n` },
      });
    }
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
      const tc = asRecord(toolCalls[tcIdx]);
      const tcName = typeof tc.name === "string" ? tc.name : "tool";
      const rawUpdates = tracker.transformSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: `bg_parent_${stepIndex}_${tcIdx}`,
        title: `Run ${tcName}`,
        name: tcName,
        kind: "other",
        status: "completed",
        rawInput: asRecord(tc.args),
      });
      for (const u of rawUpdates) {
        await this.emitSessionUpdate(sessionId, u);
      }
    }
    const textContent = typeof step.content === "string" ? step.content : "";
    if (textContent) {
      state.pendingReplayMessages = [state.pendingReplayMessages, textContent.trim()].filter(Boolean).join(" ").trim();
      // Prefix with paragraph separation so sequential subagent wakeup reports never glue onto the previous sentence.
      await this.emitSessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\n${textContent.trim()}\n` },
      });
    }
  }

  private async syncChildCursors(
    sessionId: string,
    state: SessionTranscriptMonitorState,
    tracker: SubagentProtocolTracker,
    allowGraceCompletion: boolean,
  ): Promise<void> {
    for (const cursor of state.childCursors.values()) {
      const childSteps = syncIncrementalTranscript(cursor.reader);
      for (let j = cursor.processedSteps; j < childSteps.length; j++) {
        await this.processChildStep(sessionId, cursor, childSteps[j]!, j);
        cursor.processedSteps = j + 1;
      }

      if (!cursor.finishedInTranscript) continue;
      if (state.deliveredSenders.has(cursor.conversationId)) {
        for (const update of tracker.completeSubagentByIdOrAlias(cursor.conversationId, cursor.terminalStatus)) {
          await this.emitSessionUpdate(sessionId, update);
        }
        continue;
      }
      if (allowGraceCompletion) {
        cursor.idleAfterFinishPolls++;
        if (cursor.idleAfterFinishPolls >= CHILD_FINISH_GRACE_POLLS) {
          for (const update of tracker.completeSubagentByIdOrAlias(cursor.conversationId, cursor.terminalStatus)) {
            await this.emitSessionUpdate(sessionId, update);
          }
        }
      }
    }
  }

  private async processChildStep(
    sessionId: string,
    cursor: ChildCursor,
    step: JsonRecord,
    stepIndex: number,
  ): Promise<void> {
    const stepType = typeof step.type === "string" ? step.type : "";
    const subId = cursor.subagentSessionId;

    if (stepType === "PLANNER_RESPONSE") {
      const thinking = typeof step.thinking === "string" ? step.thinking : "";
      if (thinking) {
        await this.emitSessionUpdate(
          sessionId,
          withAirToolMeta({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thinking } }, { subagentSessionId: subId }),
        );
      }

      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
        await this.emitChildToolCall(sessionId, cursor, asRecord(toolCalls[tcIdx]), stepIndex, tcIdx);
      }

      const textContent = typeof step.content === "string" ? step.content.trim() : "";
      if (toolCalls.length === 0 && (textContent || step.status === "ERROR")) {
        cursor.finishedInTranscript = true;
        cursor.terminalStatus = step.status === "ERROR" ? "failed" : "completed";
        cursor.idleAfterFinishPolls = 0;
      }
      return;
    }

    if (stepType === "GENERIC") {
      const pending = cursor.pendingToolCalls.shift();
      if (!pending || pending.name === "send_message") return;
      const failed = step.status === "ERROR";
      const rawResult = typeof step.content === "string" ? stripToolResultTimestamps(step.content) : "";
      const errorMsg = typeof step.error === "string" ? step.error : "";
      const outText = failed ? (errorMsg || rawResult) : rawResult;
      await this.emitSessionUpdate(
        sessionId,
        withAirToolMeta(
          {
            sessionUpdate: "tool_call_update",
            toolCallId: pending.toolCallId,
            title: pending.title,
            kind: pending.kind,
            status: failed ? "failed" : "completed",
            ...(outText
              ? { content: [{ type: "content", content: { type: "text", text: outText.slice(0, 4000) } }] }
              : {}),
          },
          { subagentSessionId: subId, commandTitle: pending.title },
        ),
      );
    }
  }

  private async emitChildToolCall(
    sessionId: string,
    cursor: ChildCursor,
    tc: JsonRecord,
    stepIndex: number,
    tcIdx: number,
  ): Promise<void> {
    const tcName = typeof tc.name === "string" ? tc.name : "tool";
    const tcArgs = asRecord(tc.args);
    const toolCallId = `sub_${cursor.conversationId.slice(0, 8)}_${stepIndex}_${tcIdx}`;
    const subId = cursor.subagentSessionId;

    if (tcName === "send_message") {
      const msgText = stripWrappedQuotes(tcArgs.Message ?? tcArgs.message);
      if (msgText) {
        await this.emitSessionUpdate(
          sessionId,
          withAirToolMeta({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${msgText}\n` } }, { subagentSessionId: subId }),
        );
      }
      cursor.pendingToolCalls.push({ toolCallId, name: tcName, title: "Send report to parent agent", kind: "other" });
      return;
    }

    const desc = describeChildToolCall(tcName, tcArgs);
    cursor.pendingToolCalls.push({ toolCallId, name: tcName, title: desc.title, kind: desc.kind });
    await this.emitSessionUpdate(
      sessionId,
      withAirToolMeta(
        {
          sessionUpdate: "tool_call",
          toolCallId,
          title: desc.title,
          kind: desc.kind,
          status: "in_progress",
          rawInput: desc.rawInput,
        },
        { subagentSessionId: subId, commandTitle: desc.title },
      ),
    );
  }

  private isParentTurnSettled(state: SessionTranscriptMonitorState, parentSteps: JsonRecord[]): boolean {
    if (parentSteps.length === 0) return true;
    const lastIdx = parentSteps.length - 1;
    // If no post-turn wakeup steps arrived after the live turn, the parent has already settled.
    if (lastIdx <= state.liveTurnMaxStepIndex && state.parentProcessedSteps >= parentSteps.length) {
      return true;
    }
    const lastStep = parentSteps[lastIdx]!;
    const lastType = typeof lastStep.type === "string" ? lastStep.type : "";
    const lastToolCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : [];
    return (
      lastType === "PLANNER_RESPONSE" &&
      lastStep.status === "DONE" &&
      lastToolCalls.length === 0 &&
      state.parentProcessedSteps >= parentSteps.length
    );
  }
}
