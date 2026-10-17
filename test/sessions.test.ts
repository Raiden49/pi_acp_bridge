import { expect, test, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

test("routes concurrent workspace sessions, streams before completion, and releases listeners", async () => {
  const sessions: Array<ReturnType<typeof fakeSession>> = [];
  const client = protocolHarness(".scratch/absent-models.json", {
    async createSession(cwd) {
      const session = fakeSession(cwd);
      sessions.push(session);
      return session;
    },
  });
  try {
    const [a, b] = await Promise.all(["/workspace/a", "/workspace/b"].map(async (cwd) =>
      (await client.request("session/new", { cwd, mcpServers: [] })).result.sessionId as string));
    expect(a).not.toBe(b);
    const pa = client.request("session/prompt", { sessionId: a, prompt: [{ type: "text", text: "A" }] });
    expect((await client.nextNotification()).params).toEqual({
      sessionId: a, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "/workspace/a:A" } },
    });
    const pb = client.request("session/prompt", { sessionId: b, prompt: [{ type: "text", text: "B" }] });
    expect((await client.nextNotification()).params.sessionId).toBe(b);
    expect(await client.request("session/set_config_option", { sessionId: a, configId: "model", value: "anthropic/other" }))
      .toMatchObject({ error: { code: -32600 } });
    expect(await client.request("session/prompt", { sessionId: a, prompt: [{ type: "text", text: "overlap" }] }))
      .toMatchObject({ error: { code: -32600 } });
    sessions[0]!.finish();
    expect(await pa).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(sessions[0]!.listeners.size).toBe(0);
    await client.request("session/close", { sessionId: b });
    expect(await pb).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(sessions[1]!.dispose).toHaveBeenCalledOnce();
    expect(sessions[1]!.listeners.size).toBe(0);
    expect(await client.request("session/prompt", { sessionId: b, prompt: [] }))
      .toMatchObject({ error: { code: -32602 } });
  } finally {
    await client.close();
  }
  expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
});

test("streams thinking separately from assistant text in emission order", async () => {
  const session = fakeSession("/workspace/a");
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => session });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace/a", mcpServers: [] })).result;
    const prompt = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    await client.nextNotification();
    session.emit("thinking_delta", "Consider ");
    session.emit("thinking_delta", "the question.");
    session.emit("text_delta", "The answer.");
    session.finish();
    expect(await prompt).toMatchObject({ result: { stopReason: "end_turn" } });
    const updates = await Promise.all(Array.from({ length: 3 }, () => client.nextNotification()));
    expect(updates.map((message) => message.params)).toEqual([
      { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Consider " } } },
      { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the question." } } },
      { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The answer." } } },
    ]);
  } finally { await client.close(); }
});

test.each([false, true])("cancel preserves chunks and allows retry when Pi rejects on abort: %s", async (rejectOnAbort) => {
  const session = fakeSession("/workspace/a");
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => session });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace/a", mcpServers: [] })).result;
    const prompt = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    expect((await client.nextNotification()).params.update.content.text).toBe("/workspace/a:hello");
    session.emit("thinking_delta", "Partial reasoning");
    expect((await client.nextNotification()).params.update).toEqual({
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Partial reasoning" },
    });
    session.abort.mockImplementationOnce(async () => {
      session.emit("thinking_delta", "Late thought");
      session.emit("text_delta", "Late answer");
      session.finish(rejectOnAbort ? new Error("Provider aborted") : undefined);
    });
    client.notify("session/cancel", { sessionId });
    expect(await prompt).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(session.listeners.size).toBe(0);
    const retry = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "retry" }] });
    expect((await client.nextNotification()).params.update).toEqual({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "/workspace/a:retry" },
    });
    session.finish();
    expect(await retry).toMatchObject({ result: { stopReason: "end_turn" } });
  } finally { await client.close(); }
});

test("prompt errors remove subscriptions, redact details, and allow retry", async () => {
  const session = fakeSession("/workspace/a");
  const prompt = vi.spyOn(session, "prompt").mockRejectedValueOnce(new Error("secret-provider-detail"));
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => session });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace/a", mcpServers: [] })).result;
    const response = await client.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    });
    expect(response).toMatchObject({ error: { code: -32603 } });
    expect(JSON.stringify(response)).not.toContain("secret-provider-detail");
    expect(prompt).toHaveBeenCalledWith("first\nsecond");
    expect(session.listeners.size).toBe(0);
    const retry = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "retry" }] });
    await client.nextNotification();
    session.finish();
    expect(await retry).toMatchObject({ result: { stopReason: "end_turn" } });
  } finally { await client.close(); }
});

