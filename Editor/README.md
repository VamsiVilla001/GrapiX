# Editor

One of the three applications. Tauri 2 shell, Windows and macOS.

Owns mutable authoring content: scene, material, font, script and timeline
tools, project state, and durable Publish to Playout. **It cannot change
Program or outputs** (invariant 4), and it is never eligible to own Program.

Three.js is the sole browser renderer — interim 2D and the permanent overlay
layer. PixiJS is removed (ADR Part C). Editor never imports renderer internals
(invariant 3).

project-api listens on 4100.
