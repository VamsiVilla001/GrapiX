# GrapiX — Distributed Architecture: ADRs and System Design

Target branch: a clean branch for parallel development of Render Engine,
Editor and Playout against shared contracts.

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 9 September 2026 |
| **Deciders** | Engineering lead, product owner; leadership for external gates |
| **Supersedes** | Nothing. Complements the renderer architecture design. |

> Status vocabulary is the one already in use: **Implemented**, **Partial**,
> **Planned**, **External gate**, **Not present**. This document proposes;
> it claims nothing is built.

---

## 0. The constraint that shapes everything

The render engine runs **on the editor's machine now** and **on a separate
server later** — a server that also carries I/O output locked to house
genlock.

That single sentence contains a trap. If the transport is built for local
first and remote is added later, the move is a rewrite: timing assumptions
leak into the control plane, frame delivery assumes shared memory, and the
clock ends up owned by the wrong process. The whole design below exists to
make relocation a **deployment change, not an architecture change**.

Genlock is what forces the discipline. Once output is locked to an external
reference, **the render node owns time** — not Playout, not the Editor, and
certainly not the network. Any design where a controller says "render now"
is already broken.

**A useful side effect.** A remote engine resolves the cross-platform
question cleanly: designers on macOS running the Editor, engine and I/O on
a Windows server with the cards. macOS never needs to be a certification
target.

---

# Part A — Architecture Decision Records

## ADR-001: Four transport planes, one of them out-of-band

**Status:** Proposed

### Context

Three kinds of traffic and one kind of synchronisation must cross the
Editor/Playout/Engine boundary. They have incompatible requirements —
control is small and ordered, assets are large and resumable, media is
continuous and lossy-tolerable, and timing must not be carried by software
at all.

### Decision

Define four planes with independent transports and failure semantics.

| Plane | Carries | Local (L0) | Remote (L1) | Loss tolerance |
|---|---|---|---|---|
| **Control** | protocol v3: capability, prepare, cue, take, clear, patches, output config | Named pipe / Unix socket | QUIC or TLS 1.3 stream, mTLS | **None.** Ordered, acknowledged, sequenced |
| **Asset** | `.gpxpkg` packages, textures, fonts, glTF | Local filesystem handoff by path | Content-addressed chunked upload, resumable | None, but restartable |
| **Media** | Preview and Program confidence frames back to both UIs | Shared memory or handle passing | Compressed stream, negotiated codec | **High.** Drop, never queue |
| **Timing** | Genlock reference, or PTP for IP | Hardware REF input to the card | Hardware REF input to the card | N/A — **never on the network** |

The timing plane is not a software transport. It is a cable. Recording it
as a plane makes explicit that no message ever carries "when."

### Options considered

**Option A — Single multiplexed connection for everything**

| Dimension | Assessment |
|---|---|
| Complexity | Low initially, high later |
| Cost | Low |
| Scalability | Poor — a large asset upload head-of-line blocks a take |
| Team familiarity | High |

**Pros:** one thing to build, one thing to authenticate.
**Cons:** couples unrelated failure modes. A 400MB package transfer must
not be able to delay a cue.

**Option B — Four planes, independent transports** *(chosen)*

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Medium |
| Scalability | Good — each plane scales on its own axis |
| Team familiarity | Medium |

**Pros:** failure isolation; media can drop while control cannot; assets
resume without touching the control session; timing is structurally
incapable of being networked.
**Cons:** four things to authenticate and monitor; more surface.

**Option C — Message broker between products**

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | High |
| Scalability | Good for control, wrong for media |
| Team familiarity | Low |

**Cons:** adds a component that must be as reliable as the engine, for a
single-engine local-first system. Rejected as premature.

### Consequences

- **Easier:** relocating the engine; reasoning about what can be lost.
- **Harder:** four transports to secure, instrument and test.
- **Revisit:** whether QUIC's multiplexed streams let Control and Asset
  share one connection with separate streams — plausible, and worth
  measuring rather than assuming.

### Action items

1. [ ] Define the plane boundaries in the shared contracts package.
2. [ ] Extend the capability exchange to declare locality tier.
3. [ ] One conformance test per plane, runnable against a mock peer.

---

## ADR-002: Clock authority lives with the render node

**Status:** Proposed

### Context

The existing ProgramClock derives absolute per-frame deadlines from frame
number — correct, and the right foundation. But genlock changes where
*phase* comes from: the SDI card locks its output to an external reference,
and frames must be scheduled in the card's timebase, not the host's
monotonic clock.

If Playout retains any timing authority, moving the engine to a server
introduces network jitter directly into Program cadence.

