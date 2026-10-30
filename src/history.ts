import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { sessionEntryToContextMessages, type CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import type { BridgeSession } from "./sessions.js";
import { displayContent } from "./content.js";

export function customMessageUpdates(message: Pick<CustomMessageEntry, "content" | "display">): SessionUpdate[] {
  if (!message.display) return [];
  const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  return blocks.map((content) => ({ sessionUpdate: "agent_message_chunk", content: displayContent(content) }));
}

export function* replayHistory(session: BridgeSession): Generator<SessionUpdate> {
  // Model context is compacted; the chat transcript must retain earlier turns.
  const messages = session.sessionManager
    ? session.sessionManager.getBranch().flatMap((entry) =>
      entry.type === "message" || entry.type === "custom_message" ? sessionEntryToContextMessages(entry) : [])
    : session.messages ?? [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "bashExecution") {
      const toolCallId = `pi-bash-${index}-${message.timestamp}`;
      yield { sessionUpdate: "tool_call", toolCallId, title: message.command, kind: "execute",
        status: "in_progress", rawInput: { command: message.command } };
      yield { sessionUpdate: "tool_call_update", toolCallId,
        status: message.cancelled || message.exitCode !== 0 ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: message.output } }],
      };
    } else if (message.role === "custom") {
      yield* customMessageUpdates(message);
    } else if (message.role === "toolResult") {
      yield { sessionUpdate: "tool_call_update", toolCallId: message.toolCallId,
        status: message.isError ? "failed" : "completed",
        content: message.content.map((content) => ({ type: "content", content: displayContent(content) })),
      };
    } else if (message.role === "user" || message.role === "assistant") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      for (const content of blocks) {
        if (content.type === "text" || content.type === "image") {
          yield { sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: displayContent(content) };
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
