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
2. Inspect `git status` before editing. Preserve uncommitted work.
3. Log every change here: what, why, and what was actually run to verify it.
   An entry with no execution evidence must say so.
4. Never describe anything as working without having run it. "Compiles" is not
   "works", and `cargo check` is not a test.
5. Run `npm run check` before committing. It is cheap and it is the whole gate
   at this stage.
6. Rust is the source of truth for contracts. Never hand-edit
   `Shared/generated-ts` — regenerate and commit the result.
7. Do not add a `Now` variant to `TakeAt`, or any other way for a client to
   send a time. That is invariant 8 and it is the load-bearing decision of the
   whole architecture.
8. `resolve_intent` has exactly one implementation. A mock, a test double or a
   second engine must call it, never reimplement it (invariant 46).
9. The control plane has an L0 transport; the asset and media planes do not.
   Do not describe those two as transported.
10. The L0 transport is loopback TCP, not the named pipe ADR-001 specifies.
   Say so when describing L0 security posture.
11. Authentication lives in the transport. Do not add a credential check to
   the engine or to a request handler.
12. The credential is a shared bearer token over an unencrypted socket. Never
   describe it as mTLS, and never describe L1 as ready.
13. The next implementation step is one of: automatic reconnect with backoff,
   an asset-plane transport, or the pixel gate.

---

## 2026-09-10 — credential enforcement and reconnect reconciliation

Closed a hole the previous entry opened, then implemented ADR B.4's first row.

**The hole.** `check_bind` said a token makes a non-loopback address
acceptable, and nothing verified a token on a connection. That is worse than
not having the policy: it reads as a security control while being none. A
network-bound engine would have accepted anybody.

**`Shared/control-plane/src/auth.rs`.** `Token` compares in constant time over
its full length — `==` returns at the first differing byte, which leaks the
matching prefix length to anyone who can time it — and redacts itself in
`Debug`, because every message type derives `Debug` and connection errors are
printed. A token that prints itself reaches a log on the first bad connection.
`Token::new` refuses anything under 32 bytes, which is the case an unset
environment variable produces.

**Enforcement is in the transport, not the engine.** Authentication is a
property of the connection; an engine that re-checked on every request would
eventually miss one. The engine refuses `Authenticate` outright if it ever
sees one, and the compiler's exhaustiveness check is what forced that decision
to be explicit rather than defaulted. A protected connection is refused every
request until authenticated — capability included, since capability carries
device tier, clock source and reference state, none of which is public. A wrong
token gets a named refusal and the connection stays open: a mistyped
credential deserves a retry, and an attacker gains nothing from an open socket
that redialling would not also give.

**Reconnect and reconcile (ADR B.4).** `Client::reconnect` redials,
re-authenticates and returns a `Reconciliation` carrying the previous and
current epoch plus what is now on Program. `engine_restarted()` is the
question that matters. The trap it guards: a restarted engine can republish at
the *same revision*, so a client comparing revisions alone would see no change
and carry on with state that no longer exists. A fresh connection starts
unauthenticated, so a reconnect re-authenticates — which is what makes a
rotated token actually stop working, and there is a test that proves it.

`MockEngine::restart()` models a new incarnation that lost its state, so the
epoch path is reachable in a test rather than argued about.

### One defect the tests found

A `Refused(Unauthenticated)` arriving during the capability exchange came back
to the caller as `InvalidData` with the text "expected a capability reply",
because the client treated every non-capability reply as malformed. "Needs a
credential" and "this peer is broken" are different problems and a caller can
only act differently on them if the error kind says which. There is now one
`kind_for` mapping used by both the authentication step and the capability
exchange, so they cannot classify the same refusal differently — which they
did until the test caught it.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **125 passed, 0 failed** |
| — of which auth/reconnect integration | 10 passed, over real sockets |
| `cargo clippy --workspace --all-targets` | Clean, 0 warnings |
| `cargo run -p gx-conformance` | **88 passed, 0 failed, 8 skipped**, exit 0 |
| — peers exercised | 6, including two over a socket, one requiring a token |
| `node --test` | 7 passed |
| codegen | 37 types; `Token`, `Authenticate`, `Unauthenticated` reached TypeScript |
| `gx-mock-engine --token short` | Refused before binding, exit 1 |
| `gx-mock-engine --token <32 bytes>` | Bound, protected, listening |
| `npm run check` | **exit 0** |

