import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadToolDefinition, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { assistantStream, createBareSession, createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(holdSelection = false) {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/live-config-"));
  const modelsPath = resolve(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "fixture-only",
    models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }],
  } } }));
  const runtime = await createTestRuntime(modelsPath);
  await runtime.setRuntimeApiKey("fixture", "fixture-only");
  const tool = deferred();
  const selection = deferred();
  const selectionStarted = deferred();
  const requests: Array<{ model: string; reasoning: unknown }> = [];
  let waitForIdle!: () => Promise<void>;
  const client = protocolHarness(modelsPath, { sessionIndexPath: resolve(root, "index.json"), async createSession(cwd) {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [pi => {
        pi.registerTool(createReadToolDefinition(cwd, {
          operations: { access: () => tool.promise, readFile: async () => Buffer.from("fixture") },
        }));
        if (holdSelection) pi.on("model_select", async event => {
          if (event.model.id === "two") { selectionStarted.resolve(); await selection.promise; }
        });
      }],
    });
    const session = await createBareSession({ cwd, agentDir: root, modelRuntime: runtime, model: runtime.getModel("fixture", "one"),
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ["read"] });
    waitForIdle = () => session.waitForIdle();
    session.agent.streamFunction = (model, _context, options) => {
      requests.push({ model: model.id, reasoning: options?.reasoning });
      return assistantStream(model, requests.length === 1
        ? [{ type: "toolCall", id: "paused", name: "read", arguments: { path: "fixture.txt" } }]
        : [{ type: "text", text: "finished" }]);
    };
    return session;
  } });
  const { sessionId } = (await client.request("session/new", { cwd: root, mcpServers: [] })).result;
  return { client, sessionId, tool, selection, selectionStarted, requests, waitForIdle, async cleanup() {
    selection.resolve(); tool.resolve(); await client.close(); await rm(root, { recursive: true, force: true });
  } };
}

test("configuration queued during a prompt is not lost when that prompt starts settling", async () => {
  const f = await fixture(true);
  try {
    const prompt = f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "read" }] });
    while ((await f.client.nextNotification()).params.update.sessionUpdate !== "tool_call") {}
    const model = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "model", value: "fixture/two" });
    await f.selectionStarted.promise;
    const thinking = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "thinking", value: "high" });
    f.tool.resolve();
    await f.waitForIdle();
    await f.client.request("session/list", {});
    f.selection.resolve();
    expect(await model).toHaveProperty("result");
    expect(await thinking).toHaveProperty("result");
    expect(await prompt).toHaveProperty("result");
  } finally { await f.cleanup(); }
});

test("a prompt admitted after a configuration request waits for it instead of failing busy", async () => {
  const f = await fixture(true);
  try {
    const model = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "model", value: "fixture/two" });
    await f.selectionStarted.promise;
    const prompt = f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "read" }] });
    await f.client.request("session/list", {});
    f.selection.resolve(); f.tool.resolve();
    expect(await model).toHaveProperty("result");
    expect(await prompt).toHaveProperty("result");
    expect(f.requests.map(request => request.model)).toEqual(["two", "two"]);
  } finally { await f.cleanup(); }
});

test("cancelling a prompt waiting for configuration cannot start a late model request", async () => {
  const f = await fixture(true);
  try {
    const model = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "model", value: "fixture/two" });
    await f.selectionStarted.promise;
    const prompt = f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "read" }] });
    f.client.notify("session/cancel", { sessionId: f.sessionId });
    await f.client.request("session/list", {});
    f.selection.resolve(); f.tool.resolve();
    expect(await model).toHaveProperty("result");
    expect(await prompt).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(f.requests).toEqual([]);
  } finally { await f.cleanup(); }
});

test("closing a session fences queued configuration writes and drains the in-flight write", async () => {
  const f = await fixture(true);
  try {
    const model = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "model", value: "fixture/two" });
    await f.selectionStarted.promise;
    const thinking = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "thinking", value: "high" });
    const closing = f.client.request("session/close", { sessionId: f.sessionId });
    await f.client.request("session/list", {});
    f.selection.resolve();
    expect(await model).toHaveProperty("result");
    expect(await thinking).toHaveProperty("error");
    expect(await closing).toHaveProperty("result");
  } finally { await f.cleanup(); }
});

test("failed configuration returns an error and republishes actual state before the next successful write", async () => {
  const f = await fixture();
  try {
    const failed = await f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "thinking", value: "unsupported" });
    expect(failed).toHaveProperty("error");
    expect(await f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "thinking", value: "high" })).toHaveProperty("result");
    const levels = [];
    for (;;) {
      const update = (await f.client.nextNotification()).params.update;
      if (update.sessionUpdate !== "config_option_update") continue;
      const level = update.configOptions.find((option: { id: string }) => option.id === "thinking").currentValue;
      levels.push(level);
      if (level === "high") break;
    }
    expect(levels).toEqual(["medium", "high"]);
  } finally { await f.cleanup(); }
});

test("concurrent configuration requests wait for the preceding write and publication, not the prompt", async () => {
  const f = await fixture(true);
  try {
    const model = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "model", value: "fixture/two" });
    await f.selectionStarted.promise;
    const thinking = f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "thinking", value: "high" });
    await f.client.request("session/list", {});
    f.selection.resolve();
    expect(await model).toHaveProperty("result");
    expect((await thinking).result?.configOptions).toContainEqual(expect.objectContaining({ id: "thinking", currentValue: "high" }));
  } finally { await f.cleanup(); }
});

test("live model and Thinking changes reach the next SDK request inside the same ACP prompt", async () => {
  const f = await fixture();
  try {
    const prompt = f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "read" }] });
    while ((await f.client.nextNotification()).params.update.sessionUpdate !== "tool_call") {}
    const model = await f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "model", value: "fixture/two" });
    expect(model).toHaveProperty("result");
    const thinking = await f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "thinking", value: "high" });
    expect(thinking.result.configOptions).toContainEqual(expect.objectContaining({ id: "thinking", currentValue: "high" }));
    f.tool.resolve();
    expect(await prompt).toHaveProperty("result");
    expect(f.requests).toEqual([{ model: "one", reasoning: "medium" }, { model: "two", reasoning: "high" }]);
  } finally { await f.cleanup(); }
});
