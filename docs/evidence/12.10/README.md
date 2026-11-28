# 12.10 Overlay layers with channel/layer targeting: first slice

**Slice 1 built 20 November 2026; the row stays active.** Decision Q8 (16 Oct 2026): keep overlay layers with channel/layer targeting on one Program channel in scope, add the target fields now and refuse other channels by name.

## Built
- **`Envelope.target: Option<OutputTarget { channel, layer }>`** (`Shared/control-plane`): closed (`deny_unknown_fields`); absent on the wire when none, so an engine or client that predates it reads the envelope as before. Absent means the Program channel's main layer (`PROGRAM_CHANNEL`, `MAIN_LAYER`). It rides the envelope, as the operator does, so no request type changed; it moves into the requests when the engine composes layers.
- **`ClientRequest::is_targeted()`:** cue, take, clear and phase (the continue). The output configuration is the channel's own and is not aimed.
- **Refusals by name** (`Refusal::ChannelNotSupported`, `LayerNotSupported`), checked by the transport server after the credential, scope and operator, before the engine: only `program` exists, and only `main` is drawn. The name is shown cut to 32 characters and escaped, so a hostile one cannot put a line break or a long string in a log.
- **Client:** `Client::set_target`, sent with targeted commands only, kept across a redial.
- **As-run (12.11):** each record names the layer (`main` when none).

## Evidence
- `tests/target.rs`, 8 tests over a real server, client and mock engine: each of the four targeted commands refused for another channel and for another layer, and none reaches the engine; no target and an explicit `program/main` both work; a read and the output configuration carry no target; a hostile name is cut and escaped; the target survives a redial; the wire form (no target when none, round trip, closed). The conformance refusal audit drives both refusals through a real server.
- 11 mutants, one at a time: 10 each failed a named test; one is equivalent (the client sending a target on every request: the server ignores it on a command that is not aimed).
- Gate: fmt, clippy `-D warnings`, `npm run check` exit 0: 135 Node, 547 Editor, 1,209 Rust (38 ignored), conformance 633 passed, 0 failed, 9 skipped.

## Not done (the row stays open)
- Independent layers: a bug, a lower third and a ticker cued, taken, updated and cleared separately on one output with a deterministic z-order and a named refusal on conflict. The engine holds one Program scene; compositing several is its own engine change.
- Update, Continue and Out as commands of their own (the engine has Cue, Take, Clear and Phase), and the targeted clear that removes only its layer when the expected page still matches.
- Playout and the Playout MCP do not set a target yet.

## Layers slice, 24 to 25 Nov 2026 (task 112)
The engine holds one Program scene per layer and composites them together, lowest layer first.

- **Stack:** `compositor/stack.rs` and `stack.wgsl`: each scene is composited into its own working-space tiles as before; the stack then puts each over the one below (`u + d * (1 - u.w)`), rounds to the project depth at every step, and encodes Program (Rec.709) and Preview (sRGB) once. A scene whose tiles are not the stack's shape is refused before any GPU pass opens.
- **Engine:** `engine.rs`: `layer_programs`, `replacements`, `settle_replacements` (runs at the end of `sync_clock`; a replacement whose start frame has come is promoted at that frame, however late the clock is looked at). A take on an occupied layer: a queued replacement keeps its start; else the occupant's authored Out is played from the commit and the new scene starts `Out.frame_count()` frames later; else a cut. Clear drops what was queued; Phase and Clear take the layer of the target; Clear with no target is layer zero only.
- **Recovery:** `recovery.rs`: `layerPrograms` and `replacements` (both default empty, so an older journal reads), validated by layer range, an orphan replacement, and an unpublished scene, and named by the journal rule.
- **Refusal:** `LayerCanvasMismatch` (a scene whose canvas is not the one on air); `conformance/src/refusal_audit.rs` lists it as a limitation; `Shared/generated-ts` regenerated, `codegen:check` 563 files current.
- **Decision, Jev and Laya before the design (`layers-input.json`, `jev-laya-layers.json`):** followed Jev; Laya's dissent is in the file.

### Evidence
- 253 worker library tests pass; all 56 hardware tests pass on `GX_GPU_316_BACKEND=vulkan` (534 s) and `dx12` (1,747 s; the first DX12 run compiles shaders for about 100 s). These are `--ignored` tests and a plain `cargo test` does not run them.
- Hardware tests of this slice: 7 in `compositor/stack_tests.rs` and 8 in `engine/gpu_tests.rs` (named in row 12.10).
- Mutations, 15 of 15 caught (7 by the ordinary tests, 8 by the GPU tests). One survived the first run, the shader's per-step depth rounding, because the depth test accepted a difference of one level; `gpu_stack_rounds_to_the_project_depth_at_every_step_not_once_at_the_end` compares the alpha byte exactly (85, not the 84 of one rounding at the end) and kills it. Two earlier runs were stopped by hand because a test process hung (a mutant that stops a layer drawing can leave a test waiting for a frame); mutants 4, 12 and 13 were re-run with a 15 minute limit and were caught by an assertion.
- Workspace: contracts 366, control-plane 77, control-transport 65, editor 157, editor MCP library 15, mock engine 18, Playout 13, Playout MCP 23, conformance 8; `check:boundaries` and `check:protocol` pass. One test fails, `services/editor-mcp/tests/import_surface.rs` (`an_svg_is_imported_with_every_tier_named_and_its_source_kept`), because it expects a Stored effect without the `sceneLabel` field codex added in task 113; it is in codex's claim and was left to codex.

### Not done
- Update, Continue and Out as commands; the targeted clear with the expected-page check; clear all (armed, 12.14).
- A transition per layer or per take (C-5).
- Playout, the Playout MCP and the Editor setting a nonzero target; mixed-version enablement of explicit numeric targets.
- Memory: every layer's scene keeps its own tiles at once; a stack of many large scenes is not measured.
