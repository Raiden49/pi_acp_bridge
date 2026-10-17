import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { SessionLease } from "../src/session-lease.js";
import { SessionIndex } from "../src/session-index.js";
import { protocolHarness } from "./protocol-harness.js";

async function fixture() {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/session-lease-"));
  const file = resolve(cwd, "history.jsonl");
  await writeFile(file, "original history");
  return { cwd, file, locks: resolve(cwd, "locks"), cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test("leases cover file aliases, fail immediately and recover after a writer is killed", async () => {
  const f = await fixture();
  const owner = new SessionLease(f.locks);
  const contender = new SessionLease(f.locks);
  const alias = resolve(f.cwd, "alias.jsonl");
  await symlink(f.file, alias);
  await owner.acquire(f.file);
  try {
    await expect(contender.acquire(alias)).rejects.toMatchObject({ code: -32600, data: { reason: "session_active_writer" } });
    owner.release();
    const lockPath = resolve(f.locks, (await readdir(f.locks)).find((name) => name.endsWith(".sqlite"))!);
    const inode = (await stat(lockPath)).ino;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const lock = new DatabaseSync(process.argv[1]);
      lock.exec("BEGIN IMMEDIATE");
      process.send("locked");
      setInterval(() => {}, 1000);
    `, lockPath], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "close");
    try {
      await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Writer exited early"); })]);
      await expect(contender.acquire(f.file)).rejects.toHaveProperty("code", -32600);
      child.kill("SIGKILL");
      await exited;
      await contender.acquire(f.file);
      expect((await stat(lockPath)).ino).toBe(inode);
    } finally { child.kill("SIGKILL"); await exited; }
  } finally { owner.release(); contender.release(); await f.cleanup(); }
});

test("two Bridge connections cannot load or delete another connection's leased history", async () => {
  const f = await fixture();
  const sessionIndexPath = resolve(f.cwd, "index.json");
  const index = new SessionIndex(sessionIndexPath);
  await index.set("one", { cwd: f.cwd, sessionFile: f.file });
  await index.set("alias", { cwd: f.cwd, sessionFile: f.file });
  let openings = 0;
  const options = { sessionIndexPath, async createSession() {
    openings++;
    return { sessionFile: f.file, prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose() {} };
  } };
  const a = protocolHarness(resolve(f.cwd, "models.json"), options);
  const b = protocolHarness(resolve(f.cwd, "models.json"), options);
  try {
    expect(await a.request("session/load", { sessionId: "one", cwd: f.cwd, mcpServers: [] })).toHaveProperty("result");
    for (const method of ["session/load", "session/delete"]) {
      expect(await b.request(method, { sessionId: "alias", cwd: f.cwd, mcpServers: [] }))
        .toMatchObject({ error: { code: -32600, data: { reason: "session_active_writer" } } });
    }
    expect(openings).toBe(1);
    expect(await readFile(f.file, "utf8")).toBe("original history");
    await a.request("session/close", { sessionId: "one" });
    expect(await b.request("session/load", { sessionId: "alias", cwd: f.cwd, mcpServers: [] })).toHaveProperty("result");
    await b.shutdown();
    expect(await a.request("session/load", { sessionId: "one", cwd: f.cwd, mcpServers: [] })).toHaveProperty("result");
    await a.request("session/close", { sessionId: "one" });
    expect(await a.request("session/delete", { sessionId: "one" })).toHaveProperty("result");
  } finally { await a.close(); await b.close(); await f.cleanup(); }
});
