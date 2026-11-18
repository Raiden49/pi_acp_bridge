import type { SessionUpdate } from "@agentclientprotocol/sdk";

export type JsonRecord = Record<string, unknown>;

export const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

export const nonBlank = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export const stripWrappedQuotes = (value: unknown): string | undefined => {
  const str = nonBlank(value);
  if (!str) return undefined;
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return nonBlank(str.slice(1, -1));
  }
  return str;
};

// TODO: Add Pi's native subagent tool name here once Pi introduces subagent support.
const SUBAGENT_TOOL_NAMES = new Set([
  "invoke_subagent",
  "subagent",
  "spawn_agent",
  "delegate_task",
]);

const SUBAGENT_CONTROL_TOOL_NAMES = new Set([
  "send_message",
  "manage_subagents",
  "define_subagent",
  "swarm",
]);

export interface SubagentSpawnInfo {
  subagentSessionId: string;
  name: string;
  description: string;
  prompt?: string;
}

export type SubagentTerminalState = "completed" | "failed" | "cancelled" | "disconnected";

function toSessionUpdate(record: JsonRecord): SessionUpdate {
  return record as unknown as SessionUpdate;
}

export function withAirToolMeta(
  update: JsonRecord,
  patch: { subagent?: boolean; commandTitle?: string; subagentSessionId?: string },
): JsonRecord {
  const meta = asRecord(update._meta);
  const jetbrains = asRecord(meta.jetbrains);
  const air = asRecord(jetbrains.air);
  const nextAir: JsonRecord = { ...air };
  if (patch.subagent !== undefined) nextAir.subagent = patch.subagent;
  if (patch.commandTitle !== undefined) nextAir.commandTitle = patch.commandTitle;
  if (patch.subagentSessionId !== undefined) nextAir.subagentSessionId = patch.subagentSessionId;
  return {
    ...update,
    _meta: {
      ...meta,
      jetbrains: {
        ...jetbrains,
        air: nextAir,
      },
    },
  };
}

export function buildSubagentSpawnedUpdate(info: SubagentSpawnInfo): SessionUpdate {
  return toSessionUpdate({
    sessionUpdate: "subagent_spawned",
    subagentSessionId: info.subagentSessionId,
    name: info.name,
    description: info.description,
    ...(info.prompt ? { prompt: info.prompt } : {}),
    capabilities: { cancel: false, close: false },
  });
}

export function buildSubagentStateUpdate(
  subagentSessionId: string,
  state: SubagentTerminalState,
): SessionUpdate {
  return toSessionUpdate({
    sessionUpdate: "subagent_state_update",
    subagentSessionId,
    state,
  });
}

