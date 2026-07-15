//! GrapiX render daemon entry point.
//!
//! Run with `cargo run` (null output available) or
//! `cargo run --features ndi` (NDI output; requires the NDI SDK).
//! See README.md for configuration and the WebSocket protocol.

use std::sync::Arc;

use tokio::sync::Mutex;

use grapix_render_daemon::config::DaemonConfig;
use grapix_render_daemon::controller::DaemonController;
use grapix_render_daemon::renderer::gpu::GpuContext;
use grapix_render_daemon::transport::websocket;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("GRAPIX_RENDER_DAEMON_LOG")
                .or_else(|_| tracing_subscriber::EnvFilter::try_from_default_env())
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = DaemonConfig::from_env()?;

    // Fail fast: a render daemon without a GPU is misconfiguration, not a
    // state to limp along in.
    let gpu = Arc::new(GpuContext::new().await?);

    tracing::info!(
        ndi_feature = cfg!(feature = "ndi"),
        "grapix render daemon starting"
    );

    let controller = Arc::new(Mutex::new(DaemonController::new(gpu)));

    websocket::serve(config, controller).await
}
