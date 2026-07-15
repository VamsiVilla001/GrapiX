//! GrapiX render daemon library.
//!
//! The daemon receives `SceneDocument` JSON (the same document the editor and
//! API server use, defined in `packages/shared-types`) over a local WebSocket,
//! renders it headlessly with wgpu using the shared shaders from
//! `packages/render-shaders`, and hands finished frames to a video output
//! backend (NDI when compiled with `--features ndi`, otherwise a null output).
//!
//! Structured as a library so integration tests (`tests/`) can exercise the
//! protocol, scene parsing, and renderer without spawning the binary.

pub mod config;
pub mod controller;
pub mod output;
pub mod protocol;
pub mod renderer;
pub mod scene;
pub mod transport;
