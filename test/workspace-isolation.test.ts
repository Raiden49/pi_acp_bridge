import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

type Stream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
type Message = Awaited<ReturnType<Stream["result"]>>;

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
  const runtime = await ModelRuntime.create({
    modelsPath: resolve(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false,
    credentials: {
      async read() { return undefined; }, async list() { return []; },
      async modify() { throw new Error("Read only"); }, async delete() { throw new Error("Read only"); },
    },
  });
  const model = runtime.getModels()[0]!;
  await runtime.setRuntimeApiKey(model.provider, "test-only-key");
  const client = protocolHarness(resolve(agentDir, "models.json"), {
    async createSession(cwd) {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd, agentDir, model, modelRuntime: runtime, settingsManager, resourceLoader,
        sessionManager: SessionManager.inMemory(cwd), tools: ["read"],
      });
      session.agent.streamFunction = (_model, context) => {
        const last = context.messages.at(-1)!;
        const toolTurn = last.role !== "toolResult";
        const text = JSON.stringify(context.messages);
        const message: Message = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: toolTurn ? [{ type: "toolCall", id: "read-marker", name: "read", arguments: { path: "marker.txt" } }]
            : [{ type: "text", text }],
          stopReason: toolTurn ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        // The agent consumes only the iterable and final result at the model seam.
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            if (!toolTurn) yield { type: "text_delta", contentIndex: 0, delta: text, partial: message };
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() { return message; },
        } as unknown as Stream;
      };
      return session;
    },
  });
  try {
    const ids = await Promise.all(workspaces.map(async (cwd) =>
      (await client.request("session/new", { cwd, mcpServers: [] })).result.sessionId as string));
    for (let i = 0; i < ids.length; i++) {
      expect((await client.nextNotification()).params.update.sessionUpdate).toBe("available_commands_update");
    }
    const prompts = ids.map((sessionId, i) => client.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: `Private prompt: ${i === 0 ? "alpha" : "beta"}` }],
    }));
    expect(await Promise.all(prompts)).toEqual(ids.map(() => expect.objectContaining({ result: { stopReason: "end_turn" } })));
    const notifications = await Promise.all(Array.from({ length: 6 }, () => client.nextNotification()));
    const chunks = notifications.filter((message) => message.params.update.sessionUpdate === "agent_message_chunk");
    expect(chunks).toHaveLength(2);
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
