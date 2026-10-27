import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { assistantStream, createBareSession, createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

test("fork creates an independently loadable history without replacing or modifying the source", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/fork-"));
  const runtime = await createTestRuntime(resolve(root, "models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "fixture-key");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const streaming = new Promise<void>(resolve => { entered = resolve; });
  const client = protocolHarness(resolve(root, "models.json"), { sessionIndexPath: resolve(root, "index.json"), sessionDir: resolve(root, "sessions"),
    async createSession(cwd, file) {
      const session = await createBareSession({ cwd, agentDir: root, modelRuntime: runtime, model, settingsManager: SettingsManager.inMemory(),
        sessionManager: file ? SessionManager.open(file) : SessionManager.create(cwd, resolve(root, "sessions")), noTools: "all" });
      session.agent.streamFunction = async (_model, context) => {
        const stream = await assistantStream(model, [{ type: "text", text: "fixture response" }]);
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
          if (JSON.stringify(context.messages.at(-1)).includes("busy source")) { entered(); await gate; }
          yield* { [Symbol.asyncIterator]: iterate };
        };
        return stream;
      };
      return session;
    },
  });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: root, mcpServers: [] })).result;
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "source conversation" }] });
    const busy = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "busy source" }] });
    await streaming;
    expect(await client.request("session/fork", { sessionId, cwd: root, mcpServers: [] })).toMatchObject({ error: { code: -32600 } });
    release(); await busy;
    const source = (await SessionManager.list(root, resolve(root, "sessions")))[0]!;
    const original = await readFile(source.path, "utf8");
    const response = await client.request("session/fork", { sessionId, cwd: root, mcpServers: [] });
    expect(response.error).toBeUndefined();
    const forkId = response.result.sessionId;
    expect(forkId).not.toBe(sessionId);
    expect(await readFile(source.path, "utf8")).toBe(original);
    await client.request("session/close", { sessionId: forkId });
    expect(await client.request("session/load", { sessionId: forkId, cwd: root, mcpServers: [] })).toHaveProperty("result");
    await client.request("session/prompt", { sessionId: forkId, prompt: [{ type: "text", text: "fork only" }] });
    expect(await readFile(source.path, "utf8")).not.toContain("fork only");
    expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "source still usable" }] })).toHaveProperty("result");
    expect(await client.request("session/fork", { sessionId, cwd: root, _meta: { jetbrains: { air: { fork: { version: 1, messageId: "selected-message" } } } } }))
      .toMatchObject({ error: { code: -32602 } });
    await client.request("session/close", { sessionId });
    expect(await client.request("session/fork", { sessionId, cwd: root, mcpServers: [] })).toHaveProperty("result");
  } finally { release(); await client.close(); await rm(root, { recursive: true, force: true }); }
});
