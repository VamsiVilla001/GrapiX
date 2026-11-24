# Invariants

Binding rules. Rationale lives in `adr/0001-distributed-architecture.md`; this
file states what may not be done. **Numbers are permanent** - code and commit
messages cite them, so new rules are appended and never renumbered. Each rule is here because breaking it was
either paid for once already or is structurally unrecoverable.

## Product boundary

1. There are exactly three applications: **Editor**, **Playout**, **Render
   Engine**. `Shared/` is contracts, not a fourth runtime, and cannot depend on
   Editor or Playout.
2. The Render Engine is the only implementation that evaluates and rasterizes
   production scene pixels.
3. Editor and Playout never import renderer internals and never own Program GPU
   state.
4. Editor owns mutable authoring content and cannot change Program or outputs.
5. Playout owns published scene operations and is the only client allowed to
   Cue, Take, Continue, Clear Program or configure outputs.
6. Program, its frame clock and its outputs continue if Editor, Playout or both
   disconnect or close.
7. A mutable Editor scene can never replace a published Playout scene in place.

## Time — ADR-002

8. **The render node is the sole clock authority.** The control plane carries
   intent, never time. No message may carry "when."
9. `take` and `cue` take `TakeAt::NextOpportunity | Frame(n)` and return the
   frame the engine committed to. Playout may not send "now."
10. One clock domain per engine instance. Two outputs on different references
    means two engine instances.
11. Free-run is reported as free-run, explicitly and unmissably. Never hidden,
    never inferred.
12. Rates are rational (`num`/`den`). Never a float.

## Transport — ADR-001 and ADR-004

13. Four planes, independent transports: **Control** (ordered, acknowledged,
    zero loss), **Asset** (restartable), **Media** (drops, never queues),
    **Timing** (a cable, never a software transport).
14. No media path may influence Program cadence.
15. The interactive media stream degrades resolution before it degrades
    latency.
16. Relocating the engine from L0 to L1 is a deployment change. Contracts,
    product code and the meaning of every message stay identical.

## Refusal contract — ADR-005

17. A refusal names its failing condition. `RevisionMismatch`,
    `TierTooLow(T2)`, `ReferenceUnlocked`, `UnsupportedBlendMode(overlay)`.
18. **No silent substitution, ever.** A fallback may not produce visually
    different pixels. `overlay` aliasing to `screen` is the known live example
    and is an M1 fix.
19. A live adapter refuses to configure unless device tier is T0, the platform
    is a certification target, and the reference is locked or an operator has
    been explicitly told it is free-running.
20. `is_live()` is the only thing that may decide whether an output is
    described as live. Never infer it from an adapter name. Never let an
    unavailable live adapter accept frames.
21. Never claim NDI/DeckLink/AJA/video/hardware readiness without execution
    evidence, and never set `hardware_certified` from a compile-time feature
    flag.

## Contracts — ADR-003

22. **Rust is the source of truth. TypeScript is generated.** Hand-mirrored
    types are a recorded source of drift and are forbidden.
23. `Shared/generated-ts` is generated output. Never edited by hand.
24. One Cargo workspace, one lockfile.
25. Each product develops against a mock peer, never against another product.
26. No product merges without passing the conformance suite.
27. Two parallel implementations of one specification must change together, and
    each must carry the test suite that catches the divergence.

## Assets

28. Asset bytes are verified before they are cached, written to a temporary
    file and then renamed. A truncated file in a content-addressed cache
    carries a name claiming it was verified.
29. An asset a loaded scene declares is a take blocker. A scene never prepares
    as ready with a missing asset.
30. Publishing is additive and all-or-nothing. Every publish is a new version;
    rundown items pin the version they were built against and do not follow the
    latest publish. A partial package never becomes a revision.
31. Content hash addresses the store; project-relative path addresses the
    library. Both are retained, so replacing a file in place keeps material
    bindings intact.

## Ports

32. 4100 project API, 4300 playout-control, 4400–4403 engine and render nodes,
    5173/5174 web. **4200 is burned** — it belonged to a retired daemon. Do not
    place anything there and do not reuse any of the others.

## Carried forward, pending re-proof

The following were paid for in the 1.x tree. They are recorded here so 2.0 does
not re-earn them, and each is marked **Planned** until 2.0 has its own
execution evidence.

