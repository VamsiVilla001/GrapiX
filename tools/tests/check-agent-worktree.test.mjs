import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { AUTHORIZED_PRIMARY, validateWorkspace } from "../check-agent-worktree.mjs";

const primary = AUTHORIZED_PRIMARY;
const canonical = join(primary, "agent", "worktree");
const facts = { primary, top: canonical, branch: "agent/shared", registered: [primary, canonical] };

test("the registered shared agent worktree is accepted", () => {
  assert.deepEqual(validateWorkspace(facts).violations, []);
});
test("the primary checkout cannot be used as an agent editing workspace", () => {
  assert.match(validateWorkspace({ ...facts, top: primary, branch: "GrapiX-2.0" }).violations.join("\n"), /must run in/);
});
test("a similarly named unregistered directory cannot pass", () => {
  assert.match(validateWorkspace({ ...facts, registered: [primary] }).violations.join("\n"), /not a registered/);
});
test("a private branch in the right folder cannot pass", () => {
  assert.match(validateWorkspace({ ...facts, branch: "claude/private" }).violations.join("\n"), /must use agent\/shared/);
});
test("detached HEAD cannot pass", () => {
  assert.match(validateWorkspace({ ...facts, branch: "" }).violations.join("\n"), /detached HEAD/);
});
test("an additional vendor or per-agent worktree is refused", () => {
  const registered = [...facts.registered, join(primary, ".claude", "worktrees", "private")];
  assert.match(validateWorkspace({ ...facts, registered }).violations.join("\n"), /Additional GrapiX worktree is forbidden/);
});

test("another clone cannot authorize its own agent/worktree layout", () => {
  const clone = resolve("other-clone");
  assert.match(validateWorkspace({ primary: clone, top: join(clone, "agent", "worktree"), branch: "agent/shared", registered: [clone, join(clone, "agent", "worktree")] }).violations.join("\n"), /authorized GrapiX repository/);
});
