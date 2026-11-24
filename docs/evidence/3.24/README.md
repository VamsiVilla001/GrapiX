# 3.24 GPU/CPU load balancer: design and first slice (18 Nov 2026)

`jev-laya-design.json` holds the three questions, the facts given, and both answers.

| Question | Jev | Laya (second opinion) | Chosen |
|---|---|---|---|
| Signal | leading indicators with hysteresis, plus any late or missed frame trips at once (1.00) | late only | Jev |
| Order | graded and reversible (1.00) | queue everything | Jev |
| How Preview is shed | decimate (0.55) | move to CPU | Jev; the CPU renderer would take cores from the render loop |

Built in this slice: `services/render-engine/worker/src/governor.rs`, wired in `engine.rs` and `log.rs`;
telemetry in `Shared/control-plane/src/telemetry.rs`. Mutations: 12 run (`G1` to `G12`), each failed a named
test and was restored byte-identical; `G11` first survived because its test compared the constant with
itself, and was fixed.

Not built: levels 2 to 4, thread priority, and the sustained load test on DX12 and Vulkan.

# Levels 2 to 4 built (20 November 2026)

**The row stays active:** the sustained load test on DX12 and Vulkan that its acceptance names still needs a quiet GPU.

- **Level 2, Preview decimated:** one Preview frame in four (`PREVIEW_DECIMATION`) is delivered; Program is emitted on every frame (`FrameEmitter::emit_program`), and the Preview slot keeps its last frame. This sheds the consumer's work, not the GPU's: the compositor still draws both from one render, so the GPU saving needs the output ring to skip the Preview encode (not built).
- **Level 3, preparation deferred:** a publication, a package or a preview waits at the peer's `CalmGate` (the engine offers the governor's own gate) for up to 5 s (`MAX_CALM_WAIT`), **outside the peer's lock**, so a cue or the locality read is never queued behind it. A wait that runs out goes on and is on the log (`load.defer_expired`); nothing is dropped.
- **Level 4, non-live work refused:** a new headless render, preview or publication is refused `LoadShed { request, level, retry_after_ms: 5000 }` by name, before any work. Program, the control plane and reads are never asked. It returns when the governor releases the level.
- `WIRED_LEVEL` is now the last level, so the engine reports every level it sheds at.
- Tests: governor 2 (the decimation table; the wait ends on a release from another thread and gives up on its deadline), engine 3 (refusals at the last level for render, publish and preview with Program untouched and the answer returning at a lower level; nothing refused below it; the offered gate is the governor's), emitter 1, `Shared/asset-plane/tests/calm.rs` 2 (a publication waits while the locality read is answered at once; a wait that runs out goes on), the conformance refusal audit drives `LoadShed` on a real engine.
- Mutants, one at a time: 16, each failed a named test (decimation off, ratio, level; the wait never waiting, wrong level, deadline ignored; refusal from level 3, never, and each of render, publish and preview unchecked; not wired to the last level; no gate offered; the gate waited inside the lock; publication not asked; wait unbounded).
- Gate: fmt, clippy `-D warnings`, `npm run check` exit 0: 135 Node, 547 Editor, 1,217 Rust (38 ignored), conformance 634 passed, 0 failed, 9 skipped.

## Still not built
Thread priority for detached work; the Preview encode skipped on the GPU output ring; the sustained load test (headless renders and previews pushed until the GPU saturates, Program with no late or missed frame while the shifts happen) on DX12 and Vulkan.
