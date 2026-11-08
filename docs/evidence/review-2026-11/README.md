# Re-review of every done row, 8 November 2026 (Claude, Panchayati #104)

User instruction, 8 Nov 2026: re-review all completed tasks with Jev
(TypeSafe `jev-1.14.0`, via `@typesafe-ai/sdk`) and Laya
(`convaiinnovations/laya` 0.4.28, local, CPU), compare their decisions, and
update `progress.json` and `progress.html` after the review.

## Method

1. `tools/digest_rows.py`: every row `done` in `progress.json` (123), with its
   done-when, the tracker `$comment` sentences naming it, the `memory.md`
   entries naming it (heading or body), and whether `docs/evidence/<row>/`
   exists. `done-rows-digest.json`.
2. `tools/code_refs.py`: the tests, conformance checks and source files that
   cite each row id. `done-rows-code-citations.json`.
3. `tools/review_done.py`: the same four typed questions to both models per
   row (done-when met by executed evidence; evidence names what was run;
   silent-substitution risk; weakest point). `done-rows-jev-laya.json`.
4. Hand re-verification of every concrete finding before any state change
   (LLM-GOVERNANCE hard rule 4), and the decisions put to both models
   (`findings-jev-laya.json`, `ci-jev-laya.json`) and then to the user.
5. Version and context check, on the user's instruction. Jev: the SDK is
   `@typesafe-ai/sdk` 0.7.0 (npm `latest`); the account's `jev-latest` and
   `jev-preview` aliases are both served by `jev-1.14.0`
   (`tools/jev_models.mjs`). Laya: the `laya`
   package is 0.4.28 (PyPI latest) and the checkpoint is at the Hugging Face
   head, but `convaiinnovations/laya` reads 512 tokens and
   `tools/laya_truncation.py` showed it had silently read only the first 512
   of 83 of the 123 row inputs and of all four decision inputs
   (`laya-context.json`). Every Laya answer was therefore re-asked of its
   sibling `convaiinnovations/laya-multilingual` (same release day, 678 MB,
   Apache-2.0) at `max_len=8192`, which read every input whole
   (`tools/rerun_laya.py`, 467 s on CPU). The tables below carry those
   full-input answers; the superseded 512-token answers stay in every file
   under `laya_base_512`. Jev's answers came from the full inputs and are
   unchanged.

The key is read from the user's secrets file by `tools/jev_runner.mjs` and
never printed, logged or committed. The tools run from a scratch copy beside
a Laya virtual environment outside the repository.

## What the models said, and how much weight it carries

| | Jev | Laya |
|---|---|---|
| Rows judged done-when met (≥ 0.5) | 26 of 123 | 123 of 123 (512-token run: 113) |
| Rows where the two agree (both ≥ 0.5 or both < 0.5) | 26 of 123 | |
| Most common weakest point | an unexecuted clause (96) | none (101) |

Neither result is a verdict on its own. Jev's low scores are mostly an
artefact of the evidence it was given: a text digest of records cannot show
that a test ran, and Jev rose from 0.42 to 0.87 on 3.22 when given the
clause-by-clause evidence instead of a summary (`docs/evidence/3.22`).
Laya, reading every input whole, rates every row done (lowest
0.59) and on the decision sets sided against the hand-verified
finding three times (keep 0.10 and 4.2 done, no 0.9 breach, leave CI
failing); its card's zero-shot caveat applies. **No row's state was changed
on a model score.** States change only on the hand-verified findings below,
each approved by the user.

## Findings, re-verified by hand

