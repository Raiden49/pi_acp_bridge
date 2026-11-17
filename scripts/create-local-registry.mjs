import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, accessSync } from 'node:fs';
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
const output = join(root, 'dist/local-registry');
const archive = join(output, 'launcher.zip');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
// Keep the runtime stable across regenerations: an explicit override wins, then the
// runtime recorded in the previous launcher, then the runtime executing this script.
function launchNode() {
  const previous = join(output, 'launch');
  const recorded = [process.env.PI_BRIDGE_NODE, (() => {
    try {
      const match = readFileSync(previous, 'utf8').match(/^exec '((?:[^']|'\\'')*)'/m);
      return match?.[1].replaceAll("'\\''", "'");
    } catch {}
  })()].find((candidate) => {
    try {
      if (candidate) accessSync(candidate);
      return Boolean(candidate);
    } catch { return false; }
  });
  return recorded ?? process.execPath;
}
const node = launchNode();
const bundleSha = createHash('sha256').update(readFileSync(bundle)).digest('hex');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'launch'), `#!/bin/sh\n# bundle-sha256: ${bundleSha}\nexec ${quote(node)} ${quote(bundle)} "$@"\n`);
chmodSync(join(output, 'launch'), 0o755);
// Fixed mtime keeps the archive hash stable when only the catalog snapshot changes.
utimesSync(join(output, 'launch'), new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
rmSync(archive, { force: true });
execFileSync('/usr/bin/zip', ['-q', '-X', archive, 'launch'], { cwd: output });
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const platformKey = `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
const archiveHref = pathToFileURL(archive).href;
const officialAgy = registry.agents.find((entry) => entry.id === 'antigravity-acp');
const localEntry = ({ id, name, description, authors, icon: entryIcon, args }) => ({
  id,
  name,
  version: pkgVersion,
  description,
  authors,
  license: 'proprietary',
  icon: entryIcon,
  distribution: {
    binary: {
      [platformKey]: {
        archive: archiveHref,
        sha256,
        cmd: './launch',
        args,
        env: {},
      },
    },
  },
});
const agent = localEntry({
  id: 'pi-acp-bridge-local',
  name: 'Pi Bridge',
  description: 'Pi ACP Bridge from a local checkout',
  authors: ['Raiden'],
  icon: pathToFileURL(icon).href,
  args: [],
});
const agyAgent = localEntry({
  id: 'pi-acp-bridge-agy-local',
  name: 'Antigravity (Pi Bridge)',
  description: 'Google Antigravity ACP with Pi AGENTS.md',
  authors: ['Google LLC', 'Raiden'],
  icon: officialAgy?.icon ?? 'https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg',
  args: ['--agy'],
});
registry.agents = registry.agents.filter((entry) => ![agent.id, agyAgent.id].includes(entry.id));
registry.agents.push(agent, agyAgent);
const path = join(output, 'registry.json');
writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
console.log(`Registry: ${path}\nNode: ${node}\nAgents: ${registry.agents.length}`);
console.log('No IDE settings changed. This is a local catalog snapshot, not a live public registry.');
