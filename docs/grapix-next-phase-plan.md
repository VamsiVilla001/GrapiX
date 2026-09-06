# GrapiX — Phase Plan

> Execution breakdown of `grapix-roadmap-easing-io-data-scripting.md`.
> Thirteen phases in five milestones. Each phase states what it changes, what it must not
> change, how it is proven, and what it unblocks.
>
> Effort is **working days for one engineer**, and it is a shape, not a commitment.
> Where a phase touches a parallel TypeScript/Rust pair, the estimate includes both sides —
> they land in one commit or not at all.

---

## Milestone map

| Milestone | Phases | Theme | Hardware | Effort |
| --- | --- | --- | --- | --- |
| **M-A** | P0 · P1 · P2 | Animation and easing | none | 16–24 d |
| **M-B** | P3 · P4 · P5 | Output foundations and control protocols | none | 20–29 d |
| **M-C** | P6 · P7 | Live output to certification | NDI LAN, one DeckLink card | 14–22 d + certification runs |
| **M-D** | P8 · P9 · P10 | Data Hub and binding | a DB instance in P9 | 24–35 d |
| **M-E** | P11 · P12 | Isolated scripting and the public SDK | none | 16–24 d |

Total ≈ 90–134 engineer-days plus two certification windows.

### Dependency graph

```
P0 → P1 → P2 ─┬─────────────────────────────► P11 → P12
              │
P3 → P4 ──────┼─► P6 ─► P7
              │
P5 ───────────┴─────────────────────────────► P11
                                    (vocabulary)
P8 → P9 → P10
 ▲
 └── needs P2 only for animated data-driven scenes; contracts can start earlier
```

**Three tracks can run concurrently once P2 lands:** the I/O track (P3→P7), the data track
(P8→P10), and the automation gateway (P5). Scripting is last by design and depends on both P2
(directors give it something worth controlling) and P5 (it must reuse the proven command
vocabulary).

---

# Milestone A — Animation and easing

## P0 · Easing library and the conformance table

**Effort** 4–6 d · **Blocked by** nothing · **Unblocks** P1, P2

**Intent.** Make easing a single specification with two implementations that cannot drift, and
make an unknown easing loud.

**Work**

- `Shared/animation-engine/src/easing.ts` — the full named set as exact cubic-Bezier control
  pairs or closed forms: `linear`, `hold`, `ease`, `easeIn|Out|InOut` × `quad·cubic·quart·quint·sine·expo·circ`, `back`, `elastic`, `bounce`.
- `services/render-engine/src/easing.rs` — the twin, same commit.
- `Shared/animation-engine/fixtures/easing-vectors.json` — 33 samples of `t → f(t)` per easing
  at fixed rational times; generated once, checked in, never regenerated to make a test pass.
- `hold` promoted from an out-of-range behaviour to a first-class interpolation on a key.
- Unknown easing → diagnostic `animation.unknown-easing` carrying object, property, frame and the
  offending value; the evaluator **holds the previous value**. No linear substitution.

**Must not change.** Existing scenes must evaluate identically. The vector table is additive;
every easing already in use keeps its exact curve.

**Exit gate**

- `node --test` and `cargo test --manifest-path services/render-engine/Cargo.toml` both read the
  same fixture and agree to 1e-9. *(Rule 147: `cargo test` is not part of `npm test` — run it.)*
- `npm run certify:animation` unchanged and still green.
- A scene carrying a bogus easing name produces a diagnostic in both applications' consoles.

**Definition of done.** Adding an easing to one language and not the other fails a test locally,
not on air.

---

## P1 · Tangents, spatial linking, colour, rational time

**Effort** 6–9 d · **Blocked by** P0 · **Unblocks** P2

**Intent.** Make the curve editor mean what an operator thinks it means, and remove the two
quiet correctness bugs in the evaluator's inputs.

**Work**

- **Influence/speed tangents.** Store `influence` (0–100 %) and `speed` (units/s) per side;
  derive the Bezier handle. Update `TimelinePanel.tsx` numeric fields and the Speed Graph to read
  and write those, not raw handles. Migrate existing tangents on load (rule 8) — the conversion
  is exact, not lossy.
- **Linked spatial easing.** `spatialLink: 'independent' | 'linked'` on the position channel
  group. Linked drives one parameter `u`; X/Y/Z sample at `u`. New channels default `linked`;
  every scene already on disk normalises to `independent` so nothing moves differently after an
  upgrade.
- **OKLab colour interpolation.** `colorSpace: 'oklab' | 'srgb'` on colour channels, default
  `oklab` for new channels, `srgb` for existing. Mirrored in Rust.
