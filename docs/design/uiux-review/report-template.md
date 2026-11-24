# GrapiX UI/UX review — <YYYY-MM-DD>

- **Build:** `<branch>` at `<commit>`; Editor exe `<path>` (CDP 9333); Playout exe `<path>` (CDP 9334)
- **Widths captured:** 1280 × 720, 1440 × 900, 1920 × 1080
- **Tools run:** CDP helper ✓ · Playwright MCP ✓/not installed · Chrome DevTools MCP ✓/not installed · axe-core `<version>` ✓/not run · Impeccable ✓/not installed · UI/UX Pro Max ✓/not installed · Humbleteam Design Review ✓/not installed
- **Not reviewed and why:** <modules or states that could not be reached>

## 1. Summary

<Three sentences: overall state, the three lowest-scoring modules, the single most important fix.>

| Severity | Count |
|---|---|
| S0 Blocker | |
| S1 Critical | |
| S2 Major | |
| S3 Minor | |
| S4 Polish | |

## 2. Scorecard

| Module | Task fit /20 | Hierarchy /15 | Layout /15 | Consistency /15 | A11y /15 | Type /10 | States /10 | **Total /100** | design-review /4 | Δ since last |
|---|---|---|---|---|---|---|---|---|---|---|
| Editor · Start dialog | | | | | | | | | | |
| … | | | | | | | | | | |

## 3. Issues (ordered by severity, then reach)

At most six issues per module, ranked by impact; never padded. Before = an observable fact;
After = shippable in under an hour; Why = exactly one citation.

| ID | Sev | Module | Before (finding) | Evidence | Impact | After (component / selector → change) | Why (one citation) | Touches | Must not break |
|---|---|---|---|---|---|---|---|---|---|
| U-01 | S1 | Editor · Top bar | Scene id and name fields and eight buttons wrap into two overlapping rows below 1500 px | `shots/editor-topbar-default-1440.png`; `header.bar` 2 rows at 1440 | Save and Undo are covered while editing | `header.bar`: move scene id/name to the scene tab tooltip and Inspector; `flex-wrap: wrap` → `nowrap`; overflow buttons to `…` menu | Nielsen heuristic #8 - Aesthetic and minimalist design | `Editor/web/index.html`, `style.css` | `data-menu-item` ids on every button |

For each issue also give, when it is CSS-level:

```css
/* U-01 — Editor/web/style.css */
header.bar { flex-wrap: nowrap; gap: var(--sk-space-2); }   /* was: wrap; 6px */
```

## 4. Unnecessary complexity

| What | Where | Proposal | Saves |
|---|---|---|---|

## 5. Before-and-after plan

Batches can each be approved, built and re-tested alone.

### Batch A — <name> (issues U-xx, U-yy)
| | Before | After |
|---|---|---|
| Capture / design | `shots/…-before.png` | Figma node `<id>` or annotated capture |
| Files | | |
| Behaviour kept | | |
| Re-test | captures to replay; axe states; `npm run …` | |

## 6. Approval

> Which items do you approve? Reply with IDs (for example "approve batch A" or "approve U-01, U-04").
> Nothing in the source changes until you do.

## 7. Implementation and re-test log (filled after approval)

| ID | Status (verified / partly / reverted / not run) | After capture | axe Δ | design-review comparison (winner) | Checks run | New module score |
|---|---|---|---|---|---|---|
