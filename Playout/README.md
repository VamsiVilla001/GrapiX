# Playout

One of the three applications. Tauri 2 shell, Windows.

Owns published scene operations and is the only client allowed to Cue, Take,
Continue, Clear Program or configure outputs (invariant 5).

Its control surface is **intent-based**: it asks for `NextOpportunity` or a
specific frame and displays the frame number the engine committed to. It must
show reference-lock state and device tier unmissably, and it must never imply
instantaneous control it does not have (ADR-002).

playout-control listens on 4300.

## Layout

| Path | What it is |
|---|---|
| `shell/` | The Tauri 2 crate: the window, and the Rust command surface. |
| `web/` | The operator surface the shell loads. Plain HTML, CSS and ES modules. |
| `src/` | Typed, headless-testable modules: the clock display rules. |

`shell/src/lib.rs` is where invariant 5 and ADR-002 are enforced. It exposes
cue, take, clear, output configuration and status — and no authoring command
at all. No command accepts a time: the only scheduling that can be expressed
is `NextOpportunity` or a frame number, and every reply carries the frame the
engine committed to.

Severity is not decided here. `clock_summary` decides once on the shared side
and `src/clock-display.ts` maps it to a required prominence, so free-run can
never be rendered quietly on one surface and loudly on another (invariant 11).

Run it with `npm run playout` from the repository root.
