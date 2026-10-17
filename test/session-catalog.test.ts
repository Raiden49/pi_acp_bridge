import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { SessionIndex } from "../src/session-index.js";

async function fixture() {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/catalog-"));
  const sessionDir = resolve(root, "history");
  await mkdir(sessionDir);
  const cwd = resolve(root, "workspace");
  const sessionIndexPath = resolve(root, "index.json");
  const create = async (workspace: string, text: string, title?: string) => {
    const manager = SessionManager.create(workspace, sessionDir);
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    if (title) manager.appendSessionInfo(title);
    // A CLI may not have received an assistant response yet; persist the fixture explicitly.
    await writeFile(manager.getSessionFile()!, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return manager;
  };
  return { root, cwd, sessionDir, sessionIndexPath, create,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("discovers native histories with project filtering, titles, pagination and stable legacy IDs", async () => {
  const f = await fixture();
  const index = new SessionIndex(f.sessionIndexPath);
  const history = await Promise.all(Array.from({ length: 51 }, (_, i) => f.create(f.cwd, `Terminal message ${i}`, i === 0 ? "Named terminal chat" : undefined)));
  const other = await f.create(resolve(f.root, "other"), "Another workspace");
  const native = history[0]!;
  const aliasPath = native.getSessionFile()!.replace("/history/", "/history/../history/");
  await index.set("legacy-acp-id", { cwd: f.cwd, sessionFile: aliasPath });
  await index.set("duplicate-alias", { cwd: f.cwd, sessionFile: native.getSessionFile()! });
  await copyFile(native.getSessionFile()!, resolve(f.sessionDir, "copied-session.jsonl"));
  const before = await readFile(f.sessionIndexPath, "utf8");
  const client = protocolHarness(resolve(f.root, "models.json"), f);
  try {
    const initialized = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(initialized.result.agentCapabilities.sessionCapabilities.list).toEqual({});
    const first = (await client.request("session/list", { cwd: f.cwd })).result;
    expect(first.sessions).toHaveLength(50);
    const second = (await client.request("session/list", { cwd: f.cwd, cursor: first.nextCursor })).result;
    expect(second.sessions).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const listed = [...first.sessions, ...second.sessions];
    expect(new Set(listed.map((entry) => entry.sessionId)).size).toBe(51);
    expect(listed.map((entry) => entry.updatedAt)).toEqual(listed.map((entry) => entry.updatedAt).sort().reverse());
    expect(listed).toContainEqual(expect.objectContaining({ sessionId: "legacy-acp-id", title: "Named terminal chat", cwd: f.cwd, updatedAt: expect.any(String) }));
    expect(listed.some((entry) => entry.sessionId === native.getSessionId() || entry.sessionId === "duplicate-alias")).toBe(false);
    expect(listed).toContainEqual(expect.objectContaining({ title: "Terminal message 1" }));
    expect((await client.request("session/list", { cwd: resolve(f.root, "other") })).result.sessions.map((entry: any) => entry.sessionId)).toEqual([other.getSessionId()]);
    expect((await client.request("session/list", {})).result.nextCursor).not.toBeNull();
    expect(await readFile(f.sessionIndexPath, "utf8")).toBe(before);
    expect(await client.request("session/list", { cwd: "relative" })).toHaveProperty("error");
    expect(await client.request("session/list", { cursor: "invalid" })).toHaveProperty("error");
  } finally { await client.close(); await f.cleanup(); }
});

test("hides setup-only histories without deleting them or hiding image conversations", async () => {
  const f = await fixture();
  const empty = SessionManager.create(f.cwd, f.sessionDir);
  empty.appendMessage({ role: "system", content: "Setup only", timestamp: 1 });
  await writeFile(empty.getSessionFile()!, [empty.getHeader(), ...empty.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const image = SessionManager.create(f.cwd, f.sessionDir);
  image.appendMessage({ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 2 });
  const client = protocolHarness(resolve(f.root, "models.json"), f);
  try {
    const listed = (await client.request("session/list", { cwd: f.cwd })).result.sessions;
    expect(listed).toEqual([expect.objectContaining({ sessionId: image.getSessionId(), title: "Untitled conversation" })]);
    expect(await readFile(empty.getSessionFile()!, "utf8")).toContain("Setup only");
  } finally { await client.close(); await f.cleanup(); }
});

test("loads terminal history, keeps existing IDs and deletes native histories without prior loading", async () => {
  const f = await fixture();
  const native = await f.create(f.cwd, "Created in terminal");
  const legacy = await f.create(f.cwd, "Legacy history");
  const unopened = await f.create(f.cwd, "Delete without loading");
  const index = new SessionIndex(f.sessionIndexPath);
  await index.set("legacy", { cwd: f.cwd, sessionFile: legacy.getSessionFile()! });
  await index.set("legacy-alias", { cwd: f.cwd, sessionFile: legacy.getSessionFile()! });
  const client = protocolHarness(resolve(f.root, "models.json"), { ...f, async createSession(cwd, file) {
    const sessionManager = file ? SessionManager.open(file) : await f.create(cwd, "New bridge chat");
    return { sessionManager, sessionFile: sessionManager.getSessionFile(), subscribe: () => () => {},
      prompt: async () => {}, abort: async () => {}, dispose() {} };
  } });
  try {
    const nativeId = native.getSessionId();
    expect(await client.request("session/load", { sessionId: nativeId, cwd: resolve(f.root, "wrong"), mcpServers: [] })).toMatchObject({ error: { code: -32602 } });
    expect(await client.request("session/load", { sessionId: nativeId, cwd: f.cwd, mcpServers: [] })).toHaveProperty("result");
    expect((await client.nextNotification()).params.update).toEqual({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Created in terminal" } });
    await client.request("session/close", { sessionId: nativeId });
    expect(await client.request("session/load", { sessionId: "legacy", cwd: f.cwd, mcpServers: [] })).toHaveProperty("result");
    expect(await client.request("session/load", { sessionId: legacy.getSessionId(), cwd: f.cwd, mcpServers: [] })).toMatchObject({ error: { code: -32600 } });
    expect(await client.request("session/delete", { sessionId: legacy.getSessionId() })).toHaveProperty("result");
    expect(await index.get("legacy")).toBeUndefined();
    expect(await index.get("legacy-alias")).toBeUndefined();
    expect(await client.request("session/delete", { sessionId: unopened.getSessionId() })).toHaveProperty("result");
    expect(await client.request("session/delete", { sessionId: unopened.getSessionId() })).toHaveProperty("result");
    await expect(readFile(unopened.getSessionFile()!)).rejects.toMatchObject({ code: "ENOENT" });
    const created = (await client.request("session/new", { cwd: f.cwd, mcpServers: [] })).result;
    expect(await index.get(created.sessionId)).toBeDefined();
    const listed = (await client.request("session/list", { cwd: f.cwd })).result.sessions;
    expect(listed.map((entry: any) => entry.sessionId).sort()).toEqual([nativeId, created.sessionId].sort());
    expect(SessionManager.open((await index.get(created.sessionId))!.sessionFile).getSessionId()).toBe(created.sessionId);
  } finally { await client.close(); await f.cleanup(); }
});
