# GrapiX Object Inspector — council plan

**Status:** **P0–P3 implemented (2026-08-08). P4–P5 are Plan.** Council consensus, 2026-08-08, after one
adversarial round.
**Scope:** The Editor's Object Inspector — `Editor/apps/editor-web/src/components/Inspector.tsx`,
`ObjectTypeProperties.tsx`, `inspectorFields.tsx`, `TextFontControls.tsx`, `PropertiesSidebar.tsx`,
`MaterialsTab.tsx`, and the tab host `modules/object-inspector/{components,services}` — plus the
Editor state it owns. Where this plan appears to disagree with `docs/architecture.md`, the
`SceneDocument` contract, or the renderers' actual behaviour, **they win**.

> Companion to [`docs/object-manager-plan.md`](object-manager-plan.md), whose P0–P4 shipped on
> 2026-08-08. That panel **lists** objects; this one **edits** them. The two must not grow two
> conventions for the same act.

---

## 0. How this plan was made

The lead assembled a verified evidence brief — every schema member of all 13 object types extracted
mechanically from `Shared/shared-types/src/index.ts`, then cross-referenced against every write in the
Inspector surface — and convened five seats on it: **SchemaTruth** (per-type completeness),
**RendererParity** (does anything honour it), **AuthoringUx** (how it is used), **BindingsAnimation**
(static vs keyframed vs bound), **MaterialsFaces** (slots, faces, instances).

**Three seats refuted the lead's brief, and the corrections are now the plan's basis.** The lead
re-verified each against source before accepting it:

