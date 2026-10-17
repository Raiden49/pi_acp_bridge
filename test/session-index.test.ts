import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SessionIndex } from "../src/session-index.js";

test("never steals an active lock and recovers after its process is killed", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/index-"));
  const path = resolve(cwd, "acp-sessions.json");
  const record = { cwd, sessionFile: resolve(cwd, "a.jsonl") };
  await new SessionIndex(path).set("original", record);
  const orphan = path + ".00000000-0000-4000-8000-000000000000.tmp";
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    import { writeFileSync } from "node:fs";
    const db = new DatabaseSync(process.argv[1] + ".lock.sqlite");
    db.exec("BEGIN IMMEDIATE");
    writeFileSync(process.argv[2], "interrupted write");
    process.send("locked");
    setInterval(() => {}, 1000);
  `, path, orphan], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "close");
  try {
    await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Lock holder exited early"); })]);
    // Advance only the retry deadline; the real child still owns the OS lock.
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(6000);
    try { await expect(new SessionIndex(path).set("blocked", record)).rejects.toMatchObject({ errcode: 5 }); }
    finally { clock.mockRestore(); }
    expect(await readFile(orphan, "utf8")).toBe("interrupted write");
    child.kill("SIGKILL");
    await exited;
    await Promise.all(["a", "b"].map((id) => new SessionIndex(path).set(id, record)));
    expect(await Promise.all(["original", "a", "b", "blocked"].map((id) => new SessionIndex(path).get(id))))
      .toEqual([record, record, record, undefined]);
    expect((await readdir(cwd)).sort()).toEqual(["acp-sessions.json", "acp-sessions.json.lock.sqlite"]);
  } finally {
    child.kill("SIGKILL");
    await exited;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writers ignore legacy locks, retain concurrent mappings and preserve a damaged index", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/index-"));
  const path = resolve(cwd, "acp-sessions.json");
  const a = { cwd, sessionFile: resolve(cwd, "a.jsonl") };
  const b = { cwd, sessionFile: resolve(cwd, "b.jsonl") };
  try {
    await mkdir(path + ".lock");
    await Promise.all([new SessionIndex(path).set("a", a), new SessionIndex(path).set("b", b)]);
    expect(await Promise.all(["a", "b"].map((id) => new SessionIndex(path).get(id)))).toEqual([a, b]);
    await writeFile(path, "damaged");
    await expect(new SessionIndex(path).set("c", a)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("damaged");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
