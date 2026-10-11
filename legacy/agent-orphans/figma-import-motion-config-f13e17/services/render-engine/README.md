# Render Engine

One of the three applications, and the only implementation that evaluates and
rasterizes production scene pixels (invariant 2).

| Unit | Role |
|---|---|
| `host` | Persistent single-instance Engine Host. Supervises the worker, journals Program mutations, performs verified restore. Neither Editor nor Playout stops it on window close |
| `worker` | Native Rust/wgpu Render Worker. Scene evaluation, tiling, Program frames, outputs |

**This product owns time** (ADR-002). ProgramClock is slaved to the output
device's reference clock when a genlocked live adapter is configured, and
free-runs — reported as free-run — when no reference is present.

Listens on 4400. Ports 4400–4403 are engine and render nodes; 4200 is burned
(invariant 32).