- **Rational frame time.** The evaluator takes a rational frame, not a float second, on both
  sides. Audit the evaluation path for any remaining float second and remove it.
- **Stagger tool** (Editor command, no evaluator change): offset the channels of N selected
  objects by a per-index delay with an optional group ease.

**Must not change.** Pixel parity. `certify:parity` must be identical before and after — if it
moves, a default was applied to an old scene somewhere.

**Exit gate**

- `certify:animation` extended: a linked-spatial diagonal move asserted identical in TS and Rust
  at 12 frames; an influence/speed round-trip asserted lossless; an OKLab ramp asserted against
  fixtures.
- `certify:parity` unchanged.
- Live UI check: drag a tangent, type an influence, watch both agree (rule 12).

---

## P2 · Scene Directors

**Effort** 6–9 d · **Blocked by** P1 · **Unblocks** T1 transitions later, P11

**Intent.** Replace "Take plays the timeline, Take Out is a cut" with the named-director model
the operator console was already built around.

**Work**

- `SceneDocument.directors[]` in `Shared/shared-types`:
  `{ id, name, role: 'in'|'out'|'loop'|'custom', startFrame, endFrame, playMode: 'once'|'loop'|'pingpong', onComplete: 'hold'|'stop'|'trigger:<id>' }`.
- Rust counterpart in `animation.rs`; director state machine in the engine, sampled per frame
  from already-prepared objects — **never** by re-preparing (482 ms/frame, rule 49).
- Editor: director strip in the timeline, create/rename/range-drag, per-director preview.
- Playout: `take` plays `in`; `takeOut` plays `out` and clears **on completion**, not before;
  `Continue` advances to the next custom director. Protocol v3 additions land in TS and Rust
  together (rule 7).
- Publishing carries directors; a rundown item pins them with the version it already pins.

**Must not change.** A scene with no directors behaves exactly as it does today — Take plays the
timeline, Take Out cuts. This is the compatibility rule that keeps `certify:publish-takelist`
meaningful.

**Exit gate**

- `certify:playout-engine` extended: publish → cue → take (`in` plays) → hold → take out (`out`
  plays to completion, *then* clear), with real rendered pixels compared at named frames.
- `certify:publish-takelist` green unchanged, plus one case proving a director-less scene is
  byte-identical in behaviour.
- Live: Take, Take Out and Continue drive a real animated lower third on the operator console.

---

# Milestone B — Output foundations and control protocols

## P3 · Alpha and key/fill semantics

**Effort** 4–6 d · **Blocked by** nothing (can run beside M-A) · **Unblocks** P4, P6, P7

**Intent.** Decide the alpha contract now, while it is cheap. Deciding it after a card exists
means re-certifying pixel parity twice.

**Work**

- `Shared/output-contracts`: `alphaMode: 'straight' | 'premultiplied'` reported per output and
  per adapter, never inferred; `keyFill: { mode: 'none'|'fill-only'|'key-and-fill'|'internal-keyer', keyLink?, fillLink? }`.
- Engine: key plane = alpha promoted to full-range luma; fill = colour premultiplied against
  black unless the adapter declares otherwise. Both produced from the same Program frame.
- An adapter that cannot honour a requested `keyFill` mode **refuses to configure** with a code
  and the modes it does support.
- Fixtures: a known RGBA test pattern with hard edges, soft edges, and a 50 % alpha gradient.

**Exit gate**

- New `npm run certify:key-fill` — fill and key planes byte-for-byte against fixtures, through
  the **virtual** output. No hardware required to prove the maths.
- `certify:parity` unchanged.

**Why this is worth its own phase.** Premultiplied-vs-straight is the single most common reason a
graphic looks right in the editor and shows a dark halo on air, and it is invisible until a
downstream keyer sees it.

---

## P4 · Clock source, readback and frame pacing

**Effort** 8–12 d · **Blocked by** P3 · **Unblocks** P6, P7

**Intent.** Make the engine able to be driven by an external device clock, and make getting a
frame off the GPU cheap enough for UHD — both before a card exists, so the card phase is about
the card.

**Work**

- `services/render-engine/src/clock_source.rs`:

  | Source | When | Behaviour |
  | --- | --- | --- |
  | `internal` | today, NDI-only, virtual | absolute deadlines from frame number, unchanged |
  | `external(deviceId)` | a genlocked card is master | the device's scheduled-playback callback drives `render_program_frame`; the internal clock becomes a watchdog that reports and never emits frames |

  Exactly one master; a second request refused with a code. Master lost → fall back to
  `internal` **and report the degradation**.
