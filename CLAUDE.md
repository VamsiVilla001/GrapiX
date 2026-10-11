# GrapiX agent entry point

Read `AGENTS.md` and `LLM-GOVERNANCE.md` before working.

All LLMs, including Claude, Codex and OMP workers, use only
`D:\Project KK\Personal projects\GrapiX\agent\worktree` on `agent/shared`.
Do not request or create an isolated worktree or a per-agent branch. Enter
the existing shared tree with `tools/enter-agent.ps1` and verify its identity
with `node tools/check-agent-worktree.mjs` before editing or testing.
