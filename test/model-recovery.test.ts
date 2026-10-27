import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createWorkspaceSession } from "../src/sessions.js";
import { assistantStream, createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

test.each([true, false])("an unavailable or absent selection still offers working models: selected=%s", async (selected) => {
  const replacement = { provider: "fixture", id: "replacement", name: "Replacement" } as NonNullable<AgentSession["model"]>;
  const session = {
    model: selected ? { ...replacement, id: "removed" } : undefined,
    modelRuntime: { getAvailableSnapshot: () => [replacement] } as unknown as AgentSession["modelRuntime"],
    async setModel(model: typeof replacement) { this.model = model; },
    prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose() {},
  };
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => session });
  try {
    const opened = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    const modelOption = opened.configOptions.find((option: { id: string }) => option.id === "model");
    expect(modelOption?.options).toContainEqual({ value: "fixture/replacement", name: "Replacement (fixture)" });
    const response = await client.request("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: "fixture/replacement" });
    expect(response.result.configOptions[0].currentValue).toBe("fixture/replacement");
  } finally { await client.close(); }
});

test.each([true, false])("history restoration scopes SDK fallbacks but preserves valid selections: missing=%s", async (missing) => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/model-recovery-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("PI_OFFLINE", "1");
  let session: Awaited<ReturnType<typeof createWorkspaceSession>> | undefined;
  try {
    const settings = JSON.stringify({ defaultProvider: "fixture", defaultModel: "outside", enabledModels: ["fixture/preferred:high"],
      extensions: [], skills: [], promptTemplates: [] });
    await writeFile(resolve(root, "settings.json"), settings);
    const modelsPath = resolve(root, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "https://example.invalid",
      apiKey: "fixture-only", models: [{ id: "outside", reasoning: true }, { id: "preferred", reasoning: true }] } } }));
    const runtime = await createTestRuntime(modelsPath);
    const manager = SessionManager.create(root, resolve(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Previous conversation", timestamp: 1 });
    manager.appendMessage(await (await assistantStream(runtime.getModel("fixture", "outside")!, [{ type: "text", text: "Earlier reply" }])).result());
    manager.appendModelChange(missing ? "missing-provider" : "fixture", missing ? "removed-model" : "outside");
    session = await createWorkspaceSession(root, manager.getSessionFile());
    expect([session.model?.provider, session.model?.id, session.thinkingLevel])
      .toEqual(["fixture", missing ? "preferred" : "outside", missing ? "high" : "medium"]);
    expect(await readFile(resolve(root, "settings.json"), "utf8")).toBe(settings);
  } finally { session?.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