### Decision

**The render node is the sole clock authority.** The control plane carries
*intent*, never time.

- Playout sends `take(take_id, revision, at: NextOpportunity | Frame(n))`.
  It never sends "now."
- The engine resolves intent against its own genlocked timebase and returns
  the frame number it actually committed to.
- When a genlocked live adapter is configured, ProgramClock is **slaved to
  the output device's reference clock**. When no reference is present, it
  free-runs — and reports free-run explicitly rather than hiding it.
- **One clock domain per engine instance.** Two outputs on different
  references means two engine instances, not one.

### Options considered

**Option A — Controller-driven timing.** Playout computes when. Simple
locally, fails the moment there is a network. Rejected.

**Option B — Engine-owned clock, intent-based control** *(chosen)*.
Identical code path local and remote. Latency changes only how far ahead
intent must arrive, not correctness.

**Option C — Shared distributed clock (PTP everywhere).** Correct for IP
production and the eventual answer for multi-node. Overkill for a single
local engine, and doesn't remove the need for genlock on SDI. Deferred to
the multi-node phase.

### Trade-off analysis

Option B costs a small amount of expressiveness — Playout cannot demand an
exact wall-clock instant — in exchange for the property that matters:
**cadence is never a function of transport.** That is what makes L0 → L1
migration safe.

### Consequences

- **Easier:** relocation; genlock; multi-node later, since each node
  already owns its clock.
- **Harder:** Playout UI must express "next opportunity" honestly rather
  than implying instantaneous control. Operators need to see the committed
  frame number.
- **Revisit:** reference lock loss mid-show. Recommended behaviour is to
  hold last good cadence, report degraded, and refuse new live
  configuration — consistent with the existing refusal contract.

### Action items

1. [ ] Change take/cue contracts to intent form; return committed frame.
2. [ ] Add reference-lock state to capability and status reporting.
3. [ ] Surface free-run vs locked in Playout, unmissably.

---

## ADR-003: Contract-first parallel development

**Status:** Proposed

### Context

Three products are to be built in parallel on a clean branch. Parallel
development against an unstable interface produces integration failure, not
speed. The existing tree already has a Shared layer that all three consume
and that depends on none of them — the right shape, and the enabler.

Note the existing state: two internal documents disagree about how many
contract packages exist, and hand-mirrored TypeScript and Rust types are a
recorded source of drift.

### Decision

- **Contracts land first, in one place, generated not mirrored.** Rust is
  the source of truth; TypeScript is generated from it.
- **Each product develops against a mock peer**, not against the other
  products. A conformance suite defines what a valid peer does.
- **One Cargo workspace**, one lockfile. The current four-project layout is
  why version pinning has to be enforced by convention.
- No product may merge to the branch without passing the conformance suite.

### Options considered

**Option A — Integrate continuously against real peers.** Realistic, but
serialises three teams on whoever's build is broken.

**Option B — Contract-first with mock peers and a conformance suite**
*(chosen).* Each product moves independently; integration becomes a
scheduled event rather than a daily hazard.

**Option C — One product at a time.** Lowest risk, but the request is
explicitly parallel.

### Consequences

- **Easier:** genuine parallelism; the mock peer doubles as the CI harness
  and, later, as the offline-development story.
- **Harder:** contract changes become a coordinated event. That is a
  feature, not a defect.
- **Revisit:** whether to move from generated types to a full IDL
  (FlatBuffers) once the protocol surface stabilises. Zero-copy reads
  matter more on the media plane than on control.

### Action items

1. [ ] Create the contracts package; resolve the disputed package count.
2. [ ] Generate TS from Rust; delete hand-mirrored declarations.
3. [ ] Build the mock engine, mock playout, mock editor.
4. [ ] Consolidate to one Cargo workspace on the clean branch.

---

## ADR-004: Media plane negotiates encoding by locality

**Status:** Proposed

### Context

Preview and Program confidence frames currently return as bounded JPEG
streams. Locally that is nearly free. Across a LAN, four streams (Preview
fill/key, Program fill/key) at native resolution is a bandwidth problem —
and a designer dragging a handle needs low latency, which is a different
requirement from an operator watching a confidence monitor.

### Decision

Negotiate media encoding at session start from the declared locality tier
and the consumer's role.

| Consumer | L0 co-located | L1 LAN |
|---|---|---|
| Editor viewport (interactive) | Shared memory, uncompressed | Low-latency codec, adaptive resolution, optimistic local overlay |
| Confidence monitor (observational) | JPEG, as today | Compressed, bounded, resolution-tiered |

**Rules:** media always drops rather than queues; the interactive stream
degrades resolution before it degrades latency; and no media path may
influence Program cadence.

