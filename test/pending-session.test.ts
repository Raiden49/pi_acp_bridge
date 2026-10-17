import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { assistantStream, createBareSession, createTestRuntime } from "./fixtures.js";
import type { ServerOptions } from "../src/server.js";

test("pending sessions resume with the same ID without creating empty Pi histories", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/pending-"));
  const sessionIndexPath = resolve(root, "index.json");
  const sessionDir = resolve(root, "sessions");
  const runtime = await createTestRuntime(resolve(root, "models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "test-only");
  const options: Partial<ServerOptions> = { sessionDir, sessionIndexPath,
    async createSession(cwd, file, _servers, id) {
      if (file) await stat(file);
      const sessionManager = file ? SessionManager.open(file) : SessionManager.create(cwd, sessionDir, id ? { id } : undefined);
      const session = await createBareSession({ cwd, agentDir: root, modelRuntime: runtime, model,
        sessionManager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), noTools: "all" });
      session.agent.streamFunction = () => assistantStream(model, [{ type: "text", text: "Ready" }]);
      return session;
    },
  };
  let client = protocolHarness(resolve(root, "models.json"), options);
  const other = protocolHarness(resolve(root, "models.json"), options);
  const record = async (id: string) => JSON.parse(await readFile(sessionIndexPath, "utf8"))[id];
  try {
    const { sessionId } = (await client.request("session/new", { cwd: root, mcpServers: [] })).result;
    const pending = await record(sessionId);
    expect(pending.pending).toBe(true);
    await expect(stat(pending.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await client.request("session/list", { cwd: root })).result.sessions).toEqual([]);
    expect(await other.request("session/load", { sessionId, cwd: root, mcpServers: [] }))
      .toMatchObject({ error: { code: -32600, data: { reason: "session_active_writer" } } });
    await client.close();
    client = protocolHarness(resolve(root, "models.json"), options);
    expect(await client.request("session/load", { sessionId, cwd: root, mcpServers: [] })).toHaveProperty("result");
    await expect(stat((await record(sessionId)).sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await other.request("session/load", { sessionId, cwd: root, mcpServers: [] }))
      .toMatchObject({ error: { code: -32600, data: { reason: "session_active_writer" } } });
    expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Start now" }] }))
      .toHaveProperty("result");
    const started = await record(sessionId);
    expect(started.pending).toBeUndefined();
    expect(SessionManager.open(started.sessionFile).getSessionId()).toBe(sessionId);
    expect((await client.request("session/list", { cwd: root })).result.sessions.map((s: any) => s.sessionId)).toEqual([sessionId]);
    await client.request("session/close", { sessionId });
    await rm(started.sessionFile);
    // Missing real history must not silently turn into a new empty conversation.
    expect(await client.request("session/load", { sessionId, cwd: root, mcpServers: [] })).toHaveProperty("error");
  } finally { await client.close(); await other.close(); await rm(root, { recursive: true, force: true }); }
});
