import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import { decodePrompt } from "./content.js";

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
