/**
 * The service's own data root — the one directory that is not part of any project.
 *
 * A project holds the operator's work: scenes, the assets they collected, autosaves, backups,
 * packages. This root holds the *service's* own state, which outlives any single project and
 * belongs to none of them — the pointer to the project that is currently open, the allowlist of
 * After Effects roots, the user table, logs and caches.
 *
 * ## Why it is its own module
 *
 * It used to live in `storage.ts`, which `projectWorkspace.ts` imported for it. Now that storage
 * resolves its paths *through* the open project, that dependency would be a cycle: storage needs
 * the project, the project needed storage. Splitting the one thing they both need is what makes
 * the direction one-way — `dataRoot` depends on nothing, `projectWorkspace` depends on it, and
 * `storage` depends on both.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// Four levels: src (or dist) -> project-api -> services -> Editor -> repository
// root. The project API moved a level deeper in the Phase 2 migration, and the data
// root has to keep pointing at the repository's `data/`.
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

/**
 * Resolved once, at import.
 *
 * Every test in this service sets `GRAPIX_DATA_ROOT` before its first import for exactly this
 * reason, and a test that expects to change it later does not get a different root — the module
 * is cached. That is a documented constraint of the suite, not an accident to fix here.
 */
const dataRoot = process.env.GRAPIX_DATA_ROOT?.trim()
  ? path.resolve(process.env.GRAPIX_DATA_ROOT)
  : path.join(workspaceRoot, "data");

/** The service's own state directory. Project content does not live here. */
export function projectDataRoot(): string {
  return dataRoot;
}
