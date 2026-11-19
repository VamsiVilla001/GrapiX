#!/usr/bin/env node
// One source for the web pieces both apps carry (build plan 2.27).
//
// `Shared/web-panels/*.js` (and its `.d.ts`) is the source. An app serves its own `web/` folder
// (Tauri `frontendDist`), so the file has to be inside it: this copies the source
// into `Playout/web/` under a generated header, and `--check`
// fails when a copy differs from what the source would produce (the same idea as
// `codegen:check`). Edit the source, never the copies.
//
//   node tools/sync-shared-web.mjs           write the copies
//   node tools/sync-shared-web.mjs --check   fail if a copy is missing or edited

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = "Shared/web-panels";
// Playout only: live telemetry is an operator feature; the Editor has nothing to do with live broadcast.
const TARGETS = ["Playout/web"];

/** The text a copy of `name` must hold, given its source text. */
export function generated(name, source) {
  return (
    `// GENERATED from ${SOURCE_DIR}/${name} by tools/sync-shared-web.mjs. Do not edit: edit the source and run \`npm run sync:web\`.\n` +
    source.replace(/\r\n/g, "\n")
  );
}

/** Every copy that should exist: `[path, expected text]`. Pure over the file reads it is given. */
export function plan(sources) {
  return sources.flatMap(({ name, source }) => TARGETS.map((target) => [`${target}/${name}`, generated(name, source)]));
}

/** The copies that are missing or differ: `[path, "missing" | "edited"]`. */
export function drift(expected, read) {
  const problems = [];
  for (const [path, text] of expected) {
    const held = read(path);
    if (held === undefined) problems.push([path, "missing"]);
    else if (held.replace(/\r\n/g, "\n") !== text) problems.push([path, "edited"]);
  }
  return problems;
}

function main() {
  const check = process.argv.includes("--check");
  const sources = readdirSync(join(ROOT, SOURCE_DIR))
    .filter((name) => name.endsWith(".js") || name.endsWith(".d.ts"))
    .map((name) => ({ name, source: readFileSync(join(ROOT, SOURCE_DIR, name), "utf8") }));
  const expected = plan(sources);
  const read = (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : undefined);
  if (check) {
    const problems = drift(expected, read);
    for (const [path, why] of problems) console.error(`${path}: ${why}; run npm run sync:web`);
    if (problems.length > 0) process.exit(1);
    console.log(`sync:web ok (${expected.length} copies match ${SOURCE_DIR})`);
    return;
  }
  for (const [path, text] of expected) writeFileSync(join(ROOT, path), text);
  console.log(`sync:web wrote ${expected.length} copies`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
