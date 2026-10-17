import { expect, test } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

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
