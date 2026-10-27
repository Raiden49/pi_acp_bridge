import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createCodemodeExtension, createWriteToolDefinition, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { assistantStream, createBareSession, createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

async function fixture(tool = "write") {
  const nested = tool === "codemode";
  let toolResult = "";
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/approvals-"));
  const runtime = await createTestRuntime(resolve(root, "models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "fixture-key");
  const target = resolve(root, "mutation.txt");
  const client = protocolHarness(resolve(root, "models.json"), { sessionIndexPath: resolve(root, "index.json"), sessionDir: resolve(root, "sessions"),
    async createSession(cwd, file, _servers, id, _fs, approval) {
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [...(nested ? [createCodemodeExtension()] : []), ...(tool === "custom_mutator" ? [(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => {
          pi.registerTool({ ...createWriteToolDefinition(cwd), name: "custom_mutator" });
        }] : []), ...(approval?.extensions() ?? [])] });
      const session = await createBareSession({ cwd, agentDir: root, modelRuntime: runtime, model, settingsManager, resourceLoader,
        sessionManager: file ? SessionManager.open(file) : SessionManager.create(cwd, resolve(root, "sessions"), id ? { id } : undefined), tools: nested ? ["codemode", "write"] : [tool] });
      session.agent.streamFunction = (_model, context) => {
        toolResult = JSON.stringify(context.messages.at(-1));
        return assistantStream(model, context.messages.at(-1)?.role === "user"
          ? [{ type: "toolCall", id: "mutation", name: tool, arguments: nested
            ? { code: `return await tools.write({path:${JSON.stringify(target)},content:"changed"});` }
            : tool === "bash" ? { command: `printf changed > '${target}'` } : { path: target, content: "changed" } }]
          : [{ type: "text", text: "finished" }]);
      };
      return session;
    },
  });
  const created = await client.request("session/new", { cwd: root, mcpServers: [] });
  const { sessionId } = created.result;
  expect(created.result.configOptions).toContainEqual(expect.objectContaining({ id: "approval", currentValue: "direct" }));
  expect(created.result.modes.availableModes.map((mode: { id: string }) => mode.id)).toEqual(["direct", "ask", "plan"]);
  return { client, root, target, sessionId, toolResult: () => toolResult, async cleanup() { await client.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const [mode, decision, written, tool] of [["direct", undefined, true, "write"], ["ask", "allow", true, "write"], ["ask", "reject", false, "write"],
  ["ask", "unsupported", false, "write"], ["ask", "reject", false, "codemode"], ["plan", undefined, false, "write"]] as const) {
  test(`${mode}/${decision ?? "no dialog"} controls SDK ${tool}`, async () => {
    const f = await fixture(tool);
    try {
      if (mode === "plan") expect(await f.client.request("session/set_mode", { sessionId: f.sessionId, modeId: mode })).toHaveProperty("result");
      else if (mode !== "direct") expect(await f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "approval", value: mode })).toHaveProperty("result");
      if (mode === "plan") {
        await f.client.request("session/close", { sessionId: f.sessionId });
        const pending = await f.client.request("session/load", { sessionId: f.sessionId, cwd: f.root, mcpServers: [] });
        expect(pending.result.configOptions).toContainEqual(expect.objectContaining({ id: "approval", currentValue: "plan" }));
        expect(pending.result.modes.currentModeId).toBe("plan");
      }
      const response = f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "make a change" }] });
      if (decision) {
        let request;
        const published = new Set<string>();
        do {
          request = await f.client.nextNotification();
          if (request.params.update?.sessionUpdate === "tool_call") published.add(request.params.update.toolCallId);
        } while (request.method !== "session/request_permission");
        expect(published.has(request.params.toolCall.toolCallId)).toBe(true);
        if (decision === "unsupported") f.client.respondError(request.id!, { code: -32601, message: "Approval UI unavailable" });
        else f.client.respond(request.id!, { outcome: { outcome: "selected", optionId: decision } });
      }
      expect(await response).toHaveProperty("result");
      expect(await access(f.target).then(() => true, () => false)).toBe(written);
      if (mode === "plan") {
        await f.client.request("session/close", { sessionId: f.sessionId });
        const loaded = await f.client.request("session/load", { sessionId: f.sessionId, cwd: f.root, mcpServers: [] });
        expect(loaded.result.configOptions).toContainEqual(expect.objectContaining({ id: "approval", currentValue: "plan" }));
        const forked = await f.client.request("session/fork", { sessionId: f.sessionId, cwd: f.root, mcpServers: [] });
        expect(forked.result.configOptions).toContainEqual(expect.objectContaining({ id: "approval", currentValue: "plan" }));
      }
    } finally { await f.cleanup(); }
  });
}

test.each(["codemode", "bash", "custom_mutator"])("Plan blocks %s mutations through the native SDK hook", async (tool) => {
  const f = await fixture(tool);
  try {
    await f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "approval", value: "plan" });
    expect(await f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "nested change" }] })).toHaveProperty("result");
    expect(await access(f.target).then(() => true, () => false)).toBe(false);
    expect(f.toolResult()).toContain(`Plan mode blocks ${tool === "codemode" ? "write" : tool}`);
  } finally { await f.cleanup(); }
});

test("cancellation settles without approval; a late allow cannot write or grant future permission", async () => {
  const f = await fixture();
  try {
    await f.client.request("session/set_config_option", { sessionId: f.sessionId, configId: "approval", value: "ask" });
    const prompt = f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "first change" }] });
    let approval;
    do { approval = await f.client.nextNotification(); } while (approval.method !== "session/request_permission");
    f.client.notify("session/cancel", { sessionId: f.sessionId });
    expect(await prompt).toMatchObject({ result: { stopReason: "cancelled" } });
    f.client.respond(approval.id!, { outcome: { outcome: "selected", optionId: "allow" } });
    const next = f.client.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "second change" }] });
    do { approval = await f.client.nextNotification(); } while (approval.method !== "session/request_permission");
    f.client.respond(approval.id!, { outcome: { outcome: "selected", optionId: "reject" } });
    await next;
    expect(await access(f.target).then(() => true, () => false)).toBe(false);
  } finally { await f.cleanup(); }
});
