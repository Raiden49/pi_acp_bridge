import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { createBareSession, createTestRuntime, assistantStream } from "./fixtures.js";


test("real Pi sessions isolate context, history and relative read paths over ACP", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/isolation-"));
  const agentDir = resolve(root, "agent");
  await mkdir(agentDir);
  const workspaces = await Promise.all(["alpha", "beta"].map(async (name) => {
    const cwd = resolve(root, name);
    await mkdir(cwd);
    await writeFile(resolve(cwd, "AGENTS.md"), `Workspace instruction: ${name}`);
    await writeFile(resolve(cwd, "marker.txt"), `File contents: ${name}`);
    return cwd;
  }));
  const runtime = await createTestRuntime(resolve(agentDir, "models.json"));
  const model = runtime.getModels()[0]!;
  await runtime.setRuntimeApiKey(model.provider, "test-only-key");
  const client = protocolHarness(resolve(agentDir, "models.json"), {
    async createSession(cwd) {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const session = await createBareSession({
        cwd, agentDir, model, modelRuntime: runtime, settingsManager,
        sessionManager: SessionManager.inMemory(cwd), tools: ["read"],
      });
      session.agent.streamFunction = (_model, context) => {
        const last = context.messages.at(-1)!;
        const toolTurn = last.role !== "toolResult";
        const text = JSON.stringify(context.messages);
        return assistantStream(model, toolTurn ? [{ type: "toolCall", id: "read-marker", name: "read", arguments: { path: "marker.txt" } }] : [{ type: "text", text }]);
      };
      return session;
    },
  });
  try {
    const ids = await Promise.all(workspaces.map(async (cwd) =>
      (await client.request("session/new", { cwd, mcpServers: [] })).result.sessionId as string));
    const initial = await Promise.all(Array.from({ length: ids.length * 2 }, () => client.nextNotification()));
    for (const sessionId of ids) expect(initial.filter((message) => message.params.sessionId === sessionId)
      .map((message) => message.params.update.sessionUpdate)).toEqual(["usage_update", "available_commands_update"]);
    const prompts = ids.map((sessionId, i) => client.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: `Private prompt: ${i === 0 ? "alpha" : "beta"}` }],
    }));
    expect(await Promise.all(prompts)).toEqual(ids.map(() => expect.objectContaining({ result: { stopReason: "end_turn" } })));
    const chunks = [];
    // Configuration/usage updates may interleave across concurrent sessions.
    // Assert isolation on the assistant output rather than a fixed queue length.
    while (chunks.length < ids.length) {
      const message = await client.nextNotification();
      if (message.params.update.sessionUpdate === "agent_message_chunk") chunks.push(message);
    }
    for (const chunk of chunks) {
      const i = ids.indexOf(chunk.params.sessionId);
      const own = i === 0 ? "alpha" : "beta";
      const other = i === 0 ? "beta" : "alpha";
      const text = chunk.params.update.content.text as string;
      expect(text).toContain(`Workspace instruction: ${own}`);
      expect(text).toContain(`File contents: ${own}`);
      expect(text).toContain(`Private prompt: ${own}`);
      expect(text).not.toContain(`Workspace instruction: ${other}`);
      expect(text).not.toContain(`File contents: ${other}`);
      expect(text).not.toContain(`Private prompt: ${other}`);
    }
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
