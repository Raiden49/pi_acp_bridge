import { createHash } from "node:crypto";
import { mkdir, realpath, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RequestError } from "@agentclientprotocol/sdk";

// Cooperating Bridge processes only: stock Pi does not acquire this lease.
export class SessionLease {
  private locks = new Map<string, DatabaseSync>();
  constructor(private directory: string) {}

  async acquire(sessionFile: string) {
    const key = await realpath(sessionFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return resolve(sessionFile);
      throw error;
    });
    if (this.locks.has(key)) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${createHash("sha256").update(key).digest("hex")}.sqlite`);
    await (await open(path, "a", 0o600)).close();
    const lock = new DatabaseSync(path);
    try {
      lock.exec("BEGIN IMMEDIATE");
      this.locks.set(key, lock);
    } catch (error) {
      lock.close();
      if ((error as { errcode?: number }).errcode === 5) {
        throw new RequestError(-32600,
          "This Pi session is in use by another Pi Bridge process. Close it there before loading or deleting it here.",
          { reason: "session_active_writer" });
      }
      throw error;
    }
  }

  release() {
    // Closing releases the OS lock, including after a crash. Never unlink its file.
    for (const lock of this.locks.values()) lock.close();
    this.locks.clear();
  }
}
