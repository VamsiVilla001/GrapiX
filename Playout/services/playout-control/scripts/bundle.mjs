import { build } from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(packageRoot, "dist", "bundle", "grapix-playout-control.mjs");

await mkdir(path.dirname(outfile), { recursive: true });

// Fastify's dependency avvio calls `require("node:events")` at runtime. esbuild rewrites
// that into a shim which throws under ESM unless a real `require` is in scope, so the
// banner supplies one via `createRequire`.
await build({
  entryPoints: [path.join(packageRoot, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  logLevel: "warning"
});

const { size } = await stat(outfile);
process.stdout.write(
  `[playout-control] bundled ${path.relative(packageRoot, outfile)} — ${(size / 1024).toFixed(0)} KiB\n`
);
