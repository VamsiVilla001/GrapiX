#!/usr/bin/env node
// The agent protocol files stay context-efficient and consistent (build plan 0.12).
//
// `memory.md` is read by every agent at the start of every session, so it is held to a size:
// the dated history lives in `docs/log/` and is proven unchanged by `tools/memory-log.mjs`.
// The workspace rule is stated once, in `AGENTS.md`, and the other entry files point to it.
//
//   node tools/check-protocol.mjs

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { verify } from "./memory-log.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MEMORY_LIMIT_BYTES = 12 * 1024;
const WORKTREE = "agent\\worktree";
const LAST_MOVED_INVARIANT = 83;

/** Problems with the protocol files, as strings. Pure over a file reader (`undefined` = absent). */
export function checkProtocol(read) {
  const problems = [];
  const need = (name) => {
    const text = read(name);
    if (text === undefined) problems.push(`${name} is missing`);
    return text ?? "";
  };
  const memory = need("memory.md");
  const bytes = Buffer.byteLength(memory);
  if (bytes > MEMORY_LIMIT_BYTES) problems.push(`memory.md is ${bytes} bytes; the limit is ${MEMORY_LIMIT_BYTES} (move history to docs/log/)`);
  for (const pointer of ["docs/invariants.md", "AGENTS.md", "docs/log/"]) {
    if (!memory.includes(pointer)) problems.push(`memory.md does not point to ${pointer}`);
  }
  if (/^\d+\. .*\bbinding\b/im.test(memory)) problems.push("memory.md lists a rule as binding; binding rules belong in docs/invariants.md");

  const invariants = need("docs/invariants.md");
  const numbers = [...invariants.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  const consecutive = numbers.every((n, i) => n === i + 1);
  if (!consecutive || numbers.length < LAST_MOVED_INVARIANT) {
    problems.push(`docs/invariants.md numbers are not 1..${LAST_MOVED_INVARIANT}+ in order (${numbers.length} found)`);
  }

  const agents = need("AGENTS.md");
  if (!agents.includes(WORKTREE)) problems.push("AGENTS.md does not state the worktree path");
  for (const name of ["CLAUDE.md", "LLM-GOVERNANCE.md"]) {
    const text = need(name);
    if (text.includes(WORKTREE)) problems.push(`${name} restates the worktree path; it must point to AGENTS.md`);
    if (!text.includes("AGENTS.md")) problems.push(`${name} does not point to AGENTS.md`);
  }
  const governance = need("LLM-GOVERNANCE.md");
  if (/\b\d+\s+steps\b|\b\d+\s+phases\b/i.test(governance)) problems.push("LLM-GOVERNANCE.md carries a step or phase count that will go stale");
  for (const word of ["`done`", "`active`", "`blocked`", "`pending`", "Implemented", "Partial", "Planned", "External gate"]) {
    if (!governance.includes(word)) problems.push(`LLM-GOVERNANCE.md status vocabulary lacks ${word}`);
  }

  const manifestText = read("docs/log/MANIFEST.json");
  if (manifestText === undefined) {
    problems.push("docs/log/MANIFEST.json is missing");
  } else {
    for (const [what, why] of verify(JSON.parse(manifestText), (file) => read(`docs/log/${file}`))) {
      problems.push(`docs/log: ${what}: ${why}`);
    }
  }
  return problems;
}

function main() {
  const read = (name) => (existsSync(join(ROOT, name)) ? readFileSync(join(ROOT, name), "utf8") : undefined);
  const problems = checkProtocol(read);
  if (problems.length) {
    for (const p of problems) console.error(`protocol: ${p}`);
    process.exit(1);
  }
  console.log("check:protocol OK");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
