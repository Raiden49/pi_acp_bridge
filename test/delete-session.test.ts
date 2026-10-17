import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { SessionIndex } from "../src/session-index.js";
import { protocolHarness } from "./protocol-harness.js";

test.each(["active", "closing", "closed"])("deletes history only after resources settle: %s", async (state) => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/delete-"));
  const sessionFile = resolve(cwd, "history.jsonl");
  const sessionIndexPath = resolve(cwd, "index.json");
  await writeFile(sessionFile, "history");
  let release!: () => void;
  let started!: () => void;
  let aborting!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const entered = new Promise<void>((done) => { started = done; });
  const aborted = new Promise<void>((done) => { aborting = done; });
  const dispose = vi.fn();
  const client = protocolHarness(resolve(cwd, "models.json"), { sessionIndexPath, createSession: async () => ({
    sessionFile, subscribe: () => () => {}, dispose, abort: async () => { aborting(); },
    async prompt() { started(); await gate; await writeFile(sessionFile, "last write"); },
  }) });
  try {
    const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(init.result.agentCapabilities.sessionCapabilities.delete).toEqual({});
    const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    let prompt: Promise<unknown> | undefined;
    let close: Promise<unknown> | undefined;
    if (state === "closed") await client.request("session/close", { sessionId });
    else {
      prompt = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "work" }] });
      await entered;
      if (state === "closing") {
        close = client.request("session/close", { sessionId });
        await aborted;
      }
    }
    const deleting = client.request("session/delete", { sessionId });
    if (state !== "closed") {
      await aborted;
      expect(await readFile(sessionFile, "utf8")).toBe("history");
      expect(await client.request("session/load", { sessionId, cwd, mcpServers: [] })).toHaveProperty("error");
      release();
      expect(await prompt).toMatchObject({ result: { stopReason: "cancelled" } });
    }
    expect(await deleting).toMatchObject({ result: {} });
    await close;
    expect(dispose).toHaveBeenCalledOnce();
    await expect(readFile(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await new SessionIndex(sessionIndexPath).get(sessionId)).toBeUndefined();
    expect(await client.request("session/load", { sessionId, cwd, mcpServers: [] })).toMatchObject({ error: { code: -32602 } });
    // Reopening an IDE-local thread must not make a repeated delete fail.
    expect(await client.request("session/delete", { sessionId })).toMatchObject({ result: {} });
    expect(await client.request("session/delete", { sessionId: "unknown" })).toMatchObject({ result: {} });
  } finally { release(); await client.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("failed file deletion retains its mapping; retry tolerates an already missing file", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/delete-failure-"));
  const sessionIndexPath = resolve(cwd, "index.json");
  const sessionFile = resolve(cwd, "history.jsonl");
  const index = new SessionIndex(sessionIndexPath);
  await mkdir(sessionFile);
  await writeFile(resolve(sessionFile, "keep"), "not a session file");
  await index.set("saved", { cwd, sessionFile });
  const client = protocolHarness(resolve(cwd, "models.json"), { sessionIndexPath });
  try {
    expect(await client.request("session/delete", { sessionId: "saved" })).toMatchObject({ error: { code: -32603 } });
    expect(await index.get("saved")).toEqual({ cwd, sessionFile });
    expect(await readFile(resolve(sessionFile, "keep"), "utf8")).toBe("not a session file");
    await rm(sessionFile, { recursive: true });
    await Promise.all([
      index.set("unrelated", { cwd, sessionFile: resolve(cwd, "unrelated.jsonl") }),
      client.request("session/delete", { sessionId: "saved" }).then((reply) => expect(reply).toMatchObject({ result: {} })),
    ]);
    expect(await index.get("saved")).toBeUndefined();
    expect(await index.get("unrelated")).toBeDefined();
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
