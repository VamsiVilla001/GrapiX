//! The Program clock.
//!
//! Renders the on-air scene at the configured frame rate and hands each frame to
//! every running output. Only runs when something is actually on air with a running
//! output, so an idle engine costs nothing.
//!
//! Three properties that matter for broadcast:
//!
//! 1. **The schedule is absolute.** Deadlines are computed from the frame number
//!    with integer arithmetic, never accumulated, so the clock cannot drift. At
//!    59.94 the interval is 16683333.33 ns — not a whole number — which is exactly
//!    why accumulating it goes wrong over a long show.
//!
//! 2. **Late frames are dropped, not queued.** If a render overruns, the clock jumps
//!    to the frame that is actually due and counts what it skipped. Catching up
//!    frame by frame would fall further behind and play the show in slow motion.
//!
//! 3. **The render happens off the async runtime.** GPU work is synchronous and can
//!    take milliseconds; running it directly in a Tokio task would block the
//!    protocol server, so it goes through `spawn_blocking`.

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::engine::Engine;

/// How long the loop waits before re-checking when nothing is on air.
const IDLE_POLL_MS: u64 = 250;

pub struct ProgramClock {
    engine: Arc<Mutex<Engine>>,
}

impl ProgramClock {
    pub fn new(engine: Arc<Mutex<Engine>>) -> Self {
        Self { engine }
    }

    /// Run until the process ends.
    ///
    /// Spawned once at startup. It is deliberately resilient: a render failure logs
    /// and continues, because one bad frame must not stop Program.
    pub async fn run(self) {
        let mut frame: u64 = 0;
        let mut epoch = std::time::Instant::now();
        let mut running = false;
        let mut consecutive_failures: u32 = 0;

        loop {
            // Is there anything to do? Checked under a short-lived lock so the
            // protocol server is never blocked waiting on the clock.
            let (active, rate) = {
                let guard = self.engine.lock().await;
                (guard.has_running_outputs(), guard.program_frame_rate())
            };

            if !active {
                if running {
                    tracing::info!(frames = frame, "program clock idle: no running outputs");
                    running = false;
                }
                tokio::time::sleep(std::time::Duration::from_millis(IDLE_POLL_MS)).await;
                continue;
            }

            if !running {
                // Restart the schedule from now, so a gap in Program does not look
                // like thousands of dropped frames.
                frame = 0;
                epoch = std::time::Instant::now();
                running = true;
                consecutive_failures = 0;
                tracing::info!(
                    frame_rate = format!("{}/{}", rate.numerator, rate.denominator),
                    "program clock started"
                );
            }

            let next = frame + 1;
            // Absolute deadline from the frame number: computed, never accumulated.
            let deadline_ns = rate.deadline_nanos(next);
            let elapsed_ns = epoch.elapsed().as_nanos() as u64;

            if elapsed_ns < deadline_ns {
                let wait = deadline_ns - elapsed_ns;
                tokio::time::sleep(std::time::Duration::from_nanos(wait)).await;
            }

            // How far behind are we? Jump to the frame that is genuinely due rather
            // than trying to render every frame we missed.
            let due = frame_at(&rate, epoch.elapsed().as_nanos() as u64);
            let target = next.max(due);
            let dropped = target.saturating_sub(next);

            if dropped > 0 {
                tracing::debug!(dropped, target, "program clock skipped late frames");
            }

            let engine = Arc::clone(&self.engine);
            let render = tokio::task::spawn_blocking(move || {
                // `blocking_lock` is correct here: this closure is already off the
                // async runtime, so it is not holding up any other task.
                let mut guard = engine.blocking_lock();
                guard.note_dropped_program_frames(dropped);
                guard.render_program_frame(target)
            })
            .await;

            frame = target;

            match render {
                Ok(Ok(_delivered)) => consecutive_failures = 0,
                Ok(Err(error)) => {
                    consecutive_failures += 1;
                    // Log the first few, then fall quiet: a persistently failing
                    // Program must be visible in status, not by filling the log.
                    if consecutive_failures <= 3 {
                        tracing::warn!(%error, frame = target, "program frame failed");
                    }
                    if consecutive_failures == 4 {
                        tracing::warn!(
                            "further program frame failures will be reported in status only"
                        );
                    }
                    self.engine
                        .lock()
                        .await
                        .note_program_error(&error, consecutive_failures);
                }
                Err(join_error) => {
                    tracing::error!(%join_error, "program render task panicked");
                    consecutive_failures += 1;
                }
            }
        }
    }
}

/// Frame due at an elapsed nanosecond offset.
fn frame_at(rate: &crate::stage::FrameRate, elapsed_ns: u64) -> u64 {
    if rate.numerator == 0 {
        return 0;
    }
    ((elapsed_ns as u128 * u128::from(rate.numerator))
        / (1_000_000_000u128 * u128::from(rate.denominator))) as u64
}
