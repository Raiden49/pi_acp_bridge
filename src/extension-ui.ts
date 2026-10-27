import { stripVTControlCharacters } from "node:util";
import { errorDetail } from "./errors.js";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { BridgeSession } from "./sessions.js";
import type { FormQuestion, Questions } from "./questions.js";

let themeReady = false;

// ACP forms are interactive; arbitrary terminal widgets still need Pi CLI.
export async function bindExtensionUI(session: BridgeSession, notify: (text: string) => void, questions: Questions) {
  if (!session.extensionRunner) return;
  if (!themeReady) { initTheme(); themeReady = true; }
  const terminalDialogError = "This extension requires a terminal dialog; use Pi CLI for this command.";
  const textForm = async (question: FormQuestion, options?: Parameters<Questions["ask"]>[1]) => {
    const answer = await questions.ask(question, options);
    return typeof answer === "string" ? answer : undefined;
  };
  const uiContext: ExtensionUIContext = {
    ...session.extensionRunner.getUIContext(),
    notify: (message, type) => notify(`${type === "error" ? "错误：" : ""}${stripVTControlCharacters(errorDetail(message, 12000))}\n`),
    select: (message, choices, options) => textForm({ kind: "select", message, choices }, options),
    confirm: async (title, message, options) => (await questions.ask({ kind: "confirm", message: `${title}\n\n${message}` }, options)) === true,
    input: (title, placeholder, options) => textForm({ kind: "text", message: `${title}${placeholder ? `\n\n提示：${placeholder}` : ""}` }, options),
    editor: (message, prefill) => textForm({ kind: "text", message, prefill }),
    custom: async (): Promise<never> => { throw new Error(terminalDialogError); },
  };
  await session.bindExtensions({
    mode: "rpc", uiContext,
    onError: ({ error }) => notify(error === terminalDialogError
      ? "该命令需要终端交互，请在 Pi CLI 中运行。\n"
      : `扩展执行失败：${stripVTControlCharacters(errorDetail(error))}\n`),
  });
}
