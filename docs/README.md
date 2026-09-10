# GrapiX 2.0 documentation

## Authority order

When two documents disagree, the one higher in this list wins. Fix the lower
one; do not leave the disagreement in place. The previous tree had two
documents disputing how many contract packages existed, and ADR-003 records
that as a real cost.

1. **`adr/0001-distributed-architecture.md`** — the ADRs and system design.
   Canonical for transport planes, clock authority, contract strategy, media
   negotiation and `is_live` gating.
2. **`adr/0002-platform-and-mcp-schema.md`** — accepted final draft, 10
   September 2026. Canonical for the platform matrix, colour management, DPI,
   filename handling, resolution and rate policy, the MCP tool surface and
   scopes, the UI research plan, and the design-system and motion-library
   handoff. Its **Part E is the definition of done for the platform layer**:
   22 numbered items, and the checklist any claim of completeness is measured
   against. Part G supersedes the standalone design-system handoff of 9
   September; do not work from that copy.

   Where 0002 and 0001 touch the same ground they agree. If they ever do not,
   0001 wins on runtime architecture and 0002 wins on platform, tooling and
   authoring-time concerns — and the disagreement gets fixed rather than
   left standing.
3. **`invariants.md`** — the operative rules. Binding on every change. Carries
   rationale by reference, never by copy.
4. **Crate and package `README.md`** — ownership and boundary of one unit.
5. **Code.**

`/memory.md` at the repository root is the session log: what changed, when, and
what was verified. It records history; it does not grant authority.

## Status vocabulary

Used verbatim from the ADR. Nothing may be described in any other terms.

| Term | Meaning |
|---|---|
| **Implemented** | Built, and verified by execution |
| **Partial** | Built, with named gaps |
| **Planned** | Decided, not built |
| **External gate** | Blocked on hardware, vendor SDK or lab time |
| **Not present** | Not built, and not currently decided |

Everything in GrapiX 2.0 is **Planned** until a memory.md entry records
execution evidence. The skeleton is not an implementation.