### Still not done, and not claimed

- **A shared token is not mTLS.** ADR-001 specifies mTLS for L1 and this is a
  bearer secret on an unencrypted loopback socket. It is the enforcement half
  of the bind policy, not the L1 credential.
- Nothing is encrypted. At L0 that is defensible; at L1 it would not be.
- No token rotation, no expiry, no per-client identity. One secret, shared.
- Reconnect is client-initiated and manual: nothing reconnects automatically,
  and there is no backoff.
- The asset and media planes still have no transport.
- No renderer, no shell. Nothing has rendered a frame.

## 2026-09-10 — the L0 control transport

The planes had semantics but no transport: everything ran in-process, so
"transport-independent contracts" was an assertion. It is now a thing that runs.

**`Shared/control-plane` gained two pure modules.** `framing`: a four-byte
big-endian length then that many bytes of JSON, with the length validated
against a 1 MiB cap *before* any body is allocated — a peer cannot make the
reader reserve memory by lying (invariant 51). `bind`: the policy deciding
where the engine may listen. `0.0.0.0` and `::` are explicitly not loopback,
which is the case that would otherwise turn invariant 41 into decoration.

**`Shared/control-transport` is new** — both halves of the wire in one crate.
ADR-001 places protocol clients in `Shared`, and the server is the same format
read the other way; two copies of framing and dispatch would be the parallel
implementation invariant 27 forbids. The server is generic over `EnginePeer`
and has never heard of a scene. Three behaviours come straight from the plane's
guarantees: a sequence gap closes the connection (there is no correct way to
continue past a lost message), a duplicate is acknowledged but not re-executed
(a repeated take would reach air twice), and replies carry a `reply.` id while
events do not — which is how the client separates them off one stream, making
invariant 34 load-bearing rather than decorative.

**The conformance suite now runs over a socket.** Because the suite is written
against `EnginePeer` and `Client` implements it, pointing it at a live server
took no change to any check. Twelve control-plane checks now pass across a real
transport. That is ADR-001's L0/L1 exit criterion in miniature.

**The mock engine is runnable.** `cargo run -p gx-mock-engine -- --genlocked
--publish lower-third:4` serves on `127.0.0.1:4400`, with flags for locality,
tier and reference so a client developer can reach every refusal path. Verified
listening, and verified refusing port 4200 with the burned-port reason.

### One real defect, found by its symptom

The first `serve()` printed and continued on *every* accept error. On Windows,
Winsock deinitialises when `main` returns, so the detached listener thread hit
a permanent error and spun, flooding stderr with the same line. The bug is not
Windows-specific: any persistent accept failure would burn a core forever. Now
transient errors (interrupted, aborted, reset, timed out) are retried and
anything else stops the listener (invariant 50).

### One defect in the report itself

With four peers in one run, results were printed with no attribution, so
"SKIP live output refuses below T0" could not be traced to the peer that
skipped it — and I misread the output myself before noticing. `Result_` now
carries the peer, and the report groups by peer then plane.

The codegen guard also did its job unprompted: adding `Refusal::TransportFailed`
made `Refusal.ts` stale and `npm run check` refused to pass until it was
regenerated.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **108 passed, 0 failed** |
| `cargo clippy --workspace --all-targets` | Clean |
| `cargo run -p gx-conformance` | **77 passed, 0 failed, 7 skipped**, exit 0 |
| — of which over a real socket | 11 passed, 1 skipped |
| `node --test` | 7 passed |
| `npx tsc --build` | Clean, 4 projects |
| `gx-mock-engine` serving | Bound and listening on 127.0.0.1:4400 |
| `gx-mock-engine --port 4200` | Refused, exit 1, burned-port reason |
| `npm run check` | **exit 0** |

