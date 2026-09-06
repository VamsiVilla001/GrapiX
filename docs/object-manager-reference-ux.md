# Reference UX study — XPression Object Manager and Viz Artist Scene Tree

**Status:** **Analysis and plan. Nothing here is implemented.** 2026-08-08.
**Subject:** The Editor's Object Manager (`Editor/apps/editor-web/src/components/ObjectManager.tsx`),
whose council plan P0–P4 shipped on 2026-08-08
([`docs/object-manager-plan.md`](object-manager-plan.md)), compared against the two products the
architecture already names as references
([`docs/main-architecture.md:37`](main-architecture.md): *"the same relationship as Viz Artist / Trio /
Engine or Ross XPression Designer / Sequencer / Engine"*).

---

## 0. Sources, and how much to trust them

Everything attributed to a vendor below comes from web research grounded on `rossvideo.com`,
`rossvideo.community` and `vizrt.com`, cross-checked by asking each question two or three different
ways and keeping only answers that agreed across queries. **The primary manuals — the XPression User
Guide and the Viz Artist User Guide — were not read directly.** Every GrapiX claim, by contrast, is
cited to a file and line in this repository and was verified while writing this.

| Claim | Confidence | How to settle it properly |
| --- | --- | --- |
| XPression renders the object list **bottom-up** (bottom = in front) | **High** — two independent queries, consistent, cited to `rossvideo.com` and `rossvideo.community` | XPression User Guide, Object Manager chapter; or ten minutes in the product |
| XPression has per-Layer **Depth Sorting: Manual / Automatic** on the Object Inspector's Rendering tab | **High** — same two sources agreed | Same |
| XPression has a per-text **"Text Always on Top"** flag | Medium | Same |
| Viz Artist: **container** is the unit; geometry/material/transform appear as **icons on the row** that open their editors | **High** — `vizrt.com` | Viz Artist User Guide, Scene Tree chapter |
| Viz Artist: **middle-click a row icon → Quick Editor** popover | Medium — `vizrt.com` | Same |
| Viz Artist: tree can be **sorted by render time or texture size** | Medium — one source, and the standout idea, so worth confirming first | Same |
| Viz Artist: **colour labels** on containers | Medium | Same |
| Viz Artist: with **Z-Sort**, lower in the tree draws **later**, i.e. on top; default is Z-buffer by 3D position | **High** — `vizrt.com` | Same |

**Nothing in the phase plan below depends on a Medium claim without saying so.** The one High claim
that would be expensive to act on wrongly — stacking direction — is deliberately *not* acted on; see
§2.

---

## 1. How the three products model the same panel

**Ross XPression — Object Manager.** A hierarchy of typed objects (quads, text, groups, layer
objects). Selecting a row targets the **Object Inspector**; the two panels are separate jobs. Grouping
gives a parent whose transform carries its children. Masking is **positional**: a mask affects
everything *above* it in the tree, so scoping a mask means putting it in a group with its targets.
Stacking is the list order, read **bottom-up**, and a Layer Object can switch between honouring that
order (**Manual**) and honouring 3D Z position (**Automatic**).

**Vizrt Viz Artist — Scene Tree.** Radically different unit of composition: everything is a
**Container**, and geometry, material and transformation are *things attached to* a container rather
than kinds of object. The row therefore becomes a **launcher** — each attached property shows as an
icon you click (or middle-click, for a Quick Editor popover) to edit it in place. Containers carry
visibility and lock, take **colour labels** for navigation, and the tree can be **sorted by cost**
(render time, texture size) to find what is eating the frame. Drawing order is the Z-buffer by
default; applying the **Z-Sort** plug-in switches that subtree to strict tree order, where lower
draws later and therefore appears on top.

**GrapiX — Object Manager (shipped).** Typed objects like XPression, listing separated from editing
like XPression (`ObjectInspector` is a distinct panel), and compositing **bands** keyed by `layerId`
that are close cousins of XPression's Layer Objects. Where it departs from both is that the tree is
also a **spreadsheet**: `X`, `Y`, `Rot Z`, `Alpha` and the rest are live, scrubbable columns on the
row, chosen from a column picker, with a stopwatch per cell that keys at the playhead
(`objectManagerColumns.ts`, `TransformCell`). Neither reference product puts editable property columns
in its tree. It also ships a complete `treegrid` keyboard model and ARIA semantics that, on the
evidence available, neither reference product offers.

---

## 2. The one hard disagreement: which end of the list is the front

This is the finding worth the whole study, and it is **not a defect**.

| Product | Reading the list | Convention |
| --- | --- | --- |
| Ross XPression | Bottom of the list draws last | **bottom = front** |
| Viz Artist (Z-Sort) | Lower in the tree draws last | **bottom = front** |
| After Effects, Photoshop, Illustrator, Figma, Sketch | Top of the stack is nearest the viewer | **top = front** |
| **GrapiX today** | `createLayerStacks` reverses each band, so a row visually above is later in render order and has the greater `zIndex` | **top = front** |

GrapiX therefore agrees with the design-tool world and disagrees with **both** named broadcast
references. The recommendation is to **keep top = front**, for four reasons:

1. **The stated target names After Effects first** —
   [`docs/3d-engine-architecture.md:4`](3d-engine-architecture.md): *"Target: After Effects /
   XPression–class motion"*.
2. **Every importer speaks top = front.** GrapiX imports PSD, AI, SVG, Figma and After Effects
   (`Shared/adobe-common-schema`, `designImport.ts`). An imported layer stack keeps its meaning with
   no inversion; flipping the panel would put every import upside-down relative to its source file.
3. **The inversion is load-bearing and freshly verified.** Rules 180–181 exist because getting it
   wrong drew drop indicators on the wrong edge: `resolveRowDrop` returns *screen* terms and
   `inRenderOrder` converts once, on the way into the store. The live P2 pass proved the fixed
   behaviour. Flipping the default would re-open the exact defect those rules record.
4. **The panel and the canvas already agree with each other.** The mismatch is only with other
   products, and it is a *convention*, not a correctness bug — Blender's outliner and Unity's
   hierarchy differ from After Effects too, and neither treats it as a fault.

**But two things must change.** First, the convention is currently **undiscoverable**: nothing in the
panel says which end is the front, so an operator arriving from a Ross or Vizrt house has no way to
learn it except by moving something and looking. Second, in live broadcast that muscle memory is
worth respecting, so an **opt-in inverted row order** is a legitimate preference — placed late and
gated hard, because rules 180–181 prove the inversion is precisely where the drop grammar breaks.

---

## 3. Capability comparison

Legend: ● full, ◐ partial, ○ absent. GrapiX column cites the file that proves it.

| Capability | XPression | Viz Artist | GrapiX | GrapiX evidence |
| --- | :---: | :---: | :---: | --- |
| Hierarchy with inherited transform | ● | ● | ● | `store/objectHierarchy.ts` |
| Listing separated from property editing | ● | ◐ (row icons edit in place) | ● | `modules/object-inspector/` is its own panel |
| Compositing bands / layer objects | ● | ◐ (containers) | ● | `layerId`, `bandAggregate` |
| Visibility and lock per row | ● | ● | ● | shipped P3 |
| Drag to reorder, reparent, re-layer | ● | ● | ● | shipped P2, `objectManagerDrop.ts` |
| Multi-selection with anchor and active member | ◐ | ◐ | ● | `store/objectSelection.ts` |
| Search that keeps ancestors and descendants | ◐ | ● | ● | `services/objectSearch.ts` |
| **Editable property columns in the tree** | ○ | ○ | ● | `objectManagerColumns.ts`, `TransformCell` |
| **Per-cell stopwatch keying at the playhead** | ○ | ○ | ● | shipped P0/P1 |
| **Full `treegrid` semantics + keyboard model** | ○ | ○ | ● | shipped P4, rules 190–201 |
| Persisted column/width preferences | ○ | ◐ | ● | `objectManagerStore`, `grapix-object-manager-v1` |
| **Row icons that open the relevant editor** | ○ | ● | ○ | status dots are `aria-readonly`, `tabIndex={-1}` (`ObjectManager.tsx:1606-1609`) |
| **Quick-edit popover from the row** | ○ | ● | ○ | no equivalent |
| **Colour labels / tags on objects** | ○ | ● | ○ | `tags` exists on assets and materials only, never on `SceneObject` |
| **Sort the tree by render cost** | ○ | ● | ○ | `grep renderTime\|renderCost\|textureSize ObjectManager.tsx` → 0 |
| **Per-band depth-sort mode (list vs 3D Z)** | ● | ● (Z-Sort) | ○ | `sortObjectsForRender` is fixed: `layerId → zDepth → zIndex` (`sceneMaterial.ts:192-204`) |
| Positional masking (mask affects rows above) | ● | — | ○ (per-object masks, AE model) | `ObjectMask[]` on the object |
| "Always on top" per-object override | ● | — | ○ | none |
| Stacking direction | bottom = front | bottom = front | **top = front** | rules 180–181 |

**Read the table honestly in both directions.** GrapiX is *ahead* of both references on five rows —
editable columns, per-cell keying, keyboard and ARIA, persisted preferences, and selection semantics.
It is *behind* on five — row-launched editors, quick edit, colour labels, cost sorting, and depth-sort
mode. The gaps are not scattered: four of the five are about **navigating and diagnosing a big scene**,
which is exactly the workload a broadcast designer has and a plan should target.

---

## 4. What to adopt, what to decline

**Adopt — Viz Artist's idea that a row is a launcher.** GrapiX already draws three status dots for
material, animation and data binding, and they are deliberately inert. Making them the way you *reach*
those editors converts decoration into navigation and costs no new schema.

**Adopt — Viz Artist's cost sorting, as the differentiator.** A broadcast designer's real question is
"what is eating my frame". A tree that can order itself by measured cost answers it where the author
is already working. It also suits this repository's culture better than most features would: the
Object Manager's own P4 replaced an assumption with a measurement, and rule 200 makes re-measurement
the trigger for revisiting virtualisation.

**Adopt — colour labels**, the cheapest navigation win in the study, and one `SceneDocument` field.

**Adopt — XPression's Depth Sorting mode**, but knowingly: it is the only item here that changes what
the renderers do, so it is paired TypeScript/Rust work under rule 7, and it interacts with the
`zDepth` authoring gate the Object Manager's P0 shipped.

**Decline — positional masking.** XPression's "a mask affects everything above it" is a different and
more error-prone model than per-object `ObjectMask[]`, which GrapiX already has and which matches
After Effects. Adopting it would be a regression dressed as parity.

**Decline — flipping the stacking default.** §2. Offer it as a preference instead.

**Decline — "Text Always on Top".** A per-object override of global sort order is the kind of escape
hatch that makes a scene unexplainable; the depth-sort mode covers the legitimate case.

---

## 5. Phases

Effort is working days for one engineer; a shape, not a commitment. Every phase assumes the shipped
P0–P4 behaviour and its 339 tests stay green.

| Phase | Theme | Effort |
| --- | --- | --- |
| **R0** | Say which way is up | 0.5–1 d |
| **R1** | The row becomes a launcher | 2 d |
| **R2** | Colour labels and finding things | 1.5 d |
| **R3** | The tree as a frame-budget profiler | 3–4 d |
| **R4** | Depth-sort mode, both renderers | 3–4 d |
| **R5** | Opt-in inverted row order | 2 d |

Numbered `R` for *reference*, so they cannot be confused with the shipped `P` phases.

### R0 · Say which way is up — 0.5–1 d

**Work.** Make the stacking convention legible without changing it. A persistent marker at the head of
each band's stack reading **Front** (and the foot reading **Back**), the same words in the reorder
controls' tooltips, and one paragraph in the panel's own documentation stating that GrapiX follows the
After Effects convention and naming both references as differing. Nothing else in this study should
land before an operator can tell which end is which.

**Must not change.** Row order, `zIndex`, the drop grammar, `sortObjectsForRender`.

**Exit gate.** Live: a reader unfamiliar with the panel can state which row draws in front without
moving anything. Headless: the marker is asserted against `inRenderOrder`, so the label and the store
cannot disagree — if someone later flips the inversion, this test fails.

### R1 · The row becomes a launcher — 2 d

**Work.** The three status dots become buttons: material opens the Materials tab of the Object
Inspector for that object, animation reveals and selects that object's Timeline track, binding opens
the Data Binding tab. Each keeps its current meaning as an indicator and gains an action. Then Viz's
**Quick Editor**: a popover from the material dot offering the compatible material list for face 0
without leaving the panel, reusing the existing compatibility predicates.

**Must not change.** The status cell is `data-cell="3"` in the keyboard model and must remain exactly
one navigable cell with the row's cell count unchanged (`TreeRow.cellCount`); the popover must be
dismissible without disturbing the active cell, and Escape must return focus to it (the focus contract
from P4, `objectManagerFocus.ts`).

**Exit gate.** Headless: each dot's action resolves to the right panel and tab for every object type,
and a type with no material offers no material action; the row's `cellCount` is unchanged and the
keymap's column clamp still holds. Live: keyboard-only — reach the status cell with arrows, open the
popover, assign a material, press Escape, and confirm the tab stop is where it was.

### R2 · Colour labels and finding things — 1.5 d

**Work.** One optional `colorLabel` on `BaseSceneObject`, normalised for old scenes (rule 8), set from
the row's context menu and drawn as a spine on the row. The search box gains `label:red` alongside its
existing name matching, through the existing pure `objectSearch` service. Labels are authoring
metadata: no renderer reads them, and the schema comment must say so.

**Must not change.** `objectSearch`'s ancestor/descendant retention (rule from P1's fix). No renderer
gains a field it must honour — this is the rare case where a `SceneDocument` field is *deliberately*
inert, so it needs the same explicitness a parity gap would get.

