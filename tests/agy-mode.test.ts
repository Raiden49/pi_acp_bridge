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

test("startAgyBridge translates invoke_subagent, send_message, and manage_subagents into Air subagent protocol updates", async () => {
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
    loadSystemPromptAppend: async () => "",
  });

  await clientToBridge.send({ jsonrpc: "2.0", id: 10, method: "session/prompt", params: { sessionId: "sess-sub", prompt: [{ type: "text", text: "review" }] } });
  await agentInbox.nextWhere(m => m.id === 10);

  // 1. Agent invokes a subagent tool call
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess-sub",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-sub-1",
        title: "invoke_subagent",
        kind: "other",
        status: "in_progress",
        rawInput: {
          TypeName: "research",
          Role: "Standards Reviewer",
          Prompt: "Check coding standards",
        },
      },
    },
  });

  const spawnedMsg = await clientInbox.nextWhere(
    m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "subagent_spawned",
  );
  const spawnedUpdate = (spawnedMsg.params as { update: Record<string, unknown> }).update;
  assert.equal(spawnedUpdate.subagentSessionId, "subagent:tc-sub-1");
  assert.equal(spawnedUpdate.name, "Standards Reviewer");
  assert.equal(spawnedUpdate.description, "Standards Reviewer (research)");
  assert.equal(spawnedUpdate.prompt, "Check coding standards");
  assert.deepEqual(spawnedUpdate.capabilities, { cancel: false, close: false });

  // Verify tool_call has _meta.jetbrains.air.subagent = true
  const toolCallMsg = clientInbox.messages.find(
    m => (m.params as { update?: { sessionUpdate?: string; toolCallId?: string } } | undefined)?.update?.toolCallId === "tc-sub-1",
  )!;
  const toolCallMeta = ((toolCallMsg.params as { update: { _meta: { jetbrains: { air: Record<string, unknown> } } } }).update._meta.jetbrains.air);
  assert.equal(toolCallMeta.subagent, true);
  assert.equal(toolCallMeta.commandTitle, "Standards Reviewer");

  // 2. Subagent tool_call_update returns async conversationId
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess-sub",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-sub-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: 'Created the following subagent:\n{\n  "conversationId": "conv-uuid-1234"\n}',
            },
          },
        ],
      },
    },
  });

  // 3. send_message to conv-uuid-1234 routes thought chunk to subagent:tc-sub-1
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess-sub",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-msg-1",
        title: "send_message",
        kind: "other",
        status: "in_progress",
        rawInput: {
          Recipient: "conv-uuid-1234",
          Message: "Also check tests",
        },
      },
    },
  });

  const routedMsg = await clientInbox.nextWhere(
    m => {
      const u = (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update;
      return u?.sessionUpdate === "agent_thought_chunk" && Boolean(u.content?.text?.includes("Also check tests"));
    },
  );
  const routedAirMeta = ((routedMsg.params as { update: { _meta: { jetbrains: { air: Record<string, unknown> } } } }).update._meta.jetbrains.air);
  assert.equal(routedAirMeta.subagentSessionId, "subagent:tc-sub-1");

  // 4. Prompt turn finishes -> open async subagent receives subagent_state_update = completed
  await agentToBridge.send({ jsonrpc: "2.0", id: 10, result: { stopReason: "end_turn" } });
  await clientInbox.nextWhere(m => m.id === 10);

  const stateMsg = clientInbox.messages.find(
    m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "subagent_state_update",
  );
  assert.ok(stateMsg);
  assert.deepEqual((stateMsg.params as { update: Record<string, unknown> }).update, {
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "subagent:tc-sub-1",
    state: "completed",
  });

  await clientToBridge.close();
  await agentToBridge.close();
  await bridge.closed;
});

