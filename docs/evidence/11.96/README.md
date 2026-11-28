# 11.96 Layout dropdown and Layouts dialog: decisions

Built 24 Nov 2026 (`Editor/src/layout-switcher.ts`, `layout-bridge.ts`, `layout-switcher-view.ts`). The three design choices were put to Jev and Laya before the code (`decisions-input.json`, answers in `jev-laya-decisions.json`; Jev `jev-1.14.0`, Laya `laya-multilingual`, `max_len=8192`, not truncated). Jev's numbers are confidences; Laya is uncalibrated, a second opinion.

| Question | Built | Jev | Laya |
|---|---|---|---|
| How the page's four-region layout travels in a saved workspace | carried in the workspace's view state beside the tree, checked on load (A) | A, 0.82 | A, 0.15 |
| Which layouts ship | only Design; the other names wait for the owner (A) | A, 0.96 | A, 0.60 |
| First run for someone who already arranged their panels | their arrangement becomes Design's session copy (A) | A, 0.76 | A, 0.73 |

They agree with what was built on all three.