### Still not done, and not claimed

- **This is loopback TCP, not a named pipe.** ADR-001 specifies a pipe or Unix
  socket at L0. A pipe can carry an OS-level peer identity; loopback TCP
  cannot. Recorded as a gap, not dressed up. What TCP buys is one code path on
  Windows and Unix.
- No reconnect, no reconciliation by revision and epoch. A gap closes the
  connection and nothing dials back.
- **No asset or media transport.** Those planes are still in-process only.
- No token authentication implemented: the bind policy *requires* a token off
  loopback, and nothing yet verifies one on a connection.
- No engine host supervision, no WAL, no renderer, no shell.
- Nothing has rendered a frame.

## 2026-09-10 — ADR-001 and ADR-002 implemented

All six action items across the two ADRs. Every file new; nothing ported from
1.x.

### ADR-001 — four transport planes

**Action 1, plane boundaries in the contracts.** Each plane's failure semantics
are now executable rather than described:

- Control (`Shared/control-plane`, five new modules): `SequenceTracker`
  classifies arriving messages as Accepted / Duplicate / Gap, with **sequence
  handling ordered before deduplication** — the check order *is* the rule, and
  a test proves the retransmission that fills a gap is processed rather than
  discarded. `MessageId::is_reply()` matches the `reply.` prefix, so a reply
  kind nobody enumerated is still recognised.
- Asset (`transfer.rs`): resume-by-chunk, out-of-order chunks refused rather
  than buffered, and **completion separated from verification** — a complete
  transfer is not promotable until `verify` succeeds, and a hash mismatch
  poisons it permanently.
- Media (`slot.rs`): `LatestFrameSlot` holds exactly one frame. `publish`
  returns unit and cannot fail, so a producer has no error path to block on —
  invariant 14 holds by construction, not by review.
- Timing: represented by its *absence*. There is no timing crate, and the
  conformance suite serialises every control request to assert none carries a
  timestamp.

**Action 2, locality in the capability exchange.** `EngineCapability` declares
locality, device tier, clock source, reference state, epoch and the derived
`live_allowed`.

**Action 3, one conformance test per plane.** `conformance` is now a library of
suites generic over `EnginePeer`, plus a runner. It reports PASS / FAIL /
**SKIP**, and a skip is never counted as coverage.

### ADR-002 — clock authority on the render node

**Action 1, intent form.** `TakeAt` is `NextOpportunity | Frame(n)` with no
`Now` variant, and cue and clear take the same form. `resolve_intent` is the
single implementation of the resolution rule, shared by the engine clock and
every mock (invariant 46). A frame that has passed or falls inside the lead is
refused as `FrameNotReachable { requested, earliest }` rather than fired late.

**Action 2, reference lock in status.** `EngineStatus` carries clock, reference,
tier and a `Degradation` list. `ReferenceMonitor` implements the ADR's revisit
note: losing lock **holds the cadence** in use at that moment, reports
`ReferenceLost { was }`, and refuses new live configuration. Regaining lock
clears the hold.

**Action 3, free-run surfaced.** `clock_summary` decides severity and wording
once on the engine side. `Playout/src/clock-display.ts` maps severity to a
required *prominence*: Nominal may be quiet, Warning is persistent, Critical
blocks. Free-run is a Warning, so it can never be rendered quietly.

`ProgramClock` (`services/render-engine/worker/src/clock.rs`) is the first real
code in the worker. `offset_nanos(n)` is a pure function of the frame number in
`u128`, so deadlines cannot compound error.

