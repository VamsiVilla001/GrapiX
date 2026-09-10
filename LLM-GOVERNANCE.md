# LLM Governance — Verification and Progress Tracking (BINDING)

**This rule is mandatory for every LLM and every platform that works in this
repository — Codex, Claude, Kimi, Copilot, or any other, present or future. It
is not advisory. If you are an AI assistant about to change code here, read
this file and `AGENTS.md` first, and treat this file as the law of the repo.**

There are exactly two planning documents, and they are the only ones:

| File | Role |
|---|---|
| `GrapiX-Build-Plan.md` | **The single authoritative build plan.** 164 steps across 19 phases. No other plan, roadmap, or handoff may be planned or worked against. |
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

### 2. Report the verification

State, in plain terms, **what you ran and what it produced** — the command and
its result. A claim of completion with no execution evidence is not accepted.

### 3. Only then mark `progress.html`

If — and only if — the verification passed and the "Done when" criterion is
met:

- Update the step's state in `progress.html`'s `INITIAL_STATE` (or via the UI,
  then export) **and** mirror it to `progress.json` so the two never drift.
- Set it to `done`. If it is genuinely underway but not verified, set `active`.
  If an external gate blocks it, set `blocked` and name the gate.
- **Never mark a step `done` without step 1 and 2.** A `done` with no
  verification behind it is worse than a `pending`, because everything
  downstream trusts it.

### 4. Commit the tracker with the work

The code change and its `progress.html` / `progress.json` update belong in the
**same commit**, so the tracker always reflects the tree it sits in.

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
6. **Status vocabulary is exact.** Use the words in `docs/README.md` —
   Implemented / Partial / Planned / External gate. "Partial" is not "nearly
   done," and "Planned" is not a euphemism.

---

## Why this exists

The architecture's central discipline is **no silent fallback** — a component
that cannot do its job must say so by name, never approximate. The build
process has the same discipline: a step that is not verifiably done must say
so, never be marked done. An LLM that marks unverified work complete is the
process-level equivalent of a silent fallback, and it is the failure this rule
exists to prevent. The tracker is the team's shared picture of reality; keep it
true.
