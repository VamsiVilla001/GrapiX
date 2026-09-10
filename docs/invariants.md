# Invariants

Binding rules. Rationale lives in `adr/0001-distributed-architecture.md`; this
file states what may not be done. Each rule is here because breaking it was
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
    is not a warning.
42. A remote client supplies a relative, traversal-free path resolved inside a
    configured root, re-checked after canonicalisation. A syntax check alone
    cannot see a symlink.
43. The parity harness reports SKIP, not PASS, when there is no capture.
