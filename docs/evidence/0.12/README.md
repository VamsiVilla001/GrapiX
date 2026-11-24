# 0.12 Agent protocol files made context-efficient

Done 19 November 2026. Measured before: `memory.md` 540,634 bytes, and its first rule told every agent to read it.

## What changed
- `memory.md` is the working handoff: working rules, "Resume here", an index. 4.8 KB; `npm run check:protocol` holds it to 12 KB.
- The 162 dated entries are in `docs/log/` (26 day files, `undated-omp-session-import.md`, and `0000-memory-header-and-rules-before-0.12.md` for the old header and rules). `docs/log/MANIFEST.json` records each entry's heading, size and SHA-256 and the original file's SHA-256 (`540634` bytes). `node tools/memory-log.mjs --split` reassembled to the original before it wrote anything; `npm run check:log` (inside `check:protocol`) fails if an archived entry changes or goes missing and allows additions.
- Old rules 10, 11, 13, 14, 16, 17 and 19 to 29 are invariants 67 to 83 in `docs/invariants.md`, in their own words. Rules 8, 9, 12 and 18 were already invariants 8 and 9, 46, 56 and 21. Rules 1 to 7 and 15 are procedure, now in `AGENTS.md` and `memory.md`.
- The workspace rule is stated once, in `AGENTS.md`, with the working protocol (reading order, logging, the gate, the Panchayati lock, mutation testing, Jev and Laya, commit only when told, downloads, live checks). `CLAUDE.md` and `LLM-GOVERNANCE.md` point to it.
- `LLM-GOVERNANCE.md`: one status vocabulary (`done`, `active`, `blocked`, `pending`, mapped to Implemented, Partial, Planned, External gate); the "250 steps across 19 phases" count is gone.
- `docs/README.md` says history is in `docs/log/`.

## Evidence
- Reading cost: `AGENTS.md` + `LLM-GOVERNANCE.md` + `memory.md` is about 17 KB, roughly 5k tokens (the row asks for about 10k).
- `node --test tools/tests/memory-log.test.mjs`: 8 pass (split, filing by date, reassembly, verify finds a changed, missing and absent entry and allows additions, the real archive is whole, the protocol check names each way the files can drift).
- 16 mutants over `memory-log.mjs`, `check-protocol.mjs` and `sync-tracker.mjs`, one at a time, each failed a named test. Two survived first (a comment mentioning a row id; a one-digit month) and their tests were strengthened.
- `npm run check`: exit 0 (see the 19 November log).

## Not done
Reading cost was estimated from bytes, not measured with a tokenizer.
