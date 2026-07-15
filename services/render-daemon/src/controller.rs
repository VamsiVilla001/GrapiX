//! Daemon controller: owns the scene state, the output state machine, and
//! the render/output threads. WebSocket connections call into this through
//! an `Arc<tokio::sync::Mutex<DaemonController>>`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};

use serde_json::Value;
use tokio::sync::watch;

use crate::config::OutputConfig;
use crate::output::create_output;
use crate::protocol::{
    ErrorCode, GpuStatus, OutputStatus, ProtocolError, SceneStatus, StatusReport,
};
use crate::renderer::{gpu::GpuContext, spawn_render_loop, RenderStats};
use crate::scene::{prepare_scene, PreparedScene};

/// Frames buffered between the render thread and the output thread.
/// Two slots = double buffering: one frame in flight to the output while the
/// next renders. When the output stalls, try_send fails and the frame is
/// dropped + counted instead of blocking the render clock.
const FRAME_CHANNEL_CAPACITY: usize = 2;

enum OutputState {
    Idle,
    Configured {
        config: OutputConfig,
    },
    Running {
        config: OutputConfig,
        stop: Arc<AtomicBool>,
        render_thread: std::thread::JoinHandle<()>,
        output_thread: std::thread::JoinHandle<()>,
    },
}

pub struct DaemonController {
    gpu: Arc<GpuContext>,
    scene_tx: watch::Sender<Option<Arc<PreparedScene>>>,
    scene_rx: watch::Receiver<Option<Arc<PreparedScene>>>,
    output_state: OutputState,
    stats: Arc<RenderStats>,
    pub connected_clients: Arc<AtomicUsize>,
}

