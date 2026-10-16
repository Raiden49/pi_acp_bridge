import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SessionRecord { cwd: string; sessionFile: string }

export class SessionIndex {
  constructor(private path = join(getAgentDir(), "acp-sessions.json")) {}

  private async read(): Promise<Record<string, SessionRecord>> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) =>
      !entry || typeof entry.cwd !== "string" || !isAbsolute(entry.cwd) ||
      typeof entry.sessionFile !== "string" || !isAbsolute(entry.sessionFile))) throw new Error("Invalid session index");
    return value as Record<string, SessionRecord>;
  }

  async get(id: string) {
    const entries = await this.read();
    return Object.hasOwn(entries, id) ? entries[id] : undefined;
  }

  async set(id: string, record: SessionRecord) {
    await mkdir(dirname(this.path), { recursive: true });
    // Serialize read-modify-write across bridge processes; rename keeps readers atomic.
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
        await setTimeout(20);
      }
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const entries = await this.read();
      entries[id] = record;
      await writeFile(temporary, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
