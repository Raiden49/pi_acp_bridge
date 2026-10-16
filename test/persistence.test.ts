import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import type { ServerOptions } from "../src/server.js";

test("indexes Pi JSONL sessions and replays history to a second client after restart", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/persistence-"));
  const agentDir = resolve(cwd, "agent");
  const sessionIndexPath = resolve(agentDir, "acp-sessions.json");
  await mkdir(agentDir);
  const runtime = await ModelRuntime.create({ modelsPath: resolve(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
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
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    await resourceLoader.reload();
    return (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader,
      sessionManager: manager, noTools: "all",
    })).session;
  } };
  let client = protocolHarness(resolve(agentDir, "models.json"), options);
  try {
    const { sessionId, configOptions } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    const index = JSON.parse(await readFile(sessionIndexPath, "utf8"));
    expect(index[sessionId]).toMatchObject({ cwd });
    expect(await readFile(index[sessionId].sessionFile, "utf8")).toContain("Remember this");
    await client.close();
    client = protocolHarness(resolve(agentDir, "models.json"), options);
    expect(await client.request("session/load", { sessionId, cwd: resolve(cwd, "other"), mcpServers: [] }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/load", { sessionId, cwd, mcpServers: [] }))
      .toMatchObject({ result: { configOptions } });
    expect((await client.nextNotification()).params).toEqual({ sessionId, update: {
      sessionUpdate: "user_message_chunk", content: { type: "text", text: "Remember this" },
    } });
    const history = [];
    for (;;) {
      const { update } = (await client.nextNotification()).params;
      if (update.sessionUpdate === "available_commands_update") break;
      history.push(update);
    }
    expect(history.filter((update) => update.sessionUpdate === "agent_message_chunk")
      .every((update) => update.content.type === "text")).toBe(true);
    expect(history).toEqual(expect.arrayContaining([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[robot](file://${cwd}/robot.png)` } },
      expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "read-image" }),
      expect.objectContaining({ sessionUpdate: "agent_message_chunk", content: {
        type: "text", text: expect.stringContaining("[打开图片](file:///"),
      } }),
    ]));
    expect(await client.request("session/load", { sessionId, cwd, mcpServers: [] }))
      .toMatchObject({ error: { code: -32600 } });
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
