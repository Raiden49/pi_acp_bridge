import { build, defineConfig } from "tsup";
import { copyFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdkRequire = createRequire(sdkEntry);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  // Prefix-only builtins such as node:sqlite must not become package imports.
  removeNodeProtocol: false,
  target: "node22",
  clean: true,
  splitting: false,
  minify: true,
  // Use Pi's embedded module loader for user extensions in the standalone bundle.
  define: { PI_BUNDLED_NODE: "true" },
  banner: { js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);' },
  noExternal: [/.*/],
  // Follow Pi's Node release build: the codemode worker is a separate,
  // self-contained entry without a createRequire/import.meta banner.
  onSuccess: async () => {
    await build({ config: false, entry: { "codemode-worker": join(dirname(sdkEntry), "extensions/codemode/worker.js") },
      outDir: "dist", format: ["esm"], platform: "node", target: "node22", splitting: false,
      minify: true, clean: false, noExternal: [/.*/], removeNodeProtocol: false });
    const worker = await readFile("dist/codemode-worker.js", "utf8");
    if (worker.includes("import.meta")) throw new Error("Codemode worker must run from Pi's data URL without import.meta");
    await copyFile(sdkRequire.resolve("quickjs-wasi/quickjs.wasm"), "dist/quickjs.wasm");
  },
  esbuildPlugins: [{
    name: "codemode-wasm-sidecar",
    setup(build) {
      build.onLoad({ filter: /[/\\]pi-coding-agent[/\\]dist[/\\]config\.js$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const lookup = 'createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")';
        const versionExport = 'export const VERSION = pkg.version || "0.0.0";';
        if (!source.includes(lookup) || !source.includes(versionExport)) throw new Error("Pi config changed; update the standalone asset/version adapter");
        // Once bundled, Pi's upward package lookup finds the Bridge package instead.
        const sdkPackage = JSON.parse(await readFile(join(dirname(path), "../package.json"), "utf8"));
        if (sdkPackage.name !== "@earendil-works/pi-coding-agent" || !sdkPackage.version) throw new Error("Cannot identify bundled Pi SDK");
        return { contents: source.replace(lookup, 'fileURLToPath(new URL("./quickjs.wasm", import.meta.url))')
          .replace(versionExport, `export const VERSION = ${JSON.stringify(sdkPackage.version)};`), loader: "js", resolveDir: dirname(path) };
      });
    },
  }, {
    name: "embed-photon-wasm",
    setup(build) {
      build.onLoad({ filter: /[/\\]photon-node[/\\]photon_rs\.js$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const loader = "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');\nconst bytes = require('fs').readFileSync(path);";
        if (!source.includes(loader)) throw new Error("Photon WASM loader changed; update the standalone bundle adapter");
        const wasm = gzipSync(await readFile(join(dirname(path), "photon_rs_bg.wasm"))).toString("base64");
        return {
          contents: source.replace(loader, `const bytes = require('node:zlib').gunzipSync(Buffer.from('${wasm}', 'base64'));`),
          loader: "js", resolveDir: dirname(path),
        };
      });
    },
  }],
});
