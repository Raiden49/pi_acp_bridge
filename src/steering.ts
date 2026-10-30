import { RequestError, type Agent, type ContentBlock } from "@agentclientprotocol/sdk";
import { decodePrompt } from "./content.js";
import { parseBridgeCommand } from "./commands.js";
import { sessionBusy, bridgeError, errorDetail } from "./errors.js";
import type { SessionHost } from "./managed-session.js";

// Claude ACP's v1 extension contract, not an invented ACP v2 method.
export function steeringRequest(params: Record<string, unknown>) {
  if (typeof params.sessionId !== "string" || !params.sessionId || !Array.isArray(params.prompt) || !params.prompt.length) {
    throw RequestError.invalidParams("Steering requires sessionId and a non-empty prompt array");
  }
  const meta = params._meta as { steering?: { idleBehavior?: unknown } } | undefined;
  const idleBehavior = meta?.steering?.idleBehavior;
  if (idleBehavior !== undefined && idleBehavior !== "promptRequired") throw RequestError.invalidParams("Unsupported steering idleBehavior");
  const prompt = params.prompt as ContentBlock[];
  return { sessionId: params.sessionId, prompt, idleBehavior, decode() {
    // promptRequired must leave even file-backed attachments untouched.
    let decoded: ReturnType<typeof decodePrompt>;
    try { decoded = decodePrompt(prompt); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      throw RequestError.invalidParams("Invalid steering prompt content");
    }
    if (!decoded.text.trim() && !decoded.images.length) throw RequestError.invalidParams("Steering input is empty");
    return decoded;
  } };
}

export function createSteeringHandler(
  { getSession, sessions, sendUpdate, trace }: SessionHost,
  prompt: Agent["prompt"],
): NonNullable<Agent["extMethod"]> {
  return async (method, params) => {
    if (method !== "_session/steering") throw new RequestError(-32601, "Unsupported extension method");
    const request = steeringRequest(params);
    const entry = getSession(request.sessionId);
    const active = entry.active;
    if (!active) {
      if (request.idleBehavior === "promptRequired") return { outcome: "promptRequired", reason: "noRunningTurn" };
      parseBridgeCommand(request.prompt);
      void Promise.resolve(prompt({ sessionId: request.sessionId, prompt: request.prompt })).catch(async (error) => {
        trace({ event: "steered_prompt_failed" });
        if (sessions.get(request.sessionId) === entry) {
          await sendUpdate({ sessionId: request.sessionId, update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Steered prompt failed: ${errorDetail(error)}` },
          } }).catch(() => undefined);
        }
      });
      return { outcome: "startedNewTurn" };
    }
    if (active.cancelled || !active.acceptingInputs || entry.session.isIdle === true) throw sessionBusy("Session is cancelling, running a command, or settling");
    if (parseBridgeCommand(request.prompt)) throw RequestError.invalidParams("Bridge commands cannot be injected into a running turn");
    const { text, images } = request.decode();
    // Pi RPC uses this public prompt/preflight hook, including the race where
    // asynchronous input handlers finish after the previous SDK run settles.
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let accepted = false;
      const operation = Promise.resolve().then(() => entry.session.prompt(text, {
        images, streamingBehavior: "steer", source: "rpc", expandPromptTemplates: false,
        preflightResult: () => {
          if (active.cancelled || !active.acceptingInputs) {
            reject(sessionBusy("Turn is no longer accepting input"));
            return;
          }
          accepted = true;
          resolve({ outcome: "injected" });
        },
      })).catch((error) => {
        if (accepted) active.inputError = error;
        reject(bridgeError("Unable to steer Pi session", error));
      }).finally(() => { active.inputs.delete(operation); });
      active.inputs.add(operation);
    });
  };
}
