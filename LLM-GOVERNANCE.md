# LLM Governance — Verification and Progress Tracking (BINDING)

**This rule is mandatory for every LLM and every platform that works in this
repository — Codex, Claude, Kimi, Copilot, or any other, present or future. It
is not advisory. If you are an AI assistant about to change code here, read
this file and `AGENTS.md` first, and treat this file as the law of the repo.**

## The shared agent worktree

Every LLM works only in the one shared agent worktree, on `agent/shared`. The rule, how
to enter it and what is forbidden are stated once, in `AGENTS.md`. It binds every provider
without exception; read it before any edit, test, generated output or commit.

## Parallel agents in the one worktree (user, 24 Nov 2026)

Two or more agents (Claude sessions, Codex, Kimi, OMP, or a delegated agent) may edit, build and
test in the shared worktree at the same time. They stay in that one worktree: parallel work is
never a reason for a second worktree, a private branch or a copy. They work under these rules,
on the Panchayati mission channel, each post addressed to every other agent in the tree, Codex
included:

1. **Never overwrite another agent's work (user, 24 Nov 2026).** Agents may work on the same row
   or the same feature, but no agent overwrites, reverts or loses an edit another agent made. They
   agree on Panchayati how the work is split. Read the open claims, then post
   `CLAIM <agent>: <row> <paths or globs>`, naming what you will change. The claim starts when every
   agent with an open claim on the same row or paths answers `AGREE`. A claim that touches no open
   claim starts at once. An objection is settled on Panchayati, or goes to the user if the agents
   cannot agree. Two agents may edit one file only on parts they agreed to split, and then only by
   exact-match edits re-read just before each one. A file is never written whole while another agent
   has a claim on it. When an exact match fails because the text changed, re-read the file and redo
   the edit on what is there now. Never force it, and never restore your older copy. Widening a claim
   is a new `CLAIM`, agreed the same way. Post `RELEASE <agent>: <row>` once the work is recorded or
   set aside. A delegated agent works inside its parent's claim, and the claim names it.
2. **Hot files have one writer at a time.** `GrapiX-Build-Plan.md`, `progress.json`,
   `progress.html`, `memory.md`, `docs/log/*.md`, `Cargo.lock`, `Cargo.toml`, `package.json`,
   the Refusal enum in `Shared/contracts/src/lib.rs` and the generated files are edited only
   under `LOCK commit-lock`. Re-read the file just before each exact-match edit, never rewrite one
   whole, and post `UNLOCK` straight after. Keep the lock for that edit, not for the task.
3. **Builds do not share a target folder.** Each agent builds in its own cargo target folder
   outside the repository (`CARGO_TARGET_DIR`). A running process holds the default folder's
   files (24 Nov 2026). `npm run codegen`, `npm run sync:tracker` and the whole gate
   (`npm run check`) rewrite or read the whole tree, so each runs only under `LOCK gate`, one at a
   time. Two gates at once failed on each other's half-finished work on 7 Nov 2026.
4. **Leave other agents' work alone.** Never revert, reset, stash, clean, reformat or
   search-and-replace outside your claim. A failure in another agent's claimed area is reported to
   that agent on the channel, not fixed or reverted.
5. **Commit your own paths.** When the user says to commit, stage your claimed paths by name
   (never `git add -A` or `git add .`). Run the whole gate on the tree as it is, then commit under
   the commit-lock. If another agent's half-finished work fails the gate, wait for it or ask the
   user. Do not commit around it.
6. **No change to git state while anyone holds a claim.** No branch switch, rebase, pull, merge or
   history rewrite until every other claim is released or the user says.
7. **Decisions that reach another agent's work are mutual.** A change to something more than one
   claim depends on is agreed on Panchayati before it is made: a contract or shared type, a wire
   field, a refusal, a hot file's structure, a plan row's scope or a build dependency. Open a topic,
   propose and decide, and record the agreed decision in the log entry of the work that makes it.
   Without agreement it waits, or goes to the user.

These rules add to `AGENTS.md`'s workspace rule; they do not relax it. Design input:
`docs/evidence/0.12/jev-laya-parallel-agents.json`.

---

## Authoritative planning documents

There are exactly two planning documents, and they are the only ones:

