//! GrapiX render core.
//!
//! Scene parsing, mesh preparation, text shaping, pipeline caching and output adapters,
//! rendered headlessly with wgpu using the shared shaders from `Shared/render-shaders`.
//! Consumed by `services/render-engine` under the alias `grapix-render-core`, which is the
//! only thing that renders in V1.
//!
//! **Library only.** This crate used to ship a `grapix-render-daemon` binary speaking
//! protocol v2 on port 4200. It is gone, along with its transport, controller, v2 protocol,
//! resource table and asset cache — roughly 3,250 lines that nothing launched and no test
//! exercised. Keeping a second renderer that could bind a port and drive its own outputs was
//! a way to put unverified pixels on air (`docs/architecture.md`, invariants 1 and 7), and
//! the engine on 4400 is the single renderer.
//!
//! The crate directory is still `services/render-daemon` so git history stays attached to
//! these files; the package name is what the engine aliases.

pub mod config;
pub mod output;
pub mod renderer;
pub mod scene;
