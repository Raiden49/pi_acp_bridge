import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RequestError } from "@agentclientprotocol/sdk";
import { SessionIndex } from "./session-index.js";

export class SessionCatalog {
  constructor(private index: SessionIndex, private sessionDir?: string) {}

  private async scan() {
    const [history, mappings] = await Promise.all([SessionManager.listAll(this.sessionDir), this.index.entries()]);
    const aliases = new Map<string, string>();
    for (const [id, record] of Object.entries(mappings)) {
      const key = resolve(record.sessionFile);
      if (!aliases.has(key)) aliases.set(key, id);
    }
    const files = new Map<string, { info: (typeof history)[number]; id: string }>();
    for (const info of history) {
      const key = resolve(info.path);
      if (!files.has(key)) files.set(key, { info: { ...info, path: key }, id: aliases.get(key) ?? info.id });
    }
    const sessions = new Map<string, { info: (typeof history)[number]; id: string }>();
    for (const entry of files.values()) {
      const previous = sessions.get(entry.info.id);
      // Copied histories still describe one session. Prefer its established ACP ID.
      if (!previous || (previous.id === previous.info.id && entry.id !== entry.info.id)) sessions.set(entry.info.id, entry);
    }
    return [...sessions.values()];
  }

  async list(cwd?: string | null, cursor?: string | null) {
    if (cursor && !/^\d+$/.test(cursor)) throw RequestError.invalidParams("Invalid session cursor");
    const offset = Number(cursor ?? 0);
    if (!Number.isSafeInteger(offset)) throw RequestError.invalidParams("Invalid session cursor");
    const history = (await this.scan()).filter(({ info }) => {
      if (!info.cwd || (cwd && info.cwd !== cwd) || !info.messageCount) return false;
      // Image-only conversations have no text preview too; do not hide them.
      return info.firstMessage !== "(no messages)" || SessionManager.open(info.path).getEntries().some((entry) =>
        entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
    })
      .sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime() || a.id.localeCompare(b.id));
    const page = history.slice(offset, offset + 50);
    return {
      sessions: page.map(({ info, id }) => ({ sessionId: id, cwd: info.cwd,
        title: info.name || (info.firstMessage === "(no messages)" ? "Untitled conversation" : info.firstMessage.slice(0, 120)) || info.id, updatedAt: info.modified.toISOString() })),
      nextCursor: offset + 50 < history.length ? String(offset + 50) : null,
    };
  }

  async resolve(id: string) {
    const indexed = await this.index.get(id);
    if (indexed) return { id, ...indexed, sessionFile: resolve(indexed.sessionFile) };
    const found = (await this.scan()).find((entry) => entry.info.id === id || entry.id === id);
    return found && { id: found.id, cwd: found.info.cwd, sessionFile: found.info.path };
  }
}