| File | Role |
|---|---|
| `GrapiX-Build-Plan.md` | **The single authoritative build plan.** Rows are found by id. No other plan, roadmap, or handoff may be planned or worked against. |
| `progress.html` | **The single visual tracker.** Mirrors `progress.json`. The only place "done" is recorded. |

The ADRs under `docs/adr/` are **reference and rationale**, not the plan. Where
an ADR and the build plan appear to disagree on *what to build*, the build plan
wins for sequencing; the ADR still wins for the *why* and for invariants.

---

## The non-negotiable loop

**On EVERY task completion — every single work item, no exceptions — you MUST
run this loop in order. Skipping any step is a process violation.**

### 1. Verify against the handoff

Before you call anything "done," you MUST verify it by execution, against the
step's own **"Done when"** criterion in `GrapiX-Build-Plan.md` — not against
your own looser standard.

- "It compiles" is not verification. `cargo check` is not a test.
- Run the specific thing that proves it: the test, the conformance suite, the
  socket exchange, the rendered frame, the gate.
- Run the relevant gate for the area you touched, and prefer the whole gate:
  `npm run check` (boundaries → codegen-staleness → typecheck → TS tests →
  Rust tests → conformance). It is cheap and it is the gate.
- If the "Done when" criterion cannot be met yet, the step is **not done** —
  mark it `active` or leave it `pending`, and say precisely what is missing.
- A row's status is the user's: set `done` only when the whole "Done when" is verified.

### 2. Report the verification

State, in plain terms, **what you ran and what it produced** — the command and
its result. A claim of completion with no execution evidence is not accepted.

### 3. Only then mark `progress.html`

If — and only if — the verification passed and the "Done when" criterion is
met:

- Closing a row is two edits and one command: edit the row in `GrapiX-Build-Plan.md` (its
  text is the only copy), set its status in `progress.json`, then run
  `npm run sync:tracker`, which regenerates the rows and statuses embedded in
  `progress.html`. Never edit those embedded copies by hand: `npm run check:tracker` (part of
  `npm run check`) fails when the plan, `progress.json` and `progress.html` disagree.
- Set it to `done`. If it is genuinely underway but not verified, set `active`.
  If an external gate blocks it, set `blocked` and name the gate.
- **Never mark a step `done` without step 1 and 2.** A `done` with no
  verification behind it is worse than a `pending`, because everything
  downstream trusts it.

### 4. Commit the tracker with the work

The code change, the plan row, `progress.json` and the regenerated `progress.html` belong in
the **same commit**, so the tracker always reflects the tree it sits in.

---

## Hard rules

1. **One plan, one tracker.** Do not create or follow any other plan, roadmap,
   or progress file. Do not fork `progress.html`.
2. **No unverified `done`.** Ever. The tracker is only as honest as its
   strictest contributor.
3. **Honest status over flattering status.** `active`, `pending` and `blocked`
   are all respectable. A false `done` is the only failure that matters — the
   whole point of the tracker is that a wrong "done" is found by a client, on
   air, not by the gate.
4. **Preserve prior progress.** Never reset or downgrade another step's state
   without re-verifying it. If you suspect a prior `done` is wrong, re-run its
   verification and report what you find before changing it.
5. **Dependencies gate the start.** A step does not begin until every step in
   its "Needs" column is `done`. The tracker highlights ready steps; do not
   start work the plan says is not ready.
6. **One status vocabulary, used exactly.** A row is `done`, `active`, `blocked` or
   `pending`, and nothing else. Prose says the same four things with the words of
   `docs/README.md`, which map one to one:

   | Tracker state | Prose word | Meaning |
   |---|---|---|
   | `done` | Implemented | Built, and verified by execution against the whole "Done when" |
   | `active` | Partial | Built in part, with the gaps named |
   | `pending` | Planned | Decided, not built (or **Not present** if not yet decided) |
   | `blocked` | External gate | Waiting on hardware, a vendor SDK or lab time, named |

   "Partial" is not "nearly done", and "Planned" is not a euphemism. Do not invent a
   fifth word.

---

## Why this exists

The architecture's central discipline is **no silent fallback** — a component
that cannot do its job must say so by name, never approximate. The build
process has the same discipline: a step that is not verifiably done must say
so, never be marked done. An LLM that marks unverified work complete is the
process-level equivalent of a silent fallback, and it is the failure this rule
exists to prevent. The tracker is the team's shared picture of reality; keep it
true.
