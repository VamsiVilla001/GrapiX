## OMP session import (tools/omp-import)

The OMP agent's own transcripts for this repository lived only in
`~/.omp/agent/sessions/--D--Project KK-Personal projects-GrapiX--` — 27 JSONL
files, 288 MB, 2026-07-29 to 2026-09-14 — and were invisible to Claude Code.
`tools/omp-import/omp_import.py` rewrites them into Claude Code's transcript
format under `~/.claude/projects/D--Project-KK-Personal-projects-GrapiX`, so
the earlier build history is readable and searchable from the session list.

The mapping is recorded in `tools/omp-import/README.md`. The parts worth
keeping in mind: OMP's `toolCall`/`toolResult` pair becomes `tool_use` plus a
`tool_result` linked by `tool_use_id`; `image` blocks are resolved out of the
OMP blob store into base64; `compaction` becomes an `isCompactSummary` record;
runtime metadata (`model_change`, `ttsr_injection`, `credential_pin`, tool
execution starts) is dropped. Session ids are OMP's own UUIDv7s and record
uuids are uuid5-derived from them, so a re-run rewrites an already-imported
session byte-identically instead of duplicating it — run it again whenever OMP
does more work here.

Imported sessions are for reading, not resuming: thinking blocks keep their
text but not the originating provider's signature, and the tool names are OMP's
own, so replaying one through the Anthropic API would be refused.

**The trap that cost the first import.** Stamping each output with its source's
real mtime looked like the way to keep the session list ordered, and Claude
Code deleted 18 of the 27 transcripts within minutes: it prunes anything older
than `cleanupPeriodDays` (30 by default), and these sessions date back to July.
The importer now stamps a recent window one minute apart in source order, which
orders the list identically and survives cleanup; `--preserve-mtime` restores
true dates for anyone who raises the retention setting first.

### Verified by execution

| What | Result |
|---|---|
| `python tools/omp-import/omp_import.py` over all 27 sessions | **27 transcripts written**, 96 MB; 305 user turns, 20,629 assistant messages, 21,161 tool results, 405 meta records |
| image recovery from the OMP blob store | **163 of 163** resolved, 0 unrecoverable |
| built-in validation pass | **OK** — every record parses, no `tool_result` without its `tool_use`, no duplicate uuids, no `parentUuid` referencing an unseen record |
| idempotency check (re-converted session compared by SHA-256 against the installed file) | identical |
| session store after the mtime fix | **27 imported + 8 pre-existing transcripts present**, none pruned |

No GrapiX source, build or test surface was touched by this step.

---