### Consequences

- **Easier:** remote authoring becomes viable rather than theoretical.
- **Harder:** an encoder in the engine, and a codec decision. NVENC on
  the server, VideoToolbox on macOS clients for decode.
- **Revisit:** whether the interactive stream should become a native child
  surface at L0 — eliminating the round trip entirely — while L1 keeps the
  stream. Both, selected by tier, is likely the answer.

---

## ADR-005: `is_live` gates on device tier *and* reference lock

**Status:** Proposed

### Context

`is_live` already decides what reaches an audience. Two new conditions must
join it: the device tier from the renderer design (T0 hardware GPU through
T3 CPU partial), and genlock reference state.

### Decision

A live adapter refuses to configure unless **all** hold:

1. Device tier is T0 (hardware GPU).
2. Platform is a certification target.
3. Reference signal is locked, or the adapter is explicitly configured for
   free-run by an operator who has been told.

Each refusal names the failing condition. No fallback, no approximation —
the existing contract, extended.

### Consequences

- **Easier:** the CPU/software fallback becomes safe by construction. A
  degraded machine cannot silently go to air.
- **Harder:** more states for operators to understand. Mitigated by
  reporting them explicitly rather than inferring.

---

# Part B — System Design

## B.1 Deployment topologies

**Phase A — co-located (now)**

```
┌─────────────────────── ONE WORKSTATION ───────────────────────┐
│                                                                │
│  EDITOR (Tauri 2)          PLAYOUT (Tauri 2)                  │
│   project-api :4100         playout-control :4300             │
│        │                          │                            │
│        │  ctrl: unix socket /     │ ctrl: unix socket /        │
│        │        named pipe        │       named pipe           │
│        └──────────┬───────────────┘                            │
│                   ▼                                            │
│      RENDER ENGINE :4400  (device tier T0)                     │
│        ProgramClock — free-run, reported as free-run           │
│        outputs: null · virtual · recording                     │
│                   │                                            │
│        media: shared memory ──► both UIs                       │
│        assets: local filesystem by path                        │
└────────────────────────────────────────────────────────────────┘
```

**Phase B — engine on an output server (later)**

```
┌──── OPERATOR / DESIGNER MACHINES ────┐
│  EDITOR (macOS or Windows)           │
│  PLAYOUT (Windows)                   │
└───────────┬──────────────────────────┘
            │  Control: QUIC/TLS 1.3, mTLS, gx1 tokens
            │  Asset:   content-addressed chunked, resumable
            │  Media:   negotiated codec, adaptive
            ▼
┌──────────────── OUTPUT SERVER (Windows, certified) ───────────┐
│  RENDER ENGINE :4400   device tier T0                         │
│    ProgramClock ◄─── SLAVED to card reference clock           │
│    WAL journal · tiling · Program                             │
│                                                                │
│  OUTPUT: DeckLink / AJA ──► SDI fill + key                    │
│          NDI / SRT / OMT ──► IP                               │
│                     ▲                                          │
│                     │ REF IN                                   │
└─────────────────────┼──────────────────────────────────────────┘
                      │
              ┌───────┴────────┐
              │ HOUSE GENLOCK  │  black burst / tri-level
              │ (or PTP 2059)  │  — never over the network
              └────────────────┘
```

**What changes between A and B:** transport binding, media encoding, clock
source. **What does not change:** contracts, product code, the meaning of
any message.

## B.2 Control plane contract shape

```rust
// Intent, never time. Engine returns what it committed to.
enum TakeAt { NextOpportunity, Frame(u64) }

struct TakeRequest {
    take_id:  TakeId,
    revision: Revision,        // exact; refuse on mismatch
    at:       TakeAt,
}

struct TakeCommitted {
    frame:      u64,           // in the engine's timebase
    timebase:   RationalRate,  // num/den, never a float
    clock:      ClockSource,   // Genlocked{locked} | Ptp{..} | FreeRun
}

// Capability exchange, extended for locality and clock
struct EngineCapability {
    protocol:     u32,             // fixed constant, mismatch = error code
    locality:     Locality,        // CoLocated | Lan
    device_tier:  DeviceTier,      // T0..T3
    clock:        ClockSource,
    reference:    ReferenceState,  // Locked | Unlocked | NotPresent
    live_allowed: bool,            // derived from ADR-005
    media:        Vec<MediaCodec>, // offered, in preference order
}
```

Refusals stay first-class and name their reason — `RevisionMismatch`,
`TierTooLow(T2)`, `ReferenceUnlocked`, `UnsupportedBlendMode(overlay)`.

