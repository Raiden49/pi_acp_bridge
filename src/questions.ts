import type { AgentSideConnection, CreateElicitationResponse, ElicitationPropertySchema } from "@agentclientprotocol/sdk";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

export type FormQuestion = { message: string } & (
  | { kind: "text"; prefill?: string }
  | { kind: "select"; choices: string[] }
  | { kind: "confirm" }
);
type Answer = string | boolean;
export type NativeQuestion = (message: string, property: ElicitationPropertySchema, signal: AbortSignal) => Promise<CreateElicitationResponse>;

export function nativeQuestions(client: Pick<AgentSideConnection, "request">, sessionId: string): NativeQuestion {
  return (message, property, cancellationSignal) => client.request("elicitation/create", {
    mode: "form", sessionId, message,
    requestedSchema: { type: "object", required: ["answer"], properties: { answer: property } },
  }, { cancellationSignal });
}

export class Questions {
  private pending = new Set<() => void>();
  constructor(private native?: NativeQuestion) {}

  async ask(question: FormQuestion, options?: ExtensionUIDialogOptions): Promise<Answer | undefined> {
    if (options?.signal?.aborted) return undefined;
    if (!this.native) throw new Error("The client has not advertised native form support");
    const property: ElicitationPropertySchema = question.kind === "confirm"
      ? { type: "boolean", title: "确认", default: false }
      : { type: "string", title: "回答",
        ...(question.kind === "select" ? { enum: question.choices } : { default: question.kind === "text" ? question.prefill : undefined }) };
    const send = this.native;
    return new Promise<Answer | undefined>((resolve, reject) => {
      const controller = new AbortController();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (answer?: Answer, error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        this.pending.delete(cancel);
        if (error) reject(error); else resolve(answer);
      };
      const cancel = () => { controller.abort(); finish(); };
      this.pending.add(cancel);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      if (options?.timeout !== undefined) timer = setTimeout(cancel, options.timeout);
      // Cancellation must settle locally even if the client ignores $/cancel_request.
      void send(question.message, property, controller.signal).then((response) => {
        if (done) return;
        if (response.action !== "accept") { finish(); return; }
        const answer = (response.content as Record<string, unknown> | undefined)?.answer;
        const valid = question.kind === "confirm" ? typeof answer === "boolean"
          : typeof answer === "string" && (question.kind !== "select" || question.choices.includes(answer));
        if (valid) finish(answer as Answer);
        else finish(undefined, new Error("The client returned an invalid form answer"));
      }).catch(() => finish(undefined, new Error("Native form request failed; no user approval was received")));
    });
  }

  cancel() { for (const cancel of [...this.pending]) cancel(); }
}
