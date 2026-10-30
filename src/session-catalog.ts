import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RequestError, type ListSessionsResponse, type SessionInfo } from "@agentclientprotocol/sdk";
import { SessionIndex, type SessionRecord } from "./session-index.js";
import { readSessionHeader, readSessionMetadata, type SessionMetadata } from "./session-metadata.js";

const PAGE_SIZE = 50;
const SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_CURSORS = 8;
const MAX_METADATA = 2048;
type Candidate = { path: string; size: number; mtimeMs: number; ino: number; pending?: SessionRecord & { id: string } };
type Snapshot = { cwd?: string; at: number; generation: number; files: Candidate[]; position: number; aliases: Map<string, string>; nativeAliases: Map<string, string>; hidden: Set<string>; seen: Set<string>; buffered?: SessionInfo };
type Cursor = { snapshot: Snapshot; result?: Promise<ListSessionsResponse> };

async function mapBounded<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(16, items.length) }, async () => {
    while (index < items.length) { const current = index++; results[current] = await work(items[current]); }
  }));
  return results;
}

export class SessionCatalog {
  private cursors = new Map<string, Cursor>();
  private metadata = new Map<string, { key: string; info?: SessionMetadata }>();
  private generation = 0;

  constructor(private index: SessionIndex, private sessionDir?: string, private options: {
    sessionsRoot?: string;
    readMetadata?: typeof readSessionMetadata;
  } = {}) {}

