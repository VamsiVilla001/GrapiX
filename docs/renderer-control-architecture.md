# Renderer control architecture

The editor preview and the authoritative Program renderer are separate
responsibilities.

```text
React editor
  ├─ ScenePreviewRenderer -> Pixi preview adapter -> editor canvas only
  └─ RendererClient -> Fastify bridge -> versioned renderer protocol
                                      -> Rust/wgpu daemon -> Program output
```

## Boundaries now in the repository

- `packages/renderer-protocol` owns protocol v2 TypeScript envelopes, commands,
  replies, output configuration, channel names, and scene lifecycle names.
- `apps/editor-web/src/rendering/RendererClient.ts` defines the control seam
  for capabilities, load, warm, patch, Preview, Take, playback, and release.
- `ScenePreviewRenderer` is the editor-only drawing seam.
- `PixiPreviewRendererAdapter` contains the current Pixi implementation.
  Feature components no longer construct that implementation directly.
- `services/api-server/src/renderDaemon.ts` consumes the shared protocol
  package instead of maintaining a second handwritten wire contract.
- `services/render-daemon` remains the long-lived authority for output. A
  controller disconnect does not stop Program.

Protocol v2 requires request correlation, monotonic per-connection sequences,
timestamps, expected renderer state, and explicit scene/revision/channel
context. It adds capability negotiation and heartbeat, rejects stale sequences
and revision mismatches, and publishes typed lifecycle/channel/output events.
Structural edits use full replacement; live data/object changes use typed
`scene.patch` messages with current/next revision proof. The daemon implements warm residency, protected
Preview/Program ownership, cut Take, release, and a bounded warm LRU. Preview
is prepared state; a second continuous native Preview render output remains.

## Next daemon slice

The next implementation milestone is intentionally server-side:

1. add a native Preview render output without reducing Program priority;
2. replace patch re-preparation with targeted binding updates;
3. connect native video decode and real GPU asset promotion;
4. expand native Program coverage beyond solid rects/ellipses.

Program state will stay authoritative in the daemon. The React store may show
requested state, but it must reconcile from renderer acknowledgements/events.
