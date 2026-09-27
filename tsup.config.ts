import { defineConfig } from "tsup";

export default defineConfig([
  // The npm package: ESM, types, dependencies left external (npm installs them).
  {
    entry: { index: "src/index.ts", stdio: "src/stdio.ts", http: "src/http.ts" },
    format: ["esm"],
    target: "node20",
    dts: true,
    clean: true,
    sourcemap: true,
  },
  // The hosted server's Lambda artifact: one self-contained file, no node_modules to ship.
  {
    entry: { lambda: "src/lambda.ts" },
    outDir: "dist-lambda",
    format: ["esm"],
    target: "node22",
    platform: "node",
    noExternal: [/.*/],
    splitting: false,
    clean: true,
    outExtension: () => ({ js: ".mjs" }),
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  },
]);
