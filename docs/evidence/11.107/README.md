# 11.107 and the spec parts of 11.104: path editing and the Pen (23 to 24 Nov 2026)

See `PEN_TOOL_ARCHITECTURE.md` for how the spec maps onto the code. Both rows stay `active`.

## Checks

- **Rust:** `cargo test -p gx-contracts`: the path maths tests (dense-reference nearest point for 200 random cubics and for a loop, a
  cusp and a point; exact splits; bounds; length; every edit and its refusals) and the `editPath` tests for a shape's subpaths and a mask.
  The shared fixture `Shared/contracts/fixtures/path-geometry.json` is checked by the Rust test and rewritten with `GX_WRITE_FIXTURES=1`.
- **Conformance:** `gx-conformance` reports CONFORMANT with `editPath` in the command trace (built in a separate target folder,
  since `gx-editor-mcp.exe` was running and blocked the normal one).
- **TypeScript:** the Editor's path maths against the same fixture; the pointer model; the page wiring (source-pattern tests as the
  repo does elsewhere, plus a render test of the overlay); the Pen's new modifiers.
- **Mutants** (`tools/mutate_paths.py`, 132): TypeScript 101, Rust 31.
  - TypeScript: 85 caught first; of 16 survivors, 13 now caught by new tests. Three are equivalent: `tAtLength` clamping at the end gives the
    same answer by bisection; the nearest point's two ends are also added by the root walk; the sign-change count only changes how often a
    piece is split.
  - Rust: 29 of 31 first; `rs-smooth-opposite` was a real gap (handles on the same side) and a test now catches it; `rs-nearest-ends` is
    the same equivalent as the TypeScript one.
  - **Report of a mistake:** the first Rust run printed "killed 31 of 31". It was false: the command had two test filters, which cargo
    refuses, so each mutant "failed" to start. It was found by running the command by hand, fixed, and rerun.

## Not done

A window check of the path tools; join and snap 11.110; Pen creating a mask 11.111; animated paths 11.112; auto-smooth and remove point
11.113; SVG 11.114; performance and render parity 11.115; the Shift step as a setting 11.116. No independent review was run.
