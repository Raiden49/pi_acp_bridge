import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { createBareSession, createTestRuntime } from "./fixtures.js";
import type { ServerOptions } from "../src/server.js";

test("indexes Pi JSONL sessions and replays history to a second client after restart", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/persistence-"));
  const agentDir = resolve(cwd, "agent");
  const sessionIndexPath = resolve(agentDir, "acp-sessions.json");
  await mkdir(agentDir);
  await writeFile(resolve(agentDir, "models.json"), JSON.stringify({ providers: {
    "persistence-fixture": { baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "test-only",
      models: [{ id: "reasoning", reasoning: true }, { id: "excluded", reasoning: false }] },
  } }));
  const runtime = await createTestRuntime(resolve(agentDir, "models.json"));
  await runtime.setRuntimeApiKey("persistence-fixture", "test-only");
  let renameOutsidePrompt: (name: string) => void = () => {};
  const options: Partial<ServerOptions> = { sessionIndexPath, artifactDir: resolve(cwd, "artifacts"), async createSession(cwd, sessionFile) {
    const manager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd, resolve(agentDir, "sessions"));
    if (!sessionFile) {
      manager.appendMessage({ role: "user", content: "Remember this", timestamp: 1 });
      manager.appendMessage({ role: "toolResult", toolCallId: "read-image", toolName: "read", isError: false,
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 2,
      });
      manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "fixture",
        content: [{ type: "text", text: "![robot](./robot.png)" }], stopReason: "stop", timestamp: 3,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
    }
    const settingsManager = SettingsManager.inMemory({ enabledModels: ["persistence-fixture/reasoning"] });
    const session = await createBareSession({ cwd, agentDir, modelRuntime: runtime, settingsManager,
      sessionManager: manager, model: runtime.getModels("persistence-fixture")[0], noTools: "all" });
    renameOutsidePrompt = (name) => session.setSessionName(name);
    return session;
  } };
  let client = protocolHarness(resolve(agentDir, "models.json"), options);
  try {
    const expectUsage = async () => expect((await client.nextNotification()).params.update.sessionUpdate).toBe("usage_update");
    const { sessionId, modes } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    await expectUsage();
    await client.nextNotification();
    expect(await client.request("session/set_mode", { sessionId, modeId: "high" })).toMatchObject({ result: {} });
    expect((await client.nextNotification()).params.update).toMatchObject({ currentModeId: "high" });
    const { configOptions } = (await client.nextNotification()).params.update;
    expect(configOptions[0].options).toEqual([{ value: "persistence-fixture/reasoning", name: "reasoning (persistence-fixture)" }]);
    await expectUsage();
    expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/name 发布测试" }] }))
      .toMatchObject({ result: { stopReason: "end_turn" } });
    expect((await client.nextNotification()).params.update).toMatchObject({ sessionUpdate: "session_info_update", title: "发布测试" });
    await client.nextNotification();
    await expectUsage();
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/name" }] });
    expect((await client.nextNotification()).params.update.content.text).toContain("发布测试");
    await expectUsage();
    renameOutsidePrompt("后台新标题");
    expect((await client.nextNotification()).params.update).toMatchObject({ sessionUpdate: "session_info_update", title: "后台新标题" });
    const index = JSON.parse(await readFile(sessionIndexPath, "utf8"));
    expect(index[sessionId]).toMatchObject({ cwd });
    expect(await readFile(index[sessionId].sessionFile, "utf8")).toContain("Remember this");
    await client.close();
    client = protocolHarness(resolve(agentDir, "models.json"), options);
    expect(await client.request("session/load", { sessionId, cwd: resolve(cwd, "other"), mcpServers: [] }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/load", { sessionId, cwd, mcpServers: [] }))
      .toMatchObject({ result: { configOptions, modes: { ...modes, currentModeId: "high" } } });
    expect((await client.nextNotification()).params).toEqual({ sessionId, update: {
      sessionUpdate: "user_message_chunk", content: { type: "text", text: "Remember this" },
    } });
    const history = [];
    for (;;) {
      const { update } = (await client.nextNotification()).params;
      if (update.sessionUpdate === "available_commands_update") break;
      history.push(update);
    }
    expect(history).toContainEqual(expect.objectContaining({ sessionUpdate: "session_info_update", title: "后台新标题" }));
    expect(history).toContainEqual(expect.objectContaining({ sessionUpdate: "usage_update" }));
    expect(history.filter((update) => update.sessionUpdate === "agent_message_chunk")
      .every((update) => update.content.type === "text")).toBe(true);
    expect(history).toEqual(expect.arrayContaining([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[robot](file://${cwd}/robot.png)` } },
      expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "read-image" }),
      expect.objectContaining({ sessionUpdate: "tool_call_update", content: expect.arrayContaining([
        { type: "content", content: { type: "text", text: expect.stringContaining("[打开图片](file:///") } },
      ]) }),
    ]));
    expect(await client.request("session/load", { sessionId, cwd, mcpServers: [] }))
      .toMatchObject({ error: { code: -32600 } });
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
