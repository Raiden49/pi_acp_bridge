import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyInitialModelScope, refreshSessionModels, sessionConfiguration } from "../src/models.js";
import { createBareSession, createTestRuntime } from "./fixtures.js";

test("CLI scope priority, saved default and local model refresh stay aligned", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/model-sync-"));
  const path = resolve(cwd, "models.json");
  const configure = (ids: string[]) => writeFile(path, JSON.stringify({ providers: {
    fixture: { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "fixture-key",
      models: ids.map(id => ({ id, reasoning: true })) },
  } }));
  await configure(["one", "two"]);
  const runtime = await createTestRuntime(path);
  await runtime.setRuntimeApiKey("fixture", "fixture-key");
  const settings = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "one", enabledModels: ["fixture/two:high"] });
  const session = await createBareSession({ cwd, agentDir: cwd, modelRuntime: runtime, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
  try {
    await applyInitialModelScope(session);
    expect([session.model?.id, session.thinkingLevel]).toEqual(["two", "high"]);
    settings.applyOverrides({ enabledModels: ["fixture/one:low", "fixture/two:high"], defaultModel: "two" });
    await applyInitialModelScope(session);
    expect([session.model?.id, session.thinkingLevel]).toEqual(["two", "high"]);
    await configure(["one", "two", "three"]);
    settings.applyOverrides({ enabledModels: [] });
    await refreshSessionModels(session);
    expect((await sessionConfiguration(session)).configOptions[0]).toMatchObject({
      currentValue: "fixture/two", options: expect.arrayContaining([expect.objectContaining({ value: "fixture/three" })]),
    });
    expect(session.thinkingLevel).toBe("high");
  } finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
