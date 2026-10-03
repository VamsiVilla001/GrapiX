#!/usr/bin/env node
// Fails if the committed generated TypeScript or JSON Schema is not what a
// fresh run produces.
//
// ADR-003 makes Rust the source of truth and TypeScript generated output. That
// only holds if the committed output is current: a stale commit is drift
// wearing a generated label, and it is indistinguishable from a hand edit by
// the time someone debugs it.
//
// Codegen wipes and rewrites `Shared/generated-ts/schemas/` on every run, so
// a committed schema whose command no longer exists is reported as "no longer
// generated". The TypeScript directory is only overwritten, never wiped, so a
// stale `.ts` file there is not detected (a known gap).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GENERATED = join(ROOT, "Shared", "generated-ts", "src");
const SCHEMAS = join(ROOT, "Shared", "generated-ts", "schemas");

/// Generated files that do not live under `Shared/generated-ts`.
///
/// The cross-language reference tables are produced by the same codegen run
/// from the Rust implementations that own the curves — colour transfer (11.4)
/// and easing (11.11). They were outside this gate, and that was a real hole:
/// each is pinned by a TypeScript test that compares the mirror against the
/// table, so a *stale table* leaves the test passing while Rust and TypeScript
/// have actually diverged. Checking them here is what makes "changed on one
/// side and not the other fails the gate in the same run" true rather than
/// nearly true.
const GENERATED_FILES = [
  join("Editor", "src", "transfer-reference.ts"),
  join("Editor", "src", "easing-reference.ts"),
];

const backup = mkdtempSync(join(tmpdir(), "gx-codegen-"));
const schemaBackup = mkdtempSync(join(tmpdir(), "gx-codegen-schemas-"));
const fileBackup = mkdtempSync(join(tmpdir(), "gx-codegen-files-"));
let restored = false;

function snapshot(dir, prefix = "") {
  const out = new Map();
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      // Nested output (e.g. ts-rs's serde_json/JsonValue.ts) is generated
      // too, and drifts the same way a flat file does.
      for (const [k, v] of snapshot(full, rel)) out.set(k, v);
    } else if (name.endsWith(".ts") || name.endsWith(".json")) {
      out.set(rel, readFileSync(full, "utf8"));
    }
  }
  return out;
}

function snapshotFiles() {
  const out = new Map();
  for (const relative of GENERATED_FILES) {
    out.set(relative, readFileSync(join(ROOT, relative), "utf8"));
  }
  return out;
}

function snapshotSchemas(dir) {
  return existsSync(dir) ? new Map([...snapshot(dir)].map(([name, text]) => [`schemas/${name}`, text])) : new Map();
}

try {
  cpSync(GENERATED, backup, { recursive: true });
  if (existsSync(SCHEMAS)) cpSync(SCHEMAS, join(schemaBackup, "schemas"), { recursive: true });
  for (const relative of GENERATED_FILES) {
    cpSync(join(ROOT, relative), join(fileBackup, basename(relative)));
  }
  const before = new Map([...snapshot(backup), ...snapshotSchemas(join(schemaBackup, "schemas")), ...snapshotFiles()]);

  execFileSync("cargo", ["run", "-q", "-p", "gx-contract-codegen"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const after = new Map([...snapshot(GENERATED), ...snapshotSchemas(SCHEMAS), ...snapshotFiles()]);

  const problems = [];
  for (const [name, text] of after) {
    if (!before.has(name)) problems.push(`missing from the commit: ${name}`);
    else if (before.get(name) !== text) problems.push(`stale in the commit: ${name}`);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) problems.push(`no longer generated, delete it: ${name}`);
  }

  if (problems.length > 0) {
    console.error("codegen:check FAILED - generated output is not current\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nRun `npm run codegen` and commit the result.");
    process.exit(1);
  }
  console.log(`codegen:check OK (${after.size} files current)`);
  restored = true;
} finally {
  // On failure the regenerated files are left in place: that is what the
  // developer needs to commit. On success they are identical anyway.
  if (!restored) {
    cpSync(backup, GENERATED, { recursive: true });
    rmSync(SCHEMAS, { recursive: true, force: true });
    if (existsSync(join(schemaBackup, "schemas"))) cpSync(join(schemaBackup, "schemas"), SCHEMAS, { recursive: true });
    for (const relative of GENERATED_FILES) {
      cpSync(join(fileBackup, basename(relative)), join(ROOT, relative));
    }
  }
  rmSync(schemaBackup, { recursive: true, force: true });
  rmSync(fileBackup, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
}
