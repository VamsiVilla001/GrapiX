# One shared agent workspace

All LLMs use the existing `agent/worktree` linked Git worktree, branch
`agent/shared`. The primary `GrapiX-2.0` checkout is the integration view.
`AGENTS.md` and `LLM-GOVERNANCE.md` prohibit per-agent worktrees/branches.

From the primary checkout:

```powershell
& ./tools/enter-agent.ps1
node tools/check-agent-worktree.mjs
```

The checker verifies the exact mandated repository path, actual registered
Git worktree, branch, and absence of extra GrapiX worktrees; a similarly
named ordinary folder or a clone with the same layout does not pass.
The entry script does not create a worktree or discard pending changes.
When starting an IDE or agent session, open the shared worktree directly.

| Primary repository path | Purpose |
|---|---|
| `agent/worktree/` | The single agent code workspace |
| `agent/config/` | Consolidated provider settings/profiles |
| `agent/tmp/` | Disposable diagnostics and build artifacts |
| `agent/archive/` | Local preservation copies and old runtime data |
| `agent/reference/` | Third-party source studied during integration; never another GrapiX checkout |

Private Claude settings and recovery files are ignored by Git. Committed
Codex configuration and OMP profiles live in `agent/config/`. Native apps may
still require their own launch-time setting flags; moving these files is not
a claim that every app automatically discovers the new folder. No global
user settings or conversation stores were moved.

The consolidation merged existing worktree histories and local source edits.
The unrelated 1.x application is retained, with history, at
`legacy/grapix-1x/`; the orphaned partial checkout is at
`legacy/agent-orphans/`. Their old manifests remain historical source rather
than taking over the current Cargo/npm workspace. See `memory.md` for
preservation, cleanup and verification evidence.
