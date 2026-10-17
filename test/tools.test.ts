import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { createBareSession, createTestRuntime, assistantStream } from "./fixtures.js";

type Message = import("@earendil-works/pi-ai").AssistantMessage;

async function toolRun(calls: Array<Pick<Extract<Message["content"][number], { type: "toolCall" }>, "name" | "arguments">>) {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/tools-"));
  const agentDir = resolve(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(resolve(cwd, "existing.txt"), "first\nold\n");
  const runtime = await createTestRuntime(resolve(agentDir, "models.json"));
  const model = runtime.getModels()[0]!;
  await runtime.setRuntimeApiKey(model.provider, "test-only-key");
  const client = protocolHarness(resolve(agentDir, "models.json"), {
    async createSession() {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const session = await createBareSession({
        cwd, agentDir, model, modelRuntime: runtime, settingsManager,
        sessionManager: SessionManager.inMemory(cwd), tools: ["read", "edit", "write"],
        customTools: [{
          name: "fixture_tool", label: "Fixture", description: "Return a fixture result",
          parameters: { type: "object", properties: {}, additionalProperties: true } as ToolDefinition["parameters"],
          async execute() { return { content: [{ type: "text", text: "Fixture result" }], details: {} }; },
        }],
      });
      let turn = 0;
      session.agent.streamFunction = () => {
        const call = calls[turn++];
        return assistantStream(model, call ? [{ type: "toolCall", id: `call-${turn}`, ...call }] : [{ type: "text", text: "done" }]);
      };
      return session;
    },
  });
  try {
    const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    expect((await client.nextNotification()).params.update.sessionUpdate).toBe("usage_update");
    expect((await client.nextNotification()).params.update.sessionUpdate).toBe("available_commands_update");
    expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }))
      .toMatchObject({ result: { stopReason: "end_turn" } });
    const updates = [];
    for (;;) {
      const { update } = (await client.nextNotification()).params;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.text === "done") break;
      updates.push(update);
    }
    return { cwd, updates };
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("custom tools preserve input without synthesizing assistant messages", async () => {
  const { updates } = await toolRun([{ name: "fixture_tool", arguments: { message: "Fixture input" } }]);
  expect(updates.some((update) => update.sessionUpdate === "agent_message_chunk")).toBe(false);
  expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call", title: "fixture_tool", rawInput: { message: "Fixture input" } });
});

test("edit and write diffs use actual before/after contents, including new files and failed edits", async () => {
  const { cwd, updates } = await toolRun([
    { name: "edit", arguments: { path: "existing.txt", edits: [{ oldText: "old", newText: "new" }] } },
    { name: "write", arguments: { path: "existing.txt", content: "replacement\n" } },
    { name: "write", arguments: { path: "created.txt", content: "created\n" } },
    { name: "edit", arguments: { path: "existing.txt", edits: [{ oldText: "absent", newText: "unused" }] } },
  ]);
  const ends = updates.filter((update) => update.sessionUpdate === "tool_call_update");
  expect(ends.map((update) => update.content.filter((block: { type: string }) => block.type === "diff"))).toEqual([
    [{ type: "diff", path: resolve(cwd, "existing.txt"), oldText: "first\nold\n", newText: "first\nnew\n" }],
    [{ type: "diff", path: resolve(cwd, "existing.txt"), oldText: "first\nnew\n", newText: "replacement\n" }],
    [{ type: "diff", path: resolve(cwd, "created.txt"), oldText: null, newText: "created\n" }],
    [],
  ]);
  expect(ends[3].status).toBe("failed");
  expect(ends[0].locations).toMatchObject([{ path: resolve(cwd, "existing.txt"), line: 2 }]);
});

test.each(["./existing.txt", "@existing.txt"])("autonomous read emits lifecycle notifications and navigation coordinates: %s", async (path) => {
  const { cwd, updates } = await toolRun([{ name: "read", arguments: { path, offset: 2 } }]);
  expect(updates).toMatchObject([
    { sessionUpdate: "tool_call", toolCallId: "call-1", kind: "read", status: "in_progress",
      locations: [{ path: resolve(cwd, "existing.txt"), line: 2 }] },
    { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "old\n" } }] },
  ]);
});
