# GrapiX Editor workspace

The authoring product. Editor owns project and source assets, authoring state,
undo/redo, validation, package building and **Publish to Playout**.

It owns no on-air state. `docs/architecture.md` invariants 3 and 4 put Cue, Take,
Continue, Clear and output configuration entirely in Playout's hands, and the
engine rejects them from an Editor role rather than trusting a UI to omit the
button.

```text
apps/editor-web         React/Vite authoring UI
apps/desktop-tauri      primary desktop shell
apps/desktop-electron   fallback shell
services/project-api    scenes, assets, fonts, packages, automation evaluation
services/editor-mcp     MCP server: the authoring surface and the ingested
                        architecture, contracts and capability knowledge
```

## What the desktop shell supervises

| Process | Port | Ownership |
| --- | --- | --- |
| `project-api` | 4100 | owned; stopped when the window closes |
| `grapix-render-engine` | 4400 | **ensured, never owned** |

The shell starts an engine when none is running, adopts one that is already up,
and leaves it running on window close — including an engine it started itself.
An authoring window must never be able to take a show off air.

It does not restart the renderer or restore Program. That is the Engine Host's
journal-and-verify recovery path (milestone M3); a shell that re-took a scene from
a cached guess is precisely the failure it exists to prevent.

## Commands

```bash
npm run dev:editor       # desktop shell: project service + ensured engine
npm run dev:web          # UI only, in a browser
npm run dev:api          # project service only
npm run dev:mcp          # MCP server, watching sources
npm run build:editor
npm run test:editor
```

## Automation

`services/project-api` evaluates scene and rundown automation so an author can see
what a trigger *would* do, and returns the action plan. It never executes it —
execution is an operator action and belongs to Playout.

## AI clients

`services/editor-mcp` exposes the authoring surface over the Model Context
Protocol, so Claude, Codex, Gemini, Kimi or any other MCP client can author
GrapiX scenes. It talks to `project-api` rather than to `data/`, so an agent
works under the same origin allow-list, token, read-only show mode, audit log,
write lock, backups and revision counter as a human author.

It also ingests the repository's own architecture, contracts and session rules,
and derives a capability map that separates what a scene *may declare* from what
the renderers *actually implement* — the distinction that stops an agent
authoring a value which validates cleanly and then renders as something else.

The same invariants bind it: `assertEditorAuthority` fails the build if a tool
ever names Cue, Take, Continue, Clear, Program or an output verb. See
[`services/editor-mcp/README.md`](services/editor-mcp/README.md) for client
configuration.