33. Replies and events must never share a `messageId`, and sequence handling
    runs before deduplication. Both wedged a live connection.
34. Match replies by their `reply.` prefix. An enumerated switch is how one
    reply kind came to hang every call for 15 s.
35. Nothing that can be built once may be built per Program frame. Pipelines,
    render target, prepared scene and mesh frame are built once; doing it per
    frame cost 482 ms a frame.
36. Any inbound frame proves the engine is alive. Keep reachability separate
    from readiness; conflating them tore down working sockets.
37. Never represent a large stage as one GPU texture. Only tiles become render
    targets.
38. Never hand absolute stage coordinates to the GPU. Subtract the tile or
    viewport origin in f64, then narrow to f32.
39. A preview whose scaled output fits one texture uses the single-pass path.
    Tile-by-tile turns a thumbnail into a minute of GPU time.
40. Preview streams are addressed to one client. Never broadcast frames.
41. A non-loopback engine bind with no configured token refuses to start. That
    is not a warning. One policy answers for every listener
    (`gx_contracts::endpoints::check_listen`, 2.21): a plane that verifies no
    credential (the asset plane and the MCP HTTP transport, today) listens on
    loopback only, token or not, and no listener takes a reserved port.
42. A remote client supplies a relative, traversal-free path resolved inside a
    configured root, re-checked after canonicalisation. A syntax check alone
    cannot see a symlink.
43. The parity harness reports SKIP, not PASS, when there is no capture.

## Established by the ADR-001 / ADR-002 implementation

44. **`Lead` is the only place transport distance may influence timing.** It
    changes how early a client must ask, never what the engine does with the
    request. Anything else that varies behaviour by locality has moved timing
    into the transport, which is what ADR-002 exists to prevent.
45. **A mock peer must refuse exactly where the real engine refuses.** A
    permissive mock is worse than none: it teaches callers a contract that does
    not exist, and the lesson is only unlearned during integration.
46. **Intent resolution has one implementation.** `resolve_intent` is called by
    the engine clock and by every mock. Two copies would drift, and the drift
    would be a mock that disagrees with the engine about what
    `NextOpportunity` means.
47. **A conformance check that always skips is not a check.** If every
    available peer skips it, add a peer that exercises it. The suite is graded
    on what it ran, not on what it declared.

## Established by the L0 control transport

48. **A sequence gap closes the connection.** The control plane tolerates no
    loss, so there is no correct way to carry on past a missing message.
    Closing forces the reconnect-and-reconcile that ADR B.4 specifies.
49. **A duplicate request is acknowledged, never re-executed.** Re-applying a
    take because its request arrived twice would put a scene to air twice.
50. **A listener retries a transient accept error and stops on a persistent
    one.** Looping on an unrecoverable error burns a core and floods the log
    with one line, which is how a small fault becomes the visible outage.
51. **A frame's declared length is validated before any of its body is
    allocated.** A peer must not be able to make this side reserve memory by
    lying about a length.
52. **The bind policy is checked before the socket is created**, so a refused
    address never briefly holds a listener. `0.0.0.0` and `::` are not
    loopback — treating an unspecified address as local is what turns
    invariant 41 into decoration.

## Established by credential enforcement and reconnect

53. **A token verifies in constant time over its full length.** `==` returns at
    the first differing byte, which leaks the length of the matching prefix to
    anyone who can time it.
54. **`Token` redacts itself in `Debug`.** Message types derive `Debug`,
    refusals are formatted into logs, and connection errors are printed. A
    token that prints itself reaches a log file on the first bad connection.
55. **A protected connection is refused every request until authenticated,
    capability included.** Capability carries device tier, clock source and
    reference state; none of it is public.
56. **Authentication is a property of the connection, not of a request.** The
    transport answers it; the engine refuses it if it ever sees one, because an
    engine that re-checked on every request would eventually miss one.
57. **A fresh connection is unauthenticated, so a reconnect re-authenticates.**
    Inheriting trust across a redial is what would keep a rotated token
    working.
58. **Reconciliation compares epoch and revision, never revision alone.** A
    restarted engine can rebuild state carrying the number it had before, and
    a revision-only comparison would see no change.
