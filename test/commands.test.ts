import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";

test.each([true, false])("advertises loaded prompt templates, extensions and enabled skills: %s", async (enableSkillCommands) => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/commands-"));
  const agentDir = resolve(cwd, "agent");
  await mkdir(resolve(agentDir, "skills/review"), { recursive: true });
  await mkdir(resolve(agentDir, "prompts"));
  await writeFile(resolve(agentDir, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nCheck code.");
  await writeFile(resolve(agentDir, "prompts/explain.md"), "---\ndescription: Explain code\n---\nExplain $@");
  const settingsManager = SettingsManager.inMemory({ enableSkillCommands });
  const runtime = await ModelRuntime.create({ modelsPath: resolve(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const client = protocolHarness(resolve(agentDir, "models.json"), { async createSession() {
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noThemes: true, extensionFactories: [(pi) => {
        pi.registerCommand("hello", { description: "Say hello", handler: async () => {} });
      }],
    });
    await resourceLoader.reload();
    return (await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(cwd), noTools: "all",
    })).session;
  } });
  try {
    const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    const notification = await client.nextNotification();
    expect(notification.params).toMatchObject({ sessionId, update: { sessionUpdate: "available_commands_update" } });
    const commands = notification.params.update.availableCommands;
    expect(commands).toEqual(expect.arrayContaining([
      { name: "explain", description: "Explain code" }, { name: "hello", description: "Say hello" },
    ]));
    expect(commands.some((command: { name: string }) => command.name === "skill:review")).toBe(enableSkillCommands);
    expect(commands.some((command: { name: string }) => command.name === "quit")).toBe(false);
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
