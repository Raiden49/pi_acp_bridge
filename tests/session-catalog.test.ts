import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionCatalog } from "../src/session-catalog.js";
import { SessionIndex } from "../src/session-index.js";
import { METADATA_WINDOW_BYTES, readSessionMetadata } from "../src/session-metadata.js";

async function fixture(t: TestContext) {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/acp-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "sessions");
  await mkdir(dir);
  return { root, dir, index: new SessionIndex(join(root, "index.json")) };
}

async function history(dir: string, id: string, time = 1, cwd = "/workspace", prefix = "2024-01-01T00-00-00-000Z") {
  const file = join(dir, `${prefix}_${id}.jsonl`);
  await writeFile(file, [
    { type: "session", version: 3, id, cwd, timestamp: "2024-01-01T00:00:00Z" },
    { type: "message", message: { role: "user", content: `Prompt ${id}` } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await utimes(file, time, time);
  return file;
}

const invalidCursor = (error: unknown) => (error as { code: number }).code === -32602;

test("pages probe only page-sized metadata and reuse a stable, repeatable snapshot", async t => {
  const { dir, index } = await fixture(t);
  await Promise.all(Array.from({ length: 75 }, (_, i) => history(dir, `s${i}`, i + 1)));
  let reads = 0;
  const catalog = new SessionCatalog(index, dir, { readMetadata: async (...args) => {
    reads++;
    return readSessionMetadata(...args);
  } });
  const first = await catalog.list();
  assert.equal(first.sessions.length, 50);
  assert.equal(reads, 51);
  await history(dir, "new", 1000);
  const [second, retry] = await Promise.all([catalog.list(null, first.nextCursor), catalog.list(null, first.nextCursor)]);
  assert.deepEqual(retry, second);
  assert.equal(second.sessions.length, 25);
  assert.equal("nextCursor" in second, false);
  assert.equal(reads, 75);
  assert.equal(new Set([...first.sessions, ...second.sessions].map(session => session.sessionId)).size, 75);
  await catalog.list();
  assert.equal(reads, 76); // Unchanged metadata is reused; only the new file is read.
  await assert.rejects(catalog.list("/workspace", first.nextCursor), invalidCursor);
  await assert.rejects(catalog.list(null, ""), invalidCursor);
});

test("scoped discovery never opens another project's transcripts; exact IDs avoid list scans", async t => {
  const { dir, index } = await fixture(t);
  const own = join(dir, "--workspace--");
  const other = join(dir, "--other--");
  await Promise.all([mkdir(own), mkdir(other)]);
  const path = await history(own, "wanted");
  await history(other, "other", 2, "/other");
  let reads = 0;
  const catalog = new SessionCatalog(index, undefined, { sessionsRoot: dir, readMetadata: async (file, size) => {
    reads++;
    assert.equal(file, path);
    return readSessionMetadata(file, size);
  } });
  assert.equal((await catalog.resolve("missing", "/workspace")), undefined);
  assert.equal(reads, 0);
  assert.equal((await catalog.resolve("wanted", "/workspace"))?.sessionFile, path);
  assert.deepEqual((await catalog.list("/workspace")).sessions.map(session => session.sessionId), ["wanted"]);
  assert.equal(reads, 1);
});

test("unindexed, renamed imports remain loadable by their native ID after restart", async t => {
  const { dir, index } = await fixture(t);
  const file = await history(dir, "renamed");
  const imported = join(dir, "imported.jsonl");
  await rename(file, imported);
  const catalog = new SessionCatalog(index, dir);
  assert.equal((await catalog.resolve("renamed"))?.sessionFile, imported);
});

test("large tool records are never fully read for metadata", async t => {
  const { dir } = await fixture(t);
  const file = await history(dir, "large");
  const header = JSON.stringify({ type: "session", id: "large", cwd: "/workspace" });
  await writeFile(file, `${header}\n${JSON.stringify({ type: "message", message: { role: "toolResult", content: "x".repeat(2 * 1024 * 1024) } })}\n${JSON.stringify({ type: "session_info", name: "Latest title" })}\n`);
  let bytes = 0;
  const info = await readSessionMetadata(file, (await stat(file)).size, count => { bytes += count; });
  assert.equal(info?.title, "Latest title");
  assert.equal(bytes, 2 * METADATA_WINDOW_BYTES);
});

test("pending sessions are discoverable and deletion hides copies across restarts", async t => {
  const { dir, index } = await fixture(t);
  const original = await history(dir, "native", 1, "/workspace", "original");
  await history(dir, "native", 2, "/workspace", "copy");
  await index.set("legacy-acp", { cwd: "/workspace", sessionFile: original, nativeId: "native" });
  await index.set("pending", { cwd: "/workspace", sessionFile: join(dir, "future_pending.jsonl"), pending: true });
  const catalog = new SessionCatalog(index, dir);
  assert.deepEqual((await catalog.list()).sessions.map(session => session.sessionId), ["legacy-acp", "pending"]);
  await index.delete("legacy-acp");
  const restarted = new SessionCatalog(index, dir);
  assert.deepEqual((await restarted.list()).sessions.map(session => session.sessionId), ["pending"]);
  assert.equal(await restarted.resolve("native"), undefined);
});
