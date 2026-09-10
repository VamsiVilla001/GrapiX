# GrapiX 2.0 — session memory

The session log: what changed, when, and what was verified by execution. It
records history and grants no authority — see `docs/README.md` for the
authority order, and `docs/invariants.md` for the binding rules.

Status words are used exactly as `docs/README.md` defines them. **Planned** is
not a euphemism for nearly done.

---

## Rules for the next session

1. Read this file and `docs/invariants.md` before editing. The invariants are
   binding; this file is context.
2. Inspect `git status` before editing. Preserve uncommitted work.
3. Log every change here: what, why, and what was actually run to verify it.
   An entry with no execution evidence must say so.
4. Never describe anything as working without having run it. "Compiles" is not
   "works", and `cargo check` is not a test.
5. Run `npm run check` before committing. It is cheap and it is the whole gate
   at this stage.
6. Rust is the source of truth for contracts. Never hand-edit
   `Shared/generated-ts` — regenerate and commit the result.
7. Do not add a `Now` variant to `TakeAt`, or any other way for a client to
   send a time. That is invariant 8 and it is the load-bearing decision of the
   whole architecture.
8. The next implementation step is **M1 completion**, not a new direction: the
   mock peers and the conformance suite are stubs that exit 78, and the pixel
   gate does not exist.

---

## 2026-09-10 — M1 skeleton and basic setup on a clean branch

First commit on `GrapiX-2.0`, an orphan branch with no ancestry to 1.x. The
architecture comes from `docs/adr/0001-distributed-architecture.md`, carried in
as given; the invariants were distilled from the 1.x tree so 2.0 does not
re-earn faults that were already paid for once.

**Structure.** One Cargo workspace, one lockfile, eleven crates (invariant 24).
npm workspaces for the four TypeScript packages. Four contract packages, one
per plane, with no plane depending on another.

**Contracts, written to make invariants unbreakable rather than documented:**

- `RationalRate` has no `f64` constructor. 29.97 is 30000/1001, and a test
  asserts the float form is *not* equal to 29.97 (invariant 12).
- `TakeAt` has no `Now` variant, and a test matches it exhaustively so adding
  one stops the build (invariant 8).
- `Refusal` is a tagged enum where every variant names its failing condition
  (invariant 17). `UnsupportedBlendMode` carries the mode, so the `overlay`
  aliasing to `screen` that 1.x shipped cannot recur silently.
- `live_allowed()` in `gx-control-plane` is the single place ADR-005's three
  conditions are evaluated, so tier, platform and reference-lock cannot drift
  between engine, API and UI (invariant 20).
- `negotiate()` in `gx-media-plane` is the single implementation of ADR-004's
  L0/L1 table, which is what makes M4's relocation a deployment change
  (invariant 16).
- `is_syntactically_safe()` in `gx-asset-plane` rejects traversal, absolute and
  drive-letter paths, and carries a test documenting that it is the *first* of
  two gates — a syntax check cannot see a symlink (invariant 42).

**One design correction during the work.** `MediaCodec` was first declared in
`gx-control-plane`, because the capability exchange offers the set. That forced
`gx-media-plane` to depend on `gx-control-plane` — a plane-to-plane dependency,
which contradicts the independent failure semantics in ADR-001. Moved to
`gx-contracts`, which both planes already depend on.

**One real fault found and fixed.** `#[ts(export)]` on the contract types made
ts-rs export bindings during `cargo test`, into a per-crate `bindings/`
directory. The result was four copies of `MediaCodec.ts` and two of
`ContentHash.ts` — precisely the mirroring drift ADR-003 exists to end, arriving
by a different route. Removed the attribute; `gx-contract-codegen` is now the
only generator (invariant 27), writing one copy of each type plus a barrel
`index.ts`.

**Guards.** `tools/check-boundaries.mjs` fails on a cross-domain dependency and
on a hand-authored file in generated output. `tools/codegen-check.mjs` fails if
the committed generated output differs from a fresh run. Both were
negative-tested: a Shared-imports-Editor line, a hand-written file in
`generated-ts/src`, and a doctored `Locality.ts` were each caught, and the tree
restored clean afterwards.

### Verified by execution

| What | Result |
|---|---|
| `cargo check --workspace --all-targets` | Clean, 11 crates |
| `cargo test --workspace` | **29 passed, 0 failed** |
| `cargo fmt --all` | Applied |
| `cargo run -p gx-contract-codegen` | 21 contract types + barrel into one directory |
| `npm install` | Clean, 4 workspace packages linked |
| `npx tsc --build` | Clean, 4 projects |
| `node tools/check-boundaries.mjs` | OK, and caught 2 injected violations |
| `node tools/codegen-check.mjs` | OK (22 files), and caught 1 injected staleness |

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/contracts`, `control-plane`, `asset-plane`, `media-plane` | **Partial** — the types and decision functions in this entry exist and are tested; no transport, no serialisation over a wire |
| `Shared/generated-ts` | **Implemented** — generated, current, checked |
| `tools/contract-codegen`, both guards | **Implemented** — run, and negative-tested |
| `services/render-engine/host`, `worker` | **Planned** — stub, exits 78 |
| `mocks/*`, `conformance` | **Planned** — stubs, exit 78 |
| `services/schema-mcp` | **Planned** — declares read-only capability, no server |
| `Editor`, `Playout` | **Planned** — type-level entry points only, no Tauri shell |

### Not done, and not claimed

- No mock peer behaves like a peer. They exit 78.
- No conformance suite. The merge gate in invariant 26 has nothing behind it.
- No pixel gate, and no baseline snapshot. M1 requires the baseline be captured
  **before** anything changes, and nothing has been captured.
- The `overlay` blend-mode fix is expressible in the refusal type but is not
  implemented, because there is no renderer.
- No Tauri scaffold in either product.
- Nothing has been rendered, transported, published or taken.
