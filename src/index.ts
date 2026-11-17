#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { startServer } from "./server.js";
import { startAgyProcessBridge } from "./agy-mode.js";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

// Opt-in metadata only; never log prompt text, image data, or credentials.
const trace = process.env.PI_ACP_TRACE === "1" ? (event: Record<string, string | number | boolean>) => {
  process.stderr.write(`[pi-acp-bridge] ${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
} : undefined;

const argv = process.argv.slice(2);
const connection = argv.includes("--agy")
  ? startAgyProcessBridge({
      input: Readable.toWeb(process.stdin),
      output: Writable.toWeb(process.stdout),
      args: argv.filter((arg) => arg !== "--agy"),
      trace,
    })
  : (() => {
      // Pi's static OAuth loaders also support standalone Node bundles.
      // Without them, lazy relative imports resolve beside the bundled CLI.
      registerBunOAuthFlows();
      return startServer({
        input: Readable.toWeb(process.stdin),
        output: Writable.toWeb(process.stdout),
        trace,
      });
    })();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { void connection.shutdown().then(() => process.exit(0)); });
}
await connection.closed;
