import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

type Stream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
type Message = Awaited<ReturnType<Stream["result"]>>;

async function fixture(mode: "manual" | "cancel" | "overflow" | "empty") {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/context-"));
  const runtime = await ModelRuntime.create({ modelsPath: resolve(cwd, "models.json"), refreshOnCreate: false, allowModelNetwork: false,
    credentials: { async read() { return undefined; }, async list() { return []; },
      async modify() { throw new Error("Read only"); }, async delete() { throw new Error("Read only"); } },
  });
  const model = { ...runtime.getModels("anthropic")[0]!, contextWindow: 4096, maxTokens: 512 };
  await runtime.setRuntimeApiKey(model.provider, "test-only");
  const requests: string[] = [];
  const assistant = (text: string): Message => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: 1,
    usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const client = protocolHarness(resolve(cwd, "models.json"), { sessionIndexPath: resolve(cwd, "index.json"), async createSession(cwd, file) {
    const manager = file ? SessionManager.open(file) : SessionManager.create(cwd, resolve(cwd, "sessions"));
    if (!file && mode !== "empty") for (let i = 0; i < 8; i++) {
      manager.appendMessage({ role: "user", content: `Original turn ${i}: ` + "long context ".repeat(1000), timestamp: i });
      manager.appendMessage(assistant(`Original answer ${i}`));
    }
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false },
      compaction: { enabled: mode === "overflow", reserveTokens: 512, keepRecentTokens: 128 } });
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
      sessionManager: manager, modelRuntime: runtime, model, noTools: "all" });
    session.agent.streamFunction = (_model, context, options) => {
      requests.push(JSON.stringify(context));
      const overflow = mode === "overflow" && requests.length === 1;
      const message = assistant(overflow ? "" : "Saved summary: preserve requirements.");
      if (overflow) { message.stopReason = "error"; message.errorMessage = "prompt is too long: 5000 tokens > 4096 maximum"; }
      const wait = mode === "cancel" ? new Promise<void>((done) => {
        const abort = () => { message.stopReason = "aborted"; done(); };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      }) : Promise.resolve();
      return { async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message };
        await wait;
        if (message.stopReason === "stop") {
          yield { type: "text_delta", contentIndex: 0, delta: "Saved summary: preserve requirements.", partial: message };
          yield { type: "done", reason: "stop", message };
        } else yield { type: "error", reason: message.stopReason, error: message };
      }, async result() { await wait; return message; } } as unknown as Stream;
    };
    return session;
  } });
  const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
  await client.nextNotification();
  return { client, cwd, sessionId, requests,
    prompt: (text: string) => client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    async cleanup() { await client.close(); await rm(cwd, { recursive: true, force: true }); },
  };
}

test("manual compaction reports progress, preserves requirements and restores full chat history", async () => {
  const f = await fixture("manual");
  try {
    expect(await f.prompt("/compact retain requirements")).toMatchObject({ result: { stopReason: "end_turn" } });
    const start = (await f.client.nextNotification()).params.update;
    expect(start.content.text).toContain("正在压缩");
    expect((await f.client.nextNotification()).params.update.content.text).toContain("压缩完成");
    expect(f.requests[0]).toContain("retain requirements");
    expect(await f.prompt("Continue")).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(f.requests.at(-1)).toContain("Saved summary: preserve requirements.");
    expect(f.requests.at(-1)).not.toContain("Original turn 0");
    await f.client.nextNotification();
    await f.client.request("session/close", { sessionId: f.sessionId });
    expect(await f.client.request("session/load", { sessionId: f.sessionId, cwd: f.cwd, mcpServers: [] })).toHaveProperty("result");
    const history = [];
    for (;;) {
      const update = (await f.client.nextNotification()).params.update;
      if (update.sessionUpdate === "available_commands_update") break;
      history.push(update);
    }
    expect(history.some((update) => update.sessionUpdate === "user_message_chunk" && update.content.text.includes("Original turn 0"))).toBe(true);
  } finally { await f.cleanup(); }
});

test("cancel interrupts manual compaction and leaves the session usable", async () => {
  const f = await fixture("cancel");
  try {
    const pending = f.prompt("/compact");
    expect((await f.client.nextNotification()).params.update.content.text).toContain("正在压缩");
    expect(await f.prompt("/reload")).toMatchObject({ error: { code: -32600 } });
    f.client.notify("session/cancel", { sessionId: f.sessionId });
    expect(await pending).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(await f.prompt("/session")).toMatchObject({ result: { stopReason: "end_turn" } });
  } finally { await f.cleanup(); }
});

test("an empty session needs no compaction or model request", async () => {
  const f = await fixture("empty");
  try {
    expect(await f.prompt("/compact")).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(f.requests).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test("context overflow compacts and retries within the same ACP turn", async () => {
  const f = await fixture("overflow");
  try {
    expect(await f.prompt("Continue")).toMatchObject({ result: { stopReason: "end_turn" } });
    // Pi summarizes both the older history and the split turn before retrying.
    expect(f.requests).toHaveLength(4);
    expect(f.requests.at(-1)).toContain("Saved summary: preserve requirements.");
    expect((await f.client.nextNotification()).params.update.content.text).toContain("上下文超限");
  } finally { await f.cleanup(); }
});
