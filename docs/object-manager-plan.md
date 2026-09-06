# GrapiX Object Manager — council plan

**Status:** **P0–P4 implemented (2026-08-08). All four phases of the plan are shipped.** Council
consensus, 2026-08-08, after one adversarial round.
**Scope:** The Editor's Object Manager panel (`Editor/apps/editor-web/src/components/ObjectManager.tsx`,
dock id `"scene-manager"`, user-facing title *Object Manager*) and the Editor session state it owns.
One phase (P0) necessarily reaches into `Shared/shared-types`; §4 says why and bounds it.
**Authority:** Subordinate to [`architecture.md`](architecture.md) and
[`scene-document-v1.md`](scene-document-v1.md). It changes no product boundary and adds no
`SceneDocument` field. Where it appears to disagree with either, they win.

## 0. How this plan was made

| Seat | Owns |
| --- | --- |
| Broadcast authoring / XPression parity | What an author loses per session; template trust before publish |
| Interaction design and IA | Selection semantics, drop grammar, row grammar |
| Frontend performance | Render cost at playhead rate, interaction cost, virtualisation threshold |
| Editor architecture | State ownership, module boundaries, contract hygiene, naming drift |
| Keyboard / accessibility / testability | Grid semantics, key map, focus rules, what is provable headlessly |

Each seat read the source independently and corrected the brief where it was wrong; those
corrections are in §2 rather than quietly dropped. The draft was then attacked by a review seat and
re-ratified by the authoring seat, which dissented twice. Nine review findings and four
authoring-seat corrections are folded in below; the two dissents that survive adjudication are
recorded in §5 as dissents, not resolved into agreement.

## 1. Decision summary

The Object Manager is the Editor's authoritative list of what a scene contains. Today it lists well
and **acts poorly**: it can show one selected object while the app holds a multi-selection it cannot
see, it cannot move an object in the hierarchy, its two most-used gestures are not undoable, and one
of its columns authors an animation that plays in the Editor and does nothing on air.

| # | Decision | Why in this order |
| --- | --- | --- |
| **D1** | `zDepth` becomes animatable **on meshes only**, enforced by one rule in `Shared/shared-types` that the Editor's controls *and* package preflight both consume. The stopwatch disappears from the Z column and from the Inspector's Position Z field for every 2D type; the static value stays editable everywhere. | It is the only defect here that puts a wrong picture on air, and the author is shown it working while it happens. |
| **D2** | One selection, owned by `editorStore`: `selectedObjectIds` (the set) + `selectedObjectId` (the **active** member, unchanged name and meaning) + `objectSelectionAnchorId`. `uiStore.selectedPathObjectIds` is deleted, not aliased. Every direct writer of `selectedObjectId` routes through the new action. | Every later feature is undefined without it — "reorder *what*", "lock *what*", "align to *which*". |
| **D3** | Drag to reorder, reparent and re-layer, with hover-time refusal. Every mutation goes through store actions that already exist and are already cycle-safe. | UI over live capability, not new capability. Also discharges the standing product requirement that ordering not be repeated up/down buttons. |
| **D4** | Row grammar: in-place rename, per-object lock, a working band chevron, inline layer-name validation replacing `window.alert`, a resizable and *persisted* name column, honest badges. | Changes no semantics, so it is the only tranche that may slip without blocking the others. |
| **D5** | `treegrid` semantics with a panel-scoped roving keyboard model, then virtualisation only at a measured threshold. | Correctness of structure before speed of structure. Cell memoisation is **not** here — it lands in P1 (§5). |

The panel's settled behaviours are **not** reopened: chosen property columns, the live `keyframed`
column mode, spelled-out status dots, mask rows keeping their own Alpha/Feather/Expand instead of
borrowing transform columns, and detailed Properties/Materials/Text/Data Binding staying in the
Object Inspector.

## 2. Findings ledger

