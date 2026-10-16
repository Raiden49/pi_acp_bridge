import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SessionIndex } from "../src/session-index.js";

test("independent writers retain every session mapping and refuse to overwrite a damaged index", async () => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/index-"));
  const path = resolve(cwd, "acp-sessions.json");
  const a = { cwd, sessionFile: resolve(cwd, "a.jsonl") };
  const b = { cwd, sessionFile: resolve(cwd, "b.jsonl") };
  try {
    await Promise.all([new SessionIndex(path).set("a", a), new SessionIndex(path).set("b", b)]);
    expect(await Promise.all(["a", "b"].map((id) => new SessionIndex(path).get(id)))).toEqual([a, b]);
    await writeFile(path, "damaged");
    await expect(new SessionIndex(path).set("c", a)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("damaged");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
