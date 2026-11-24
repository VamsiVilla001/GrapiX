// The split of memory.md into docs/log (0.12) must lose nothing, reorder nothing, and the
// protocol check must fail on each way the files can drift.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildSplit, fileFor, reassemble, sha256, splitEntries, verify } from "../memory-log.mjs";
import { checkProtocol, MEMORY_LIMIT_BYTES } from "../check-protocol.mjs";

const SAMPLE = [
  "# Title\n\nintro\n\n",
  "## Rules for the next session\n\n1. one\n\n---\n\n",
  "## 2026-11-19 — newest (Claude)\n\nbody a\n\n---\n\n",
  "## 2026-11-18 — first (Claude)\n\nbody b\n\n---\n\n",
  "## 2026-11-19 — second same day (Claude)\n\nbody c\n\n---\n\n",
  "## Shared agent worktree consolidation — 11 October 2026\n\nbody d\n\n---\n\n",
  "## Early work — 5 September 2026\n\nbody f\n\n---\n\n",
  "## OMP session import (tools/omp-import)\n\nbody e\n",
].join("");

test("an entry runs from its heading to the next, and nothing is dropped", () => {
  const { head, entries } = splitEntries(SAMPLE);
  assert.equal(head + entries.join(""), SAMPLE);
  assert.equal(entries.length, 7);
});

test("each entry is filed under its date, the prose date, or the undated file", () => {
  const { entries } = splitEntries(SAMPLE);
  assert.deepEqual(entries.slice(1).map(fileFor), ["2026-11-19.md", "2026-11-18.md", "2026-11-19.md", "2026-10-11.md", "2026-09-05.md", "undated-omp-session-import.md"]);
});

test("the split reassembles to the original in the original order", () => {
  const { rules, files, manifest } = buildSplit(SAMPLE);
  const read = (name) => (name === manifest.head.file ? rules : files.get(name));
  assert.equal(reassemble(manifest, read), SAMPLE);
  assert.equal(sha256(reassemble(manifest, read)), manifest.originalSha256);
  assert.equal(files.get("2026-11-19.md").match(/^## /gm).length, 2);
});

test("verify finds a changed entry, a missing entry and a missing file, and allows additions", () => {
  const { rules, files, manifest } = buildSplit(SAMPLE);
  const reader = (override) => (name) => (name in override ? override[name] : name === manifest.head.file ? rules : files.get(name));
  assert.deepEqual(verify(manifest, reader({})), []);
  assert.deepEqual(verify(manifest, reader({ "2026-11-18.md": `## 2026-11-20 — added later\n\nnew\n\n${files.get("2026-11-18.md")}` })), []);
  assert.deepEqual(verify(manifest, reader({ "2026-11-18.md": files.get("2026-11-18.md").replace("body b", "body B") })).map((p) => p[1]), ["changed"]);
  assert.deepEqual(verify(manifest, reader({ "2026-11-18.md": "## unrelated\n\nx\n" })).map((p) => p[1]), ["missing"]);
  assert.ok(verify(manifest, reader({ "2026-10-11.md": undefined })).some((p) => p[1] === "file is missing"));
  assert.deepEqual(verify(manifest, reader({ [manifest.head.file]: `${rules}extra` })).map((p) => p[1]), ["changed"]);
});

test("the real archive is whole", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const manifest = JSON.parse(readFileSync(`${root}docs/log/MANIFEST.json`, "utf8"));
  const read = (name) => readFileSync(`${root}docs/log/${name}`, "utf8");
  assert.deepEqual(verify(manifest, read), []);
  assert.equal(sha256(reassemble(manifest, read)), manifest.originalSha256);
  assert.equal(manifest.entries.length, 162);
});

function goodFiles() {
  const invariants = Array.from({ length: 83 }, (_, i) => `${i + 1}. rule`).join("\n");
  const { rules, files, manifest } = buildSplit(SAMPLE);
  const map = {
    "memory.md": "Rules: see docs/invariants.md and AGENTS.md. History: docs/log/.\n",
    "docs/invariants.md": `${invariants}\n`,
    "AGENTS.md": "The worktree is agent\\worktree.\n",
    "CLAUDE.md": "Read AGENTS.md.\n",
    "LLM-GOVERNANCE.md": "See AGENTS.md. `done` `active` `blocked` `pending` Implemented Partial Planned External gate\n",
    "docs/log/MANIFEST.json": JSON.stringify(manifest),
    [`docs/log/${manifest.head.file}`]: rules,
  };
  for (const [name, body] of files) map[`docs/log/${name}`] = body;
  return map;
}
const reader = (map) => (name) => map[name];

test("protocol check: a good set passes", () => {
  assert.deepEqual(checkProtocol(reader(goodFiles())), []);
});

test("protocol check: each way the files can drift is named", () => {
  const cases = [
    ["memory.md is too big", { "memory.md": `${goodFiles()["memory.md"]}${"x".repeat(MEMORY_LIMIT_BYTES)}` }, /limit/],
    ["memory.md loses its pointer", { "memory.md": "nothing\n" }, /does not point to/],
    ["memory.md claims a binding rule", { "memory.md": `${goodFiles()["memory.md"]}8. This is binding on everyone.\n` }, /binding/],
    ["an invariant is lost", { "docs/invariants.md": Array.from({ length: 80 }, (_, i) => `${i + 1}. rule`).join("\n") }, /numbers/],
    ["an invariant is renumbered", { "docs/invariants.md": `${goodFiles()["docs/invariants.md"]}\n90. skipped\n` }, /numbers/],
    ["CLAUDE.md restates the worktree", { "CLAUDE.md": "AGENTS.md agent\\worktree\n" }, /restates/],
    ["governance restates the worktree", { "LLM-GOVERNANCE.md": `${goodFiles()["LLM-GOVERNANCE.md"]} agent\\worktree` }, /restates/],
    ["governance has a stale count", { "LLM-GOVERNANCE.md": `${goodFiles()["LLM-GOVERNANCE.md"]} 250 steps` }, /count/],
    ["governance loses a status word", { "LLM-GOVERNANCE.md": "AGENTS.md `done` `active` `blocked` `pending`\n" }, /vocabulary/],
    ["an archived entry changes", { "docs/log/2026-11-18.md": goodFiles()["docs/log/2026-11-18.md"].replace("body b", "body X") }, /changed/],
    ["the manifest is gone", { "docs/log/MANIFEST.json": undefined }, /MANIFEST/],
  ];
  for (const [name, override, pattern] of cases) {
    const files = { ...goodFiles(), ...override };
    const problems = checkProtocol(reader(files));
    assert.ok(problems.some((p) => pattern.test(p)), `${name}: ${JSON.stringify(problems)}`);
  }
});
