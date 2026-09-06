/**
 * Bundle the bridge into what Figma can load.
 *
 * A Figma plugin runs in a sandbox with no module loader, so `code.js` has to be one file with the
 * shared converter inlined — which is the whole reason this script exists rather than a `tsc`
 * invocation. `@grapix/shared-types` resolves through the workspace symlink in the root
 * `node_modules`, so the bundled converter is the same code the test suite runs, not a copy that
 * can drift from it.
 *
 * esbuild does not typecheck, and nothing here asks it to: the plugin globals (`figma`,
 * `__html__`) come from `@figma/plugin-typings`, a plugin-only dependency the monorepo does not
 * carry. Everything worth typechecking lives in `Shared/shared-types/src/figmaMotionBridge.ts`,
 * which the `Shared` workspace builds and tests on every run.
 */
import { build } from "esbuild";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(packageRoot, "dist");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(packageRoot, "src", "code.ts")],
  outfile: path.join(outDir, "code.js"),
  bundle: true,
  // The plugin sandbox is not a browser and not Node: no module syntax, no Node built-ins.
  format: "iife",
  platform: "neutral",
  target: "es2017",
  logLevel: "warning"
});

await copyFile(path.join(packageRoot, "src", "ui.html"), path.join(outDir, "ui.html"));

const { size } = await stat(path.join(outDir, "code.js"));
process.stdout.write(`figma-motion-bridge: dist/code.js ${(size / 1024).toFixed(1)} kB, dist/ui.html copied\n`);
