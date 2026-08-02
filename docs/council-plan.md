# GrapiX Council Integration and Performance Plan

**Status:** Council consensus, 2026-08-02  
**Scope:** Integrate the existing Editor, Playout, Render Engine, Editor Assistant, Adobe MCP Gateway/Cloud Bridge, design importers, materials, and Font Manager without creating a fourth runtime or weakening production authority.

## 1. Decision summary

GrapiX remains three products with one production renderer:

| Product | Authority | Boundary |
| --- | --- | --- |
| Editor | Mutable authoring scenes, assets, materials, fonts, animation, data bindings, Assistant/MCP-assisted authoring, import compatibility reporting, and versioned package creation. | Does not own Program, outputs, or production GPU state. |
| Playout | Immutable published library, take IDs/lists, Preview/Program operator actions, automation, and output configuration. | Does not mutate a published revision in place or author scene content. |
| Render Engine | Native prepared runtimes, rational frame clock, Program, outputs, GPU state, resource admission, and rendering. | Does not depend on browser/desktop UI or accept Editor Program/output authority. |

Assistant, Adobe MCP Gateway/Cloud Bridge, PSD/SVG/AI/Figma import, Standard Materials, and Font Manager are **Editor ingress**. They produce normal, validated authoring documents and content-addressed assets. The only path to air is the existing immutable, checksum-verified `.gfxpkg` publish path into Playout, followed by Playout commands over protocol v3. There is no Assistant/Adobe/importer-to-renderer side channel.

## 2. Architecture and design invariants

1. **Engine-only production pixels.** The Render Engine is the only implementation that evaluates and rasterizes Program pixels, owns output GPU state, and owns the rational broadcast clock. Browser rendering is authoring interaction only.
2. **Server-enforced authority.** A connection's immutable `ConnectionPrincipal` is derived from its authenticated loopback credential or host-issued session, never from client-provided Hello role claims. Engine dispatch applies a closed role/capability matrix before handler mutation. Only Playout can Cue, Take, Continue, Clear, or configure outputs; rejected commands have a stable machine error code and audit record.
3. **One canonical runtime identity.** Every runtime/cache/stream/program lookup and audit record uses `SceneRef { projectId, domain, sceneId, revision }`. `domain` is `authoring` or `published`; Program accepts only checksum-verified immutable `published` package revisions. Remove bare scene-ID addressing from protocol payloads and internal maps. Editor authoring views are private to their session and cannot collide with Playout Preview or Program.
4. **One shader and scene contract.** Shared scene fixtures, shared WGSL/layout byte contracts, premultiplied-alpha and color rules remain the common source for all renderer hosts. `SceneDocument.version = 1` stays additive-only; runtime handles, cache state, and view navigation never enter durable scenes.
5. **Native Editor Render View.** M2 replaces the browser Pixi/Three production-like viewport with a native Engine-owned private Editor Render View that consumes the same prepared runtime and WGSL pipeline as Preview/Program and returns binary alpha frames plus picking/bounds/camera metadata. The browser remains the UI host. This is the required authoring-to-Program parity gate.
6. **No silent visual substitutions.** Unsupported materials, blend modes, video, transitions, or render features remain explicitly refused/deferred/warned as their contracts prescribe; they are never rendered as a different feature.
7. **Resilience semantics.** Application UI failure cannot interrupt Program. Cached last-good frames may preserve operator context during a recovering view but are never output as live Program frames. The Engine restores Program only after verified state recovery and an off-air first-frame validation.

## 3. Resource Governor and memory admission

### 3.1 One governor, one accounting model

Extend the existing SceneRegistry, tile, and asset budget mechanisms into one Engine-owned `ResourceGovernor`; do not add per-product caches, independent schedulers, or a second governor. Profiles remain the configuration source (`EDITOR_PREVIEW`, `PROGRAM_HD`, `PROGRAM_UHD`, `LOW_LATENCY`, `SAFE_MODE`) and set hard owned-resource CPU/GPU budgets plus per-class limits.

