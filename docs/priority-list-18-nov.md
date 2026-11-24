# GrapiX tasks by priority (from progress.html, 18 Nov 2026)

293 tasks: 150 done, 143 remaining (7 marked in progress, 136 not started or open). Not marked done in the tracker are the rows built in part this session (their notes say what is left).

**How the order is set.** Tier 0 is what you marked in progress. Tier 1 finishes the effects and presets work you called the main thing. Tier 2 is what you asked for on 18 Nov. Tier 3 is every other task whose dependencies are all done, most unblocking first (the count is how many waiting tasks need it), then tracker order. Tier 4 waits on an unfinished dependency, in tracker order.

## Tier 0: marked in progress (7)

| ID | Task | Track | Depends on | Note |
|---|---|---|---|---|
| `3.21` | GPU Program/Preview output: encode, quantise once, bounded asynchronous readback | Backend | 3.11, 3.15, 3.16 |  |
| `7.3` | Import fidelity gate: source reference render versus imported render | Backend | 4.3 |  |
| `8.14` | Tiered MCP surface: read, author on draft handles, propose | Backend | 8.13, 11.36, 11.38 |  |
| `11.1` | Tauri 2 shell on Windows; signed (macOS and notarising dropped 8 Nov 2026) | Interface | 0.3 |  |
| `11.2` | WebGPU capability probe on both target OS versions | Platform | 11.1 |  |
| `11.3` | DPI: fractional scaling, scale change, monitor move | Interface | 11.1 |  |
| `12.1` | Tauri 2 shell | Interface | 0.3 |  |

## Tier 1: finish the open effects and presets builds (7)

| ID | Task | Track | Depends on | Note |
|---|---|---|---|---|
| `3.25` | Port EffectCraft's effects beyond the first 16, broadcast-first | Backend | 3.22 |  |
| `3.24` | GPU/CPU load balancer: Program is never late because something else spiked | Backend | 3.21, 2.22 |  |
| `11.65` | Engine preview monitor in the Editor | Interface | 11.41 |  |
| `11.69` | Effects & Presets and Effect Controls in the Editor: EffectCraft's 306 effects listed, GrapiX's 16 usable | Interface | 3.22, 11.36 |  |
| `11.70` | Preset library: EffectCraft's 8 original presets and GrapiX's own animation and effect presets | Interface | 11.69, 11.23 |  |
| `11.67` | Compact, clean UI and UX pass on both apps under SKWAD, reviewed by Jev and Laya | Interface | 0.14 |  |
| `11.68` | Keyframes the way After Effects and EffectCraft do them: per-property tracks, easing, graph editor | Interface | 11.36 |  |

## Tier 2: your 18 Nov asks (layout and After Effects feel, scripts and plug-ins, Figma, Playout) (19)

| ID | Task | Track | Depends on | Note |
|---|---|---|---|---|
| `11.76` | Named workspaces: Author, Animate, Effects, Review | Interface | 11.73 |  |
| `11.74` | Chrome savings: a status line for the Activity log, one header row, a one-row timeline toolbar | Interface | 11.71 |  |
| `11.72` | Scene Manager as a dense list, with a row menu and keys, as XPression's Scene Manager is worked | Interface | 11.64, 11.71 |  |
| `11.73` | Tabbed panel groups in the dock regions | Interface | 11.71, 11.72 |  |
| `11.79` | Effects & Presets categories as collapsible dropdowns | Interface | 11.69, 11.70 |  |
| `11.80` | Resizable panels: splitters between stacked panels and groups, and a drop indicator | Interface | 11.73 |  |
| `11.71` | XPression-informed layout: use the Editor's real estate | Interface | 11.5, 11.63 |  |
| `11.75` | Pop out any panel into its own window | Interface | 11.73 |  |
| `11.77` | Stagger animations: offset the keys of several selected objects by a step | Interface | 11.22 |  |
| `11.78` | Pre- and post-infinity on the speed graph: constant, reset, repeat | Interface | 11.68 |  |
| `16.14` | After Effects scripting: .jsx scripts run against GrapiX through undoable commands | Backend | 16.4, 11.36 |  |
| `16.15` | ScriptUI panels and extensions: dockable script panels | Interface | 16.14, 11.33 |  |
| `16.16` | Effect plug-ins: sandboxed modules from a Plug-ins folder | Backend | 3.22, 16.4 |  |
| `18.2` | Figma ingest through the Figma MCP, with the source retained and no token in GrapiX | Backend | 7.2, 11.39, 8.1 |  |
| `18.11` | A real Figma frame end to end: PAC - PIC 2026 three-caster lower third to air | Backend | 18.2, 7.3 |  |
| `11.61` | Text animators: per-glyph range selectors | Backend | 3.18, 11.20, 11.36 |  |
| `2.26` | The architecture guard covers Playout as it covers the Editor, and sees the files and the listeners it does not see today | Backend | 2.21 |  |
| `8.15` | AI-native authoring: an agent builds a template from a Figma or PSD frame and a data schema, and verifies its own render | Gen-AI | 8.14, 18.2, 3.20 |  |
| `8.16` | A supervising agent on live telemetry: warns and suggests, never acts on air | Gen-AI | 2.27, 8.14 |  |