impl DaemonController {
    pub fn new(gpu: Arc<GpuContext>) -> Self {
        let (scene_tx, scene_rx) = watch::channel(None);

        Self {
            gpu,
            scene_tx,
            scene_rx,
            output_state: OutputState::Idle,
            stats: Arc::new(RenderStats::default()),
            connected_clients: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Load or update the scene (v1: both are full replacement). Returns the
    /// preparation warnings so callers can surface them in the ack.
    pub fn load_scene(&mut self, scene_json: &Value) -> Result<Vec<String>, ProtocolError> {
        let prepared = prepare_scene(scene_json)
            .map_err(|error| ProtocolError::new(ErrorCode::InvalidScene, error.to_string()))?;

        for warning in &prepared.warnings {
            tracing::warn!(scene = %prepared.scene_id, "{warning}");
        }

        tracing::info!(
            scene = %prepared.scene_id,
            name = %prepared.name,
            objects = prepared.object_count,
            rects = prepared.rects.len(),
            warnings = prepared.warnings.len(),
            "scene loaded"
        );

        let warnings = prepared.warnings.clone();
        self.scene_tx
            .send(Some(Arc::new(prepared)))
            .map_err(|_| ProtocolError::new(ErrorCode::RendererError, "scene channel closed"))?;

        Ok(warnings)
    }

    pub fn configure_output(&mut self, config: OutputConfig) -> Result<(), ProtocolError> {
        if matches!(self.output_state, OutputState::Running { .. }) {
            return Err(ProtocolError::new(
                ErrorCode::OutputStateError,
                "output is running; send output.stop before output.configure",
            ));
        }

        tracing::info!(
            width = config.width,
            height = config.height,
            fps = format!("{}/{}", config.frame_rate.numerator, config.frame_rate.denominator),
            backend = ?config.backend,
            ndi_source = %config.ndi_source_name,
            "output configured"
        );

        self.output_state = OutputState::Configured { config };

        Ok(())
    }

    pub fn start_output(&mut self) -> Result<(), ProtocolError> {
        let config = match &self.output_state {
            OutputState::Idle => {
                return Err(ProtocolError::new(
                    ErrorCode::OutputStateError,
                    "no output configuration; send output.configure before output.start",
                ))
            }
            OutputState::Running { .. } => {
                return Err(ProtocolError::new(
                    ErrorCode::OutputStateError,
                    "output is already running",
                ))
            }
            OutputState::Configured { config } => config.clone(),
        };

        let mut output = create_output(&config)
            .map_err(|error| ProtocolError::new(ErrorCode::RendererError, error.to_string()))?;
        output
            .configure(&config)
            .and_then(|()| output.start())
            .map_err(|error| ProtocolError::new(ErrorCode::RendererError, error.to_string()))?;

        let (frame_tx, frame_rx) = mpsc::sync_channel(FRAME_CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::clone(&self.stats);

        stats.frames_rendered.store(0, Ordering::Relaxed);
        stats.frames_sent.store(0, Ordering::Relaxed);
        stats.frames_dropped.store(0, Ordering::Relaxed);
        *stats.last_error.lock().expect("stats mutex poisoned") = None;

        let render_thread = spawn_render_loop(
            Arc::clone(&self.gpu),
            config.clone(),
            self.scene_rx.clone(),
            frame_tx,
            Arc::clone(&stop),
            Arc::clone(&stats),
        );

        let output_stats = Arc::clone(&stats);
        let output_thread = std::thread::Builder::new()
            .name("grapix-output".to_string())
            .spawn(move || {
                // Consumes frames until the render loop drops its sender.
                // NDI network sends happen here, off the render thread.
                while let Ok(frame) = frame_rx.recv() {
                    match output.send_frame(&frame) {
                        Ok(()) => {
                            output_stats.frames_sent.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            tracing::error!(%error, backend = output.name(), "failed to send frame");
                            output_stats.record_error(&error);
                        }
                    }
                }

                if let Err(error) = output.stop() {
                    tracing::warn!(%error, "output stop reported an error");
                }
            })
            .expect("failed to spawn output thread");

        self.output_state = OutputState::Running {
            config,
            stop,
            render_thread,
            output_thread,
        };

        Ok(())
    }

    pub fn stop_output(&mut self) -> Result<(), ProtocolError> {
        match std::mem::replace(&mut self.output_state, OutputState::Idle) {
            OutputState::Running {
                config,
                stop,
                render_thread,
                output_thread,
            } => {
                stop.store(true, Ordering::Relaxed);
                // Wake the frame clock immediately. `park_timeout` preserves
                // deadline pacing while `unpark` makes stop/shutdown prompt,
                // even at the minimum supported frame rate.
                render_thread.thread().unpark();

                // The render thread may still finish an in-flight GPU
                // readback, but it no longer waits out the next frame period.
                if render_thread.join().is_err() {
                    tracing::error!("render thread panicked");
                }
                if output_thread.join().is_err() {
                    tracing::error!("output thread panicked");
                }

                tracing::info!("output stopped");
                self.output_state = OutputState::Configured { config };

                Ok(())
            }
            OutputState::Configured { config } => {
                // Stopping a non-running output keeps the configuration.
                self.output_state = OutputState::Configured { config };
                Err(ProtocolError::new(
                    ErrorCode::OutputStateError,
                    "output is not running",
                ))
            }
            OutputState::Idle => Err(ProtocolError::new(
                ErrorCode::OutputStateError,
                "output is not running",
            )),
        }
    }

    /// Called on daemon shutdown; unlike `stop_output` it never errors.
    pub fn shutdown(&mut self) {
        if matches!(self.output_state, OutputState::Running { .. }) {
            if let Err(error) = self.stop_output() {
                tracing::warn!(%error, "error while stopping output during shutdown");
            }
        }
    }

    pub fn status(&self) -> StatusReport {
        let scene = self.scene_rx.borrow().as_ref().map(|scene| SceneStatus {
            id: scene.scene_id.clone(),
            name: scene.name.clone(),
            revision: scene.revision.clone(),
            object_count: scene.object_count,
            rect_count: scene.rects.len(),
            warnings: scene.warnings.clone(),
        });

        let (state, config) = match &self.output_state {
            OutputState::Idle => ("idle", None),
            OutputState::Configured { config } => ("configured", Some(config.clone())),
            OutputState::Running { config, .. } => ("running", Some(config.clone())),
        };

        StatusReport {
            connected_clients: self.connected_clients.load(Ordering::Relaxed),
            scene,
            gpu: GpuStatus {
                adapter: self.gpu.adapter_info.name.clone(),
                backend: self.gpu.adapter_info.backend.to_string(),
            },
            output: OutputStatus {
                state: state.to_string(),
                config,
                frames_rendered: self.stats.frames_rendered.load(Ordering::Relaxed),
                frames_sent: self.stats.frames_sent.load(Ordering::Relaxed),
                frames_dropped: self.stats.frames_dropped.load(Ordering::Relaxed),
                last_render_ms: self.stats.last_render_micros.load(Ordering::Relaxed) as f64
                    / 1000.0,
                last_error: self
                    .stats
                    .last_error
                    .lock()
                    .expect("stats mutex poisoned")
                    .clone(),
            },
        }
    }
}
