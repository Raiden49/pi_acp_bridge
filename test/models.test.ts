import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

test("native model selector switches the model used by the next prompt without changing other sessions", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/models-"));
  const runtime = await ModelRuntime.create({
    modelsPath: resolve(cwd, "models.json"), refreshOnCreate: false, allowModelNetwork: false,
    credentials: {
      async read() { return undefined; }, async list() { return []; },
      async modify() { throw new Error("Read only"); }, async delete() { throw new Error("Read only"); },
    },
  });
  const models = runtime.getModels("anthropic").slice(0, 2);
  const ids = models.map((model) => `${model.provider}/${model.id}`);
  await runtime.setRuntimeApiKey("anthropic", "test-only-key");
  const client = protocolHarness(resolve(cwd, "models.json"), { async createSession() {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: cwd, model: models[0], modelRuntime: runtime,
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: "all",
    });
    type Stream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
    session.agent.streamFunction = (model) => {
      const text = `${model.provider}/${model.id}`;
      const message: Awaited<ReturnType<Stream["result"]>> = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text }], stopReason: "stop", timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      return { async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message };
        yield { type: "text_delta", contentIndex: 0, delta: text, partial: message };
        yield { type: "done", reason: "stop", message };
      }, async result() { return message; } } as unknown as Stream;
    };
    return session;
  } });
  try {
    const a = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    await client.nextNotification();
    expect(a.configOptions).toContainEqual(expect.objectContaining({
      id: "model", category: "model", type: "select", currentValue: ids[0],
      options: expect.arrayContaining([expect.objectContaining({ value: ids[1] })]),
    }));
    const b = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    await client.nextNotification();
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: ids[1] }))
      .toMatchObject({ result: { configOptions: [expect.objectContaining({ currentValue: ids[1] })] } });
    for (const [sessionId, expected] of [[a.sessionId, ids[1]], [b.sessionId, ids[0]]]) {
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "identify model" }] }))
        .toMatchObject({ result: { stopReason: "end_turn" } });
      expect((await client.nextNotification()).params.update.content.text).toBe(expected);
    }
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: "missing/model" }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/set_config_option", { sessionId: a.sessionId, configId: "unknown", value: ids[0] }))
      .toMatchObject({ error: { code: -32602 } });
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
