import { CLIENT_METHODS, RequestError, type AgentSideConnection, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { InlineExtension, SessionManager, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { errorDetail } from "./errors.js";

export type ApprovalMode = "direct" | "ask" | "plan";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "direct" || value === "ask" || value === "plan";
}
const entryType = "pi-acp-bridge/approval-v1";
const readOnly = new Set(["read", "grep", "find", "ls", "codemode", "tool_search"]);

// This is an execution policy for Pi's tool pipeline, not an OS sandbox.
export class ApprovalGate {
  installed = false;
  mode: ApprovalMode = "direct";
  private sessionId = "";
  private manager?: SessionManager;
  private turn?: AbortController;
  private beforePermission?: (toolCallId: string) => Promise<void>;

  constructor(private readonly connection: Pick<AgentSideConnection, "request">) {}

  bind(sessionId: string, manager?: SessionManager, fallback?: ApprovalMode) {
    this.sessionId = sessionId;
    this.manager = manager;
    const entry = manager?.getBranch().findLast(entry => entry.type === "custom" && entry.customType === entryType);
    if (entry?.type === "custom") {
      const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
      if (isApprovalMode(mode)) {
        this.mode = mode;
        return;
      }
    }
    // Pi deliberately keeps setup-only custom entries in memory. Restore the
    // indexed policy and append it so the first conversation persists it.
    if (fallback) this.setMode(fallback);
  }

  setMode(value: unknown) {
    if (!this.installed || !isApprovalMode(value)) throw RequestError.invalidParams("Unsupported approval mode");
    this.manager?.appendCustomEntry(entryType, { mode: value });
    this.mode = value;
  }

  option(): SessionConfigOption {
    return { id: "approval", name: "Tool policy", category: "mode", type: "select", currentValue: this.mode,
      description: "Session-only tool policy; trusted extensions are not sandboxed. Plan blocks shell and unknown tools.",
      options: [{ value: "direct", name: "Direct execution" }, { value: "ask", name: "Ask before changes" }, { value: "plan", name: "Plan (read-only tools)" }] };
  }

  beginTurn(beforePermission: (toolCallId: string) => Promise<void>) {
    this.turn = new AbortController();
    this.beforePermission = beforePermission;
  }

  cancelTurn() {
    this.turn?.abort();
  }

  finishTurn() {
    this.cancelTurn();
    this.turn = undefined;
    this.beforePermission = undefined;
  }

  extensions(): InlineExtension[] {
    return [{ name: "acp-tool-policy", hidden: true, factory: pi => {
      // Registered after user extensions: an asynchronously transformed input
      // cannot restart a cancelled turn when it eventually reaches this hook.
      pi.on("input", () => this.turn?.signal.aborted ? { action: "handled" } : undefined);
      pi.on("before_agent_start", event => this.mode === "direct" ? undefined : {
        systemPrompt: `${event.systemPrompt}\n\n${this.mode === "plan"
          ? "Plan mode: inspect and explain only. Do not modify files, execute shell commands, or invoke unknown tools."
          : "Ask-before-changes mode: tools that can change state require the user's approval."}`,
      });
      pi.on("tool_call", (event, ctx) => {
        // Hints come from trusted tool registrations, never model-supplied input.
        // Resolve on each call so reloads and late MCP registration remain visible.
        const hint = pi.getAllTools().find(tool => tool.name === event.toolName)?.annotations?.readOnlyHint;
        return this.check(event, hint ?? readOnly.has(event.toolName), ctx.signal);
      });
      this.installed = true;
    } }];
  }

  private async check(event: ToolCallEvent, readOnly: boolean, sdkSignal?: AbortSignal) {
    const signals = [this.turn?.signal, sdkSignal].filter((signal): signal is AbortSignal => !!signal);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const blocked = (reason: string) => ({ block: true as const, reason });
    if (signal?.aborted) return blocked("Tool execution cancelled");
    if (this.mode === "direct" || readOnly) return;
    if (this.mode === "plan") return blocked(`Plan mode blocks ${event.toolName}; switch the session's Tool policy to approve changes.`);
    let onAbort: (() => void) | undefined;
    try {
      await this.beforePermission?.(event.toolCallId);
      if (signal?.aborted) return blocked("Tool execution cancelled");
      const decision = await Promise.race([
        this.connection.request(CLIENT_METHODS.session_request_permission, { sessionId: this.sessionId, toolCall: {
          toolCallId: event.toolCallId, title: event.toolName, status: "pending",
          kind: ["bash", "powershell"].includes(event.toolName) ? "execute" : ["edit", "write"].includes(event.toolName) ? "edit" : "other",
          content: [{ type: "content", content: { type: "text", text: errorDetail(JSON.stringify(event.input), 12000) } }],
        }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] }, { cancellationSignal: signal }),
        new Promise<undefined>(resolve => {
          onAbort = () => resolve(undefined);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) resolve(undefined);
        }),
      ]);
      if (!signal?.aborted && decision?.outcome.outcome === "selected" && decision.outcome.optionId === "allow") return;
      return blocked(signal?.aborted ? "Tool execution cancelled" : "User did not approve tool execution");
    } catch (error) {
      return blocked(`Approval failed: ${errorDetail(error)}`);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
}
