import { duplexPair, Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { startServer, type ServerOptions } from "../src/server.js";

type Message = { id?: number; method?: string; params?: any; result?: any; error?: any };

export function protocolHarness(modelsPath: string, options: Partial<ServerOptions> = {}) {
  const [client, server] = duplexPair();
  const lines = createInterface({ input: client });
  const connection = startServer({
    ...options,
    input: Readable.toWeb(server),
    output: Writable.toWeb(server),
    modelsPath,
  });
  let id = 0;
  const pending = new Map<number, (message: Message) => void>();
  const notifications: Message[] = [];
  const waiters: Array<(message: Message) => void> = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Message;
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else {
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else notifications.push(message);
    }
  });
  return {
    request(method: string, params: unknown): Promise<Message> {
      const requestId = ++id;
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        client.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
      });
    },
    notify(method: string, params: unknown) {
      client.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    nextNotification(): Promise<Message> {
      const next = notifications.shift();
      return next ? Promise.resolve(next) : new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      client.end();
      await connection.closed;
      lines.close();
      client.destroy();
      server.destroy();
    },
  };
}
