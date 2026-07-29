# GrapiX Editor workspace

This is the v0.2 ownership root for GrapiX authoring.

During migration Phase 1 it is a compatibility entry point over the verified
Basic v0.1 source:

- `apps/editor-web`
- `apps/desktop-tauri`
- `apps/desktop-electron` (temporary fallback)
- `services/api-server`

The physical source move happens in migration Phase 2. It must remain mechanical:
preserve behavior and history, repair paths/configuration, then pass all existing
gates before feature work resumes.

Editor owns project/source assets, authoring state, undo/redo, validation,
package publishing, and authoring Preview. It never owns on-air Program state.
