# Build-plan review with Jev and Laya, 8 November 2026 (Claude, Panchayati #105)

User instruction, 8 Nov 2026: a Jev-vs-Laya comparison and decision-making pass over the
existing build plan, with disagreements and recommended plan changes brought to the user
before any plan row is edited.

## Method

1. `tools/digest_plan.py`: every row of `GrapiX-Build-Plan.md` with its phase, Needs, done-when and
   tracker state (`plan-rows.json`: 254 rows, 123 done, 16 active, 115 pending).
2. `tools/review_plan.py`: for each of the 131 open rows, the same four typed questions to Jev
   (`jev-1.14.0`) and Laya (`laya-multilingual`, `max_len=8192`, no truncation): is the done-when
   executable as written; when to work it given its Needs and their states; are the Needs right;
   the main risk. Per phase with open rows: is the order right, which row first. `plan-review.json`.
3. `tools/compare.py decision-plan-changes.json`: the two concrete changes from the done-row review
   (a transport scope-enforcement row; 5.5's done-when) put to both models. `plan-changes-jev-laya.json`.
4. A mechanical check beside the models: a row is `now` when every Need is done, `after_needs`
   otherwise, `external` on the EXT track.

## Agreement

| Question | Jev and Laya agree | Jev matches the mechanical check | Laya matches it |
|---|---|---|---|
| When to work the row | 68 of 131 | 124 of 131 | 64 of 131 |
| Done-when executable (both sides of 0.5) | 63 of 131 | | |
| Main risk | 18 of 131 | | |

Rows whose done-when both models call not executable as written (0): none.

Jev alone: 68; Laya alone: 0.

## The two plan changes

| Question | Jev | Laya |
|---|---|---|
| scope_row_placement | 5_7_transport | 14_x_remote (confidence 0.6582) |
| scope_row_urgency | 0.91 | 0.974 (confidence 0.974) |
| done_when_5_5 | capability_field | keep_as_is (confidence 0.8715) |
| reopen_5_5 | 0.81 | 0.9731 (confidence 0.9731) |

**User decision (8 Nov 2026): 5.7 in Phase 5 (Needs 5.2, 8.13) and the `capability_field` wording for 5.5.**
Jev's choice on both; Laya preferred Phase 14 (0.66) and keeping 5.5's wording (0.87). Both agreed the new row
comes before Phase 14 (Jev 0.91, Laya 0.97) and that 5.5 should return to active until its new done-when is
executed (Jev 0.81, Laya 0.97). Applied to `GrapiX-Build-Plan.md` (255 steps).

**Further user decisions (8 Nov 2026):** 5.5 returns to `active` until its new done-when is executed; the 68
done-whens Jev scored below 0.5 are rewritten to executable form, with user approval, when their phase opens
(no row edited today); the phase and row order stands (Jev's first-row picks match it; Laya's contradict
dependencies). Recorded in the plan's dated decisions paragraph.

## How to read the row results

Jev's `when` matched the mechanical dependency check on most rows; Laya answered `after_needs` for many rows whose
Needs are all done and `order_ok` for every phase, including one where it picked a row before the row it depends
on (3.19 before 3.17), so its ordering answers carry no weight here. Jev scored 68 done-whens below 0.5 for
executability, all in phases 9 and 12 to 19, where the plan's wording is a one-line intent ("Reduces the Adobe
dependency", "Same wrapper shape", "Any difference is explained or fixed"); Laya scored none below 0.5. The
lowest-scored done-whens are listed in the per-row table and are the rewrite backlog proposed to the user.

## Per phase

| Phase | Open rows | Jev: order ok / first | Laya: order ok / first |
|---|---|---|---|
| Phase P | 3 | 0.61 / P.1 | 0.913 / P.1 |
| Phase 0 | 2 | 0.77 / 0.3 | 0.9545 / 0.3 |
| Phase 3 | 4 | 0.45 / 3.17 | 0.9622 / 3.19 |
| Phase 4 | 1 | 0.86 / 4.5 | 0.7273 / 4.5 |
| Phase 7 | 1 | 0.77 / 7.3 | 0.3099 / 7.3 |
| Phase 8 | 3 | 0.52 / 8.1 | 0.9213 / 8.14 |
| Phase 9 | 5 | 0.39 / 9.1 | 0.8982 / 9.3 |
| Phase 11 | 33 | 0.15 / 11.1 | 0.9726 / 11.30 |
| Phase 12 | 8 | 0.3 / 12.1 | 0.9344 / 12.11 |
| Phase 13 | 8 | 0.5 / 13.1 | 0.7664 / 13.7 |
| Phase 14 | 8 | 0.42 / 14.1 | 0.9124 / 14.8 |
| Phase 15 | 13 | 0.34 / 15.1 | 0.6884 / 15.1 |
| Phase 16 | 13 | 0.25 / 16.1 | 0.7823 / 16.7 |
| Phase 17 | 9 | 0.45 / 17.1 | 0.9288 / 17.9 |
| Phase 18 | 10 | 0.65 / 18.1 | 0.934 / 18.9 |
| Phase 19 | 10 | 0.7 / 19.1 | 0.953 / 19.9 |

## Every open row

Probabilities are each model's P(done-when executable as written).

| Row | State | Mechanical | Jev when | Laya when | Jev exec | Laya exec | Jev risk | Laya risk |
|---|---|---|---|---|---|---|---|---|
| P.1 | active | external | external | after_needs | 0.54 | 0.93 | external_gate | none |
| P.2 | active | external | external | superseded | 0.37 | 0.96 | external_gate | superseded_by_direction |
| P.3 | active | now | now | after_needs | 0.60 | 0.90 | superseded_by_direction | none |
| 0.3 | active | now | now | after_needs | 0.75 | 0.93 | external_gate | superseded_by_direction |
| 0.4 | active | after_needs | after_needs | after_needs | 0.81 | 0.97 | missing_dependency | missing_dependency |
| 3.17 | active | now | now | now | 0.58 | 0.99 | scope_too_large | unclear_done_when |
| 3.18 | pending | after_needs | after_needs | after_needs | 0.77 | 0.95 | missing_dependency | unclear_done_when |
| 3.19 | pending | after_needs | after_needs | after_needs | 0.65 | 0.96 | scope_too_large | unclear_done_when |
| 3.21 | active | now | now | after_needs | 0.70 | 0.97 | external_gate | unclear_done_when |
| 4.5 | active | now | now | after_needs | 0.14 | 0.76 | superseded_by_direction | unclear_done_when |
| 7.3 | active | now | now | after_needs | 0.49 | 0.66 | unclear_done_when | superseded_by_direction |
| 8.1 | active | now | now | after_needs | 0.37 | 0.85 | none | none |
| 8.12 | active | now | after_needs | after_needs | 0.51 | 0.85 | scope_too_large | superseded_by_direction |
| 8.14 | active | now | now | after_needs | 0.65 | 0.95 | scope_too_large | unclear_done_when |
| 9.1 | pending | after_needs | after_needs | after_needs | 0.11 | 0.93 | unclear_done_when | superseded_by_direction |
| 9.2 | pending | after_needs | after_needs | after_needs | 0.19 | 0.96 | superseded_by_direction | unclear_done_when |
| 9.3 | pending | after_needs | after_needs | after_needs | 0.35 | 0.94 | external_gate | superseded_by_direction |
| 9.5 | pending | after_needs | after_needs | after_needs | 0.27 | 0.94 | missing_dependency | unclear_done_when |
| 9.7 | pending | after_needs | after_needs | after_needs | 0.25 | 0.92 | missing_dependency | superseded_by_direction |
| 11.1 | active | after_needs | after_needs | after_needs | 0.67 | 0.92 | missing_dependency | superseded_by_direction |
| 11.2 | active | after_needs | after_needs | after_needs | 0.40 | 0.88 | external_gate | unclear_done_when |
| 11.3 | active | after_needs | after_needs | rewrite_first | 0.47 | 0.89 | missing_dependency | unclear_done_when |
| 11.30 | pending | now | now | after_needs | 0.85 | 0.90 | missing_dependency | unclear_done_when |
| 11.31 | pending | after_needs | after_needs | after_needs | 0.50 | 0.94 | scope_too_large | unclear_done_when |
| 11.32 | pending | after_needs | after_needs | after_needs | 0.65 | 0.98 | missing_dependency | missing_dependency |
| 11.33 | pending | after_needs | after_needs | now | 0.65 | 0.97 | missing_dependency | unclear_done_when |
| 11.34 | pending | after_needs | after_needs | after_needs | 0.71 | 0.95 | missing_dependency | unclear_done_when |
| 11.35 | pending | after_needs | after_needs | after_needs | 0.66 | 0.93 | missing_dependency | missing_dependency |
| 11.40 | pending | now | now | after_needs | 0.72 | 0.89 | scope_too_large | superseded_by_direction |
| 11.42 | pending | now | now | after_needs | 0.77 | 0.88 | scope_too_large | unclear_done_when |
| 11.43 | pending | after_needs | after_needs | after_needs | 0.69 | 0.94 | missing_dependency | unclear_done_when |
| 11.44 | pending | after_needs | after_needs | after_needs | 0.69 | 0.97 | scope_too_large | unclear_done_when |
| 11.45 | pending | after_needs | after_needs | after_needs | 0.72 | 0.97 | missing_dependency | unclear_done_when |
| 11.46 | pending | after_needs | after_needs | after_needs | 0.66 | 0.97 | missing_dependency | unclear_done_when |
| 11.47 | pending | after_needs | after_needs | after_needs | 0.75 | 0.94 | scope_too_large | unclear_done_when |
| 11.48 | pending | after_needs | after_needs | after_needs | 0.57 | 0.91 | missing_dependency | unclear_done_when |
| 11.49 | pending | after_needs | after_needs | after_needs | 0.46 | 0.97 | missing_dependency | unclear_done_when |
| 11.50 | pending | after_needs | after_needs | after_needs | 0.59 | 0.91 | missing_dependency | superseded_by_direction |
| 11.51 | pending | after_needs | after_needs | after_needs | 0.59 | 0.95 | missing_dependency | unclear_done_when |
| 11.52 | pending | now | now | after_needs | 0.30 | 0.94 | scope_too_large | unclear_done_when |
| 11.53 | pending | now | now | after_needs | 0.57 | 0.93 | scope_too_large | unclear_done_when |
| 11.54 | pending | now | now | after_needs | 0.47 | 0.94 | scope_too_large | unclear_done_when |
| 11.55 | pending | after_needs | after_needs | now | 0.71 | 0.93 | scope_too_large | unclear_done_when |
| 11.56 | pending | after_needs | after_needs | after_needs | 0.60 | 0.97 | missing_dependency | unclear_done_when |
| 11.57 | pending | after_needs | after_needs | after_needs | 0.52 | 0.90 | missing_dependency | unclear_done_when |
| 11.58 | pending | after_needs | after_needs | now | 0.55 | 0.98 | missing_dependency | unclear_done_when |
| 11.59 | pending | after_needs | after_needs | after_needs | 0.65 | 0.97 | missing_dependency | unclear_done_when |
| 11.60 | pending | after_needs | after_needs | after_needs | 0.61 | 0.94 | missing_dependency | unclear_done_when |
| 11.61 | pending | after_needs | after_needs | after_needs | 0.72 | 0.95 | missing_dependency | unclear_done_when |
| 11.62 | pending | after_needs | after_needs | after_needs | 0.56 | 0.99 | scope_too_large | unclear_done_when |
| 11.65 | pending | now | now | rewrite_first | 0.65 | 0.98 | none | superseded_by_direction |
| 11.66 | pending | now | now | after_needs | 0.40 | 0.95 | unclear_done_when | unclear_done_when |
| 12.1 | active | after_needs | after_needs | after_needs | 0.28 | 0.97 | missing_dependency | none |
| 12.2 | pending | now | now | after_needs | 0.42 | 0.93 | scope_too_large | missing_dependency |
| 12.3 | pending | now | now | rewrite_first | 0.29 | 0.90 | unclear_done_when | unclear_done_when |
| 12.5 | pending | now | now | after_needs | 0.18 | 0.93 | unclear_done_when | none |
| 12.8 | pending | after_needs | after_needs | after_needs | 0.73 | 0.96 | missing_dependency | unclear_done_when |
| 12.9 | pending | after_needs | after_needs | now | 0.43 | 0.97 | scope_too_large | unclear_done_when |
| 12.10 | pending | now | now | after_needs | 0.67 | 0.98 | missing_dependency | missing_dependency |
| 12.11 | pending | now | now | after_needs | 0.69 | 0.97 | missing_dependency | unclear_done_when |
| 13.1 | pending | now | now | after_needs | 0.59 | 0.86 | external_gate | missing_dependency |
| 13.2 | pending | after_needs | after_needs | after_needs | 0.36 | 0.86 | missing_dependency | unclear_done_when |
| 13.3 | pending | after_needs | after_needs | after_needs | 0.33 | 0.93 | missing_dependency | unclear_done_when |
| 13.4 | pending | after_needs | after_needs | after_needs | 0.19 | 0.84 | missing_dependency | unclear_done_when |
| 13.5 | pending | now | now | after_needs | 0.55 | 0.85 | missing_dependency | unclear_done_when |
| 13.6 | pending | now | after_needs | after_needs | 0.46 | 0.83 | missing_dependency | missing_dependency |
| 13.7 | pending | after_needs | after_needs | after_needs | 0.34 | 0.93 | missing_dependency | unclear_done_when |
| 13.8 | pending | after_needs | after_needs | after_needs | 0.59 | 0.92 | missing_dependency | unclear_done_when |
| 14.1 | pending | now | now | after_needs | 0.37 | 0.78 | scope_too_large | superseded_by_direction |
| 14.2 | pending | after_needs | after_needs | after_needs | 0.18 | 0.82 | unclear_done_when | superseded_by_direction |
| 14.3 | pending | now | now | after_needs | 0.46 | 0.92 | unclear_done_when | unclear_done_when |
| 14.4 | pending | now | now | after_needs | 0.23 | 0.91 | unclear_done_when | unclear_done_when |
| 14.5 | pending | after_needs | after_needs | after_needs | 0.17 | 0.79 | missing_dependency | missing_dependency |
| 14.6 | pending | now | now | after_needs | 0.20 | 0.85 | unclear_done_when | unclear_done_when |
| 14.7 | pending | now | now | after_needs | 0.36 | 0.83 | unclear_done_when | unclear_done_when |
| 14.8 | pending | now | after_needs | after_needs | 0.39 | 0.90 | missing_dependency | unclear_done_when |
| 15.1 | pending | external | external | after_needs | 0.63 | 0.92 | external_gate | missing_dependency |
| 15.2 | pending | external | external | after_needs | 0.12 | 0.87 | external_gate | superseded_by_direction |
| 15.3 | pending | external | external | after_needs | 0.12 | 0.80 | external_gate | superseded_by_direction |
| 15.4 | pending | external | external | after_needs | 0.36 | 0.90 | external_gate | superseded_by_direction |
| 15.5 | pending | after_needs | after_needs | superseded | 0.28 | 0.86 | external_gate | unclear_done_when |
| 15.6 | pending | external | after_needs | after_needs | 0.61 | 0.94 | external_gate | superseded_by_direction |
| 15.7 | pending | external | external | after_needs | 0.61 | 0.91 | external_gate | unclear_done_when |
| 15.8 | pending | now | external | after_needs | 0.32 | 0.95 | external_gate | superseded_by_direction |
| 15.9 | pending | external | external | after_needs | 0.14 | 0.93 | external_gate | superseded_by_direction |
| 15.10 | pending | external | external | after_needs | 0.41 | 0.89 | external_gate | unclear_done_when |
| 15.11 | pending | external | external | after_needs | 0.34 | 0.92 | external_gate | superseded_by_direction |
| 15.12 | pending | external | external | after_needs | 0.75 | 0.98 | external_gate | unclear_done_when |
| 15.13 | pending | external | external | after_needs | 0.18 | 0.88 | external_gate | unclear_done_when |
| 16.1 | pending | after_needs | after_needs | after_needs | 0.11 | 0.77 | external_gate | unclear_done_when |
| 16.2 | pending | after_needs | after_needs | after_needs | 0.16 | 0.88 | superseded_by_direction | unclear_done_when |
| 16.3 | pending | now | now | after_needs | 0.20 | 0.90 | unclear_done_when | superseded_by_direction |
| 16.4 | pending | after_needs | after_needs | after_needs | 0.55 | 0.83 | missing_dependency | unclear_done_when |
| 16.5 | pending | now | now | after_needs | 0.08 | 0.75 | unclear_done_when | unclear_done_when |
| 16.6 | pending | now | now | after_needs | 0.22 | 0.89 | unclear_done_when | superseded_by_direction |
| 16.7 | pending | now | now | after_needs | 0.25 | 0.90 | unclear_done_when | superseded_by_direction |
| 16.8 | pending | after_needs | after_needs | after_needs | 0.36 | 0.87 | missing_dependency | unclear_done_when |
| 16.9 | pending | now | after_needs | after_needs | 0.24 | 0.86 | missing_dependency | none |
| 16.10 | pending | after_needs | after_needs | after_needs | 0.39 | 0.92 | external_gate | unclear_done_when |
| 16.11 | pending | after_needs | after_needs | now | 0.60 | 0.95 | missing_dependency | unclear_done_when |
| 16.12 | pending | after_needs | after_needs | after_needs | 0.60 | 0.75 | missing_dependency | missing_dependency |
| 16.13 | pending | after_needs | rewrite_first | after_needs | 0.22 | 0.88 | unclear_done_when | unclear_done_when |
| 17.1 | pending | now | now | after_needs | 0.22 | 0.96 | missing_dependency | none |
| 17.2 | pending | after_needs | after_needs | after_needs | 0.13 | 0.93 | missing_dependency | missing_dependency |
| 17.3 | pending | now | now | after_needs | 0.41 | 0.82 | missing_dependency | missing_dependency |
| 17.4 | pending | after_needs | after_needs | after_needs | 0.41 | 0.94 | missing_dependency | superseded_by_direction |
| 17.5 | pending | now | now | after_needs | 0.31 | 0.94 | missing_dependency | superseded_by_direction |
| 17.6 | pending | now | now | after_needs | 0.33 | 0.90 | missing_dependency | unclear_done_when |
| 17.7 | pending | after_needs | after_needs | now | 0.40 | 0.97 | missing_dependency | superseded_by_direction |
| 17.8 | pending | after_needs | after_needs | after_needs | 0.24 | 0.96 | missing_dependency | superseded_by_direction |
| 17.9 | pending | after_needs | after_needs | after_needs | 0.26 | 0.90 | missing_dependency | superseded_by_direction |
| 18.1 | pending | after_needs | after_needs | after_needs | 0.76 | 0.95 | external_gate | unclear_done_when |
| 18.2 | pending | now | now | after_needs | 0.62 | 0.97 | external_gate | superseded_by_direction |
| 18.3 | pending | after_needs | after_needs | after_needs | 0.68 | 0.97 | missing_dependency | superseded_by_direction |
| 18.4 | pending | after_needs | after_needs | now | 0.61 | 0.98 | missing_dependency | unclear_done_when |
| 18.5 | pending | after_needs | after_needs | now | 0.60 | 0.92 | missing_dependency | superseded_by_direction |
| 18.6 | pending | after_needs | after_needs | now | 0.54 | 0.91 | missing_dependency | superseded_by_direction |
| 18.7 | pending | after_needs | after_needs | after_needs | 0.29 | 0.89 | missing_dependency | superseded_by_direction |
| 18.8 | pending | after_needs | after_needs | after_needs | 0.54 | 0.95 | missing_dependency | unclear_done_when |
| 18.9 | pending | after_needs | after_needs | now | 0.66 | 0.93 | missing_dependency | superseded_by_direction |
| 18.10 | pending | after_needs | after_needs | after_needs | 0.59 | 0.96 | missing_dependency | unclear_done_when |
| 19.1 | pending | now | now | after_needs | 0.31 | 0.94 | scope_too_large | superseded_by_direction |
| 19.2 | pending | after_needs | after_needs | after_needs | 0.30 | 0.92 | missing_dependency | superseded_by_direction |
| 19.3 | pending | after_needs | after_needs | after_needs | 0.56 | 0.92 | missing_dependency | superseded_by_direction |
| 19.4 | pending | after_needs | after_needs | after_needs | 0.23 | 0.92 | missing_dependency | superseded_by_direction |
| 19.5 | pending | after_needs | after_needs | after_needs | 0.49 | 0.88 | missing_dependency | unclear_done_when |
| 19.6 | pending | after_needs | after_needs | after_needs | 0.51 | 0.97 | missing_dependency | superseded_by_direction |
| 19.7 | pending | after_needs | after_needs | after_needs | 0.59 | 0.89 | missing_dependency | superseded_by_direction |
| 19.8 | pending | after_needs | after_needs | after_needs | 0.31 | 0.93 | missing_dependency | unclear_done_when |
| 19.9 | pending | after_needs | after_needs | after_needs | 0.62 | 0.99 | missing_dependency | unclear_done_when |
| 19.10 | pending | after_needs | after_needs | after_needs | 0.36 | 0.94 | scope_too_large | superseded_by_direction |
