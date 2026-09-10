# Shared

Contracts. **Not an application** (invariant 1) and cannot depend on Editor or
Playout — the dependency arrow points only inward.

| Package | Carries |
|---|---|
| `contracts` | Core types every plane shares: ids, revisions, rational rates, device tier, clock source, reference state, refusals |
| `control-plane` | protocol v3: capability, prepare, cue, take, clear, patches, output config. Ordered, acknowledged, zero loss |
| `asset-plane` | `.gpxpkg` packages, content addressing, chunked resumable transfer, preflight |
| `media-plane` | Preview and Program confidence frames. Drops, never queues |
| `generated-ts` | **Generated. Never edited by hand** (invariant 23) |

There is no `timing` package. Timing is a cable, not a software transport
(ADR-001). It appears in contracts only as *reported state* — `ClockSource` and
`ReferenceState` — never as a message that carries "when."
