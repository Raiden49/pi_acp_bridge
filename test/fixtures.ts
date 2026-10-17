import { createAgentSession, DefaultResourceLoader, ModelRuntime, type CreateAgentSessionOptions, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { BridgeSession } from "../src/sessions.js";

export type TestSession = Pick<BridgeSession, "prompt" | "subscribe" | "abort" | "dispose"> & Partial<BridgeSession>;

export function completeSession(session: TestSession): BridgeSession {
  const unexpected = () => { throw new Error("Unexpected session operation in test"); };
  const defaults = {
    setModel: unexpected, setThinkingLevel: unexpected, getAvailableThinkingLevels: () => ["off"],
    setSessionName: unexpected, getSessionStats: unexpected, getContextUsage: () => undefined, reload: unexpected,
    compact: unexpected, bindExtensions: unexpected,
  } satisfies Partial<BridgeSession>;
  // Keep SDK instances and method receivers intact; fill only lightweight fakes.
  return Object.assign(session, Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in session)))) as BridgeSession;
}

export function createTestRuntime(modelsPath: string) {
  return ModelRuntime.create({ modelsPath, refreshOnCreate: false, allowModelNetwork: false,
    credentials: {
      async read() { return undefined; }, async list() { return []; },
      async modify() { throw new Error("Read only"); }, async delete() { throw new Error("Read only"); },
    },
  });
}

// Real SDK sessions without ambient extensions, skills, templates, or model traffic.
export async function createBareSession(options: CreateAgentSessionOptions &
  Required<Pick<CreateAgentSessionOptions, "cwd" | "agentDir" | "settingsManager" | "modelRuntime">>) {
  const { cwd, agentDir, settingsManager } = options;
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ ...options, resourceLoader });
  session.agent.streamFunction = () => { throw new Error("Unexpected model request in test"); };
  return session;
}

export function assistantStream(model: Model<Api>, content: AssistantMessage["content"]) {
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
      for (const [contentIndex, block] of content.entries()) {
        if (block.type === "text") yield { type: "text_delta", contentIndex, delta: block.text, partial: message };
      }
      yield { type: "done", reason: message.stopReason, message };
    },
    async result() { return message; },
  } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
}
