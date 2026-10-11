# Shared agent workspace (binding)

Every LLM working on GrapiX must first read `LLM-GOVERNANCE.md`.

The only authorized agent worktree is:

`D:\Project KK\Personal projects\GrapiX\agent\worktree`

Use branch `agent/shared`. Run `tools/enter-agent.ps1` from the primary
checkout, then `node tools/check-agent-worktree.mjs` in that worktree before
editing or testing. The primary checkout is for inspection and fast-forward
integration; agent code, documentation, tests and commits belong in the
shared worktree. This instruction also applies to every delegated agent.

Do not create another worktree, per-agent checkout, fork, private branch or
replacement workspace. Do not use `.claude/worktrees`, `.codex` worktrees,
`.omp` worktrees, or tool-generated isolation. If the shared worktree is
missing or occupied, report that condition and preserve the shared state;
do not create a substitute. Explicit user instructions override this rule.

Coordinate edits in the existing shared tree. Never reset, stash, clean or
overwrite another worker's changes to obtain a clean tree. Do not spawn
other agents unless the user or applicable instructions authorize delegation.

Project agent settings are consolidated under the primary repository's
`agent/config/`. Temporary artifacts belong under `agent/tmp/`; recovery
copies belong under `agent/archive/`. These are not alternate worktrees.
`legacy/` preserves merged historical source and is outside current product
builds. Follow the build plan and verification/tracker rules for all work.
