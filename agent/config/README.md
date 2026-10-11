# Consolidated project agent configuration

- `codex.toml`: preserved project Codex configuration, moved from `.codex`.
- `omp/`: preserved OMP council profiles, moved from `.omp/agents`; every
  profile inherits the shared-worktree rule.
- `claude.local.json` (primary checkout only, ignored): root Claude settings
  with allow/deny rules merged from eight former project/worktree files.
- `claude-launch.json` (primary checkout only, ignored): preserved preview
  launch settings from the orphaned Claude task folder.

Original private settings are preserved under
`agent/archive/consolidation-2026-10-11/`. Provider configuration is data,
not an exemption from `AGENTS.md` or `LLM-GOVERNANCE.md`. No provider may
create its own source checkout or branch. Configure native launchers to open
the existing shared worktree and pass supported settings explicitly; do not
recreate provider-specific workspace folders.