export function extractToolOutputText(update: JsonRecord): string {
  const parts: string[] = [];
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      const rec = asRecord(item);
      if (rec.type === "content") {
        const inner = asRecord(rec.content);
        if (inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
      } else if (rec.type === "text" && typeof rec.text === "string") {
        parts.push(rec.text);
      }
    }
  }
  const rawOutput = update.rawOutput;
  if (typeof rawOutput === "string") {
    parts.push(rawOutput);
  } else if (rawOutput && typeof rawOutput === "object") {
    const raw = asRecord(rawOutput);
    for (const key of ["output", "text", "result", "stdout"]) {
      if (typeof raw[key] === "string") parts.push(raw[key] as string);
    }
    if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        const b = asRecord(block);
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function cleanToolToken(toolName: string | undefined): string {
  return (toolName ?? "").trim().toLowerCase().replace(/^run\s+/i, "").trim();
}

export function isSubagentSpawnTool(toolName: string | undefined, rawInput: JsonRecord): boolean {
  const token = cleanToolToken(toolName);
  if (SUBAGENT_TOOL_NAMES.has(token)) return true;
  if (token === "swarm" && stripWrappedQuotes(rawInput.action)?.toLowerCase() === "add") return true;
  const hasType = Boolean(nonBlank(rawInput.TypeName) ?? nonBlank(rawInput.type_name) ?? nonBlank(rawInput.typeName));
  const hasPrompt = Boolean(nonBlank(rawInput.Prompt) ?? nonBlank(rawInput.prompt));
  return hasType && hasPrompt;
}

export function isAsyncSubagentLaunchTool(toolName: string | undefined, rawInput: JsonRecord): boolean {
  const token = cleanToolToken(toolName);
  if (token === "invoke_subagent") return true;
  if (token === "swarm" && stripWrappedQuotes(rawInput.action)?.toLowerCase() === "add") return true;
  if (Boolean(nonBlank(rawInput.TypeName) && nonBlank(rawInput.Prompt))) return true;
  return rawInput.run_in_background === true || rawInput.async === true;
}

export function isSubagentControlTool(toolName: string | undefined, rawInput: JsonRecord): boolean {
  const token = cleanToolToken(toolName);
  if (SUBAGENT_CONTROL_TOOL_NAMES.has(token)) return true;
  if (nonBlank(rawInput.Recipient) && nonBlank(rawInput.Message)) return true;
  const action = stripWrappedQuotes(rawInput.Action ?? rawInput.action)?.toLowerCase();
  return Boolean(action && ("ConversationIds" in rawInput || ["list", "kill", "kill_all"].includes(action)));
}

export function extractSubagentSpawnInput(
  toolCallId: string,
  title: string | undefined,
  rawInput: JsonRecord,
): { name: string; description: string; prompt?: string } {
  const role = stripWrappedQuotes(rawInput.Role ?? rawInput.role ?? rawInput.name ?? rawInput.agent);
  const typeName = stripWrappedQuotes(rawInput.TypeName ?? rawInput.type_name ?? rawInput.typeName ?? rawInput.subagent_type);
  const prompt = stripWrappedQuotes(rawInput.Prompt ?? rawInput.prompt ?? rawInput.brief ?? rawInput.task);
  const cleanTitle = stripWrappedQuotes(title);
  const name = role ?? typeName ?? cleanTitle ?? `Subagent (${toolCallId})`;
  const description = role && typeName && role !== typeName
    ? `${role} (${typeName})`
    : (typeName ?? role ?? cleanTitle ?? "task");
  return { name, description, ...(prompt ? { prompt } : {}) };
}

export function parseConversationIdFromOutput(text: string, rawOutput: unknown): string | undefined {
  const raw = asRecord(rawOutput);
  const direct = nonBlank(raw.conversationId) ?? nonBlank(raw.subagentSessionId) ?? nonBlank(raw.interactionId) ?? nonBlank(raw.interaction_id);
  if (direct) return direct;
  if (Array.isArray(raw.subagents) && raw.subagents.length > 0) {
    const first = asRecord(raw.subagents[0]);
    const id = nonBlank(first.conversationId) ?? nonBlank(first.interactionId) ?? nonBlank(first.interaction_id) ?? nonBlank(first.id);
    if (id) return id;
  }
  const match = text.match(/"conversationId"\s*:\s*"([^"]+)"/) ?? text.match(/conversationId["']?\s*[:=]\s*["']?([0-9a-fA-F-]{8,})/);
  return match?.[1]?.trim();
}

export function parseSubagentLaunchMetadata(text: string): { conversationId?: string; logPath?: string } {
  const conversationId = parseConversationIdFromOutput(text, undefined);
  const uriMatch = text.match(/"logAbsoluteUri"\s*:\s*"([^"]+)"/);
  let logPath: string | undefined;
  if (uriMatch?.[1]) {
    const rawUri = uriMatch[1].trim();
    logPath = rawUri.startsWith("file://") ? decodeURIComponent(rawUri.slice("file://".length)) : rawUri;
  }
  return { ...(conversationId ? { conversationId } : {}), ...(logPath ? { logPath } : {}) };
}

export interface PendingSpawnTool {
  toolCallId: string;
  subagentSessionId: string;
  name: string;
  description: string;
  prompt?: string;
  asyncLaunch: boolean;
  completed: boolean;
  conversationId?: string;
  logPath?: string;
}

type PendingKillTarget = { killAll: true } | { killAll: false; ids: string[] };

export class SubagentProtocolTracker {
  private readonly spawnTools = new Map<string, PendingSpawnTool>();
  private readonly spawnOrder: PendingSpawnTool[] = [];
  private readonly aliasToCanonicalId = new Map<string, string>();
  private readonly openSubagents = new Set<string>();
  private readonly pendingKillTools = new Map<string, PendingKillTarget>();

  hasOpenSubagents(): boolean {
    return this.openSubagents.size > 0;
  }

  getSpawnEntries(): ReadonlyArray<PendingSpawnTool> {
    return this.spawnOrder;
  }

  bindSubagentConversation(subagentSessionId: string, conversationId: string, logPath?: string): void {
    this.aliasToCanonicalId.set(conversationId, subagentSessionId);
    const entry = this.spawnOrder.find(item => item.subagentSessionId === subagentSessionId);
    if (entry) {
      entry.conversationId = conversationId;
      if (logPath) entry.logPath = logPath;
    }
  }

