#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { startServer } from "./server.js";

const connection = startServer({
  input: Readable.toWeb(process.stdin),
  output: Writable.toWeb(process.stdout),
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { void connection.shutdown().then(() => process.exit(0)); });
}
await connection.closed;
