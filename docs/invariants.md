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
    is not a warning.
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
