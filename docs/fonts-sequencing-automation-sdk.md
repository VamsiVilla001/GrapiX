# Fonts, sequencing, transitions, automation, and JavaScript SDK

This document extends the reviewed broadcast architecture without weakening its
Program-output boundary. The editor and control service may author and evaluate
automation; the native renderer executes only typed, revision-safe commands.
It never evaluates JavaScript.

## Font Manager

`SceneDocument.fonts` is a family/face registry. A face can use:

- a checksummed OTF, TTF, WOFF, or WOFF2 `font` asset embedded in `.gfxpkg`;
- an allowlisted HTTPS Google Fonts or Bunny Fonts stylesheet reference;
- an Adobe Fonts project link normalized to
  `https://use.typekit.net/{projectId}.css`.

The Font Manager generates browser CSS for preview and assigns a family plus,
for file fonts, `fontAssetId` to text objects. CSS and Adobe sources are
references, not copied font binaries. They retain their licensing and network
requirements and receive a package-preflight warning. Arbitrary CSS hosts are
rejected because a stylesheet can affect more than font faces. On-air profiles should
use a licensed packaged file or a declared fallback.

Native text shaping/rasterization remains an explicit renderer gate. The daemon
reports `nativeTextRender=false`, `packagedFontFiles=false`, and
`remoteFontCss=false`; therefore a browser-loaded font is not misrepresented as
native Program support.

## Multiple sequences and timelines

A `RundownDocument` owns multiple `SequenceDocument` values. Each sequence has:

- its own frame rate and duration;
- Program, overlay, automation, or audio tracks;
- scene cues with start/duration/prewarm frames;
- transition references;
- conditional trigger rules.

Rundowns are stored atomically under the project data root with monotonic
revisions. The Sequencer panel can create multiple sequences and place saved
scenes on its Program track. Scene-local object animation remains in
`SceneDocument.timeline`; cross-scene playout belongs to the rundown.

The future on-air sequencer process—not the editor tab—must own the active
rundown cursor, timecode lock, retry/idempotency state, and automatic cue
advancement.

## Transition scope

### T0 — cut

Implemented and certified by renderer protocol v2. A Take switches the prepared
Program scene at a frame boundary.

### T1 — mix, dip, wipe, and push

Required implementation:

1. Keep outgoing and incoming scenes resident and protected.
2. Render both into separate targets.
3. Composite with a renderer-clock progress value.
4. Budget the second render target and both scene working sets before Take.
5. Expose transition progress, cancellation, completion, and failure events.
6. Add Preview/Program parity and dropped-frame certification.

### T2 — custom transitions

Custom WGSL transitions require a validated shader manifest, bounded textures
and parameters, offline compilation, deterministic fallback, and package
capability declarations. A custom transition without a shader is a preflight
error.

Only `cut` is currently advertised by the native daemon. Other transition
definitions persist and sequence correctly, but execution returns `deferred`
instead of silently substituting a cut.

## Trigger and conditional behavior

Conditions are a bounded declarative AST (`all`, `any`, `not`, `exists`, and
typed comparisons). Operands may read the event payload, scene data, rundown
variables, or literals. Rules add event type/name matching, priority, cooldown,
one-shot behavior, and ordered typed actions.

Supported action contracts include warm, Preview, Take, release, data patch,
timeline control, cue navigation, and event emission. The API executes the
currently safe subset and reports unsupported timeline/transition work as
`deferred`. Dry-run evaluation is available before execution.

Trigger sources are manual, API, webhook, data change, timer, timecode,
keyboard, and scene event. Production adapters must authenticate and normalize
external webhook/timecode feeds before creating a `GrapixTriggerEvent`.

## Per-scene JavaScript and `@grapix/sdk`

Each scene can reference one checksummed JavaScript asset through
`SceneDocument.automation.script`. The reference fixes:

- SDK API version;
- exact asset checksum;
- entrypoint;
- enabled state;
- permissions;
- `control-sandbox` execution mode.

The first `@grapix/sdk` package provides:

- `defineSceneScript`;
- condition evaluation;
- the stateful `GrapixSequenceEngine`;
- a capability-scoped scene API;
- typed action collection with permission and action-count limits.

Script import rejects host globals, imports, network APIs, Node/filesystem
access, dynamic code generation, WebAssembly, and shared memory. This static
gate is defense in depth, not a complete hostile-code sandbox.

Arbitrary source execution is deliberately not in the API process, Tauri
webview, or native render daemon. The next runtime stage must use a disposable
isolated worker process/realm with no filesystem or network authority, strict
CPU/wall-time/memory limits, signed script approval, structured-clone inputs,
and typed-action-only output. Until that worker is implemented, declarative
rules are the production execution path and script assets remain packaged,
validated SDK modules.

An authored module uses the SDK:

```js
import { defineSceneScript } from "@grapix/sdk";

export default defineSceneScript({
  apiVersion: 1,
  onEvent(gx) {
    if (gx.getData("score.home") >= 10) {
      gx.take(undefined, "score-mix");
      gx.emit("scoreboard.taken");
    }
  }
});
```

The build step must bundle this into one self-contained `.mjs` artifact before
Font/Script Manager import; runtime imports remain forbidden.

## Control APIs

- `POST /api/fonts/import`
- `POST /api/fonts/link`
- `POST /api/import/scene-script`
- `GET|POST /api/rundowns`
- `GET /api/rundowns/:rundownId`
- `POST /api/rundowns/:rundownId/events`
- `POST /api/scenes/:sceneId/events`

Event requests default to dry-run unless `execute: true` is explicit.

## Production acceptance gates

- Native text renderer passes packaged-font shaping and preview-parity tests.
- Remote fonts have an offline fallback and license approval.
- T1 transitions pass HD/UHD headroom tests with both scenes resident.
- The sequencer owns cursor/timecode state independently of the editor.
- Webhook and API sources are authenticated, replay-protected, and audited.
- The isolated script worker passes escape, timeout, memory, and action-flood
  tests before scene scripts are enabled on-air.
