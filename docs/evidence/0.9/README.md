# 0.9, re-verified 8 November 2026 (Claude, Panchayati #104)

Row 0.9's done-when says no hand-written TS type duplicates a Rust one; the
Rust contracts are the source of truth and the TS is generated from them.
The done-row review (`docs/evidence/review-2026-11`) found one breach and
the user chose to reopen the row and fix it next; the fix landed in the
same commit, so the row stays `done` with the breach on record.

## The breach

`Editor/src/bindings.ts` declared its own `BindingIssue`
(`{code, objectId, property, path?, reason}`) while the generated contract
type is `{objectId, property, path, detail}`; the Editor preview's
`resolveSceneBindings` re-implements `gx_contracts::bindings` (the engine
and the MCP servers apply bindings in Rust; the preview applies them in TS
without a round trip per keystroke), and nothing held the two to the same
answers. Jev called it a breach at confidence 1.00; Laya said no breach
(0.21 with the whole input).

## The fix

- The preview reports the generated `BindingIssue` (`Editor/src/bindings.ts`
  re-exports it; `Editor/web/main.ts` prints `detail`). The hand-written
  type and its `code` field are gone.
- `Shared/contracts/fixtures/binding-resolution.json`: six scenes with the
  exact issues (object order, property-name order, wording) and the resolved
  values both sides must produce. `Shared/contracts/tests/binding_fixture.rs`
  and `Editor/tests/binding-fixture.test.ts` read the same file.
- The TS resolver now walks a binding map in property-name order, as Rust's
  `BTreeMap` does, so the issue order is part of the shared answer.

## What the fixture found on its first run

Rust's `is_index` accepted `0` and multi-digit indices but refused a single
digit other than `0`, so `teams.1.name` resolved in the Editor preview and
would have been refused on air (`binding path segment "1" is invalid`). The
TS grammar is `^(0|[1-9][0-9]*)$`; Rust now implements the same rule, and
the fixture's passing case binds `teams.1.name`.

## Executed

- `cargo test -p gx-contracts`: 247 unit tests and `binding_fixture` pass.
- `npx vitest run tests/bindings.test.ts tests/binding-fixture.test.ts`
  (Editor): 20 tests pass.
- `npx tsc -p Editor/tests/tsconfig.json` and `npx tsc --build` (Editor):
  exit 0. `Editor/tests/tsconfig.json` gained `resolveJsonModule` and a
  repository-root `rootDir` so the test can import the shared fixture.
- The whole-repository gate is recorded with the commit in `memory.md`.
