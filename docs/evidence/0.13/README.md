# 0.13 The tracker generated from the plan

Done 19 November 2026.

- `tools/sync-tracker.mjs`: `npm run sync:tracker` regenerates the rows and statuses embedded in `progress.html` from `GrapiX-Build-Plan.md` and `progress.json`; `npm run check:tracker` (in `npm run check`) fails on drift.
- Kept from the page: each module's title, note, milestone and side (the only copy of that wording), and the comments in the state block. A plan module the page lacks is an error.
- The check names: a changed row (name, track, needs, done-when), a missing, extra or reordered row, a row in another module, a changed status between `progress.json` and the page, and a status for a row the plan does not have.
- **Round trip over the files as they were:** one change, row 11.2's tracker text lacked the full stop after "fallback" that the plan has (real drift). A second round trip changes nothing; no status changed. 293 rows, 169 then 171 statuses.
- 9 tests in `tools/tests/sync-tracker.test.mjs`, including one that checks and regenerates the real files; mutants T1 to T8 (field, module, order, status, unknown status, comment, state-block additions) each failed a named test.
- `LLM-GOVERNANCE.md` steps 3 and 4: closing a row is a plan edit, a status edit and `npm run sync:tracker`, in one commit.
