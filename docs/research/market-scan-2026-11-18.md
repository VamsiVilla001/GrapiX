# Broadcast motion-graphics market scan (18 Nov 2026)

Web research for GrapiX's feature map, run at the user's request ("search the web for XPression, Chyron, Vizrt,
Singular.live and others, list what a real-time broadcast motion-graphics application needs, and place it in its
module"). Key: **T** table-stakes, **D** differentiating, **R** rare, **U** unconfirmed (no source found).

## Headline

No vendor runs an agent loop over the engine itself. Vizrt Viz Arc 3.0 has an in-editor AI assistant (Accept/Reject)
and an MCP server, both for template editing only, with no documented permission model on the MCP route. Ross and
HighField AI (April 2026) pick templates from story context. Chyron's AI is assistive (CAMIO lower-third text, PRIME
Translate). Every vendor that says anything requires human review of AI output. Load protection is documented as
buffering, frame skipping, separate preview engines and hardware bypass; nobody documents per-layer render priority,
preview throttling or graceful degradation. No broadcast CG vendor documents per-GPU and per-output late/missed frame
counters streamed to operators.

## Features by module

| Module | Items |
|---|---|
| Scene and layers | T scene tree, groups, masks, cameras. D 2D layer tools with 3D (Unreal Motion Design). D After Effects / Illustrator ingest (Chyron PRIME 5.2). R Figma import: no vendor found. |
| Animation | T timeline, keyframes, directors, stop/continue points (Viz Stop, Local Stop, Tags), loops. D transition logic for back-to-back takes (XPression Scene Directors, Viz, Unreal). U graph-editor and expression depth against After Effects. |
| Effects and layer styles | T shaders, blur, glow. D Viz Render Pipeline post-processing. R full Photoshop/Figma layer-style parity (U for every vendor). |
| Text | T dynamic fields, font management. U auto-fit, per-character animators, RTL/Indic shaping (no vendor confirmed). D AI localisation (PRIME Translate). |
| Data and templates | T JSON, XML, RSS, CSV, Excel, Google Sheets. D REST with OAuth2 (XPression DataLinq), sports feeds (Daktronics, Genius, Stats Perform, NFL NGS), WebSocket data under 300 ms (Singular). U field validation. |
| Assets and media | T alpha clips, clip stores; XPression ClipStore pre-fetch before take. U audio depth. |
| Playout control | T rundown/playlist, cue/take, GPI, MOS (XPression Sequencer, Chyron CAMIO/ISQ, Viz Pilot/Trio). D RossTalk over TLS, Stream Deck templates (Singular UNO), Unreal Rundown Server. |
| Output | T SDI fill and key, genlock, multi-channel, NDI with alpha. D ST 2110 (Viz), SRT (Chyron PRIME 5.1). |
| Engine performance | T GPU rendering. D hardware watchdog bypass (Viz). R documented dropped-frame protection. |
| Monitoring and telemetry | D segmented render-time HUD (Viz Performance Analyzer), browser monitoring (XPression, NAB 2026). U per-GPU / per-output dashboards. |
| Collaboration and review | D Project Server with role-based access (XPression 11.5+), cloud multi-user (Singular, Viz Flowics). U comment/approval workflows. |
| Integration | T vendor APIs (RossTalk, Viz commands, Singular). D OSC status out (CasparCG). R MCP (Viz Arc 3.0, template editing only). |

## Openings for an AI-native, MCP-first product

1. Figma/PSD frame plus a data schema becomes an animated template: an agent maps layers to fields, proposes in/loop/out
   from a house motion library, and the designer accepts the diff per layer. Nobody ships this.
2. The engine as a typed, scoped MCP surface (read the scene graph, edit keyframes, bind data, render preview frames),
   with Program-affecting tools never exposed to agents.
3. Render-and-verify: the agent renders preview frames on the CPU twin and checks reference frames, text overflow and
   safe areas before publish.
4. Natural-language rundown building with operator approval per item; takes stay manual.
5. A supervising agent on live telemetry that warns and suggests (pre-warm, simplify the next item) and never acts on
   Program.
6. A data-validation agent that catches stale, implausible or overflowing values before cue.
7. Explainable diffs and an audit trail of every agent edit.

**Unsafe on air (GrapiX rule):** agents never take, clear, continue or change Program, never change engine or output
configuration during a show, and never push live data into on-air fields without an operator-approved binding.

## How engines protect live output

- CasparCG: consumer buffer depth trades latency for spike tolerance (DeckLink minimum 3 frames; 2 above it recommended).
  https://casparcg.com/docs/wiki/server/configuration
- Viz Engine: frame skipping to stay in time ("Incremental Video Wall"), optionally animating only visible objects.
  https://docs.vizrt.com/viz-engine-guide/5.2/Render_Options.html
- Viz Engine watchdog: hardware bypass on crash or power loss (default 999 ms).
  https://docs.vizrt.com/viz-engine-guide/5.4/Watchdog.html
- Viz Preview Server: a separate, load-balanced pool of engines for previews and thumbnails, off the program engine.
  https://docs.vizrt.com/preview-server-guide/4.2/About_the_Preview_Server.html
- Unconfirmed everywhere: per-layer render priority, preview throttling under program load, automatic degradation.

## Telemetry shown to operators

- Viz Engine Performance Analyzer: frame rate against output rate, per-frame microseconds for render, video I/O,
  scripts, plug-ins and animation; segmented render-time history; a scene-impact heatmap (Viz Artist 5.5).
  https://documentation.vizrt.com/viz-engine-guide/5.3/Performance.html
- CasparCG diagnostics: frame-time graphs against a real-time line; OSC `profiler/time`.
  https://casparcg.com/docs/wiki/server/diagnostics
- Outside broadcast CG: vMix "Renderer Dropped", disguise "Discarded", Pixera dropped/incomplete frames.
- Not found for Chyron PRIME, Singular, Loopic, Aximmetry or NewBlue.

## Best example per module (sources)

- Scene: Unreal Motion Design. https://forums.unrealengine.com/t/talks-and-demos-project-avalanche-a-dedicated-toolset-for-motion-and-broadcast-graphics-unreal-fest-2023/1643525
- Animation: Viz Director stops and tags. https://docs.vizrt.com/viz-artist-guide/5.2/Event_Editor.html
- Transition logic: XPression Scene Directors. https://www.rossvideo.com/resources/ross-university/xpression-transition-logic/
- Design ingest: Chyron PRIME 5.2 Adobe integration. https://chyron.com/prime-5-2-adobe-integration/
- Data: XPression DataLinq. https://documentation.rossvideo.com/files/Manuals/CG%20and%20Graphics/XPression/Application%20Notes/XPression%20DataLinq%20and%20Scoreboard%20Sources.pdf
- Live data push: Singular Data Stream API. https://developer.singular.live/data-stream-api/introduction
- Playout: Chyron CAMIO newsroom graphics. https://chyron.com/products/uncategorized/newsroom-graphics-management
- Output: Viz video output and NDI. https://docs.vizrt.com/viz-engine-guide/5.5/Video_Output.html
- Collaboration: XPression Project Server RBAC. https://www.rossvideo.com/resources/ross-university/role-based-access-control-with-xpression-project-server/
- AI: Viz Arc 3.0. https://documentation.vizrt.com/viz-arc-user-guide/3.0/Templates.html
- Ross and HighField AI: https://www.rossvideo.com/ross-video-and-highfield-ai-partner-to-deliver-ai-assisted-graphics-workflows/
