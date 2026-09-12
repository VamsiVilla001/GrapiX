# Editor

One of the three applications. Tauri 2 shell, Windows and macOS.

Owns mutable authoring content: scene, material, font, script and timeline
tools, project state, and durable Publish to Playout. **It cannot change
Program or outputs** (invariant 4), and it is never eligible to own Program.

Three.js is the sole browser renderer — interim 2D and the permanent overlay
layer. PixiJS is removed (ADR Part C). Editor never imports renderer internals
(invariant 3).

project-api listens on 4100.

## Layout

| Path | What it is |
|---|---|
| `shell/` | The Tauri 2 crate: the window, and the Rust command surface. |
| `web/` | The web layer the shell loads. `main.ts` is bundled to `main.js`. |
| `src/` | Typed, headless-testable modules: viewport, camera, colour policy. |

`shell/src/lib.rs` is where invariant 4 is enforced. It exposes new, load,
save and publish — and no cue, take, clear or output command at all. The
split is the absence of a capability, not a flag that could be set wrongly.

Run it with `npm run editor` from the repository root, which bundles the web
layer first. `npm run shells` starts the render engine and both applications
together.
