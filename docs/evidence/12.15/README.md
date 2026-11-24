# 12.15 bulk Cue ID suggestion: decisions

Slice 1 built 24 Nov 2026 in `Shared/contracts/src/cue_suggest.rs`. The two design choices below were made while coding and put to Jev
and Laya afterwards (`decisions-input.json`, answers in `jev-laya-decisions.json`; Jev `jev-1.14.0`, Laya `laya-multilingual`,
`max_len=8192`, not truncated). Jev's numbers are confidences; Laya is uncalibrated, a second opinion.

| Question | Built | Jev | Laya |
|---|---|---|---|
| What confirming does | recompute, apply only the identical clean plan, all or nothing (A) | A, confidence 0.98 | C (apply as shown, no recompute), 0.11 |
| A suggestion that collides | a refused line naming the holder (A) | A, confidence 1.0 | B (skip to the next free number), 0.30 |

**They disagree on both.** The built behaviour stands for now: C would apply a plan made against a show that has changed since (a cue
on air could be renamed), which the row's "nothing is renamed before confirmation" and 1.13's on-air lock rule out. B is a fair
operator convenience; it is listed as open in the plan row ("the first free number for a prefix") and is put to the user.
