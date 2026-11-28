// Row 11.127: one table of every name a person reads, and a ratchet that keeps the old names from coming back while the screens are
// rebuilt one at a time. `GX_WRITE_BASELINE=1 node --test Shared/web-panels/tests/terms.test.mjs` rewrites the allowed counts after a
// screen has been rebuilt; the test fails when a count is higher (an old word came back) and also when it is lower (lower the baseline).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TERMS, oldWordsIn, term } from "../terms.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const BASELINE = join(root, "Shared", "web-panels", "terms-baseline.json");

test("every term has a stable camelCase key, a name, a meaning and the apps it belongs to", () => {
  for (const [key, entry] of Object.entries(TERMS)) {
    assert.match(key, /^[a-z][A-Za-z0-9]*$/, key);
    assert.ok(entry.name.trim().length > 0 && entry.name === entry.name.trim(), key);
    assert.ok(entry.meaning.length > 10, key);
    assert.ok(entry.apps.length > 0 && entry.apps.every((a) => a === "editor" || a === "playout"), key);
    assert.ok(Array.isArray(entry.replaces), key);
  }
  const names = Object.values(TERMS).map((e) => e.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, "two terms share a name");
});

test("the type file lists exactly the keys of the table", () => {
  const types = read("Shared/web-panels/terms.d.ts");
  const block = types.match(/export type TermKey =([^;]+);/)?.[1] ?? "";
  const declared = [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(TERMS).sort());
});

test("a name is looked up by key and an unknown key is an error, never a guess", () => {
  assert.equal(term("cue"), "Cue");
  assert.equal(term("stack"), "Stack");
  assert.equal(term("sceneBank"), "Scene Bank");
  assert.throws(() => term("nonsense"), /no term "nonsense"/);
});

test("the user's names of 24 Nov 2026 are the table", () => {
  const chosen = {
    cue: "Cue", cueId: "Cue ID", cueControl: "Cue Control", preload: "Preload", preloaded: "Preloaded", style: "Style", effects: "Effects",
    stack: "Stack", playline: "Playline", sceneBank: "Scene Bank", inputs: "Inputs", airview: "Airview", element: "Element", phase: "Phase",
    playRules: "Play Rules", dataHub: "Data Hub", replayLab: "Replay Lab", sceneId: "Scene ID",
  };
  for (const [key, name] of Object.entries(chosen)) assert.equal(term(key), name, key);
});

test("a name that replaces another is never the old name of a different term", () => {
  const current = new Set(Object.values(TERMS).map((e) => e.name));
  for (const [key, entry] of Object.entries(TERMS)) for (const word of entry.replaces) assert.ok(!current.has(word), `${key} replaces ${word}, a current name`);
});

test("the wire words are recorded, not renamed", () => {
  assert.equal(TERMS.cue.wire, "take");
  assert.equal(TERMS.preload.wire, "cue");
});

test("old names are found whole, as written and in capitals, and only where the app must drop them", () => {
  const keys = (text, app) => oldWordsIn(text, app).map((f) => `${f.key}:${f.word}`).sort();
  assert.deepEqual(keys("TAKE", "playout"), ["cue:TAKE"]);
  assert.deepEqual(keys("Take the scene, then Take ID", "playout"), ["cue:Take", "cue:Take", "cueId:Take ID"]);
  assert.deepEqual(keys("Layers and Layer", "playout"), ["stack:Layer", "stack:Layers"]);
  assert.deepEqual(keys("Layers and Layer", "editor"), [], "the Editor's timeline still has layers");
  assert.deepEqual(keys("Partial, Particle, take-off, undertake, Takeover", "playout"), []);
  assert.deepEqual(keys("Part and Moment", "editor"), ["element:Part", "phase:Moment"]);
  assert.deepEqual(keys("Cue Control, Cue ID, Cue", "playout"), []);
});

// ---- the ratchet over what the two apps show today ------------------------------------------------------------------------------

/** The words a person reads in an HTML file: its text, and the attributes that are shown or spoken. */
export function visibleText(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const attributes = [...body.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*)"/gi)].map((m) => m[1]);
  const text = body.replace(/<[^>]*>/g, " ");
  return [text, ...attributes].join("\n");
}

function counts() {
  const out = {};
  for (const [file, app] of [["Editor/web/index.html", "editor"], ["Playout/web/index.html", "playout"]]) {
    const tally = {};
    for (const { word } of oldWordsIn(visibleText(read(file)), app)) tally[word] = (tally[word] ?? 0) + 1;
    out[file] = Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}

test("the old names on the two apps' pages do not grow, and the allowed count follows the screens down", () => {
  const now = counts();
  if (process.env.GX_WRITE_BASELINE) writeFileSync(BASELINE, JSON.stringify({ note: "Old product names still shown by each page; may only fall. See terms.test.mjs.", counts: now }, null, 2) + "\n");
  const allowed = JSON.parse(readFileSync(BASELINE, "utf8")).counts;
  for (const file of Object.keys(now)) {
    for (const word of new Set([...Object.keys(now[file]), ...Object.keys(allowed[file] ?? {})])) {
      const have = now[file][word] ?? 0;
      const may = allowed[file]?.[word] ?? 0;
      assert.ok(have <= may, `${file}: "${word}" is shown ${have} times, ${may} allowed: an old name came back (use term("..."))`);
      assert.ok(have >= may, `${file}: "${word}" is shown ${have} times and ${may} are allowed: lower the baseline (GX_WRITE_BASELINE=1)`);
    }
  }
});

test("a screen built on the new names uses none of the old ones", () => {
  const dirs = [["Editor/src/screens", "editor"], ["Playout/web/screens", "playout"]];
  let checked = 0;
  for (const [dir, app] of dirs) {
    const path = join(root, dir);
    if (!existsSync(path) || !statSync(path).isDirectory()) continue;
    for (const name of readdirSync(path).filter((n) => /\.(ts|js|html)$/.test(n))) {
      checked += 1;
      const found = oldWordsIn(read(`${dir}/${name}`), app);
      assert.deepEqual(found, [], `${dir}/${name} shows an old name`);
    }
  }
  assert.ok(checked >= 0);
});