## B.3 Asset plane

- Content-addressed by SHA-256; the store already dedupes.
- **Two addressing modes retained:** content hash for the store,
  project-relative path for the library, so replacing a file in place keeps
  material bindings intact.
- Chunked, verified, resumable upload — already Implemented; extend with
  resume-after-disconnect for L1.
- `.gpxpkg` remains a zip container with a per-file SHA-256 manifest,
  re-verified after write. Publishing stays all-or-nothing.
- **Preflight before transfer:** the engine reports which content hashes it
  already holds; only the difference ships.

## B.4 Reliability

| Failure | Behaviour |
|---|---|
| Control disconnect | Program continues. Engine outlives both UIs. Reconnect, reconcile by revision and epoch. |
| Reference lock lost | Hold last good cadence, report degraded, refuse new live configuration. |
| GPU device lost | Renegotiate tier. If below T0, live adapters refuse. Restore from WAL, output-inhibited, validate first frame off-air. |
| Asset transfer interrupted | Resume by chunk. Package promotion is atomic — a partial package never becomes a revision. |
| Media stall | Drop counted frames. Never blocks the render clock. |
| Engine process death | WAL restore, output-inhibited start. Local standby before remote failover. |

## B.5 Observability

`tracing` spans per frame, exported via OpenTelemetry. Minimum series:
committed vs presented frame numbers, dropped frame counts by cause,
reference lock state transitions, device tier changes, media plane bitrate
and latency, asset transfer throughput. Wanted **before** the first soak
run, not after.

---

# Part C — Technology selection

## C.1 New for this design

| Concern | Choice | Notes |
|---|---|---|
| Remote control + asset transport | **QUIC via `quinn`**, fallback TLS 1.3 over TCP | Multiplexed streams avoid head-of-line blocking between planes. Measure whether Control and Asset can share a connection. |
| TLS / mTLS | **`rustls`** | Pure Rust, no OpenSSL build burden across platforms. |
| Local control transport | Named pipe (Windows) / Unix socket | Already Implemented. |
| Local media transport | Shared memory or handle passing | L0 only. |
| Remote media encode | **NVENC** on the server; VideoToolbox for macOS decode | Also the encoder for the recording adapter. |
| Genlock | **DeckLink / AJA reference input**, scheduled playback in the card's timebase | **External gate** — needs hardware. |
| IP timing | **SMPTE ST 2059 / PTP** | Deferred to multi-node. `statime` if a Rust implementation is wanted. |
| GPU→card DMA | **`ash`** Vulkan external memory, GPUDirect | wgpu does not expose external memory. Needed the day SDI is real. |
| Contract generation | **`ts-rs`** or **`specta`** now; FlatBuffers later | Ends hand-mirrored types. FlatBuffers only if protocol overhead shows in profiling. |
| Derived index | **SQLite**, rebuildable from JSON | Published library, asset lookup, audit search. Never the source of truth. |
| Package compression | **zstd** | Keep the zip container and manifest. |

## C.2 Carried forward from earlier discussion

| Technology | Verdict | Role |
|---|---|---|
| Rust + wgpu 26 | **Keep** | Engine. Memory safety in the on-air process is the strongest decision in the stack. |
| Tauri 2 | **Keep** | Both shells, Windows and macOS. Already native; no C++ rewrite justified. |
| Three.js 0.185 | **Keep, sole browser renderer** | Interim 2D plus permanent overlay layer. |
| PixiJS | **Remove** | Cannot do 3D; never a viable survivor. |
| lyon | **Keep as baseline** | Default rasteriser and the pixel-gate reference. |
| cosmic-text | **Keep** | Single shaping source for both paths. |
| Vello / `vello_hybrid` | **Evaluate later** | Shares the wgpu device; also the natural T1 hybrid backend. Alpha; wants wgpu 29; panics on mask layers and some blend modes — must be pre-validated. |
| Rive Renderer | **Dropped** | Three device-bridge implementations across Vulkan, D3D12 and Metal for work that is not on the gap register. |
| vgpu | **Tooling only** | Typed WGSL reflection; Dawn-backed headless CI. Not a renderer. |
| WASM core on WebGPU | **Fallback** | If the engine-rendered viewport fails on latency. |
| CUDA | **Not applicable** | Not a graphics API. NVIDIA is already reached via Vulkan/D3D12. NVDEC/NVENC are the relevant pieces. |
| SwiftShader / Lavapipe / WARP | **Adopt for T2** | CI and no-GPU environments. Never live. |
| `rquickjs` | **Adopt** | Script sandbox. Deterministic, capped, no V8 in Program. |
| FFmpeg / GStreamer + NVDEC | **Adopt for video tier** | Resolve the LGPL/GPL build question before writing code. |
| Lottie import | **Adopt** | Strategic alternative to the AE runtime container. No licence, no resident process. |
| NDI + SRT + OMT | **Adopt** | IP output not hostage to one vendor's licensing. |
| AE runtime container | **Parked** | Unresolved licensing. Wrong foundation for new surface. |

