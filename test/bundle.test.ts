import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("production bundle is optimized and initializes without adjacent dependencies", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/bundle-"));
  try {
    await exec(process.execPath, [resolve("node_modules/tsup/dist/cli-default.js")], { timeout: 20_000 });
    const bundle = await readFile("dist/index.js", "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(Buffer.byteLength(bundle)).toBeLessThan(10_000_000);
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
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: resolve(root, "agent") }, timeout: 10_000,
    });
    const lines = createInterface({ input: child.child.stdout! });
    const response = once(lines, "line");
    child.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
    await Promise.race([response, child.then(() => { throw new Error("CLI exited before handshake"); })]);
    child.child.stdin!.end();
    const { stdout } = await child;
    lines.close();
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ agentInfo: { name: "pi-acp-bridge", version: "0.1.0" } }) }),
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
