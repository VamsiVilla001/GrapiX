import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoWeb = "D:/Project KK/Personal projects/GrapiX/agent/worktree/Playout/web";
const scratch = path.resolve(".");
const mutants = [
  ["main.js", "a row Clear stops naming the page", "{ ...stackArgs(stack), expected: page }, stack);", "{ ...stackArgs(stack) }, stack);"],
  ["main.js", "a take stops carrying its stack", "{ takeId: target.takeId, revision: target.revision, contentHash: target.contentHash, ...stackArgs(stack) },\n    stack,\n  );\n}\n\n/** The Transport's CLEAR.", "{ takeId: target.takeId, revision: target.revision, contentHash: target.contentHash },\n    stack,\n  );\n}\n\n/** The Transport's CLEAR."],
  ["main.js", "the Transport CLEAR stops naming a page on another stack", "const page = stack === 0 ? null : pageShownOn(stack);", "const page = null;"],
  ["main.js", "the Transport CLEAR on stack 0 starts naming a page", "const page = stack === 0 ? null : pageShownOn(stack);", "const page = pageShownOn(stack);"],
  ["main.js", "a lost engine leaves its table on screen", "  session.status = null;\n  stacks.cancelHolds();", "  stacks.cancelHolds();"],
  ["main.js", "an invalid stack is sent anyway", "  const stack = stackTarget(\"CUE\");\n  if (stack === null) return;", "  const stack = parseStack(ui.stackInput.value).stack ?? 0;"],
  ["screens/stacks-view.js", "a Clear reads the page when the hold ends, not when it began", "() => ({ stack, page: row.page }),\n      ({ stack: target, page }) => {\n        if (page !== null) handlers.onClear(target, page);", "() => ({ stack }),\n      ({ stack: target }) => {\n        if (row.page !== null) handlers.onClear(target, row.page);"],
  ["screens/stacks-view.js", "rows are moved on every status read", "if (body.children[index] !== row.tr) body.insertBefore(row.tr, body.children[index] ?? null);", "body.insertBefore(row.tr, body.children[index] ?? null);"],
  ["screens/stacks-view.js", "a row's controls ignore the gate", "button.disabled = !usable || !on;", "button.disabled = !on;"],
  ["screens/stacks-view.js", "a hold that loses its pointer keeps going", 'for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) button.addEventListener(type, () => hold.release());', ""],
];
let caught = 0;
const survivors = [];
for (const [file, name, find, replace] of mutants) {
  const copy = path.join(scratch, "web-mut");
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(repoWeb, copy, { recursive: true });
  const target = path.join(copy, file);
  const original = fs.readFileSync(target, "utf8");
  if (!original.includes(find)) {
    console.log("NOT FOUND:", name);
    survivors.push(`${name} (pattern not found)`);
    continue;
  }
  fs.writeFileSync(target, original.replace(find, replace));
  const r = spawnSync("node", ["stacks-harness.mjs", copy, scratch], { encoding: "utf8", timeout: 170000 });
  let failed = "?";
  try { failed = JSON.parse(r.stdout).failed; } catch { failed = `unreadable output (${r.status})`; }
  const ok = r.status !== 0 && failed !== 0;
  if (ok) caught += 1;
  else survivors.push(name);
  console.log(ok ? "caught  " : "SURVIVED", name, `(failed checks: ${failed})`);
}
console.log(JSON.stringify({ mutants: mutants.length, caught, survivors }));
