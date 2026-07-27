# `@grapix/sdk`

JavaScript/TypeScript authoring surface for GrapiX sequence conditions and
per-scene automation modules.

Exports:

- `GrapixSequenceEngine`
- `evaluateCondition`
- `defineSceneScript`
- `createSceneScriptApi`

The SDK creates typed actions; it does not connect directly to the renderer.
Only the authenticated GrapiX control service may translate those actions into
revision-safe renderer commands.

Scene scripts should be authored with normal package imports and bundled to one
self-contained `.mjs` file before import. GrapiX does not execute arbitrary
source in the API process, editor webview, or native renderer.
