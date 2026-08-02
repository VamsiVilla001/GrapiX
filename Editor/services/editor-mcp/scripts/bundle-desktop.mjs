/**
 * Fully self-contained desktop bundle.
 *
 * `bundle.mjs` produces the publishable CLI with MCP SDK + zod external, because those are
 * resolvable npm packages when the CLI is installed by hand. The desktop shell ships with
 * no npm install step, so this bundle inlines everything into one file the Tauri supervisor
 * can spawn directly.
 */

import { build } from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Deliberately the same basename it must have once installed. Tauri's MSI packaging
// records the *source* file name in the WiX File table and ignores a `bundle.resources`
// rename, so a source called `...-desktop.mjs` installs under that name and the
// supervisor's lookup misses it — which is how the packaged MCP server went missing.
const outfile = path.join(packageRoot, "dist", "bundle", "grapix-editor-mcp.mjs");

await mkdir(path.dirname(outfile), { recursive: true });

// Inlined CommonJS dependencies call `require` at runtime; esbuild's ESM shim throws
// unless a real `require` is in scope, which the banner supplies.
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
  `[editor-mcp] bundled ${path.relative(packageRoot, outfile)} — ${(size / 1024).toFixed(0)} KiB\n`
);