Severity: **A** = wrong output or lost work; **B** = costs time every session; **C** = polish.

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | A | **A `zDepth` channel on a 2D object animates in the Editor and is ignored on air.** The TS evaluator patches every animated channel including `zDepth` for every object type, and the Editor sorts by `layerId → zDepth → zIndex` on the evaluated scene each frame; the engine explicitly discards `AnimatedProperty::Z` for quads and texts and never re-sorts. Both the Object Manager's Z column and the Inspector's Position Z field offer the stopwatch that authors it. | `Shared/shared-types/src/index.ts:582-587`, `:1232-1243`; `CanvasStage.tsx:223-231`; `rendering/sceneMaterial.ts:192-204`; `services/render-engine/src/animation.rs:498-504` and `:527-530` (quads/texts discard Z) vs `:569-577` (a mesh animates it correctly); `objectPropertySupport.ts:37-64` returns `true` by default; `objectManagerColumns.ts:42-71`; `Inspector.tsx:151` with the always-present stopwatch at `:889-896` |
| F2 | A | **The panel's numeric scrub has no history transaction at all.** No `beginHistory`/`commitHistory`, so a drag produces no undo entry while dirtying the scene on every qualifying pointermove; autosave observes every intermediate identity. The Timeline wraps its gesture correctly and is the precedent. | `ObjectManager.tsx:737-779`; `TimelinePanel.tsx:260-302`; `lib/autosave.ts:212-224`; `editorStore.ts:2004-2017` |
| F3 | A | **Reparent, reorder and visibility are not undoable.** `setContainerChild`, `moveObjectInStack` and `updateObject` write with a bare `set({ scene: touchScene(...) })`; only `commitScene` pushes `undoStack`. | `editorStore.ts:607`, `:1028-1033`, `:473-478`, `:2134-2141` |
| F4 | A | **The multi-selection has no exit and no picture.** Nothing clears `uiStore.selectedPathObjectIds` except one toolbar path; neither `selectObject` nor `setActiveTool` touches it, so a marquee of five stays live in the alignment toolbar after the author clicks one object. The canvas draws a gizmo for the active object only, and `applyMarquee` picks the active as `next.at(-1)` — so the "Photoshop key object" is whichever object sorted last. | `DesignToolToolbar.tsx:367`; `editorStore.ts:385-394`; `uiStore.ts:265-279`; `CanvasStage.tsx:233-236`, `:1054-1062`, `:1393-1400`; `useAlignmentSelection.ts:10-14`, `:46` |
| F5 | A | **`selectedObjectId` has writers that bypass `selectObject`.** Add, duplicate and the scene-lifecycle paths assign it directly, so a naive D2 would leave the active id outside the set with no type error. | `editorStore.ts:634`, `:2222`, `:2263`, `:2071`, `:2090`, `:2103`, `:2119`, `:2289` |
| F6 | B | **`moveObjectToLayer` exists, is dead, and would split a group if used.** It moves one object's `layerId`, not its subtree, while `setContainerChild` propagates `layerId` across the subtree. All three renderers sort `layerId` before depth, so a group moved with it would draw detached from its children. Zero callers, so fixing it cannot regress anything. | `editorStore.ts:294`, `:1837-1854`, `:582-600`, `:3291`; `rendering/sceneMaterial.ts:192-204`; `services/render-daemon/src/scene/document.rs:640-649` |
| F7 | B | **A dragged subtree has no lock check.** `setContainerChild` collects every descendant and rewrites each one's `layerId` without consulting `locked`, so moving an unlocked group would move a locked child with it. | `editorStore.ts:580-607` |
| F8 | B | **Reparenting today is a silent-failure checkbox list.** The Inspector offers every object in the scene as a candidate parent, unfiltered by legality, and discards `setContainerChild`'s `false` return. The legality predicates exist and are module-private. | `Inspector.tsx:649-653`; `ObjectTypeProperties.tsx:513-527`; `editorStore.ts:3208`, `:3212-3217`, `:3219-3231` |
| F9 | B | **Search flattens the tree.** Objects are filtered before the tree is built, so a matching group shows with its children gone (reads as empty) and a matching child of a non-matching group is promoted to a root. | `ObjectManager.tsx:815-834`, `:836-872` |
| F10 | B | **A band's eye and lock lie during a search.** `layerVisible`/`layerLocked` are reduced over the *filtered* set while the actions write the whole layer. The same list is sorted and reversed for no reader. | `ObjectManager.tsx:593-594`, `:816-832`, `:831`; `editorStore.ts:1923-1949` |
| F11 | B | **Collapse dies on a re-dock** (component state) while the chosen columns beside it survive; and **nothing in `uiStore` survives a reload** — it is a plain `create` with no `persist`, so "remembered" means across remount only. | `ObjectManager.tsx:113-123`, `:180-187`; `uiStore.ts:1`, `:196`, `:156-193` |
| F12 | B | **A container whose only children are masks has no disclosure control**, because the condition is `node.children.length > 0` while the same collapsed flag also hides masks. | `ObjectManager.tsx:239-251`, `:310-395` |
| F13 | B | **The layer band chevron is decoration** — no handler, so a band cannot collapse. | `ObjectManager.tsx:597-600` |
| F14 | B | **No object rename, no per-object lock in the panel.** Rename is a history-aware store action already; the row renders a span. Layer lock bulk-writes every object, so it cannot protect one logo while the rest is revised. | `editorStore.ts:484-501`, `:1937-1949`; `ObjectManager.tsx:238-255` |
| F15 | B | **Playhead fan-out.** For V visible objects and C chosen columns, one playhead change re-executes the panel and `V×C` cell components; `T` of those cells sample a channel (`0 ≤ T ≤ V×C`), each sample seeking its bounding key pair linearly, and `hasKeyAtFrame` scans the keys again. Nothing is memoised below the panel. | `ObjectManager.tsx:101`, `:189-196`, `:288-306`, `:394-397`, `:649`, `:664-687`; `Shared/shared-types/src/index.ts:550-563` |
| F16 | C | **The layer rename lies twice before it alerts.** The input is seeded with the raw slug while the band shows Title Case, and the alert quotes the raw draft while the collision is decided on the normalised id. Then it blocks the app with an OS dialog. | `ObjectManager.tsx:172-178`, `:618`, `:625`, `:874-877`; `editorStore.ts:1884`, `:3405-3411` |
| F17 | C | **Two reading directions in one tree.** Roots are render-sorted then reversed (topmost first); children are raw `childIds` order, and adoption appends — so a group reads roughly bottom-up inside a top-down list. | `ObjectManager.tsx:831`, `:850-853`, `:857`; `editorStore.ts:592` |
| F18 | C | **Mask indent collides with object depth** (a mask under a depth-0 object sits at the same 38px as a depth-2 object), and the zebra stripe inverts below any object owning a mask because `nth-child` counts mask rows. | `ObjectManager.tsx:238`, `:322`; `styles.css:6554` |
| F19 | C | **Badges misreport two types.** A `layer` object's badge is its bare `layerKind` — literally `object` or `camera`, the latter colliding with a camera object's `Persp`/`Ortho` — and `meshKind` is unbounded text in a 34px badge. | `ObjectManager.tsx:879-895`; `styles.css:6660-6664` |
| F20 | C | **The name column is the real width defect, not the value columns.** At depth 6, indent + 34px badge + 14px disclosure leaves the name ≈34px of a fixed 180px column. Meanwhile a value clipped in a 72px cell has no ellipsis, so `-1234.567` can read as a different number. | `ObjectManager.tsx:149-150`, `:238`, `:781`; `styles.css:6660-6663`, `:6666-6671`, `:6885-6899` |
| F21 | C | **Dead property-panel residue.** `PropertyInspectorContent`/`propertyInspectorTabs` are imported and the `view`/`selectView`/`propertiesTab` path is kept, but no property content renders here since the tabs moved to the Object Inspector. | `ObjectManager.tsx:35-39`, `:61`, `:113`, `:167-170` |
| F22 | C | **Drop feedback has already forked once** — two rule sets for one material-drop meaning. A third fork is the failure mode when drag-and-drop lands. | `styles.css:4573-4581`, `:7004-7010` |
| F23 | C | **Selection, depth and position are unannounced.** No `aria-selected`, no `aria-level`/`aria-posinset`/`aria-setsize`, no cell roles, no keyboard path at all; the status dots and property controls *are* labelled. | `ObjectManager.tsx:189-307`, `:565-581`, `:266-287`, `:701-730` |

