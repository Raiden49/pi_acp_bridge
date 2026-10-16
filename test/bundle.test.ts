import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("standalone production bundle initializes and loads configured provider extensions", async () => {
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
    await writeFile(resolve(agentDir, "extensions/provider.ts"), `
      import { Type } from '@sinclair/typebox';
      export default function (pi) {
        const schema = Type.String();
        pi.registerCommand('bundle-extension', { description: schema.type, handler: async () => {} });
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
      const session = await request(2, "session/new", { cwd: root, mcpServers: [] });
      expect(session.result?.configOptions[0]?.options).toContainEqual({ value: "bundle-provider/extension-model", name: "Extension model (bundle-provider)" });
      const commands = messages.find((message) => message.params?.update?.sessionUpdate === "available_commands_update");
      expect(commands?.params.update.availableCommands).toContainEqual({ name: "bundle-extension", description: "string" });
    } finally {
      child.child.stdin!.end();
      await child;
      lines.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
