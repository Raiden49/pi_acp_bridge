import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

// Discovery must never parse an unbounded transcript or a giant tool/image record.
export const METADATA_WINDOW_BYTES = 64 * 1024;
export interface SessionMetadata { id: string; cwd: string; title?: string }

interface DiscoveryEntry {
  type?: string; id?: string; cwd?: string; name?: string;
  message?: { role?: string; content?: string | { type: string; text?: string }[] };
}

function entries(text: string): DiscoveryEntry[] {
  return text.split("\n").flatMap(line => {
    try { const entry = JSON.parse(line); return entry && typeof entry === "object" ? [entry] : []; }
    catch { return []; } // Partial writes and cut records are not discovery failures.
  });
}

function sessionHeader(text: string): SessionMetadata | undefined {
  const header = entries(text.slice(0, text.indexOf("\n") < 0 ? undefined : text.indexOf("\n")))[0];
  if (header?.type === "session" && typeof header.id === "string" && typeof header.cwd === "string" && isAbsolute(header.cwd)) {
    return { id: header.id, cwd: header.cwd };
  }
}

// Nonstandard imported filenames need a header-only fallback, never a full load.
export async function readSessionHeader(path: string): Promise<SessionMetadata | undefined> {
  const file = await open(path, "r");
  try {
    let buffer = Buffer.alloc(4096);
    let { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length && !buffer.subarray(0, bytesRead).includes(10)) {
      const expanded = Buffer.alloc(METADATA_WINDOW_BYTES);
      buffer.copy(expanded);
      buffer = expanded;
      bytesRead += (await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)).bytesRead;
    }
    return sessionHeader(buffer.toString("utf8", 0, bytesRead));
  } finally { await file.close(); }
}

export async function readSessionMetadata(path: string, size: number, onRead?: (bytes: number) => void): Promise<SessionMetadata | undefined> {
  const file = await open(path, "r");
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      onRead?.(bytesRead);
      return buffer.toString("utf8", 0, bytesRead);
    };
    const head = await read(0, Math.min(size, METADATA_WINDOW_BYTES));
    const firstLine = head.indexOf("\n");
    if (firstLine < 0 && size > METADATA_WINDOW_BYTES) return;
    const header = sessionHeader(head);
    if (!header) return;
    const start = Math.max(Math.min(size, METADATA_WINDOW_BYTES), size - METADATA_WINDOW_BYTES);
    const tail = size > METADATA_WINDOW_BYTES ? await read(start, size - start) : "";
    // A tail may start inside a JSON record (including UTF-8 or base64 data).
    const aligned = start === METADATA_WINDOW_BYTES && head.endsWith("\n");
    const records = [...entries(head), ...entries(aligned ? tail : tail.slice(tail.indexOf("\n") + 1))];
    const named = records.findLast(entry => entry.type === "session_info");
    const firstUser = records.find(entry => entry.type === "message" && entry.message?.role === "user");
    const content = firstUser?.message?.content;
    const preview = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter(block => block.type === "text").map(block => block.text).join(" ") : undefined;
    const title = (typeof named?.name === "string" ? named.name.trim() : undefined) || preview?.slice(0, 120);
    return { id: header.id, cwd: header.cwd, ...(title ? { title } : {}) };
  } finally {
    await file.close();
  }
}