**Open question, answered during P0.** The engine also discards `Width`, `Height` and `Opacity` for
a **mesh**, on the grounds that a mesh is scaled and its opacity lives in the material
(`services/render-engine/src/animation.rs:578-582`, pinned by its own test at `:1088-1104`), while
the TS evaluator patches all three for every type. The Editor's preview **does** show them: the
Three layer feeds `object.opacity` into mesh material creation (`ThreeSceneLayer.ts:227`, `:602`) and
multiplies it by the face opacity (`:730-736`), while the engine bakes object opacity into the
prepared surface once (`services/render-daemon/src/scene/mesh_prepare.rs:555`, `:977`). So mesh
opacity animation *is* F1's defect with a different property — and it is deliberately **not** gated.
Two reasons: `shape` objects travel the same mesh path (`mesh_prepare.rs:740`), so gating it would
remove fading a vector logo, which is ordinary authoring the preview honours; and the honest repair
is an engine that patches prepared surfaces per frame, not an Editor that deletes the control.
Tracked as its own decision. Gating it here would have been solving the symptom.

Corrections the seats made to the brief they were given, kept because a plan that hides them would
repeat them: property columns are **not** persisted across a reload (F11); `sampleChannel` is called
only for cells that actually have a channel, not for every cell (F15); the scrub problem is not
merely cost — there is **no** undo entry for it (F2); and the render sort key is
`layerId → zDepth → zIndex`, not `layerId → zIndex`, which is exactly why animating a 2D object's
depth cannot work without a re-sort (F1, F6).

## 3. Invariants this plan may not break

1. **`SceneDocument` gains nothing.** Selection, anchor, collapse, sort, row height and column
   choice are Editor session state. The only document writes this plan adds are `name`, `visible`,
   `locked`, `layerId`, `childIds` and `zIndex`, all through store actions that exist.
2. **One authority per support question, and it lives where every consumer can reach it.** Whether a
   property is *editable/bindable* on a type stays `isPropertySupported`; whether it is *animatable*
   becomes a new rule in `Shared/shared-types`, because package preflight lives there
   (`Shared/shared-types/src/index.ts:3967`) and cannot import from `Editor/`. No panel-local copy
   of either — that drift already shipped once, offering Rotate X/Y on layers and groups.
3. **The animatability rule and `animation.rs` are one specification in two languages** and change
   in one commit, like every other TS/Rust twin in this repository.
4. **Container legality comes from `editorStore`'s own predicates, exported, never copied.**
5. **Cycle safety stays layered**: the panel refuses on hover, `setContainerChild` still refuses at
   the store, and `createObjectTree`'s ancestor guard still keeps malformed legacy groups
   inspectable. This plan adds a defence and removes none.
6. **Listing objects and editing one object stay two jobs.** No property tab comes back here.
7. **Nothing touches Program, outputs or the render engine.** D1's engine-side behaviour is already
   correct; the change is to stop the Editor authoring against it.
8. **Delete stays panel-scoped.** No document-level shortcut may cross panel ownership.
9. **A single selection must render exactly as it does today** after D2 — same fill, same accent
   bar. The two-class split and the added `aria-selected` are the only permitted differences, and
   neither is a visual one.

## 4. Phases

Each phase ships on its own. Effort is one engineer, and it is a shape, not a commitment.

### P0 · The Z column stops lying — **Implemented, 2026-08-08**

**One correction found while implementing it, before any code changed:** the gate is not "mesh
only". A bezier `shape` is tessellated into a `PreparedMesh`
(`services/render-daemon/src/scene/mesh_prepare.rs:740`) and is therefore patched by
`mesh_transforms`, so a shape's `zDepth` animates on air exactly as a mesh's does. The rule is
**the mesh path** — `mesh` and `shape` — and gating shapes would have removed something that works.

**What shipped.**

- `isPropertyAnimatable(objectType, property)` in `Shared/shared-types/src/index.ts` is the single
  authority. `isPropertySupported` keeps answering the editable/bindable question; this answers the
  animation one, and package preflight can reach it because it lives in `Shared`.
- `evaluatePropertyChannelsAtFrame` skips a channel the rule rejects, so Preview stops animating what
  Program discards. This **closed** an existing divergence rather than creating one.
- `objectManagerColumns.isColumnAnimatable` gates the Object Manager cell: no stopwatch, no diamond,
  and the number stays editable, with the cell padding reclaimed (`.no-stopwatch`). `animatedColumns`
  ignores an inert channel too, so **Keyframed** mode cannot show a column nothing plays.
- The Inspector's `AnimatedNumberField` gates itself for every property, so Position Z on 2D content
  loses its stopwatch and keeps its alignment through a placeholder.
- `preflightScenePackage` emits `ANIMATION_CHANNEL_NOT_RENDERED` as a **warning** naming the object.
  Keys are never stripped.
- `fixtures/animatable-properties.json` is emitted from the rule by `fixtures:emit` and asserted by
  `animation.rs`'s `the_animatability_table_matches_what_this_module_applies`, which also *proves*
  both sides behaviourally in the same test — a mesh's Z translates, a quad's is discarded — so the
  Rust test is not a second copy of the list.

**Deliberately unchanged.** Mesh/shape `zDepth` animation. Static `zDepth` editing and `zDepth`
*binding* on every type — a binding sets the value preparation reads, which works. Mesh
`width`/`height`/`opacity` (see §2). Draw-order semantics: this did not make depth animation work for
2D, it stopped offering it.

**Evidence.** `@grapix/shared-types` 129/129 (+5), `@grapix/editor-web` 158/158 (+3),
`@grapix/api-server` 118/118 across three consecutive runs, `cargo test --lib` animation 30/30 (+1),
`npm run typecheck` repo-wide clean, `npm run check:boundaries` passed, `fixtures:check` up to date.
Live on an isolated pair (project service 4111 with its own data root, Vite 5199 via
`VITE_GRAPIX_API_URL` — rule 118): a text, a cube and a rect in one scene, all ten columns shown.
Z cell on the text and the rect had no stopwatch and no diamond and stayed editable — typing 42 into
the rect's Z took, and the row re-sorted, which is `zDepth` being a live sort key and the reason the
animation could never have worked. The cube's Z stopwatch enabled a channel and the diamond appeared;
**Keyframed** then resolved to exactly `Z`. In the Inspector, Position Z showed no stopwatch on the
rect with its row alignment intact and a working one on the cube, while X, Y, Rotate, Scale and
Opacity kept theirs on both. Only console error was `ERR_CONNECTION_REFUSED` for the render engine,
which was deliberately not running.

