#!/usr/bin/env node
// The session log, split out of `memory.md` (build plan 0.12), and the check that nothing was lost.
//
// `memory.md` had grown to 540 KB, and its first rule told every agent to read it. The dated
// history now lives under `docs/log/`, one file per day, and `memory.md` holds only the rules,
// "Resume here" and an index. Every entry was moved byte for byte; `docs/log/MANIFEST.json`
// records what was moved so a check can prove it.
//
//   node tools/memory-log.mjs --split <memory.md>   one time: write docs/log and the manifest
//   node tools/memory-log.mjs --check               fail if an archived entry changed or went missing
//
// The check allows additions: new entries are added to `docs/log/` as work goes on, and only the
// entries that were archived are held to the manifest.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG = "docs/log";
const MANIFEST = `${LOG}/MANIFEST.json`;
const HEAD_FILE = "0000-memory-header-and-rules-before-0.12.md";
const OMP_FILE = "undated-omp-session-import.md";

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Split text into pieces that each start at a `## ` heading. Text before the first is `head`. */
export function splitEntries(text) {
  const lines = text.split(/(?<=\n)/);
  const entries = [];
  let head = "";
  let current = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current !== null) entries.push(current);
      current = line;
    } else if (current === null) {
      head += line;
    } else {
      current += line;
    }
  }
  if (current !== null) entries.push(current);
  return { head, entries };
}

export const headingOf = (entry) => entry.slice(0, entry.indexOf("\n") === -1 ? undefined : entry.indexOf("\n")).replace(/^## /, "");

const DATED = /^## (\d{4}-\d{2}-\d{2}) /;
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** The log file an entry belongs in: its date, or a named file for the two undated ones. */
export function fileFor(entry) {
  const dated = entry.match(DATED);
  if (dated) return `${dated[1]}.md`;
  const prose = entry.match(/^## .*? — (\d{1,2}) ([A-Z][a-z]+) (\d{4})/);
  if (prose && MONTHS[prose[2].toLowerCase()]) {
    return `${prose[3]}-${String(MONTHS[prose[2].toLowerCase()]).padStart(2, "0")}-${prose[1].padStart(2, "0")}.md`;
  }
  return OMP_FILE;
}

/** Where the rules end and the dated history begins: the first dated entry's index. */
export function firstDated(entries) {
  return entries.findIndex((e) => DATED.test(e));
}

export function buildSplit(text) {
  const { head, entries } = splitEntries(text);
  const start = firstDated(entries);
  if (start < 0) throw new Error("no dated entry found");
  const rules = head + entries.slice(0, start).join("");
  const history = entries.slice(start);
  const files = new Map();
  const manifestEntries = history.map((entry, n) => {
    const file = fileFor(entry);
    files.set(file, (files.get(file) ?? "") + entry);
    return { n, heading: headingOf(entry), file, bytes: Buffer.byteLength(entry), sha256: sha256(entry) };
  });
  const manifest = {
    note: "memory.md as it stood before build plan 0.12, split byte for byte. Check with `node tools/memory-log.mjs --check`.",
    originalBytes: Buffer.byteLength(text),
    originalSha256: sha256(text),
    head: { file: HEAD_FILE, bytes: Buffer.byteLength(rules), sha256: sha256(rules) },
    entries: manifestEntries,
  };
  return { rules, files, manifest };
}

/** The archived entries that are missing or changed: `[heading, why]`. Pure over a file reader. */
export function verify(manifest, readFile) {
  const problems = [];
  const have = new Map();
  for (const file of new Set([manifest.head.file, ...manifest.entries.map((e) => e.file)])) {
    const text = readFile(file);
    if (text === undefined) {
      problems.push([file, "file is missing"]);
      continue;
    }
    have.set(file, file === manifest.head.file ? [text] : splitEntries(text).entries);
  }
  const headText = have.get(manifest.head.file)?.[0];
  if (headText !== undefined && sha256(headText) !== manifest.head.sha256) problems.push([manifest.head.file, "changed"]);
  for (const e of manifest.entries) {
    const pieces = have.get(e.file);
    if (!pieces) continue;
    if (!pieces.some((piece) => sha256(piece) === e.sha256)) {
      problems.push([`${e.file}: ${e.heading}`, pieces.some((p) => headingOf(p) === e.heading) ? "changed" : "missing"]);
    }
  }
  return problems;
}

/** The archived text in its original order: proves the split loses and reorders nothing. */
export function reassemble(manifest, readFile) {
  const used = new Map();
  let out = readFile(manifest.head.file) ?? "";
  for (const e of manifest.entries) {
    const pieces = splitEntries(readFile(e.file) ?? "").entries;
    const piece = pieces.find((p, i) => sha256(p) === e.sha256 && !(used.get(e.file) ?? new Set()).has(i));
    if (piece === undefined) throw new Error(`${e.file}: ${e.heading} is not there`);
    const set = used.get(e.file) ?? new Set();
    set.add(pieces.indexOf(piece));
    used.set(e.file, set);
    out += piece;
  }
  return out;
}

function main() {
  const [mode, source] = process.argv.slice(2);
  const read = (name) => (existsSync(join(ROOT, LOG, name)) ? readFileSync(join(ROOT, LOG, name), "utf8") : undefined);
  if (mode === "--split") {
    const text = readFileSync(source, "utf8");
    const { rules, files, manifest } = buildSplit(text);
    mkdirSync(join(ROOT, LOG), { recursive: true });
    writeFileSync(join(ROOT, LOG, manifest.head.file), rules);
    for (const [file, body] of files) writeFileSync(join(ROOT, LOG, file), body);
    writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    const back = reassemble(manifest, read);
    if (sha256(back) !== manifest.originalSha256) throw new Error("the split does not reassemble to the original");
    console.log(`split ${manifest.entries.length} entries into ${files.size} files; reassembles to the original (${manifest.originalBytes} bytes)`);
    return;
  }
  if (mode === "--check") {
    const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
    const problems = verify(manifest, read);
    if (problems.length) {
      for (const [what, why] of problems) console.error(`log: ${what}: ${why}`);
      process.exit(1);
    }
    const files = readdirSync(join(ROOT, LOG)).filter((f) => f.endsWith(".md"));
    console.log(`check:log OK (${manifest.entries.length} archived entries unchanged, ${files.length} files)`);
    return;
  }
  console.error("usage: node tools/memory-log.mjs --split <memory.md> | --check");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
