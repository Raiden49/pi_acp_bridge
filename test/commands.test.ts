import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { createTestRuntime } from "./fixtures.js";
import { parseBridgeCommand } from "../src/commands.js";

const editorContext = "\n\n" + [
  "context: renderer=file title=File source=editor project=/workspace\nfile: /workspace/example.ts",
  "context: renderer=symbol title=Symbol source=editor\nsymbol: example",
  "context: renderer=snippet title=Selection source=editor\nsnippet:\n```ts\nconst example = 1;\n```",
].join("\n\n");

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
    for (const text of ["/session", `/session${editorContext}`]) {
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }))
        .toMatchObject({ result: { stopReason: "end_turn" } });
      const { update } = (await client.nextNotification()).params;
      expect(update.content.text).toContain("pi-session");
      expect(update.content.text).toContain("620");
    }
    for (const [text, name] of [["/session unexpected", "session"], ["/reload\n\nOrdinary extra text", "reload"]]) {
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }))
        .toMatchObject({ error: { code: -32602, message: `Invalid params: Usage: /${name}` } });
    }
    expect(prompt).not.toHaveBeenCalled();
  } finally { await client.close(); }
});

test("/doctor reports runtime and configuration provenance without a model call or secrets", async () => {
  const prompt = vi.fn(async () => { throw new Error("Doctor must not call the model"); });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "default-model", enabledModels: ["fixture/*"] });
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    prompt, settingsManager, subscribe: () => () => {}, abort: async () => {}, dispose() {},
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `/doctor${editorContext}` }] }))
      .toMatchObject({ result: { stopReason: "end_turn" } });
    const text = (await client.nextNotification()).params.update.content.text;
    for (const value of ["Node", "Pi SDK", "SHA-256", "settings.json", "default-model", "fixture/*", "永久删除", "/mcp"]) expect(text).toContain(value);
    expect(prompt).not.toHaveBeenCalled();
  } finally { await client.close(); }
});

test("local command arguments exclude editor context appended inside the text block", async () => {
  const reload = vi.fn(async () => {});
  const setSessionName = vi.fn();
  const compact = vi.fn(async (_args?: string) => ({ summary: "fixture", firstKeptEntryId: "fixture", tokensBefore: 100 }));
  const prompt = vi.fn(async () => { throw new Error("Model must not be called"); });
  expect(parseBridgeCommand([{ type: "text", text: editorContext }])).toBeUndefined();
  expect(parseBridgeCommand([{ type: "text", text: "/name A context: renderer=file title" }]))
    .toEqual({ name: "name", args: "A context: renderer=file title" });
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    prompt, reload, setSessionName, compact, subscribe: () => () => {}, abort: async () => {}, dispose() {},
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    for (const command of ["/reload", "/name pi acp bridge修复bug", "/compact", "/compact Keep decisions\nand pending work"]) {
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: command + editorContext }] }))
        .toMatchObject({ result: { stopReason: "end_turn" } });
    }
    expect(reload).toHaveBeenCalledOnce();
    expect(setSessionName).toHaveBeenCalledExactlyOnceWith("pi acp bridge修复bug");
    expect(compact.mock.calls).toEqual([[undefined], ["Keep decisions\nand pending work"]]);
    expect(prompt).not.toHaveBeenCalled();
  } finally { await client.close(); }
});

test("local commands ignore attached editor context without decoding it or calling the model", async () => {
  const reload = vi.fn(async () => {});
  const prompt = vi.fn(async () => { throw new Error("Model must not be called"); });
  const context = [
    { type: "resource" as const, resource: { uri: "file:///context.txt", text: "/name not-a-command" } },
    { type: "resource_link" as const, uri: "file:///missing-context.png", name: "editor image", mimeType: "image/png" },
    { type: "image" as const, mimeType: "image/png", data: "not-base64" },
  ];
  expect(parseBridgeCommand(context)).toBeUndefined();
  expect(parseBridgeCommand([{ type: "text", text: "/name Actual title" }, ...context]))
    .toEqual({ name: "name", args: "Actual title" });
  const client = protocolHarness(".scratch/absent-models.json", { createSession: async () => ({
    prompt, reload, subscribe: () => () => {}, abort: async () => {}, dispose() {},
  }) });
  try {
    const { sessionId } = (await client.request("session/new", { cwd: "/workspace", mcpServers: [] })).result;
    expect(await client.request("session/prompt", { sessionId, prompt: [context[0], { type: "text", text: "/reload" }, ...context.slice(1)] }))
      .toMatchObject({ result: { stopReason: "end_turn" } });
    expect(reload).toHaveBeenCalledOnce();
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
        pi.registerCommand("hello", { description: "Say hello", handler: async (args, ctx) => {
          ctx.ui.notify(args === "failure" ? "server: failed https://example.invalid?token=private-status-token"
            : ctx.ui.theme.fg("accent", "Hello from extension"), "info");
        } });
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
    expect((await client.nextNotification()).params.update.content.text).toContain("当前模型不可用");
    const notification = await client.nextNotification();
    expect(notification.params).toMatchObject({ sessionId, update: { sessionUpdate: "available_commands_update" } });
    const commands = notification.params.update.availableCommands;
    expect(commands).toEqual(expect.arrayContaining([
      { name: "explain", description: "Explain code" }, { name: "hello", description: "Say hello" },
    ]));
    expect(commands.map((command: { name: string }) => command.name).sort()).toEqual(
      ["session", "doctor", "reload", "compact", "name", "hello", "confirm", "explain", ...(enableSkillCommands ? ["skill:review"] : [])].sort());
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
      await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/hello failure" }] });
      const status = (await client.nextNotification()).params.update.content.text;
      expect(status).toContain("server: failed");
      expect(status).not.toContain("private-status-token");
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
