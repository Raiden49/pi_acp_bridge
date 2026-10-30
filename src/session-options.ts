import { RequestError } from "@agentclientprotocol/sdk";
import { isApprovalMode } from "./approvals.js";
import { selectableModels, setThinking } from "./models.js";
import type { BridgeSession } from "./sessions.js";

export function isLiveConfiguration(configId: string) {
  return ["model", "thinking", "approval", "mode"].includes(configId);
}

export function setLegacyMode(session: BridgeSession, value: string) {
  if (session.bridgeApproval && isApprovalMode(value)) {
    session.bridgeApproval.setMode(value);
    return;
  }
  throw RequestError.invalidParams(undefined, "Unsupported session mode");
}

export async function setSessionOption(session: BridgeSession, configId: string, value: unknown) {
  if (configId === "approval") {
    if (!session.bridgeApproval) throw RequestError.invalidParams("Tool policy adapter is not loaded");
    session.bridgeApproval.setMode(value);
    return;
  }
  if (configId === "thinking") {
    if (!session.model?.reasoning) throw RequestError.invalidParams("Thinking option is not available");
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
