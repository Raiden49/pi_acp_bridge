import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadToolDefinition, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { assistantStream, createBareSession, createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

test.each(["normal", "cancel", "settle"])("steering uses the real SDK input pipeline (%s)", async (scenario) => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/steering-"));
  const runtime = await createTestRuntime(resolve(root, "models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "fixture-key");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let releaseInput!: () => void;
  const inputGate = new Promise<void>(resolve => { releaseInput = resolve; });
  let inputStarted!: () => void;
  const inputEntered = new Promise<void>(resolve => { inputStarted = resolve; });
  let calls = 0;
  const modelInputs: string[] = [];
  let nativeSession: Awaited<ReturnType<typeof createBareSession>>;
  let secondCall!: () => void;
  const secondModelCall = new Promise<void>(resolve => { secondCall = resolve; });
  const client = protocolHarness(resolve(root, "models.json"), { sessionIndexPath: resolve(root, "index.json"), async createSession(cwd, _file, _servers, _id, _fs, approval) {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [pi => {
        pi.registerTool(createReadToolDefinition(cwd, { operations: { access: () => gate, readFile: async () => Buffer.from("read completed") } }));
        pi.on("input", async event => { if (event.text === "late direction") { inputStarted(); await inputGate; } });
      }, ...(approval?.extensions() ?? [])],
    });
    const session = await createBareSession({ cwd, agentDir: root, modelRuntime: runtime, model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd), tools: ["read"] });
    nativeSession = session;
    session.agent.streamFunction = (_model, context) => {
      if (calls === 1) secondCall();
      modelInputs.push(JSON.stringify(context.messages.filter(message => message.role === "user")));
      return assistantStream(model, ++calls === 1
        ? [{ type: "toolCall", id: "paused-read", name: "read", arguments: { path: "fixture.txt" } }]
        : [{ type: "text", text: JSON.stringify(context.messages) }]);
    };
    return session;
  } });
  try {
    const initialized = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(initialized.result._meta.steering).toEqual({ supported: true });
    const { sessionId } = (await client.request("session/new", { cwd: root, mcpServers: [] })).result;
    const first = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "original" }] });
    while ((await client.nextNotification()).params.update.sessionUpdate !== "tool_call") {}
    if (scenario !== "normal") {
      const steering = client.request("_session/steering", { sessionId, prompt: [{ type: "text", text: "late direction" }] });
      await inputEntered;
      if (scenario === "settle") {
        release(); await secondModelCall;
        await nativeSession!.waitForIdle();
        releaseInput();
        expect(await steering).toMatchObject({ result: { outcome: "injected" } });
        expect(await first).toMatchObject({ result: { stopReason: "end_turn" } });
        expect(modelInputs.at(-1)).toContain("late direction");
        return;
      }
      client.notify("session/cancel", { sessionId });
      // Wait for cancellation to be processed before releasing the extension.
      expect(await client.request("_session/steering", { sessionId, prompt: [{ type: "text", text: "after cancel" }] })).toHaveProperty("error");
      releaseInput(); release();
      expect(await steering).toMatchObject({ error: { code: -32600 } });
      expect(await first).toMatchObject({ result: { stopReason: "cancelled" } });
      expect(modelInputs.join("\n")).not.toContain("late direction");
      return;
    }
    expect(await client.request("_session/steering", { sessionId, prompt: [{ type: "text", text: "new direction" }] }))
      .toMatchObject({ result: { outcome: "injected" } });
    release();
    expect(await first).toMatchObject({ result: { stopReason: "end_turn" } });
    let text = "";
    while (!text) { const update = (await client.nextNotification()).params.update; if (update.sessionUpdate === "agent_message_chunk") text = update.content.text; }
    expect(text).toContain("new direction");
    expect(await client.request("_session/steering", { sessionId, prompt: [{ type: "resource_link", name: "not-read-yet.png", uri: "file:///absent-steering-input.png", mimeType: "image/png" }], _meta: { steering: { idleBehavior: "promptRequired" } } }))
      .toMatchObject({ result: { outcome: "promptRequired", reason: "noRunningTurn" } });
    expect(await client.request("_session/steering", { sessionId, prompt: [{ type: "text", text: "legacy idle input" }] }))
      .toMatchObject({ result: { outcome: "startedNewTurn" } });
    // Closing waits for the detached prompt lifecycle rather than leaking it.
    await client.request("session/close", { sessionId });
  } finally { releaseInput(); release(); await client.close(); await rm(root, { recursive: true, force: true }); }
});
