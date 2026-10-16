#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { startServer } from "./server.js";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

// Pi's static OAuth loaders also support standalone Node bundles.
// Without them, lazy relative imports resolve beside the bundled CLI.
registerBunOAuthFlows();

const connection = startServer({
  input: Readable.toWeb(process.stdin),
  output: Writable.toWeb(process.stdout),
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { void connection.shutdown().then(() => process.exit(0)); });
}
await connection.closed;
