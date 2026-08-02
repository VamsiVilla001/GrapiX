/**
 * Build the publishable CLI bundle.
 *
 * `@grapix/shared-types` is a workspace-private package that is on no registry, so a published
 * `@grapix/editor-mcp` that merely declared it as a dependency would fail to install: npm would
 * look for `@grapix/shared-types@0.1.0` and find nothing. It is therefore **inlined** here.
 *
 * The MCP SDK and zod stay *external*, declared as ordinary dependencies. They are public,
 * resolvable packages, and the SDK is the protocol implementation — a protocol or validation fix
 * should reach users through `npm install`, not require republishing GrapiX.
 *
 * The result is `bundle/grapix-editor-mcp.mjs`: the `bin` target, runnable with no build step and
 * no checkout of this repository. The knowledge corpus is deliberately *not* bundled (session
 * rule 92): it is read from a real checkout so a stale snapshot can never be served.
 */

import { build } from "esbuild";
import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(packageRoot, "bundle", "grapix-editor-mcp.mjs");

await mkdir(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(packageRoot, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod", "zod/*"],
  logLevel: "warning"
});

// npm sets the exec bit for `bin` targets on install, but a directly-cloned or `npm link`ed
// checkout runs this file as-is.
await chmod(outfile, 0o755);

const { size } = await stat(outfile);
process.stdout.write(
  `bundled ${path.relative(packageRoot, outfile)} — ${(size / 1024).toFixed(0)} KiB\n`
);
