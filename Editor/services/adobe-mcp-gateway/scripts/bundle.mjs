import { build } from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(packageRoot, "dist", "bundle", "grapix-adobe-mcp-gateway.mjs");

await mkdir(path.dirname(outfile), { recursive: true });

// `ws` and the Adobe AIO libraries are CommonJS and call `require` at runtime; esbuild's
// ESM shim throws unless a real `require` is in scope, which the banner supplies.
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
  `[adobe-mcp-gateway] bundled ${path.relative(packageRoot, outfile)} — ${(size / 1024).toFixed(0)} KiB\n`
);
