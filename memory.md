# GrapiX 2.0 — working handoff

What the next session needs, and where the rest is. **This file is the working handoff, not
the history and not the law.** The binding rules are in `docs/invariants.md` (numbers are
permanent; code cites them) and `AGENTS.md` (workspace and working protocol). The dated
history is under `docs/log/`, one file per day. This file is held to 12 KB by
`npm run check:protocol`; keep it a handoff.

Status words follow `LLM-GOVERNANCE.md`: a row is `done`, `active`, `blocked` or `pending`;
in prose, Implemented, Partial, Planned, External gate. Nothing is Implemented without
execution evidence.

---

## Working rules

1. Read `AGENTS.md`, `LLM-GOVERNANCE.md`, then this file. Read `docs/invariants.md` before
   changing contracts, transport, timing or rendering. Find a row by id in
   `GrapiX-Build-Plan.md`; do not read the whole plan.
2. `git status` before editing; preserve uncommitted work.
3. Log every change in `docs/log/<YYYY-MM-DD>.md` (newest first within the day): what, why, and
   what was run to verify it. No execution evidence means the entry says so. Then refresh
   "Resume here" below.
4. Never describe anything as working without having run it. Run `npm run check` before any
   commit; commit and push only when the user says.
5. Rust is the source of truth for contracts; regenerate `Shared/generated-ts` with
   `npm run codegen`, never edit it.
6. A row is `done` only when its whole "Done when" is verified, and the status is the user's.
   Update `progress.html` and `progress.json` together (row 0.13 will generate them).
7. Where the old numbered rules went: rules 8, 9, 12 and 18 are invariants 8 and 9, 46, 56 and
   21; rules 10, 11, 13, 14, 16, 17 and 19 to 29 are invariants 67 to 83, in their original words;
   rules 1 to 7 and 15 are this list and `AGENTS.md`. The file as it stood before 0.12 is
   `docs/log/0000-memory-header-and-rules-before-0.12.md`.

## Resume here

**State on 24 November 2026.** Branch `agent/shared`. The user asked to commit everything done up to 24 Nov;
that commit holds the work of 19 to 24 Nov (pen, mask and path tools, path animation and links, guides,
matte views, variable feather, tiled layer drawing, 1.13 identifiers, 12.15 bulk Cue ID plans, 1.14 ADR
numbering, the per-frame copy removed from animated paths, and much Editor and Playout work). Details are in
`docs/log/2026-11-23.md` (its 24 Nov entries) and in each plan row.

- **Parallel agents** (user, 24 Nov): several agents may work in this one worktree, even on the same row,
  but never overwrite each other. See `LLM-GOVERNANCE.md`, "Parallel agents in the one worktree":
  CLAIM / AGREE on Panchayati topic 10, hot files under the commit-lock, a target folder per agent.
- **Split since 24 Nov (user):** Claude does the frontend: the new Figma UI in both apps, designed on branch
  `claude/vibrant-bassi-6cce4b`, `docs/design/`, Figma file `gyGkmEFX4oAuknNNI4dq9k`. Codex does the backend:
  12.10 slice 2 is verified (task 111). The transport now passes numeric Program layers to the peer.
  Task 112 is active under 12.10. Scene timing now takes a scene state explicitly and both phase tests pass.
  Panchayati topic 14 is decided. Independent layer cues restore from the journal. The status and Take wire changes are verified.
  Check graphic backend (`cmd_scene_preflight`, topic 16) was finished by claude on 24 Nov while codex was out of its 5-hour limit; codex's task 112 and row 12.10 work was left untouched.
  Task 112 was finished by claude on 25 Nov (codex's 5-hour limit): the engine holds one Program scene per layer, a GPU `LayerStack` composites them in layer order, a take on an occupied layer replaces it through the old scene's Out (a cut with none), Clear and Phase are per layer, layers and queued replacements are journaled; 15 of 15 mutants caught, 56 hardware tests pass on dx12 and vulkan (run with `--ignored`). Still open: Update, Continue and Out as commands, the targeted clear's expected-page check and clear all, C-5 transitions, and any caller setting a nonzero target. `services/editor-mcp/tests/import_surface.rs` fails on task 113's `sceneLabel` (codex's to fix). Task 113 is verified. Create, duplicate and stored import allocate the first free Scene ID; MCP returns it. Task 114 is verified. Playout shell exposes signed-in Cue ID preview and confirmation for the configured rundown. Conformance drives CuePlanStale.
  `Shared/contracts/src/animation.rs` is RELEASED by claude (25 Nov, Panchayati was down, so this note stands for the post): Bounce and Elastic are finished and verified (contract, `ease_at`, codegen, Editor mirror; 1,078 Rust tests and conformance pass). Codex task 118 may edit the file now; start from the file as it stands in the worktree, not from HEAD. After a contract change run `npm run codegen` and `npx tsc --build` in `Shared/generated-ts`. claude will not touch `animation.rs`, `Shared/generated-ts/**` or `Editor/src/timeline/{easing,key-edit,key-card}.ts` until task 118 says it is done.
- **Open questions for the user:** the 12.15 switch to skip to the next free number. The Figma conflicts: six
  or eight menus, CUE versus TAKE words, layout names, Moments and Cast, white dividers, info blue.
- **Known:** two GPU timing tests (`output_tests` ring and budget) fail only when the whole GPU suite runs in
  parallel. Two `.claude` worktrees are still registered, and the agent-entry guard refuses while they are.
  Nothing has been checked in the real Editor window since 19 Nov.

**Gate.** `npm run check` (boundaries, protocol, tracker, web-shared, codegen, typecheck, TS tests, Rust
tests, conformance). `gx-engine-host` tests are excluded from the Rust step: a named hole, run with
`npm run test:rust:host`.

## Index

- **Where things are:** plan `GrapiX-Build-Plan.md` (backend modules B1 to B14, frontend F1 to F7,
  parked X1 to X6; every row is found by id); tracker `progress.html` with `progress.json`;
  decisions `docs/adr/`; brand `docs/brand/`; evidence per row `docs/evidence/<row>/`.
- **History:** `docs/log/` has one file per day from `2026-09-10` to `2026-11-19`, plus
  `undated-omp-session-import.md`. Find an entry with `grep -n '^## ' docs/log/*.md`; open the day.
  `docs/log/MANIFEST.json` records the 162 entries archived by 0.12, each byte for byte.
- **Recent days:** `2026-11-19` (Windows only; wordmark), `2026-11-18` (module split; plan rewrite;
  effects, layout, 11.65 to 11.80, 3.24, 2.27), `2026-11-17` (2.14 to 2.20, OSI audit),
  `2026-11-16` (2.13), `2026-11-15`, `2026-11-08`, `2026-11-07`.
- **Standing user directions** are kept with the session's private notes, not here; the plan's
  "Decisions in force" section is the repository's copy.
