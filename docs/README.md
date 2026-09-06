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
| [`technology-architecture.md`](technology-architecture.md) | The technology map: languages, runtimes, framework and crate versions, the process/port table, packaging, build order, protocols, and the on-disk data layout. Descriptive — `architecture.md` still decides what the products may do. |
| [`main-architecture.md`](main-architecture.md) | A consolidated snapshot that merges every architecture document against the as-built codebase into one status-annotated view (Implemented / Partial / Planned / External gate). A reference, not a new canonical — `architecture.md` still wins on any conflict. |
| [`adobe-integration.md`](adobe-integration.md) | **Partial (Adobe integration).** The Adobe MCP gateway (port 4784), its two Photoshop transports — the local UXP plugin and Adobe's Photoshop API — and SDK-derived Photoshop/After Effects object models. **AE Runtime Mode** is the planned boundary where a locally installed After Effects runtime renders; **GrapiX Native Mode** uses the wgpu renderer only for an explicit, compatibility-reported conversion. The AEP Static Inspector is not an import-fidelity or rendering claim. Editor has no Program or output verb. |
| [`remote-production-v2.md`](remote-production-v2.md) | **Plan (V2).** Cloud package distribution, a headless venue render engine with SDI/NDI I/O, and the operator update/verify/import-or-replace flow. Gated behind the V1 acceptance work. |
| [`object-manager-plan.md`](object-manager-plan.md) | **Plan (Editor UI).** The council plan for the Editor's Object Manager panel: one canonical object selection, drag reorder/reparent/re-layer, `treegrid` semantics and keyboard, and the `zDepth` authoring gate that stops a 2D depth animation playing in Preview and doing nothing on air. Adds no `SceneDocument` field and no Program/output verb. |
| [`object-inspector-plan.md`](object-inspector-plan.md) | **Plan (Editor UI).** The council plan for the Editor's Object Inspector: eleven dishonest controls deleted or disclosed, multi-selection with an explicit `Mixed` state, one editing grammar shared with the Object Manager, a visible answer to which of static/keyframed/bound is in force, and `PROPERTY_RENDERER_SUPPORT` — a per-property Preview/Program capability contract so a parity claim lives in one place instead of a test literal. Adds no Program or output verb. |
| [`object-manager-reference-ux.md`](object-manager-reference-ux.md) | **Analysis and plan (Editor UI).** Ross XPression's Object Manager and Vizrt Viz Artist's Scene Tree measured against the shipped GrapiX Object Manager: a capability matrix, the one hard disagreement (both references put the **front** of the stack at the **bottom**; GrapiX follows After Effects and puts it at the top — kept, with reasons), and six `R` phases adopting row-launched editors, colour labels, cost sorting and a per-band depth-sort mode. Confidence per claim is stated; the vendor manuals were not read directly. |
| [`direct-aep-import-plan.md`](direct-aep-import-plan.md) | **Plan (After Effects integration).** The planned AE Runtime Mode keeps rendering in a locally installed After Effects runtime; GrapiX Native Mode renders explicitly converted, compatibility-reported GrapiX scenes with wgpu. The earlier binary-reader work is retained only as AEP Static Inspector evidence, never as a claim of project-import fidelity. The plan adds no Editor Program or output verb. |
| [`ae-runtime-container-phase-plan.md`](ae-runtime-container-phase-plan.md) | **Plan (execution breakdown).** The council phase plan for the document above: seven tracks in eight milestones, each phase stating its work, its must-not-change invariants, its runnable exit gate and its effort. Puts the licensing decision before engineering, makes resident AE control and non-capture RGBA-with-alpha two early killable spikes, splits the oversized §36 phases, rewrites six unfalsifiable gates, and registers every external prerequisite (licence, pinned SDK/build, NDI receiver, SDI card and mixer, reference host). |
| [`ae-runtime-licensing-decision-request.md`](ae-runtime-licensing-decision-request.md) | **Decision request (open).** Phase L0 of the phase plan above: the licensing question that gates every AE Runtime engineering phase. Describes the deployment as five separately rulable variants, states six questions to be answered yes/no, quotes every located Adobe term with its URL (General Terms, Software and Business Product Specific Terms, Developer Terms, trademark guidelines, Adobe's own network-rendering documentation), lists nine risks, records the constraints the codebase already meets, and gives rescope paths for a negative answer. Its determination block is **unsigned**; until an authorized approver signs it, L0 is open and no later phase may start. |

## Ledgers and history

| Document | What it is |
| --- | --- |
| [`ae-connector-plan-vs-code.md`](ae-connector-plan-vs-code.md) | **Analysis snapshot (2026-08-26).** The revised AE Connector plan compared section by section against the After Effects code that exists today, phase by phase, with a status per item (Built / Partial / Missing / Divergent). Records that the runtime half (Phases 7–8: supervisor, live data, cue/take/out, `ae_schedule → ae_runtime_client → ae_ring_source → ae_ingress`) is built and certified, while the Editor-side design-time connector and the entire portable publish package (Phase 6) are absent. A comparison ledger, not a plan: it sets no product boundary and adds no verb. |
| [`architecture-review-compliance.md`](architecture-review-compliance.md) | Historical ledger against a 35-section external review that predates the three-product split. Kept for the review trail; the V1 gates supersede it. Its evidence table is current. |
| [`project-memory.md`](project-memory.md) | The chronological log that predates the consolidation in the repository-root [`memory.md`](../memory.md). History, not guidance — its paths are the ones that were true when each entry was written (`packages/`, `apps/`, `services/api-server`) and are deliberately left that way. |

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
