import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ClientFileSystem } from "../src/client-filesystem.js";
import { decodePrompt } from "../src/content.js";
import { replayHistory } from "../src/history.js";
import { isLiveConfiguration, setLegacyMode, setSessionOption } from "../src/session-options.js";
import type { BridgeSession } from "../src/sessions.js";

test("all resource links remain references, including remote and missing local images", () => {
  const result = decodePrompt([
    { type: "resource_link", name: "remote.png", mimeType: "image/png", uri: "https://example.com/remote.png" },
    { type: "resource_link", name: "missing.png", mimeType: "image/png", uri: "file:///nonexistent/image.png" },
  ]);
  assert.equal(result.images.length, 0);
  assert.match(result.text, /https:\/\/example.com\/remote.png/);
  assert.match(result.text, /file:\/\/\/nonexistent\/image.png/);
});

test("advertised embedded context handles both text and blob resource variants", () => {
  const result = decodePrompt([
    { type: "resource", resource: { uri: "memory:text", text: "unsaved editor content" } },
    { type: "resource", resource: { uri: "memory:image", mimeType: "image/png", blob: "aGVsbG8=" } },
    { type: "resource", resource: { uri: "memory:binary", mimeType: "application/octet-stream", blob: "AAE=" } },
  ]);
  assert.equal(result.images.length, 1);
  assert.match(result.text, /unsaved editor content/);
  assert.match(result.text, /encoding="base64">\nAAE=/);
});

test("editor filesystem maps standard missing-resource codes independently of error wording", async () => {
  const files = new ClientFileSystem("/virtual-workspace", "/profile", {
    async readTextFile() { throw new RequestError(-32002, "Gone"); },
    async writeTextFile() { return {}; },
  }, { readTextFile: true, writeTextFile: true });
  files.bindSession("session");
  let read!: ToolDefinition;
  const extension = files.extensions()[0];
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({
    registerTool(tool: ToolDefinition) { if (tool.name === "read") read = tool; },
    getSettings() { return {}; },
  } as unknown as ExtensionAPI);
  await assert.rejects(read.execute("read", { path: "/virtual-workspace/missing.txt" }, undefined, undefined,
    { cwd: "/virtual-workspace" } as Parameters<ToolDefinition["execute"]>[4]),
  error => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("mode and config setters reject unadvertised legacy selector aliases", async () => {
  let mode: string | undefined;
  const session = { model: { reasoning: true }, getAvailableThinkingLevels: () => ["off"],
    bridgeApproval: { setMode(value: string) { mode = value; } },
  } as unknown as BridgeSession;
  const invalid = (error: unknown) => (error as { code: number }).code === -32602;
  assert.throws(() => setLegacyMode(session, "off"), invalid);
  await assert.rejects(setSessionOption(session, "mode", "off"), invalid);
  setLegacyMode(session, "ask");
  assert.equal(mode, "ask");
  assert.equal(isLiveConfiguration("approval"), true);
});

test("history replay retains user, tool and direct shell conversation entries", () => {
  const session = { messages: [
    { role: "user", content: [{ type: "text", text: "Run the check", textSignature: "provider-private" }], timestamp: 1 },
    { role: "bashExecution", command: "check", output: "passed", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 },
    { role: "custom", customType: "hidden", content: "private state", display: false, timestamp: 3 },
  ] } as BridgeSession;
  const updates = [...replayHistory(session)];
  assert.deepEqual(updates.map(update => update.sessionUpdate), ["user_message_chunk", "tool_call", "tool_call_update"]);
  assert.ok(updates[2].sessionUpdate === "tool_call_update" && updates[2].status === "completed");
  assert.ok(updates[0].sessionUpdate === "user_message_chunk");
  assert.deepEqual(updates[0].content, { type: "text", text: "Run the check" });
});
