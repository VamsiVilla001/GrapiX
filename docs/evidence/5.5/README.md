# 5.5, done 8 November 2026 (Claude)

**Row:** Locality declared in the capability exchange (Phase 5, Needs 1.10).

**Done-when (second rewording, user decision of 8 Nov):** a conformance test
reads `EngineCapability.locality` over the wire from the real local worker and
from a LAN mock served over the loopback transport, and every consumer's media
profile comes from `gx_media_plane::negotiate` applied to that declared value;
no consumer branches on locality; the engine's offered codecs agree with it.

## Why the wording changed twice

The original done-when ("consumers adapt without code change") could not be
executed. The first rewording asked that "Playout chooses its asset path" by
locality. Reading the code showed that premise was wrong. Playout moves no
assets; the Editor publishes them. Only one asset path exists, and no product
consumer read `capability.locality` at all. Jev chose rewording to the media
profile; Laya chose keeping the wording and leaving the row open
(`wording-jev-laya.json`). The user chose the media profile, and split the
asset-path idea into its own pending row, `5.8` (ADR-001's L0 by-path handoff).

## Design, asked of both models (`design-jev-laya.json`)

| Question | Jev | Laya | Taken |
|---|---|---|---|
| Consumer API | `profile_for` checked against the offer | same | `profile_for` |
| Codec not offered | new named refusal | pick the first offered codec (confidence 0.02) | new refusal: Laya's answer is a silent substitution (invariant 18) |
| Test shape | new conformance suite over the wire | unit tests only (0.46) | conformance suite: the done-when asks for the wire |

## What was built

- `gx_media_plane::profile_for(locality, offered, role)` returns
  `negotiate(locality, role)` when the engine offers that codec, otherwise
  `Refusal::MediaCodecNotOffered { codec, locality, offered }`. This is a new
  contract variant with its code name, display text and regenerated TS, and a
  route in the conformance refusal audit.
- Conformance `locality_suite(capability, started_as)` takes the capability
  a transport client read and checks:
  - that the declared locality is the one the engine was started with;
  - that, for the interactive and the observational role,
    `profile_for(...) == Ok(negotiate(...))`.
- `run_over_transport` runs it for a co-located mock and for a new LAN mock,
  each behind `Server::bind` on loopback TCP. `run_against_real_engine` runs it
  against the spawned `gx-render-worker`.
- Boundary rule **R9** (`tools/check-boundaries.mjs`): outside the crates that
  declare, lead from or negotiate locality, and conformance, no Rust consumer
  may branch on a `Locality` variant (match arm, `==`/`!=`, `matches!`,
  `if let`). No TS consumer may compare a value to `"CoLocated"` or `"Lan"`.
  Constructing a value is a declaration and stays allowed. Both models asked
  for this gate (0.66 / 0.94). On its first run it flagged a placeholder
  capability in the transport client, which is a declaration, so the rule was
  narrowed to branches.

## Executed

- `cargo test -p gx-media-plane`: 14 pass, including
  `profile_for_follows_the_declared_locality` and
  `an_unoffered_codec_is_refused_not_substituted`.
- `cargo run -p gx-conformance`: 522 passed, 0 failed, 9 skipped. The locality
  checks pass for each of:
  - "control-transport client … engine declares CoLocated"
  - "control-transport client … engine declares Lan"
  - "real render engine, CoLocated, T0, FreeRun"

  "MediaCodecNotOffered is produced when the engine lacks the negotiated codec"
  passes as well.
- `node --test tools/tests/check-boundaries.test.mjs`: 18 pass, including the
  Rust and TS branch cases and the declaration case.
  `node tools/check-boundaries.mjs`: OK on the real tree.
- Acceptance, asked of both (`acceptance-jev-laya.json`): row done, Jev 0.77
  and Laya 0.95. Both named the no-branch clause as the weakest point before
  R9 existed.
- The full gate is recorded with the commit in `memory.md`.

## Not in this row

- ADR-001's L0 asset handoff by local path: `5.8`, pending.
- A real engine on a LAN: Phase 14 (`14.8`).
