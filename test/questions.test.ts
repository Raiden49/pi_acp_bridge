import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { protocolHarness } from "./protocol-harness.js";
import { createTestRuntime, assistantStream } from "./fixtures.js";


test.each(["select", "input", "empty", "editor", "confirm", "decline", "cancel", "close", "stop", "unsupported"])("native question form handles %s without extra chat commands", async (mode) => {
  await mkdir(".scratch", { recursive: true });
  const cwd = await mkdtemp(resolve(".scratch/questions-"));
  const runtime = await createTestRuntime(resolve(cwd, "models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "test-only");
  let calls = 0;
  const client = protocolHarness(resolve(cwd, "models.json"), { async createSession() {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [(pi) => {
        pi.registerTool({ name: "fixture_question", label: "Fixture", description: "Exercise Pi UI primitives",
          parameters: Type.Object({}),
          async execute(_id, _params, signal, _update, ctx) {
            if (ctx.mode !== "rpc" || !ctx.hasUI) throw new Error("RPC UI unavailable");
            const answer = mode === "editor" ? await ctx.ui.editor("Edit text", "Original text")
              : ["input", "empty"].includes(mode) ? await ctx.ui.input("Enter text", "Optional value", { signal })
              : ["confirm", "decline"].includes(mode) ? await ctx.ui.confirm("Confirm", "Proceed?", { signal })
              : await ctx.ui.select("Choose", ["A", "B", "C"], { signal });
            const result = answer === undefined ? { cancelled: true } : { cancelled: false, answer };
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          },
        });
      }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime, settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ["fixture_question"] });
    session.agent.streamFunction = (_model, context, options) => {
      // Honor the provider's cancellation contract before any simulated request.
      options?.signal?.throwIfAborted();
      calls++;
      const last = context.messages.at(-1)!;
      const text = last.role === "toolResult" ? JSON.stringify(last.content) : "";
      return assistantStream(model, text ? [{ type: "text", text }] : [{ type: "toolCall", id: "question", name: "fixture_question", arguments: {} }]);
    };
    return session;
  } });
  try {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: mode === "unsupported" ? {} : { elicitation: { form: {} } } });
    const { sessionId } = (await client.request("session/new", { cwd, mcpServers: [] })).result;
    await client.nextNotification();
    const pending = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Ask me" }] });
    const answer = mode === "input" ? "Use a local fixture" : mode === "empty" ? "" : mode === "editor" ? "Updated text" : mode === "confirm" ? true : mode === "decline" ? false : "B";
    if (mode !== "unsupported") {
      let request;
      const updates = [];
      do { request = await client.nextNotification(); updates.push(request.params.update); } while (request.method !== "elicitation/create");
      expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "question" }));
      expect(calls).toBe(1);
      expect(request.params).toMatchObject({ mode: "form", sessionId });
      expect(request.params.requestedSchema.properties.answer).toMatchObject(["confirm", "decline"].includes(mode) ? { type: "boolean" }
        : mode === "editor" ? { type: "string", default: "Original text" }
        : ["input", "empty"].includes(mode) ? { type: "string" } : { type: "string", enum: ["A", "B", "C"] });
      if (mode === "close" || mode === "stop") {
        if (mode === "close") expect(await client.request("session/close", { sessionId })).toHaveProperty("result");
        else client.notify("session/cancel", { sessionId });
        expect(await pending).toMatchObject({ result: { stopReason: "cancelled" } });
        client.respond(request.id!, { action: "accept", content: { answer: "B" } });
        expect(calls).toBe(1);
        return;
      }
      client.respond(request.id!, mode === "cancel" ? { action: "cancel" } : {
        action: "accept", content: { answer },
      });
    }
    expect(await pending).toMatchObject({ result: { stopReason: "end_turn" } });
    let reply;
    do { reply = (await client.nextNotification()).params.update; } while (reply.sessionUpdate !== "agent_message_chunk");
    const text = JSON.parse(reply.content.text)[0].text;
    if (mode === "unsupported") expect(text).toContain("native form support");
    else expect(JSON.parse(text)).toEqual(mode === "cancel" ? { cancelled: true } : {
      cancelled: false, answer,
    });
    expect(calls).toBe(2);
  } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});
