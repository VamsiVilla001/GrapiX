# `@grapix/editor-mcp`

A Model Context Protocol server that connects any MCP client — Claude Code,
Claude Desktop, Codex, Gemini CLI, Kimi, Cursor, Zed — to the GrapiX Editor.

It does two things:

**Authoring.** 53 tools covering scenes, objects, materials, assets, fonts,
imports, animation, data bindings, automation evaluation, rundowns, preflight
and publish. Every one of them goes through `Editor/services/project-api` on
4100, so an agent works under the same rules a human author does: the origin
allow-list, the bearer token, read-only show mode, the operator audit log, the
per-scene write lock, scene backups and the revision counter.

**Knowledge.** The server ingests the repository's own writing — every document
in `docs/`, the product READMEs, the durable handoff in `memory.md`, and the
TypeScript contract sources in `Shared/` — and derives a live capability map
from the contracts themselves. It is read from the working tree, not bundled, so
it cannot go stale.

## Why the knowledge half exists

The failure mode of an AI editing a broadcast graphics application is not
"cannot find the API". It is authoring something that validates, saves, and then
renders differently on air — or reaching for a verb the Editor is
architecturally forbidden to have.

Both are already documented in this repository. Six of eight `TextureFitMode`
values were selectable, saved, validated as fine, and drawn as `stretch`. An
object carries its colour twice and the renderers read the rich representation
first, so a factory that sets only the string paints the previous colour. These
are recorded in `memory.md` because they each cost a debugging session.

So `grapix_editor_describe_capabilities` reports **declared** and
**implemented** separately for every enum and names the gap, `analyze_scene`
audits a scene against that gap, and the object factory writes both colour
representations. The knowledge is not documentation bolted on the side; it is
what makes the authoring tools safe to hand to an agent.

## The authority boundary

GrapiX splits authoring from operations the way Viz Artist splits from Trio, or
XPression Designer from Sequencer. This server is the **Editor**.

It may author scenes, materials, assets, fonts, animation and data bindings,
evaluate automation as a dry run, and build a checksum-addressed `.gfxpkg`.

It may **not** Cue, Take, Continue, Clear Program, or configure an output. Those
belong to Playout (`docs/architecture.md` invariants 3 and 4), and the render
engine enforces it server-side by authenticated role — an Editor-role request
for one is refused at the engine regardless of what any client offers.

That boundary is a test, not a comment. `assertEditorAuthority` runs at server
construction and in CI, and fails the build if a tool ever names one of those
verbs. Publishing builds a package; Playout stages, independently validates and
promotes it, and an operator takes it.

## Install and run

The package is a workspace member; `npm install` at the repository root is
enough. Build it once:

```bash
npm run build -w @grapix/editor-mcp
```

Start the project service in another terminal, or run the Editor desktop shell,
which starts it for you:

```bash
npm run dev:api
```

The MCP server runs without the project service — the whole knowledge half still
works — but every authoring tool needs it.

### stdio (default)

The client launches the process and owns it. Correct for a desktop assistant.

```bash
node Editor/services/editor-mcp/dist/index.js
```

### Streamable HTTP

For clients that attach to a running server, or several assistants sharing one.
Binds loopback, stateless per request, DNS-rebinding protection on.

```bash
node Editor/services/editor-mcp/dist/index.js --http
```

Endpoint `http://127.0.0.1:4150/mcp`, plus a plain `GET /health`.

### Read-only

Registers read tools only and omits every mutating tool — the right default for
an agent pointed at a live authoring station. An omitted verb is the only signal
a model reliably acts on; a tool that always errors just gets retried.

```bash
node Editor/services/editor-mcp/dist/index.js --read-only
```

## Client configuration

Replace `D:/Project KK/Personal projects/GrapiX` with your checkout path.

### Claude Code

```bash
claude mcp add grapix-editor -- node "D:/Project KK/Personal projects/GrapiX/Editor/services/editor-mcp/dist/index.js"
```

Or in `.mcp.json` at the repository root, which shares the server with everyone
who clones it:

```json
{
  "mcpServers": {
    "grapix-editor": {
      "command": "node",
      "args": ["Editor/services/editor-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json` — macOS
`~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`:

```json
{
  "mcpServers": {
    "grapix-editor": {
      "command": "node",
      "args": ["D:/Project KK/Personal projects/GrapiX/Editor/services/editor-mcp/dist/index.js"],
      "env": { "GRAPIX_REPOSITORY_ROOT": "D:/Project KK/Personal projects/GrapiX" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.grapix-editor]
command = "node"
args = ["D:/Project KK/Personal projects/GrapiX/Editor/services/editor-mcp/dist/index.js"]

[mcp_servers.grapix-editor.env]
GRAPIX_REPOSITORY_ROOT = "D:/Project KK/Personal projects/GrapiX"
```

### Gemini CLI

`~/.gemini/settings.json`, or `.gemini/settings.json` in the project:

```json
{
  "mcpServers": {
    "grapix-editor": {
      "command": "node",
      "args": ["D:/Project KK/Personal projects/GrapiX/Editor/services/editor-mcp/dist/index.js"],
      "env": { "GRAPIX_REPOSITORY_ROOT": "D:/Project KK/Personal projects/GrapiX" }
    }
  }
}
```

### Kimi, Cursor, Zed, and other clients

