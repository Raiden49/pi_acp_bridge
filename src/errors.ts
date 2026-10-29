import { RequestError } from "@agentclientprotocol/sdk";

export const SESSION_ACTIVE_WRITER = "session_active_writer";

const sensitiveName = /^(?:(?:(?:x[-_]?)?api[-_]?|private[-_]?)?key|(?:access[-_]?|refresh[-_]?|id[-_]?)?token|authorization|proxy-authorization|password|passwd|secret|client[-_]?secret|credential|signature|sig|code|x-amz-(?:credential|signature|security-token))$/i;

// Parse URLs rather than attempting to recognize credentials inside their encoding.
function redactUrl(text: string): string {
  try {
    const url = new URL(text);
    if (url.username || url.password) { url.username = "REDACTED"; url.password = ""; }
    for (const key of new Set(url.searchParams.keys())) {
      if (sensitiveName.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch { return "[invalid URL omitted]"; }
}

// This is a diagnostic summary, not a serializer for request/configuration objects.
export function errorDetail(error: unknown, maxLength = 2000): string {
  const messages = [error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Pi error"];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause instanceof Error && depth < 3; depth++, cause = cause.cause) messages.push(cause.message);
  return messages.join(": ")
    .replace(/https?:\/\/[^\s<>"']+/gi, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/(["']?(?:(?:(?:x[-_]?)?api[-_]?)?key|(?:access[-_]?|refresh[-_]?|id[-_]?)?token|authorization|proxy-authorization|password|passwd|secret|client[-_]?secret)["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+\[REDACTED\]|"[^"]*"|'[^']*'|[^\s,;}&?#]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .slice(0, maxLength);
}

// Like Codex's error explanation boundary, retain protocol codes but never forward
// arbitrary error data (which may contain the original request or credentials).
export function bridgeError(operation: string, error: unknown): RequestError {
  if (error instanceof RequestError) {
    const data = error.data as { reason?: unknown } | undefined;
    return new RequestError(error.code, errorDetail(error),
      data?.reason === SESSION_ACTIVE_WRITER ? { reason: data.reason } : undefined);
  }
  return new RequestError(-32603, `${operation}: ${errorDetail(error)}`);
}