### One wrong claim, corrected by a failing test

The first version of the drift test asserted that accumulating the frame
interval in `f64` drifts measurably across an 8-hour soak. It does not: the
test failed, reporting 89 ns. Measured properly, the real costs at 29.97 over
863,136 frames are:

| Approach | Drift over 8 hours |
|---|---|
| Rate stored as rounded `29.97` | 28.8 ms — 0.86 of a frame |
| `f32` accumulation | 117 s — 3,513 frames |
| `f64` accumulation of `1001/30000` | 89 ns — negligible |

So the hazard invariant 12 guards against is **rounding the rate**, not
floating point as such. The module doc and three tests now say that, and the
`f64` case is recorded as the negligible one it is.

### Two design corrections found by the compiler and the suite

- `MediaCodec` moved from `gx-control-plane` to `gx-contracts`. The control
  plane offers the codec set and the media plane negotiates from it, so leaving
  it in either one coupled two planes ADR-001 keeps independent.
- The conformance suite skipped "live output refuses below T0" against both
  mock peers, because both were T0. A check that always skips is not a check
  (invariant 47), so the runner now includes a T2 peer and the check passes on
  it.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **86 passed, 0 failed** |
| `cargo clippy --workspace --all-targets` | Clean, no warnings |
| `cargo fmt --all` | Applied |
| `node --test` (Playout clock display) | **7 passed, 0 failed** |
| `cargo run -p gx-conformance` | **66 passed, 0 failed, 6 skipped**, exit 0 |
| `npx tsc --build` | Clean, 4 projects |
| codegen | 37 contract types, one copy each |
| `npm run check` | **exit 0** |

The six skips, each named in the report: two peers are T0 so the sub-T0 refusal
skips on them; a co-located peer has no encode to adapt; two peers are not
locked so lock-loss skips on them; there is no asset endpoint on the control
peer; and hardware reference lock is an external gate.

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/control-plane` | **Partial** — intent, sequencing, status, capability and the message surface, all tested in-process; no transport |
| `Shared/asset-plane`, `media-plane` | **Partial** — plane semantics tested; no transport, no encoder |
| `mocks/mock-engine` | **Implemented** as a peer — in-process, deterministic, no transport |
| `conformance` | **Implemented** — 66 checks across four planes, 6 named skips |
| `services/render-engine/worker` | **Partial** — `ProgramClock` only; no GPU, no rasterizer |
| `services/render-engine/host` | **Planned** — stub, exits 78 |
| `Playout` | **Partial** — clock-display logic tested; no shell |
| `Editor`, `services/schema-mcp` | **Planned** — type-level only |

### Still not done, and not claimed

- **No transport.** Every plane's semantics are implemented and tested
  in-process; nothing crosses a socket, pipe or wire. ADR-001's four transports
  do not exist.
- No engine host supervision, no WAL, no journal, no restore.
- No renderer. `rasterizer_status()` returns `NotImplemented`.
- No Playout or Editor shell. `clock-display.ts` is tested logic with no UI
  rendering it, so "unmissable" is enforced in the model and not yet on screen.
- No pixel gate, no baseline snapshot.
- Nothing has rendered a frame or reached an output.

## 2026-09-10 — M1 skeleton and basic setup on a clean branch

First commit on `GrapiX-2.0`, an orphan branch with no ancestry to 1.x. The
architecture comes from `docs/adr/0001-distributed-architecture.md`, carried in
as given; the invariants were distilled from the 1.x tree so 2.0 does not
re-earn faults that were already paid for once.

**Structure.** One Cargo workspace, one lockfile, eleven crates (invariant 24).
npm workspaces for the four TypeScript packages. Four contract packages, one
per plane, with no plane depending on another.

**Contracts, written to make invariants unbreakable rather than documented:**

- `RationalRate` has no `f64` constructor. 29.97 is 30000/1001, and a test
  asserts the float form is *not* equal to 29.97 (invariant 12).
- `TakeAt` has no `Now` variant, and a test matches it exhaustively so adding
  one stops the build (invariant 8).
- `Refusal` is a tagged enum where every variant names its failing condition
  (invariant 17). `UnsupportedBlendMode` carries the mode, so the `overlay`
  aliasing to `screen` that 1.x shipped cannot recur silently.
- `live_allowed()` in `gx-control-plane` is the single place ADR-005's three
  conditions are evaluated, so tier, platform and reference-lock cannot drift
  between engine, API and UI (invariant 20).
- `negotiate()` in `gx-media-plane` is the single implementation of ADR-004's
  L0/L1 table, which is what makes M4's relocation a deployment change
  (invariant 16).
- `is_syntactically_safe()` in `gx-asset-plane` rejects traversal, absolute and
  drive-letter paths, and carries a test documenting that it is the *first* of
  two gates — a syntax check cannot see a symlink (invariant 42).

**One design correction during the work.** `MediaCodec` was first declared in
`gx-control-plane`, because the capability exchange offers the set. That forced
`gx-media-plane` to depend on `gx-control-plane` — a plane-to-plane dependency,
which contradicts the independent failure semantics in ADR-001. Moved to
`gx-contracts`, which both planes already depend on.

**One real fault found and fixed.** `#[ts(export)]` on the contract types made
ts-rs export bindings during `cargo test`, into a per-crate `bindings/`
directory. The result was four copies of `MediaCodec.ts` and two of
`ContentHash.ts` — precisely the mirroring drift ADR-003 exists to end, arriving
by a different route. Removed the attribute; `gx-contract-codegen` is now the
only generator (invariant 27), writing one copy of each type plus a barrel
`index.ts`.

