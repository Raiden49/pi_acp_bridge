import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { BridgeSession } from "./sessions.js";

let themeReady = false;

// ACP has no terminal widget host. Never silently accept an unsupported dialog.
export async function bindExtensionUI(session: BridgeSession, notify: (text: string) => void) {
  if (!session.bindExtensions || !session.extensionRunner) return;
  if (!themeReady) { initTheme(); themeReady = true; }
  const terminalDialogError = "This extension requires a terminal dialog; use Pi CLI for this command.";
  const unavailable = async (): Promise<never> => { throw new Error(terminalDialogError); };
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message, type) => notify(`${type === "error" ? "错误：" : ""}${stripVTControlCharacters(message)}\n`),
      select: unavailable, confirm: unavailable, input: unavailable, editor: unavailable, custom: unavailable,
    },
    onError: ({ error }) => notify(error === terminalDialogError
      ? "该命令需要终端交互，请在 Pi CLI 中运行。\n"
      : "扩展执行失败；请检查该扩展的 ACP/无终端兼容性。\n"),
  });
}
