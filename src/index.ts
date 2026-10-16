#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { startServer } from "./server.js";

const connection = startServer({
  input: Readable.toWeb(process.stdin),
  output: Writable.toWeb(process.stdout),
});
await connection.closed;