---

# Part D — Roadmap

Sequenced so each stage is independently useful and nothing later blocks
value earlier. **M** = milestone.

## M1 — Foundations on the clean branch

- One Cargo workspace, one lockfile
- Contracts package; TS generated from Rust; hand-mirrored types deleted
- Mock engine / mock playout / mock editor; conformance suite in CI
- Pixel gate with a baseline snapshot captured **before** anything changes
- Blend-mode refusal fix (`overlay` currently aliases to `screen` — a
  silent visual fallback)

**Exit:** three products build and test independently against mocks.

## M2 — Three products in parallel, co-located

- **Engine:** locality-aware transport; intent-based take; clock source
  reporting; device tier negotiation
- **Editor:** PixiJS removed, Three.js carries 2D; one camera model shared
  with the engine path; shared texture cache
- **Playout:** intent-based control surface; committed frame number visible;
  reference and tier state unmissable

**Exit:** full local vertical slice on the new contracts, conformance-clean.

## M3 — Parity

- Measure viewport latency on the existing frame stream
- Engine renders the viewport: binary alpha, picking, bounds, adaptive
  resolution; browser reduced to overlays
- If latency fails: native child surface at L0, or the WASM fallback

**Exit:** viewport and Program byte-identical across the reference set.

## M4 — Relocation

- Control and Asset planes over QUIC/mTLS; resumable transfer
- Media plane codec negotiation; adaptive interactive stream
- Engine runs on a separate machine with no product code change

**Exit:** the same conformance suite passes at L1 as at L0.

## M5 — Output server and genlock — *External gate*

- Reference input, scheduled playback in the card's timebase
- ProgramClock slaved to the card; free-run reported explicitly
- `is_live` gating on tier, platform and reference lock
- DeckLink / AJA via `ash` interop; NDI certification
- 8-hour nightly protocol soak; 24-hour hardware release gate

**Blocked on:** hardware, vendor SDKs, lab time. Not closable by
engineering alone.

## M6 — Content depth

- Video decoder tier: FFmpeg/NVDEC on Windows, VideoToolbox on macOS
- Transitions beyond cut (dual-target, dropped-frame certified)
- Script sandbox on `rquickjs` — unblocks scene scripting
- Lottie import path
- 3D depth: shadows, transparent ordering, camera parity — separate branch,
  separate gate

## M7 — Automation pipeline (Gen-AI)

Depends only on M1–M3 plus the publish path. Deliberately independent of
the certification gates, so it can move at its own pace.

| Stage | Content |
|---|---|
| **M7.1 Reproduction test** | Regenerate an already-shipped esports pack from the same brief. Blind comparison; designer states whether fixing a draft beat starting fresh. **~1 week. Kills or confirms the idea.** |
| **M7.2 Constrained generation** | Design system as machine-checkable constraints; motion preset library (10–15 designer-authored); scene assembly via MCP tools; publish as draft with Take ID; **correction capture from the first draft** |
| **M7.3 Visual loop** | Render → critique → revise. Validation gates: system diff, preset validity, binding completeness, refusal-clean render |
| **M7.4 Batch and measure** | Template list → batch generation. Zero-edit publish rate per class, per tournament |
| **M7.5 Graduation** | Per-class auto-publish behind a threshold and a **named sign-off owner**. Corpus tunes constraints and presets |

Two things carry this stage: **motion comes from a curated library, not
from the model**, and **the refusal contract is the agent's guardrail** —
an explicit named refusal teaches the agent what a silent approximation
never would.

## Sequencing note

M5 is the only milestone that cannot be closed by engineering. It should be
started in parallel from the commercial side at M1, because lead time on
hardware, vendor SDKs and lab access is the long pole — not the code.

---

## Revisit list

| When | What |
|---|---|
| After M4 | Whether Control and Asset share one QUIC connection with separate streams |
| After M3 | Native child surface at L0 vs frame stream at both tiers |
| After M3 | Rasteriser candidates, measured against the pixel gate — Vello first |
| After M5 | PTP / ST 2059 for multi-node; local standby before remote failover |
| After M7.1 | Whether the automation pipeline is a GrapiX feature or a separate product consuming its agent API — **the second keeps the renderer roadmap clean** |