- `services/render-engine/src/readback.rs`: three persistent GPU→CPU staging buffers created
  once, `map_async` on a ring. Nothing allocated per frame (rule 29).
- Format conversion as a **compute shader** (BGRA → UYVY / v210 / NV12), not a CPU loop. New WGSL
  in `Shared/render-shaders/wgsl/`.
- 3-frame preroll before an output starts, so the first scheduled frame is never late.
- Per-output telemetry: queued frames, late frames, readback ms, convert ms — into the existing
  frame/dropped-frame/render-time channel.

**Exit gate**

- 1920×1080 @ 50 fps sustained with readback and conversion enabled, on the RTX 3070 Ti, within
  the 20 ms budget. Record the number the way 5.6 ms was recorded.
- A test asserting zero allocations in the per-frame path.
- Clock-master contention and master-loss fallback both covered by unit tests.

---

## P5 · Automation gateway — TCP/UDP/IP

**Effort** 8–11 d · **Blocked by** nothing (pure TypeScript, Playout-owned) · **Unblocks** P11, P12

**Intent.** Let the plant drive Playout, through the command bus Playout already has, and never
through a second path to Program.

**Work**

- New `Playout/services/automation-gateway`, loopback bind, port 4310.
- Protocol adapters, in this order: **RossTalk** (TCP 7788) → **JSON-lines** (TCP/TLS) →
  **UDP triggers** → **GPO/tally out** (TCP + HTTP webhook) → **AMCP subset** (TCP 5250).
- All adapters translate onto the same in-process command bus that `playout-control` exposes over
  HTTP. No adapter gets its own route to the engine.
- Non-negotiables, identical to the engine's rules: loopback default; non-loopback with no token
  refuses to start; peer allowlist; per-peer rate limit; audit log of accepted **and** refused
  commands; an idempotency key on every command (UDP duplicates, TCP reconnects mid-command); a
  malformed command refused with a stable code on the wire, never ignored.
- Timecode: system-clock and engine frame-count first. RP188/VITC arrives with P7.

**Exit gate**

- New `npm run certify:automation`: every adapter round-trips a take; duplicate UDP triggers fire
  once; a rate-limited peer is refused with a code; a non-loopback bind with no token refuses to
  start; the audit log contains both outcomes.
- `npm run check:boundaries` proves the gateway cannot reach `render-protocol`.

---

# Milestone C — Live output to certification

> Both phases end at a **recorded certification run**, not at "it compiles". A feature flag makes
> an adapter compilable, never certified (rule 22). Order the DeckLink card during P3.

## P6 · NDI to certification

**Effort** 6–9 d + a soak window · **Blocked by** P4 · **Hardware** a second machine on the LAN

**Work**

- Discover the NDI 6 runtime at **run time** (`NDI_RUNTIME_DIR_V6`, then the standard install
  path). Missing runtime → refusal naming the redistributable, not a failed start.
- Send RGBA so key and fill travel in one stream; optional `fill + key as two sources` mode for
  receivers that cannot read alpha.
- **Tally read-back** from NDI surfaced in the operator console — a receiver telling you it is on
  air is real production information and costs almost nothing.
- Groups, source naming (`<machine> (GrapiX Program)`), bandwidth mode.

**Exit gate** — `certify:output-hardware(ndi)`: a receiver on a second machine; alpha validated
against the P3 fixtures; 8-hour soak with dropped-frame telemetry; results written into
`docs/hardware-certification-template.md`. **Only that record flips `hardware_certified` for NDI.**

---

## P7 · DeckLink

**Effort** 8–13 d + a certification window · **Blocked by** P4, P6 · **Hardware** one card

**Work**

- `crates/grapix-decklink` behind `--features decklink`. Bind from an env-pointed
  `DECKLINK_SDK_DIR` at build time; load `DeckLinkAPI.dll` through COM at run time. **No vendor
  file enters the repository.** With the SDK absent, CI builds the adapter as
  unavailable-with-reason.
- Device and mode enumeration; an unsupported mode refused with the list of supported ones.
- `ScheduleVideoFrame` + `ScheduledFrameCompleted` as the `external` clock source from P4.
- Key/fill across two SDI links, plus the internal keyer where the device supports it — report
  which is in use.
- Genlock/reference detect as a status field.
- Device loss: a card pulled mid-show produces a structured fault, stops claiming live, and
  allows reconfiguration **without restarting the engine**. Record the timings.
- RP188/VITC timecode read, fed to the gateway from P5.

