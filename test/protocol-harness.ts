import { duplexPair, Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { startServer } from "../src/server.js";

export function protocolHarness(modelsPath: string) {
  const [client, server] = duplexPair();
  const lines = createInterface({ input: client });
  startServer({
    input: Readable.toWeb(server),
    output: Writable.toWeb(server),
    modelsPath,
  });
  let id = 0;
  return {
    async request(method: string, params: unknown) {
      const response = once(lines, "line");
      client.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
      return JSON.parse((await response)[0] as string);
    },
    close() {
      lines.close();
      client.push(null);
      server.push(null);
      client.destroy();
      server.destroy();
    },
  };
}
