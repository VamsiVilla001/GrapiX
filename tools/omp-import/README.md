# omp-import

Rewrites OMP agent session transcripts into Claude Code transcript files, so
past OMP work on this repository is readable and searchable from Claude Code's
session list.

```bash
python tools/omp-import/omp_import.py --dry-run   # list what would be converted
python tools/omp-import/omp_import.py             # convert and validate
```

Both directories are derived from `--project` (default: this repository's
Windows path) using each tool's own directory-slug rule:

| | |
|---|---|
| reads | `~/.omp/agent/sessions/--D--Project KK-Personal projects-GrapiX--/*.jsonl` |
| images from | `~/.omp/agent/blobs` |
| writes | `~/.claude/projects/D--Project-KK-Personal-projects-GrapiX/<session-id>.jsonl` |

Override either with `--omp-dir` / `--out`, and restrict a run with
`--only=<filename fragment>`.

## What is converted

| OMP record | Claude Code record |
|---|---|
| `message` role `user` / `assistant` | `type:"user"` / `type:"assistant"`, one record per content block sharing `message.id` |
| `toolCall` block | `tool_use` block (id, name and arguments preserved) |
| `message` role `toolResult` | `user` message holding a `tool_result` block linked by `tool_use_id` |
| `thinking` block | `thinking` block, provider signature dropped |
| `image` block (`blob:sha256:…`) | base64 `image` block resolved from the OMP blob store |
| `custom_message`, role `developer` | `isMeta` user record (system reminders, skill prompts, inter-agent messages) |
| `compaction` | `isCompactSummary` user record |
| `model_change`, `thinking_level_change`, `ttsr_injection`, `credential_pin`, `service_tier_change`, `custom` | dropped — runtime metadata with no counterpart |

OMP's `id`/`parentId` chain becomes a linear `uuid`/`parentUuid` chain. Titles
are prefixed `[omp] ` so imported sessions are distinguishable in the session
list. Tool output longer than 100,000 characters is truncated with a note.

Outputs are stamped with **recent** mtimes, one minute apart in source order —
not the sources' real ones. Claude Code deletes transcripts older than its
retention window (`cleanupPeriodDays`, 30 by default), and stamping months-old
mtimes gets the whole import silently pruned on the next cleanup; this was
observed, and cost 18 of 27 transcripts on the first run. The ordering of the
session list is preserved either way. Pass `--preserve-mtime` for true dates
only if `cleanupPeriodDays` is long enough to cover the oldest session.

Session ids are OMP's own UUIDv7 session ids and record uuids are uuid5-derived
from them, so **re-running is idempotent**: an already-imported session is
rewritten byte-identically rather than duplicated. Re-run after further OMP
work to pick up new and extended sessions.

Every run re-reads what it wrote and checks the invariants Claude Code relies
on — parsable records, no `tool_result` without its `tool_use`, no duplicate
uuids, no `parentUuid` referencing an unseen record — and exits non-zero if any
fail.

## Limits

Imported sessions are for **reading, not resuming**. Thinking blocks keep their
text but lose the originating provider's signature, and tool names are OMP's
(`bash`, `ast_edit`, `todo`), so replaying one through the Anthropic API would
be rejected.

They also land in the CLI's session store: `claude --resume` from the
repository root lists them, while the desktop app maintains its own index and
may not show them.
