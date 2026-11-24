# GrapiX module inventory for UI/UX review

Source of truth, read on 24 Nov 2026 from `agent/shared` at `1f6a8e1`: `Editor/web/index.html`
(`data-panel` sections), `Editor/src/app-menu.ts` (menu model), `Editor/src/panel-registry.ts`,
`Editor/src/workspace-catalog.ts` and `Playout/web/index.html`. If those files have moved on,
re-read them and update this table before you review: the code wins over this file.

## Workflows the UI exists for

| Workflow | Who | Path through the modules |
|---|---|---|
| A. Start | Designer | Start dialog → New or Open project → Design workspace |
| B. Build a scene | Designer | Scenes → New scene → Ribbon create tools → Objects → Viewport → Inspector / Pivot / Masks / Text styles / Fonts |
| C. Animate | Designer | Timeline (keys, easing, presets, phases in / hold / out) → Preview → Motion presets |
| D. Effects | Designer | Effects & Presets → Effect Controls → Timeline |
| E. Data | Designer | Data bindings (sample data, schema) → Template controls (control contract) → Take page |
| F. Publish | Designer | Publish → asset plane → engine reply (an immutable revision; never on air) |
| G. Run a show | Operator | Playout: sign in → connect → Transport (Cue, Take, Hold, Continue, Update, Take out, Clear) → Program → Output → Activity |
| H. Troubleshoot | Engineer | Playout Clock & reference, severity band, telemetry, Output; Editor Help → diagnostic bundle |

## Editor modules

| Module | Code hook | Job | States to capture |
|---|---|---|---|
| Start dialog | `project-start.ts`, `showStart` | Choose or create a project before work | first run (no recents), recents list, new-project form, refusal (folder exists) |
| Menu bar | `nav.app-menubar`, `app-menu.ts` | Every command in plain words: File, Edit, Project, Motion, Panels, Layout, Utilities, Help | each menu open, submenu open, disabled item with plan-row tooltip, keyboard navigation |
| Top bar | `header.bar` | Scene id and name, New / Open / Import SVG / Save / Undo / Redo / History / Reset layout | default, dirty, narrow window (wrap check) |
| Tool ribbon | `data-tool`, `data-create-kind`, `data-native=arrange-*` | Select, Move, Rotate, Resize, Pivot, Pen (mode), path and vertex tools, Hand, Zoom, create, line up and spread | each tool active, Pen mode menu, disabled line-up with one object |
| Scene tabs | `#scene-tabs` | Open scenes, dirty mark, close | one, many, dirty, overflow |
| Viewport | `data-panel="viewport"` | Composition: view mode, background, size and rate, fit / zoom, safe areas | empty, object selected, pen drawing, path edit, zoom 12 % and 400 % |
| Preview | `data-panel="preview"` | Engine-rendered frame, transport, playback settings | engine current, drawing, unavailable (refusal text), paused |
| Scene manager | `data-panel="scene-manager"` | Project picker, scene list, search | empty, many, search with no hits |
| Object manager | `data-panel="object-manager"` | Add, duplicate, rename, delete, order, lock | empty, nested, locked, delete armed |
| Inspector (Properties) | `data-panel="inspector"` | Transform, fill, stroke, text values | no selection, one, many (mixed values), invalid entry |
| Masks | `data-panel="masks"` | Masks and track matte | none, one, feather, matte |
| Fonts | `data-panel="fonts"` | Project fonts, registration, licence | missing font, registered |
| Pivot | `data-panel="pivot"` | Anchor point placement (AE-style grid) | default, custom |
| Text styles | `data-panel="text-styles"` | Reusable text styles | empty, list |
| Effect controls | `data-panel="effect-controls"` | Stacked effect parameters | none, several, keyed values |
| Effects & Presets | `data-panel="effects"` | 306 EffectCraft effects + GrapiX effects + presets, collapsible categories | collapsed, expanded, search, engine-ready filter |
| Materials | `data-panel="materials"` | Material slots and dynamic materials | empty, bound, missing asset |
| Assets | `data-panel="assets"` | Project assets | empty, grid |
| Take page | `data-panel="take-page"` | Take items for this scene | empty, populated |
| Animation | `data-panel="animation"` | Keys, easing, motion preset browser | none, keys selected |
| Data bindings | `data-panel="bindings"` | Bindings, sample data | none, bound, invalid sample |
| Template controls | `data-panel="control-contract"` | Operator-editable fields | none, several |
| Publish | `data-panel="publish"` | Publish a revision to the engine's package folder | ready, engine unreachable, refused by name, success with locality |
| Timeline | `data-panel="timeline"` | Layers, keys, phases, jump to hold, zoom | empty, layers, keys selected, long scene scrolled |
| Change history | Edit ▸ Change history… | Jump to any earlier state | short, long, current row |
| Settings | Edit ▸ Settings… (row 11.81) | Preferences | each section |
| Activity log | `footer.log-bar` | What just happened, refusals by name | ok line, refusal line, long log |
| Workspaces | `workspace-*.ts`, Layout menu | Dock, tab, float, save and reset layouts | drag with drop zones, floating, saved layout |
| Help | Help menu | Guide, diagnostic bundle (no telemetry in the Editor) | menu, export dialog |

## Playout modules

| Module | Code hook | Job | States to capture |
|---|---|---|---|
| Connection bar | `#connectionBar` | Operator sign-in, endpoint, token, connect, status, telemetry | signed out (transport held), connecting, connected, refused |
| Severity band | `#severityBand` | Warning or critical, never dismissable | none, warning (free run), critical |
| Clock & reference | `#clockPanel` | Rate, clock source, reference, device tier, epoch, current frame, degradations | locked, free run, degraded |
| Transport | `#transportPanel` | Take id, revision, content hash, frame; CUE, CLEAR, TAKE, HOLD, CONTINUE, UPDATE, TAKE OUT | idle, cued, on air, refused (hash mismatch), held (no operator) |
| Program | `.panel--program` | What is on air now | empty, on air |
| Output | `.panel--output` | Adapter, live, free-run, configure | unconfigured, live, refused (tier) |
| Activity | `.panel--log` | Log of commands and refusals | short, long |
| Telemetry | Help / Telemetry button | Per GPU, CPU, adapter and output health | nominal, late frames, missed frames |

## Planned modules (no UI yet; review the designs, not the app)

Curve editor, Agent (MCP) panel with per-layer diffs, Scripts and extensions (AE scripts and
ScriptUI panels), Command palette, Run order (rundown), Template control cards, Remote control
and triggers (TCP, UDP, HTTP, GPI, MOS), Outputs and devices. Designs for these are in the Figma
file `GrapiX` (see `docs/design/grapix-screens-spec.md`).
