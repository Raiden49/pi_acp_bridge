import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["tests/*.test.ts"],
  outDir: ".scratch/acp-tests",
  format: ["esm"],
  target: "node22",
  removeNodeProtocol: false,
  splitting: false,
  sourcemap: false,
  clean: true,
});
