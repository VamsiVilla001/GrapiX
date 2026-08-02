/**
 * Stages the native dependencies the service bundles cannot inline.
 *
 * esbuild can inline pure JavaScript, but not a native addon: `@napi-rs/canvas` loads a
 * `.node` binary (Skia) plus an ICU data file, so `bundle.mjs` marks it external. External
 * means "resolve it from node_modules at runtime" — which works in a checkout and fails in
 * an install, where the bundle sits in a flat `services/` directory with no node_modules
 * anywhere above it. The project service then dies on start-up with
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@napi-rs/canvas'`.
 *
 * Node resolves `node_modules` by walking up from the importing file, so a `node_modules`
 * beside the bundle is all that is required. The staged tree is copied into the installer
 * as `services/node_modules/`.
 *
 * Only the binding for the host platform is staged. Shipping all ten would add roughly
 * 300 MB of binaries that can never load on the target machine.
 */

import { cp, mkdir, rm, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The npm platform suffix napi-rs uses, matching `process.platform`/`process.arch`. */
function platformSuffix() {
  const key = `${process.platform}-${process.arch}`;
  const map = {
    "win32-x64": "win32-x64-msvc",
    "win32-arm64": "win32-arm64-msvc",
    "darwin-x64": "darwin-x64",
    "darwin-arm64": "darwin-arm64",
    "linux-x64": "linux-x64-gnu",
    "linux-arm64": "linux-arm64-gnu"
  };
  const suffix = map[key];
  if (!suffix) throw new Error(`no @napi-rs/canvas binding is published for ${key}`);
  return suffix;
}

/**
 * External packages per staging target. Kept beside the bundle scripts' `external` lists
 * deliberately: a package added there without being added here ships a bundle that cannot
 * start, so this list is the other half of that decision.
 */
const targets = [
  {
    label: "api-server",
    stageRoot: path.join(
      repositoryRoot,
      "Editor",
      "services",
      "project-api",
      "dist",
      "bundle",
      "node_modules"
    ),
    packages: ["@napi-rs/canvas", `@napi-rs/canvas-${platformSuffix()}`]
  }
];

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    total += (await stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
  }
  return total;
}

for (const target of targets) {
  await rm(target.stageRoot, { recursive: true, force: true });

  for (const name of target.packages) {
    // Resolve through the package manifest rather than guessing a path, so a hoisted or
    // nested install both work.
    const manifest = require.resolve(`${name}/package.json`);
    const source = path.dirname(manifest);
    const destination = path.join(target.stageRoot, ...name.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    // `dereference` because a pnpm-style store links packages; the installer must carry
    // real files, not links into a directory that will not exist on the target machine.
    await cp(source, destination, { recursive: true, dereference: true });
  }

  const bytes = await directorySize(target.stageRoot);
  process.stdout.write(
    `[native] ${target.label}: staged ${target.packages.length} packages — ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MiB into ${path.relative(repositoryRoot, target.stageRoot)}\n`
  );
}