## Tier 3: ready now (dependencies done), most unblocking first (40)

| ID | Task | Track | Depends on | Note |
|---|---|---|---|---|
| `11.53` | Timeline: named stop points and a looping hold | Contracts | 11.22, 11.25, 11.36, 11.38 | unblocks 4 |
| `11.54` | Template field constraints | Contracts | 11.26, 11.27, 11.38 | unblocks 4 |
| `11.40` | Component registry and project variables | Contracts | 11.36, 11.41 | unblocks 3 |
| `11.42` | Lint framework and first rules | Backend | 11.36, 11.41 | unblocks 3 |
| `13.6` | Pixel gate: viewport equals Program | Backend | 4.4 | unblocks 3 |
| `15.1` | Hardware, SDKs and lab access in hand | External | — | unblocks 3 |
| `11.30` | Save model: Ctrl+S saves in place, Ctrl+Shift+S saves a new version | Interface | 11.29, 11.15 | unblocks 2 |
| `12.3` | Take list and rundown | Interface | 6.4 | unblocks 2 |
| `0.12` | Agent protocol files made context-efficient: `memory.md` split, binding rules in one place, the worktree rule stated once, one status vocabulary, the working protocol written down | Platform | 0.11 | unblocks 1 |
| `2.15` | Named operator login for Playout: the person, not only the credential | Backend | 2.9 | unblocks 1 |
| `11.52` | Asset manager: versioned replace and provenance shown | Interface | 2.7, 11.18, 11.39 | unblocks 1 |
| `11.60` | Layer styles: every Photoshop style and its blending options, animatable, on the GPU | Backend | 3.19, 3.22, 11.36 | unblocks 1 |
| `12.2` | Playout library: published graphics by Take ID | Interface | 6.1 | unblocks 1 |
| `12.5` | Confidence monitors, fill and key | Interface | 5.4 | unblocks 1 |
| `12.10` | Overlay layers with channel/layer targeting on one Program channel | Backend | 1.9, 6.2 | unblocks 1 |
| `13.1` | Measure viewport interaction latency on the existing stream | Backend | 5.4 | unblocks 1 |
| `14.1` | QUIC with rustls; mTLS | Backend | 5.1 | unblocks 1 |
| `14.4` | Media codec negotiation by locality and consumer role | Backend | 5.5 | unblocks 1 |
| `14.8` | Conformance suite passes at L1 exactly as at L0 | Backend | 5.6 | unblocks 1 |
| `16.1` | Video decoder tier: FFmpeg with NVDEC | Backend | — | unblocks 1 |
| `16.3` | Transitions beyond cut, dual-target | Backend | 3.8 | unblocks 1 |
| `18.1` | Figma reference corpus | Research | — | unblocks 1 |
| `19.1` | ADR-0005: Data Server boundaries | Contracts | 1.9, 5.1 | unblocks 1 |
| `2.23` | MCP HTTP authentication, or loopback-only recorded as the decision | Backend | 2.21 |  |
| `2.24` | Asset plane: authentication, resume, retry, and transport errors named as transport errors | Backend | 2.21 |  |
| `11.66` | Glossary label lint | Interface | 11.63, 11.64 |  |
| `13.5` | Browser reduced to overlays only | Interface | 11.7 |  |
| `14.3` | Resumable asset transfer | Backend | 5.3 |  |
| `14.6` | Two engine instances by role: design and program | Backend | 3.2 |  |
| `14.7` | Build hash pinned at publish; skew warning in Playout | Backend | 7.6 |  |
| `15.8` | SRT and OMT adapters | Backend | 3.10 |  |
| `15.11` | Device-loss and driver-reset recovery tests | External | 3.12 |  |
| `16.5` | Lottie import path | Backend | 7.2 |  |
| `16.6` | 3D: shadows | Backend | 3.7 |  |
| `16.7` | 3D: transparent depth ordering | Backend | 3.7 |  |
| `16.9` | Rasteriser benchmark; Vello evaluated against the gate | Backend | 4.4 |  |
| `17.1` | Reproduction test on an already-shipped esports pack | Gen-AI | 8.13 |  |
| `17.3` | Motion preset library authored by a designer | Gen-AI | 11.15 |  |
| `17.5` | Correction capture from the very first draft | Gen-AI | 7.6 |  |
| `17.6` | Visual critique loop | Gen-AI | 8.9 |  |

