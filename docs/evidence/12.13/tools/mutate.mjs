import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const root = path.resolve("mut");
fs.rmSync(root, { recursive: true, force: true });
for (const [from, to] of [
  ["Playout/tests/stacks.test.mjs", "Playout/tests/stacks.test.mjs"],
  ["Playout/web/screens/stacks.js", "Playout/web/screens/stacks.js"],
  ["Playout/web/screens/stacks-view.js", "Playout/web/screens/stacks-view.js"],
  ["Shared/web-panels/terms.js", "Shared/web-panels/terms.js"],
]) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(repo, from), path.join(root, to));
}
const target = path.join(root, "Playout/web/screens/stacks.js");
const original = fs.readFileSync(target, "utf8");
const run = () => spawnSync("node", ["--test", path.join(root, "Playout/tests/stacks.test.mjs")], { encoding: "utf8" });

const base = run();
console.log("baseline (unmutated) exit:", base.status);

const mutants = [
  ["a number is no longer normalised away from -0", "return { ok: true, stack: stack === 0 ? 0 : stack };", "return { ok: true, stack };"],
  ["blank is no longer its own fault", 'if (text === "") return { ok: false, reason: "empty" };', ""],
  ["seven digits are read as a number", "const WHOLE = /^[+-]?[0-9]{1,6}$/;", "const WHOLE = /^[+-]?[0-9]+$/;"],
  ["zero is written with a plus", "return stack > 0 ?", "return stack >= 0 ?"],
  ["the steppers wrap or run past the ends", "Math.min(STACK_MAX, Math.max(STACK_MIN, stack + delta))", "stack + delta"],
  ["zero is sent as a layer", "return stack === 0 ? {} : { layer: stack };", "return { layer: stack };"],
  ["the table runs back to front", "b.stack - a.stack", "a.stack - b.stack"],
  ["the selected stack is not added", "if (!byStack.has(selected)) rowFor(selected, false);", ""],
  ["an unreadable entry is not counted", "unreadable += 1;", "unreadable += 0;"],
  ["a second queued scene is not said", "if (row.queued !== null) row.doubled = true;", "if (row.queued !== null) row.doubled = false;"],
  ["a second scene on a stack is not said", "} else if (row.current !== null) {\n      row.doubled = true;", "} else if (row.current !== null) {\n      row.doubled = false;"],
  ["a leaving scene cannot be cleared", 'clear: current === "onAir" || current === "leaving"', 'clear: current === "onAir"'],
  ["an unknown state offers Continue", 'continue: current === "onAir"', "continue: current !== undefined"],
  ["a Clear names a wrapped id as an object", "takeId: unwrap(row.current.takeId)", "takeId: row.current.takeId"],
  ["a repeated key press starts a second hold", 'if (state !== "idle") return false;', ""],
  ["a release does not cancel the timer", "unschedule(handle);", ""],
  ["an engine with no list reads its scene as queued", 'state: "onAir", frame: program.committedFrame', 'state: "queued", frame: program.committedFrame'],
  ["an unknown state is drawn as ON AIR", "String(state).toUpperCase()", '"ON AIR"'],
  ["the hold is half a second", "export const HOLD_MS = 1000;", "export const HOLD_MS = 500;"],
  ["a typed stack is not trimmed", 'const text = String(input ?? "").trim();', 'const text = String(input ?? "");'],
  ["a status with nothing on air is read as no status", 'source: "program",\n    entries: program', 'source: program ? "program" : "none",\n    entries: program'],
  ["a missing status is read as a status", 'if (status === null || status === undefined || typeof status !== "object") return { source: "none", entries: [] };', ""],
  ["a hold fires on release too (fired state not reached)", 'set("fired");\n        options.onFire();', "options.onFire();"],
];
let caught = 0;
const survivors = [];
for (const [name, find, replace] of mutants) {
  if (!original.includes(find)) {
    console.log("NOT FOUND:", name);
    survivors.push(`${name} (pattern not found)`);
    continue;
  }
  fs.writeFileSync(target, original.replace(find, replace));
  const r = run();
  const ok = r.status !== 0;
  if (ok) caught += 1;
  else survivors.push(name);
  console.log(ok ? "caught  " : "SURVIVED", name);
}
fs.writeFileSync(target, original);
console.log(JSON.stringify({ mutants: mutants.length, caught, survivors }));
