import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RequestError, type Agent, type AgentSideConnection, type SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { guardInitialization } from "../src/protocol-guard.js";
import { createSessionLifecycle } from "../src/session-lifecycle.js";
import { createTurnRunner } from "../src/turn-runner.js";
import { ApprovalGate } from "../src/approvals.js";
import type { BridgeSession } from "../src/sessions.js";

const errorCode = (code: number) => (error: unknown) => error instanceof RequestError && error.code === code;

test("initialization gates requests until completion and prevents capability renegotiation", async () => {
  let complete!: () => void;
  const initializing = new Promise<void>(resolve => { complete = resolve; });
  const agent = guardInitialization({
    async initialize() { await initializing; return { protocolVersion: 1 }; },
    async listSessions() { return { sessions: [] }; },
  } as unknown as Agent);
  await assert.rejects(Promise.resolve().then(() => agent.listSessions!({})), errorCode(-32600));
  const pending = agent.initialize({ protocolVersion: 1 });
  await assert.rejects(Promise.resolve().then(() => agent.listSessions!({})), errorCode(-32600));
  complete();
  assert.equal((await pending).protocolVersion, 1);
  assert.deepEqual(await agent.listSessions!({}), { sessions: [] });
  await assert.rejects(Promise.resolve().then(() => agent.initialize({ protocolVersion: 1 })), errorCode(-32600));
});

test("unknown session errors, idempotent close/delete and close-time cancellation follow ACP", async t => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/acp-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const updates: SessionNotification[] = [];
  let published!: () => void;
  const toolPublished = new Promise<void>(resolve => { published = resolve; });
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let abort!: () => void;
  let disposed = false;
  const session = {
    subscribe(listener: (event: AgentSessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    getContextUsage() { return undefined; },
    async prompt() {
      const pending = new Promise<void>(resolve => { abort = resolve; });
      for (const listener of listeners) listener({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "true" } });
      await pending;
    },
    async abort() { abort?.(); },
    dispose() { disposed = true; },
  } as unknown as BridgeSession;
  const client = { async sessionUpdate(update: SessionNotification) {
    updates.push(update);
    if (update.update.sessionUpdate === "tool_call") published();
  } } as AgentSideConnection;
  const approval = new ApprovalGate(client);
  approval.installed = true;
  session.bridgeApproval = approval;
  const lifecycle = createSessionLifecycle({ client, trace() {}, artifactDir: root, sessionIndexPath: join(root, "index.json"), sessionDir: root,
    async createSession() { return session; } });
  t.after(() => lifecycle.shutdown());
  const { methods, host, configuration, index } = lifecycle;
  const prompt = createTurnRunner({ ...host, configuration, index, artifactDir: root });
  await assert.rejects(async () => methods.loadSession!({ sessionId: "missing", cwd: root, mcpServers: [] }), (error: unknown) =>
    errorCode(-32002)(error) && ((error as RequestError).data as { sessionId?: string })?.sessionId === "missing");
  await assert.rejects(configuration.setSessionConfigOption({ sessionId: "missing", configId: "model", value: "none" }), errorCode(-32002));
  await index.set("stale", { cwd: root, sessionFile: join(root, "missing.jsonl"), nativeId: "stale" });
  await assert.rejects(async () => methods.loadSession!({ sessionId: "stale", cwd: root, mcpServers: [] }), errorCode(-32002));
  await assert.rejects(async () => methods.unstable_forkSession!({ sessionId: "stale", cwd: root }), errorCode(-32002));
  assert.deepEqual(await methods.closeSession!({ sessionId: "missing" }), {});
  assert.deepEqual(await methods.deleteSession!({ sessionId: "missing" }), {});
  const created = await methods.newSession({ cwd: root, mcpServers: [] });
  const turn = prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
  await toolPublished;
  await assert.rejects(prompt({ sessionId: created.sessionId, prompt: [] }), errorCode(-32900));
  const configured = await configuration.setSessionConfigOption({ sessionId: created.sessionId, configId: "approval", value: "ask" });
  assert.ok(configured.configOptions.some(option => option.id === "approval" && option.currentValue === "ask"));
  assert.deepEqual(await methods.closeSession!({ sessionId: created.sessionId }), {});
  assert.deepEqual(await turn, { stopReason: "cancelled" });
  assert.equal(disposed, true);
  assert.ok(updates.some(({ update }) => update.sessionUpdate === "tool_call_update" && update.status === "failed"));
  assert.deepEqual(await methods.closeSession!({ sessionId: created.sessionId }), {});
  await assert.rejects(prompt({ sessionId: created.sessionId, prompt: [] }), errorCode(-32002));
});
