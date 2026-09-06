import { build } from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(packageRoot, "dist", "bundle", "grapix-api-server.mjs");

await mkdir(path.dirname(outfile), { recursive: true });

// Fastify (and its dependency avvio) uses `require("node:events")` at runtime — a
// dynamic require, which esbuild rewrites into a shim that throws under ESM. Two things
// unstick it together: give the bundle a real `require` via `createRequire`, and leave
// every Node built-in module external so the shim never has to resolve one.
await build({
  entryPoints: [path.join(packageRoot, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@napi-rs/canvas"],
  banner: {
    // `require` for Fastify/avvio's dynamic requires; `__filename`/`__dirname` for the
    // inlined TypeScript compiler (sceneScriptImporter) — its `getNodeSystem` reads
    // `__filename` at module load, which does not exist in an ESM bundle and crashed
    // every packaged boot of this service.
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fup(import.meta.url); const __dirname = __dn(__filename);"
  },
  logLevel: "warning"
});

const { size } = await stat(outfile);
process.stdout.write(
  `[api-server] bundled ${path.relative(packageRoot, outfile)} — ${(size / 1024).toFixed(0)} KiB\n`
);
