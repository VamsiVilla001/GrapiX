# Workspace Manager: first slice (23 Nov 2026)

The user shared `GrapiX_Workspace_Manager_Handoff.md` (dockable panels for the Editor and Playout) and asked
for a way to build it. This is what was built first, how it was checked, and what is still to do. Nothing in
this slice touches the page yet: it is the pure part (a tree of panels, the rules it must keep, the panel
registry, and reading and migrating saved layouts). The plan rows are 11.92 to 11.101, 2.29 and 12.12.

## How it is being built, and the decision

Jev and Laya were asked how to build it (`jev-laya-dock.json`; Laya `laya-multilingual`, max_len 8192, not
truncated). **Jev: build the model in house first and only look at a library if floating or pop-out windows turn
out costly (option C, confidence 0.88); Laya preferred in house throughout (option A, 0.51).** Both agreed on
the other three questions: replace the four-region layout and migrate stored layouts (Jev 0.96, Laya 0.68);
start with no new dependency and ask for approval only if a library is later wanted (0.93, 0.93); and build and
test a pure model before touching the page's renderer (0.93, 0.92). Adding a library such as Dockview would
need the user's approval, so none was added.

## What exists

| File | What it is |
|---|---|
| `Editor/src/dock-model.ts` | the arrangement as a tree of splits and tab groups, and every step: move a panel or a group (centre or a side), reorder tabs, close, focus, maximise and restore, resize dividers; each returns a new arrangement or a refusal that names why |
| `Editor/src/dock-validate.ts` | the saved-layout rules 1, 3, 4, 5, 7 and 9 of the hand-off, each named in words |
| `Editor/src/panel-registry.ts` | what each kind of panel may do; a registration that contradicts itself is refused; a panel this build cannot show is unavailable, with the reason |
| `Editor/src/workspace-manager.ts` | opening and closing against the registry, the placeholder list, and keeping a panel's view state (a secret is refused there) |
| `Editor/src/workspace-io.ts` | reading a layout strictly, migrating it, and converting the older four-region layout |

Not built yet (rows 11.94 onward): saved and named workspaces and their store, drawing the tree on the page
with drop zones, the selector and Layout menu, floating groups, pop-out windows, and the Playout side.

## How it was checked

- **133 tests** across five files (`Editor/tests/dock-*.test.ts`, `panel-registry`, `workspace-manager`,
  `workspace-io`), written to the hand-off's own list: centre drop makes a tab; a side drop makes the right
  split; a move never duplicates or loses a panel; a refused or cancelled move changes nothing it was given
  (inputs are frozen); closing the last tab collapses the group and the split; weights add up to one; a divider
  stops at the smallest size; maximise then restore gives the same tree; a layout from a build with more panels
  keeps them and names them.
- **Mutants: 136, all killed** (`tools/mutate_dock.py`). A first run of 109 killed 97 and left 12 alive; each
  was a real gap, now tested. After the review fixes below, 136 mutants (the 109 plus one that takes each fix back
  out) killed 135, and the one survivor, heights measured for other panels being applied in migration, now has a
  test that kills it.
- **A code review** (the `code-review` skill, high effort, on the five source files) found **10 real defects the
  tests had not**, each confirmed by a scratch run, and all fixed with a test:
  1. moving the whole main layout beside a floating group left two groups with one id;
  2. migrating the four-region layout could give two nodes one id (a torn-out panel's group, or a name the author
     had used);
  3. a panel id such as `constructor` passed as a known panel (and `__proto__` as an instance key replaced the
     prototype), and an alias lookup inherited the same way;
  4. rule 9 refused ordinary preferences named `bypass`, `compass` or `designTokens`;
  5. rule 9 refused a search for "Basic 3D" as if it were a credential;
  6. migration did not keep the width of a side dock the author had dragged (and put the timeline under the centre
     only; the page shows it across the whole width);
  7. moving a panel or group while another was maximised left what was moved out of sight;
  8. a secret nested deeper than the scan passed unchecked, so it is now refused as too deep;
  9. `movePanel` took a tab position that is not a number;
  10. an empty group could be moved, silently changing which tab the target showed.

## Jev and Laya on error handling and accuracy

The user asked for both. They were asked on **measured outcomes**: `facts.json` is what the real functions
returned for 31 calls (`tools/facts.ts` runs the code; nothing is typed by hand), and `controls.json` is what a
deliberately broken build returned for 24 of them (`tools/controls.py` applies one mutant, runs the facts, and
restores the source). Each outcome is an anonymous case with the rule it is held to; a real outcome and its broken
twin are never in the same batch (`tools/review_run.py`, answers in `jev-laya-review.json`, scores from
`tools/review_report.py` in `review-summary.json`).

| | real outcomes accepted | broken outcomes rejected |
|---|---|---|
| Jev (jev-1.14.0) | 30 of 31 | **14 of 24** |
| Laya (laya-multilingual) | 31 of 31 | **0 of 24** |

**They cannot be used to check that the code is right.** Jev rejected 14 of the 24 broken outcomes, and let
through some where the broken result says plainly that the step was not refused (a second singleton opened, a
panel docked beside its own group, a secret kept) or where the arithmetic is wrong (weights left unscaled, 0.82; a
split with one child kept, 0.82). Laya says yes to nearly everything (its answers sit at about 0.9 whatever the outcome). Jev
also rejected one real outcome that is correct (a drop above a group: weights 0.68, 0.16, 0.16). Their answers
were therefore **not counted as evidence** for any of the work. The correctness of this slice rests on the tests,
the mutants and the code review. The first try of this review used a weaker control (the same outcome put to a
different fact's rule); that was unfair to Jev because some of those rules were partly true, and Laya answered yes
to all 31 of them. It is kept as `jev-laya-review-run1.json`.

**What they did give.** On the words of the real refusals, Jev scored four low for naming the cause: a divider
moved by something that is not a number (0.42), text that is not a layout file at all (0.39), a panel type
registered twice (0.45), and a layout with a part of an unknown kind (0.27). The first and third are developer
errors that an author does not see; the second and fourth appear only for a damaged or foreign file, and use the
words "JSON" and "tabs or split". They are left, and listed here as the wording to improve when a layout import
window exists (11.96).

## What changes for the next Jev and Laya review

Use them for design questions and for the wording a person reads, as before. For "is it correct", the check is
tests, mutants and a code review by a reader that can run the code. Controls must be outcomes of broken builds.

## Still to do (rows)

11.94 saved workspaces and 2.29 the store; 11.95 drawing the tree with drop zones, dividers and keyboard moves
(the large step, and the one that touches the page); 11.96 selector and menu; 11.97 the isolation proof; then
11.98 to 11.101 and 12.12 (more workspaces, floating groups, pinned panels, pop-out windows, Playout).
