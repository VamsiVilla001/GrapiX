/**
 * Remove every `dist/` directory before a full build.
 *
 * `tsc` emits but never prunes: delete a source file and its compiled `.js` and `.d.ts` stay in
 * `dist/` forever. That is not cosmetic. When the protocol v2 daemon was retired,
 * `project-api/dist/renderDaemon.js` and `playout-control/dist/rendererClient.js` survived the
 * deletion of their sources — compiled v2 code, importing a package that no longer exists,
 * sitting in the directory a long-lived service loads from. Nothing imported them, so nothing
 * failed; the repository just kept shipping the corpse of a renderer that had been removed.
 *
 * Wired into the root `build` so a full build is always a clean one. Per-package `npm run build`
 * stays incremental and fast.
 */

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Directories whose immediate children are packages owning a `dist/`. Listed rather than
 * discovered by a recursive walk so a stray `dist/` somewhere unexpected is never silently
 * deleted.
 */
const PACKAGE_PARENTS = [
  "Shared",
  "Editor/apps",
  "Editor/services",
  "Playout/apps",
  "Playout/services"
];

let removed = 0;

for (const parent of PACKAGE_PARENTS) {
  const absolute = path.join(repositoryRoot, parent);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    // A workspace folder that does not exist is not an error; the layout may differ.
    continue;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dist = path.join(absolute, entry.name, "dist");
    try {
      rmSync(dist, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      // A dist that cannot be removed is worth naming: the next build would layer new output
      // over stale files, which is the exact failure this script exists to prevent.
      console.error(`[clean-dist] could not remove ${dist}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

console.log(`[clean-dist] cleared build output under ${removed} package(s)`);
