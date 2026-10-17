import { expect, test } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

test("refreshes context during a running prompt and immediately after compaction", async () => {
  let tokens: number | null = 175524;
  let size = 272000;
  let listener: Parameters<AgentSession["subscribe"]>[0] | undefined;
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    abort: async () => { finish?.(); }, dispose() {},
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    getContextUsage: () => ({ tokens, contextWindow: size, percent: null }),
    async prompt() { await new Promise<void>((resolve) => { finish = resolve; started(); }); },
  }) });
  const emit = (event: unknown) => listener?.(event as Parameters<NonNullable<typeof listener>>[0]);
  const messageEnd = () => emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
  const expectUsage = async (used: number) => expect((await client.nextNotification()).params.update)
    .toEqual({ sessionUpdate: "usage_update", used, size });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    await expectUsage(175524);
    const prompt = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "continue" }] });
    await running;
    // The SDK persists the new usage after its synchronous message_end listeners return.
    messageEnd();
    tokens = 256603;
    await expectUsage(256603);
    tokens = null;
    emit({ type: "compaction_end", result: { tokensBefore: 256603, estimatedTokensAfter: 59927 } });
    expect((await client.nextNotification()).params.update.content.text).toContain("59927");
    await expectUsage(59927);
    tokens = 61234;
    messageEnd();
    await expectUsage(61234);
    messageEnd(); // Identical occupancy must not enqueue a duplicate notification.
    await Promise.resolve();
    size = 128000;
    messageEnd();
    await expectUsage(61234); // A changed window must still be published.
    finish();
    expect(await prompt).toHaveProperty("result");
    // Drain through a text marker to detect any duplicate end-of-prompt usage.
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/name" }] });
    expect((await client.nextNotification()).params.update.content.text).toContain("/name");
  } finally { finish?.(); await client.close(); }
});

test("reports current context, preserves zero, and omits unknown usage without interrupting prompts", async () => {
  let tokens: number | null = 0;
  let listener: Parameters<AgentSession["subscribe"]>[0] | undefined;
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    abort: async () => {}, dispose() {},
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    getContextUsage: () => ({ tokens, contextWindow: 4096, percent: tokens == null ? null : tokens / 40.96 }),
    async prompt(text) {
      listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } } as Parameters<NonNullable<typeof listener>>[0]);
      if (text === "failure") throw new Error("provider failure");
    },
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    expect((await client.nextNotification()).params.update).toEqual({ sessionUpdate: "usage_update", used: 0, size: 4096 });
    for (const [text, used] of [["unknown", null], ["known", 123], ["failure", 456]] as const) {
      tokens = used;
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }))
        .toHaveProperty(text === "failure" ? "error" : "result");
      // An unknown estimate must not leave a fabricated zero before the next turn's text.
      expect((await client.nextNotification()).params.update.content.text).toBe(text);
      if (used !== null) expect((await client.nextNotification()).params.update)
        .toEqual({ sessionUpdate: "usage_update", used, size: 4096 });
    }
  } finally { await client.close(); }
});