59. **A refusal keeps its meaning when it becomes an error.** "Needs a
    credential" and "this peer is broken" are different problems, and a caller
    can only act differently on them if the classification says which.

## Established by the Editor core and AI readiness merge (2 October 2026)

Approved by the user on 2 October 2026. Each rule names the build-plan step
that makes it enforceable. Until that step is `done` the rule is **Planned**:
it binds new work now, but there is no execution evidence that the tree
already obeys it.

60. **Every mutation of Editor authoring content is a command of the one
    command type defined in `Shared/`.** No other mutation path exists. A
    second path is a second, unlogged history that undo, review and the agent
    surface cannot see. Enforced by 11.36 (3 October 2026): the boundary
    guard fails a build that adds another path, and the conformance suite
    runs every command against a recording peer.
61. **Playout loads scene revisions only by pinned content hash.** This
    refines invariant 30: a version number identifies a publish, and the hash
    proves its content. An unknown or unpinned hash is refused by name.
    Enforced by 11.38 (3 October 2026): cue and take carry the pin, one
    shared check refuses `revisionUnpinned` and `revisionHashMismatch`, and
    conformance runs it against the mocks, the real engine and Playout.
62. **Scene scripts have no wall-clock or network access.** Time comes only
    from the engine frame number and rational rate, and data only through
    bindings. A script that reads the wall clock makes the same frame render
    two ways (invariant 8). Planned — enforced by 16.4.
63. **No generator or model inference runs on the Take path.** Generated
    content is baked offline into hashed assets before it can be taken.
    Holds today because no generator exists; 16.10 must keep it.
64. **No neural frame generation or temporal AI upscaling is applied to
    Program.** A synthesised frame is a substitution, which invariant 18
    forbids. Holds today because none exists.
65. **No author- or agent-scoped tool can reach playout-control.** Program
    operations over MCP (today `playout.cue`, `playout.take`, `playout.clear`
    and `outputs.configure`) exist only behind operator scopes (`Cue`, `Take`,
    `Clear`, `ConfigureOutput`), per ADR-0002 D.3 and build-plan 8.11. Agents
    publish drafts; a human takes them to air.
    Enforced today by the 8.13 scope tests; 8.14 extends them to every tool.
66. **A missing glyph is a refusal, never a font substitution.** This narrows
    invariant 18 to the glyph: a covered font that lacks a glyph renders tofu
    or a fallback face, and either is different pixels. Planned — enforced by
    11.42 and 11.51.

## Carried over from `memory.md` (moved by build plan 0.12, 19 November 2026)

These were rules 10 to 29 of `memory.md`, which called them binding while saying it grants
no authority. They are stated here, once, in their original words. The rest of that list
was already here (rule 8 is invariants 8 and 9, rule 9 is 46, rule 12 is 56, rule 18 is 21)
or is working procedure (rules 1 to 7 and 15), now in `AGENTS.md` and `memory.md`.

67. The control plane has an L0 transport; the asset and media planes do not.
    Do not describe those two as transported.
68. The L0 transport is loopback TCP, not the named pipe ADR-001 specifies.
    Say so when describing L0 security posture.
69. The credential is a shared bearer token over an unencrypted socket. Never
    describe it as mTLS, and never describe L1 as ready.
70. `docs/adr/0002-platform-and-mcp-schema.md` is the accepted handoff and its
    **Part E is the definition of done**. Verify against it; do not claim an
    item without execution evidence.
71. The structured refusal envelope is `StructuredRefusal` in `gx-contracts`
    (0.6). It uses `allowed`, never `supported` — that inconsistency is
    settled. The severity type is `RefusalSeverity`; `Severity` stays with
    clock health. Optional fields are `Option<T>` with `skip_serializing_if`
    **and** `#[ts(optional)]` — ts-rs cannot see serde's skip attribute, and
    one without the other makes the TS shape lie about the wire.
72. CI-only done-when criteria (0.3, 0.4) are not closable from a workstation.
    Mark `active` with the workflow committed and every locally observable
    half verified; `done` needs the CI run's green check plus the SBOM
    artifact, which only exists after a push. Do not mark them `done` because
    the YAML looks right.
