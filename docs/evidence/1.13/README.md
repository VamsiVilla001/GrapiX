# 1.13 identifiers contract: decisions

Built 24 Nov 2026 in `Shared/contracts/src/ids.rs`. The three design choices below were made while coding and put to Jev and Laya
afterwards, on the user's request the same day (`decisions-input.json`, answers in `jev-laya-decisions.json`; Jev `jev-1.14.0`, Laya
`laya-multilingual` at `max_len=8192`, not truncated). Jev's numbers are confidences. Laya is uncalibrated zero-shot: a second opinion.

| Question | Built | Jev | Laya |
|---|---|---|---|
| Two Cue IDs the same? | without regard to case (A) | A, confidence 0.86 | A, confidence 0.10 |
| Characters | any script with marks, digits, `. - _`, no space, NFC (A) | A, confidence 0.96 | A, confidence 0.25 |
| Rename `takeId` on the wire | not now (A) | A, confidence 0.86 | A, confidence 0.01 |
| Contract row done without screens | yes | yes, 0.77 | yes, 0.96 |

They agree with what was built on every question. The tests and mutants are in the plan row.