| Finding | Re-verification | Jev | Laya | User decision (8 Nov) | Rows |
|---|---|---|---|---|---|
| CI has never run the gate on this tree. `.github/workflows/check.yml` triggered only on `GrapiX-2.0` and `main`; `agent/shared` (50 commits ahead of its remote) never triggered it; the last two runs (11 Sep, 11 Oct) failed at `cargo fmt --check` on both platforms. | `gh run list`, `gh run view --log-failed`; local `cargo fmt --check` reports ~100 unformatted files; local `cargo clippy -D warnings` failed in every crate | downgrade (confidence 0.40) | keep done (0.05) | **Reopen 0.10 and 4.2 until a green CI run**; add `agent/shared` to the triggers; one whole-workspace format commit after Codex commits its open work | 0.10, 4.2 → active |
| Row 0.9 "no hand-written TS type duplicates a Rust one": `Editor/src/bindings.ts` hand-wrote `BindingIssue` (a different shape from the generated type) and re-implements `gx_contracts::bindings::resolve_scene_bindings` for the Editor preview, with no test holding the two together. `PreviewFrame` in `preview-playback.ts` is a name collision, not a duplicate. | scan of every exported TS type in Editor/Playout against the generated names | breach (1.00) | no breach (0.21) | **Reopen 0.9 and fix next.** Fixed in this same commit, so the row stays `done` with the breach recorded (`docs/evidence/0.9`): the preview reports the generated `BindingIssue`, and `Shared/contracts/fixtures/binding-resolution.json` holds TS and Rust to the same issues, order, wording and resolved values (`Shared/contracts/tests/binding_fixture.rs`, `Editor/tests/binding-fixture.test.ts`). The fixture found a second drift on its first run: Rust's `is_index` refused single-digit array indices other than `0`, so `teams.1.name` previewed in the Editor and would have refused on air; fixed. | 0.9 stays done, re-verified |
| The engine's control port (`Shared/control-transport/src/server.rs`) verifies a token's signature and then ignores its claims: any valid token, of any role, can send Take, Clear or output configuration straight to the engine. Scopes are enforced only by the MCP server (8.11, 8.13). No row owns transport-level enforcement. | read of `server.rs`; `Role::permits` is called only in `mcp.rs` to filter the capability surface | | | **Add a plan row** in the build-plan review (#105); no code change today | (new row) |
| 5.2 and 1.10 were marked done at plan adoption (b5e0755, 10 Sep) with no evidence record. | 5.2: `auth_and_reconnect.rs::program_survives_a_reconnect_and_the_epoch_matches` runs in the gate. 1.10: `ProtocolMismatch`, `TierTooLow`, `MultipleClockDomains` and `ReferenceUnlocked` are dedicated codes driven by the conformance refusal audit. | record and keep (0.98) | record and keep (0.15) | (no state change) | 5.2, 1.10 stay done; evidence recorded here |
| 5.5's done-when ("consumers adapt without code change") is not executable as written; locality is declared in `EngineCapability` and read by Playout. | read of the capability exchange and `services/playout` | propose a rewrite (0.31) | accept (0.29) | goes to the build-plan review (#105) | 5.5 stays done |

Also fixed in this commit so CI's lint can pass once formatted: every
`clippy -D warnings` error across contracts, asset-plane, write-semantics,
mcp-server, editor, control-transport, conformance, the render worker and
both shells (`cargo clippy --workspace --all-targets -- -D warnings` exits 0). Mechanical fixes (unused imports and variables, `?` for
`let … else`, struct literals for `Default` then assign, `clamp`, `find`,
`&Path`, a doc-list blank line, an explicit NaN comparison) and targeted
`#[allow]`s with a comment where the lint's advice contradicts the design:
`result_large_err` on functions whose refusal carries field, value and
allowed list by design, `large_enum_variant` on the publish request set,
`type_complexity` in one test, and `dead_code` on the transport's held
claims (the scope finding above).

## Not done by this review

- The whole-workspace `cargo fmt --all` (user-approved) waits for Codex to
  commit its open 3.17 work.
- Pushing `agent/shared`, which starts CI, stays with the user. 0.10 and
  4.2 stay `active` until that run is green.
- 60 done rows have no test, conformance check or source comment that names
  them (`done-rows-code-citations.json`). Their verification may exist under
  another name; locating it row by row is the follow-up for #104.

## Every done row

Scores are the probability each model gave that the done-when is met by
executed evidence (Laya: `laya-multilingual`, whole input); "tests" counts
tests that cite the row id.

| Row | Name | Jev | Laya | Jev's weakest point | Tests |
|---|---|---|---|---|---|
| 0.1 | Clean branch; one Cargo workspace, one lockfile | 0.16 | 0.90 | unexecuted_clause | 10 |
| 0.2 | Pin toolchains: Rust, Node, wgpu 30 across every crate | 0.19 | 0.96 | unexecuted_clause | 12 |
| 0.5 | tracing + OpenTelemetry skeleton | 0.02 | 0.79 | unexecuted_clause | 12 |
| 0.6 | Structured refusal type — code, field, given, allowed, severity | 0.48 | 0.82 | none | 9 |
| 0.7 | RationalRate type (num/den). No float rates anywhere | 0.19 | 0.88 | unexecuted_clause | 4 |
| 0.8 | Stable ID and Revision types; if_revision semantics | 0.54 | 0.86 | stale | 12 |
| 0.9 | Contracts package; Rust is source of truth, TS generated | 0.09 | 0.91 | unexecuted_clause | 10 |
| 0.10 | Conformance harness scaffold and mock-peer pattern | 0.16 | 0.86 | unexecuted_clause | 0 |
| 0.11 | Consolidate all project agents into one shared worktree and enforce LLM workspace governance | 0.02 | 0.95 | unexecuted_clause | 0 |
| 1.1 | Scene document schema | 0.24 | 0.73 | unexecuted_clause | 6 |
| 1.2 | Object type catalogue and full property surface | 0.76 | 0.92 | stale | 3 |
| 1.3 | Material model; fit and blend enums as the single source of truth | 0.11 | 0.81 | unexecuted_clause | 2 |
| 1.4 | Colour types: linear working space, tagged sources, output transforms | 0.29 | 0.80 | none | 3 |
| 1.5 | Design system token schema | 0.04 | 0.93 | unexecuted_clause | 9 |
| 1.6 | Motion token and preset schema: phases, 0–1 time, stagger modes | 0.05 | 0.79 | unexecuted_clause | 2 |
| 1.7 | Asset addressing: content hash plus project-relative path | 0.67 | 0.72 | unexecuted_clause | 1 |
| 1.8 | .gpxpkg format and manifest | 0.05 | 0.93 | unexecuted_clause | 1 |
| 1.9 | Protocol v3 message set — intent-based take, committed frame returned | 0.04 | 0.91 | unexecuted_clause | 0 |
| 1.10 | Capability: locality, device tier, clock source, reference state | 0.02 | 0.82 | unexecuted_clause | 0 |
| 1.11 | Mock engine, mock playout, mock editor | 0.08 | 0.91 | unexecuted_clause | 0 |
| 1.12 | Conformance suite green against all three mocks | 0.26 | 0.92 | unexecuted_clause | 0 |
| 2.1 | Atomic write helper: unique temp, fsync, retry on contention, directory fsync | 0.16 | 0.91 | unexecuted_clause | 1 |
| 2.2 | Filename sanitiser: reserved names, illegal characters, length, NFC | 0.08 | 0.92 | platform_gap | 3 |
| 2.3 | Case canonicalisation policy: compare insensitively, preserve for display | 0.61 | 0.85 | platform_gap | 1 |
| 2.4 | OS directory conventions; the in-repo default removed | 0.18 | 0.81 | unexecuted_clause | 2 |
| 2.5 | File watching with debounce, both platforms | 0.06 | 0.89 | unexecuted_clause | 1 |
| 2.6 | Project store: JSON, backups, autosave ring | 0.02 | 0.89 | unexecuted_clause | 0 |
| 2.7 | Asset store: SHA-256 dedupe, two-address, geometry read from headers | 0.02 | 0.87 | unexecuted_clause | 0 |
| 2.8 | Font subsystem ported across unchanged | 0.81 | 0.97 | platform_gap | 0 |
| 2.9 | gx1 HMAC tokens; roles and scopes | 0.05 | 0.92 | unexecuted_clause | 0 |
| 2.10 | Audit and operations logging, sanitised | 0.91 | 0.93 | none | 1 |
| 3.1 | wgpu init; backend selection D3D12 / Metal / Vulkan | 0.01 | 0.93 | unexecuted_clause | 0 |
| 3.2 | Device tier negotiation T0–T3 | 0.06 | 0.94 | unexecuted_clause | 0 |
| 3.3 | Colour pipeline: linear internal, tagged textures, sRGB and Rec.709 output | 0.04 | 0.59 | platform_gap | 0 |
| 3.4 | Scene parse to prepared scene | 0.61 | 0.88 | unexecuted_clause | 1 |
| 3.5 | PathRasteriser trait; lyon implementation behind it | 0.03 | 0.91 | unexecuted_clause | 0 |
| 3.6 | Text via cosmic-text: shaping, fallback, bidi, OpenType | 0.25 | 0.94 | unexecuted_clause | 1 |
| 3.7 | Meshes, glTF, materials, lights, cameras | 0.37 | 0.93 | unexecuted_clause | 0 |
| 3.8 | ProgramClock: rational rate, absolute deadlines, ClockSource abstraction | 0.02 | 0.93 | unexecuted_clause | 0 |
| 3.9 | Tiling with overscan above the GPU texture limit | 0.02 | 0.88 | unexecuted_clause | 0 |
| 3.10 | OutputAdapter trait; null, virtual, recording | 0.02 | 0.93 | unexecuted_clause | 0 |
| 3.11 | Preview and Program frame emission; bounded queue, counted drops | 0.03 | 0.95 | unexecuted_clause | 0 |
| 3.12 | WAL recovery journal; restore starts output-inhibited | 0.01 | 0.96 | unexecuted_clause | 0 |
| 3.13 | Refusal coverage audit — every unsupported case refuses by name | 0.39 | 0.95 | unexecuted_clause | 3 |
| 3.14 | Pinned EffectCraft render/GPU compatibility spike on Windows (ADR-0003); no production cutover | 0.02 | 0.89 | unexecuted_clause | 0 |
| 3.15 | Project working colour space: compositing follows the project's declared colour space | 0.03 | 0.96 | unexecuted_clause | 4 |
| 3.16 | GrapiX-owned GPU compositor: layer stack, transforms, opacity and composition on the GPU | 0.11 | 0.94 | unexecuted_clause | 3 |
| 3.20 | Full blend-mode set on the GPU | 0.10 | 0.95 | unexecuted_clause | 7 |
| 3.22 | Typed effect registry and the broadcast effect set on the GPU | 0.04 | 0.94 | unexecuted_clause | 5 |
| 4.1 | Reference scene set: colour ramp, safe areas, text, vector, 3D, every rate family | 0.02 | 0.96 | unexecuted_clause | 0 |
| 4.2 | Headless render harness on both platforms | 0.13 | 0.84 | unexecuted_clause | 0 |
| 4.3 | Baseline capture, committed to the repo | 0.04 | 0.93 | unexecuted_clause | 0 |
| 4.4 | CI gate with a diff threshold that fails the build | 0.09 | 0.71 | unexecuted_clause | 0 |
| 5.1 | Control plane over named pipe and unix socket | 0.01 | 0.78 | unexecuted_clause | 0 |
| 5.2 | Session, auth, epoch, reconnect and reconciliation | 0.02 | 0.91 | unexecuted_clause | 0 |
| 5.3 | Asset plane local: hash preflight, transfer only the difference | 0.02 | 0.88 | unexecuted_clause | 0 |
| 5.4 | Media plane local: shared memory or handle passing | 0.02 | 0.86 | unexecuted_clause | 0 |
| 5.5 | Locality declared in the capability exchange | 0.02 | 0.87 | unexecuted_clause | 0 |
| 5.6 | Conformance suite passes over the real transport, not just mocks | 0.07 | 0.91 | vague_record | 0 |
| 6.1 | Published library store; stable Take IDs | 0.05 | 0.92 | unexecuted_clause | 0 |
| 6.2 | Cue, take, continue, out, clear as intent; committed frame returned | 0.04 | 0.97 | unexecuted_clause | 0 |
| 6.3 | Revision pinning; refusal on mismatch | 0.70 | 0.84 | none | 1 |
| 6.4 | Rundown persistence and sequence engine | 0.04 | 0.94 | unexecuted_clause | 0 |
| 6.5 | Output configuration; is_live gated on tier, platform and reference | 0.04 | 0.87 | unexecuted_clause | 0 |
| 6.6 | Automation trigger evaluation; execution explicitly deferred | 0.08 | 0.86 | unexecuted_clause | 0 |
| 7.1 | Project and scene CRUD | 0.71 | 0.92 | none | 1 |
| 7.2 | Import pipeline: four tiers, compatibility report, source retained | 0.50 | 0.86 | unexecuted_clause | 3 |
| 7.4 | Scene validator: every unsupported case refused by name | 0.61 | 0.95 | unexecuted_clause | 1 |
| 7.5 | Design system enforcement: three severities plus override log (historical compatibility; not required for authoring or publish) | 0.03 | 0.86 | unexecuted_clause | 0 |
| 7.6 | Package build, verify, publish; design-system version stamped when present (optional, historical) | 0.53 | 0.83 | unexecuted_clause | 1 |
| 7.7 | Preflight | 0.08 | 0.88 | unexecuted_clause | 1 |
| 8.2 | system.capability — supported enums, tier, versions, build hash | 0.13 | 0.89 | unexecuted_clause | 0 |
| 8.3 | project, scenes, objects | 0.07 | 0.89 | unexecuted_clause | 1 |
| 8.4 | materials, assets, fonts | 0.37 | 0.84 | unexecuted_clause | 1 |
| 8.5 | animation, including apply_preset | 0.47 | 0.91 | unexecuted_clause | 1 |
| 8.6 | bindings | 0.88 | 0.93 | none | 2 |
| 8.7 | designsystem.* (historical compatibility) and motion.* | 0.52 | 0.91 | none | 2 |
| 8.8 | validate.* | 0.82 | 0.85 | none | 2 |
| 8.9 | render.preview returning a real frame | 0.52 | 0.97 | platform_gap | 1 |
| 8.10 | packages.* | 0.80 | 0.94 | none | 3 |
| 8.11 | playout.* and outputs.*, scope-gated | 0.73 | 0.87 | none | 3 |
| 8.13 | Scope enforcement tests | 0.69 | 0.82 | none | 3 |
| 10.1 | Token ingest from W3C Design Tokens JSON | 0.80 | 0.92 | none | 1 |
| 10.2 | Token ingest from Figma and Claude Design | 0.48 | 0.86 | unexecuted_clause | 1 |
| 10.3 | Unexpressible report at ingest | 0.20 | 0.83 | unexecuted_clause | 3 |
| 10.4 | Versioned, immutable store with provenance | 0.24 | 0.85 | unexecuted_clause | 1 |
| 10.5 | Drift report across published templates | 0.24 | 0.91 | unexecuted_clause | 2 |
| 11.4 | Colour management in the browser layer, matching the engine | 0.08 | 0.86 | unexecuted_clause | 1 |
| 11.5 | Dockable workspace | 0.06 | 0.82 | unexecuted_clause | 0 |
| 11.6 | Three.js viewport: 2D on an orthographic camera plus 3D | 0.33 | 0.81 | unexecuted_clause | 1 |
| 11.7 | Overlay layer: handles, guides, selection, marquee | 0.86 | 0.89 | none | 0 |
| 11.8 | Object manager treegrid | 0.76 | 0.89 | none | 0 |
| 11.9 | Type-aware inspector | 0.76 | 0.89 | stale | 1 |
| 11.10 | Timeline: virtualised rows, canvas layers, dirty-rect repaint | 0.03 | 0.91 | unexecuted_clause | 0 |
| 11.11 | Speed graph and curve editing | 0.63 | 0.89 | unexecuted_clause | 2 |
| 11.12 | Material manager | 0.33 | 0.73 | stale | 0 |
| 11.13 | Font manager panel | 0.67 | 0.97 | platform_gap | 0 |
| 11.14 | Design system panel; tokens as editor defaults (historical compatibility; not part of the 15 Oct authoring workflow) | 0.04 | 0.92 | unexecuted_clause | 0 |
| 11.15 | Motion preset browser; save selection as preset | 0.03 | 0.62 | unexecuted_clause | 0 |
| 11.16 | Live conformance indicator (historical compatibility) | 0.02 | 0.92 | unexecuted_clause | 0 |
| 11.17 | Import UI with tier and substitution report | 0.06 | 0.94 | unexecuted_clause | 1 |
| 11.18 | Editor 1.x panel parity in the Editor 2.0 workspace | 0.07 | 0.66 | unexecuted_clause | 0 |
| 11.19 | Data binding panel integrated with object properties | 0.85 | 0.96 | none | 1 |
| 11.20 | Editable animation contract and service integration | 0.08 | 0.83 | unexecuted_clause | 0 |
| 11.21 | Inspector keyframe diamonds and Auto-Key | 0.03 | 0.81 | unexecuted_clause | 0 |
| 11.22 | Selection-driven timeline and keyframe editing | 0.03 | 0.89 | unexecuted_clause | 2 |
| 11.23 | Simple easing, Custom Bezier and starter presets | 0.02 | 0.88 | unexecuted_clause | 1 |
| 11.24 | Spacebar preview and integrated Editor parity verification | 0.09 | 0.97 | unexecuted_clause | 0 |
| 11.25 | Named animation phases on the scene timeline | 0.06 | 0.95 | unexecuted_clause | 0 |
| 11.26 | Template control contract: declared operator fields | 0.15 | 0.96 | unexecuted_clause | 1 |
| 11.27 | Test fill in the Editor: fill a template instance (operator pages are 12.8) | 0.04 | 0.91 | unexecuted_clause | 0 |
| 11.28 | Named text style presets | 0.08 | 0.95 | unexecuted_clause | 2 |
| 11.29 | Multi-scene workspace: scenes as first-class entities | 0.18 | 0.92 | unexecuted_clause | 0 |
| 11.36 | Typed editor command model: every authoring mutation is a shared command | 0.06 | 0.87 | unexecuted_clause | 3 |
| 11.37 | Undo/redo on the command log | 0.28 | 0.92 | unexecuted_clause | 0 |
| 11.38 | Immutable, content-hashed scene revisions with review state | 0.15 | 0.87 | unexecuted_clause | 1 |
| 11.39 | Asset provenance and licence fields | 0.08 | 0.92 | unexecuted_clause | 2 |
| 11.41 | Headless render entry point in the Render Engine | 0.05 | 0.97 | platform_gap | 1 |
| 11.63 | EffectCraft / After Effects workspace presentation | 0.06 | 0.91 | unexecuted_clause | 0 |
| 11.64 | Scene Manager: one container, multiple independent graphics | 0.05 | 0.93 | unexecuted_clause | 0 |
| 12.4 | Transport controls: cue, take, continue, out, clear | 0.04 | 0.96 | unexecuted_clause | 0 |
| 12.6 | Status surface: tier, reference lock, free-run, clock source | 0.36 | 0.92 | unexecuted_clause | 0 |
| 12.7 | Output configuration with refusal reasons shown | 0.15 | 0.95 | unexecuted_clause | 0 |
