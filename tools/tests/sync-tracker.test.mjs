// 0.13: the tracker's embedded rows and statuses are generated from the plan and progress.json,
// and the check fails on each way the three can drift.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drift, parsePage, parsePlan, readState, regenerate } from "../sync-tracker.mjs";

const MD = `# Plan

### Module B1 — First

*Backend.* intro

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| \`0.1\` | Clean \`branch\` | CON | — | builds |
| \`0.2\` | Pin | CON | \`0.1\` | pinned, a | b stays |

### Module F1 — Second

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| \`11.1\` | Shell | UI | 0.1, 0.2 | signed |
`;

const modules = (steps) => [
  { id: "B1", side: "backend", title: "First", note: "n1", milestone: "m", steps: steps.filter((s) => s.id.startsWith("0.")) },
  { id: "F1", side: "frontend", title: "Second", note: "n2", steps: steps.filter((s) => s.id.startsWith("11.")) },
];
const ROWS = parsePlan(MD);
const PLAN = modules(ROWS.map(({ id, name, track, dep, done }) => ({ id, name, track, dep, done })));
const page = (state = '  "0.1": "done", // verified\n  "0.2": "active",', plan = PLAN) =>
  `<script>\nconst PLAN = ${JSON.stringify(plan)};\n// note\nconst INITIAL_STATE = {\n${state}\n};\nlet x = 1;\n</script>\n`;
const JSON_STATE = { "0.1": "done", "0.2": "active" };

test("a plan row parses with backticks removed and a pipe kept inside the done-when", () => {
  assert.deepEqual(ROWS[0], { module: "B1", id: "0.1", name: "Clean branch", track: "CON", dep: "—", done: "builds" });
  assert.equal(ROWS[1].done, "pinned, a | b stays");
  assert.equal(ROWS[1].dep, "0.1");
  assert.equal(ROWS[2].module, "F1");
});

test("a row outside a module, or one that does not parse, is an error", () => {
  assert.throws(() => parsePlan("| `1.1` | x | CON | — | y |\n"), /outside any module/);
  assert.throws(() => parsePlan("### Module B1 — A\n| `1.1` | broken |\n"), /does not parse/);
});

test("a page that matches the plan and the json has no drift", () => {
  const { modules: m, state } = parsePage(page());
  assert.deepEqual(state, JSON_STATE);
  assert.deepEqual(drift(ROWS, m, state, JSON_STATE), []);
});

test("a changed row, a missing row, an extra row and a reordered row are each named", () => {
  const changed = structuredClone(PLAN);
  changed[0].steps[0].done = "builds, mostly";
  assert.match(drift(ROWS, changed, JSON_STATE, JSON_STATE).join("\n"), /row 0\.1: done differs/);
  for (const field of ["name", "track", "dep"]) {
    const other = structuredClone(PLAN);
    other[0].steps[1][field] = field === "track" ? "UI" : "changed";
    assert.match(drift(ROWS, other, JSON_STATE, JSON_STATE).join("\n"), new RegExp(`row 0\\.2: ${field} differs`));
  }
  const moved = structuredClone(PLAN);
  moved[1].steps.push(moved[0].steps.pop());
  assert.match(drift(ROWS, moved, JSON_STATE, JSON_STATE).join("\n"), /module B1 in the plan, F1 in progress\.html/);
  const missing = structuredClone(PLAN);
  missing[1].steps = [];
  assert.match(drift(ROWS, missing, JSON_STATE, JSON_STATE).join("\n"), /row 11\.1 is in the plan but not in progress\.html/);
  const extra = structuredClone(PLAN);
  extra[0].steps.push({ id: "0.9", name: "x", track: "CON", dep: "—", done: "y" });
  assert.match(drift(ROWS, extra, JSON_STATE, JSON_STATE).join("\n"), /row 0\.9 is in progress\.html but not in the plan/);
  const reordered = structuredClone(PLAN);
  reordered[0].steps.reverse();
  assert.match(drift(ROWS, reordered, JSON_STATE, JSON_STATE).join("\n"), /different order/);
});

test("a changed status, and a status for a row the plan does not have, are each named", () => {
  assert.match(drift(ROWS, PLAN, { "0.1": "done", "0.2": "done" }, JSON_STATE).join("\n"), /row 0\.2: active in progress\.json, done in progress\.html/);
  assert.match(drift(ROWS, PLAN, JSON_STATE, { ...JSON_STATE, "9.9": "done" }).join("\n"), /progress\.json has a status for 9\.9/);
  assert.match(drift(ROWS, PLAN, { ...JSON_STATE, "8.8": "done" }, JSON_STATE).join("\n"), /progress\.html has a status for 8\.8/);
  assert.match(drift(ROWS, PLAN, { "0.1": "finished" }, { "0.1": "finished" }).join("\n"), /status "finished"/);
});

test("a plan module the page does not have is an error, not a silent drop", () => {
  const rows = [...ROWS, { module: "Z9", id: "20.1", name: "n", track: "BE", dep: "—", done: "d" }];
  assert.throws(() => drift(rows, PLAN, JSON_STATE, JSON_STATE), /module Z9/);
});

test("regenerating fixes row text and statuses, keeps comments and the module wording, and is stable", () => {
  const stale = structuredClone(PLAN);
  stale[0].steps[0].done = "old";
  stale[0].note = "page wording";
  const html = page('  "0.1": "active", // verified\n  "0.2": "active",', stale);
  const next = regenerate(html, ROWS, { ...JSON_STATE, "11.1": "pending" });
  const { modules: m, state } = parsePage(next);
  assert.equal(m[0].steps[0].done, "builds");
  assert.equal(m[0].note, "page wording");
  assert.deepEqual(state, { ...JSON_STATE, "11.1": "pending" });
  assert.match(next, /"0\.1": "done", \/\/ verified/);
  assert.equal(regenerate(next, ROWS, { ...JSON_STATE, "11.1": "pending" }), next);
  assert.deepEqual(drift(ROWS, m, state, { ...JSON_STATE, "11.1": "pending" }), []);
});

test("a comment that mentions a row id is not read as a status", () => {
  const { state } = parsePage(page('  "0.1": "done", // was "9.9": "done" once\n  "0.2": "active",'));
  assert.deepEqual(state, JSON_STATE);
});

test("the real plan, tracker and json agree, and regenerating them changes nothing", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const rows = parsePlan(readFileSync(`${root}GrapiX-Build-Plan.md`, "utf8"));
  const html = readFileSync(`${root}progress.html`, "utf8");
  const json = readState(readFileSync(`${root}progress.json`, "utf8"));
  const { modules: m, state } = parsePage(html);
  assert.deepEqual(drift(rows, m, state, json), []);
  assert.equal(regenerate(html, rows, json), html);
  // A lower bound, not a pin: rows are added all the time and never removed, so a count that must equal today's fails on every new row
  // (351 became 402 on 24 Nov 2026, then 407 the same evening). A row that vanishes still fails.
  assert.ok(rows.length >= 407, `${rows.length} rows`);
});
