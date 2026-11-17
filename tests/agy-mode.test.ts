import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildAgySystemPromptAppend,
  injectAgySystemPromptMeta,
  resolveAgyExecutable,
  startAgyBridge,
  startAgyProcessBridge,
} from "../src/agy-mode.js";

function createLinePipe() {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const encoder = new TextEncoder();
  return {
    readable: transform.readable,
    writable: transform.writable,
    async send(msg: unknown) {
      await writer.write(encoder.encode(`${JSON.stringify(msg)}\n`));
    },
    async close() {
      await writer.close();
    },
  };
}

function collectJsonLines(stream: ReadableStream<Uint8Array>) {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let eof = false;
  const notify = () => { while (waiters.length) waiters.shift()!(); };
  const done = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            messages.push(JSON.parse(line) as Record<string, unknown>);
            notify();
          }
          idx = buffer.indexOf("\n");
        }
      }
    } finally {
      eof = true;
      notify();
      reader.releaseLock();
    }
  })();
  return {
    messages,
    done,
    isEof: () => eof,
    async nextWhere(predicate: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (eof) throw new Error("Stream ended before expected message arrived");
        await new Promise<void>(r => waiters.push(r));
      }
    },
  };
}

test("buildAgySystemPromptAppend and injectAgySystemPromptMeta merge existing append", () => {
  const append = buildAgySystemPromptAppend({
    agentsFiles: [{ path: "/Users/test/AGENTS.md", content: "Global rules" }],
    appendSystemPrompt: ["Extra rule"],
  });
  assert.match(append, /<project_instructions path="\/Users\/test\/AGENTS\.md">/);
  assert.match(append, /<addendum>\nExtra rule\n<\/addendum>/);

  const injected = injectAgySystemPromptMeta({ cwd: "/Users/test/proj", _meta: { antigravity: { systemPrompt: { append: "Base" } } } }, append);
  const sysAppend = ((injected._meta as Record<string, unknown>).antigravity as Record<string, unknown>).systemPrompt as { append: string };
  assert.match(sysAppend.append, /^Base\n\n<project_context>/);
});

test("startAgyBridge injects AGENTS.md, filters live user_message_chunk while allowing replay, and propagates EOF", async () => {
  const clientToBridge = createLinePipe();
  const bridgeToClientStream = new TransformStream<Uint8Array, Uint8Array>();
  const agentToBridge = createLinePipe();
  const bridgeToAgentStream = new TransformStream<Uint8Array, Uint8Array>();

  const clientInbox = collectJsonLines(bridgeToClientStream.readable);
  const agentInbox = collectJsonLines(bridgeToAgentStream.readable);

  const bridge = startAgyBridge({
    clientInput: clientToBridge.readable,
    clientOutput: bridgeToClientStream.writable,
    agentInput: agentToBridge.readable,
    agentOutput: bridgeToAgentStream.writable,
    loadSystemPromptAppend: async () => "<project_context>rules</project_context>",
  });

  // 1. session/new injects systemPrompt.append.
  await clientToBridge.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/Users/test/proj", mcpServers: [] } });
  const newReq = await agentInbox.nextWhere(m => m.id === 1);
  assert.equal(
    ((newReq.params as { _meta: { antigravity: { systemPrompt: { append: string } } } })._meta.antigravity.systemPrompt.append),
    "<project_context>rules</project_context>",
  );
  await agentToBridge.send({ jsonrpc: "2.0", id: 1, result: { sessionId: "sess-1" } });
  await clientInbox.nextWhere(m => m.id === 1);

  // 2. Live prompt suppresses echoed user_message_chunk while passing agent_message_chunk.
  await clientToBridge.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "sess-1", prompt: [{ type: "text", text: "hi" }] } });
  await agentInbox.nextWhere(m => m.id === 2);
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echoed" } } },
  });
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply" } } },
  });
  await agentToBridge.send({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  await clientInbox.nextWhere(m => m.id === 2);
  assert.equal(
    clientInbox.messages.some(m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "user_message_chunk"),
    false,
  );

  // 3. session/resume (even without cwd) forwards replayed user_message_chunk, and colliding agent request id does not clear replay state.
  await clientToBridge.send({ jsonrpc: "2.0", id: 3, method: "session/resume", params: { sessionId: "sess-1" } });
  await agentInbox.nextWhere(m => m.id === 3);
  await agentToBridge.send({
    jsonrpc: "2.0",
    id: 3,
    method: "fs/read_text_file",
    params: { sessionId: "sess-1", path: "/tmp/a.txt" },
  });
  await clientInbox.nextWhere(m => m.id === 3 && m.method === "fs/read_text_file");
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed" } } },
  });
  await agentToBridge.send({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "load failed" } });
  await clientInbox.nextWhere(m => m.id === 3 && "error" in m);
  assert.equal(
    clientInbox.messages.filter(m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "user_message_chunk").length,
    1,
  );

  // After failed/finished session/resume, user_message_chunk is suppressed again.
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "after" } } },
  });
  await agentToBridge.send({ jsonrpc: "2.0", id: 4, result: {} });
  await clientInbox.nextWhere(m => m.id === 4);
  assert.equal(
    clientInbox.messages.filter(m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "user_message_chunk").length,
    1,
  );

  // 4. Closing clientInput propagates EOF to agentOutput cleanly.
  await clientToBridge.close();
  await agentInbox.done;
  assert.equal(agentInbox.isEof(), true);
  await agentToBridge.close();
  await bridge.closed;
});

test("resolveAgyExecutable ignores executable directories named agy", async t => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agy-bin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirA = join(root, "a");
  const dirB = join(root, "b");
  await mkdir(join(dirA, "agy"), { recursive: true });
  await chmod(join(dirA, "agy"), 0o755);
  await mkdir(dirB, { recursive: true });
  const bin = join(dirB, "agy");
  await writeFile(bin, "#!/bin/sh\n", "utf8");
  await chmod(bin, 0o755);
  assert.equal(resolveAgyExecutable(undefined, [dirA, dirB]), bin);
});

test("startAgyProcessBridge handles missing executable without uncaught crash", async () => {
  const clientToBridge = createLinePipe();
  const bridgeToClientStream = new TransformStream<Uint8Array, Uint8Array>();
  const events: string[] = [];

  const proc = startAgyProcessBridge({
    input: clientToBridge.readable,
    output: bridgeToClientStream.writable,
    command: "/nonexistent/agy-binary-for-test",
    trace: (ev) => { events.push(String(ev.event)); },
  });

  await proc.closed;
  assert.ok(events.includes("agy_spawn_error"));
});
