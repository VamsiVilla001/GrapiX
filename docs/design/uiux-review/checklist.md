# Review checklist, scoring and severity

Desktop broadcast software rules. A check that only makes sense for a marketing site does not
belong here.

## Scoring rubric (per module, 100 points)

| Area | Points | Full marks means |
|---|---|---|
| Task fit and usability | 20 | The module's job (see the inventory) takes the fewest steps; the common action is the obvious one; nothing shown before it can work; no duplicated command paths inside the module |
| Visual hierarchy | 15 | One focal point per panel; title, then values, then hints; the state that matters (selection, on-air, error) is the most visible thing |
| Layout, spacing, alignment | 15 | Everything on the SKWAD scale (4 / 8 / 12 / 14 / 16 / 20 / 24); labels and values align in columns; no wrap, overlap or clipping at 1280, 1440 and 1920 wide |
| Component consistency | 15 | Same button, tab, field, list row, chip and panel header as every other module; tokens, never raw colours; one control per job |
| Accessibility | 15 | WCAG 2.2 AA: text contrast 4.5:1 (3:1 for 18 px+ and UI parts), visible focus on every control, logical tab order, every control named, 24 × 24 px targets, status changes announced (`aria-live`), no meaning by colour alone |
| Typography | 10 | Manrope 500 for UI at 11 to 13 px, JetBrains Mono for values, ids, timecode and logs, Anybody only for display (TAKE, clock); tabular figures; no all-caps body text |
| States and error prevention | 10 | Empty, loading, disabled (with the reason), error and success states exist; refusals name their condition (invariant 17); destructive actions are armed or confirmed |

Score = sum. Report sub-scores. 90+ excellent, 75 to 89 good, 60 to 74 needs work, under 60 poor.

## Severity

| Level | Meaning | Examples |
|---|---|---|
| S0 Blocker | Risk to air, data loss, or a workflow cannot be completed | A safety warning can be hidden; Take reachable without operator; Delete with no undo |
| S1 Critical | Work is badly slowed or error-prone for every user of the module | Top bar wraps and covers controls at 1440 px; refusal text is a raw OS error |
| S2 Major | Clear usability, consistency or accessibility failure | Contrast below AA; two different button styles for one job; no focus ring |
| S3 Minor | Friction or inconsistency with a workaround | Label misaligned; spacing off-scale by a few px |
| S4 Polish | Cosmetic | Icon optical alignment |

## Checklist by area

### Task fit
- [ ] The module's primary action is visible without scrolling at 1440 × 900.
- [ ] Commands appear once per surface; a command in the menu bar, ribbon and panel uses the same label and the same command id (`data-menu-item`).
- [ ] Controls that cannot work yet are disabled and say why (plan row), not hidden or silently inert.
- [ ] Destructive commands (delete, clear, take out, discard) are visually distinct and armed or confirmed.
- [ ] Keyboard shortcuts exist for frequent actions and are shown in menus and tooltips.
- [ ] Editor shows no Program, take or output control (invariant 4). Playout transport is held without an operator (row 2.15).

### Hierarchy
- [ ] Panel header (title) → section label (caps, ink-3) → values (ink) → hints (ink-3 / ink-4).
- [ ] Selection uses ember tint plus a 2 px ember edge; on-air uses brand ember `#F15A29` only in Playout; critical keeps its own red `#FF5F56`.
- [ ] Status chips pair colour with a word.

### Layout and spacing
- [ ] Panel padding 8 or 12; row height 24 (lists) or 26 (fields); header 28; menu bar 28; top bar 40; ribbon 36; activity bar 28.
- [ ] Label column 88 px in inspector rows; values left-aligned in one column.
- [ ] Nothing wraps, overlaps or clips at 1280, 1440 or 1920 wide; overflow goes to a menu or scroll, never on top of other controls.
- [ ] Splitters and docking keep the viewport usable (minimum sizes from `panel-registry.ts`).

### Consistency
- [ ] One Button (Default, Primary, Ghost, Danger), one IconButton, one Tab, one Input, one Select, one FieldRow, one ListRow, one Chip, one PanelHeader across both apps.
- [ ] Colours come from `--sk-*` tokens in `skwad.css`; flag every raw hex.
- [ ] Icons from `Editor/web/icons` (Phosphor regular 2.1.1 plus the GrapiX stroke set), 16 px in 26 px buttons.

### Accessibility (run axe-core, then check by hand)
- [ ] axe-core: zero serious or critical violations.
- [ ] Focus visible (`:focus-visible` 2 px ember outline) on every interactive element, including canvas tools and timeline rows.
- [ ] Tab order follows the visual order; no keyboard traps in menus or dialogs; Escape closes menus and dialogs.
- [ ] Icon-only buttons have `aria-label`; toggles use `aria-pressed`; menus use `role="menu"` / `menuitem`.
- [ ] Live status (`connectionState`, severity band, activity) is announced.
- [ ] Targets at least 24 × 24 px; ribbon buttons 26 × 26.

### Typography
- [ ] UI 12 px Manrope 500, captions 11, labels 10 caps with 6 % tracking, titles 13 semibold.
- [ ] Values, ids, hashes, timecode, logs in JetBrains Mono with tabular figures.

### States
- [ ] Empty state says what to do next in one line.
- [ ] Loading shows progress or "Drawing…" with the engine as the subject.
- [ ] Errors keep the refusal's name and add a plain-language next step; raw OS errors go behind a "details" disclosure.

## Unnecessary complexity: what to look for
- The same command in the top bar, the panel and the menu with different labels.
- Fields that belong in Settings or a dialog shown permanently in a panel (for example endpoints).
- Two panels that show the same object list.
- Toolbars wider than their panel, forcing horizontal scroll.
- Explanatory paragraphs where a tooltip or one line would do.
