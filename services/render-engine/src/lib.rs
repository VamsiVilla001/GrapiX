//! GrapiX standalone render engine.
//!
//! An independent, headless-capable, tile-based real-time broadcast graphics
//! renderer — the GrapiX equivalent of Viz Engine, in the same relationship to the
//! Editor and Playout as Viz Engine is to Viz Artist and Viz Trio.
//!
//! # What makes it independent
//!
//! No React, no Electron, no PixiJS, no DOM. The Editor and Playout reach it only
//! through the versioned protocol in [`protocol`], never by touching a renderer
//! object. It runs on the same machine, as a separate local process, on another
//! machine, on a dedicated GPU workstation, on a headless server, or as one of
//! several render nodes — all as configuration rather than as different code paths.
//!
//! # How a 50,000 x 50,000 stage is possible
//!
//! It is never a framebuffer. [`stage`] holds a *logical* coordinate space in
//! `f64`, and [`tile`] decomposes it into rectangles small enough to be real GPU
//! render targets. Only tiles become framebuffers, and only when a viewport,
//! output, preview, or export actually needs one. A stage-sized RGBA8 image would
//! be 10 GB; the engine reports that number and never allocates it.
//!
//! The precision rule that makes this work, enforced in [`stage`] and applied in
//! [`render`]:
//!
//! > Never hand absolute stage coordinates to the GPU. Subtract the tile origin in
//! > `f64` first, and only then narrow to `f32`.
//!
//! # What is reused rather than rebuilt
//!
//! `grapix_render_core` is the existing `services/render-daemon` crate: scene
//! parsing, mesh preparation, text shaping, pipeline caching, asset caching, media
//! lifecycle, resource profiles, and output adapters — around ten thousand lines
//! with a passing test suite. This engine adds the virtual canvas, tiling, the
//! render graph, protocol v3, configuration, capability reporting, preview
//! generation, diagnostics, and security on top of it.
//!
//! # Honesty rules
//!
//! - An output adapter without its SDK reports itself unavailable with a reason.
//!   It never accepts frames and discards them.
//! - Surface warp, edge blending, and bezel compensation are carried in the data
//!   model and reported as uncalibrated. The renderer does not pretend to apply
//!   them.
//! - Only the cut transition is implemented. Anything else is refused rather than
//!   silently substituted.
//! - `hardware_certified` is never set from a compile-time feature flag.

pub mod ae_ingress;
#[cfg(windows)]
pub mod ae_ring_source;
pub mod ae_runtime_client;
pub mod ae_schedule;
pub mod animation;
pub mod auth;
pub mod assets;
pub mod capabilities;
pub mod config;
pub mod easing;
pub mod editor_view;
pub mod engine;
pub mod ipc;
pub mod outputs;
pub mod patch;
pub mod preview;
pub mod program;
pub mod protocol;
pub mod recovery;
pub mod render;
pub mod scene_renderer;
pub mod security;
pub mod stage;
pub mod stream;
pub mod tile;
pub mod transport;

pub use capabilities::{EngineCapabilities, EngineState, EngineStateMachine};
pub use config::{CliOptions, EngineConfig};
pub use engine::Engine;
pub use stage::{Rect, StageDocument, VirtualCanvas};
pub use tile::{TileGrid, TileManager};
