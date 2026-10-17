import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sessionConfiguration } from "../src/models.js";
import { protocolHarness } from "./protocol-harness.js";
import { createBareSession, createTestRuntime } from "./fixtures.js";

test("scoped model choices follow Pi settings, retain the current model and refresh without widening invalid scopes", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/scoped-models-"));
  const modelsPath = resolve(cwd, "models.json");
  const settingsPath = resolve(cwd, "settings.json");
  await writeFile(modelsPath, JSON.stringify({ providers: {
    "scope-test": { baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "test-only",
      models: ["one", "two", "three"].map((id) => ({ id, reasoning: true })) },
    "scope-unconfigured": { baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "hidden" }] },
  } }));
  const configure = (enabledModels: string[]) => writeFile(settingsPath, JSON.stringify({ enabledModels }));
  await configure(["scope-test/two:high"]);
  const runtime = await createTestRuntime(modelsPath);
  await runtime.setRuntimeApiKey("scope-test", "test-only");
  const client = protocolHarness(modelsPath, { async createSession() {
    const settingsManager = SettingsManager.create(cwd, cwd);
    const session = await createBareSession({ cwd, agentDir: cwd, settingsManager,
      modelRuntime: runtime, model: runtime.getModels("scope-test").find((model) => model.id === "one"),
      sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
    const authRefresh = vi.spyOn(runtime, "getAvailable").mockRejectedValue(new Error("Snapshot matching must not refresh auth"));
    try { await sessionConfiguration(session); expect(authRefresh).not.toHaveBeenCalled(); }
    finally { authRefresh.mockRestore(); }
    return session;
  } });
  const choices = (options: any[]) => options.find((option) => option.id === "model").options.map((option: any) => option.value);
  const nextConfiguration = async () => {
    const text: string[] = [];
    for (;;) {
      const { update } = (await client.nextNotification()).params;
      if (update.sessionUpdate === "config_option_update") {
        expect((await client.nextNotification()).params.update.sessionUpdate).toBe("usage_update");
        return { options: update.configOptions, text: text.join("") };
      }
      if (update.sessionUpdate === "agent_message_chunk") text.push(update.content.text);
    }
  };
  try {
    const a = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    expect((await client.nextNotification()).params.update.sessionUpdate).toBe("usage_update");
    await client.nextNotification();
    expect(choices(a.configOptions)).toEqual(["scope-test/two", "scope-test/one"]);
    expect(a.configOptions.find((option: any) => option.id === "thinking").currentValue).toBe("medium");
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: "scope-test/three" }))
      .toMatchObject({ error: { code: -32602 } });
    await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: "scope-test/two" });
    expect(choices((await nextConfiguration()).options)).toEqual(["scope-test/two"]);
    const reload = async (patterns: string[]) => {
      await configure(patterns);
      expect(await client.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "/reload" }] }))
        .toMatchObject({ result: { stopReason: "end_turn" } });
      return nextConfiguration();
    };
    expect(choices((await reload(["scope-test/t*", "scope-test/two:high"])).options)).toEqual(["scope-test/two", "scope-test/three"]);
    const unmatched = await reload(["scope-unconfigured/*", "missing/*"]);
    expect(choices(unmatched.options)).toEqual(["scope-test/two"]);
    expect(unmatched.text).toContain("enabledModels 未匹配任何可用模型");
    await client.request("session/set_mode", { sessionId: a.sessionId, modeId: "medium" });
    expect((await nextConfiguration()).text).toBe("");
    const b = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    expect(choices(b.configOptions)).toEqual(["scope-test/one"]);
    expect((await client.nextNotification()).params.update.content.text).toContain("enabledModels 未匹配");
    expect((await client.nextNotification()).params.update.sessionUpdate).toBe("usage_update");
    await client.nextNotification();
    expect(choices((await reload([])).options)).toEqual(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