**Exit gate.** Headless: an old scene with no labels normalises; `label:red` filters to labelled rows
and still keeps their ancestors; an unknown label name matches nothing rather than everything. Live:
label three objects across two bands, filter to them, confirm the spine survives a reload.

### R3 · The tree as a frame-budget profiler — 3–4 d

**Work.** The idea worth stealing. Add optional per-object cost columns — **draw calls**, **texture
bytes**, **last measured milliseconds** — populated from the renderer that is actually running, and
let the column header sort by them. Sorting by cost is a **view**, never a reorder: it must not touch
`zIndex`, so the panel enters an explicit read-only "sorted by cost" mode in which drag is disabled
and a banner says why.

The measurement must come from the renderer rather than being estimated in the panel, or it will
mislead exactly when it matters. Preview can report per-object timings from the existing render loop;
Program timings arrive over the engine client and may be absent, in which case the column says
**"not measured"** — never zero.

**Must not change.** `sortObjectsForRender` and the document. Drag must be impossible while a cost sort
is active, because a reorder under a non-document ordering would write an order the author never saw.

**Exit gate.** Headless: a cost sort produces no store write and no `zIndex` change; entering cost-sort
mode disables the drag source; an absent Program measurement renders "not measured" rather than 0, and
a stale measurement is labelled with its age. Live, with the 200-object fixture already used in P4:
sort by measured milliseconds, confirm the heaviest object is genuinely the heaviest by an independent
measurement, and confirm exiting the mode restores document order with drag re-enabled.

