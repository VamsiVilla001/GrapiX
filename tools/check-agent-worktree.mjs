#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const normalized = (path) => {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

export function validateWorkspace({ primary, top, branch, registered }) {
  const canonical = join(primary, "agent", "worktree");
  const expected = normalized(canonical);
  const allowed = new Set([normalized(primary), expected]);
  const violations = [];
  if (normalized(top) !== expected) {
    violations.push(`Agent edits/tests must run in ${canonical}; current worktree is ${top}`);
  }
  if (branch !== "agent/shared") {
    violations.push(`Agent work must use agent/shared; current branch is ${branch || "detached HEAD"}`);
  }
  if (!registered.some((path) => normalized(path) === expected)) {
    violations.push(`The canonical path is not a registered Git worktree: ${canonical}`);
  }
  for (const path of registered) {
    if (!allowed.has(normalized(path))) violations.push(`Additional GrapiX worktree is forbidden: ${path}`);
  }
  return { canonical, violations };
}

export function inspectWorkspace(cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const common = realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
  const primary = dirname(common);
  const top = realpathSync(git("rev-parse", "--show-toplevel"));
  const branch = git("branch", "--show-current");
  const registered = git("worktree", "list", "--porcelain").split(/\r?\n/)
    .filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
  return { primary, top, branch, registered, ...validateWorkspace({ primary, top, branch, registered }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = inspectWorkspace();
    if (result.violations.length) {
      console.error(result.violations.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Agent workspace OK: ${result.canonical} (agent/shared)`);
    }
  } catch (error) {
    console.error(`Agent workspace check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
