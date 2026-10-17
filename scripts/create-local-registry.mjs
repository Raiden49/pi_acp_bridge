import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, accessSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Generate local artifacts only; never edit IDE settings or installed agents.
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('This launcher supports macOS only. Use direct ACP configuration on other platforms.');
}
if (process.argv.length > 3) throw new Error('Usage: node scripts/create-local-registry.mjs [base-registry.json]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist/index.js');
const icon = join(root, 'assets/icon.svg');
accessSync(bundle);
accessSync(icon);
async function publicRegistry() {
  const response = await fetch('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Public registry request failed: ${response.status}`);
  return response.json();
}
const registry = process.argv[2]
  ? JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'))
  : await publicRegistry();
if (!['1', '1.0.0'].includes(registry.version) || !Array.isArray(registry.agents)) {
  throw new Error('Expected a version 1 ACP registry with an agents array.');
}
const output = join(root, '.scratch/local-registry');
const archive = join(output, 'launcher.zip');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'launch'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bundle)} "$@"\n`);
chmodSync(join(output, 'launch'), 0o755);
rmSync(archive, { force: true });
execFileSync('/usr/bin/zip', ['-q', '-X', archive, 'launch'], { cwd: output });
const agent = {
  id: 'pi-acp-bridge-local',
  name: 'Pi Bridge',
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  description: 'Pi ACP Bridge from a local checkout',
  authors: ['Raiden'],
  license: 'proprietary',
  icon: pathToFileURL(icon).href,
  distribution: {
    binary: {
      [`darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`]: {
        archive: pathToFileURL(archive).href,
        sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
        cmd: './launch',
        args: [],
        env: {},
      },
    },
  },
};
registry.agents = registry.agents.filter((entry) => entry.id !== agent.id);
registry.agents.push(agent);
const path = join(output, 'registry.json');
writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
console.log(`Registry: ${path}\nNode: ${process.execPath}\nAgents: ${registry.agents.length}`);
console.log('No IDE settings changed. This is a local catalog snapshot, not a live public registry.');