### R4 · Depth-sort mode, both renderers — 3–4 d

**Work.** XPression's Manual/Automatic, on the band. `SceneDocument` gains a per-band
`depthSort: "list" | "z-position"`, default **`"list"`** so every existing scene is unchanged.
`sortObjectsForRender` stops being unconditional and reads the mode; the Rust side changes in the same
commit (rule 7); the capability map gains the enum with its implemented values so a mode neither
renderer honours cannot be authored (rule 82). The band header shows the mode, because a band that
sorts by Z ignores the row order the panel is showing — and a panel whose order stops meaning anything
must say so.

**Must not change.** The `zDepth` authoring gate from the shipped P0: `zDepth` remains un-animatable
where a renderer discards it. In `"z-position"` mode the reorder controls for that band are disabled
with the reason, because reordering something sorted by Z is a no-op.

**Exit gate.** Headless: a paired TypeScript/Rust fixture proves both sorters agree for both modes over
the same scene; a scene with no `depthSort` normalises to `"list"` and sorts byte-identically to today;
reorder is refused in `"z-position"` mode. Live: two overlapping quads at different Z — swapping rows
changes the picture in `"list"` and does not in `"z-position"`, in Preview *and* in a published
Program frame.

### R5 · Opt-in inverted row order — 2 d

