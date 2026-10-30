import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { AgentSideConnection, FileSystemCapabilities } from "@agentclientprotocol/sdk";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, detectSupportedImageMimeTypeFromFile,
  type EditOperations, type InlineExtension, type ReadOperations, type WriteOperations } from "@earendil-works/pi-coding-agent";
import type { FileChange } from "./tool-updates.js";

function within(path: string, root: string) {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

// The ACP pair is opt-in. Keep one backend for Pi's read/edit/write tools;
// never turn a failed editor request into a potentially stale disk operation.
export class ClientFileSystem {
  readonly changes = new Map<string, FileChange>();
  private sessionId?: string;
  readonly enabled: boolean;
  constructor(private cwd: string, private agentDir: string,
    private client: Pick<AgentSideConnection, "readTextFile" | "writeTextFile">,
    capabilities: FileSystemCapabilities) {
    this.enabled = Boolean(capabilities.readTextFile && capabilities.writeTextFile);
  }
  bindSession(sessionId: string) { this.sessionId = sessionId; }
  private requestSessionId() {
    if (!this.sessionId) throw new Error("Editor filesystem requires an active ACP session");
    return this.sessionId;
  }
  private delegated(path: string) {
    // Like Gemini ACP, exclude native profile data even when it overlaps cwd.
    // This is routing, not a filesystem sandbox or symlink security boundary.
    return this.enabled && within(path, this.cwd) && !within(path, this.agentDir);
  }
  private async readText(path: string) {
    try {
      return (await this.client.readTextFile({ sessionId: this.requestSessionId(), path })).content;
    } catch (error) {
      // ACP standardizes -32002; retain text matching for older clients.
      const message = error instanceof Error ? error.message : String(error);
      if ((error as { code?: number } | null)?.code === -32002 || /Resource not found|ENOENT|does not exist|No such file/i.test(message)) {
        throw Object.assign(new Error(message, { cause: error }), { code: "ENOENT" });
      }
      throw error;
    }
  }
  private async snapshot(path: string): Promise<string | null | undefined> {
    try { return await this.readText(path); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
  }
  private async imageMime(path: string) {
    try { return await detectSupportedImageMimeTypeFromFile(path); }
    catch (error) { if (this.delegated(path)) return null; throw error; }
  }
  private operations(toolCallId: string): EditOperations & WriteOperations {
    return {
      access: path => this.delegated(path) ? Promise.resolve() : access(path, constants.R_OK | constants.W_OK),
      mkdir: async path => { if (!this.delegated(path)) await mkdir(path, { recursive: true }); },
      readFile: async path => {
        if (!this.delegated(path)) return readFile(path);
        const text = await this.readText(path);
        this.changes.set(toolCallId, { path, oldText: text });
        return Buffer.from(text);
      },
      writeFile: async (path, content) => {
        if (!this.delegated(path)) { await writeFile(path, content, "utf8"); return; }
        const change = this.changes.get(toolCallId) ?? { path, oldText: await this.snapshot(path) };
        this.changes.set(toolCallId, change);
        await this.client.writeTextFile({ sessionId: this.requestSessionId(), path, content });
        // Read back the actual editor state, not the proposed content or disk.
        change.newText = await this.snapshot(path) ?? undefined;
      },
    };
  }
  extensions(): InlineExtension[] {
    if (!this.enabled) return [];
    return [{ name: "ide-filesystem", hidden: true, replaceable: true, factory: pi => {
      const operations: ReadOperations = {
        access: path => this.delegated(path) ? Promise.resolve() : access(path, constants.R_OK),
        detectImageMimeType: path => this.imageMime(path),
        readFile: async path => this.delegated(path) && !await this.imageMime(path)
          ? Buffer.from(await this.readText(path)) : readFile(path),
      };
      pi.registerTool({ ...createReadToolDefinition(this.cwd), defaultActive: false,
        execute: (id, args, signal, onUpdate, ctx) => createReadToolDefinition(this.cwd,
          { operations, autoResizeImages: pi.getSettings().images?.autoResize }).execute(id, args, signal, onUpdate, ctx),
      });
      pi.registerTool({ ...createEditToolDefinition(this.cwd), defaultActive: false,
        execute: (id, args, signal, onUpdate, ctx) => createEditToolDefinition(this.cwd, { operations: this.operations(id) })
          .execute(id, args, signal, onUpdate, ctx),
      });
      pi.registerTool({ ...createWriteToolDefinition(this.cwd), defaultActive: false,
        execute: (id, args, signal, onUpdate, ctx) => createWriteToolDefinition(this.cwd, { operations: this.operations(id) })
          .execute(id, args, signal, onUpdate, ctx),
      });
    } }];
  }
}
