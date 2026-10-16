import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("standalone production bundle loads extensions, derives OAuth auth and cleans up MCP", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/bundle-"));
  try {
    await exec(process.execPath, [resolve("node_modules/tsup/dist/cli-default.js")], { timeout: 20_000 });
    const bundle = await readFile("dist/index.js", "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(Buffer.byteLength(bundle)).toBeLessThan(10_000_000);
    const agentDir = resolve(root, "agent");
    await mkdir(resolve(agentDir, "extensions"), { recursive: true });
    await writeFile(resolve(agentDir, "models.json"), JSON.stringify({ providers: {
      baseline: { baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "test-only",
        models: [{ id: "baseline-model" }] },
    } }));
    const oauthPath = resolve(root, "oauth.json");
    await writeFile(oauthPath, JSON.stringify({ openai: {
      type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
    } }));
    await writeFile(resolve(agentDir, "extensions/provider.ts"), `
      import { Type } from '@sinclair/typebox';
      import { ModelRuntime, resizeImage } from '@earendil-works/pi-coding-agent';
      import { writeFileSync } from 'node:fs';
      export default function (pi) {
        const schema = Type.String();
        pi.registerCommand('bundle-extension', { description: schema.type, handler: async () => {} });
        pi.registerCommand('bundle-image', { description: 'Verify bundled image processing', handler: async () => {
          const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
          const result = await resizeImage(bytes, 'image/png');
          if (!result || result.width !== 1 || result.height !== 1) throw new Error('Image processing failed');
          writeFileSync(${JSON.stringify(resolve(root, "image-success"))}, 'ok');
        } });
        pi.registerCommand('bundle-oauth', { description: 'Verify bundled OAuth', handler: async () => {
          const runtime = await ModelRuntime.create({ authPath: ${JSON.stringify(oauthPath)},
            modelsPath: ${JSON.stringify(resolve(root, "absent-models.json"))},
            refreshOnCreate: false, allowModelNetwork: false });
          const result = await runtime.getAuth('openai');
          if (result?.auth.apiKey !== 'fixture-access') throw new Error('OAuth derivation failed');
          writeFileSync(${JSON.stringify(resolve(root, "oauth-success"))}, 'ok');
        } });
        pi.registerProvider('bundle-provider', {
          baseUrl: 'https://example.invalid/v1', api: 'openai-completions', apiKey: 'test-only',
          models: [{ id: 'extension-model', name: 'Extension model', reasoning: false,
            input: ['text'], contextWindow: 4096, maxTokens: 512,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        });
      }
    `);
    const entry = resolve(root, "bridge.mjs");
    await cp("dist/index.js", entry);
    // Reject external module loads even though the fixture lives inside the repo.
    const script = `import { registerHooks, isBuiltin } from 'node:module';
      const entry = ${JSON.stringify(`file://${entry}`)};
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (result.url !== entry && !isBuiltin(result.url)) throw new Error('External dependency: ' + result.url);
        return result;
      } });
      globalThis.fetch = async () => { throw new Error('Network forbidden in bundle regression'); };
      await import(entry);`;
    const child = exec(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, timeout: 10_000,
    });
    const lines = createInterface({ input: child.child.stdout! });
    const pending = new Map<number, (message: any) => void>();
    const messages: any[] = [];
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      messages.push(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    async function request(id: number, method: string, params: unknown) {
      const response = new Promise<any>((resolve) => pending.set(id, resolve));
      child.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return Promise.race([response, child.then(() => { throw new Error("CLI exited before response"); })]);
    }
    try {
      expect(await request(1, "initialize", { protocolVersion: 1, clientCapabilities: {} }))
        .toMatchObject({ result: { agentInfo: { name: "pi-acp-bridge", version: "0.1.0" } } });
      const pidFile = resolve(root, "mcp.pid");
      const mcpScript = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        const lines = require('node:readline').createInterface({ input: process.stdin });
        lines.on('line', line => { const m = JSON.parse(line); if (m.id === undefined) return;
          const result = m.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : { tools: [] };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
        });
        lines.on('close', () => process.exit(0));`;
      const session = await request(2, "session/new", { cwd: root, mcpServers: [
        { name: "ide", command: process.execPath, args: ["-e", mcpScript], env: [] },
      ] });
      expect(session.result?.configOptions[0]?.options).toContainEqual({ value: "bundle-provider/extension-model", name: "Extension model (bundle-provider)" });
      const commands = messages.find((message) => message.params?.update?.sessionUpdate === "available_commands_update");
      expect(commands?.params.update.availableCommands).toContainEqual({ name: "bundle-extension", description: "string" });
      let pid = "";
      for (let attempt = 0; attempt < 50 && !pid; attempt++) {
        pid = await readFile(pidFile, "utf8").catch(() => "");
        if (!pid) await delay(10);
      }
      expect(pid).not.toBe("");
      expect(await request(3, "session/prompt", {
        sessionId: session.result.sessionId, prompt: [{ type: "text", text: "/bundle-oauth" }],
      })).toMatchObject({ result: { stopReason: "end_turn" } });
      expect(await readFile(resolve(root, "oauth-success"), "utf8").catch(() => "not-derived")).toBe("ok");
      expect(await request(4, "session/prompt", {
        sessionId: session.result.sessionId, prompt: [{ type: "text", text: "/bundle-image" }],
      })).toMatchObject({ result: { stopReason: "end_turn" } });
      expect(await readFile(resolve(root, "image-success"), "utf8").catch(() => "not-processed")).toBe("ok");
      expect(commands?.params.update.availableCommands.map((command: { name: string }) => command.name))
        .toEqual(expect.arrayContaining(["session", "reload", "compact"]));
      expect(await request(5, "session/prompt", {
        sessionId: session.result.sessionId, prompt: [{ type: "text", text: "/session" }],
      })).toMatchObject({ result: { stopReason: "end_turn" } });
      expect(messages.some((message) => message.params?.update?.content?.text?.includes("Pi 会话"))).toBe(true);
      expect(await request(6, "session/prompt", {
        sessionId: session.result.sessionId, prompt: [{ type: "text", text: "/reload" }],
      })).toMatchObject({ result: { stopReason: "end_turn" } });
      expect(() => process.kill(Number(pid), 0)).toThrow();
      const previousPid = pid;
      for (let attempt = 0; attempt < 50 && pid === previousPid; attempt++) {
        pid = await readFile(pidFile, "utf8");
        if (pid === previousPid) await delay(10);
      }
      expect(pid).not.toBe(previousPid);
      child.child.kill("SIGTERM");
      await child;
      expect(() => process.kill(Number(pid), 0)).toThrow();
    } finally {
      child.child.stdin!.end();
      await child;
      lines.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