| The brief claimed | The truth | Verified by |
| --- | --- | --- |
| The Inspector offers editable controls for 11 typed effect types | Typed `effects` has **no editor at all**; the editable effect controls are `importedDesign.effects` **metadata** | `grep addObjectEffect\|updateObjectEffect\|object\.effects` → no matches; `Inspector.tsx:677-685` reads `metadata.effects` |
| `shape.compoundPaths` is read-only because subpaths are not drawn | Preview **draws** every subpath; the panel's note saying otherwise is stale | `GpuSceneRenderer.ts:764` calls `compoundGraphicsPath(object)` |
| `shape.pathAnimation` is read-only | It is fully editable | `ObjectTypeProperties.tsx:166-185`, `editorStore.ts:1015-1056` |
| `fillRule` — both renderers fill non-zero (per the panel's own note) | `evenodd` is **Program-only**: Rust branches on it, Preview never reads `fillRule` | `services/render-daemon/src/scene/mesh_prepare.rs:1366`; `grep -c fillRule GpuSceneRenderer.ts` → **0** |

That last one matters beyond itself: a `ParityNote` was **confidently wrong in the operator's
favour**, which is worse than no note. Parity claims are now only admissible with a renderer
file:line.

---

## 1. Decision summary

1. **The panel's first job is to stop lying, and that is P0.** Eleven controls are dishonest today:
   they accept a value nothing consumes, resize something that ignores the size, or explain a parity
   gap incorrectly. Every one is deleted, disabled, or corrected before a single capability is added.
2. **A twelve-object selection silently edits one object.** The Object Manager shipped a first-class
   multi-selection; the Inspector never learned about it. This is the worst operator defect in the
   panel and it is P1.
3. **A mixed value must read as `Mixed`, never as the active object's value.** Anything else invents
   data the author did not type.
4. **One editing grammar across both panels.** Scrub with Shift for fine control, one history entry
   per gesture, Enter commits, Escape reverts, and clamping at the mutation boundary — not as an HTML
   `min` hint the store ignores.
5. **A property has three possible sources — static, keyframed, bound — and exactly one wins.** Today
   a binding overrides a keyframe at render time while the field displays the keyframe. One shared
   resolver reports which is in force, and the field says so.
6. **The Inspector enables a channel; the Timeline owns keys.** No key dragging, easing or tangents
   here. No second keyframe editor.
7. **`zIndex` stays out.** Stack order is the Object Manager's drag gesture (its plan, P2). A numeric
   z-index field would be a second, worse ordering model. Two seats independently agreed.
8. **Per-face material binding already exists** in the Materials tab and works, including imported
   glTF elements. The defects are the duplicate "Main Material" quick field in the type tab and an
   assigned **instance** masquerading as its base material.
9. **The Object Manager's one-tab-stop treegrid rule does NOT transfer.** That rule belongs to a grid
   of cells. A form must expose its fields to Tab. What transfers is panel scoping, field-owned
   drafts, and conditional focus restoration — not `reduceObjectManagerKey`.
10. **Nothing becomes authorable ahead of a renderer.** `textCase` stays non-editable until Program
    implements it, however tempting an eight-line select is.

---

## 2. Findings ledger

Severity: **A** = the panel states something untrue about the scene or the renderers; **B** = a real
capability an operator cannot reach; **C** = inconsistency or friction.

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | A | ~~A selection of twelve edits one object with no count, scope cue or warning.~~ **Closed by P1.** | `Inspector.tsx:36-45`, `ObjectInspector.tsx:23-31` read `selectedObjectId`; the set lives at `editorStore.ts:143-150` |
| F2 | A | **W/H are offered for `line`, `shape` and `paint`, whose draw paths never read them.** Resizing produces no visible change. | `Inspector.tsx:23-25,154-158`; `drawLine:602`, `drawShape:747`, `drawPaint:795` use `object.width/height` **0 times** |
| F3 | A | **`importedDesign.effects` gives enabled opacity/radius/spread/colour inputs for effects no renderer draws.** | `Inspector.tsx:709-725`; `IMPLEMENTED_OBJECT_EFFECTS = Object.freeze([])` at `index.ts:1947` |
| F4 | A | **Typed `effects` has no editor, and `validateSceneEffects` is never surfaced** — the audit written for exactly this purpose has no consumer. | `grep validateSceneEffects Editor/apps/editor-web/src` → nothing; audit at `index.ts:2234` |
| F5 | A | **The `fillRule` note is factually wrong**: it says both renderers fill non-zero; `evenodd` is Program-only and Preview ignores the field. | `ObjectTypeProperties.tsx:259-265` vs `mesh_prepare.rs:1366` and `grep -c fillRule GpuSceneRenderer.ts` → 0 |
| F6 | A | ~~enabled five-value select~~ **Corrected while implementing P0: the select was already `disabled`.** The real defect was that it gave no reason of its own — neither renderer reads a paint layer blend, and only a generic "paint is Editor-only" note stood nearby. | `ObjectTypeProperties.tsx:365-372`; `GpuSceneRenderer.ts:795-831`; `document.rs:429-447` |
| F7 | A | **`text.paragraphSpacing` is enabled and consumed by neither renderer**, while its neighbours `textIndent` and `overflow` are correctly disabled. | `Inspector.tsx:410-411` vs `:433-451` |
| F8 | A | **`marker.eventName` is writable and nothing subscribes to it.** | `ObjectTypeProperties.tsx:494-505`; only other `eventName` use is `AutomationPanel`'s own trigger names |
| F9 | A | **A camera button says "program camera" while calling `setActiveCameraId`** — an authoring control claiming Program authority the Editor does not have. | `Inspector.tsx:538-548` |
| F10 | A | **Camera `near`/`far`/`up` and `light.castShadow` are Preview-only with no disclosure**; Program treats camera as unsupported. | `ThreeSceneLayer.ts:350-385,150-152`; `document.rs:429-447` |
| F11 | A | **`text.direction`, `wordSpacing`, and writing-mode's `vertical-rl` vs `vertical-lr` are Preview-only, undisclosed.** | `GpuSceneRenderer.ts:965,1037,1023-1037`; `document.rs:869-955,951-955` |
| F12 | A | **A binding overrides a keyframe at render time while the field shows the keyframed number.** | channels applied at `index.ts:1295-1301`, bindings after, at `sceneMaterial.ts:34-38`; field samples only the channel at `Inspector.tsx:880-887` |
| F13 | A | **A `scaleZ` binding on a `layer`/`group` is advertised and cannot work** — two independent reasons: `assignBoundValue` writes `scaleZ` for meshes only, and bindings are applied *after* hierarchy inheritance. | `objectPropertySupport.ts:57-59` vs `index.ts:4545-4552` and `sceneMaterial.ts:34-38` |
| F14 | A | **`paint` is offered as a material surface**; paint strokes draw from `stroke.color` and never consume a material. | `Inspector.tsx:20-22`; `sceneMaterial.ts:77-80`; `GpuSceneRenderer.ts:795-829` |
| F15 | A | **An assigned material *instance* is displayed as its base material**, so choosing the displayed name silently discards the instance. | slot shape at `index.ts:430-453`; `MaterialsTab.tsx:65-105` reduces to `materialId` |
| F16 | A | **Numeric fields never enforce the range the renderers clamp**, so the saved, shown and rendered values disagree. Units are unstated almost everywhere. | `inspectorFields.tsx:30-50` passes `Number(...)` through; clamps at `ThreeSceneLayer.ts:352-364,411-452`, `slabGeometry.ts:42-60` |
| F17 | B | **`shape.compoundPaths` renders but cannot be edited** — no subpath can be selected, added, removed or reordered. | `GpuSceneRenderer.ts:764`; `ObjectTypeProperties.tsx:188-190` shows a count |
| F18 | B | **`mesh.meshKind` cannot be changed after creation**, though the renderer picks geometry from it dynamically. Deleting and recreating is the only route. | `grep meshKind` → creation at `editorStore.ts:3047-3061`, read-only at `ObjectTypeProperties.tsx:543-558`; `ThreeSceneLayer.ts:547-574` switches on it |
| F19 | B | **A data binding path is accepted verbatim** — no validation, and a missing path or a type mismatch is invisible in the authoring surface. | `PropertiesSidebar.tsx:90-100`; `resolveDataPath` returns `undefined` silently at `index.ts:3084-3107` |
| F20 | B | **`text.textCase` is honoured by Preview and authorable nowhere** — only an importer can set it. | `GpuSceneRenderer.ts:965`, `textPresentation.ts:20`; `grep textCase` finds no UI |
| F21 | C | **The Inspector's numeric convention diverges from the Object Manager's for the same properties**: no scrub, no Shift-fine, and a history entry per keystroke rather than per gesture. | `Inspector.tsx:862-937`, `inspectorFields.tsx:30-52` vs `ObjectManager.tsx:1803-1866` |
| F22 | C | **Enter/Escape have no defined meaning in Inspector numeric fields**, and a rejected rename still uses `window.alert` — the pattern the Object Manager removed in its P3. | `Inspector.tsx:114-120,825-857` vs `ObjectManager.tsx:1535-1559` |
| F23 | C | **"Main Material" in the type tab duplicates the Materials tab's `main` face**, giving one relationship two homes. | `Inspector.tsx:122-135` and `MaterialsTab.tsx:92-128` |
| F24 | C | **`PropertiesSidebar`'s Text route is dead code** that duplicates the text editor and will reintroduce competing homes if mounted. | `PropertiesSidebar.tsx:45-76`; no caller outside the file |
| F25 | C | **The tab strip is plain buttons** — no `tablist`/`tab`/`tabpanel`, no arrow-key movement, no `aria-selected`. | `ObjectInspector.tsx:57-66` |
| F26 | C | **A locked object is fully editable from the Inspector**, and lock/visibility are single-object header toggles rather than selection state. | `Inspector.tsx:92-108`; `updateObject` spreads any patch at `editorStore.ts:552-561` |
| F27 | C | **Camera and light hide `rotation`/`scaleX`/`scaleY`/`opacity`** although those are animatable for every type. | `supportsDetailedTransform` at `Inspector.tsx:51,185,202` |

**Deliberately not findings.** `zIndex` absent (Object Manager owns order — F-none, by design);
W/H absent for `light`/`camera`/`marker`/`layer`/`group` (preview glyph decoration only, rule 116);
per-face mesh binding (already works, `MaterialsTab.tsx:65-143`); the five disabled texture-fit
options (correctly disabled, only their wording is thin); no per-type section for text/rect/ellipse/
light/camera/layer (their editors live in `Inspector.tsx` — a wrapper would duplicate, not add).

---

## 3. Invariants this plan may not break

1. **The Editor authors; it has no Program or output authority.** F9's wording is fixed by renaming
   the control, never by adding Program control.
2. **Never author an option no renderer honours** (rule 82). Delete it, or disable it and name the
   missing renderer. `ParityNote` (9 uses) and `ReadOnlyField` (7 uses) already exist for this.
3. **A parity claim requires a renderer file:line.** F5 is why: a confident, wrong note is worse than
   silence.
4. **One definition per rule.** `objectPropertySupport.ts` (bindable), `isPropertyAnimatable`
   (animatable), `getBindableFaces`/`isMaterialCompatibleWithFace` (material legality),
   `objectHierarchy.ts` (containment) are the definitions. No panel-local copy — that file's own
   comment records the drift that created it.
5. **TypeScript and Rust contracts move together** (rule 7); normalise new fields for old scenes
   (rule 8); `main` is material face index 0 (rule 6).
6. **The Timeline owns keys, easing and tangents.** The Inspector may enable a channel and navigate to
   the track. Nothing more.
7. **Panel-scoped keys only** (rule 4). And the treegrid one-tab-stop rule (rules 190–201) is
   **grid-specific** — a form exposes its fields.
8. **Measure before optimising.** The Object Manager's P4 assumption was falsified by measurement;
   no performance work here without a number first.

---

## 4. Phases

Effort is working days for one engineer, and a shape rather than a commitment.

| Phase | Theme | Effort |
| --- | --- | --- |
| **P0** | Stop the panel lying, and write the parity contract | **Implemented** |
| **P1** | One selection, honestly edited | **Implemented** |
| **P2** | One editing grammar | 2–3 d |
| **P3** | Which value is in force | 3–4 d |
| **P4** | Capability gaps worth closing | 3–4 d |
| **P5** | Semantics, keyboard and disclosure | 2 d |

### P0 · Stop the panel lying, and write the parity contract — **Implemented, 2026-08-08**

**Shipped as amended.** `PROPERTY_RENDERER_SUPPORT` now lives in
`Shared/shared-types/src/propertyRendererSupport.ts` and holds both the verdict and its wording, so a
note cannot contradict a support value again. The Editor reads it through one pure service,
`modules/object-inspector/services/inspectorControls.ts`, which also carries `CONTROL_MANIFEST` — the
panel's own account of every control it offers — because there is no DOM in the test runner and an audit
has to be able to see the panel somehow. Adding a control now means declaring its renderer support, or
the audit fails.

**A fifth verdict was needed and is not in the plan above.** `editor` marks authoring state — a name, a
lock — that no renderer is expected to consume. Without it, `locked` reads as a property nothing renders
and the audit demands disabling it. `neither` now means only what it should: a value that was meant to
reach the screen and does not.

**The type-level downgrade earns its keep.** Program prepares six object types
(`document.rs:435-448`), so no property of an `image`, `line`, `paint`, `camera` or `marker` reaches a
published frame. Rather than writing `preview` thirty times, the resolver derives it from that one
verified fact — which is why the camera panel now says, in the operator's words, *"Program does not
render camera objects, so nothing authored here reaches a published frame."*

**Cross-language agreement is behavioural, not a mirrored list.**
`Shared/shared-types/contracts/program-object-types.json` is read by both sides:
`services/render-daemon/tests/program_object_types.rs` feeds one object of every declared type through
`prepare_scene` and asserts that exactly the declared types avoid the "are NOT rendered" warning. A
renderer that gains or loses a type fails that test until the shared claim is updated.

**One council finding was wrong, and this is the correction.** F6 said `paint.paintBlendMode` was an
*enabled* five-value select. It was already `disabled` (`git diff` confirms no `+disabled` was added by
this phase). The real defect was narrower: disabled with no reason of its own, the surrounding note
only saying that paint is Editor-only. It is now a `ReadOnlyField` showing the stored value with the
contract's explanation beside it. A disabled control that does not explain itself is the same defect in
a quieter form, and the audit now fails on it.

**Also shipped:** W/H deleted for `line`/`shape`/`paint`; `marker.eventName` and the one-option marker
Kind select made read-only; `paragraphSpacing` disabled beside `textIndent` and `overflow`, each with
its own note; the `fillRule` note corrected to name the real split; parity notes for camera, cast
shadow, `direction` and `wordSpacing`; the camera chip reworded to "Use this camera in the Editor
preview"; imported design effects turned into read-only readouts; an imported `textCase` disclosed
read-only; `paint` removed from the material surfaces through one shared predicate now asserted against
the tab descriptors; the duplicate "Main Material" quick field removed; and the dead `TextProperties`
route deleted together with the unmounted `PropertiesSidebar` shell and the `propertiesTab` store field
it was the only reader of.

**Two stale claims in the shape panel were also false and are fixed:** the note said extra subpaths are
"preserved but not yet drawn" when `GpuSceneRenderer.ts:764` draws every one of them.

**Exit gate: all eight clauses closed, 2026-08-08.** The first pass left four of them open and said so;
they are now met.

| Clause | How it was closed |
| --- | --- |
| Table-driven audit over 13 types, nothing enabled for `neither` | `tests/inspector-parity-audit.test.ts`, derived from the contract with no parity literal in the test |
| Every non-`both` property carries a note | Same file, plus the mirror in `shared-types` |
| Paired TypeScript/Rust agreement | `tests/property-renderer-support.test.mjs` against `services/render-daemon/tests/program_object_types.rs` |
| `fillRule` note asserted against the real split | Asserted in both suites, including that it no longer says "both renderers fill" |
| **Rust `mesh_prepare` test pinning even-odd** | `even_odd_leaves_the_inner_square_unfilled_and_non_zero_does_not`: a square inside a same-winding square, asserted by **tessellated area** — non-zero fills 40,000 units², even-odd 30,000. A vertex-count comparison could have passed by coincidence; an area cannot. A second test pins the legacy fallback for an unknown rule |
| Deep preservation of the retained fields | `tests/inspector-retained-fields.test.ts`, 8 tests |
| **Imported `textCase` shown read-only and never settable** | The condition moved out of JSX into pure `importedDisclosures`, so it is provable without a DOM: reported when non-default, silent at `original` or absent, and absent from `CONTROL_MANIFEST` |
| **Live: no W/H on a line, a shape and a paint layer** | All three, on an isolated pair. A **paint layer** was drawn with the real Brush tool; a **line** arrived through the real Import Design dialog from a Figma fixture, since no tool creates one |
| **Live: imported effects read-only with the renderer named** | The same import carried a drop shadow and a layer blur. The section shows **2 effects, 7 read-only readouts, 0 editable inputs, 0 checkboxes**, "enabled in source" in place of the old Enabled toggle, and the note naming both renderers |

**Evidence.** `@grapix/editor-web` **366/366** (+27); `@grapix/shared-types` **140/140** (+9);
`cargo test --lib scene::mesh_prepare::tests` **14/14** (+2); `--test program_object_types` 2/2; repo
`typecheck` and `check:boundaries` clean. Live on an isolated pair (4111 + 5199, data root and fixture
deleted after): a Shape's, a Line's and a Paint layer's Transform tabs have **no W/H** while a Quad's and
a Text's still do; Paint and Line show **no Materials tab** at all; the shape panel states *"Program
tessellates even-odd fills; Preview ignores the rule"*; Text shows `Paragraph space`, `First-line indent`
and `Overflow` disabled with one note each; the camera panel carries its Program note with **no "program
camera" wording** anywhere in its markup; the light panel names the shadow gap; and the paint panel's
layer blend is a read-only readout with its own reason.

**Still not seen on screen:** the marker event readout. No tool or importer in the app creates a
`marker` object, so there is nothing to select. It is covered headlessly — the audit proves no control is
offered and the preservation test proves the value survives — and that is the honest limit of what has
been checked.

### P0 as planned — 3–4 d

**Work.** Every A-severity finding that is a deletion, a disable, or a correction. No new capability.

- **Delete** W/H for `line`, `shape`, `paint` from `DIMENSION_OBJECT_TYPES` (F2). If the mask
  fallback rectangle genuinely needs the envelope, show it as a computed `ReadOnlyField`, never as a
  resize control.
- **Delete** `marker.eventName`'s writable field (F8) and `paint.paintBlendMode`'s select (F6);
  retain the stored values for round-trip, edit neither.
- **Disable** `text.paragraphSpacing` and extend the existing flow note to name it beside `textIndent`
  and `overflow` (F7).
- **Correct** the `fillRule` note to state the real split — Preview lacks `evenodd`, Program
  implements it — and keep the value non-authorable until Preview catches up (F5).
- **Add `ParityNote`s** naming the missing renderer for camera `near`/`far`/`up`, `light.castShadow`,
  `text.direction`, `text.wordSpacing`, and writing-mode's `rl`/`lr` distinction (F10, F11). These
  stay Preview-authorable; they stop being silent.
- **Rename** the camera activation control to "Use this camera in Preview" (F9).
- **Replace** the editable `importedDesign.effects` inputs with `ReadOnlyField`s plus one note naming
  both renderers (F3), and surface typed `effects` through `validateSceneEffects` as a read-only
  audit line (F4). Consume `IMPLEMENTED_OBJECT_EFFECTS`; do not write a second list.
- **Remove `paint`** from the Inspector's material surfaces, through one shared renderer-backed
  eligibility predicate used by both `Inspector.tsx` and `objectInspectorTabs.ts` (F14). Leave
  `BaseSceneObject.materialSlots` alone — document compatibility.
- **Remove** the "Main Material" quick field (F23) and delete the dead Text route in
  `PropertiesSidebar.tsx` (F24). One home per relationship.
- Improve the five disabled texture-fit options to name the missing capability rather than "(planned)".
- **Show an imported `textCase` as a `ReadOnlyField`** with a Program-missing note (F20). Authoring
  stays deferred; an imported value that Preview *is* applying must not be invisible.
- **Write the contract the rest of this plan leans on: `PROPERTY_RENDERER_SUPPORT`.** A per-object-type,
  per-property map in `Shared/shared-types` declaring which renderers consume each property —
  `both | preview | program | neither` — mirrored in Rust and asserted from both sides, in the shape of
  the existing `IMPLEMENTED_BLEND_MODES`, `IMPLEMENTED_TEXTURE_FIT_MODES`, `IMPLEMENTED_MASK_MODES` and
  `IMPLEMENTED_OBJECT_EFFECTS`. **This is the load-bearing item in P0**, because without it every
  parity claim in this document is a literal in a test that rots the moment a renderer gains a feature.
  The adversarial round established that no such contract exists today: the only per-property rule is
  `isPropertyAnimatable` (`index.ts:480-547`), which leaves most types undecided, and
  `objectPropertySupport.ts` answers bindability, not consumption. Seed it from the parity table this
  council produced; every `ParityNote` then reads from it rather than restating it.

**Must not change.** No stored field is dropped from the wire, and no renderer changes. **Deep
preservation, not byte identity**: `normalizeScene` already writes defaults on load — `zDepth`,
`zIndex`, `layerId`, lock, scales, anchors, styles, masks, `materialSlots`, paint defaults
(`editorStore.ts:3259-3301,3353-3360`) — so a byte-identical round trip is impossible for a legacy
import whatever this phase does. The contract is that `paintBlendMode`, `eventName`, typed `effects`,
`compoundPaths` and material slots survive load → save **deep-equal**, having lost their editors but
not their values.

**Exit gate.** Headless: a table-driven test over all 13 types asserting **no enabled control exists
for a property `PROPERTY_RENDERER_SUPPORT` marks `neither`**, and that every `preview`-only property
carries a note — derived from the new contract, with no parity literal in the test; a paired
TypeScript/Rust assertion that the two sides of the contract agree; the `fillRule` note text asserted
against the real split; a Rust `mesh_prepare` test pinning `FillOptions::even_odd` for an even-odd
path; a deep-preservation test for the five retained fields above; and an imported `textCase` shown
read-only and not settable. Live: resize a line, a shape and a paint layer and confirm no W/H control
is offered; open an imported PSD object and confirm effects are read-only with the renderer named.

**Unblocks.** Everything. A panel that lies cannot be extended honestly.

### P1 · One selection, honestly edited — **Implemented, 2026-08-08**

**Shipped as specified.** Every decision lives in one pure service,
`modules/object-inspector/services/multiSelection.ts`: the summary, which properties may be batched,
whether a value is shared or mixed, and whether a lock refuses the write. A new
`modules/object-inspector/components/SelectionInspector.tsx` draws the answer, and the single-object
surface is untouched — nothing an author already knows moved.

**Eligibility is derived, not tabled.** `batchableProperties` starts from position and opacity, adds
size only where every target's geometry is drawn from its box, and unlocks transform, appearance and
type style **only for a homogeneous set** — then filters the lot through `inspectorControl`, so P0's
renderer contract governs a batch exactly as it governs one object. A rect and a mesh therefore share
only `x`, `y`, `zDepth`, `width`, `height` and `opacity`: a mesh's `rotation` is its legacy Z fallback
while a rect's is its only angle, and writing one number into two meanings is the edit that looks fine
and is not.

**`Mixed` carries no value, by type.** `BatchValue` is `{ kind: "same"; value }` or
`{ kind: "mixed"; count }` — the mixed arm has **no value field at all**, so a caller cannot render the
first target's number by accident. That is the difference between a type and a convention.

**One commit, not a loop.** `updateObjects(ids, patch, label)` was added to the store: a loop over
`updateObject` would rebuild and normalise the scene once per target and deposit an entry each unless
every caller remembered to wrap it. One commit writes every target and one Ctrl+Z takes it back.

**The lock gate refuses rather than partially writes**, and it can be opened from where it is refused:
"Unlock all" acts *on* the locked objects, since a gate with no escape hatch is a dead end.

**Two decisions the plan did not spell out.** Visibility and lock are **explicit commands**, not
tri-state toggles — with a mixed selection there is no current state to flip, and guessing one is how an
author hides the half they meant to show. And the numeric readers moved into the service as **explicit
typed accessors** rather than an index, because indexing a discriminated union needs a cast that
fabricates a shape; writing them out also puts each default in one place, so a missing `scaleX` reads 1
and a mesh's `rotationZ` falls back to its legacy `rotation` exactly as the hierarchy resolver reads it.

**Evidence.** `@grapix/editor-web` **396/396** (+30: 21 eligibility/mixed/lock, 9 batch store);
`@grapix/shared-types` 140/140; repo `typecheck` and `check:boundaries` clean. Live on an isolated pair
(4111 + 5199, data root deleted after) with **twelve quads** given distinct X and two opacities through
the Object Manager's own columns: the header reads *"Object Inspector — … — 12 Objects"*, the tabs are
Selection / Transform / Materials, the summary says "12 objects selected · 12 rect · 12 visible · 0
hidden · 0 locked"; **X reads "Mixed — 12 values" and Opacity "Mixed — 2 values"** — counting distinct
values, not objects — while Y, Z, W, H, Rotate, Scale and Stroke W show their shared numbers. Typing
`777` into the mixed X moved **all twelve**, and **one Ctrl+Z restored all twelve distinct originals**.
Locking two members then disabled **all ten** batch fields, showed *"2 locked objects must be unlocked
before this can be edited. Nothing has been changed."*, and left every value untouched; "Unlock all"
cleared it and the same write then succeeded across all twelve.

### P1 as planned — 3–4 d

**Work.** The Inspector learns about `selectedObjectIds` (F1).

- One object: today's surface, unchanged.
- More than one: the leading tab becomes **Selection** — "12 objects selected", type counts, and
  visible/hidden/locked counts — before any editor.
- **Eligibility**: a field appears only when *every* selected object has that property, the renderers
  honour it for each, and the write means the same thing for all. Derived from the existing support
  definitions in a new pure `modules/object-inspector/services/` module. **No second capability
  table.**
- **Mixed** is a first-class state: numeric and text fields empty with an accessible
  "Mixed — N values", selects showing a non-domain Mixed entry, booleans `indeterminate` with
  `aria-checked="mixed"`. No write until the author supplies a value; then **one** history entry
  writes every eligible target.
- Never batch: text content, image `src`, names, paths/points/strokes, anchors, asset selection,
  container children, camera activation, masks, effects, bindings, keyframes.
- Lock is a gate, not a surprise (F26): a batch containing locked targets is refused with the count
  and a way to unlock, never applied to the subset. Visibility and lock become batch commands.

**Must not change.** Single-selection behaviour. The selection reducer in `store/objectSelection.ts`
stays the only definition of what a selection is.

**Exit gate.** Headless: twelve mixed rects; a rect+mesh set; heterogeneous booleans; a homogeneous
text-style set; a set with two locked members — asserting the exact offered field set, that a mixed
field never shows the active object's value, the written target ids, and **exactly one** history entry
per batch, with **no partial write** when a lock refuses. Live: select twelve objects with different X
and opacity, confirm the header count and every field reading Mixed, set X once, watch all twelve
move, and undo all twelve with one Ctrl+Z.

### P2 · One editing grammar — 2–3 d

**Work.** Extract the Object Manager's numeric gesture — scrub, Shift-fine, `beginHistory` on
focus/pointerdown, `commitHistory` on blur/scrub end, pointer capture — into a shared behaviour used
by both panels (F21). Enter commits, Escape reverts to the pre-edit snapshot, Escape on a mixed field
restores Mixed, and the `window.alert` rename path is replaced by the inline-validation pattern P3 of
the other plan already shipped (F22). Clamp **at the mutation boundary**, from one shared constraint
table mirrored in Rust where the wire owns it, and put units in the labels (F16).

**Must not change.** The Object Manager's shipped behaviour — this is an extraction, and its 339 tests
must stay green. Keyframe semantics stay single-object.

**Exit gate.** Headless: Shift-scrub yields one-tenth the delta; twelve updates in one gesture make
one history entry; Enter commits, Escape restores; `NaN`, negatives, cone > 179, zoom > 100, inverted
near/far and over-extrusion bevels all save the value the renderer would clamp to. Live: scrub X in
both panels and measure equal deltas and one undo each.

**Shipped as specified — 2026-08-08.** The gesture is one pure reducer plus one hook,
`src/lib/numericGesture.ts`, and both panels call it: the Object Manager's grid cells were cut over as
an extraction (its suite stayed green throughout), and the Inspector's fields had none of it before —
no scrub, no Shift-fine, and one history entry per keystroke.

Two things the plan did not say, found by measuring rather than reading:

- **A step is a property of the property.** Both panels decided their own — the grid with an inline
  `column.startsWith("scale") ? 0.01 : 0.1`, the Inspector's animated field with `props.step ?? 1` and
  `step={0.05}` at six call sites. Measured live before the fix: the same 27-pixel drag on `x` moved the
  object **2.7px in the Object Manager and 27px in the Inspector**. `propertyStep` in the shared table
  is now the only answer, and twenty-one Inspector controls read their range, step and unit from it
  through one `ConstrainedNumberField` instead of restating them — which is also why `W` showed no unit
  beside an `X (px)`.
- **Escape cannot revert by writing a number.** The first implementation restored the value the field
  displayed. A mixed field displays none, so reverting would have written the active object's value onto
  the whole selection — the invented data the mixed field exists to prevent, arriving through the abandon
  path. It now calls the store's `cancelHistory`, which restores the scene the transaction opened on: a
  batch reverts in full, and a mixed field is mixed again because no write survives.

Two relationship clamps were missing rather than wrong. `clampPatch` took the object's *type*, so it
could not consult the other half of a pair: its comment claimed the camera planes were enforced while
the branch it guarded returned its input unchanged, and the slab bevels were never clamped at all — a
500-unit bevel depth on a 100-deep slab saved 500, showed 500 and drew 50. It takes the object now, and
`normalizeSlabBevels` is transcribed from `slabGeometry.ts:50-66` including the detail that each depth
is capped at the extrusion **before** the pair is scaled, so a bevel deeper than the whole slab loses
its proportion. The store agrees with that rather than inventing a nicer answer the picture contradicts.

**Evidence.** `@grapix/editor-web` **427/427** (+31), `@grapix/shared-types` **170/170** (+30),
`cargo test --test renderer_clamps` **5/5** cross-language against
`Shared/shared-types/contracts/renderer-clamps.json`, `typecheck` and `check:boundaries` clean. Live on
an isolated pair: a 27px drag on `x` moved **2.7 in both panels** and **0.27 with Shift in both**;
`W (px)` steps like `X (px)`; one Ctrl+Z restored a ten-write scrub and a three-keystroke typed value in
each panel; Escape restored an abandoned edit; and on a three-object selection, typing into the mixed
`X` then pressing Escape left **100, 200, 300** untouched with the field reading `Mixed — 3 values`
again. The spot light's controls read `Cone (°)` 1–179 and `Penumbra` 0–1 — the bounds
`document.rs:1079-1082` clamps to.

**Not verified live:** the slab bevel clamp. The Insert menu creates a Quad, not a slab, and no UI route
builds one, so it is covered headlessly only — eight store tests through the real write path plus seven
on the pure function. Same limit as P0's marker: proven, not seen.

### P2 as planned — 2–3 d

**Unblocks.** Every numeric field an author touches now behaves the same way and cannot save a number
the renderer refuses, which is what P3's "which value is in force" readout is built on top of.

### P3 · Which value is in force — 3–4 d

**Work.** One shared, non-mutating resolver reporting `static | keyframed | bound | binding-missing |
binding-type-mismatch` for a property, built from the existing `resolveDataPath`, assignment rules and
`isPropertyAnimatable`. Every applicable field shows it (F12), and the Data Binding rows show each
path's live resolution instead of a raw JSON dump (F19).

Then **resolve F13 rather than leaving a mixed contract**: either apply bindings before hierarchy
resolution so a bound container transform reaches its children — in both renderers, in one commit —
or remove the container rows from `BINDABLE_PROPERTIES`. The declared intent says the former; a paired
Preview/Program test decides whether it can land in this pass, and if it cannot, the row goes.

Reconcile the animatable set with the editable surface (F27): a property that is animatable and
applicable gets a stopwatch; one that is not gets neither. Encode the answer only in
`isPropertyAnimatable`.

**Must not change.** The Timeline keeps keys, easing and tangents; the Inspector may link to a track.
Multi-object stopwatches stay out of scope.

**Exit gate.** Headless: a valid `x` binding over a sampled `x` channel reports `bound` with the
resolved value; a missing path reports `binding-missing` with the correct fallback; a string bound to
numeric `x` reports `binding-type-mismatch`; a layer/group binding either moves a mesh child (fix) or
does not appear (removal) — no third outcome. Live: a field visibly states "Bound: data.path" rather
than an unqualified number.

**Shipped as specified — 2026-08-08.** The resolver is `Shared/shared-types/src/propertySource.ts`, pure
and non-mutating, and it decides in the order the renderer applies things rather than in the order the
panel used to read them. Preview prepares a scene as **channels, then hierarchy, then bindings**
(`sceneMaterial.ts:35-38`), so a binding overwrites a sampled keyframe — the field that sampled only the
channel was showing a number nothing drew.

**The fact that reframed the phase.** F12 describes a Preview-internal inconsistency. The larger one was
written down nowhere: **the native renderer resolves no data bindings at all.** `SceneDocumentDto` has no
`dataContext` field (`services/render-daemon/src/scene/document.rs:41-54`), nothing under
`services/render-engine/src` resolves a path, and `dataContext` is read in exactly one place in the whole
Editor. Channels *are* sampled on air (`animation.rs:70-86`). So a bound property animates in rehearsal
and holds its authored value on Program, and the resolver reports `preview` and `program` separately
because there is no single answer to "which value is in force".

**A sixth state the plan did not name.** `binding-unsupported`: the path resolves, the type is right, and
`assignBoundValue` drops the write because its guard is `object.type === "mesh"`. Without it a `scaleZ`
binding on a layer would have reported `bound` — the exact lie this phase exists to remove — so the five
states could not be honest on their own.

**F13, decided by measurement.** Both outcomes were tested rather than reasoned about. A container's
`scaleZ` set **directly** does reach its mesh child (inheritance works: the child reads 5). The same
property **bound** does not, and — the finding that settled it — *reordering the pipeline would not have
fixed it either*, because the applier never writes a container's `scaleZ` in either order. Both halves
would have to change and Program has no binding resolution to change, so the row goes. The **column**
stays: direct editing genuinely works, and one predicate answering both questions is what advertised the
inert option in the first place. `BINDABLE_PROPERTIES` moved to `@grapix/shared-types` beside the applier
that honours it.

**F27, in both directions.** The panel gated seven controls behind one `supportsDetailedTransform` flag
meaning "not a camera and not a light". It was right about six and wrong about the seventh: a light's
`opacity` scales its intensity in **both** renderers (`ThreeSceneLayer.ts:412-413`, `document.rs:1092`),
so hiding it hid a working dimmer. `rotation`/`scaleX`/`scaleY` really are read by neither, for both
kinds, and `isPropertyAnimatable` now derives from `PROPERTY_RENDERER_SUPPORT` — so the Timeline stopped
offering a camera's `scaleY` as well.

**Also repaired, because the tab could not otherwise be used.** `setDataJson`/`applyDataJson`/`dataError`
had sat in the store with **no consumer** since the editor that used them was removed, so the Data
Binding tab named paths into data nothing in the application could create, and its only feedback was a
`<pre>` dump of the empty object it was failing to find anything in.

**Evidence.** `@grapix/editor-web` **438/438** (+11), `@grapix/shared-types` **202/202** (+32),
`cargo test --test data_bindings_are_not_resolved` **4/4** pinning the Program half behaviourally,
`--lib animation` **30/30** including the animatability table, `typecheck` and `check:boundaries` clean.
A 7-type × 18-property sweep runs the real `applyBindings` and asserts the resolver said `bound` exactly
when the applier wrote, so the type and assignability tables cannot drift from the code they mirror.
Live on an isolated pair: `X (px)` read **777** disabled, stating "Bound: layout.x · Program draws 220,
which resolves no bindings"; `W (px)` read 360 with "resolves to a string, and this property needs a
number"; a bound `fill` disclosed under its own control; and the Data Binding rows read "Resolves to 777
— preview only", "Not found in the scene data. 220 is drawn instead." and the mismatch.

**Found and not fixed:** a light's and a camera's `zDepth` have a control and no channel, so a camera
dolly cannot be keyed. The mesh-path allowlist was written for 2D paint order and catches them
incidentally. Named in `KNOWN_CONTROL_WITHOUT_CHANNEL` with a test that fails when either is fixed, so
the exclusion list shrinks rather than rots. Separately, `animation.rs` has no light, camera, container
or marker branch at all — no channel of any kind reaches those on air.

### P3 as planned — 3–4 d

**Unblocks.** An author can now see which of three mechanisms owns a value and whether air agrees, which
is the prerequisite for P4 touching properties whose provenance was previously unknowable.

### P4 · Capability gaps worth closing — implemented 2026-08-10

**Work.** The B-severity findings, in order of value.

- `convertMeshKind(objectId, next)` as a store action that normalises model-only metadata, reconciles
  material slots through the existing face vocabulary, and normalises slab properties (F18).
- Subpath authoring for `shape.compoundPaths` — select, edit, add, remove, reorder — with `path`
  remaining the primary compatibility subpath, and the stale note corrected to say they render (F17).
- `MaterialsTab` becomes instance-aware: an instance is shown as itself, offered distinctly, and
  preserved on assignment, with a route to its Material Manager inspector (F15). Parameter editing
  stays in the Material Manager.

**Exit gate.** Headless: a conversion matrix from every `MeshPrimitiveKind` to every other asserting no
dangling model metadata and no invalid face slot; subpath mutations preserving vertex/tangent array
lengths; a face bound to instance B projecting B and producing the `{materialId, instanceId}` payload.
Live: convert cube → slab → model and inspect geometry and faces; edit the inner ring of an imported
"O" and watch the hole move; give two objects sharing one base material different instance tints.

**Delivered.** `MESH_PRIMITIVE_KINDS` is the shared primitive catalogue; `convertMeshKind` performs
the destructive conversion as one history entry, removes model-only metadata, keeps only faces valid
for the destination kind, and normalises Slab state. The Shape Inspector now authors every
`compoundPaths` entry after the primary compatibility path: add, select, edit, reorder and remove all
preserve the parallel vertex/tangent arrays. Material face assignment now carries
`{ materialId, instanceId }`, names the instance rather than collapsing it to its base, previews the
resolved override, and routes directly to that instance in Material Manager.

**Evidence.** `@grapix/editor-web` **480/480**, `@grapix/shared-types` **202/202**, editor typecheck,
production build and workspace boundaries pass. Targeted tests cover every primitive-to-primitive
conversion, malformed compound-path repair and all subpath mutations, and instance/base identity
validation. Live on an isolated Editor/API pair: cube → slab exposed the five Slab face groups and
Slab controls; slab → model removed them and exposed model metadata; two added subpaths reordered,
removed and accepted an `X = 44` edit as one undoable action; two objects bound to distinct instances
of `Standard Material` routed to overrides `#ff3344` and `#3366ff`.

### P5 · Semantics, keyboard and disclosure — implemented 2026-08-10

**Work.** Real `tablist`/`tab`/`tabpanel` with arrow/Home/End inside the strip, `aria-selected` and
`aria-controls` (F25). Sections named via `aria-labelledby`; advanced sections (Masks, Imported
Design) become collapsible disclosures whose state is **session-scoped** — survives a re-dock, not a
reload, matching the lifetime split the Object Manager's P3 established. Deterministic tab order
through the fields.

**Must not change.** Every visible editor stays reachable by Tab. `reduceObjectManagerKey` is **not**
reused and no second Inspector keymap reducer is created: field-local Enter/Escape own drafts, native
Tab moves between fields, and the ARIA-tabs handler owns only the strip.

**Exit gate.** Headless: labelled tablist wiring, exactly one selected tab, ordered focus, and a
remount preserving disclosure state without stealing focus. Live: tab through a text object, collapse
Masks, re-dock, confirm Masks is still collapsed and the caret did not move.

**Delivered.** `ObjectInspectorTabStrip` owns the complete ARIA tab contract: one selected tab and one
tab stop, matched tab/panel ids, horizontal arrow wrapping, Home/End, and no interception of native
Tab, Enter or Escape. Every semantic section under the Inspector is named by its heading. `Masks` and
`Imported Design` use disclosure buttons with `aria-expanded`/`aria-controls`; their collapsed ids
live only in `objectInspectorStore`, so a dock remount retains them and a reload does not. Collapsed
content is `hidden`, removing every editor inside it from native focus order without assigning
positive tab indices or introducing another keymap.

**Evidence.** Targeted semantics tests **13/13**, `@grapix/editor-web` **485/485**,
`@grapix/shared-types` **202/202**, editor typecheck, production build and workspace boundaries pass.
Live on an isolated Editor/API pair, a four-tab Text Inspector kept exactly one selected tab and tab
stop while Right/End/Home/Left selected and focused the expected tab with matching panel labels.
Native Tab then walked the visible header and fields in DOM order. Masks remained collapsed after the
Object Inspector moved from the right dock to the left; an external `Search objects` caret remained
at offset 4 with the same value and focus, and the live Inspector contained no unnamed sections.


### Deferred, deliberately

- **`textCase` authoring** (F20) until Program implements it — Preview-only authoring would diverge
  the two renderers on published text. Read-only disclosure of an imported value lands in P0.
- Native text `direction`, `wordSpacing`, `paragraphSpacing`, full writing-mode semantics; Preview
  even-odd fill; native camera and shadows; imported glTF animation tracks; an effects compositor.
  Each is paired Preview+Rust renderer work, proven by a rendered-pixel fixture, and none of it
  re-enables a control merely because a schema field exists.
- `shape` as a textured material surface — `drawShape` consumes fill and stroke only, so a Standard
  texture control there would be dishonest. Needs a renderer decision first.

---

## 5. Agreed disagreements and resolutions

| Question | Seats | Resolution |
| --- | --- | --- |
| Is `zIndex` a missing Inspector field? | SchemaTruth + AuthoringUx: no | **No.** Order is the Object Manager's drag gesture. A numeric field would be a competing model. |
| Is per-face material binding missing? | MaterialsFaces: already works | **Already works** (`MaterialsTab.tsx:65-143`). The defects are the duplicate quick field and instance masking. |
| Keep "Main Material" as a convenience? | AuthoringUx: no; MaterialsFaces: one home | **Remove.** Convenience that duplicates a relationship is dishonest IA. |
| Apply the one-tab-stop rule to the Inspector? | AuthoringUx: no | **No.** It is a grid rule. A form exposes its fields; only panel scoping and field-owned drafts transfer. |
| Fix or remove the container `scaleZ` binding? | BindingsAnimation: fix; RendererParity: possibly remove | **Decide in P3 with a paired test.** Fix if both renderers can land it together; otherwise remove the row. **Never leave the mixed contract.** |
| Are the disabled fit options a rule-82 defect? | RendererParity: no; MaterialsFaces: weak disclosure | **Not a defect.** Correctly disabled; wording improved in P0. |
| Multi-object stopwatches in the first pass? | BindingsAnimation + AuthoringUx: no | **No.** Channel/key conflict semantics are unspecified; single-object until they are. |
| Should a bound field become read-only? | BindingsAnimation: no | **No.** The static value is the documented fallback when a path is missing; hiding it would remove useful authoring. Show precedence instead. |

### Dissents recorded, not resolved

- **SchemaTruth** holds that `meshKind` is mutable configuration and its immutability is an oversight;
  no seat disputed the conversion action, but its migration risk (model metadata, face slots) is real
  and P4's exit gate is deliberately a full conversion matrix rather than a spot check.
- **RendererParity** would accept leaving Preview-only controls authorable with a note; **SchemaTruth**
  leans toward deleting more. P0 takes the note for camera/shadow/text-flow (an author genuinely uses
  them to compose in Preview) and deletion for paint blend, marker event and W/H (no use at all).

---

## 6. Final objection check

Asked of every seat: *what in this plan is still wrong?*

- **Nothing in P0 adds capability, and that is intentional.** A reviewer who wants `textCase` or an
  effects editor in the first pass is asking for the defect this panel already has.
- **P1 is the largest single behavioural change and carries the most risk** — a batch write that
  partially applies would be worse than today's silent single-object edit. Hence the exit gate demands
  *no partial write* under a lock refusal, and exactly one history entry per batch.
- **The unresolved question is F13's direction**, and the plan names both outcomes with a test that
  decides between them rather than pretending the answer is known.
- **The adversarial round returned `do not execute` on the first draft**, and three amendments are
  now folded in: P0's central gate was **unprovable** (no per-property capability contract existed, so
  the test could only hard-code the parity list it promised not to); the imported `textCase`
  disclosure was promised in the deferred section but missing from P0's work and gate; and the
  "byte-identical round trip" guarantee was **false independently of this plan**, because
  `normalizeScene` writes defaults on load. The same round confirmed the four section-0 corrections
  are source-accurate and that `beginHistory`/`commitHistory` can bracket N synchronous
  `updateObject` calls without selection reconciliation dropping a target — P1's mechanism is sound.
- **The rot risk is what `PROPERTY_RENDERER_SUPPORT` exists to answer.** The parity tables in this
  document are true as of 2026-08-08 and will rot as the renderers gain features. Every control and
  note therefore reads from that one contract, so a renderer gaining a capability makes a control legal
  by editing the contract — not by someone remembering that a disabled field in a panel is now stale.
  A plan that shipped these tables as literals in a test would have guaranteed the next parity lie.