  private async directories(cwd?: string) {
    if (this.sessionDir) return [resolve(this.sessionDir)];
    const root = this.options.sessionsRoot ?? join(getAgentDir(), "sessions");
    if (cwd) {
      const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      return [join(root, encoded)];
    }
    try {
      return (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(root, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async files(cwd?: string) {
    const groups = await mapBounded(await this.directories(cwd), async dir => {
      try { return (await readdir(dir)).filter(name => name.endsWith(".jsonl")).map(name => join(dir, name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
    return [...new Set(groups.flat())];
  }

  private async describe(file: Candidate) {
    const key = `${file.mtimeMs}:${file.size}:${file.ino}`;
    const cached = this.metadata.get(file.path);
    if (cached?.key === key) return cached.info;
    let info;
    try { info = await (this.options.readMetadata ?? readSessionMetadata)(file.path, file.size); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.metadata.delete(file.path);
    this.metadata.set(file.path, { key, info });
    if (this.metadata.size > MAX_METADATA) this.metadata.delete(this.metadata.keys().next().value!);
    return info;
  }

  private async snapshot(cwd?: string): Promise<Snapshot> {
    const generation = this.generation;
    const mappings = await this.index.entries();
    const aliases = new Map<string, string>();
    const nativeAliases = new Map<string, string>();
    const hidden = new Set<string>();
    for (const [id, record] of Object.entries(mappings)) {
      if (record.deleted) { hidden.add(id); hidden.add(record.nativeId ?? id); continue; }
      if (!aliases.has(resolve(record.sessionFile))) aliases.set(resolve(record.sessionFile), id);
      if (!nativeAliases.has(record.nativeId ?? id)) nativeAliases.set(record.nativeId ?? id, id);
    }
    // Indexed files can live outside the default Pi tree, including pending sessions.
    const paths = new Set(await this.files(cwd));
    for (const record of Object.values(mappings)) if (!record.deleted && (!cwd || record.cwd === cwd)) paths.add(resolve(record.sessionFile));
    const files = (await mapBounded([...paths], async path => {
      try {
        const info = await stat(path);
        return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino } : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const id = aliases.get(path);
        const record = id ? mappings[id] : undefined;
        return record?.pending ? { path, size: 0, mtimeMs: 0, ino: 0, pending: { ...record, id: id! } } : undefined;
      }
    })).filter((file): file is Candidate => file !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    return { cwd, at: Date.now(), generation, files, position: 0, aliases, nativeAliases, hidden, seen: new Set() };
  }

  async list(cwd?: string | null, cursor?: string | null): Promise<ListSessionsResponse> {
    if (cwd != null && !isAbsolute(cwd)) throw RequestError.invalidParams("cwd must be absolute");
    for (const [id, state] of this.cursors) if (Date.now() - state.snapshot.at > SNAPSHOT_TTL_MS) this.cursors.delete(id);
    let state = cursor != null ? this.cursors.get(cursor) : undefined;
    if (cursor != null && (!state || state.snapshot.cwd !== (cwd ?? undefined))) throw RequestError.invalidParams("Invalid or expired session cursor");
    if (!state) state = { snapshot: await this.snapshot(cwd ?? undefined) };
    // Cache the promise, so concurrent retries of one cursor cannot advance it twice.
    return state.result ??= this.page(state.snapshot);
  }

  private async page(snapshot: Snapshot): Promise<ListSessionsResponse> {
    const sessions: SessionInfo[] = snapshot.buffered ? [snapshot.buffered] : [];
    snapshot.buffered = undefined;
    // One lookahead row avoids advertising an empty next page. Invalid files and
    // duplicate histories can require more probes, but each probe has a byte cap.
    while (snapshot.position < snapshot.files.length && sessions.length <= PAGE_SIZE) {
      const file = snapshot.files[snapshot.position++];
      const info = file.pending ? { id: file.pending.id, cwd: file.pending.cwd } : await this.describe(file);
      if (!info || (snapshot.cwd && info.cwd !== snapshot.cwd) || snapshot.hidden.has(info.id) || snapshot.seen.has(info.id)) continue;
      snapshot.seen.add(info.id);
      sessions.push({ sessionId: snapshot.aliases.get(file.path) ?? snapshot.nativeAliases.get(info.id) ?? info.id, cwd: info.cwd,
        ...("title" in info && info.title ? { title: info.title } : {}),
        ...(file.mtimeMs ? { updatedAt: new Date(file.mtimeMs).toISOString() } : {}),
      });
    }
    if (sessions.length > PAGE_SIZE) snapshot.buffered = sessions.pop();
    const result: ListSessionsResponse = { sessions };
    if (snapshot.buffered && snapshot.generation === this.generation) {
      result.nextCursor = randomUUID();
      this.cursors.set(result.nextCursor, { snapshot });
      while (this.cursors.size > MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value!);
    }
    return result;
  }

  invalidate() { this.generation++; this.cursors.clear(); this.metadata.clear(); }

  async resolve(id: string, cwd?: string): Promise<(SessionRecord & { id: string }) | undefined> {
    const mappings = await this.index.entries();
    if (Object.hasOwn(mappings, id)) {
      const record = mappings[id];
      if (record.deleted) return;
      let nativeId = record.nativeId;
      if (!nativeId) {
        try {
          const file = await stat(record.sessionFile);
          nativeId = (await this.describe({ path: record.sessionFile, size: file.size, mtimeMs: file.mtimeMs, ino: file.ino }))?.id;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return { id, ...record, nativeId, sessionFile: resolve(record.sessionFile) };
    }
    // Exact discovery only reads matching filenames, not every session body.
    const paths = await this.files(cwd);
    const candidates = paths.filter(path => path.endsWith(`_${id}.jsonl`) || path.endsWith(`/${id}.jsonl`) || this.metadata.get(path)?.info?.id === id);
    const exact = new Set(candidates);
    const imported = paths.filter(path => !exact.has(path) && !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_.+\.jsonl$/.test(basename(path)));
    for (const path of [...candidates, ...imported]) {
      try {
        if (!exact.has(path) && (await readSessionHeader(path))?.id !== id) continue;
        const file = await stat(path);
        const info = await this.describe({ path, size: file.size, mtimeMs: file.mtimeMs, ino: file.ino });
        if (info?.id !== id) continue;
        const alias = Object.entries(mappings).find(([, record]) => resolve(record.sessionFile) === path || record.nativeId === id);
        return alias ? { id: alias[0], ...alias[1], nativeId: info.id, sessionFile: resolve(alias[1].sessionFile) }
          : { id, nativeId: info.id, cwd: info.cwd, sessionFile: path };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
