import { defineConfig } from "tsup";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

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
  esbuildPlugins: [{
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
