#!/usr/bin/env node
// Fails if the committed generated TypeScript is not what a fresh run
// produces.
//
// ADR-003 makes Rust the source of truth and TypeScript generated output. That
// only holds if the committed output is current: a stale commit is drift
// wearing a generated label, and it is indistinguishable from a hand edit by
// the time someone debugs it.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GENERATED = join(ROOT, "Shared", "generated-ts", "src");

const backup = mkdtempSync(join(tmpdir(), "gx-codegen-"));
let restored = false;

function snapshot(dir) {
  const out = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".ts")) out.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

try {
  cpSync(GENERATED, backup, { recursive: true });
  const before = snapshot(backup);

  execFileSync("cargo", ["run", "-q", "-p", "gx-contract-codegen"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const after = snapshot(GENERATED);

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
  if (!restored) cpSync(backup, GENERATED, { recursive: true });
  rmSync(backup, { recursive: true, force: true });
}