## Tier 4: waiting on a dependency, in tracker order (70)

| ID | Task | Track | Depends on | Note |
|---|---|---|---|---|
| `0.13` | The tracker generated from the plan: `progress.html`'s embedded rows and state come from `GrapiX-Build-Plan.md` and `progress.json`, and `npm run check` fails on drift | Platform | 0.12 | needs 0.12 |
| `3.23` | 2160p50 Program/Preview output budget (V2) | Backend | 3.21 | needs 3.21 |
| `11.31` | One command registry behind every menu, toolbar, shortcut and agent action | Interface | 11.30, 11.36 | needs 11.30 |
| `11.32` | Menu bar and toolbar (After Effects conventions) | Interface | 11.31 | needs 11.31 |
| `11.33` | Window menu: every module reachable; tabbed docks and saved layouts | Interface | 11.5, 11.32 | needs 11.32 |
| `11.34` | Floating panel windows | Interface | 11.33 | needs 11.33 |
| `11.35` | Workspace modes | Interface | 11.33 | needs 11.33 |
| `11.43` | Project settings, explicit save and single-file .gpx packaging | Interface | 11.18, 11.29, 11.30, 11.36, 11.37, 11.38 | needs 11.30 |
| `11.44` | Viewport: gizmos, rulers, margins and safe guides | Interface | 11.7, 11.36, 11.41, 11.43 | needs 11.43 |
| `11.45` | Object manager on the command model: parenting, groups, order, unique names | Interface | 11.8, 11.36, 11.37, 11.44 | needs 11.44 |
| `11.46` | Inspector: per-type property sets, scrub fields, animation stopwatch | Interface | 11.9, 11.21, 11.36, 11.37, 11.45 | needs 11.45 |
| `11.47` | 2D object library: pen paths, masks, clip groups, trim paths | Backend | 1.2, 11.41, 11.45, 11.46 | needs 11.45, 11.46 |
| `11.48` | 3D object library: assignable-face primitives, extrusion, nulls | Backend | 3.7, 11.41, 11.45, 11.46 | needs 11.45, 11.46 |
| `11.49` | Video layer with alpha | Backend | 11.41, 11.45, 11.46, 16.1 | needs 11.45, 11.46, 16.1 |
| `11.50` | One physically lit material type and a material library | Contracts | 1.3, 11.12, 11.41, 11.48 | needs 11.48 |
| `11.51` | Text engine depth: auto-fit, complex scripts, font links | Backend | 3.6, 11.13, 11.28, 11.42, 11.47 | needs 11.42, 11.47 |
| `11.55` | Logic: conditional triggers, scene transitions, per-scene JS modules | Backend | 6.6, 11.53, 11.54, 16.3, 16.4 | needs 11.53, 11.54, 16.3, 16.4 |
| `11.56` | Widgets: clock, countdown, counter, round timer | Backend | 11.55, 16.4 | needs 11.55, 16.4 |
| `11.57` | Hash publish to Playout from the engine-rendered preview | Interface | 7.6, 8.10, 11.38, 11.53, 11.65 | needs 11.53, 11.65 |
| `11.58` | Console and debugger | Interface | 0.6, 11.36, 11.42 | needs 11.42 |
| `11.59` | Importers on 2.0 objects: PSD/AI and After Effects | Backend | 7.2, 11.39, 11.41, 11.47, 11.48, 11.50, 11.51, 11.53 | needs 11.47, 11.48, 11.50, 11.51, 11.53 |
| `11.62` | Effects and layer-style controls in the Editor | Interface | 3.22, 11.46, 11.60 | needs 11.46, 11.60 |
| `12.8` | Playout operator fill form and pages | Interface | 11.26, 11.54, 12.3 | needs 11.54, 12.3 |
| `12.9` | Lower-third operator workflow acceptance (end to end) | Interface | 11.25, 11.54, 11.57, 12.1, 12.2, 12.3, 12.4, 12.5, 12.8, 12.10 | needs 11.54, 11.57, 12.1, 12.2, 12.3, 12.5, 12.8, 12.10 |
| `12.11` | As-run record | Backend | 2.9, 2.10, 2.11, 2.15, 6.2 | needs 2.15 |
| `13.2` | Binary alpha frames | Backend | 13.1 | needs 13.1 |
| `13.3` | Picking and bounds metadata from the engine | Backend | 13.2 | needs 13.2 |
| `13.4` | Adaptive resolution | Backend | 13.2 | needs 13.2 |
| `13.7` | Approval pipeline | Backend | 8.14, 11.41, 11.42, 13.6 | needs 8.14, 11.42, 13.6 |
| `13.8` | Provenance in use | Backend | 11.39, 13.7 | needs 13.7 |
| `14.2` | Control plane over the remote transport | Backend | 14.1 | needs 14.1 |
| `14.5` | NVENC encode (VideoToolbox on macOS clients dropped 8 Nov 2026) | Backend | 14.4 | needs 14.4 |
| `15.2` | DeckLink integration via thin FFI | External | 15.1 | needs 15.1 |
| `15.3` | AJA integration | External | 15.1 | needs 15.1 |
| `15.4` | Reference input and lock detection | External | 15.2 | needs 15.2 |
| `15.5` | ProgramClock slaved to the card timebase; free-run reported | Backend | 15.4 | needs 15.4 |
| `15.6` | Scheduled playback in the card timebase | External | 15.5 | needs 15.5 |
| `15.7` | NDI adapter certification against real receivers | External | 15.1 | needs 15.1 |
| `15.9` | 8-hour nightly protocol soak | External | 15.6 | needs 15.6 |
| `15.10` | 24-hour hardware release gate | External | 15.9 | needs 15.9 |
| `15.12` | NDI 6.3 metadata: revision, asset IDs and AI-provenance flags | External | 15.7, 11.39 | needs 15.7 |
| `15.13` | ST 2110 / IPMX output server | External | 14.8 | needs 14.8 |
| `16.4` | Script sandbox on rquickjs: deterministic per-scene JS | Backend | 2.9, 11.36, 11.58 | needs 11.58 |
| `16.8` | 3D: camera parity in Program | Backend | 13.6 | needs 13.6 |
| `16.10` | Generative asset adapters | Gen-AI | 11.39, 11.52 | needs 11.52 |
| `16.11` | AI keyer sidecar | Backend | 15.6 | needs 15.6 |
| `16.12` | Gaussian splat layer | Backend | 11.48, 13.6 | needs 11.48, 13.6 |
| `16.13` | Interchange: OpenUSD/MaterialX import, OpenTimelineIO export | Backend | 11.50, 11.53 | needs 11.50, 11.53 |
| `17.2` | Brand constraints from project variables inside the loop | Gen-AI | 11.40 | needs 11.40 |
| `17.4` | Scene assembly agent over MCP: constrained generation | Gen-AI | 8.9, 11.40, 11.54 | needs 11.40, 11.54 |
| `17.7` | Batch generation from a template list | Gen-AI | 17.4, 13.7 | needs 17.4, 13.7 |
| `17.8` | Zero-edit publish rate reported per class | Gen-AI | 17.7 | needs 17.7 |
| `17.9` | Per-class graduation with a named sign-off owner | Gen-AI | 17.8 | needs 17.8 |
| `18.3` | Scene boundaries: one Figma frame is one scene | Backend | 18.2, 11.29, 11.47 | needs 18.2, 11.47 |
| `18.4` | Node and property coverage matrix | Backend | 18.3, 1.2, 1.3 | needs 18.3 |
| `18.5` | Text fidelity | Backend | 18.4, 11.13, 3.6 | needs 18.4 |
| `18.6` | Components, instances and variants | Backend | 18.4 | needs 18.4 |
| `18.7` | Variables and styles to project variables | Backend | 11.40, 18.2 | needs 11.40, 18.2 |
| `18.8` | Fidelity gate on the corpus | Backend | 18.1, 18.4, 7.3, 4.4 | needs 18.1, 18.4, 7.3 |
| `18.9` | Re-import updates in place | Backend | 18.3, 11.20, 11.19 | needs 18.3 |
| `18.10` | Import UI for Figma | Interface | 18.3, 11.17 | needs 18.3 |
| `19.2` | Data contract | Contracts | 19.1 | needs 19.1 |
| `19.3` | Standalone Data Server app | Interface | 19.2, 11.1 | needs 19.2, 11.1 |
| `19.4` | Connectors: files and web | Backend | 19.2 | needs 19.2 |
| `19.5` | Connectors: databases and sheets | Backend | 19.4 | needs 19.4 |
| `19.6` | Many sources, change propagation and staleness | Backend | 19.4 | needs 19.4 |
| `19.7` | Editor reads the Data Server | Interface | 19.6, 11.19, 8.6 | needs 19.6 |
| `19.8` | Playout reads the Data Server | Backend | 19.6, 6.2, 6.3 | needs 19.6 |
| `19.9` | Data Server soak and failure tests | Backend | 19.8 | needs 19.8 |
| `19.10` | Live esports data and an AI suggestion lane | Backend | 19.8, 11.55 | needs 19.8, 11.55 |
