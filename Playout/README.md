# GrapiX Playout workspace

This is the v0.2 ownership root for the independent Playout application.

The first Phase 4 vertical slice is implemented:

- `apps/playout-web` is a dedicated operator UI with published-scene library,
  segmented rundown, Preview/Program monitors, connection health and protected
  Cue/Take controls;
- `services/playout-control` owns atomic file-backed published scene versions,
  rundown/segment autosave and runtime Preview/Program state;
- renderer protocol v2 drives the native daemon without importing Editor state;
- `npm run dev:playout` supervises the UI, control service and daemon.

The native renderer source remains at `services/render-daemon` during the safe
path migration, but it is launched and controlled by the Playout workspace.
The future Tauri shell will supervise the same three processes without changing
their ownership boundaries.

Playout is authoritative for rundown state, Preview, Program, transitions,
automation/timecode execution, output devices, recovery, and the on-air cursor.
It must continue operating if Editor closes or disconnects.

Development endpoints:

- operator UI: `http://127.0.0.1:5174`
- Playout control API: `http://127.0.0.1:4300`
- native renderer: `ws://127.0.0.1:4200`
