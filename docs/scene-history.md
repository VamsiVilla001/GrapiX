# GrapiX scene history: Undo, Redo, and history navigation

## What is publicly known

Adobe does not publish the internal source implementation of Photoshop or After Effects.
Its public UI documentation describes ordered history states, snapshots and restoration.
History correctness is **not based on edit timestamps**. A timestamp is useful for audit
metadata, but is not enough to reconstruct an exact edit.

Source references:
- Adobe Photoshop History panel: https://helpx.adobe.com/photoshop/desktop/get-started/set-up-toolbars-panels/history-panel-overview.html
- Adobe Photoshop snapshots: https://helpx.adobe.com/photoshop/desktop/get-started/set-up-toolbars-panels/create-work-snapshots.html
- PhotoCraft's Rust history model: https://github.com/storytold/photocraft/blob/main/crates/ops/src/lib.rs
- PhotoCraft's command coalescing: https://github.com/storytold/photocraft/blob/main/crates/engine-core/src/session/execute.rs
- EffectCraft's branching history: https://github.com/storytold/effectcraft/blob/main/crates/engine/src/history.rs
- EffectCraft's session editing: https://github.com/storytold/effectcraft/blob/main/crates/engine/src/session/edit.rs

## How the reference editors implement it

**PhotoCraft**: history holds copy-on-write `Arc<Document>` references, active layer
selection, a per-state ID and labels. A `coalesce` key groups consecutive
updates during one gesture. The engine supports Undo/Redo, rollback, selectable
history states, snapshot pinning, and limits on count and pixel memory.

**EffectCraft**: history holds `Arc<Project>` snapshots on undo/redo stacks.
Consecutive operations with one merge key become one history step. Its
History panel additionally retains alternate branches after Undo followed by
a new edit, and supports jumping to a branch's state.

## Current GrapiX implementation

- Each meaningful scene mutation is captured centrally from the Zustand store,
  including geometry, text, objects, materials, bindings, and keyframes.
- `SceneHistory` holds detached scene snapshots with monotonically assigned IDs,
  labels, optional selected-object restoration and audit timestamps.
- Undo and Redo restore snapshots without re-recording the restoration as a new edit.
- New edits after Undo discard the ordinary redo line; non-linear history branches
  are not implemented yet.
- Canvas drags and input-focus sessions group their updates into a single step.
- No-op changes and `updatedAt`-only changes create no history entry.
- History is reset on loading or creating a scene; only document edits are tracked,
  not zoom, panel placement, playback progress, or other UI-only state.
- A bounded 80-step in-memory history limits growth. History does not survive
  app restart. For large embedded media, a future memory-budget-aware
  copy-on-write layer is recommended.
- Autosaves are queued serially to prevent an earlier request completing after
  a later Undo/Redo and overwriting the last intended state.

## Developer check

```bash
npm ci
npm run typecheck --workspace @grapix/editor-web
npm run test --workspace @grapix/editor-web
```

Test the complete UI: add/delete an object, undo/redo, change material,
edit text in one input focus session, drag one object many times, adjust
keyframes, jump to older history, redo, then make a new edit. Save and
reload a scene to verify the new document starts with a clean history.

## Future improvements

1. Memory-aware structural sharing (copy-on-write) for large assets and scenes.
2. Explicit command labels for every edit, rather than automatic scene-diff labels.
3. Optional non-linear history branching and named pinned snapshots.
4. Persistent journal/checkpoints and crash recovery; keep this separate from the
   standard in-session Undo/Redo mechanism.
5. Database revisions or optimistic concurrency control for multi-client editing.
