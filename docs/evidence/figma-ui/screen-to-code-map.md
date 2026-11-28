# Figma UI to code: implementation map (24 Nov 2026)

Saved from the read-only mapping agent's final report. The full text, with all 30 screens, is in that agent's hand-back in this session. The parts below drive the build.

Design source: branch `claude/vibrant-bassi-6cce4b`, `docs/design/` (spec, summary, review, plans, wireframes and 30 PNGs; P2, P6, B7, B8, B10 and B11 were not exported). Figma file `gyGkmEFX4oAuknNNI4dq9k`: the MCP call limit has lifted (`get_variable_defs` on 34:218 worked).

## Tokens
- **Colours already match:** every Figma colour, radius and spacing variable equals `Editor/web/skwad.css` lines 20-42. The Playout copy is identical.
- **Missing tokens:**
  - `--sk-viewport` #000000 and `--sk-key` #f58138
  - info blue: #5aa9e6 border, #112130 tint, about #3f76a2 text. Playout hard-codes `--info:#6fb3d9`.
  - on-air row #603a21, on-air monitor #362119, timeline bar #393e6a
- **Type** (Figma `sk/*` styles):

  | Style | Font | Size / line | Notes |
  |---|---|---|---|
  | wordmark | Manrope 800 | 18/22 | -2% |
  | title | Manrope 600 | 13/18 | |
  | body | Manrope 500 | 12/16 | |
  | body-strong | Manrope 600 | 12/16 | |
  | caption | Manrope 500 | 11/14 | |
  | label | Manrope 600 | 10/12 | 6%, upper case |
  | mono | JetBrains Mono 500 | 11/16 | |
  | mono-small | JetBrains Mono 400 | 10/14 | |
  | timecode-sm | JetBrains Mono 700 | 12/16 | ember |

  Today the Editor body is 13/1.5 with 80 rules at 12px and stray sizes; Playout is 13/1.45.
- **Radii:** 5px is not a token (7 rules). Hard-coded hex values: 35 in the Editor CSS, 4 in Playout.
- **Sizes:** menu bar 28, ribbon 40, bottom bar about 30. Left panel about 200 and right about 330 in the PNGs (the spec ledger says 300/300). Collapsed timeline strip about 68, expanded about 470. Playout bar 38, band 24, Scenes 250, Inputs 330, Playline row 28.

## Order
- **Phase A, foundation:**
  - A1 tokens, type styles and the 12/16 base
  - A2 terms table (11.127)
  - A3 shared pieces: panel header, field row, chips, armed and hold-to-confirm buttons, slim tab with alert dot, band
- **Phase B, Editor:**
  - B1 menu bar and context line (needs C-1)
  - B2 ribbon
  - B3 layout dropdown and the E2 dialog (wire `workspace-presets.ts` to `cmd_workspace_*`)
  - B4 More bar and status line
  - B5 B2 layout
  - B6 B2 card and the S1 empty states
  - B7 S2 font band
  - B8 B3 toolbar and columns
  - B9 B3 keyframe panel and B3d properties
  - B10 B3c graph
  - B11 E1 Ctrl K
  - B12 B1 Start
  - B13 B6 Publish, step chips and Fix next issue
  - B14 B5 effect cards and C4
  - B15 E4 Settings, General and Shortcuts
  - B16 B4 Data with a local CSV
  - B17 B13 Library
- **Phase C, Playout:**
  - C1 shell and connect dialog
  - C2 Playline on the existing cue, take, phase and clear commands with an in-memory CueTable
  - C3 monitors
  - C4 PS1 and PS2
  - C5 PD diagnostics
  - C6 P3 typed inputs
- **Phase D, waits on backend:**

  | Screen | Waits on |
  |---|---|
  | Scene Bank | 12.2 |
  | Show save and open | 12.3, 6.4, 6.9, 12.18 |
  | P7 Stacks | 12.10, 12.13, 12.14 |
  | P5 Airview | 12.17, 3.24 |
  | P4 Cue Control | 6.7, 6.8, 12.16, 12.20 |
  | P8 Play Rules | 6.10, 6.6 |
  | B12 Logic | 16.4, 11.55, 11.145, 11.146 |
  | B9 Formats | 11.123 |
  | Charts | 11.137-11.142 |
  | E3 Ask | 8.14, 11.147, 11.148, 13.7, plus a model connection no row covers |
  | B4 live data | 19.x |

## Conflicts (questions for the user)
1. **C-1:** six menus in Figma (File, Edit, Graphic, Publish, View, Help) or row 11.32's eight (File, Edit, Project, Motion, Panels, Layout, Utilities, Help)? `TOP_LEVEL` and its tests enforce eight.
2. **C-2:** Playout has no menu bar in Figma, but 12.22 wants a Panels menu.
3. **C-3:** the UI says CUE, CUE OUT and PRELOAD; the wire says `take` and `cue`. The likely mapping is PRELOAD → cue, CUE → take, CONTINUE / HOLD / UPDATE / CUE OUT → phase, CLEAR → clear.
4. **C-4:** the spec says Take ID; 1.13 says Cue ID.
5. **C-5:** layer range 1-99,999 or ±99,999? Is the transition set per layer or per take?
6. **C-6:** the Moments and Cast strips are in the spec and summary but not in the PNGs. Drop them?
7. **C-7:** no plan row owns the step chips or Fix next issue.
8. **C-8 / C-9:** the Phases controls and the motion-preset UI under keyframes-only (11.131).
9. **C-10:** layout names differ between E2, 11.76, 11.35, 11.98 and the spec. Where are layouts stored?
10. **C-11:** the Effects button says 322 effects; 11.69 says 306.
11. **C-12:** "no material manager", but the 11.12 Materials panel exists.
12. **C-13:** show all four track-matte modes?
13. **C-14:** panel widths 200/330 (PNGs) or 300/300 (spec)?
14. **C-15:** a substitute font is shown, but the contract says "never a fallback".
15. **C-16:** B4 and PD assume the Data Hub (19.14 undecided). Build with local CSV only?
16. **C-17:** the E4 roles are not in the contracts; E3 has no row.
17. **C-18:** the white #ffffff dividers in the Editor PNGs: intended, or a Figma artefact?
18. **C-19:** info blue #5aa9e6 (Figma) or #6fb3d9 (Playout today)?
19. **C-20:** Scene ID "s-021" vs "1".
20. **C-21:** P4 command words vs 6.7.
21. **C-22:** "Scenes", "Scene Bank" or "Playout library"?
22. **C-23:** Prism shown disabled or hidden?
23. **C-24:** screen ids clash with plan ids.
24. **C-25:** missing exports (P2, P6, B7, B8, B10, B11, D1-D3).
