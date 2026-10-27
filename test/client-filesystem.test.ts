import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import type { ToolCall } from "@earendil-works/pi-ai";
import { assistantStream, createTestRuntime } from "./fixtures.js";
import { protocolHarness } from "./protocol-harness.js";

test.each([true, false])("SDK file tools and diffs use one backend; editor read/write pair=%s", async (paired) => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/editor-fs-"));
  const agentDir = resolve(root, "agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const path = resolve(root, "document.txt");
  await writeFile(path, "disk-old\nsecond line");
  const buffers = new Map([[path, "buffer-old\nsecond line"]]);
  const runtime = await createTestRuntime(resolve(root, "absent-models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "fixture-key");
  let call = { name: "read", arguments: { path } as ToolCall["arguments"] };
  let issued = false;
  let refuseRead = false;
  const client = protocolHarness(resolve(root, "absent-models.json"), { sessionIndexPath: resolve(root, "index.json"), artifactDir: resolve(root, "artifacts"), async createSession(cwd, file, _servers, _id, fileSystem) {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: fileSystem?.extensions() ?? [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime, model,
      sessionManager: file ? SessionManager.open(file) : SessionManager.create(cwd, resolve(root, "sessions")) });
    session.agent.streamFunction = (_model, context) => {
      if (!issued) { issued = true; return assistantStream(model, [{ type: "toolCall", id: "file-call", ...call }]); }
      return assistantStream(model, [{ type: "text", text: JSON.stringify(context.messages.at(-1)) }]);
    };
    return session;
  } });
  try {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: paired } } });
    const { sessionId } = (await client.request("session/new", { cwd: root, mcpServers: [] })).result;
    while ((await client.nextNotification()).params.update.sessionUpdate !== "available_commands_update") {}
    async function turn(name: string, args: ToolCall["arguments"]) {
      call = { name, arguments: args }; issued = false;
      const response = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Use the file tool" }] });
      const updates = [];
      for (;;) {
        const message = await client.nextNotification();
        if (message.method === "fs/read_text_file" || message.method === "fs/write_text_file") {
          expect(paired).toBe(true);
          expect(message.params.sessionId).toBe(sessionId);
          if (message.method === "fs/read_text_file") {
            if (refuseRead) client.respondError(message.id!, { code: -32603, message: "Editor refused the read" });
            else if (!buffers.has(message.params.path)) client.respondError(message.id!, { code: -32002, message: "Resource not found" });
            else client.respond(message.id!, { content: buffers.get(message.params.path)! });
          } else {
            // Simulate editor formatting: diffs must show the observed result.
            buffers.set(message.params.path, message.params.content + "\n"); client.respond(message.id!, {});
          }
        } else {
          updates.push(message.params.update);
          if (message.params.update.sessionUpdate === "agent_message_chunk") break;
        }
      }
      expect(await response).toMatchObject({ result: { stopReason: "end_turn" } });
      return updates;
    }
    const before = paired ? "buffer-old\nsecond line" : "disk-old\nsecond line";
    const read = await turn("read", { path });
    expect(read.at(-1).content.text).toContain(paired ? "buffer-old" : "disk-old");
    const afterEdit = paired ? "edited\nsecond line\n" : "edited\nsecond line";
    const edited = await turn("edit", { path, edits: [{ oldText: paired ? "buffer-old" : "disk-old", newText: "edited" }] });
    expect(edited.flatMap(update => update.content ?? []).find(content => content.type === "diff"))
      .toMatchObject({ oldText: before, newText: afterEdit });
    const written = await turn("write", { path, content: "final content" });
    expect(written.flatMap(update => update.content ?? []).find(content => content.type === "diff"))
      .toMatchObject({ oldText: afterEdit, newText: paired ? "final content\n" : "final content" });
    expect(await readFile(path, "utf8")).toBe(paired ? "disk-old\nsecond line" : "final content");
    if (paired) {
      const created = await turn("write", { path: resolve(root, "new/nested.txt"), content: "new file" });
      expect(created.flatMap(update => update.content ?? []).find(content => content.type === "diff"))
        .toMatchObject({ oldText: null, newText: "new file\n" });
      const profilePath = resolve(agentDir, "private.txt");
      await writeFile(profilePath, "profile stays native");
      expect((await turn("read", { path: profilePath })).at(-1).content.text).toContain("profile stays native");
      const imagePath = resolve(root, "pixel.png");
      await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
      const image = await turn("read", { path: imagePath });
      expect(image.flatMap(update => update.content ?? [])).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "content", content: expect.objectContaining({ type: "image" }) }),
      ]));
      refuseRead = true;
      const refused = await turn("read", { path });
      expect(refused.at(-1).content.text).toContain("Editor refused the read");
      expect(refused.at(-1).content.text).not.toContain("disk-old");
      refuseRead = false;
      await client.request("session/close", { sessionId });
      expect(await client.request("session/load", { sessionId, cwd: root, mcpServers: [] })).toHaveProperty("result");
      while ((await client.nextNotification()).params.update.sessionUpdate !== "available_commands_update") {}
      expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/reload" }] })).toHaveProperty("result");
      while ((await client.nextNotification()).params.update.sessionUpdate !== "config_option_update") {}
      expect((await turn("read", { path })).at(-1).content.text).toContain("final content");
    }
  } finally { await client.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
