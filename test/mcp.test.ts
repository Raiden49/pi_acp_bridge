import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { protocolHarness } from "./protocol-harness.js";
import { createTestRuntime, assistantStream } from "./fixtures.js";
import { clientMcpExtension } from "../src/client-mcp.js";

const serverScript = `
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : m.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo workspace marker', inputSchema: { type: 'object', properties: {} } }, ...(process.env.MARKER === 'restored' ? [{ name: 'ask_user_question', inputSchema: { type: 'object', properties: {} } }] : [])] }
    : m.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ marker: process.env.MARKER, cwd: process.cwd(), pid: process.pid }) }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
lines.on('close', () => process.exit(0));
`;

test.each(["stdio", "http"] as const)("ACP %s MCP tools preserve credentials and close session transports", async (transport) => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/mcp-"));
  const script = resolve(root, "server.mjs");
  await writeFile(script, serverScript);
  let httpClosed = false;
  const http = createServer(async (request, response) => {
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { httpClosed = true; response.writeHead(200).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }, ...(request.headers["x-marker"] === "restored" ? [{ name: "ask_user_question", inputSchema: { type: "object", properties: {} } }] : [])] }
      : { content: [{ type: "text", text: JSON.stringify({ marker: request.headers["x-marker"], cwd: root }) }] };
    response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "fixture" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  if (transport === "http") { http.listen(0, "127.0.0.1"); await once(http, "listening"); }
  const runtime = await createTestRuntime(resolve(root, "models.json"));
  const model = runtime.getModels("anthropic")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "test-only");
  let expectQuestion = false;
  const client = protocolHarness(resolve(root, "models.json"), { sessionIndexPath: resolve(root, "index.json"), async createSession(cwd, file, servers = []) {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [clientMcpExtension(servers)],
    });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: root, settingsManager, resourceLoader: loader,
      sessionManager: file ? SessionManager.open(file) : SessionManager.create(cwd, resolve(root, "sessions")), modelRuntime: runtime, model,
    });
    session.agent.streamFunction = (_model, context) => {
      expect(JSON.stringify(context.messages.filter((message) => message.role === "system"))
        .includes("prefer the client's mcp__ide__ask_user_question")).toBe(expectQuestion);
      const last = context.messages.at(-1)!;
      const text = last.role === "toolResult" ? JSON.stringify(last.content) : "";
      return assistantStream(model, text ? [{ type: "text", text }] : [{ type: "toolCall", id: "echo", name: "mcp__ide__echo", arguments: {} }]);
    };
    return session;
  } });
  try {
    let sessionId: string | undefined;
    for (const marker of ["!literal-${UNCHANGED}", "restored"]) {
      expectQuestion = marker === "restored";
      const result = await client.request(sessionId ? "session/load" : "session/new", { sessionId, cwd: root, mcpServers: [
        transport === "stdio"
          ? { name: "ide", command: process.execPath, args: [script], env: [{ name: "MARKER", value: marker }] }
          : { type: "http", name: "ide", url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, headers: [{ name: "X-Marker", value: marker }] },
      ] });
      expect(result.error).toBeUndefined();
      sessionId ??= result.result.sessionId;
      while ((await client.nextNotification()).params.update.sessionUpdate !== "available_commands_update") {}
      let echoed: { marker: string; cwd: string; pid?: number } | undefined;
      for (const reload of marker === "restored" ? [false] : [false, true]) {
        if (reload) {
          expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/reload" }] }))
            .toMatchObject({ result: { stopReason: "end_turn" } });
          while ((await client.nextNotification()).params.update.sessionUpdate !== "config_option_update") {}
          if (transport === "stdio") expect(() => process.kill(echoed!.pid!, 0)).toThrow();
          else { expect(httpClosed).toBe(true); httpClosed = false; }
        }
        expect(await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Use echo" }] }))
          .toMatchObject({ result: { stopReason: "end_turn" } });
        const updates = [];
        for (;;) {
          const message = await client.nextNotification();
          updates.push(message.params.update);
          if (message.params.update.sessionUpdate === "agent_message_chunk") break;
        }
        echoed = JSON.parse(JSON.parse(updates.at(-1).content.text)[0].text);
        expect(echoed).toMatchObject({ marker, cwd: root });
      }
      if (transport === "stdio" || marker !== "restored") {
        expect(await client.request("session/close", { sessionId })).toHaveProperty("result");
        if (transport === "stdio") expect(() => process.kill(echoed!.pid!, 0)).toThrow();
      } else {
        await client.close();
        expect(httpClosed).toBe(true);
      }
      httpClosed = false;
    }
  } finally {
    await client.close();
    if (http.listening) { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});
