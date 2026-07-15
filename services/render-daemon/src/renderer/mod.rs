//! Renderer: headless GPU context, quad pipeline, off-screen frame target,
//! and the broadcast-clocked render loop.

pub mod frame;
pub mod gpu;
pub mod pipeline;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

use tokio::sync::watch;

use crate::config::OutputConfig;
use crate::output::VideoFrame;
use crate::scene::PreparedScene;

/// Shared render/output counters, read by status reports.
#[derive(Debug, Default)]
pub struct RenderStats {
    pub frames_rendered: AtomicU64,
    pub frames_sent: AtomicU64,
    pub frames_dropped: AtomicU64,
    /// Microseconds spent rendering + reading back the latest frame.
    pub last_render_micros: AtomicU64,
    pub last_error: Mutex<Option<String>>,
}

impl RenderStats {
    pub fn record_error(&self, error: impl std::fmt::Display) {
        *self.last_error.lock().expect("stats mutex poisoned") = Some(error.to_string());
    }
}

/// One-frame render used by tests and diagnostics; not the streaming path.
pub fn render_single_frame(
    gpu: &gpu::GpuContext,
    scene: &PreparedScene,
    width: u32,
    height: u32,
) -> anyhow::Result<VideoFrame> {
    let quad_pipeline = pipeline::QuadPipeline::new(&gpu.device);
    let target = frame::FrameTarget::new(&gpu.device, width, height);
    let quads = pipeline::QuadPipeline::build_frame_quads(scene);

    target.render_and_read_back(&gpu.device, &gpu.queue, &quad_pipeline, &quads, 0)
}

/// Spawn the render thread: renders at the configured rational frame rate and
/// pushes frames into `frame_tx` (a bounded channel to the output thread).
///
/// Design notes (see docs/render-daemon-architecture.md):
/// - The loop is driven by an integer-math frame clock derived from the
///   rational frame rate, never by incoming WebSocket traffic. Scene updates
///   land in the `watch` channel and are picked up at the next frame.
/// - The bounded channel (capacity 2) provides double buffering toward the
///   output thread; when the output cannot keep up, frames are dropped and
///   counted rather than stalling the render clock.
pub fn spawn_render_loop(
    gpu: Arc<gpu::GpuContext>,
    config: OutputConfig,
    scene_rx: watch::Receiver<Option<Arc<PreparedScene>>>,
    frame_tx: mpsc::SyncSender<VideoFrame>,
    stop: Arc<AtomicBool>,
    stats: Arc<RenderStats>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("grapix-render-loop".to_string())
        .spawn(move || {
            let quad_pipeline = pipeline::QuadPipeline::new(&gpu.device);
            let target = frame::FrameTarget::new(&gpu.device, config.width, config.height);
            let dump_path = std::env::var("GRAPIX_RENDER_DAEMON_DUMP_FIRST_FRAME").ok();

            let start = Instant::now();
            let mut frame_index: u64 = 0;
            let mut warned_empty = false;
            let mut warned_overflow = false;

            tracing::info!(
                width = config.width,
                height = config.height,
                fps = format!("{}/{}", config.frame_rate.numerator, config.frame_rate.denominator),
                "render loop started"
            );

            while !stop.load(Ordering::Relaxed) {
                let scene = scene_rx.borrow().clone();

                let frame = match &scene {
                    Some(scene) => {
                        let render_started = Instant::now();
                        let mut quads = pipeline::QuadPipeline::build_frame_quads(scene);

                        if quads.len() > pipeline::MAX_QUADS_PER_FRAME {
                            if !warned_overflow {
                                tracing::warn!(
                                    quads = quads.len(),
                                    max = pipeline::MAX_QUADS_PER_FRAME,
                                    "scene exceeds per-frame quad budget; extra quads are not rendered"
                                );
                                warned_overflow = true;
                            }
                            quads.truncate(pipeline::MAX_QUADS_PER_FRAME);
                        }

                        match target.render_and_read_back(&gpu.device, &gpu.queue, &quad_pipeline, &quads, frame_index)
                        {
                            Ok(frame) => {
                                stats
                                    .last_render_micros
                                    .store(render_started.elapsed().as_micros() as u64, Ordering::Relaxed);
                                Some(frame)
                            }
                            Err(error) => {
                                tracing::error!(%error, "frame render failed");
                                stats.record_error(&error);
                                None
                            }
                        }
                    }
                    None => {
                        if !warned_empty {
                            tracing::warn!("output running with no scene loaded; sending transparent frames");
                            warned_empty = true;
                        }
                        // No scene: emit transparent frames so downstream
                        // keying stays stable instead of freezing.
                        Some(VideoFrame {
                            width: config.width,
                            height: config.height,
                            data: vec![0u8; (config.width * config.height * 4) as usize],
                            frame_index,
                        })
                    }
                };

                if let Some(frame) = frame {
                    stats.frames_rendered.fetch_add(1, Ordering::Relaxed);

                    if frame_index == 0 {
                        if let Some(path) = &dump_path {
                            match write_ppm(path, &frame) {
                                Ok(()) => tracing::info!(path = %path, "wrote first frame as PPM"),
                                Err(error) => tracing::warn!(%error, "failed to write first-frame dump"),
                            }
                        }
                    }

                    match frame_tx.try_send(frame) {
                        Ok(()) => {}
                        Err(mpsc::TrySendError::Full(_)) => {
                            stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(mpsc::TrySendError::Disconnected(_)) => {
                            tracing::info!("output channel closed; stopping render loop");
                            break;
                        }
                    }
                }

                frame_index += 1;

                // Integer-math deadline: frame N is due at exactly
                // N * 1e9 * den / num nanoseconds after start, so 60000/1001
                // stays frame-accurate indefinitely (no float accumulation).
                let deadline_nanos = config.frame_rate.frame_deadline_nanos(frame_index);
                let elapsed_nanos = start.elapsed().as_nanos();
                if deadline_nanos > elapsed_nanos {
                    // `stop_output` unparks this thread, making the frame wait
                    // interruptible instead of forcing shutdown to wait for a
                    // whole (potentially one-second) frame period.
                    std::thread::park_timeout(std::time::Duration::from_nanos(
                        (deadline_nanos - elapsed_nanos) as u64,
                    ));
                } else if frame_index % 100 == 0 {
                    tracing::warn!(
                        behind_ms = (elapsed_nanos - deadline_nanos) as f64 / 1_000_000.0,
                        "render loop running behind the frame clock"
                    );
                }
            }

            tracing::info!(frames = frame_index, "render loop stopped");
        })
        .expect("failed to spawn render thread")
}

/// Minimal PPM (P6) dump of a BGRA frame for eyeballing output without image
/// dependencies. Alpha is discarded. Debug/diagnostic use only.
fn write_ppm(path: &str, frame: &VideoFrame) -> std::io::Result<()> {
    use std::io::Write;

    let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
    write!(out, "P6\n{} {}\n255\n", frame.width, frame.height)?;

    for pixel in frame.data.chunks_exact(4) {
        // BGRA -> RGB
        out.write_all(&[pixel[2], pixel[1], pixel[0]])?;
    }

    out.flush()
}