test("disconnect during a prompt disposes the session and detaches listeners", async () => {
  const session = fakeSession("/workspace/a");
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => session });
  const { sessionId } = (await client.request("session/new", { cwd: "/workspace/a", mcpServers: [] })).result;
  void client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
  await client.nextNotification();
  await client.close();
  expect(session.listeners.size).toBe(0);
  expect(session.dispose).toHaveBeenCalledOnce();
});

test("rejects unsupported inputs before invoking Pi", async () => {
  const session = fakeSession("/workspace/a");
  const createSession = vi.fn(async () => session);
  const client = protocolHarness(".scratch/absent-models.json", { createSession });
  try {
    expect(await client.request("session/new", { cwd: "relative", mcpServers: [] }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/new", { cwd: "/workspace/a", mcpServers: [
      { type: "sse", name: "legacy", url: "https://example.invalid/sse", headers: [] },
    ] })).toMatchObject({ error: { code: -32602 } });
    expect(createSession).not.toHaveBeenCalled();
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace/a", mcpServers: [] })).result;
    expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "image", mimeType: "image/png", data: "not base64!" }] }))
      .toMatchObject({ error: { code: -32602 } });
    expect(session.listeners.size).toBe(0);
  } finally { await client.close(); }
});

test.each(["close", "disconnect", "shutdown", "close-shutdown", "failure", "retry"] as const)("waits for a model switch before disposing: %s", async (mode) => {
  const session = fakeSession("/workspace/a");
  const model = { provider: "fixture", id: "model", name: "Fixture" } as NonNullable<AgentSession["model"]>;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  let failNext = mode === "failure" || mode === "retry";
  session.dispose.mockImplementation(() => { order.push("dispose"); });
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    ...session, model,
    modelRuntime: { getAvailableSnapshot: () => [model] } as unknown as AgentSession["modelRuntime"],
    async setModel() {
      entered();
      await gate;
      order.push("switch");
      if (failNext) { failNext = false; throw new Error("Auth failed"); }
    },
  }) });
  let closing: Promise<unknown> | undefined;
  let stopping: Promise<unknown> | undefined;
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace/a", mcpServers: [] })).result;
    const switching = client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/model" });
    await started;
    if (mode === "retry") {
      release();
      expect(await switching).toHaveProperty("error");
      expect(await client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/model" }))
        .toHaveProperty("result");
      return;
    }
    closing = mode === "disconnect" ? client.close() : mode === "shutdown" ? client.shutdown()
      : client.request("session/close", { sessionId });
    await new Promise((resolve) => setImmediate(resolve));
    if (mode !== "disconnect") {
      expect(await client.request("session/prompt", { sessionId, prompt: [] })).toMatchObject({ error: { code: -32602 } });
    }
    expect(order).toEqual([]);
    if (mode === "close-shutdown") {
      let shutdownFinished = false;
      stopping = client.shutdown().then(() => { shutdownFinished = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutdownFinished).toBe(false);
    }
    release();
    await closing;
    if (mode !== "disconnect") expect(await switching).toHaveProperty(mode === "failure" ? "error" : "result");
    expect(order).toEqual(["switch", "dispose"]);
  } finally {
    release();
    await closing;
    await stopping;
    await client.close();
  }
});

function fakeSession(cwd: string) {
  const listeners = new Set<Parameters<AgentSession["subscribe"]>[0]>();
  let finish = (_error?: Error) => {};
  return {
    listeners,
    finish: (error?: Error) => finish(error),
    emit(type: "text_delta" | "thinking_delta", delta: string) {
      const event = { type: "message_update", assistantMessageEvent: { type, delta } };
      for (const listener of listeners) listener(event as Parameters<typeof listener>[0]);
    },
    subscribe(listener: Parameters<AgentSession["subscribe"]>[0]) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async prompt(text: string) {
      const done = new Promise<void>((resolve, reject) => {
        finish = (error) => error ? reject(error) : resolve();
      });
      // Only the event envelope used by the bridge is needed at this boundary.
      const event = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${cwd}:${text}` } };
      for (const listener of listeners) listener(event as Parameters<typeof listener>[0]);
      await done;
    },
    abort: vi.fn(async () => finish()),
    dispose: vi.fn(() => finish()),
  };
}
