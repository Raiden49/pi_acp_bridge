import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { replayHistory } from "../src/history.js";
import { protocolHarness } from "./protocol-harness.js";
import { createBareSession, createTestRuntime } from "./fixtures.js";

test("displayed extension messages agree in live output and SDK history; hidden messages stay hidden", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/custom-messages-"));
  const runtime = await createTestRuntime(resolve(cwd, "models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "fixture-key");
  const session = await createBareSession({ cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(),
    modelRuntime: runtime, model, sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
  session.prompt = async () => {
    await session.sendCustomMessage({ customType: "fixture", content: "Visible extension result", display: true });
    await session.sendCustomMessage({ customType: "fixture", content: "Hidden extension context", display: false });
  };
  const client = protocolHarness(resolve(cwd, "models.json"), { createSession: async () => session });
  try {
    const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    while ((await client.nextNotification()).params.update.sessionUpdate !== "available_commands_update") {}
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/fixture" }] });
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/name" }] });
    const nextText = async () => {
      for (;;) { const update = (await client.nextNotification()).params.update; if (update.sessionUpdate === "agent_message_chunk") return update; }
    };
    const visible = await nextText();
    expect(visible).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "Visible extension result" } });
    expect((await nextText()).content.text).toContain("/name");
    expect([...replayHistory(session)]).toEqual([visible]);
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
