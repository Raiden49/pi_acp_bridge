import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  splitting: false,
  minify: true,
  // Use Pi's embedded module loader for user extensions in the standalone bundle.
  define: { PI_BUNDLED_NODE: "true" },
  banner: { js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);' },
  noExternal: [/.*/],
});
