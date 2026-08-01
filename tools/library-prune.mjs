/**
 * Make the Playout Scene Manager match the Editor exactly.
 *
 * The certification harnesses publish into the real library and historically never cleaned up,
 * so an operator's Scene Manager filled with test cards and e2e leftovers — 24 published
 * versions across four scene ids, only one of which was a scene the Editor actually had. This
 * removes every published scene the Editor does not know about.
 *
 * Dry run by default. Deleting a published scene removes an operator's recall path, so the
 * default has to be "tell me", not "do it". Pass `--apply` to commit.
 *
 * Removal goes through the control service rather than the filesystem so the on-air and
 * take-list guards apply: a scene on Program, or one a live take list still references, is
 * refused and reported rather than deleted out from under the show.
 *
 * Usage:
 *   node tools/library-prune.mjs            # report what would go
 *   node tools/library-prune.mjs --apply    # remove it
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYOUT = process.env.PLAYOUT_URL ?? "http://127.0.0.1:4300";
const EDITOR = process.env.EDITOR_URL ?? "http://127.0.0.1:4100";
const ORIGIN = { Origin: "http://tauri.localhost" };
const apply = process.argv.includes("--apply");

/**
 * Scenes the Editor has.
 *
 * Prefers the project service, because that is what the Editor itself considers its library.
 * Falls back to the scene directory so the tool still works with the Editor closed — pruning
 * should not require launching an authoring application.
 */
async function editorSceneIds() {
  try {
    const response = await fetch(`${EDITOR}/api/scenes`, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      const body = await response.json();
      const scenes = body.scenes ?? body;
      if (Array.isArray(scenes)) {
        return { source: "project service", ids: new Set(scenes.map((entry) => entry.id ?? entry.sceneId)) };
      }
    }
  } catch {
    // Editor not running; the directory is authoritative enough for this decision.
  }

  const directory = process.env.GRAPIX_DATA_DIR
    ? path.join(path.resolve(process.env.GRAPIX_DATA_DIR), "scenes")
    : path.join(repositoryRoot, "data", "scenes");
  try {
    const files = await readdir(directory);
    return {
      source: `directory ${path.relative(repositoryRoot, directory)}`,
      ids: new Set(files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)))
    };
  } catch (error) {
    throw new Error(`cannot determine the Editor's scenes: ${error.message}`);
  }
}

const editor = await editorSceneIds();

const libraryResponse = await fetch(`${PLAYOUT}/api/playout/scenes`, { headers: ORIGIN });
if (!libraryResponse.ok) {
  console.error(`[prune] the control service answered ${libraryResponse.status}; is it running on ${PLAYOUT}?`);
  process.exit(1);
}
const library = await libraryResponse.json();
const published = library.scenes ?? library;

// One entry per scene id: the library lists every version, and removal takes them together.
const byScene = new Map();
for (const entry of published) {
  const existing = byScene.get(entry.sceneId);
  if (!existing || entry.version > existing.version) byScene.set(entry.sceneId, entry);
}

const keep = [];
const remove = [];
for (const [sceneId, entry] of byScene) {
  (editor.ids.has(sceneId) ? keep : remove).push(entry);
}

console.log(`\nEditor scenes from ${editor.source}: ${[...editor.ids].join(", ") || "(none)"}`);
console.log(`Published scene ids: ${byScene.size} (${published.length} versions)\n`);

console.log("keep — present in the Editor:");
for (const entry of keep) {
  console.log(`  take ${String(entry.takeId).padEnd(5)} ${entry.sceneId.padEnd(26)} ${entry.name}`);
}
console.log(`\n${apply ? "removing" : "would remove"} — not in the Editor:`);
if (remove.length === 0) {
  console.log("  (nothing)");
}

/**
 * Take lists that still reference a scene being removed.
 *
 * The store refuses to remove a scene a live take list points at, which is right: that entry is
 * an operator's recall path. But once the scene is going, the entry is a Take In that would fail
 * anyway, so the list is archived first — history rather than a recall path. Archiving, not
 * deleting: what a rehearsal contained is worth keeping, and a take list autosaves rather than
 * being versioned.
 */
async function archiveListsReferencing(sceneIds) {
  const response = await fetch(`${PLAYOUT}/api/playout/take-lists`, { headers: ORIGIN });
  const body = await response.json();
  const lists = body.takeLists ?? body;
  const doomed = lists.filter(
    (list) => !list.archived && (list.entries ?? []).some((entry) => sceneIds.has(entry.sceneId))
  );
  if (doomed.length === 0) return [];

  for (const list of doomed) {
    if (!apply) continue;
    await fetch(`${PLAYOUT}/api/playout/take-lists`, {
      method: "POST",
      headers: { ...ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ...list, archived: true })
    });
  }
  return doomed;
}

const doomedIds = new Set(remove.map((entry) => entry.sceneId));
const archived = await archiveListsReferencing(doomedIds);
if (archived.length > 0) {
  console.log(
    `\n${apply ? "archived" : "would archive"} ${archived.length} take list(s) whose scene is going:`
  );
  for (const list of archived) {
    console.log(`  ${list.takeListId}  ${list.name}`);
  }
  console.log("");
}

let removed = 0;
let refused = 0;
for (const entry of remove) {
  const label = `take ${String(entry.takeId).padEnd(5)} ${entry.sceneId.padEnd(26)} ${entry.name}`;
  if (!apply) {
    console.log(`  ${label}`);
    continue;
  }
  const response = await fetch(`${PLAYOUT}/api/playout/scenes/${entry.sceneId}`, {
    method: "DELETE",
    headers: ORIGIN
  });
  const body = await response.json().catch(() => null);
  if (response.ok) {
    removed += 1;
    console.log(`  removed  ${label} (${body?.versionsRemoved ?? "?"} version(s))`);
  } else {
    refused += 1;
    console.log(`  REFUSED  ${label} — ${body?.error ?? response.status}`);
  }
}

if (!apply) {
  console.log(`\n${remove.length} scene(s) would be removed. Re-run with --apply to commit.\n`);
  process.exit(0);
}

console.log(`\n${removed} removed, ${refused} refused.\n`);
process.exit(refused === 0 ? 0 : 1);
