import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { createBareSession, createTestRuntime, assistantStream } from "./fixtures.js";

test("native model selector switches the model used by the next prompt without changing other sessions", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/models-"));
  await writeFile(resolve(cwd, "models.json"), JSON.stringify({ providers: {
    "bridge-test": { baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [
      { id: "reasoning", reasoning: true }, { id: "plain", name: "Plain model", reasoning: false },
    ] },
    "unconfigured-bridge-test": { baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "hidden" }] },
  } }));
  const runtime = await createTestRuntime(resolve(cwd, "models.json"));
  const candidates = runtime.getModels("bridge-test");
  const models = [candidates.find((model) => model.reasoning)!, candidates.find((model) => !model.reasoning)!];
  const efforts: unknown[] = [];
  const ids = models.map((model) => `${model.provider}/${model.id}`);
  await runtime.setRuntimeApiKey("bridge-test", "test-only-key");
  const client = protocolHarness(resolve(cwd, "models.json"), { async createSession() {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const session = await createBareSession({ cwd, agentDir: cwd, model: models[0], modelRuntime: runtime,
      settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
    session.agent.streamFunction = (model, _context, options) => {
      efforts.push(options?.reasoning);
      const text = `${model.provider}/${model.id}`;
      return assistantStream(model, [{ type: "text", text }]);
    };
    return session;
  } });
  try {
    const expectUsage = async () => expect((await client.nextNotification()).params.update)
      .toMatchObject({ sessionUpdate: "usage_update", used: expect.any(Number), size: expect.any(Number) });
    const a = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    await expectUsage();
    await client.nextNotification();
    expect(a.configOptions).toContainEqual(expect.objectContaining({
      id: "model", category: "model", type: "select", currentValue: ids[0],
      options: expect.arrayContaining([expect.objectContaining({ value: ids[1], name: "Plain model (bridge-test)" })]),
    }));
    // Air in IDEs rejects the whole preferences snapshot when a model label equals its ID.
    expect(a.configOptions[0].options.every(({ name, value }: { name: string; value: string }) => name.trim() && name !== value)).toBe(true);
    expect(a.configOptions).toContainEqual(expect.objectContaining({ id: "thinking", category: "thought_level" }));
    // Thinking uses the replaceable thought_level options, not a stale legacy modes list.
    expect(a.modes).toBeUndefined();
    const expectConfiguration = async (level: string) => {
      const update = (await client.nextNotification()).params.update;
      expect(update.sessionUpdate).toBe("config_option_update");
      const thinking = update.configOptions.find((option: { id: string }) => option.id === "thinking");
      if (thinking) expect(thinking.currentValue).toBe(level);
      await expectUsage();
      return update.configOptions;
    };
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "thinking", value: "high" }))
      .toMatchObject({ result: { configOptions: expect.arrayContaining([expect.objectContaining({ id: "thinking", currentValue: "high" })]) } });
    await expectConfiguration("high");
    // Air Desktop persists the legacy Thinking selector under configId "mode".
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "mode", value: "high" }))
      .toHaveProperty("result");
    await expectConfiguration("high");
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "mode", value: "invalid" }))
      .toMatchObject({ error: { code: -32602 } });
    await client.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "Think" }] });
    await client.nextNotification();
    await expectUsage();
    expect(efforts.at(-1)).toBe("high");
    expect(await client.request("session/set_mode", { sessionId: a.sessionId, modeId: "low" })).toMatchObject({ result: {} });
    expect(await expectConfiguration("low")).toContainEqual(expect.objectContaining({ id: "thinking", currentValue: "low" }));
    await client.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "Legacy thinking" }] });
    await client.nextNotification();
    await expectUsage();
    expect(efforts.at(-1)).toBe("low");
    expect(await client.request("session/set_mode", { sessionId: a.sessionId, modeId: "invalid" }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "thinking", value: "invalid" }))
      .toMatchObject({ error: { code: -32602 } });
    expect(a.configOptions[0].options).not.toContainEqual(expect.objectContaining({ value: "unconfigured-bridge-test/hidden" }));
    const b = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    await expectUsage();
    await client.nextNotification();
    expect(b.modes).toBeUndefined();
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: ids[1] }))
      .toMatchObject({ result: { configOptions: [expect.objectContaining({ currentValue: ids[1] })] } });
    await expectConfiguration("off");
    expect(await client.request("session/set_mode", { sessionId: a.sessionId, modeId: "high" })).toMatchObject({ error: { code: -32602 } });
    for (const [sessionId, expected] of [[a.sessionId, ids[1]], [b.sessionId, ids[0]]]) {
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "identify model" }] }))
        .toMatchObject({ result: { stopReason: "end_turn" } });
      expect((await client.nextNotification()).params.update.content.text).toBe(expected);
      await expectUsage();
    }
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: "unconfigured-bridge-test/hidden" }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: "missing/model" }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "unknown", value: ids[0] }))
      .toMatchObject({ error: { code: -32602 } });
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
