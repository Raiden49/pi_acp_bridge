import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";

const kinds: Record<string, ToolKind> = {
  read: "read", edit: "edit", write: "edit", bash: "execute", grep: "search", find: "search", ls: "read",
};

function snapshot(path: string): string | null | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    // Only a missing file means creation; unreadable files must not yield invented diffs.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

function resolveToolPath(path: string, cwd: string) {
  // Match Pi's tool path normalization, including mention prefixes and file URIs.
  path = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  try {
    return resolve(cwd, path.startsWith("file://") ? fileURLToPath(path) : path);
  } catch {
    // Invalid tool input must not interrupt synchronous session event delivery.
    return undefined;
  }
}

function location(path: string, line: number) {
  return { path, line, _meta: { "pi-acp-bridge/uri": pathToFileURL(path).href } };
}

export interface FileChange {
  path: string;
  oldText: string | null | undefined;
  newText?: string;
}

export function createToolUpdates(cwd: string, editorChanges?: Map<string, FileChange>) {
  const files = new Map<string, { path: string; oldText: string | null | undefined }>();
  return (event: AgentSessionEvent): SessionUpdate[] => {
    if (event.type === "tool_execution_start") {
      const args = event.args as Record<string, unknown>;
      const rawPath = args.path;
      const path = typeof rawPath === "string" ? resolveToolPath(rawPath, cwd) : undefined;
      if (path && (event.toolName === "edit" || event.toolName === "write")) {
        // Session listeners are synchronous: capture before Pi can execute the tool.
        files.set(event.toolCallId, { path, oldText: snapshot(path) });
      }
      const line = typeof args.offset === "number" ? Math.max(1, Math.trunc(args.offset)) : 1;
      const updates: SessionUpdate[] = [{ sessionUpdate: "tool_call", toolCallId: event.toolCallId, title: event.toolName,
        kind: kinds[event.toolName] ?? "other", status: "in_progress", rawInput: event.args,
        locations: path ? [location(path, line)] : [],
      }];
      return updates;
    }
    if (event.type === "tool_execution_end" || event.type === "tool_execution_update") {
      const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
      const content: ToolCallContent[] = [];
      for (const block of result.content ?? []) {
        if (block.type === "text" || block.type === "image") content.push({ type: "content", content: block });
      }
      const editor = event.type === "tool_execution_end" ? editorChanges?.get(event.toolCallId) : undefined;
      const file = editor ?? files.get(event.toolCallId);
      let locations;
      if (event.type === "tool_execution_end" && file) {
        files.delete(event.toolCallId);
        editorChanges?.delete(event.toolCallId);
        const newText = editor ? editor.newText : snapshot(file.path);
        if (file.oldText !== undefined && typeof newText === "string" && newText !== file.oldText) {
          content.push({ type: "diff", path: file.path, oldText: file.oldText, newText });
          const before = (file.oldText ?? "").split("\n");
          const after = newText.split("\n");
          let index = 0;
          while (index < before.length && index < after.length && before[index] === after[index]) index++;
          locations = [location(file.path, Math.min(index + 1, after.length))];
        }
      }
      return [{ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, content, rawOutput: result, locations,
        status: event.type === "tool_execution_end" ? event.isError ? "failed" : "completed" : "in_progress" }];
    }
    return [];
  };
}
