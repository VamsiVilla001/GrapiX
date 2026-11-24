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
2. **Read `LLM-GOVERNANCE.md` before any task. It is binding on every LLM and
   platform.** The verify-then-record loop is mandatory: no task is marked
   done without execution evidence against the step's "Done when" criterion in
   `GrapiX-Build-Plan.md`, and only then is it recorded in `progress.html` /
   `progress.json` (kept in sync, committed with the work). `GrapiX-Build-Plan.md`
   is the only build plan; `progress.html` is the only tracker.
3. Inspect `git status` before editing. Preserve uncommitted work.
4. Log every change here: what, why, and what was actually run to verify it.
   An entry with no execution evidence must say so.
5. Never describe anything as working without having run it. "Compiles" is not
   "works", and `cargo check` is not a test.
6. Run `npm run check` before committing. It is cheap and it is the whole gate
   at this stage.
7. Rust is the source of truth for contracts. Never hand-edit
   `Shared/generated-ts` — regenerate and commit the result.
8. Do not add a `Now` variant to `TakeAt`, or any other way for a client to
   send a time. That is invariant 8 and it is the load-bearing decision of the
   whole architecture.
9. `resolve_intent` has exactly one implementation. A mock, a test double or a
   second engine must call it, never reimplement it (invariant 46).
10. The control plane has an L0 transport; the asset and media planes do not.
   Do not describe those two as transported.
11. The L0 transport is loopback TCP, not the named pipe ADR-001 specifies.
   Say so when describing L0 security posture.
12. Authentication lives in the transport. Do not add a credential check to
   the engine or to a request handler.
13. The credential is a shared bearer token over an unencrypted socket. Never
   describe it as mTLS, and never describe L1 as ready.
14. `docs/adr/0002-platform-and-mcp-schema.md` is the accepted handoff and its
   **Part E is the definition of done**. Verify against it; do not claim an
   item without execution evidence.
15. **Where to resume is the top dated entry below ("Resume here").** The
   user's standing instruction is to work open rows in `progress.html`
   order, fast, with parallel worktree agents; the user supplies test cases,
   including the Figma corpus. (1.3 and 1.4, once named here, are done.)
16. The structured refusal envelope is `StructuredRefusal` in `gx-contracts`
   (0.6). It uses `allowed`, never `supported` — that inconsistency is
   settled. The severity type is `RefusalSeverity`; `Severity` stays with
   clock health. Optional fields are `Option<T>` with `skip_serializing_if`
   **and** `#[ts(optional)]` — ts-rs cannot see serde's skip attribute, and
   one without the other makes the TS shape lie about the wire.
17. CI-only done-when criteria (0.3, 0.4) are not closable from a workstation.
   Mark `active` with the workflow committed and every locally observable
   half verified; `done` needs the CI run's green check plus the SBOM
   artifact, which only exists after a push. Do not mark them `done` because
   the YAML looks right.
18. A detected output card is not a ready one. The DeckLink probe
   (`Shared/decklink`) reports runtime presence; readiness is Phase 15 and
   needs the vendor SDK, which is a separate Blackmagic download not yet in
   the tree. Never set an output capability from a probe or a feature flag
   (invariant 21).
19. A failing-over-the-wire check that unit tests pass is usually a stale
   spawned binary, not a contract break. Rebuild and re-run before treating
   a wire failure as a serialisation bug — the conformance engine is a real
   child process and cargo does not rebuild it between runs of the harness.
20. **Hierarchy resolution walks from the roots, never down the array.** A
   child may be declared before its parent; resolving in array order makes it
   a root and silently drops the parent's transform. Duplicate ids keep the
   *first* object, which is what 1.x did and what keeps resolution
   deterministic while an invalid scene is being repaired.
21. **A kind must never redeclare an `ObjectBase` field.** With
   `#[serde(flatten)]` both are emitted, the reader keeps the last, and an
   authored value is silently lost. `fill` was declared twice until 1.2. The
   catalogue round-trip test uses a fully populated base so any recurrence
   fails.
22. **The generated TS maps `u64` to `bigint`; JSON gives `number`.** That
   affects `Revision`, `Epoch`, `Sequence`, frame numbers, `durationFrames`
   and `sizeBytes` — twelve types. The mapping is deliberate and consistent;
   the conversion is owed by the TypeScript client codec, which does not exist
   yet. Do not "fix" it with a cast in a test.
23. **Never assign a wire literal with `as unknown as T` in a TypeScript
   contract test.** A double cast type-checks anything; it hid two real drifts
   until 1.2 replaced it with a direct assignment. Assign directly and let the
   compiler do the work.
24. Photoshop layer styles and blending options are owned by **11.60** (added
   12 October 2026 at the user's request), the effects library by 3.22 and
   11.62, and text animators by 11.61. Layer masks are owned by 11.47 and
   asset provenance by 11.39 (merged 2 October 2026).
25. **`serde_json` needs `float_roundtrip` and it is not cosmetic.** Every
   scene object flattens `ObjectBase`, and `#[serde(flatten)]` forces
   deserialisation through `deserialize_any`, whose default float parser is
   accurate to a ULP rather than exact. Without the feature a scene written
   and read back is a different scene, and a content hash over the
   re-serialised document differs from the original's — a `.gpxpkg` manifest
   would be wrong about its own contents. `scene.rs` has the regression test.
26. **A worker the test harness leaks holds `gx-render-worker.exe` open**, so
   the next `cargo build` fails with "access is denied" and the *next* test
   run gets a stale binary it then hangs against. `start_worker` in
   `services/render-engine/host/tests/ensure.rs` owns the child from spawn,
   not from successful connect; if you see the access error, kill the image
   with `taskkill /F /IM gx-render-worker.exe` before rebuilding.
27. **The capability exchange declares what a device measured, not what a
   build enabled** (invariant 21). An engine with no rasteriser declares
   `MaterialSupport::none()`, and a validator refusing every mode against
   that list is the correct answer, not a degraded one.
28. **The render core is GPU-first and GrapiX-owned (ADR-0003, 12 October
   2026).** Never add an EffectCraft crate as a product dependency: port a
   component under its owning step, with attribution, stripping its silent
   fallbacks. A CPU full-frame path is a reference, never Program's backend.
29. **Colour follows the project's working space** (3.15; ADR-0002 B.1 as
   amended 12 October 2026). Do not reintroduce "composite in linear,
   always"; 3D shading alone is linear inside its pass.

---