**Explicitly still refused.** Interlaced output. It is a field-order and temporal-sampling change
in the renderer, not an output flag, and refusing it is correct until it is implemented and
proven.

**Exit gate** — `certify:output-hardware(decklink)`: signal confirmed downstream; key/fill
validated against a real keyer; genlock locked; device-loss and recovery timings recorded;
8-hour soak. Record flips `hardware_certified` **for that device only**.

---

# Milestone D — Data Hub and binding

## P8 · Contracts, service skeleton, file providers, binding UI, delivery to air

**Effort** 10–14 d · **Blocked by** P2 for animated data scenes; contracts can start any time

**Intent.** Prove the entire path end to end with the providers that need no credentials, so
that P9 is only about drivers.

**Work**

- `Shared/data-contracts`: `DataConnector`, `DataSource`, `DataSchema` (fields, types,
  nullability, **checksum**, version), `DataBinding` (`sourceId@schemaVersion` → field path →
  property + declared transform chain).
- `services/data-hub`, Rust, port **4500**. Health, discovery, token auth, loopback default,
  non-loopback-without-token refuses to start. Supervisor *ensures* it, never owns it.
- Providers: **JSON, CSV, TXT** on disk with file watch, and over HTTP. Path safety — sanitise,
  join, re-canonicalise, re-check under the root (rule 20); a symlink is invisible to a syntax
  check.
- Transforms, declared not scripted: format (precision, thousands, date/locale, case), unit,
  clamp, lookup table, and `whenMissing: { use: 'literal'|'lastGood'|'hide' }` — the one
  legitimate fallback in the system, because it is declared.
- Editor: schema browser and binding UI **inside Scene Inspector** (where bindings already live),
  live preview through the Editor Render View, take-blocker reporting.
- Playout delivery: subscribe → resolve bindings for cued/on-air scenes → coalesce updates
  arriving between frames into one `playout.update` applied at a frame boundary → **invalidate
  the prepared-scene cache explicitly** (`playout.update` does not bump the revision, rule 29).
- Snapshot at Cue by default; `live: true` opt-in per binding.
- Schema drift → `data.schema-drift` naming the field that moved, surfaced as a take blocker.

**Must not change.** Data Hub never speaks to the engine. Add it to `check:boundaries` as a
forbidden dependency on `render-protocol` — a check, not a comment.

**Exit gate** — new `npm run certify:data-to-air`: a CSV on disk changes and the on-air text
changes within one frame boundary; two updates in one frame interval produce one
`playout.update`; a renamed column produces a take blocker, not a blank graphic; a cued scene's
snapshot does not move when the source does; a `live` binding does.

---

## P9 · Database and push providers

**Effort** 8–12 d · **Blocked by** P8 · **Hardware** a DB instance

**Work**

- **ODBC/OLEDB** via `odbc-api` — the "ADODB" surface: Access, Excel, SQL Server, legacy OLEDB
  providers, through the driver manager Windows already ships.
- Native drivers where they earn it: `tiberius` (MSSQL), `tokio-postgres`, `mysql_async`.
- **Credentials in the OS credential store** (`keyring` → Windows Credential Manager), referenced
  by `credentialId`. Never in a scene document, a `.gfxpkg`, or a log.
- Parameterised queries by construction — the source stores named parameters, never a
  concatenated string.
- Read-only by default; a non-`SELECT` statement refused unless the connector is explicitly
  marked writable.
- Poll mode with interval and change detection (result hash) so an unchanged query produces no
  update.
- Push providers: WebSocket, TCP line feed, HTTP long-poll. NoSQL: MongoDB, Redis.
- Editor read-only token with a **row cap** — authoring preview must not pull a million rows into
  a design session.

**Exit gate** — new `certify:data-providers`: each provider round-trips a typed frame; a
credential never appears in any log or exported package; an injection attempt through a parameter
is inert; a write statement on a read-only connector is refused with a code; a dropped connection
keeps the last-good value, reports its age, and never presents it as fresh (the data analogue of
rule 41).

---

## P10 · Tables and repeaters

**Effort** 6–9 d · **Blocked by** P9

**Intent.** League tables, election results and start lists are the actual reason data binding
exists, and they are not a variant of single-field binding.

**Work**

- `DataTable` in the contracts — rows plus a pinned column schema.
- A repeater/duplicator scene object bound to a table: row template, count from data, per-row
  bindings, sort and filter declared in the binding.
- Paged recall: N rows per page mapped onto a take list, so an operator can page a table on air.
- Bounds: a maximum row count per repeater, refused with a code rather than instantiating 10,000
  objects during a take.

