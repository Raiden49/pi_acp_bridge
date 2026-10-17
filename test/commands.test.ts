import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { createTestRuntime } from "./fixtures.js";

test("/session reports session state without sending a model prompt", async () => {
  const prompt = vi.fn(async () => { throw new Error("Model must not be called"); });
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    prompt, subscribe: () => () => {}, abort: async () => {}, dispose() {},
    getSessionStats: () => ({ sessionId: "pi-session", sessionFile: "/workspace/history.jsonl", userMessages: 4,
      assistantMessages: 4, toolCalls: 2, toolResults: 2, totalMessages: 10,
      tokens: { input: 500, output: 100, cacheRead: 20, cacheWrite: 0, total: 620 }, cost: 0.01 }),
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/session" }] }))
      .toMatchObject({ result: { stopReason: "end_turn" } });
    const { update } = (await client.nextNotification()).params;
    expect(update.content.text).toContain("pi-session");
    expect(update.content.text).toContain("620");
    for (const blocks of [
      [{ type: "text", text: "/session unexpected" }],
      [{ type: "text", text: "/reload" }, { type: "resource", resource: { uri: "file:///context.txt", text: "Context" } }],
    ]) expect(await client.request("session/prompt", { sessionId, prompt: blocks })).toMatchObject({ error: { code: -32602 } });
    expect(prompt).not.toHaveBeenCalled();
  } finally { await client.close(); }
});

test("closing during reload waits for replacement resources before disposing them", async () => {
  let finishReload!: () => void;
  let abortStarted!: () => void;
  const reloading = new Promise<void>((resolve) => { finishReload = resolve; });
  const aborting = new Promise<void>((resolve) => { abortStarted = resolve; });
  let resourceOpen = false;
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    prompt: async () => {}, subscribe: () => () => {}, abort: async () => { abortStarted(); },
    reload: async () => { await reloading; resourceOpen = true; }, dispose: () => { resourceOpen = false; },
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    const prompt = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/reload" }] });
    await client.nextNotification();
    const closing = client.request("session/close", { sessionId });
    await aborting;
    // Let close settle if it incorrectly disposes before reload completes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishReload();
    expect(await prompt).toMatchObject({ result: { stopReason: "cancelled" } });
    await closing;
    expect(resourceOpen).toBe(false);
  } finally { finishReload(); await client.close(); }
});

test.each([true, false])("advertises loaded prompt templates, extensions and enabled skills: %s", async (enableSkillCommands) => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/commands-"));
  const agentDir = resolve(cwd, "agent");
  await mkdir(resolve(agentDir, "skills/review"), { recursive: true });
  await mkdir(resolve(agentDir, "prompts"));
  await writeFile(resolve(agentDir, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nCheck code.");
  await writeFile(resolve(agentDir, "prompts/explain.md"), "---\ndescription: Explain code\n---\nExplain $@");
  const settingsManager = SettingsManager.inMemory({ enableSkillCommands });
  const runtime = await createTestRuntime(resolve(agentDir, "models.json"));
  const client = protocolHarness(resolve(agentDir, "models.json"), { async createSession() {
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalSkillPaths: [resolve(agentDir, "skills")], additionalPromptTemplatePaths: [resolve(agentDir, "prompts")],
      extensionFactories: [(pi) => {
        pi.registerCommand("hello", { description: "Say hello", handler: async (_args, ctx) => { ctx.ui.notify(ctx.ui.theme.fg("accent", "Hello from extension")); } });
        pi.registerCommand("confirm", { handler: async (_args, ctx) => {
          const answer = await ctx.ui.confirm("Confirm", "Proceed?");
          ctx.ui.notify(`Confirmed: ${answer}`);
        } });
      }],
    });
    await resourceLoader.reload();
    return (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(cwd), noTools: "all",
    })).session;
  } });
  try {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
    const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    const notification = await client.nextNotification();
    expect(notification.params).toMatchObject({ sessionId, update: { sessionUpdate: "available_commands_update" } });
    const commands = notification.params.update.availableCommands;
    expect(commands).toEqual(expect.arrayContaining([
      { name: "explain", description: "Explain code" }, { name: "hello", description: "Say hello" },
    ]));
    expect(commands.map((command: { name: string }) => command.name).sort()).toEqual(
      ["session", "reload", "compact", "name", "hello", "confirm", "explain", ...(enableSkillCommands ? ["skill:review"] : [])].sort());
    if (enableSkillCommands) {
      await writeFile(resolve(agentDir, "prompts/new-template.md"), "---\ndescription: Newly loaded\n---\nNew template");
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/reload" }] }))
        .toMatchObject({ result: { stopReason: "end_turn" } });
      let refreshed;
      for (;;) {
        const update = (await client.nextNotification()).params.update;
        if (update.sessionUpdate === "available_commands_update") refreshed = update.availableCommands;
        if (update.sessionUpdate === "config_option_update") break;
      }
      expect(refreshed).toContainEqual({ name: "new-template", description: "Newly loaded" });
      await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/hello" }] });
      expect((await client.nextNotification()).params.update.content.text).toBe("Hello from extension\n");
      for (const accepted of [true, false]) {
        const pending = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/confirm" }] });
        const form = await client.nextNotification();
        expect(form.method).toBe("elicitation/create");
        expect(form.params.requestedSchema.properties.answer.type).toBe("boolean");
        client.respond(form.id!, accepted ? { action: "accept", content: { answer: true } } : { action: "cancel" });
        expect(await pending).toMatchObject({ result: { stopReason: "end_turn" } });
        expect((await client.nextNotification()).params.update.content.text).toBe(`Confirmed: ${accepted}\n`);
      }
    }
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
