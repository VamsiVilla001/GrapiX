# GrapiX UI/UX review agent

Agent definition: `.claude/agents/grapix-uiux-reviewer.md`. Ask Claude Code to "use the
grapix-uiux-reviewer agent to review the Editor" (or Playout, or one module).

| File | What it holds |
|---|---|
| `module-inventory.md` | Every Editor and Playout module, its job in the workflow, and the states to capture |
| `checklist.md` | Criteria, the 100-point rubric and the S0 to S4 severity scale |
| `tooling.md` | Reaching the real WebView2 window over CDP, plus Playwright MCP, Chrome DevTools MCP, axe-core and the three review skills (Humbleteam `design-review` installed at `.claude/skills/design-review/`; the rest need approval) |

The `design-review` skill is a separate git clone, not committed to this repository. In another
tree, install it with:

```bash
git clone https://github.com/humbleteam/design-review .claude/skills/design-review
```
| `report-template.md` | Report shape: scorecard, issues with CSS-level fixes, complexity list, before-and-after batches, approval gate, re-test log |

The agent reads and captures freely, writes only under `agent/tmp/uiux-review/`, and changes no
product source until the user approves named items in chat. It then re-tests what it changed.

## Where it must live to be used

Claude Code loads project agents from `.claude/agents/` in the session's working tree. This copy
was written on branch `claude/vibrant-bassi-6cce4b`. For sessions in the governed shared worktree
(`agent/worktree`, branch `agent/shared`), copy `.claude/agents/grapix-uiux-reviewer.md` and this
folder there, or install the agent at user level (`%USERPROFILE%\.claude\agents\`).
