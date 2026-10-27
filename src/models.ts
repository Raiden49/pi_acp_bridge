import { ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { RequestError, type SessionConfigOption, type SessionModeState } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";
import { errorDetail } from "./errors.js";

// The CLI applies enabledModels before SDK startup; the SDK factory alone does not.
export async function applyInitialModelScope(session: BridgeSession) {
  const patterns = session.settingsManager?.getEnabledModels();
  if (!patterns?.length || !session.modelRuntime) return;
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, session.modelRuntime);
  const selected = scopedModels.find(({ model }) =>
    model.provider === session.settingsManager?.getDefaultProvider() && model.id === session.settingsManager?.getDefaultModel()
  ) ?? scopedModels[0];
  if (!selected) return;
  await session.setModel(selected.model, { persist: false });
  if (selected.thinkingLevel) session.setThinkingLevel(selected.thinkingLevel, { persist: false });
}

export async function refreshSessionModels(session: BridgeSession) {
  if (!session.modelRuntime) return;
  const at = new Date().toISOString();
  try {
    const result = await session.modelRuntime.refresh({ allowNetwork: false });
    if (session.modelRuntime.getError()) throw new RequestError(-32603, "Invalid Pi model configuration or availability refresh; check models.json and credentials");
    // Refresh endpoint/capability metadata too, without changing the selected model ID.
    const current = session.model && session.modelRuntime.getModel(session.model.provider, session.model.id);
    if (current && session.modelRuntime.getAvailableSnapshot().some((model) => model.provider === current.provider && model.id === current.id)) {
      const thinking = session.thinkingLevel;
      await session.setModel(current, { persist: false });
      if (thinking) session.setThinkingLevel(thinking, { persist: false });
    }
    if (session.bridgeDiagnostics) session.bridgeDiagnostics.modelRefresh = { at, status: result.errors.size ? "failed" : "success",
      ...(result.errors.size ? { detail: "部分提供方刷新失败；检查 models.json 与认证配置。" } : {}) };
  } catch (error) {
    if (session.bridgeDiagnostics) session.bridgeDiagnostics.modelRefresh = { at, status: "failed", detail: errorDetail(error) };
    throw error;
  }
}

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
    ? "enabledModels 未匹配任何可用模型；不会自动扩大范围。请在 Pi /scoped-models 中调整范围后 /reload。"
    : diagnostics.length ? "enabledModels 中部分规则未匹配或包含无效 Thinking 后缀；请检查 Pi 的模型范围配置。" : undefined;
  return { models, warning };
}

export async function sessionConfiguration(session: BridgeSession): Promise<{
  configOptions: SessionConfigOption[]; modes?: SessionModeState; warning?: string;
}> {
  const approval = session.bridgeApproval?.option();
  // Legacy modes represent work/permission policy, never model-dependent effort.
  const modes: SessionModeState | undefined = approval?.type === "select" ? {
    currentModeId: approval.currentValue,
    availableModes: approval.options.flatMap(option => "value" in option
      ? [{ id: option.value, name: option.name }]
      : option.options.map(({ value, name }) => ({ id: value, name }))),
  } : undefined;
  if (!session.modelRuntime) return { configOptions: approval ? [approval] : [], modes };
  const { models, warning: scopeWarning } = await selectableModels(session);
  const currentValue = session.model ? `${session.model.provider}/${session.model.id}` : "__pi_no_model__";
  const currentAvailable = models.some((model) => `${model.provider}/${model.id}` === currentValue);
  const warning = [scopeWarning, !currentAvailable ? "当前模型不可用、在范围外或未选择；请选择范围内的可用模型。若列表为空，请检查 Pi 认证及 enabledModels 后 /reload。" : undefined].filter(Boolean).join("\n") || undefined;
  // Keep the actual selection visible, as mature adapters do, instead of hiding
  // the entire selector. This diagnostic entry never grants model availability.
  const choices = models.map((model) => ({ value: `${model.provider}/${model.id}`, name: `${model.name} (${model.provider})` }));
  if (!currentAvailable) choices.unshift({ value: currentValue, name: `${session.model?.name ?? currentValue}（当前不可用或范围外，请切换）` });
  const options: SessionConfigOption[] = [{
    id: "model", name: "Model", category: "model", type: "select", currentValue,
    ...(warning ? { description: warning } : {}),
    // Keep labels distinct from wire IDs: Air rejects model names equal to their values.
    options: choices,
  }];
  if (session.model?.reasoning && session.thinkingLevel) {
    options.push({ id: "thinking", name: "Thinking", category: "thought_level", type: "select",
      currentValue: session.thinkingLevel,
      options: session.getAvailableThinkingLevels().map(value => ({ value, name: value })),
    });
  }
  if (approval) options.push(approval);
  return { configOptions: options, modes, warning };
}

export function setThinking(session: BridgeSession, value: unknown) {
  const level = session.getAvailableThinkingLevels().find((level) => level === value);
  if (!session.model || !level) throw RequestError.invalidParams(undefined, "Unsupported thinking level for current model");
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
