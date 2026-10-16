import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";

export function* replayHistory(session: BridgeSession): Generator<SessionUpdate> {
  // Model context is compacted; the chat transcript must retain earlier turns.
  const messages = session.sessionManager
    ? session.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : [])
    : session.messages ?? [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      yield { sessionUpdate: "tool_call_update", toolCallId: message.toolCallId,
        status: message.isError ? "failed" : "completed",
        content: message.content.map((content) => ({ type: "content", content })),
      };
    } else if (message.role === "user" || message.role === "assistant") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      for (const content of blocks) {
        if (content.type === "text" || content.type === "image") {
          yield { sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk", content };
        } else if (content.type === "thinking") {
          yield { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: content.thinking } };
        } else if (content.type === "toolCall") {
          yield { sessionUpdate: "tool_call", toolCallId: content.id, title: content.name,
            status: "in_progress", rawInput: content.arguments,
          };
        }
      }
    }
  }
}
