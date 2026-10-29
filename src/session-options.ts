import { RequestError } from "@agentclientprotocol/sdk";
import { isApprovalMode } from "./approvals.js";
import { selectableModels, setThinking } from "./models.js";
import type { BridgeSession } from "./sessions.js";

// Keep legacy Air selectors at the protocol boundary, not in model selection.
export function isLiveConfiguration(configId: string, value: unknown) {
  return configId === "model" || configId === "thinking" ||
    (configId === "mode" && !isApprovalMode(value));
}

export function setLegacyMode(session: BridgeSession, value: string) {
  if (session.bridgeApproval && isApprovalMode(value)) {
    session.bridgeApproval.setMode(value);
    return;
  }
  if (!session.model || !session.getAvailableThinkingLevels().some(level => level === value)) {
    throw RequestError.invalidParams(undefined, "Unsupported session mode");
  }
  setThinking(session, value);
}

export async function setSessionOption(session: BridgeSession, configId: string, value: unknown) {
  if (configId === "approval" || (configId === "mode" && isApprovalMode(value))) {
    if (!session.bridgeApproval) throw RequestError.invalidParams("Tool policy adapter is not loaded");
    session.bridgeApproval.setMode(value);
    return;
  }
  if (configId === "thinking" || configId === "mode") {
    setThinking(session, value);
    return;
  }
  if (configId !== "model" || typeof value !== "string") {
    throw RequestError.invalidParams("Unsupported session configuration option");
  }
  const { models } = await selectableModels(session);
  const model = models.find(candidate => `${candidate.provider}/${candidate.id}` === value);
  if (!model) throw RequestError.invalidParams(undefined, "Unknown, unavailable or out-of-scope model");
  await session.setModel(model, { persist: false });
}
