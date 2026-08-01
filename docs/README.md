# GrapiX documentation

## Authority order

When two documents disagree, the one higher in this list wins. Nothing below the
line may be used to justify a design decision that contradicts something above
it.

1. **[`architecture.md`](architecture.md)** — the canonical product and runtime
   architecture for local V1: the three products, the non-negotiable invariants,
   the persistent Engine Host, protocol v3, Render View extensions, the failure
   and recovery model, and the V1 acceptance gates.
2. **[`local-v1-system-design.md`](local-v1-system-design.md)** — the design
   review behind that architecture: current-state findings, alternatives
   considered and rejected, the M1–M4 implementation plan, and the acceptance
   tests.
3. **[`editor-playout-workspace.md`](editor-playout-workspace.md)** — the
   workspace and migration handoff: repository ownership, the publish plane,
   rundowns, segments, operator states, and the phase log with what each move
   actually broke.

---

## Detail documents

Authoritative within their subject, subordinate to the three above.

| Document | Subject |
| --- | --- |
| [`render-engine-architecture.md`](render-engine-architecture.md) | Virtual canvas, f64→f32 precision rule, tile renderer, stage/surface/output model, protocol and frame clock |
| [`render-daemon-architecture.md`](render-daemon-architecture.md) | The render core library, the shared-shader decision, and the TypeScript↔Rust scene contract |
| [`scene-document-v1.md`](scene-document-v1.md) | The durable `SceneDocument` compatibility contract |
| [`material-system.md`](material-system.md) | Material and asset model, alpha and blend rules, Material Manager |
| [`3d-engine-architecture.md`](3d-engine-architecture.md) | 3D data model, lighting, cameras, and the animation model that replaces scalar keyframes |
| [`fonts-sequencing-automation-sdk.md`](fonts-sequencing-automation-sdk.md) | Font sources, multi-scene sequencing, transitions, triggers, and the SDK trust boundary |
| [`design-file-import.md`](design-file-import.md) | Figma/AE/design-file import and its compatibility reports |
| [`rendering-engine.md`](rendering-engine.md) | The Editor's **current** browser viewport — explicitly temporary, replaced by the native Editor Render View in M2 |
| [`pixel-parity.md`](pixel-parity.md) | How Editor, Preview and Program pixels are compared, and the tolerances |
| [`hardware-certification-template.md`](hardware-certification-template.md) | The record a hardware or vendor-output certification run must produce |

## Consolidated view and plans

These do not describe implemented capability in the present tense; they are a merged
overview and forward plans, subordinate to the three authority documents above.

| Document | What it is |
| --- | --- |
| [`main-architecture.md`](main-architecture.md) | A consolidated snapshot that merges every architecture document against the as-built codebase into one status-annotated view (Implemented / Partial / Planned / External gate). A reference, not a new canonical — `architecture.md` still wins on any conflict. |
| [`editor-ai-assistant.md`](editor-ai-assistant.md) | **Plan.** An in-Editor chat panel driving an AI model through the MCP server, via an added agent-runtime broker. Adds no product boundary and no Program/output verb. |
| [`remote-production-v2.md`](remote-production-v2.md) | **Plan (V2).** Cloud package distribution, a headless venue render engine with SDI/NDI I/O, and the operator update/verify/import-or-replace flow. Gated behind the V1 acceptance work. |

## Ledgers and history

| Document | What it is |
| --- | --- |
| [`architecture-review-compliance.md`](architecture-review-compliance.md) | Historical ledger against a 35-section external review that predates the three-product split. Kept for the review trail; the V1 gates supersede it. Its evidence table is current. |
| [`project-memory.md`](project-memory.md) | The chronological log that predates the consolidation in the repository-root [`memory.md`](../memory.md). History, not guidance — its paths are the ones that were true when each entry was written (`packages/`, `apps/`, `services/api-server`) and are deliberately left that way. |
| `GrapiX_Local_V1_System_Design.docx` | A Word export of `local-v1-system-design.md`. The markdown is the source of truth; the export is a convenience copy and will drift. |

## Rules for changing these documents

- A change that alters a product boundary, an invariant, or an acceptance gate
  belongs in `architecture.md`, with its reasoning in `local-v1-system-design.md`.
- A detail document that contradicts `architecture.md` is a bug in the detail
  document. Fix it there rather than weakening the invariant.
- Paths in prose are checked by nothing. When a directory moves, grep the whole
  `docs/` tree — the Phase 2 and Phase 3 moves each left silent stale paths
  behind, and both are recorded in `editor-playout-workspace.md` as the reason
  this rule exists.
- Do not describe an unimplemented capability in the present tense. Every
  document here uses **Implemented / Partial / Planned / External gate**, and a
  reader must be able to trust that vocabulary.
