import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

test("extension model changes reach the IDE at settlement without republishing unchanged configuration", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/config-sync-"));
  const modelsPath = resolve(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "fixture-key",
    models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }] } } }));
  const runtime = await createTestRuntime(modelsPath);
  await runtime.setRuntimeApiKey("fixture", "fixture-key");
  const client = protocolHarness(modelsPath, { sessionIndexPath: resolve(root, "index.json"), async createSession(cwd) {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [pi => { pi.registerCommand("switch", { handler: async () => {
        await pi.setModel(runtime.getModel("fixture", "two")!);
        pi.setThinkingLevel("high");
      } }); }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: root, modelRuntime: runtime, model: runtime.getModel("fixture", "one"),
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
    session.agent.streamFunction = () => { throw new Error("Unexpected model call"); };
    return session;
  } });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: root, mcpServers: [] })).result;
    while ((await client.nextNotification()).params.update.sessionUpdate !== "available_commands_update") {}
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/switch" }] });
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/name sync-sentinel" }] });
    const updates = [];
    for (;;) {
      const update = (await client.nextNotification()).params.update;
      updates.push(update);
      if (update.content?.text?.includes("会话标题：sync-sentinel")) break;
    }
    expect(updates.filter(update => update.sessionUpdate === "config_option_update")).toMatchObject([{ configOptions: [
      { id: "model", currentValue: "fixture/two" }, { id: "thinking", currentValue: "high" },
    ] }]);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