**Work.** A persisted panel preference, `stackDirection: "front-first" | "front-last"`, default
`"front-first"` (today's behaviour). It flips **only** the projection and the drop grammar's screen
terms, never the document. Rules 180–181 record that this is exactly where indicators break, so this
phase is mostly its test matrix.

**Must not change.** `zIndex`, `inRenderOrder`'s single definition, or any stored order. The preference
is a panel view, and the same scene opened by two operators with different preferences must publish
identically.

**Exit gate.** Headless: the entire P2 drop-grammar table (19 cases) re-run under **both** directions,
asserting that a drop at the same *screen* position produces the same *document* result in both — the
whole point, and the assertion rules 180–181 were written for. Live: with the preference inverted,
drag the top row onto the bottom edge of the third and confirm the object lands where the indicator
promised; toggle the preference and confirm the scene renders identically.

### Deliberately out of scope

Positional masking, "Text Always on Top", merging containers into one geometry (a Viz performance
device that assumes Viz's container model), and any change to the stacking **default**.

---

## 6. Honest risks

- **The ordering finding rests on secondary sources.** It changes nothing in this plan — R0 documents
  the convention, R5 makes it a preference — but §0's verification step should still be done before
  anyone quotes it in a release note.
- **R3 is the most valuable and least certain phase.** Per-object timings that are wrong are worse than
  none, and the honest fallback ("not measured") will be the common case for Program until the engine
  client reports per-object cost. It may deliver as Preview-only at first; if so it must say so, the
  way every other parity gap in this repository now does.
- **R4 touches both renderers and the wire.** It is the only phase here that can produce a scene that
  renders differently in Preview and Program, which is why its exit gate is a paired fixture rather
  than a TypeScript test.
- **GrapiX's lead over both references is in the grid, and grids get slow.** Cost columns add
  per-row work to the panel that P4 spent real effort making cheap; R3 must re-measure the 0.2 ms
  navigation and 15 ms selection figures rather than assuming they survive.
