# 11.31 Ctrl K search: decisions

Built 24 Nov 2026 (`Editor/src/command-search.ts`). The four design choices were put to Jev and Laya before the code (`ctrlk-input.json`, answers in `jev-laya-ctrlk.json`; Jev `jev-1.14.0`, Laya `laya-multilingual`, `max_len=8192`, not truncated). Jev's numbers are confidences; Laya is uncalibrated, a second opinion.

| Question | Built | Jev | Laya |
|---|---|---|---|
| Where Ctrl K works | anywhere, a text field included (A) | A, 0.60 | A, 0.14 |
| A result that cannot run | shown dimmed with its reason; Enter keeps the search open and says why (A) | A, 0.98 | B (hide it), 0.71 |
| How much is shown | search everything, a handful per group and a count of the rest, commands only when the box is empty (A) | A, 0.73 | A, 0.24 |
| A Help group | left out until the help system exists (A) | A, 0.30 | A, 0.43 |

Jev's confidence is low on two (Ctrl K from a text field, Help). They are the user's to change. Laya would hide a result that cannot run; it was not followed because the menus already show an unbuilt item dimmed with its row, and a result that disappears is a command a person cannot learn exists.
