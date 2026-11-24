#!/usr/bin/env node
// The tracker generated from the plan (build plan 0.13).
//
// `GrapiX-Build-Plan.md` holds every row's text; `progress.json` holds every row's status;
// `progress.html` embeds both so the page works from a file. The embedded copies are generated:
// closing a row is a plan edit and a status edit, then `npm run sync:tracker`. `--check` fails
// when the three disagree, so the gate sees drift the first time it happens.
//
//   node tools/sync-tracker.mjs           rewrite the embedded rows and statuses
//   node tools/sync-tracker.mjs --check   fail on drift
//
// What comes from where:
//   - each row's name, track, needs and done-when: the plan's table row, backticks removed;
//   - each module's place in the page (title, note, milestone, side): kept from the page, which
//     is the only copy of that wording; a module the plan has and the page lacks is an error;
//   - each row's status: `progress.json`. A status for a row the plan does not have is an error.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROW = /^\| `([\d.]+)` \| (.*?) \| (CON|PLAT|BE|UI|RES|EXT|AI) \| (.*?) \| (.*) \|$/;
const MODULE = /^### Module ([A-Z]\d+) — /;
const PLAN_LINE = /^const PLAN = (\[.*\]);[ \t]*$/m;
const STATE_BLOCK = /const INITIAL_STATE = \{\n([\s\S]*?)\n\};/;
const STATUSES = new Set(["done", "active", "blocked", "pending"]);
const plain = (text) => text.replaceAll("`", "");

/** Every row of the plan, in order, with the module it sits in. */
export function parsePlan(md) {
  const rows = [];
  let module = null;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(MODULE);
    if (heading) module = heading[1];
    if (!line.startsWith("| `")) continue;
    const m = line.match(ROW);
    if (!m) throw new Error(`a plan row does not parse: ${line.slice(0, 80)}`);
    if (module === null) throw new Error(`row ${m[1]} is outside any module`);
    rows.push({ module, id: m[1], name: plain(m[2]), track: m[3], dep: plain(m[4]), done: plain(m[5]) });
  }
  return rows;
}

/** The embedded modules and the embedded statuses of a page. */
export function parsePage(html) {
  const text = html.replace(/\r\n/g, "\n");
  const plan = text.match(PLAN_LINE);
  const block = text.match(STATE_BLOCK);
  if (!plan || !block) throw new Error("progress.html has no `const PLAN` line or `INITIAL_STATE` block");
  const state = {};
  for (const line of block[1].split("\n")) {
    const code = line.split("//")[0];
    for (const m of code.matchAll(/"([\d.]+)":\s*"(\w+)"/g)) state[m[1]] = m[2];
  }
  return { modules: JSON.parse(plan[1]), state };
}

/** The modules as the plan says they should be: the page's wording, the plan's rows. */
export function expectedModules(modules, rows) {
  const known = new Set(modules.map((m) => m.id));
  for (const row of rows) if (!known.has(row.module)) throw new Error(`row ${row.id} is in module ${row.module}, which progress.html does not have`);
  return modules.map((m) => ({
    ...m,
    steps: rows.filter((r) => r.module === m.id).map(({ id, name, track, dep, done }) => ({ id, name, track, dep, done })),
  }));
}

/** What is wrong, as strings: row text, row set and order, statuses on both sides. */
export function drift(rows, modules, htmlState, jsonState) {
  const problems = [];
  const want = expectedModules(modules, rows);
  const have = new Map(modules.flatMap((m) => m.steps.map((s) => [s.id, { ...s, module: m.id }])));
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const held = have.get(row.id);
    if (!held) {
      problems.push(`row ${row.id} is in the plan but not in progress.html`);
      continue;
    }
    for (const field of ["name", "track", "dep", "done"]) {
      if (held[field] !== row[field]) problems.push(`row ${row.id}: ${field} differs between the plan and progress.html`);
    }
    if (held.module !== row.module) problems.push(`row ${row.id}: module ${row.module} in the plan, ${held.module} in progress.html`);
  }
  for (const id of have.keys()) if (!ids.has(id)) problems.push(`row ${id} is in progress.html but not in the plan`);
  if (!problems.length && JSON.stringify(want) !== JSON.stringify(modules)) problems.push("progress.html lists the rows in a different order from the plan");
  for (const [where, state] of [["progress.json", jsonState], ["progress.html", htmlState]]) {
    for (const [id, status] of Object.entries(state)) {
      if (!ids.has(id)) problems.push(`${where} has a status for ${id}, which is not a row of the plan`);
      if (!STATUSES.has(status)) problems.push(`${where}: ${id} has the status "${status}"`);
    }
  }
  for (const id of new Set([...Object.keys(jsonState), ...Object.keys(htmlState)])) {
    if (jsonState[id] !== htmlState[id]) problems.push(`row ${id}: ${jsonState[id] ?? "no status"} in progress.json, ${htmlState[id] ?? "no status"} in progress.html`);
  }
  return problems;
}

/** The page with its embedded rows and statuses regenerated. Comments in the state block stay. */
export function regenerate(html, rows, jsonState) {
  const crlf = html.includes("\r\n");
  let text = html.replace(/\r\n/g, "\n");
  const { modules } = parsePage(text);
  text = text.replace(PLAN_LINE, () => `const PLAN = ${JSON.stringify(expectedModules(modules, rows))};`);
  text = text.replace(STATE_BLOCK, (_all, body) => {
    const seen = new Set();
    const lines = body.split("\n").map((line) => {
      const at = line.indexOf("//");
      const [code, comment] = at === -1 ? [line, ""] : [line.slice(0, at), line.slice(at)];
      const next = code.replace(/"([\d.]+)":\s*"(\w+)"/g, (whole, id, status) => {
        if (!(id in jsonState)) return whole;
        seen.add(id);
        return `"${id}": "${jsonState[id]}"`;
      });
      return next + comment;
    });
    const added = Object.keys(jsonState).filter((id) => !seen.has(id));
    if (added.length) lines.push(`  // Added by tools/sync-tracker.mjs from progress.json:`, `  ${added.map((id) => `"${id}": "${jsonState[id]}"`).join(", ")},`);
    return `const INITIAL_STATE = {\n${lines.join("\n")}\n};`;
  });
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

export function readState(jsonText) {
  const data = JSON.parse(jsonText);
  return Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith("$")));
}

function main() {
  const read = (name) => readFileSync(join(ROOT, name), "utf8");
  const rows = parsePlan(read("GrapiX-Build-Plan.md"));
  const html = read("progress.html");
  const jsonState = readState(read("progress.json"));
  if (process.argv.includes("--check")) {
    const { modules, state } = parsePage(html);
    const problems = drift(rows, modules, state, jsonState);
    if (problems.length) {
      for (const p of problems) console.error(`tracker: ${p}`);
      console.error("tracker: run `npm run sync:tracker` after editing the plan or progress.json");
      process.exit(1);
    }
    console.log(`check:tracker OK (${rows.length} rows, ${Object.keys(jsonState).length} statuses)`);
    return;
  }
  const next = regenerate(html, rows, jsonState);
  if (next === html) {
    console.log("sync:tracker: nothing to change");
    return;
  }
  writeFileSync(join(ROOT, "progress.html"), next);
  console.log("sync:tracker: progress.html regenerated");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && existsSync(join(ROOT, "progress.html"))) main();
