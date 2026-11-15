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

## Publishing (5.10)

Publish writes one verified package into the Editor's **package folder**,
`GX_EDITOR_PACKAGE_DIR` if set, else the platform's package exchange root
(`<cache root>/packages`), and removes it after the engine's reply. The Editor
does not choose how it reaches the engine and holds no control-plane client
(boundary rule R6): it asks the engine for its declared locality on the
asset-plane address it publishes to. A co-located engine is handed the package
by path with no asset bytes; a LAN engine gets only the bytes it lacks, chunked.
The result line says which (`localPath` or `chunkedUpload`) and how many bytes
were sent.

For the by-path route the engine must have been started with the same folder as
`--package-dir`. `npm run shells` and `gx-engine-host` do that. An engine started
by hand without it refuses every publish by name (`PackageDirectoryNotConfigured`)
and the message gives the Editor's folder; there is no fallback to the chunked
route.
