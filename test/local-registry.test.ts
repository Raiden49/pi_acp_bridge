import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test.runIf(process.platform === "darwin")("registry generation preserves the public catalog and never falls back to an empty one", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/registry-test-"));
  try {
    await Promise.all(["scripts", "assets", "dist"].map((dir) => mkdir(resolve(root, dir))));
    const script = resolve(root, "scripts/create-local-registry.mjs");
    await cp("scripts/create-local-registry.mjs", script);
    await cp("assets/icon.svg", resolve(root, "assets/icon.svg"));
    await cp("package.json", resolve(root, "package.json"));
    await writeFile(resolve(root, "dist/index.js"), "// Fixture bundle\n");
    const publicAgent = { id: "public-agent", name: "Public Agent", icon: "https://example.invalid/icon.svg", distribution: { npx: { package: "fixture@1" } } };
    const preload = resolve(root, "fetch.mjs");
    await writeFile(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ version: "1", agents: [publicAgent] }))});`);
    await exec(process.execPath, ["--import", preload, script], { timeout: 5000 });
    const path = resolve(root, ".scratch/local-registry/registry.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    expect(registry.agents).toContainEqual(publicAgent);
    expect(registry.agents).toHaveLength(2);
    expect(registry.agents[1]).toMatchObject({ id: "pi-acp-bridge-local", name: "Pi Bridge", icon: expect.stringMatching(/^file:/) });
    await writeFile(preload, 'globalThis.fetch = async () => { throw new Error("Offline fixture"); };');
    // An explicit snapshot works offline and repeated generation does not duplicate entries.
    await exec(process.execPath, ["--import", preload, script, path], { timeout: 5000 });
    const saved = await readFile(path, "utf8");
    // ZIP entry timestamps can change; metadata must match the newly generated archive.
    const platform = `darwin-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
    registry.agents[1].distribution.binary[platform].sha256 = createHash("sha256")
      .update(await readFile(resolve(root, ".scratch/local-registry/launcher.zip"))).digest("hex");
    expect(JSON.parse(saved).agents).toEqual(registry.agents);
    await expect(exec(process.execPath, ["--import", preload, script], { timeout: 5000 })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});
