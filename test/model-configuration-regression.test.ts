import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

test("model-dependent Thinking options replace the previous list without persisting IDE choices", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/model-options-"));
  const modelsPath = resolve(root, "models.json");
  const settingsPath = resolve(root, "settings.json");
  const original = JSON.stringify({ defaultProvider: "fixture", defaultModel: "six", enabledModels: ["fixture/*"], defaultTools: ["read"] });
  await writeFile(settingsPath, original);
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "fixture-only",
    models: [
      { id: "six", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } },
      { id: "three", reasoning: true, thinkingLevelMap: {
        off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
      } },
    ],
  } } }));
  const runtime = await createTestRuntime(modelsPath);
  await runtime.setRuntimeApiKey("fixture", "fixture-only");
  let scopeAtStart: string[] | undefined;
  let toolsAtStart: string[] | undefined;
  let releaseStartup!: () => void;
  let startedStartup!: () => void;
  const startup = new Promise<void>(resolve => { releaseStartup = resolve; });
  const starting = new Promise<void>(resolve => { startedStartup = resolve; });
  const client = protocolHarness(modelsPath, { sessionIndexPath: resolve(root, "index.json"), async createSession() {
    const settingsManager = SettingsManager.create(root, root);
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [pi => { pi.on("session_start", async event => {
        if (event.reason === "reload") {
          scopeAtStart = settingsManager.getEnabledModels();
          toolsAtStart = pi.getActiveTools();
          startedStartup();
          await startup;
        }
      }); }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader,
      modelRuntime: runtime, model: runtime.getModel("fixture", "six"), sessionManager: SessionManager.inMemory(root) });
    session.agent.streamFunction = () => { throw new Error("No provider calls allowed"); };
    return session;
  } });
  try {
    const opened = (await client.request("session/new", { cwd: root, mcpServers: [] })).result;
    const values = (options: any[]) => options.find(option => option.id === "thinking").options.map((option: any) => option.value);
    expect(values(opened.configOptions)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    const changed = await client.request("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: "fixture/three" });
    expect(values(changed.result.configOptions)).toEqual(["low", "high", "max"]);
    for (const level of ["high", "max"]) await client.request("session/set_config_option", {
      sessionId: opened.sessionId, configId: "thinking", value: level,
    });
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    const updated = JSON.stringify({ defaultProvider: "fixture", defaultModel: "six", enabledModels: ["fixture/three"], defaultTools: ["read", "write"] });
    await writeFile(settingsPath, updated);
    const reloading = client.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "/reload" }] });
    await starting;
    // New selectors precede a slow extension/MCP startup, using Pi's own settings reload.
    expect(scopeAtStart).toEqual(["fixture/three"]);
    expect(toolsAtStart).toContain("write");
    for (;;) {
      const update = (await client.nextNotification()).params.update;
      if (update.sessionUpdate === "config_option_update" && update.configOptions[0].options.length === 1) {
        expect(update.configOptions[0].options[0].value).toBe("fixture/three");
        break;
      }
    }
    releaseStartup();
    expect(await reloading).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(await readFile(settingsPath, "utf8")).toBe(updated);
  } finally { releaseStartup(); await client.close(); await rm(root, { recursive: true, force: true }); }
});