The governor accounts and reserves deterministic owned bytes for:

- decoded CPU assets and staging buffers;
- GPU textures including mip levels, meshes/index buffers, glyph atlases, material/pipeline state, bind-group backing data, and upload rings;
- tile caches and render targets, transition working sets, readback/preview/output frame pools;
- decoder queues and output buffers when those capabilities are certified.

wgpu does not portably expose total VRAM usage. Therefore owned-resource accounting and reservations are the admission authority. Backend allocation deltas, adapter telemetry, and OS counters are diagnostics only; they must not be represented as a reliable global VRAM limit.

### 3.2 Priority, reservation, and eviction rules

Priority is fixed: **Program > prepared Playout Preview > active Editor Render View > background thumbnails/exports**. Program, active output resources, and the active transition working set are pinned. Preview is protected while selected/prepared. Active resources are never evicted to satisfy a lower-tier request.

Preparation follows an explicit transaction:

1. Estimate CPU/GPU costs from the package manifest and decoded metadata.
2. Reserve capacity for the full prepared runtime and required pool/ring growth before expensive work.
3. Evict only unreferenced, lower-priority warm LRU candidates until the reservation fits.
4. Decode, shape, tessellate, compile, upload, and construct a prepared runtime off the render thread.
5. Atomically commit the runtime and actual measured owned bytes at a frame boundary, or roll back every reservation/upload on failure or device loss.

If protected residency leaves insufficient capacity, the request is refused or deferred with an explicit admission/pressure reason; it never causes a hidden quality change or drops on-air assets. Tightening a profile first evicts eligible warm scenes and then reports unavoidable active overage as a visible degraded condition.

### 3.3 50–60 warm-scene target

Fifty to sixty warm scenes is a certification/admission objective for representative mixed content on a specified hardware/profile tier, **not a fixed reservation or global promise**. Capacity is calculated from actual heterogeneous scene costs after reserving Program, Preview, output/transition pools, and safety headroom. A profile that fits 31 expensive scenes must expose ready capacity as 31 rather than overcommit to 60. Conversely, inexpensive scenes may exceed 60 only if the profile's explicitly configured warm-cap policy allows it; the residency target does not override hard budgets.

Governor status exposes per-scene state, priority, owner/reference count, reservations, actual owned bytes by class, active budget, LRU order, evictions, admission refusals, pressure reason, and CPU/GPU high-water marks.

## 4. Zero-allocation frame path and DrawPacket batching

### 4.1 Strict render-tick contract

After the render tick begins, Program rendering performs no heap allocation, synchronous I/O, JSON serialization, log-string formatting, lock contention, dynamic collection traversal, decode, text shaping, tessellation, shader/pipeline compilation, asset upload, or full-scene preparation. Bounded queues, preallocated command encoding, and GPU submission are allowed. Overflow is an explicit admission/backpressure event with telemetry, never an allocation escape hatch.

Off-frame workers perform parse/normalize, asset decode, font shaping, mesh/path tessellation, pipeline creation, texture upload, packet construction, and profiling. They publish immutable prepared runtimes through a bounded single-producer/single-consumer or equivalently lock-free, fixed-slot handoff. At the frame boundary, the renderer switches a preselected front slot without refcount churn in the tick.

Preallocate and recycle per-view frame slots, output/readback `VideoFrame` storage, uniform/upload rings, command-encoder capacity, packet arenas, and bounded latest-wins view queues. A frame pool/slab is required for real zero-allocation output handoff; merely moving a `Vec` allocation to another function is insufficient.

Live data and animation patches are typed, bounded, coalesced to a frame boundary, and mutate only affected prepared binding targets/packets. They never call full `prepare_scene` for ordinary property animation.

### 4.2 Packet construction and ordering

Preparation converts visible objects into fixed-capacity `DrawPacket` arenas containing the resolved pipeline, material/blend identity, texture/bind-group references, geometry/instance range, scissor/tile state, depth classification, and authored painter-order key. Persistent pipelines and bind groups are reused; dynamic per-frame data uses bounded rings or tightly packed instance/storage buffers.