**Guards.** `tools/check-boundaries.mjs` fails on a cross-domain dependency and
on a hand-authored file in generated output. `tools/codegen-check.mjs` fails if
the committed generated output differs from a fresh run. Both were
negative-tested: a Shared-imports-Editor line, a hand-written file in
`generated-ts/src`, and a doctored `Locality.ts` were each caught, and the tree
restored clean afterwards.

### Verified by execution

| What | Result |
|---|---|
| `cargo check --workspace --all-targets` | Clean, 11 crates |
| `cargo test --workspace` | **29 passed, 0 failed** |
| `cargo fmt --all` | Applied |
| `cargo run -p gx-contract-codegen` | 21 contract types + barrel into one directory |
| `npm install` | Clean, 4 workspace packages linked |
| `npx tsc --build` | Clean, 4 projects |
| `node tools/check-boundaries.mjs` | OK, and caught 2 injected violations |
| `node tools/codegen-check.mjs` | OK (22 files), and caught 1 injected staleness |

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/contracts`, `control-plane`, `asset-plane`, `media-plane` | **Partial** — the types and decision functions in this entry exist and are tested; no transport, no serialisation over a wire |
| `Shared/generated-ts` | **Implemented** — generated, current, checked |
| `tools/contract-codegen`, both guards | **Implemented** — run, and negative-tested |
| `services/render-engine/host`, `worker` | **Planned** — stub, exits 78 |
| `mocks/*`, `conformance` | **Planned** — stubs, exit 78 |
| `services/schema-mcp` | **Planned** — declares read-only capability, no server |
| `Editor`, `Playout` | **Planned** — type-level entry points only, no Tauri shell |

### Not done, and not claimed

- No mock peer behaves like a peer. They exit 78.
- No conformance suite. The merge gate in invariant 26 has nothing behind it.
- No pixel gate, and no baseline snapshot. M1 requires the baseline be captured
  **before** anything changes, and nothing has been captured.
- The `overlay` blend-mode fix is expressible in the refusal type but is not
  implemented, because there is no renderer.
- No Tauri scaffold in either product.
- Nothing has been rendered, transported, published or taken.
