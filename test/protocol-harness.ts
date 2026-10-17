import { duplexPair, Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { startServer, type ServerOptions } from "../src/server.js";
import { completeSession, type TestSession } from "./fixtures.js";

type Message = { id?: number; method?: string; params?: any; result?: any; error?: any };

type HarnessOptions = Partial<Omit<ServerOptions, "createSession">> & {
  createSession?: (...args: Parameters<NonNullable<ServerOptions["createSession"]>>) => Promise<TestSession>;
};

export function protocolHarness(modelsPath: string, options: HarnessOptions = {}) {
  const [client, server] = duplexPair();
  const lines = createInterface({ input: client });
  const connection = startServer({
    // Never discover personal history in protocol tests.
    sessionDir: ".scratch/absent-session-history",
    ...options,
    createSession: options.createSession && (async (...args) => completeSession(await options.createSession!(...args))),
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
    if (message.id !== undefined && !message.method) {
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
    respond(requestId: number, result: unknown) {
      client.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, result }) + "\n");
    },
    notify(method: string, params: unknown) {
      client.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    nextNotification(): Promise<Message> {
      const next = notifications.shift();
      return next ? Promise.resolve(next) : new Promise((resolve) => waiters.push(resolve));
    },
    shutdown: () => connection.shutdown(),
    async close() {
      client.end();
      server.end();
      await connection.closed;
      lines.close();
      client.destroy();
      server.destroy();
    },
  };
}