test("startAgyBridge holds premature end_turn while agy background subagent runs, streams child transcript steps, and flushes parent synthesis", async t => {
  await mkdir(".scratch", { recursive: true });
  const brainDir = await mkdtemp(resolve(".scratch/agy-brain-"));
  t.after(() => rm(brainDir, { recursive: true, force: true }));

  const parentId = "e820837f-d7ff-472f-b0ac-31b91d3e82d8";
  const childId = "5263f155-4bf2-4b5f-8c31-72d8bd5bcfbc";
  const parentLogDir = join(brainDir, parentId, ".system_generated", "logs");
  const childLogDir = join(brainDir, childId, ".system_generated", "logs");
  await mkdir(parentLogDir, { recursive: true });
  await mkdir(childLogDir, { recursive: true });

  const parentTranscript = join(parentLogDir, "transcript.jsonl");
  const childTranscript = join(childLogDir, "transcript.jsonl");

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
    loadSystemPromptAppend: async () => "",
    brainBaseDir: brainDir,
    pollIntervalMs: 25,
  });

  await clientToBridge.send({
    jsonrpc: "2.0",
    id: 20,
    method: "session/prompt",
    params: { sessionId: parentId, prompt: [{ type: "text", text: "run subagent" }] },
  });
  await agentInbox.nextWhere(m => m.id === 20);

  const parentInitialSteps = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "run subagent" },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [{ name: "invoke_subagent", args: { Role: '"Repo Researcher"', TypeName: '"research"', Prompt: '"Inspect repo"' } }],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: `Created the following subagent:\n{\n  "conversationId": "${childId}",\n  "logAbsoluteUri": "file://${childTranscript}"\n}`,
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "Waiting for subagent...",
    },
  ];
  await writeFile(parentTranscript, `${parentInitialSteps.map(s => JSON.stringify(s)).join("\n")}\n`, "utf8");

  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: parentId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Run invoke_subagent",
        kind: "other",
        status: "in_progress",
        rawInput: {
          Role: "Repo Researcher",
          TypeName: "research",
          Prompt: "Inspect repo",
        },
      },
    },
  });
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: parentId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        title: "Run invoke_subagent",
        kind: "other",
        status: "completed",
        rawInput: {
          Role: "Repo Researcher",
          TypeName: "research",
          Prompt: "Inspect repo",
        },
      },
    },
  });

  await clientInbox.nextWhere(
    m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "subagent_spawned",
  );
  assert.equal(
    clientInbox.messages.some(
      m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "subagent_state_update",
    ),
    false,
  );

  await agentToBridge.send({ jsonrpc: "2.0", id: 20, result: { stopReason: "end_turn" } });

  await new Promise(r => setTimeout(r, 60));
  assert.equal(clientInbox.messages.some(m => m.id === 20), false);

  const childSteps = [
    { step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: "Inspect repo" },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      thinking: "Reading README.md first.",
      tool_calls: [{ name: "read_file", args: { Path: '"/repo/README.md"' } }],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: "Created At: 2026-11-17T23:25:10+08:00\nCompleted At: 2026-11-17T23:25:10+08:00\n# Air Repo",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [{ name: "send_message", args: { Recipient: `"${parentId}"`, Message: '"Repo summary: Air workbench."' } }],
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: "Message sent.",
    },
    {
      step_index: 5,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "Summary sent to parent agent.",
    },
  ];
  await writeFile(childTranscript, `${childSteps.map(s => JSON.stringify(s)).join("\n")}\n`, "utf8");

  const childToolMsg = await clientInbox.nextWhere(
    m => {
      const u = (m.params as { update?: { sessionUpdate?: string; title?: string } } | undefined)?.update;
      return u?.sessionUpdate === "tool_call" && u.title === "Read repo/README.md";
    },
  );
  assert.equal(
    ((childToolMsg.params as { update: { _meta: { jetbrains: { air: { subagentSessionId: string } } } } }).update._meta.jetbrains.air.subagentSessionId),
    "subagent:call_1",
  );

  const parentFinalSteps = [
    ...parentInitialSteps,
    {
      step_index: 4,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      content: `<SYSTEM_MESSAGE>\n[Message] sender=${childId} content=Repo summary: Air workbench.\n</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 5,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      thinking: "Synthesizing subagent findings.",
      content: "Subagent finished: Air workbench summary.",
    },
  ];
  await writeFile(parentTranscript, `${parentFinalSteps.map(s => JSON.stringify(s)).join("\n")}\n`, "utf8");

  await clientInbox.nextWhere(m => m.id === 20);

  const subStateMsg = clientInbox.messages.find(
    m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "subagent_state_update",
  );
  assert.ok(subStateMsg);
  assert.deepEqual((subStateMsg.params as { update: Record<string, unknown> }).update, {
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "subagent:call_1",
    state: "completed",
  });

  const parentSynthMsg = clientInbox.messages.find(
    m => {
      const u = (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update;
      return u?.sessionUpdate === "agent_message_chunk" && Boolean(u.content?.text?.includes("Subagent finished: Air workbench summary."));
    },
  );
  assert.ok(parentSynthMsg);
  assert.equal(
    ((parentSynthMsg.params as { update: { content: { text: string } } }).update.content.text),
    "\n\nSubagent finished: Air workbench summary.\n",
  );

  // Verify chunked duplicate PendingText flushed by agy at the start of the next prompt turn is suppressed
  const countBefore = clientInbox.messages.filter(
    m => {
      const u = (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update;
      return u?.sessionUpdate === "agent_message_chunk" && Boolean(u.content?.text?.includes("Subagent finished:"));
    },
  ).length;
  await clientToBridge.send({
    jsonrpc: "2.0",
    id: 21,
    method: "session/prompt",
    params: { sessionId: parentId, prompt: [{ type: "text", text: "next question" }] },
  });
  await agentInbox.nextWhere(m => m.id === 21);
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: parentId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Subagent finished: " },
      },
    },
  });
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: parentId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Air workbench summary." },
      },
    },
  });
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: parentId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Fresh answer after replay." },
      },
    },
  });
  await agentToBridge.send({ jsonrpc: "2.0", id: 21, result: { stopReason: "end_turn" } });
  await clientInbox.nextWhere(m => m.id === 21);
  const countAfter = clientInbox.messages.filter(
    m => {
      const u = (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update;
      return u?.sessionUpdate === "agent_message_chunk" && Boolean(u.content?.text?.includes("Subagent finished:"));
    },
  ).length;
  assert.equal(countAfter, countBefore);
  assert.ok(clientInbox.messages.some(
    m => (m.params as { update?: { content?: { text?: string } } } | undefined)?.update?.content?.text === "Fresh answer after replay.",
  ));

  await clientToBridge.close();
  await agentToBridge.close();
  await bridge.closed;
});

test("startAgyBridge flushes parent wakeup synthesis written before end_turn and settles silent child completion", async t => {
  await mkdir(".scratch", { recursive: true });
  const brainDir = await mkdtemp(resolve(".scratch/agy-brain-race-"));
  t.after(() => rm(brainDir, { recursive: true, force: true }));

  const parentId = "aaaaaaaa-1111-2222-3333-444444444444";
  const childId = "bbbbbbbb-1111-2222-3333-444444444444";
  await mkdir(join(brainDir, parentId, ".system_generated", "logs"), { recursive: true });
  await mkdir(join(brainDir, childId, ".system_generated", "logs"), { recursive: true });
  const parentTranscript = join(brainDir, parentId, ".system_generated", "logs", "transcript.jsonl");
  const childTranscript = join(brainDir, childId, ".system_generated", "logs", "transcript.jsonl");

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
    loadSystemPromptAppend: async () => "",
    brainBaseDir: brainDir,
    pollIntervalMs: 15,
  });

  await clientToBridge.send({
    jsonrpc: "2.0",
    id: 30,
    method: "session/prompt",
    params: { sessionId: parentId, prompt: [{ type: "text", text: "go" }] },
  });
  await agentInbox.nextWhere(m => m.id === 30);

  // Parent transcript already includes SYSTEM_MESSAGE + post-wakeup synthesis BEFORE end_turn arrives.
  const parentSteps = [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "go" },
    {
      step_index: 1,
      type: "GENERIC",
      status: "DONE",
      content: `Created the following subagent:\n{\n  "conversationId": "${childId}"\n}`,
    },
    { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "Spawned child." },
    { step_index: 3, type: "SYSTEM_MESSAGE", status: "DONE", content: `sender=${childId}` },
    { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "Early synthesis result." },
  ];
  await writeFile(parentTranscript, `${parentSteps.map(s => JSON.stringify(s)).join("\n")}\n`, "utf8");

  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: parentId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_race",
        title: "invoke_subagent",
        kind: "other",
        status: "in_progress",
        rawInput: { Role: "Fast Worker", TypeName: "research", Prompt: "check" },
      },
    },
  });
  await clientInbox.nextWhere(
    m => (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "subagent_spawned",
  );
  await agentToBridge.send({ jsonrpc: "2.0", id: 30, result: { stopReason: "end_turn" } });
  await clientInbox.nextWhere(m => m.id === 30);

  assert.ok(
    clientInbox.messages.some(m => {
      const u = (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update;
      return u?.sessionUpdate === "agent_message_chunk" && Boolean(u.content?.text?.includes("Early synthesis result."));
    }),
    "Post-wakeup parent synthesis written before end_turn must still be flushed",
  );

  // Silent child finish without send_message must settle after grace polls instead of hanging forever.
  const silentChildId = "cccccccc-1111-2222-3333-444444444444";
  await mkdir(join(brainDir, silentChildId, ".system_generated", "logs"), { recursive: true });
  const silentChildTranscript = join(brainDir, silentChildId, ".system_generated", "logs", "transcript.jsonl");
  await clientToBridge.send({
    jsonrpc: "2.0",
    id: 31,
    method: "session/prompt",
    params: { sessionId: parentId, prompt: [{ type: "text", text: "silent" }] },
  });
  await agentInbox.nextWhere(m => m.id === 31);
  await writeFile(
    parentTranscript,
    `${[...parentSteps, { step_index: 5, type: "GENERIC", status: "DONE", content: `Created the following subagent:\n{\n  "conversationId": "${silentChildId}"\n}` }].map(s => JSON.stringify(s)).join("\n")}\n`,
    "utf8",
  );
  await agentToBridge.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: parentId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_silent",
        title: "invoke_subagent",
        kind: "other",
        status: "in_progress",
        rawInput: { Role: "Silent Worker", TypeName: "research", Prompt: "quiet" },
      },
    },
  });
  await clientInbox.nextWhere(
    m => (m.params as { update?: { subagentSessionId?: string; sessionUpdate?: string } } | undefined)?.update?.subagentSessionId === "subagent:call_silent",
  );
  await writeFile(
    silentChildTranscript,
    `${JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "Done without send_message." })}\n`,
    "utf8",
  );
  await agentToBridge.send({ jsonrpc: "2.0", id: 31, result: { stopReason: "end_turn" } });
  await clientInbox.nextWhere(m => m.id === 31);

  assert.ok(
    clientInbox.messages.some(m => {
      const u = (m.params as { update?: { sessionUpdate?: string; subagentSessionId?: string; state?: string } } | undefined)?.update;
      return u?.sessionUpdate === "subagent_state_update" && u.subagentSessionId === "subagent:call_silent" && u.state === "completed";
    }),
  );

  await clientToBridge.close();
  await agentToBridge.close();
  await bridge.closed;
});