**Why this was P0 and not polish.** Every other item costs an author time. This one costs the
audience the picture, and the author is shown the animation working while it does.

### P1 · One selection, made visible — **Implemented, 2026-08-08**

**Deviations from the plan below, both deliberate.** The gesture reducer lives in
`src/store/objectSelection.ts`, not `modules/object-manager/`: three surfaces read the selection and
only the store can prune it inside the same `set` as the mutation, which is the argument §5 already
makes — a panel-owned module would have been the wrong home for it. And **add, duplicate, delete and
`updateObject` became undoable in this phase too.** They were bare `set({ scene })` calls, so
deleting an object produced no undo entry at all; a toolbar that deletes four at once made that
indefensible, and P1's own objection gate names it.

**Also shipped, beyond the letter of the plan:** `lib/pointerCapture.ts` extracts the Timeline's
private `capturePointer` so both panels share one guarded implementation (the scrub's unguarded
`setPointerCapture` threw on every synthetic pointer, which is rule 121's hazard), and the design
toolbar's "N paths" label now reads "N selected", because the marquee fills it with any object.

**Evidence.** `@grapix/editor-web` 196/196 (+38: 21 reducer, 17 store-level), repo `npm run
typecheck` clean, `check:boundaries` passed. Live on an isolated pair (service 4111 with its own
data root, Vite 5199, temp data deleted): click → one member that is also active, rendering exactly
as a single selection did before; Ctrl+click → two members, one accent bar, trash reads
"Delete 2 objects" and the alignment tools **enable**; Shift+click takes the inclusive run and
replaces; Ctrl+A takes all four including the collapsed-descendant set; Escape clears. Deleting a
four-object selection removed all four and **one** undo brought all four back. Aligning a selection
made entirely in the panel moved Background 3 from x=700 to x=300 to meet Background 2, left the
unselected object alone, and undid in one step — which was impossible before, because the panel
could not make a selection the alignment tools could see. A 12-move scrub of an X cell wrote one
undo entry (0 → 6 → undo → 0). With one animated channel, the animated cell followed the playhead
(300 at f0, 600 at f20, 900 at f40) while the un-animated rows did not re-render at all. No page
errors.

The original plan for this phase follows, unedited.

### P1 as planned — 2–3 d

**Work.** In `editorStore`: `selectedObjectIds: string[]` (render order), `selectedObjectId` keeping
its name and type as the **active** member, `objectSelectionAnchorId`, and one action
`selectObjects(ids, { active?, anchor? })`; `selectObject(id)` becomes a shim for
`selectObjects(id ? [id] : [])` so the ~100 single-active read sites across 14 files need no change.
Invariant: the active id is non-null iff the set is non-empty, and is always a member.

**Every direct writer routes through the action** — add (`:634`), duplicate (`:2263`), the added
object at `:2222`, and the scene-lifecycle paths (`:2071`, `:2090`, `:2103`, `:2119`) — or the
invariant breaks with no type error (F5). Reconcile **inside the reducer**, in the same `set` as the
mutation: delete (`:2289`) drops the id and re-picks the nearest survivor above; undo/redo prunes to
ids present in the restored scene; load/import/reset/clear reset to the first object; a search-term
change touches nothing, because a filter is not a deselection.

Delete `uiStore.selectedPathObjectIds` and migrate its readers — `CanvasStage` (click, transform
drag, marquee, clear), `DesignToolToolbar` (including its mask controls) and `useAlignmentSelection`,
which then stops unioning two sets and is reduced to geometry. `applyMarquee`'s arbitrary
`next.at(-1)` active pick becomes the topmost member, so the panel and the alignment toolbar finally
agree on the key object.

**The Timeline is not left undefined.** Its row click calls `selectObject` unconditionally
(`TimelinePanel.tsx:585-597`), which through the shim would silently destroy a multi-selection. Rule:
a Timeline row click **sets the active object and preserves membership** when the clicked object is
already a member, and otherwise replaces the selection as it does today. The Timeline gains no
modifier gestures in this phase.

Gesture rules live in a pure `modules/object-manager/services/objectManagerSelection.ts`:

| Gesture | Set | Active | Anchor |
| --- | --- | --- | --- |
| Click | `[id]` | `id` | `id` |
| Ctrl+click, not a member | append `id` | `id` | `id` |
| Ctrl+click, member, n>1 | remove `id` | nearest surviving member above, if `id` was active | `id` |
| Ctrl+click, last member | `[]` | `null` | `null` |
| Shift+click with anchor | inclusive slice of object rows, replacing | `id` | unchanged |
| Ctrl+Shift+click | that slice unioned | `id` | unchanged |
| Ctrl+A (panel focused) | every object matching the search, **including collapsed descendants** | topmost | topmost |
| Escape (panel focused, nothing being edited) | `[]` | `null` | `null` |
| Click the scene row or empty grid | `[]` | `null` | `null` |

Ctrl+A spans the **search match set**, not the rendered rows, so Ctrl+A then Delete cannot orphan a
collapsed child. This is the single definition; P4's keymap adopts it verbatim. Escape in navigation
mode belongs to **this** table — P4's reducer must consume it — while a live rename or drag consumes
it first. Escape and Ctrl+A are guarded by the existing `INPUT|TEXTAREA|SELECT` target test.

The toolbar acts on the whole selection in one history transaction, with counts in the tooltips — a
multi-selection whose trash silently deletes one object is worse than no multi-selection. F2's
missing scrub transaction and F3's missing reorder/visibility transactions are fixed here, because
they are the same `beginHistory`/`commitHistory` omission.

**Cell memoisation lands here, not in P4** (§5): memoise the row and cell components and move the
playhead subscription down into the cells that actually have a channel, so a still row costs nothing
per frame, and hoist the per-row allocations (status arrays, depth style objects, inline callbacks).
It is hours of work, it conflicts with nothing else in this phase, and P1 is already touching every
row. F21's dead residue is deleted here too.

**Must not change.** The canvas's multi-object drag stays gated on the path-selection tool; only the
key name changes. Widening it belongs to the canvas owner. A multi-selection must never make a
single-object Inspector mutation apply to every member: inspectors read the active object only.

**Exit gate.** Headless: every row of that table against the pure resolver, including Shift+click
retaining the anchor while replacing the set, Ctrl+click on the active member re-picking, and Ctrl+A
including a collapsed group's children while excluding filtered-out objects. Store-level: add and
duplicate leave the active id inside the set; deleting a non-active member drops it **with no effect
having run** — asserted on the state immediately after the action, which is what distinguishes
reducer reconciliation from an effect. Live: marquee three on canvas, see three filled rows and
exactly one accent bar; Ctrl+click a fourth; align to the active; delete four and undo once; click a
member's Timeline row and watch the set survive; scrub and play with the tree expanded and record the
frame cost before and after the memoisation. A repository search for `selectedPathObjectIds` returns
nothing.

### P2 · Direct manipulation — **Implemented, 2026-08-08**

**Shipped as specified**, with the grammar in a pure `modules/object-manager/services/objectManagerDrop.ts`
resolving against `store/objectHierarchy.ts` — the four container predicates, extracted from
`editorStore` into their own pure module so the resolver and the mutation share one definition rather
than the panel keeping a copy. `applyObjectDrop` sequences the whole drop in the store (detach →
adopt → reorder) because a panel that got that order wrong would leave a half-moved subtree, and
`moveObjectToLayer` was fixed to carry the subtree (F6). The search projection moved to
`services/objectSearch.ts` and now keeps a match's ancestors and a matched container's descendants
(F9) — dropping against a tree that misreports parentage is the trap that fix removes.

**Two defects the live pass caught that no unit test would have.**

1. **The dragged ids lived in React state**, so the first `dragover` after `dragstart` read a stale
   empty set, resolved to `noop`, and drew no indicator until the pointer moved again. They live in a
   ref now: `dragover` needs them synchronously.
2. **The indicator showed the store's kind, not the author's.** The panel inverts before/after because
   the grid draws each band reversed, and doing that *before* choosing the indicator drew the
   insertion line on the opposite edge — hovering the top of a row promised a landing at its bottom.
   `resolveRowDrop` now returns screen terms and `inRenderOrder` flips exactly once, on the way into
   the store.

**Evidence.** `@grapix/editor-web` **258/258** (+38: 19 drop grammar, 12 store execution, 7 search),
repo `typecheck` and `check:boundaries` clean. Live on an isolated pair (4111 + 5199, own data root,
deleted after): hovering the top edge drew the line above the row and the bottom edge below it, a
group showed the accent ring with the line indented to depth 1 (23px), and a band row showed the ring.
Dropping Background 2 on the **top** edge of Background 3 put it **visually above** — the inversion
trap, end to end — and one Ctrl+Z restored the order. Dragging a group onto the Layer 2 band carried
its child with it, both landing in the new band with the nesting intact, and one undo returned both.
Dragging a group onto its own child showed the danger ring and **mutated nothing**. A material drag
over the same row still resolved to `material-drop-blocked`, so the two gestures never crossed. And
collapsing a group, then dropping an object into it, **expanded it** to reveal both children at depth
1 — the case a store-level test cannot reach, because collapse is panel state.

### P2 as planned — 2–3 d

**Work.** Rows become `draggable`, carrying `application/x-grapix-objects` (the whole selection when
the pressed row is a member, else that row). Discrimination from the existing material drop is by
mime on both sides, which the current handler already does — a material dragged onto a group still
assigns a material and never reparents.

Drop grammar, resolved by a pure `modules/object-manager/services/objectManagerDrop.ts` against the
**exported** container predicates:

| Target | Zone | Result |
| --- | --- | --- |
| Any object row | top 25% / bottom 25% | `before` / `after` — sibling under *its* parent |
| Container row | middle 50% | `into` — appended as last child |
| Leaf row | middle 50% | nearer of before/after; never a dead zone |
| Layer band row | whole row | `into-layer` — detach from any parent, top of that band |
| Scene row / below the last row | whole row | `after` the band's bottom-most root |

`before` means *visually above*, which in this reversed list is the **greater** `zIndex`. Saying so
is the defence against shipping it inverted. The insertion line is indented to the depth the object
will land at, so its left edge *is* the answer to "which parent"; `into` is a ring in the accent
colour that already means "container" in this panel's badge language; green stays material. The
indicator draws on the row above the sticky name cell so it survives horizontal scroll, and it
extends the existing danger rule with a selector rather than declaring a second one (F22).

Refusals are decided on hover, never after the drop: a target inside the dragged subtree; a camera
layer that holds cameras only; **any locked object in the dragged subtree, not merely a locked
dragged id** (F7 — `setContainerChild` rewrites every descendant's `layerId` with no lock check);
a locked `into` target. A drop that changes nothing — onto itself, or `into` its current parent — is
a calm `noop` with no indicator, not an error. Execution: `into` → `setContainerChild`;
`before`/`after` within a parent → one new `reorderObjectsInStack` splicing the flat sorted layer
list exactly as `moveObjectInStack` does and finishing through `normalizeObjectStack`; across parents
→ detach, adopt, reorder; `into-layer` → `moveObjectToLayer` **fixed to move the subtree** (F6). One
`beginHistory`/`commitHistory` per drop, so one Ctrl+Z restores a multi-object move. A collapsed
container that receives a drop auto-expands — a move whose result you cannot see reads as a deletion.

F9's search flattening is fixed here: a matched descendant retains its ancestors as context rather
than being promoted to a root, and a matched group keeps its children. Drag-and-drop onto a tree that
misrepresents parentage is not a feature, it is a trap.

**Must not change.** Locked objects stay unmovable, consistent with the canvas. Nesting must not be
implied to change render order: all three renderers sort `layerId` then depth, and a subtree always
lives in one band because adoption propagates `layerId`.

**Exit gate.** Headless: the four zones at fractions 0.1/0.4/0.6/0.9 on a container and on a leaf;
`into` refused for non-containers; a group dropped onto its own descendant is `invalid`,
cross-checked against `containerContains`; a camera onto an object layer and a rect onto a camera
layer both `invalid`; an unlocked group containing a locked child is `invalid`; drop-on-self and
`into`-current-parent are `noop`, distinct from `invalid`. Order is asserted **after**
`normalizeObjectStack` and re-sorted with `sortObjectsForRender`, including the inversion trap.
Store-level: one drop of three objects grows `undoStack` by exactly one and one undo restores all
three parents and `zIndex`es; a group dragged across bands leaves no descendant whose `layerId`
differs from its parent's. Live: the refusals show a ring and mutate nothing; a material drop onto a
group still assigns.

### P3 · Row grammar and remembered preferences — **Implemented, 2026-08-08**

**Shipped as specified.** Four new pure services under `modules/object-manager/services/`:
`objectManagerPreferences` (parse/prune/clamp), `objectManagerNaming` (collision prediction),
`objectManagerBands` (band aggregates) and the P2-era `objectSearch`. A `objectManagerStore` under
`modules/object-manager/stores/` owns the panel's state with **two deliberate lifetimes** — the
columns, column mode and name width persist under `grapix-object-manager-v1`; collapse is
session-scoped, surviving a re-dock and not a reload. The column state was **removed** from `uiStore`
rather than duplicated, so there is one home for it.

**Two things the spec did not name, found while implementing:**

1. **The slug rule was about to be duplicated.** Predicting a band collision needs the store's
   `normalizeLayerId`, and writing a second copy in the panel is precisely the drift that made the
   old `window.alert` incoherent (it quoted the raw draft while the store compared the slug). It is
   now `store/layerIds.ts`, used by both.
2. **`nth-child` cannot stripe by class.** Mask rows are `div` siblings of object rows, and
   `nth-of-type` counts tags, so neither selector can express "every other *object* row". The parity
   is computed from the row's index in the visible order and applied as a class.

**Evidence.** `@grapix/editor-web` **282/282** (+24: 10 preferences, 10 naming, 6 bands — with two
existing tests folded into the new modules), repo `typecheck` and `check:boundaries` clean. Live on an
isolated pair (4111 + 5199, own data root, deleted after): the header gained a Lock column and every
row matched it at 7 cells; double-click renamed `Background 1` to `Score Plate` on Enter; a colliding
rename **held the field open** with `aria-invalid` and "Another object is already called \"Score
Plate\"" and **raised no OS dialog**; locking a row dimmed it and set `draggable=false` with the title
flipped to "Unlock Score Plate"; the band rename seeded with the **displayed** name ("Main", not the
slug), showed the live hint `id: lower-third`, and committed to "Lower Third"; the band chevron
collapsed 3 rows to 0; "Hide everything except…" hid the siblings and **kept the selected group's
child visible**, undone in one step, and "Show every object" restored them.

**The persistence gate, exactly as written:** the name column dragged to 400px and a fourth column
ticked, the stored payload holding only `{columns, columnMode, nameWidth}` — then a **reload** brought
back the 400px width and all four columns, and left the band **expanded**, because collapse is
deliberately not persisted.

### P3 as planned — 2 d

**Work.** In-place rename on double-click/F2/Enter with a draft, Enter commits, Escape reverts, blur
commits — deliberately *not* the mask row's live input, which writes the scene per keystroke.
Per-object lock button; a locked row dims, refuses to be a drag source and refuses `into`. The band
chevron is wired (F13) and the disclosure condition counts masks as children (F12). `window.alert` is
replaced by predictable inline validation: compare the *normalised* id before commit, seed the input
with the displayed name, show the resulting slug as a hint (F16). Badge fixes for layer objects and
long mesh kinds (F19). Band aggregates read the whole layer, not the filtered set, and the dead sort
is removed (F10). Mask indent gains a distinguishing offset and the zebra stops counting mask rows
(F18). A clipped value's full text joins the input's title rather than replacing the scrub hint (F20).

**Persistence, which nothing owned before this phase** (F11): a `grapix-object-manager-v1` store
holding the column set, the column mode and the name-column width, validated on read with unknown
ids dropped. These survive a re-dock **and a reload**. Collapse moves out of component state into
session state keyed for both bands and groups, surviving a re-dock but **not** a reload (§5). The
name column becomes resizable through the existing grid CSS variable, clamped 120–480 (F20).

**"Hide others" / "Show all" instead of solo.** Solo is refused. Either it is a scene property, in
which case it is a contract change the renderers must honour and is out of scope, or it is a viewport
filter needing `CanvasStage` to compose it, also out of scope. The third option — writing
`visible: false` across the scene while calling it a view state — corrupts the document and loses the
author's real visibility on undo. Explicit one-shot commands over the selection give most of the
value with no new state and one undo step.

**Exit gate.** Headless: the layer-name collision predicate, including the normalisation case
("Lower Third" vs "lower third"); disclosure presence for a mask-only container; band aggregates
under an active search; the persisted payload's parse/prune behaviour including an unknown column id
and an out-of-range width. Live: F2 rename; per-object lock protecting one object while its siblings
move; a colliding rename showing inline red with no OS dialog; the name column dragged 180→400 with
the header still aligned to the body, **then a reload showing the width and columns restored and the
collapse state deliberately not**.

### P4 · Semantics, keyboard and measured cost — **Implemented, 2026-08-08**

**Shipped as specified, and the measurement changed one decision.** Three more pure services:
`objectManagerTree` (the row projection, now the panel's only tree walker), `objectManagerKeymap`
(every key as one reducer) and `objectManagerFocus` (where the tab stop goes when rows move). The
grid is a `treegrid` with `aria-colcount`/`aria-rowcount`, `columnheader` headers, `rowheader` name
cells, `gridcell` elsewhere, `aria-colspan` on the mask value cell, `aria-readonly` on cells that
cannot be edited, and `aria-level`/`aria-posinset`/`aria-setsize`/`aria-rowindex` per row.
`aria-expanded` appears only on rows that reveal something. The scene name left the row collection
and became a heading, so no row index counts a row with no object in it.

**The keyboard is a reducer, and `consumed` is separate from the intent** — End on the last cell is
ours *and* does nothing, because letting it through scrolls the panel away. Left/Right resolve by
position: hierarchy on the first cell, movement everywhere else, never both.

**Three things the spec did not name.**

1. **Rows are not all the same width, so the column budget belongs to the row.** A band draws four
   cells and a mask five, whatever the object rows beside them show. With one grid-wide width, an
   author arrowing from column 6 of an object row onto a band spent four presses moving an invisible
   index while nothing on screen changed. `TreeRow.cellCount` is now part of the projection, and every
   landing re-clamps to it. `FIXED_COLUMNS` moved to the tree module, where the rows are described.
2. **A plain arrow has to carry the selection.** Moving the tab stop without it left the anchor
   behind, so the next Shift+Down claimed every row in between — measured live as a three-row gesture
   selecting 197. Plain Up/Down select; hold the accelerator to navigate without disturbing the set.
3. **The DOM is the authority on where the caret is.** Clicking a lock button or a property cell
   focuses a cell the keymap knew nothing about, so the next arrow moved from wherever the *keyboard*
   had last been. `onFocusCapture` adopts the focused cell, and the pointer path no longer decides the
   tab stop a second time.

**Virtualisation was not needed; memoisation was.** The gate said to defer windowing past ~250 rows
and record a measurement. The measurement said the panel was already unusable at 199: **85 ms per
arrow key**, because moving one tab stop re-rendered every row, and a selection change did it again.
Two fixes. The roving tab stop left React entirely — it lives in a ref and two DOM writes, re-asserted
after each commit — taking pure navigation to **0.2 ms**. The object row became a module-level
`memo` component whose props are primitives plus a stable handlers *ref*, taking a selecting arrow
from **80 ms to 15 ms**. Marginal cost is now **~14 µs per row** (15.4 ms at 199 rows against 12.8 ms
at 12), so the cost is a fixed floor rather than a function of row count, and windowing at 250 rows
would buy under a millisecond. Deferred on evidence rather than on the original assumption.

**Evidence.** `@grapix/editor-web` **339/339** (+57: 14 projection, 30 keymap, 13 focus); repo
`typecheck` and `check:boundaries` clean. Live on an isolated pair (4111 + 5199) with a **200-object**
fixture inserted through the real Insert menu, data root deleted after: `role="treegrid"`,
`aria-rowcount` 202 for 201 rows plus the header, 7 `columnheader`s, 201 `rowheader`s, 1,203
`gridcell`s, and **exactly one tab stop** at every point in the pass. Keyboard-only: Down/Up, Left/Right,
Home/End, Ctrl+Home/Ctrl+End; the band collapsed with Left on its first cell and reopened with Right;
plain Down selected one row and two Shift+Downs made a run of three, which Ctrl+Down then left intact;
Space hid and showed; F2 typed a new name and Enter committed it **and returned focus to the owning
cell**; Delete removed the row and landed on its successor **in the same column**; filtering the list
from 198 rows to 11 and back **never moved the caret out of the search box**. A mask added live
reported `aria-level` 3, contiguous cells 0–4, `aria-colspan` 3, and made its owner claim children.
Drag reorder, click/Shift-click/Ctrl-click selection and `material-drop-blocked` all still hold after
the row extraction.

### P4 as planned — 2–4 d

**Work.** The grid becomes a `treegrid`: `aria-multiselectable`, `aria-colcount`/`aria-rowcount`;
`columnheader` on header cells; `aria-rowindex`/`aria-level`/`aria-posinset`/`aria-setsize` on data
rows; `aria-expanded` only on rows that really reveal children; `rowheader` on the name cell,
`gridcell` elsewhere, `aria-colspan` on the mask value cell to match its CSS span, and
`aria-readonly` on an unsupported cell instead of a bare em dash. Exactly one tab stop: the active
cell. `tree` cannot express editable columns, `table` leaves every inner control in the tab sequence,
and a flat `grid` loses hierarchy — hence `treegrid`.

Keyboard, panel-scoped, in a pure keymap reducer: Up/Down move rows keeping the column; Left/Right
move cells, and on a first cell collapse/expand the row instead; Home/End are row-scoped and
Ctrl+Home/Ctrl+End column-scoped; Shift+Up/Down extend from the anchor over object rows only;
Ctrl+Space toggles membership; Shift+Space takes the range; **Ctrl+A and Escape use P1's definitions
verbatim** — Ctrl+A over the search match set, Escape consumed in navigation mode to clear the
selection; Space toggles visibility; Enter/F2 begins rename or numeric edit, where arrows then belong
to the input; Delete acts only with focus inside this panel and never inside an input or a live edit.
`Ctrl+Alt+A` and `Ctrl+Alt+C` are never intercepted, and the Timeline's arrow/Home/End ownership on
its own tick row is untouched.

Focus rule: **nearest surviving logical target, never steal focus.** After a delete: same column,
next visible object row, then previous, then the focusable empty state. On scene close, the panel
heading. On re-dock, restore the active cell only if the panel had focus when docking began. A
keyboard commit returns to the owning cell; a pointer commit never pulls focus off the pointer's
target.

**Virtualisation is deferred until an expanded tree exceeds ~250 rows** — at 20–80 objects even ten
columns is 200–800 cells, which is not evidence for a variable-height tree virtualiser, and windowing
makes range selection and auto-scroll-during-drag materially harder. P1 already removed the playhead
fan-out, so the remaining cost is DOM size. When it is justified by a recorded measurement,
virtualise the flattened *visible* rows, keeping expanded ancestors, masks, the selected row and the
focused row mounted.

**Exit gate.** Headless: the whole key map as a table-driven reducer test, asserting consumed vs
not-consumed and no-ops at bounds, with no Left/Right hierarchy-versus-cell collision, and Ctrl+A
and Escape matching P1's suite rather than a second definition; the focus resolver for delete, scene
close, removed column and no-steal. Live, with a 200-object fixture: keyboard-only navigation,
selection, rename and delete; one accessibility-tree inspection confirming roles, one tab stop,
`aria-selected` and `aria-expanded`; and a recorded row count and frame time if virtualisation lands.

## 5. Agreed disagreements and resolutions

| Question | Resolution | Reason |
| --- | --- | --- |
| Where does selection live — `editorStore` or `uiStore`? | `editorStore`, with `selectedObjectId` keeping its name as the active member. | The constraint is that selection never enters `SceneDocument`, not that it lives in `uiStore` — and it never has. Only `editorStore` can prune in the same `set` as the mutation that invalidated the selection; a `uiStore` copy needs a reconciling effect and therefore one painted frame in which the alignment toolbar counts dead ids. |
| Keep both selections and reconcile them properly? | No. `selectedPathObjectIds` is deleted, with no alias. | It does not reconcile, it accumulates: nothing clears it, and its name cements a path-tool concept as the application's selection model. |
| Is the primary axis layer bands or the object hierarchy? | Bands stay the outer partition; the hierarchy inside them is made honest (F9) and collapsible (F13), and band chrome collapses to nothing when a scene has one layer. | A subtree always lives in one band because adoption propagates `layerId`, and all three renderers sort `layerId` before depth — so bands are the real compositing partition, not a view preference, and a hierarchy-first projection would show an order that is not the order that renders. The authoring complaint under it is *finding things*, which F9, collapse and search fix directly. The repository's own evidence says one band is the normal case: every new object starts in `main`, design import puts every node in `main` and orders with `zIndex`, and both committed scene fixtures are entirely `main` — so the one-band concession is the common path, not a fig leaf. There is no checked-in production corpus, so this is repository evidence, not a production statistic. |
| Should `zDepth` animation be removed outright? | No — removed for 2D types, kept for meshes. | The engine animates a mesh's `zDepth` as a real Z translation and is right to; it discards it for quads and texts and is right to. A blanket removal would delete a working capability, and the durable note that "`zDepth` is deliberately not animated" is broader than the code it describes. |
| Virtualisation before or after semantics? | After. Cell memoisation is P1 work; virtualisation waits for a measured ~250-row threshold. | Virtualising a tree that cannot express a three-object selection optimises the wrong artifact, and windowing makes range selection and drag auto-scroll harder. Memoisation conflicts with nothing, is hours, and belongs in the phase that already touches every row — assigning it to two phases, as the draft did, means neither phase's gate would catch its absence. |
| Solo, as XPression and After Effects have? | Refused. "Hide others" / "Show all" over the selection instead. | The honest versions are a contract change or a canvas compositing change, both out of scope; the dishonest version writes `visible: false` across the scene and loses the author's real visibility on undo. |
| Per-column resize and a full-width spreadsheet? | One resizable **name** column. Property columns stay 72px. | The measured defect is the name at depth 6 (≈34px), not the value cells. Ten resizable columns multiply the template's complexity, and a second place computing that template is exactly the header/body misalignment this panel already fixed once. |
| Rename the dock id and the `scene-inspector-*` CSS to match "Object Manager"? | Not in this plan. Correct the stale module map in `memory.md`; treat the CSS rename as an optional atomic follow-up. | The dock id is a persisted protocol under `grapix-dock-layout-v3` and `sanitizeStacks` discards an unknown id, so a rename needs a read migration for a purely cosmetic gain. |
| Move the whole panel into `modules/object-manager/` first? | Extract the pure services first (selection, drop, tree projection, row model); split components when the panel is split. P1 is not gated on the move. | The pure modules are where the risk is and are the part a headless suite can pin completely; a directory move proves nothing on its own. |
| Should collapse, sort and column choice survive a reload? | Columns, column mode and name width persist under `grapix-object-manager-v1`, delivered and gated in P3. Collapse stays session-scoped. | Author *preferences* are expected to persist; collapse is cheap to redo, and a per-scene collapse map adds a stale-id pruning surface for little gain. Note that today none of it survives a reload, contrary to the code comment. |
| Global Delete for convenience? | No. Panel-scoped, guarded on focus and never inside an input. | The durable rule against global Delete crossing panel ownership exists because it already went wrong, and in a broadcast UI a destructive key outside the active panel is a lost scene. |

### Dissents recorded, not resolved

The authoring seat ratified the axis ruling and dissented twice on D1. Both dissents are real
risks; both prescriptions were judged worse than the risk.

| Dissent | Chair's ruling | Reason |
| --- | --- | --- |
| A `zDepth`-animated mesh whose material can blend should be **refused at authoring time**, because the engine does not re-sort and a transparent surface animating through another composites in prepared order (`animation.rs:544-547`). | Not refused. Reported as a **preflight warning** naming the meshes. | The renderer does not *ignore* the animation — it applies it and may composite it wrongly where transparency overlaps, which is a fidelity caveat, not the "authored option the renderer ignores" defect class that D1 fixes. And blend-capability is a property of the *material*, editable long after the animation was authored, so an authoring-time gate would retroactively invalidate correct work whenever a material changed. A warning at the moment of packaging is the point where the author can still act. |
| A legacy 2D `zDepth` channel should be a preflight **error that blocks packaging**, since warnings do not clear `ok` (`Shared/shared-types/src/index.ts:4288-4294`; `Editor/services/project-api/src/index.ts:1125-1133`). | Warning, naming every affected object; never silently stripped. | The evidence about severity is correct and is why the plan now says *warning* explicitly rather than "reported". But after P0 the channel is inert in Preview **and** Program, so the scene renders identically in both — the harm is a dropped intention, not a wrong picture. Blocking a package for an inert legacy channel would stop a show for a cleanup that changes no pixel. |

## 6. Final objection check

Promotion of this work is refused while any of these is true:

- a 2D object can acquire a `zDepth` stopwatch **in any panel**, or a legacy 2D `zDepth` channel is
  evaluated in Preview, or is stripped without being reported;
- a mesh can no longer animate `zDepth`;
- the animatability rule is duplicated anywhere, or lives where package preflight cannot reach it,
  or disagrees with `animation.rs` property-by-property;
- `selectedPathObjectIds` still exists, or any surface can hold a selection the panel cannot show;
- the active object is not always a member of the selection — including immediately after add,
  duplicate, delete, undo, redo and every scene-lifecycle path — or a selection survives the
  deletion of its members into a painted frame;
- a Timeline row click destroys a multi-selection that contains the object clicked;
- Ctrl+A or Escape behave differently in the keyboard reducer than in the gesture table;
- a toolbar command acts on one object while several are selected, or a drop, a scrub, a reorder or a
  visibility toggle produces no undo entry;
- a drag can attempt an illegal drop and silently do nothing, or the panel decides legality with its
  own copy of the container rules;
- a group can be moved to another band leaving descendants behind, or a move can carry a locked
  descendant;
- any of selection, collapse, sort, solo or column width reaches `SceneDocument`;
- the grid has more than one tab stop, Delete fires from outside the panel, or a row's selected state
  and depth are unannounced;
- a single selection renders differently than it did before D2;
- virtualisation lands without a recorded measurement justifying it.

When those hold, the panel lists what the scene contains, acts on what the author selected, and
authors nothing the renderer will ignore.