Any client that reads the common `mcpServers` shape takes the Claude Desktop
block above verbatim. A client that prefers HTTP should start the server with
`--http` and point at `http://127.0.0.1:4150/mcp`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRAPIX_REPOSITORY_ROOT` | auto-detected | Checkout to ingest. Found from the server's own location, then the working directory. Set it when the client launches from elsewhere. |
| `GRAPIX_API_URL` | `http://127.0.0.1:4100` | Project service base URL. |
| `GRAPIX_API_TOKEN` | — | Bearer token, when the project service was started with one. |
| `GRAPIX_MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `GRAPIX_MCP_HOST` | `127.0.0.1` | HTTP bind host. |
| `GRAPIX_MCP_PORT` | `4150` | HTTP port. |
| `GRAPIX_MCP_READ_ONLY` | `false` | `true` omits every mutating tool. |

Configuration is resolved and validated before a transport opens, so a bad
repository root fails at startup rather than looking like an empty knowledge
base on the first tool call.

## What the server exposes

### Tools

All 53 are prefixed `grapix_editor_`, so they stay unambiguous alongside other
MCP servers and alongside a future Playout server that will own the verbs this
one cannot have.

| Group | Tools |
| --- | --- |
| **Knowledge** | `get_primer`, `search_knowledge`, `list_documents`, `read_document`, `describe_capabilities`, `describe_authority`, `get_session_rules`, `list_commands` |
| **Scenes** | `list_scenes`, `get_scene`, `analyze_scene`, `evaluate_scene_at_frame`, `create_scene`, `update_scene_settings`, `replace_scene`, `recover_scene` |
| **Objects** | `list_objects`, `get_object`, `add_object`, `update_object`, `delete_object`, `bind_object_property`, `set_object_animation` |
| **Materials** | `list_materials`, `create_material`, `update_material`, `assign_material`, `delete_material` |
| **Assets & fonts** | `import_asset`, `get_asset`, `list_scene_assets`, `add_scene_asset`, `import_font`, `resolve_remote_font`, `add_scene_font` |
| **Imports** | `import_model`, `import_media`, `import_design_file`, `import_figma`, `import_scene_script`, `inspect_after_effects_import` |
| **Live data & automation** | `get_data_context`, `set_data_value`, `replace_data_context`, `evaluate_scene_event` |
| **Publish** | `preflight_scene`, `preflight_document`, `publish_scene`, `get_status` |
| **Rundowns** | `list_rundowns`, `get_rundown`, `save_rundown`, `evaluate_rundown_event` |

Every tool declares a strict Zod input schema (`additionalProperties: false`),
read/destructive/idempotent/open-world annotations, and a `response_format`
switch between markdown and JSON where it returns data. List tools paginate and
report `has_more` / `next_offset`. Results over 25,000 characters are truncated
with a message naming the parameter that returns less.

### Resources

| URI | Contents |
| --- | --- |
| `grapix://primer` | The orientation document: products, invariants, boundary, capability map |
| `grapix://authority` | Editor verbs, forbidden verbs, invariants and the port map, as JSON |
| `grapix://capabilities` | The capability map as JSON |
| `grapix://capabilities.md` | The same, rendered for reading |
| `grapix://rules` | The binding session rules from `memory.md` |
| `grapix://doc/{documentId}` | Any ingested document, whole. Listable and completable |
| `grapix://scene/{sceneId}` | A stored `SceneDocument` as JSON. Listable and completable |
| `grapix://asset/{assetId}` | Asset bytes; text inline, binary as a base64 blob |

### Prompts

`grapix_orient`, `grapix_build_lower_third`, `grapix_publish_check`,
`grapix_explain_boundary`, `grapix_investigate`. Each front-loads the
orientation that keeps an agent out of the two expensive mistakes, and names the
tool order that works.

### Capabilities

`tools` (listChanged), `resources` (subscribe, listChanged), `prompts`
(listChanged), `logging`, and `completions` — the last supplied automatically by
the SDK because resource templates carry `complete` callbacks and prompt
arguments are `completable`, so a client can offer real document and scene ids
instead of making the user guess.

## Concurrency

`POST /api/scenes` replaces a whole document and takes no expected-revision
field, so a read-modify-write races any other writer — the Editor UI on the same
scene, or a second agent.

Tools that rewrite a document accept `expected_revision` and re-read immediately
before saving, abandoning the write if the revision moved. That narrows the race
to the gap between the check and the POST; it does not close it, because the
route has no compare-and-swap. It is the strongest guarantee available from
outside that service, and much better than silent last-writer-wins. Targeted
routes (`update_object`, `update_material`) do not rewrite the document at all
and cannot clobber a change to a different object.

`set_data_value` uses the live-data route, whose revision token is the scene's
`updatedAt` timestamp rather than the numeric revision — hence
`expected_updated_at` on that tool alone.

## Tests

```bash
npm test -w @grapix/editor-mcp
```

Three suites, 34 tests:

- **`authority.test.mjs`** — the architecture guard. No tool may name a Program
  or output verb; the guard itself is proved to reject one; read-only mode drops
  every mutator.
- **`knowledge.test.mjs`** — the corpus loads the architecture, contracts and
  handoff; the invariants and session rules survive extraction; the capability
  map keeps declared and implemented distinct; authority breaks a search tie
  toward the canonical document.
- **`protocol.test.mjs`** — a real `Client` against a real spawned
  `dist/index.js`: handshake, declared capabilities, every list, a resource
  read, a completion, tool calls, and schema rejection of bad arguments. It does
  not require the project service; the one tool that needs it is asserted to
  fail *informatively* rather than to succeed.

Verified live against a running project service on 4100: create scene, add
objects, bind live data, keyframe, create and assign a material, analyze,
preflight, publish a 3.3 KB `.gfxpkg`, delete and recover.
