# Shared agent workspace and working protocol (binding)

Every LLM working on GrapiX reads this file, then `LLM-GOVERNANCE.md`, then `memory.md`
(about 10k tokens in all). `CLAUDE.md` and `LLM-GOVERNANCE.md` point here for the
workspace rule; it is stated only in this file.

## The workspace rule

The only authorized agent worktree is:

`D:\Project KK\Personal projects\GrapiX\agent\worktree`

Use branch `agent/shared`. Run `tools/enter-agent.ps1` from the primary
checkout, then `node tools/check-agent-worktree.mjs` in that worktree before
editing or testing. A failed check stops work in that location. The primary
checkout is for inspection and fast-forward integration; agent code,
documentation, tests and commits belong in the shared worktree. This applies to
every LLM and platform (Claude, Codex, OMP, Kimi, Copilot, present or future) and
to every delegated agent.

Do not create another worktree, per-agent checkout, fork, private branch or
replacement workspace. Do not use `git worktree add` for an agent, `.claude/worktrees`,
`.codex` worktrees, `.omp` worktrees, or tool-generated isolation. If the shared
worktree is missing, busy or dirty, report that condition and preserve the shared
state; do not create a substitute. Explicit user instructions override this rule.

Coordinate edits in the existing shared tree. Never reset, stash, clean or
overwrite another worker's changes to obtain a clean tree. Do not spawn
other agents unless the user or applicable instructions authorize delegation.
Two or more agents may work in this worktree at the same time, even on the same row, as long
as none overwrites another's work; they agree the split on Panchayati, under the claim, lock,
build-folder and commit rules of `LLM-GOVERNANCE.md` ("Parallel agents in the one worktree").

Project agent settings are consolidated under the primary repository's
`agent/config/`. Temporary artifacts belong under `agent/tmp/`; recovery
copies belong under `agent/archive/`; third-party reference source is allowed
under `agent/reference/` and must not become an alternate GrapiX checkout. These
are not alternate worktrees. `legacy/` preserves merged historical source and is
outside current product builds. GrapiX builds for Windows only.

## Working protocol

What to read, in order, and no more until the task needs it:

1. This file and `LLM-GOVERNANCE.md` (the verify-then-record loop).
2. `memory.md`: the working rules, "Resume here" and an index. It is at most 12 KB.
3. The task's row in `GrapiX-Build-Plan.md`, found by id (`grep -n '^| `3.25` '`), not the
   whole plan. Read `docs/invariants.md` before changing contracts, transport, timing or
   rendering; its numbers are permanent and cited by code.
4. History only when needed: `docs/log/<date>.md`, found with
   `grep -n '^## ' docs/log/*.md`. `docs/log/MANIFEST.json` proves the archived entries
   are unchanged; `npm run check:log` verifies it.

Rules every agent follows:

- **Look before editing.** `git status` first; preserve uncommitted work, whoever made it.
- **Log what you did.** A dated entry in `docs/log/<YYYY-MM-DD>.md` (newest first within the
  file): what changed, why, and what was run to verify it; an entry with no execution
  evidence says so. Then refresh "Resume here" in `memory.md` and keep it within 12 KB.
- **Never claim without running.** "Compiles" is not "works"; `cargo check` is not a test.
  A row is `done` only when its whole "Done when" is verified (`LLM-GOVERNANCE.md`).
- **Record a finished task everywhere, at once (user, 19 Nov 2026).** When a task is done, update
  its row in `GrapiX-Build-Plan.md` (what was done and how it was verified), its status in
  `progress.json`, and `progress.html` (by `npm run sync:tracker`) in the same change. A row
  that is built in part stays `active`, with the plan row saying what is left.
- **The gate.** `npm run check` before any commit. It is the whole gate at this stage.
  The hardware GPU tests are `#[ignore]`d and are not in it: run them with `npm run test:gpu`, one test
  at a time (two of them measure timing, and fail when others share the GPU).
- **Panchayati lock.** On the Panchayati mission channel (topic 10), read the channel first,
  then post `LOCK` before taking the gate or a commit lock and `UNLOCK` when done. One gate
  at a time. Address the post to every other agent that works in the tree, Codex included.
- **Mutation testing.** A new test is proven by breaking the code under test one thing at a
  time, seeing a named test fail, and restoring the file byte for byte. A mutant that
  survives means the test is too weak: strengthen it and run that mutant again.
- **Jev and Laya.** Design and acceptance questions go to both reviewers, on measured facts in
  text (they cannot read images). Laya must be the multilingual model at `max_len=8192`.
  The key lives outside the repository (`D:\Project KK\secrets\jev.txt`) and is never printed.
- **Commit and push only when the user says.** Never skip hooks or force-push.
- **Downloads need the user's approval**, named by file, source and size.
- **Live checks.** Before any click or key in a running window, prove that window is the one
  in front; a stray key once reached another application. Capture with `PrintWindow`
  rather than changing focus.
- **Rust is the source of truth for contracts.** Regenerate `Shared/generated-ts`
  (`npm run codegen`); never hand-edit it.
- **Never copy into an existing backup folder.** Use a new dated folder and `cp -n`.
