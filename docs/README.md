# GrapiX 2.0 documentation

## Authority order

When two documents disagree, the one higher in this list wins. Fix the lower
one; do not leave the disagreement in place. The previous tree had two
documents disputing how many contract packages existed, and ADR-0001 §3 records
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

**Render core:** [ADR-0003 — GPU-first compositor, EffectCraft as component source](adr/0003-effectcraft-render-core.md)
records the 12 October 2026 decision: GrapiX owns a GPU-first compositor
(build-plan steps `3.15`–`3.22`), whole-core adoption of EffectCraft is
halted after the `3.14` spike, and EffectCraft components are ported with
attribution under the owning steps. It also amends ADR-0002 B.1: compositing
follows the project's working colour space. The compositor is **Partial**:
3.16 maps SceneDocument order into the engine's GPU Preview/Program compositor.
CPU-prepared vector and glyph textures bridge 3.17/3.18 at prepare only;
full-frame CPU rendering remains the headless/pixel reference. GPU drawing,
the full blend/effect set and asynchronous output remain 3.17-3.22.

**ADR numbering.** ADR files are numbered `0001`, `0002`, `0003`, and the
Data Server ADR planned by step `19.1` will be `0004`. ADR-0001 contains its
own sections headed ADR-001 to ADR-005; cite those as "ADR-0001 §3" and so
on, never as a bare "ADR-003", so a section is never mistaken for a file.

`/memory.md` at the repository root is the session log: what changed, when, and
what was verified. It records history; it does not grant authority.

`proposals/` holds merge proposals after they have been merged into
`/GrapiX-Build-Plan.md`. They are records only and grant no authority; the
build plan's rows are what count.

## Glossary

Decided by the user on 16 October 2026 (decision Q6 in
`proposals/GrapiX-Editor-UX-Direction-Review.md`). UI labels, MCP tool
descriptions and documentation use these words; step `11.66` adds a lint.

| Term | Meaning |
|---|---|
| **Scene Manager** | The Editor module that holds one Project and its Graphics (`11.64`). Used for nothing else. |
| **Project** | The saved container of independent Graphics, like an After Effects `.aep`. |
| **Graphic** | One independent piece of authored content: a `SceneDocument` with its own layers, timeline and undo history. |
| **Composition** | The Editor's viewer panel that shows the active Graphic. |
| **Layer** | An object row in a Graphic's timeline. Not an output layer. |
| **Take** | A published, immutable, hash-pinned revision of a Graphic, addressed by Take ID. |
| **Playout library** | Playout's searchable catalogue of published Graphics by Take ID (`12.2`). |
| **Page** | An operator-filled instance of a Take, saved in the Playout rundown and pinned to its revision, hash and field-schema version (`12.8`). |
| **Test fill** | The Editor's preview of declared fields with sample values (`11.27`). It is not a Page. |
| **Output channel / output layer** | Where Playout targets a Take on air (`12.10`). Never called a "Layer" alone. |

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
