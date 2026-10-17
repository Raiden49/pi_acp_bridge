import { ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { RequestError, type SessionConfigOption, type SessionModeState } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";

export async function selectableModels(session: BridgeSession) {
  const available = session.modelRuntime?.getAvailableSnapshot() ?? [];
  const patterns = session.settingsManager?.getEnabledModels();
  if (!patterns?.length) return { models: [...available] };
  // The public SDK resolver requires a runtime. Adapt only its input method so
  // matching stays snapshot-only: no credential checks or catalog refreshes.
  const snapshot = { getAvailable: async () => available } as ModelRuntime;
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, snapshot);
  const models = scopedModels.map(({ model }) => model);
  const warning = !models.length
    ? "enabledModels 未匹配任何可用模型；仅保留仍可用的当前模型。请在 Pi /scoped-models 中调整范围后 /reload。"
    : diagnostics.length ? "enabledModels 中部分规则未匹配或包含无效 Thinking 后缀；请检查 Pi 的模型范围配置。" : undefined;
  const current = available.find((model) => model.provider === session.model?.provider && model.id === session.model.id);
  if (current && !models.includes(current)) models.push(current);
  return { models, warning };
}

export async function sessionConfiguration(session: BridgeSession): Promise<{
  configOptions: SessionConfigOption[]; modes?: SessionModeState; warning?: string;
}> {
  const modes = thinkingModes(session);
  if (!session.model || !session.modelRuntime) return { configOptions: [], modes };
  const { models, warning } = await selectableModels(session);
  const currentValue = `${session.model.provider}/${session.model.id}`;
  if (!models.some((model) => `${model.provider}/${model.id}` === currentValue)) return { configOptions: [], modes, warning };
  const options: SessionConfigOption[] = [{
    id: "model", name: "Model", category: "model", type: "select", currentValue,
    ...(warning ? { description: warning } : {}),
    // Keep labels distinct from wire IDs: Air rejects model names equal to their values.
    options: models.map((model) => ({ value: `${model.provider}/${model.id}`, name: `${model.name} (${model.provider})` })),
  }];
  if (session.model.reasoning && modes) {
    options.push({ id: "thinking", name: "Thinking", category: "thought_level", type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map(({ id }) => ({ value: id, name: id })),
    });
  }
  return { configOptions: options, modes, warning };
}

function thinkingModes(session: BridgeSession): SessionModeState | undefined {
  if (!session.model || !session.thinkingLevel) return undefined;
  return {
    currentModeId: session.thinkingLevel,
    availableModes: session.getAvailableThinkingLevels().map((id) => ({ id, name: `Thinking: ${id}` })),
  };
}

export function setThinking(session: BridgeSession, value: unknown) {
  const level = session.getAvailableThinkingLevels().find((level) => level === value);
  if (!session.model || !level) throw RequestError.invalidParams("Unsupported thinking level for current model");
  session.setThinkingLevel(level, { persist: false });
}

export async function discoverModels(modelsPath?: string) {
  // Discovery must not refresh remote catalogs, resolve secrets, or write credentials.
  const runtime = await ModelRuntime.create({
    modelsPath,
    credentials: {
      async read() { return undefined; },
      async list() { return []; },
      async modify() { throw new Error("Model discovery is read-only"); },
      async delete() { throw new Error("Model discovery is read-only"); },
    },
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  if (runtime.getError()) {
    // Pi validation errors can include configuration contents; never forward them.
    throw new RequestError(-32603, "Invalid Pi model configuration");
  }
  return runtime.getModels().map((model) => ({
    modelId: `${model.provider}/${model.id}`,
    name: model.name,
  }));
}