  bindNextUnboundSpawn(conversationId: string, logPath?: string): PendingSpawnTool | undefined {
    const existing = this.aliasToCanonicalId.get(conversationId);
    if (existing) {
      const found = this.spawnOrder.find(item => item.subagentSessionId === existing);
      if (found && logPath && !found.logPath) found.logPath = logPath;
      return found;
    }
    const next = this.spawnOrder.find(item => !item.conversationId && this.openSubagents.has(item.subagentSessionId));
    if (!next) return undefined;
    next.conversationId = conversationId;
    if (logPath) next.logPath = logPath;
    this.aliasToCanonicalId.set(conversationId, next.subagentSessionId);
    return next;
  }

  completeSubagentByIdOrAlias(idOrConversationId: string, state: SubagentTerminalState = "completed"): JsonRecord[] {
    const canonicalId = this.resolveCanonicalId(idOrConversationId);
    if (!this.openSubagents.delete(canonicalId)) return [];
    return [buildSubagentStateUpdate(canonicalId, state) as unknown as JsonRecord];
  }

  transformSessionUpdate(update: JsonRecord): JsonRecord[] {
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "tool_call") return this.handleToolCall(update);
    if (kind === "tool_call_update") return this.handleToolCallUpdate(update);
    return [update];
  }

  settleTurn(cancelled = false): JsonRecord[] {
    const updates: JsonRecord[] = [];
    const terminalState: SubagentTerminalState = cancelled ? "cancelled" : "completed";
    for (const subagentSessionId of this.openSubagents) {
      updates.push(buildSubagentStateUpdate(subagentSessionId, terminalState) as unknown as JsonRecord);
    }
    this.openSubagents.clear();
    this.spawnTools.clear();
    this.spawnOrder.length = 0;
    this.aliasToCanonicalId.clear();
    this.pendingKillTools.clear();
    return updates;
  }

  resolveCanonicalId(id: string): string {
    return this.aliasToCanonicalId.get(id) ?? id;
  }

  private handleToolCall(update: JsonRecord): JsonRecord[] {
    const toolCallId = nonBlank(update.toolCallId);
    if (!toolCallId) return [update];
    const title = nonBlank(update.title);
    const name = nonBlank(update.name) ?? title;
    const rawInput = asRecord(update.rawInput);

    if (isSubagentSpawnTool(name, rawInput)) {
      return this.handleSpawnToolCall(toolCallId, title, rawInput, update);
    }
    if (isSubagentControlTool(name, rawInput)) {
      return this.handleControlToolCall(toolCallId, title, name, rawInput, update);
    }
    return [update];
  }

  private handleSpawnToolCall(
    toolCallId: string,
    title: string | undefined,
    rawInput: JsonRecord,
    update: JsonRecord,
  ): JsonRecord[] {
    const info = extractSubagentSpawnInput(toolCallId, title, rawInput);
    const subagentSessionId = nonBlank(rawInput.subagentSessionId) ?? nonBlank(rawInput.conversationId) ?? `subagent:${toolCallId}`;
    const entry: PendingSpawnTool = {
      toolCallId,
      subagentSessionId,
      name: info.name,
      description: info.description,
      prompt: info.prompt,
      asyncLaunch: isAsyncSubagentLaunchTool(nonBlank(update.name) ?? title, rawInput),
      completed: false,
    };
    this.spawnTools.set(toolCallId, entry);
    this.spawnOrder.push(entry);
    this.openSubagents.add(subagentSessionId);

    const annotatedCall = withAirToolMeta(
      {
        ...update,
        title: title && !/^run\s+invoke_subagent$/i.test(title) && title !== "invoke_subagent" ? title : `Subagent: ${info.name}`,
      },
      { subagent: true, commandTitle: info.name },
    );
    const spawned = buildSubagentSpawnedUpdate({
      subagentSessionId,
      name: info.name,
      description: info.description,
      prompt: info.prompt,
    }) as unknown as JsonRecord;

    const out: JsonRecord[] = [annotatedCall, spawned];
    if (info.prompt) {
      out.push(
        withAirToolMeta(
          { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Task: ${info.prompt}\n` } },
          { subagentSessionId },
        ),
      );
    }
    if (update.status === "completed" || update.status === "failed") {
      out.push(...this.finishSpawnTool(entry, update));
    }
    return out;
  }

  private handleControlToolCall(
    toolCallId: string,
    title: string | undefined,
    name: string | undefined,
    rawInput: JsonRecord,
    update: JsonRecord,
  ): JsonRecord[] {
    const recipient = stripWrappedQuotes(rawInput.Recipient ?? rawInput.recipient);
    const message = stripWrappedQuotes(rawInput.Message ?? rawInput.message);
    const action = stripWrappedQuotes(rawInput.Action ?? rawInput.action)?.toLowerCase();
    const out: JsonRecord[] = [
      withAirToolMeta(update, {
        commandTitle: recipient ? `Send message (${recipient.slice(0, 8)})` : (title ?? name),
      }),
    ];

    if (recipient && message) {
      const canonicalId = this.resolveCanonicalId(recipient);
      if (this.openSubagents.has(canonicalId)) {
        out.push(
          withAirToolMeta(
            { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `\nMessage to subagent:\n${message}\n` } },
            { subagentSessionId: canonicalId },
          ),
        );
      }
    }

    const killTarget = parseKillTarget(action, rawInput);
    if (killTarget) {
      if (update.status === "completed") {
        out.push(...this.applyKillTarget(killTarget));
      } else if (update.status !== "failed") {
        this.pendingKillTools.set(toolCallId, killTarget);
      }
    }
    return out;
  }

  private applyKillTarget(target: PendingKillTarget): JsonRecord[] {
    const out: JsonRecord[] = [];
    if (target.killAll) {
      for (const subId of this.openSubagents) {
        out.push(buildSubagentStateUpdate(subId, "cancelled") as unknown as JsonRecord);
      }
      this.openSubagents.clear();
      return out;
    }
    for (const rawId of target.ids) {
      const canonicalId = this.resolveCanonicalId(rawId);
      if (this.openSubagents.delete(canonicalId)) {
        out.push(buildSubagentStateUpdate(canonicalId, "cancelled") as unknown as JsonRecord);
      }
    }
    return out;
  }

  private handleToolCallUpdate(update: JsonRecord): JsonRecord[] {
    const toolCallId = nonBlank(update.toolCallId);
    if (!toolCallId) return [update];

    const pendingKill = this.pendingKillTools.get(toolCallId);
    if (pendingKill) {
      const status = nonBlank(update.status);
      if (status === "completed") {
        this.pendingKillTools.delete(toolCallId);
        return [update, ...this.applyKillTarget(pendingKill)];
      }
      if (status === "failed") {
        this.pendingKillTools.delete(toolCallId);
      }
      return [update];
    }

    const entry = this.spawnTools.get(toolCallId);
    if (!entry) return [update];

    const annotated = withAirToolMeta(update, { subagent: true, commandTitle: entry.name });
    const out: JsonRecord[] = [annotated];
    const text = extractToolOutputText(update);
    const meta = parseSubagentLaunchMetadata(text);
    const parsedConvId = meta.conversationId ?? parseConversationIdFromOutput(text, update.rawOutput);
    if (parsedConvId) {
      this.bindSubagentConversation(entry.subagentSessionId, parsedConvId, meta.logPath);
    }

    const status = nonBlank(update.status);
    if (status === "completed" || status === "failed") {
      out.push(...this.finishSpawnTool(entry, update, text, parsedConvId));
    } else if (text) {
      out.push(
        withAirToolMeta(
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${text}\n` } },
          { subagentSessionId: entry.subagentSessionId },
        ),
      );
    }
    return out;
  }

  private finishSpawnTool(
    entry: PendingSpawnTool,
    update: JsonRecord,
    extractedText?: string,
    parsedConvId?: string,
  ): JsonRecord[] {
    if (entry.completed) return [];
    entry.completed = true;
    const out: JsonRecord[] = [];
    const text = extractedText ?? extractToolOutputText(update);
    const meta = parseSubagentLaunchMetadata(text);
    const convId = parsedConvId ?? meta.conversationId ?? parseConversationIdFromOutput(text, update.rawOutput);
    if (convId) {
      this.bindSubagentConversation(entry.subagentSessionId, convId, meta.logPath);
    }
    if (text) {
      out.push(
        withAirToolMeta(
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${text}\n` } },
          { subagentSessionId: entry.subagentSessionId },
        ),
      );
    }
    const failed = update.status === "failed";
    const isAsyncLaunch = !failed && (
      entry.asyncLaunch ||
      (Boolean(convId) && /Created the following subagent|running in the background/i.test(text))
    );
    if (!isAsyncLaunch) {
      this.openSubagents.delete(entry.subagentSessionId);
      out.push(buildSubagentStateUpdate(entry.subagentSessionId, failed ? "failed" : "completed") as unknown as JsonRecord);
    }
    return out;
  }
}

function parseKillTarget(action: string | undefined, rawInput: JsonRecord): PendingKillTarget | undefined {
  if (action === "kill_all") return { killAll: true };
  if (action !== "kill") return undefined;
  const ids: string[] = [];
  if (Array.isArray(rawInput.ConversationIds)) {
    for (const rawId of rawInput.ConversationIds) {
      const id = stripWrappedQuotes(rawId);
      if (id) ids.push(id);
    }
  }
  const named = stripWrappedQuotes(rawInput.name);
  if (named) ids.push(named);
  return { killAll: false, ids };
}