**Exit gate** — `certify:data-to-air` extended: a 24-row table renders as three pages of eight;
a row added mid-cue does not disturb a snapshot binding; exceeding the row cap is refused, not
truncated silently.

---

# Milestone E — Scripting and the public SDK

## P11 · Script host and the Scene SDK

**Effort** 10–14 d · **Blocked by** P2 (directors give scripts something worth controlling) and
P5 (reuse the proven command vocabulary)

**Intent.** Close the gate `memory.md` already names: production arbitrary JavaScript stays
Planned until a disposable isolated worker with CPU, wall-time and memory limits and
typed-action-only output passes escape and flood testing.

**Work**

- `services/script-host`, Rust, port **4600**, embedding **QuickJS** (`rquickjs`): hard heap
  limit per isolate, interrupt handler for wall-clock, no host globals by construction, no third
  runtime in the installer.
- TypeScript authoring compiles to ES2020 for the isolate; `@grapix/sdk` types stay the source of
  truth.
- Budgets, enforced and reported: ~2 ms wall per invocation, 8 MB heap, capped action count per
  invocation and per second. Exceeding any disables the script **for that take**, raises a
  structured diagnostic, and leaves the graphic rendering.
- Determinism: inject `frame`, rational `time`, scene data, a **seeded** RNG. No wall clock, no
  network, no filesystem, no dynamic code generation.
- Hooks in order of usefulness: `onLoad`, `onCue`, `onTake`, `onTakeOut`, `onData`, `onTrigger`,
  and only then a budgeted `onFrame`.
- Authority: Editor calls with an **evaluate-only** token and receives a plan (rule 47); Playout
  calls with an **execute** token and routes every returned action through its existing command
  bus, where the same scopes, rate limits and audit log apply as to an automation command.

**Exit gate** — new `certify:script-isolate`: escape attempts (globals, prototype pollution,
import, WASM, shared memory) all fail; flood tests (infinite loop, allocation bomb, action storm)
are killed within budget; determinism holds across 1,000 runs of identical inputs; and Program
holds frame rate while a hostile script is killed.

---

## P12 · Control SDK

**Effort** 6–10 d · **Blocked by** P5, P11

**Work**

- `@grapix/sdk/control` — an out-of-process client for third parties: list scenes, cue, take,
  take out, update data, subscribe to state, over HTTP/WS.
- **Generated from the contracts in `Shared/`**, so it and the P5 automation gateway expose one
  command vocabulary — one in-process, one on the wire. A command in one and not the other is a
  bug in whichever was written second.
- Versioned and publishable; a sample integration in the repository.

**Exit gate** — a third-party sample, running outside the repository against a packaged build,
drives publish → cue → take → data update → take out end to end. Any divergence from the
gateway's vocabulary fails a contract test.

---

# Running the plan

## Per-phase definition of done

Every phase, without exception:

1. `npm run check:boundaries`
2. `npm run typecheck` (including `cargo check` for both shells)
3. `npm test`
4. **`cargo test --manifest-path services/render-engine/Cargo.toml`** — rule 147: this is not part
   of `npm test`, and the `protocol_server` suite has been red before precisely because nothing
   surfaced it
5. The phase's own `certify:*` gate, plus every pre-existing gate still green
6. `npm run build` and, for anything touching packaging, `npm run ship`
7. Live UI verification for anything rendering or operator-facing (rule 12)
8. `memory.md` updated — status, ownership, verified work, and any new binding rule (rule 13)

## Checkpoints

| After | Checkpoint | What it means |
| --- | --- | --- |
| P2 | **v0.5 — Animated library** | Every scene can animate in and out through the operator console |
| P5 | **v0.6 — Plant-ready** | The facility can drive Playout over TCP/UDP; alpha and pacing are proven without hardware |
| P7 | **v0.7 — On air** | Signal on a cable, certified per device, with recorded evidence |
| P10 | **v0.8 — Data-driven** | Scenes read live data with pinned schemas and paged tables |
| P12 | **v1.0 — Programmable** | Sandboxed scene scripting and a public SDK |

## What to start this week

- **P0** — the easing vector table. One afternoon of it removes an entire class of on-air fault,
  and everything in M-A sits on it.
- **P3** in parallel — the alpha decision. It needs no hardware, it is cheap now and expensive
  later, and it gates two thirds of the I/O work.
- **Order the DeckLink card.** It has the longest lead time and the shortest engineering
  dependency; P7 should be waiting on nothing but a certification window.
