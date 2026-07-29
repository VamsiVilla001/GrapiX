//! `grapix-render-engine` entry point.
//!
//! ```text
//! grapix-render-engine --config engine.toml
//! grapix-render-engine --config engine.toml --bind 0.0.0.0 --port 4300
//! GRAPIX_ENGINE_PORT=4301 grapix-render-engine --config engine.toml
//! grapix-render-engine --config engine.toml --print-config
//! ```
//!
//! Precedence: CLI argument > environment variable > TOML file > built-in default.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use tokio::sync::Mutex;

use grapix_render_engine::capabilities::{
    resolve_engine_id, EngineCapabilities, ENGINE_SOFTWARE_VERSION,
};
use grapix_render_engine::config::{self, CliOptions, EngineConfig, USAGE};
use grapix_render_engine::engine::Engine;
use grapix_render_engine::program::ProgramClock;
use grapix_render_engine::stream::PreviewStreamer;
use grapix_render_engine::{ipc, transport};

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();

    let cli = match config::parse_cli(&arguments) {
        Ok(cli) => cli,
        Err(error) => {
            eprintln!("grapix-render-engine: {error}");
            eprintln!();
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    if cli.help {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if cli.version {
        println!("grapix-render-engine {ENGINE_SOFTWARE_VERSION}");
        return ExitCode::SUCCESS;
    }

    match run(cli) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("grapix-render-engine: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: CliOptions) -> anyhow::Result<ExitCode> {
    let environment = config::process_env();
    let (engine_config, warnings) = config::load(&cli, &environment)?;

    // --print-config resolves the whole precedence chain and exits, so an operator
    // can confirm what a deployment actually produced rather than reasoning about
    // it. Deliberately before any GPU work: it must work on a machine with no GPU.
    if cli.print_config {
        for warning in &warnings {
            println!("# warning: {warning}");
        }
        print!("{}", engine_config.to_toml());
        return Ok(ExitCode::SUCCESS);
    }

    init_tracing(&engine_config.diagnostics.log_level);

    for warning in &warnings {
        tracing::warn!("{warning}");
    }

    let state_directory = state_directory(&engine_config);
    let engine_id = resolve_engine_id(&engine_config, &state_directory);

    // Resolve the token before touching the GPU: misconfigured auth should fail
    // in milliseconds, not after a device initialisation.
    let token = engine_config.resolve_token()?;
    if engine_config.auth.required && token.is_none() {
        anyhow::bail!(
            "auth.required is set but no token could be resolved; set auth.token-file or GRAPIX_ENGINE_TOKEN"
        );
    }

    tracing::info!(
        engine_id = %engine_id,
        name = %engine_config.identity.name,
        version = ENGINE_SOFTWARE_VERSION,
        bind = %engine_config.network.bind_address,
        port = engine_config.network.websocket_port,
        headless = engine_config.gpu.headless,
        remote = engine_config.network.is_remote_reachable(),
        "grapix render engine starting"
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async move {
        // A render engine without a GPU is misconfiguration, not a state to limp
        // along in. Fail fast and say so.
        let gpu = grapix_render_core::renderer::gpu::GpuContext::new()
            .await
            .map_err(|error| {
                anyhow::anyhow!(
                    "no usable GPU adapter: {error:#}. A render engine cannot run without one; \
                     check the driver, or set gpu.preferred-backend."
                )
            })?;

        let capabilities =
            EngineCapabilities::build(&engine_id, &engine_config, &gpu.adapter_info, &gpu.limits);

        tracing::info!(
            adapter = %capabilities.gpu.adapter,
            backend = %capabilities.gpu.backend,
            device_type = %capabilities.gpu.device_type,
            max_texture = capabilities.limits.max_texture_dimension_2d,
            max_logical_canvas = capabilities.limits.max_logical_canvas_width,
            max_tile = capabilities.limits.max_tile_size,
            "gpu ready"
        );

        // The number that explains why tiling exists, logged once at startup.
        let stage_bytes = grapix_render_engine::stage::VirtualCanvas::new(
            engine_config.stage.max_logical_canvas_width,
            engine_config.stage.max_logical_canvas_height,
        )
        .full_resolution_bytes();
        tracing::info!(
            max_logical_canvas_bytes = stage_bytes,
            tile_size = engine_config.stage.default_tile_width,
            overscan = engine_config.stage.default_overscan,
            "virtual canvas configured; the maximum stage is never allocated as one target"
        );

        if engine_config.gpu.require_discrete_gpu
            && !capabilities.gpu.device_type.contains("Discrete")
        {
            anyhow::bail!(
                "gpu.require-discrete-gpu is set but the selected adapter is {}",
                capabilities.gpu.device_type
            );
        }

        for adapter in &capabilities.output_adapters {
            if adapter.available {
                tracing::info!(
                    adapter = %adapter.adapter_id,
                    certified = adapter.hardware_certified,
                    "output adapter available"
                );
            } else {
                tracing::warn!(
                    adapter = %adapter.adapter_id,
                    reason = adapter.unavailable_reason.as_deref().unwrap_or("unknown"),
                    "output adapter unavailable"
                );
            }
        }

        let engine = Arc::new(Mutex::new(Engine::new(
            engine_config.clone(),
            engine_id.clone(),
            capabilities,
            Arc::new(gpu),
        )));

        // The Program clock renders on air at the configured rate and feeds every
        // running output. It idles cheaply when nothing is live, and it is
        // deliberately independent of any client connection: Program keeps running
        // when the Editor and Playout both go away.
        tokio::spawn(ProgramClock::new(Arc::clone(&engine)).run());

        // Preview streams are served by their own task, at their own (lower) cadence.
        // Separate from the Program clock on purpose: a preview must never be able to
        // delay a Program frame, and Program must keep running when every preview
        // client goes away.
        tokio::spawn(PreviewStreamer::new(Arc::clone(&engine)).run());

        // Local IPC, when configured. Opt-in: a deployment that does not use it should
        // not have a socket appear. It runs beside the WebSocket listener rather than
        // instead of it, so an embedded Editor and a remote Playout can be served at once.
        if engine_config.network.ipc_endpoint.is_some() {
            let ipc_config = engine_config.clone();
            let ipc_engine = Arc::clone(&engine);
            tokio::spawn(async move {
                if let Err(error) = ipc::serve(ipc_config, ipc_engine).await {
                    // Never fatal: losing IPC must not take down an engine that is on air
                    // serving WebSocket clients.
                    tracing::error!(%error, "local IPC listener stopped");
                }
            });
        }

        // The engine owns Program state, so a client disconnecting — or every
        // client disconnecting — never disturbs what is on air.
        transport::serve(engine_config, engine).await?;

        Ok::<ExitCode, anyhow::Error>(ExitCode::SUCCESS)
    })
}

/// Where the engine keeps state that must survive a restart, notably its id.
fn state_directory(engine_config: &EngineConfig) -> PathBuf {
    PathBuf::from(&engine_config.assets.cache_directory).join("state")
}

fn init_tracing(level: &str) {
    let filter = tracing_subscriber::EnvFilter::try_from_env("GRAPIX_ENGINE_LOG")
        .or_else(|_| tracing_subscriber::EnvFilter::try_new(level))
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    tracing_subscriber::fmt().with_env_filter(filter).init();
}