Batching is semantics-preserving:

- Premultiplied-alpha and the supported blend modes are order-dependent. Batch only **contiguous compatible packets in authored painter order** for these paths.
- An opaque partition may reorder only after material/opacity/depth classification proves the result cannot change pixels. Opaque packets may then group by pipeline, material, texture, mesh, and scissor.
- Mesh packets follow the same stable-order rule; transparent meshes are never material-sorted across an order boundary.
- Start with fixed-capacity instanced packets and one draw per compatible run. Indirect draws are a measured optimization only for demonstrably beneficial repeated, opaque mesh-heavy runs; do not make them the baseline.

This removes the current avoidable per-quad staging and dynamic-offset churn without sacrificing blend correctness. Benchmark packet/run counts, CPU encode time, GPU time, uniform/upload bytes, and p99 frame time before enabling an additional batching mode.

## 5. Delivery sequence and recovery

### M2 — authority, identity, and parity (first release gate)

1. Authenticate principals and enforce the server-side capability matrix.
2. Make full `SceneRef` mandatory throughout protocol v3, Engine maps, caches, streams, Preview, and Program.
3. Split private Editor views from published Preview/Program and require immutable verified published revisions for Program.
4. Deliver the native Editor Render View using the common Engine prepared-runtime/WGSL path and binary alpha frames.
5. Prove negative authorization/domain cases and Editor/Preview/Program parity for the same `SceneRef`, frame, data, materials, fonts, cameras, lights, and alpha.

M2 is independently shippable and must be gated before enabling recovery cutover. It removes the largest authority and identity ambiguity, reducing M3's recovery state space.

### Performance/reliability gate after M2

1. Deliver the governor's reservation/commit/rollback semantics and per-class accounting.
2. Move all preparation off the render tick; implement packet arenas, buffer/frame pools, stable batching, and affected-target patching.
3. Drive a representative 50–60-scene mixed lifecycle only when measured capacity admits it, then test pressure, LRU eviction, protected-residency refusal, profile tightening, and device-loss rollback.
4. Enforce allocation counters/high-water stability, frame p99/deadline behavior, packet/batch evidence, and no unbounded CPU/VRAM-owned growth.

### M3 — durable Program recovery (after M2 gate)

For every accepted Playout Program/output/data mutation, persist a canonical command **before acknowledgement** with Engine-assigned monotonic state revision, idempotency key, precondition revision, package checksum, and output lease/fence. Maintain a checksummed WAL and atomic fsync snapshot with a snapshot watermark. On worker crash/device loss, rebuild resources, verify package/assets and lease, replay only entries after the watermark idempotently, render and validate a first frame off-air, then resume outputs. Corrupt/missing recovery data leaves outputs safe/off-air and emits an actionable degraded event. Cached frames are not live recovery output.

M3 implementation work may proceed in parallel with late M2 work, but recovery activation/cutover waits for M2 authority, domain, and native-view evidence.

### Later work only after these gates

Proceed with T1 transitions, broader operator controls, live affected-target updates, certified video/material extensions, sandboxed scripts, and optional standby only after M2, governor/performance, and M3 evidence is complete. Do not use performance work as justification for V2 remote/distributed-rendering redesign, a browser production renderer, or speculative feature expansion.

## 6. Independent workstreams and interfaces

