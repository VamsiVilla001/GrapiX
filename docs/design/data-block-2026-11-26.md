# The Data block: Hide when empty, the record check, Auto-fit (row 11.153), 26 Nov 2026

What Figma B2v2 and B4 draw and the Editor does not yet: on an element bound to data, **Auto-fit** and **Hide when empty** buttons and a
warning "Record 17 overflows its plate by 64 px"; in the Data screen the **Test records** table (FITS, OVERFLOWS, EMPTY per record) and
**Checks** with a FIX button. A broadcast graphic is a template an operator fills live, and names vary in length, so this is the
check that stops a long name running off its plate on air.

## Decided (Jev A on all three at 1.0; Laya differed at 0.004 to 0.04, flagged; `docs/evidence/11.153/jev-laya-data-block.json`)

1. **Hide when empty** is an optional boolean on the object, set by an object edit. When an element's bound value is missing, null or
   only whitespace, the engine does not draw it. An unbound element is unaffected; setting it on an element with no binding is refused
   by name.
2. **The record check is the engine's.** One request takes the scene and a list of records, resolves each bound text with the record,
   shapes it in the element's box with the same shaping the renderer uses, and returns per record and element one of **Fits**,
   **Overflows** (by how many px and lines), **Empty**, **Missing** (the field is not in the record). The Editor shows the answer and
   never computes one, so the check cannot disagree with what is drawn.
3. **Overflow** means the shaped text is larger than its box in a direction its layout does not grow: paragraph text needs more height
   than the box (a word wider than the box is broken by letter, as the engine draws it, so it shows as height); point text is wider than the box. An element that grows or shrinks to fit (once
   drawn, row 11.51) does not overflow while it can still fit.

## Split

| Slice | Who | What | Done when |
|---|---|---|---|
| A | claude (done) | `hideWhenEmpty` on the object contract, an `ObjectField` to set it (refused on an unbound element), drawability and the renderer honouring it, history label, codegen | a bound element with an empty value is not drawn on CPU, DX12 and Vulkan; refusal named |
| B1 | claude | the fit report as a contract and a pure function in the worker: `FitRequest {scene, records}` to `FitReport` (per record, per bound text: Fits, Overflows {px, lines}, Empty, Missing) using the renderer's shaping | unit tests on shaped text; one overflowing and one empty record named |
| B2 | claude | the request on the control plane and a read-only shell command, so the Editor can ask | the Editor service answers for the open scene |
| C | claude | records: the scene's sample data as one record now; a CSV kept in the project (the decided `Data/` copy, slice 3 of task 121) next | 48 records read; 1-based row numbers |
| D | claude | the Editor: Auto-fit (the existing `autoFit` choice, dimmed with the engine's reason until 11.51 draws it) and Hide when empty buttons in the card's Data block; the Test records table, Checks and FIX in the Data screen; the overflow line in the card and the Publish row | seen in a real window with a CSV of 48 records, one overflowing, one empty: 46 FIT, 2 to fix, each named |

**Slice A built, 26 Nov 2026 (claude, codex's limit being used up):** `ObjectBase.hideWhenEmpty` (optional, absent is false),
`ObjectField::HideWhenEmpty` (on only where the element has a text or image binding, refused by name otherwise; off always works and
leaves the field out of the wire), the resolver (`gx_contracts::bindings`): a missing, null or blank text or image value hides the
element in the resolved scene and keeps its authored value, it is not a binding issue, and a path through a scalar or a bad asset name is
still a fault; the Editor's resolver (`Editor/src/bindings.ts`) holds the same answers through three new cases of
`fixtures/binding-resolution.json`; the card's Data block has a Hide when empty button (and Auto-fit, dimmed with the engine's reason
until 11.51), and Properties a Data section with the checkbox. CPU witness in `prepared.rs`: the resolved scene drives every backend.

Slice D starts when B2 is built (A is). Codex's limit being used up (26 Nov), claude took B1, B2 and C as well. Until then the Editor draws none of it and says nothing is measured
(`DATA_RECORDS_NOTE` in `Editor/src/data-panel.ts`): no FITS that was not measured.
