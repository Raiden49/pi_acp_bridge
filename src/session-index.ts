import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
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
    // SQLite owns the OS lock; crashes release it without guessing an owner's liveness.
    // Keep this coordination file: unlinking it could create two independent lock domains.
    const mutex = new DatabaseSync(`${this.path}.lock.sqlite`);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        try { mutex.exec("BEGIN IMMEDIATE"); break; }
        catch (error) {
          if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
          await setTimeout(20);
        }
      }
      const entries = await this.read();
      // Only the lock owner can create index temporaries; leftovers belong to crashed writers.
      const prefix = basename(this.path) + ".";
      for (const name of await readdir(dirname(this.path))) {
        if (name.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) {
          await rm(join(dirname(this.path), name), { force: true });
        }
      }
      entries[id] = record;
      await writeFile(temporary, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      try { await rm(temporary, { force: true }); }
      finally { mutex.close(); }
    }
  }
}