| Workstream | Exclusive scope | Contract delivered | Depends on |
| --- | --- | --- | --- |
| A. Engine authorization and identity | Engine authentication, dispatch authorization, protocol error/audit behavior | Credential-derived `ConnectionPrincipal`; closed capability matrix; denied-command contract | Shared protocol fixture additions only |
| B. Canonical scene domains and views | `SceneRef` propagation, Engine runtime/cache/stream keying, private Editor vs Preview/Program view ownership | No bare scene-id runtime lookup; Program published-only validation | Shared `SceneRef` fixture; coordinates with A on principal scope |
| C. Native Editor Render View/parity | Engine private view API, binary alpha-frame transport, Editor UI adapter and parity harness | Engine-rendered authoring view with common prepared path | B's view identity contract |
| D. Resource Governor | Engine SceneRegistry/tile/asset accounting, profile budgets, reservation/admission/eviction/status | Single budget authority and explicit pressure/admission result | B's canonical resource owner key |
| E. Prepared runtime/frame path | Core preparation workers, fixed slots/rings/frame pools, DrawPacket arena construction, batching/profiling | Zero-allocation tick contract and order-safe batching | D supplies hard capacity/reservation limits |
| F. Recovery | Engine WAL/snapshot/replay, host restore, output fencing, crash/device-loss tests | Verified off-air first-frame restore or safe degraded state | A/B for authoritative accepted-command identity; activation after M2 |
| G. Ingress and publish integration | Assistant/MCP and Adobe/importer normalization, asset/package provenance and publish UI/control flow | Every generated/imported asset follows authoring → `.gfxpkg` → Playout | Existing Shared document/package contracts; no Engine runtime dependency |
| H. Certification/soak | Protocol-v3 Playout-controlled harnesses, allocation/high-water telemetry collection, hardware records | 8-hour local soak; 24-hour tier/hardware procedure; negative authority/domain/recovery/perf evidence | A–F as their gates land |

Workstreams own different modules and contracts. They communicate through Shared fixtures, protocol v3 schemas, and the published governor/PreparedRuntime interfaces; no workstream may create alternate renderer, cache, or command paths.

## 7. Agreed disagreements and resolutions

| Question | Resolution | Reason |
| --- | --- | --- |
| Is 50–60 warm scenes a mandatory fixed reservation? | No. It is a measured, profile/hardware-specific admission target after Program/Preview/headroom reservations. | Fixed counts overcommit heterogeneous scenes and hide pressure; capacity must tell the truth. |
| Should M2 and M3 be one release cutover? | M2 gates first; M3 may be developed concurrently but is activated only after M2 proof. | Authority/domain/native-view parity independently closes urgent correctness gaps and makes recovery state smaller and testable. |
| Can a client assert its own role in Hello? | No. Identity derives from authenticated credential/session; Hello is not an authorization source. | Client claims are not security/authority evidence. |
| Can wgpu VRAM telemetry enforce a hard limit? | No. Deterministic owned-resource reservation/accounting is authoritative; wgpu/OS deltas are advisory. | wgpu lacks portable global VRAM accounting. |
| Can batching freely sort by material/texture? | No for blended/transparent content. Batch contiguous compatible painter-order runs; reorder only proven-opaque content. | Current blend semantics are order-dependent. |
| Are indirect draws the base optimization? | No. Start with fixed-capacity instanced packet runs; add indirect only after measured benefit for repeated opaque meshes. | Indirect buffer/culling overhead can regress current workloads. |
| Does moving allocation outside one function satisfy zero allocation? | No. Frame/output ownership requires fixed reusable pools/slots, and the tick prohibits allocation escapes. | A relocated `Vec` allocation still causes memory churn. |

## 8. Final objection check

The council's final objection check must reject release promotion if any of the following remains true:

- an Editor principal can mutate Program/output state, or a bare scene ID can select a runtime;
- Program accepts an authoring or unverified published revision;
- browser pixels are treated as proof of production parity before the native Editor Render View gate;
- a prepare request bypasses reservation, evicts a protected resource, silently downgrades, or leaks reservation/upload state after failure;
- a render tick allocates, blocks, dynamically scans unbounded collections, prepares scenes, or changes transparent draw order;
- output handoff allocates frames instead of recycling bounded slots;
- recovery acknowledges non-durable state, replays without revision/lease fencing, or resumes output before an off-air validated frame;
- a soak shows unbounded owned CPU/GPU growth, deadline/p99 regression, unexplained eviction/refusal, or failed recovery evidence.

When all gates pass, the architecture is integrated through the existing authority chain with explicit capacity behavior, stable pixel semantics, and evidence-based performance rather than a separate platform rewrite.