73. A failing-over-the-wire check that unit tests pass is usually a stale
    spawned binary, not a contract break. Rebuild and re-run before treating
    a wire failure as a serialisation bug — the conformance engine is a real
    child process and cargo does not rebuild it between runs of the harness.
74. **Hierarchy resolution walks from the roots, never down the array.** A
    child may be declared before its parent; resolving in array order makes it
    a root and silently drops the parent's transform. Duplicate ids keep the
    *first* object, which is what 1.x did and what keeps resolution
    deterministic while an invalid scene is being repaired.
75. **A kind must never redeclare an `ObjectBase` field.** With
    `#[serde(flatten)]` both are emitted, the reader keeps the last, and an
    authored value is silently lost. `fill` was declared twice until 1.2. The
    catalogue round-trip test uses a fully populated base so any recurrence
    fails.
76. **The generated TS maps `u64` to `bigint`; JSON gives `number`.** That
    affects `Revision`, `Epoch`, `Sequence`, frame numbers, `durationFrames`
    and `sizeBytes` — twelve types. The mapping is deliberate and consistent;
    the conversion is owed by the TypeScript client codec, which does not exist
    yet. Do not "fix" it with a cast in a test.
77. **Never assign a wire literal with `as unknown as T` in a TypeScript
    contract test.** A double cast type-checks anything; it hid two real drifts
    until 1.2 replaced it with a direct assignment. Assign directly and let the
    compiler do the work.
78. Photoshop layer styles and blending options are owned by **11.60** (added
    12 October 2026 at the user's request), the effects library by 3.22 and
    11.62, and text animators by 11.61. Layer masks are owned by 11.47 and
    asset provenance by 11.39 (merged 2 October 2026).
79. **`serde_json` needs `float_roundtrip` and it is not cosmetic.** Every
    scene object flattens `ObjectBase`, and `#[serde(flatten)]` forces
    deserialisation through `deserialize_any`, whose default float parser is
    accurate to a ULP rather than exact. Without the feature a scene written
    and read back is a different scene, and a content hash over the
    re-serialised document differs from the original's — a `.gpxpkg` manifest
    would be wrong about its own contents. `scene.rs` has the regression test.
80. **A worker the test harness leaks holds `gx-render-worker.exe` open**, so
    the next `cargo build` fails with "access is denied" and the *next* test
    run gets a stale binary it then hangs against. `start_worker` in
    `services/render-engine/host/tests/ensure.rs` owns the child from spawn,
    not from successful connect; if you see the access error, kill the image
    with `taskkill /F /IM gx-render-worker.exe` before rebuilding.
81. **The capability exchange declares what a device measured, not what a
    build enabled** (invariant 21). An engine with no rasteriser declares
    `MaterialSupport::none()`, and a validator refusing every mode against
    that list is the correct answer, not a degraded one.
82. **The render core is GPU-first and GrapiX-owned (ADR-0003, 12 October
    2026).** Never add an EffectCraft crate as a product dependency: port a
    component under its owning step, with attribution, stripping its silent
    fallbacks. A CPU full-frame path is a reference, never Program's backend.
83. **Colour follows the project's working space** (3.15; ADR-0002 B.1 as
    amended 12 October 2026). Do not reintroduce "composite in linear,
    always"; 3D shading alone is linear inside its pass.
84. **Every Program command names the person who sent it, and the engine refuses one that
    does not.** Cue, take, clear, a phase and an output change travel with the signed-in
    operator (`gx_contracts::auth::OperatorName`), judged by the transport after the credential
    and its scope and before the engine sees the request: `OperatorRequired` or
    `OperatorNameInvalid`, by name. A name is an identity for the record and grants nothing;
    the credential's subject is recorded beside it (`control.program_command`) and the
    credential itself never is. Enforced by 2.15 (19 November 2026); the as-run record (12.11)
    is built on it.
85. **The MCP HTTP transport verifies a gx1 credential on every request, and a call is gated by
    the scopes that credential grants.** HTTP is a port any local process can reach: a request
    with no credential, one made with another secret, or one under another scheme is refused by
    name (401 and the `unauthenticated` refusal) before the protocol sees it, and the server
    refuses to start HTTP without a secret. The server's built-in scopes apply to stdio only.
    The record names the credential's subject, never the credential. Enforced by 2.23
    (19 November 2026).
