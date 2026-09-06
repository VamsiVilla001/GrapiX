//! Renderer: headless GPU context, quad pipeline, off-screen frame target,
//! and the broadcast-clocked render loop.

pub mod frame;
pub mod gpu;
pub mod mesh;
pub mod pipeline;
pub mod text;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::config::OutputConfig;
use crate::output::VideoFrame;
use crate::scene::PreparedScene;

/// Shared render/output counters, read by status reports.
#[derive(Debug)]
pub struct RenderStats {
    pub frames_rendered: AtomicU64,
    pub frames_sent: AtomicU64,
    pub frames_dropped: AtomicU64,
    /// Microseconds spent rendering + reading back the latest frame.
    pub last_render_micros: AtomicU64,
    pub last_error: Mutex<Option<String>>,
    render_micros: Mutex<VecDeque<u64>>,
}

impl RenderStats {
    pub fn reset_for_output(&self) {
        self.frames_rendered.store(0, Ordering::Relaxed);
        self.frames_sent.store(0, Ordering::Relaxed);
        self.frames_dropped.store(0, Ordering::Relaxed);
        self.last_render_micros.store(0, Ordering::Relaxed);
        *self.last_error.lock().expect("stats mutex poisoned") = None;
        self.render_micros
            .lock()
            .expect("timing mutex poisoned")
            .clear();
    }

    pub fn record_error(&self, error: impl std::fmt::Display) {
        *self.last_error.lock().expect("stats mutex poisoned") = Some(error.to_string());
    }

    pub fn record_render_duration(&self, duration: Duration) {
        let micros = duration.as_micros() as u64;
        self.last_render_micros.store(micros, Ordering::Relaxed);
        let mut samples = self.render_micros.lock().expect("timing mutex poisoned");
        if samples.len() == samples.capacity() {
            samples.pop_front();
        }
        samples.push_back(micros);
    }

    pub fn timing_snapshot(&self) -> RenderTimingSnapshot {
        let samples = self.render_micros.lock().expect("timing mutex poisoned");
        if samples.is_empty() {
            return RenderTimingSnapshot::default();
        }
        let average_micros = samples.iter().sum::<u64>() as f64 / samples.len() as f64;
        let mut sorted: Vec<_> = samples.iter().copied().collect();
        sorted.sort_unstable();
        let p99_index = ((sorted.len() - 1) as f64 * 0.99).ceil() as usize;
        RenderTimingSnapshot {
            sample_count: samples.len(),
            average_ms: average_micros / 1000.0,
            p99_ms: sorted[p99_index] as f64 / 1000.0,
        }
    }
}

impl Default for RenderStats {
    fn default() -> Self {
        Self {
            frames_rendered: AtomicU64::new(0),
            frames_sent: AtomicU64::new(0),
            frames_dropped: AtomicU64::new(0),
            last_render_micros: AtomicU64::new(0),
            last_error: Mutex::new(None),
            render_micros: Mutex::new(VecDeque::with_capacity(600)),
        }
    }
}

#[derive(Debug, Default)]
pub struct RenderTimingSnapshot {
    pub sample_count: usize,
    pub average_ms: f64,
    pub p99_ms: f64,
}

/// One-frame render used by tests and diagnostics; not the streaming path.
pub fn render_single_frame(
    gpu: &gpu::GpuContext,
    scene: &PreparedScene,
    width: u32,
    height: u32,
) -> anyhow::Result<VideoFrame> {
    let mut quad_pipeline = pipeline::QuadPipeline::new(&gpu.device);
    let mesh_pipeline = mesh::MeshPipeline::new(&gpu.device);
    let target = frame::FrameTarget::new(&gpu.device, width, height);
    let quads = pipeline::QuadPipeline::build_frame_quads(scene);
    let meshes = mesh_pipeline.prepare_frame(&gpu.device, &gpu.queue, scene);

    let lease = target
        .try_acquire_frame()
        .ok_or_else(|| anyhow::anyhow!("bounded video frame pool is exhausted"))?;
    let mut frame = target.render_and_read_back(
        &gpu.device,
        &gpu.queue,
        &mut quad_pipeline,
        &quads,
        &mesh_pipeline,
        Some(&meshes),
        0,
        lease,
    )?;
    text::NativeTextRenderer::new().composite(&mut frame, scene);
    Ok(frame)
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
            let mut quad_pipeline = pipeline::QuadPipeline::new(&gpu.device);
            let mesh_pipeline = mesh::MeshPipeline::new(&gpu.device);
            let target = frame::FrameTarget::new(&gpu.device, config.width, config.height);
            let mut text_renderer = text::NativeTextRenderer::new();
            let dump_path = std::env::var("GRAPIX_RENDER_DAEMON_DUMP_FIRST_FRAME").ok();

            let start = Instant::now();
            let mut frame_index: u64 = 0;
            let mut warned_empty = false;
            let mut warned_overflow = false;
            let mut cached_mesh_scene: Option<Arc<PreparedScene>> = None;
            let mut cached_mesh_frame: Option<mesh::MeshFrame> = None;

            tracing::info!(
                width = config.width,
                height = config.height,
                fps = format!("{}/{}", config.frame_rate.numerator, config.frame_rate.denominator),
                "render loop started"
            );

            while !stop.load(Ordering::Relaxed) {
                let scene = scene_rx.borrow().clone();

                let frame = match (scene.as_ref(), target.try_acquire_frame()) {
                    (_, None) => {
                        stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                    (Some(scene), Some(lease)) => {
                        let render_started = Instant::now();
                        let mut quads = pipeline::QuadPipeline::build_frame_quads(scene);
                        if cached_mesh_scene
                            .as_ref()
                            .is_none_or(|cached| !Arc::ptr_eq(cached, scene))
                        {
                            cached_mesh_frame = Some(mesh_pipeline.prepare_frame(
                                &gpu.device,
                                &gpu.queue,
                                scene,
                            ));
                            cached_mesh_scene = Some(Arc::clone(scene));
                        }
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
                        match target.render_and_read_back(
                            &gpu.device,
                            &gpu.queue,
                            &mut quad_pipeline,
                            &quads,
                            &mesh_pipeline,
                            cached_mesh_frame.as_ref(),
                            frame_index,
                            lease,
                        ) {
                            Ok(mut frame) => {
                                text_renderer.composite(&mut frame, scene);
                                stats.record_render_duration(render_started.elapsed());
                                Some(frame)
                            }
                            Err(error) => {
                                tracing::error!(%error, "frame render failed");
                                stats.record_error(&error);
                                None
                            }
                        }
                    }
                    (None, Some(mut lease)) => {
                        if !warned_empty {
                            tracing::warn!("output running with no scene loaded; sending transparent frames");
                            warned_empty = true;
                        }
                        lease.as_mut_slice().fill(0);
                        Some(VideoFrame {
                            width: config.width,
                            height: config.height,
                            data: lease,
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
