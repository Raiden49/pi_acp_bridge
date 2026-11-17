import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ndJsonStream, type AnyMessage } from "@agentclientprotocol/sdk";

export interface AgyBridgeOptions {
  clientInput: ReadableStream<Uint8Array>;
  clientOutput: WritableStream<Uint8Array>;
  agentInput: ReadableStream<Uint8Array>;
  agentOutput: WritableStream<Uint8Array>;
  loadSystemPromptAppend?: (cwd: string) => Promise<string>;
  trace?: (event: Record<string, string | number | boolean>) => void;
}

type JsonRpcId = string | number | null;
type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

export function buildAgySystemPromptAppend(input: {
  agentsFiles: ReadonlyArray<{ path: string; content: string }>;
  appendSystemPrompt: ReadonlyArray<string>;
}): string {
  const sections: string[] = [];
  if (input.agentsFiles.length > 0) {
    const body = input.agentsFiles
      .map(({ path, content }) => `<project_instructions path="${path}">\n${content.trim()}\n</project_instructions>`)
      .join("\n\n");
    sections.push(`<project_context>\nProject-specific instructions and guidelines:\n\n${body}\n</project_context>`);
  }
  const addendum = input.appendSystemPrompt.map(p => p.trim()).filter(Boolean).join("\n\n");
  if (addendum) sections.push(`<addendum>\n${addendum}\n</addendum>`);
  return sections.join("\n\n");
}

export async function loadAgySystemPromptAppend(cwd: string, agentDir = getAgentDir()): Promise<string> {
  const resolvedCwd = resolve(cwd);
  const settingsManager = SettingsManager.create(resolvedCwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: resolvedCwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  return buildAgySystemPromptAppend({
    agentsFiles: loader.getAgentsFiles().agentsFiles,
    appendSystemPrompt: loader.getAppendSystemPrompt(),
  });
}

export function injectAgySystemPromptMeta(params: JsonRecord, append: string): JsonRecord {
  if (!append.trim()) return params;
  const meta = asRecord(params._meta), agy = asRecord(meta.antigravity), sys = asRecord(agy.systemPrompt);
  const existing = typeof sys.append === "string" ? sys.append.trim() : "";
  return {
    ...params,
    _meta: { ...meta, antigravity: { ...agy, systemPrompt: { ...sys, append: existing ? `${existing}\n\n${append}` : append } } },
  };
}

export function startAgyBridge({
  clientInput, clientOutput, agentInput, agentOutput,
  loadSystemPromptAppend = loadAgySystemPromptAppend, trace = () => {},
}: AgyBridgeOptions) {
  const clientStream = ndJsonStream(clientOutput, clientInput);
  const agentStream = ndJsonStream(agentOutput, agentInput);
  const clientWriter = clientStream.writable.getWriter();
  const agentWriter = agentStream.writable.getWriter();
  const pendingReplays = new Map<JsonRpcId, string>();

  const sendToClient = (message: AnyMessage) => clientWriter.write(message).catch(() => {});
  const sendToAgent = (message: AnyMessage) => agentWriter.write(message).catch(() => {});

  const handleClientMessage = async (msg: JsonRecord) => {
    const method = typeof msg.method === "string" ? msg.method : undefined;
    const id = msg.id as JsonRpcId | undefined;
    const params = asRecord(msg.params);

    if (method === "session/new" || method === "session/load" || method === "session/resume") {
      if (method !== "session/new" && id !== undefined && typeof params.sessionId === "string") {
        pendingReplays.set(id, params.sessionId);
      }
      if (typeof params.cwd === "string" && isAbsolute(params.cwd)) {
        const append = await loadSystemPromptAppend(params.cwd);
        trace({ event: "agy_session_prepare", method, appendLength: append.length });
        await sendToAgent({ ...msg, params: injectAgySystemPromptMeta(params, append) } as AnyMessage);
        return;
      }
    }

    await sendToAgent(msg as AnyMessage);
  };

  const handleAgentMessage = async (msg: JsonRecord) => {
    const id = msg.id as JsonRpcId | undefined;
    if (id !== undefined && msg.method === undefined) pendingReplays.delete(id);

    if (msg.method === "session/update") {
      const params = asRecord(msg.params), update = asRecord(params.update);
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      // agy echoes user_message_chunk during live prompt turns, duplicating user bubbles in Air.
      if (sessionId && update.sessionUpdate === "user_message_chunk"
        && ![...pendingReplays.values()].includes(sessionId)) {
        return;
      }
    }

    await sendToClient(msg as AnyMessage);
  };

  const clientReader = clientStream.readable.getReader();
  const agentReader = agentStream.readable.getReader();

  const pump = async (
    reader: ReadableStreamDefaultReader<AnyMessage>,
    handler: (msg: JsonRecord) => Promise<void>,
    onError?: (id: JsonRpcId, err: unknown) => Promise<void>,
  ) => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || Array.isArray(value)) continue;
        try {
          await handler(value as JsonRecord);
        } catch (err) {
          trace({ event: "agy_message_error", error: err instanceof Error ? err.message : String(err) });
          const id = (value as JsonRecord).id as JsonRpcId | undefined;
          if (id !== undefined && onError) await onError(id, err);
        }
      }
    } catch (err) {
      trace({ event: "agy_stream_error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      reader.releaseLock();
    }
  };

  const clientLoop = pump(clientReader, handleClientMessage, (id, err) =>
    sendToClient({ jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : "Bridge error" } }),
  ).finally(async () => {
    await agentWriter.close().catch(() => {});
    await agentOutput.close().catch(() => {});
  });

  const agentLoop = pump(agentReader, handleAgentMessage).finally(async () => {
    await clientWriter.close().catch(() => {});
    await clientReader.cancel().catch(() => {});
  });

  return { closed: Promise.allSettled([clientLoop, agentLoop]).then(() => {}) };
}

export function resolveAgyExecutable(explicit?: string, searchDirs?: readonly string[]): string {
  const override = explicit ?? process.env.PI_AGY_COMMAND;
  if (override) return override;
  const dirs = searchDirs ?? [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    "/opt/homebrew/bin", join(homedir(), ".gemini/bin"), "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), "bin"),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, "agy");
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return "agy";
}

export function startAgyProcessBridge(options: {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  command?: string;
  args?: string[];
  trace?: (event: Record<string, string | number | boolean>) => void;
}) {
  const executable = resolveAgyExecutable(options.command);
  const child = spawn(
    executable,
    ["acp", "--include-default-customizations=false", "--dangerously-skip-permissions", ...(options.args ?? [])],
    { stdio: ["pipe", "pipe", "inherit"], env: process.env },
  );
  child.stdin.on("error", () => {});
  child.on("error", (err) => {
    options.trace?.({ event: "agy_spawn_error", executable, error: err.message });
    child.stdout.destroy(err);
  });

  const bridge = startAgyBridge({
    clientInput: options.input,
    clientOutput: options.output,
    agentInput: Readable.toWeb(child.stdout),
    agentOutput: Writable.toWeb(child.stdin),
    trace: options.trace,
  });

  let stopping: Promise<void> | undefined;
  const shutdown = () => stopping ??= (async () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (!child.killed) child.kill("SIGTERM");
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        done();
      }, 2000);
      timer.unref?.();
      child.once("exit", () => { clearTimeout(timer); done(); });
    });
  })();

  return { closed: bridge.closed.finally(shutdown), shutdown };
}
