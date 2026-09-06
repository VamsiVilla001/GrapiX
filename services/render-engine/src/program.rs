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
///
/// Short, because this is the delay between a take and the animation starting: the playhead
/// cannot advance until the loop notices there is something on air. At 250ms an "in"
/// animation began a quarter of a second late, which on a 20-frame move is a third of the
/// motion missed. 40ms is two frames at 50fps and costs 25 short lock checks a second on a
/// machine doing nothing — cheaper than the alternative of waking this loop from the take
/// path, which would couple the protocol handler to the clock.
///
/// This only ever applies with no running output. Real air keeps the loop hot.
const IDLE_POLL_MS: u64 = 40;

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
            //
            // A scene on air is enough — a running output is not required. The playhead has
            // to advance so the operator's Preview and Program monitors animate before any
            // SDI or NDI output exists; without that, taking a scene online showed a frozen
            // first frame and the animation appeared never to play.
            let (delivering, has_scene, rate, ae_source) = {
                let guard = self.engine.lock().await;
                (
                    guard.has_running_outputs(),
                    guard.has_program_scene(),
                    guard.program_frame_rate(),
                    guard.has_ae_program_source(),
                )
            };
            let active = delivering || has_scene;

            if !active {
                if running {
                    tracing::info!(frames = frame, "program clock idle: nothing on air");
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
                    delivering,
                    "program clock started"
                );
            }

            let next = frame + 1;
            // Absolute deadline from the frame number: computed, never accumulated.
            let deadline_ns = rate.deadline_nanos(next);
            let elapsed_ns = epoch.elapsed().as_nanos() as u64;

            // Stage 1 — the request point, only when After Effects is the Program source.
            //
            // Until AE-F2a the loop had no earlier waking point at all: it slept to the presentation
            // deadline and only then rendered, which is fine for a GPU render the engine performs
            // itself and impossible for a frame another process has to evaluate first. So a bounded
            // lead is taken *out of* the existing wait rather than added to the schedule — the
            // deadline below is unchanged, and a late request never pushes presentation later.
            //
            // AE-F2b made that lead a *depth* rather than a longer sleep. The wakeup is still one
            // period early; what changed is that each wakeup asks for every frame inside the current
            // window, so a frame is requested `depth` periods before its own deadline. That is what
            // covers AE-F0's measured checkout cost, which exceeds one period at 59.94 and so could
            // never be met by a single-frame lead.
            //
            // Which frames, their absolute deadlines, the ring's capacity and the skip for a frame
            // whose deadline has already passed are all the source's arithmetic. This loop stays a
            // clock: it says "now, and the next frame is N".
            if ae_source {
                let lead_ns = request_lead_nanos(&rate);
                let request_at_ns = deadline_ns.saturating_sub(lead_ns);
                if elapsed_ns < request_at_ns {
                    tokio::time::sleep(std::time::Duration::from_nanos(request_at_ns - elapsed_ns))
                        .await;
                }
                let requested_at_ns = epoch.elapsed().as_nanos() as u64;
                let mut guard = self.engine.lock().await;
                // What the pipe learned since the last tick, applied before this tick's window is
                // computed: a ring refusal has to shrink the lead depth *before* we decide how many
                // frames to ask for, or the depth reacts a frame late every time.
                //
                // The requester thread holds no engine lock by design, so this is where its findings
                // land - on a tick that already holds it.
                for event in guard.apply_ae_render_feedback() {
                    tracing::debug!(?event, "ae render feedback");
                }
                // At most one request per frame is the ledger's guarantee, not this loop's: a
                // spurious wakeup or a slow lock must not make After Effects render it twice.
                let issued = guard.request_ae_program_frames(next, requested_at_ns);
                if issued.is_empty() {
                    tracing::trace!(frame = next, "ae lead window already outstanding or off-frame");
                } else {
                    tracing::trace!(
                        count = issued.len(),
                        first = issued.first().map(|request| request.frame),
                        last = issued.last().map(|request| request.frame),
                        requested = guard.has_ae_render_requester(),
                        "ae lead window requested"
                    );
                }
            }

            // Stage 2 — presentation. Same absolute deadline as before the request stage existed.
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
                // Requests for frames the clock has skipped are abandoned and counted missed. They are
                // never queued: a render that arrives for a frame already past is refused as historical
                // by ingress, which is what stops AE time replaying in slow motion.
                if ae_source {
                    let abandoned = self.engine.lock().await.abandon_ae_program_requests_before(target);
                    if !abandoned.is_empty() {
                        tracing::debug!(count = abandoned.len(), target, "abandoned ae requests");
                    }
                }
            }

            // Frames really elapsed since the last tick, so a dropped frame moves the
            // animation on by the time that passed instead of playing it in slow motion.
            let elapsed_frames = target.saturating_sub(frame);

            // Advancing the playhead is a counter increment, so it happens under a short
            // async lock. Sending it through `spawn_blocking` would cost a thread-pool round
            // trip fifty times a second on a machine with nothing transmitting.
            {
                let mut guard = self.engine.lock().await;
                guard.note_dropped_program_frames(dropped);
                guard.advance_program_playhead(elapsed_frames);
            }

            // GPU work, and only when something is actually transmitting. The monitors get
            // their pixels from the preview streamer, which renders on its own schedule off
            // the same advancing playhead.
            let render = if delivering {
                let engine = Arc::clone(&self.engine);
                tokio::task::spawn_blocking(move || {
                    // `blocking_lock` is correct here: this closure is already off the
                    // async runtime, so it is not holding up any other task.
                    let mut guard = engine.blocking_lock();
                    guard.render_program_frame(target)
                })
                .await
            } else {
                Ok(Ok(0))
            };

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

/// How far ahead of a frame's presentation deadline After Effects is asked for it.
///
/// One frame period, capped. One period is the largest lead that cannot overlap the previous frame's
/// own request — at two periods the clock would have two frames outstanding before either presented,
/// which is `AE-F2b`'s pipelining question and not something to acquire by accident here.
///
/// The cap matters at absurd rates: at 1 fps a full-period lead would ask a second early and hold a ring
/// slot for that whole second. `AE-F0` measured checkout costs in the tens of milliseconds, so 50 ms is
/// generous for the work while staying far inside a 59.94 period of 16.68 ms — which is itself below the
/// cap, so at broadcast rates the lead *is* exactly one period.
const MAX_REQUEST_LEAD_NS: u64 = 50_000_000;

fn request_lead_nanos(rate: &crate::stage::FrameRate) -> u64 {
    if rate.numerator == 0 {
        return 0;
    }
    let period_ns = (1_000_000_000u128 * u128::from(rate.denominator)
        / u128::from(rate.numerator)) as u64;
    period_ns.min(MAX_REQUEST_LEAD_NS)
}

#[cfg(test)]
mod tests {
    use super::{frame_at, request_lead_nanos, MAX_REQUEST_LEAD_NS};
    use crate::stage::FrameRate;

    #[test]
    fn request_lead_is_one_period_at_broadcast_rates() {
        let rates = [
            FrameRate {
                numerator: 60_000,
                denominator: 1_001,
            },
            FrameRate {
                numerator: 30_000,
                denominator: 1_001,
            },
            FrameRate {
                numerator: 2_997,
                denominator: 100,
            },
            FrameRate {
                numerator: 50,
                denominator: 1,
            },
        ];

        for rate in rates {
            assert_eq!(request_lead_nanos(&rate), rate.frame_duration_nanos());
        }
        assert_eq!(
            request_lead_nanos(&FrameRate {
                numerator: 60_000,
                denominator: 1_001,
            }),
            16_683_333
        );
    }

    #[test]
    fn request_lead_is_capped_at_one_fps() {
        let rate = FrameRate {
            numerator: 1,
            denominator: 1,
        };

        assert_eq!(request_lead_nanos(&rate), MAX_REQUEST_LEAD_NS);
        assert_ne!(request_lead_nanos(&rate), rate.frame_duration_nanos());
    }

    #[test]
    fn request_lead_is_zero_for_a_zero_numerator() {
        assert_eq!(
            request_lead_nanos(&FrameRate {
                numerator: 0,
                denominator: 1,
            }),
            0
        );
    }

    /// `deadline_nanos` and `frame_at` both truncate, so a deadline does **not** round-trip.
    ///
    /// This was written the other way first, asserting `frame_at(deadline_nanos(f)) == f`, and it
    /// failed for 1,333 of the first 2,000 frames at `60000/1001`. The cause is not a bug: frame 1's
    /// exact deadline is 16,683,333.33 ns, `deadline_nanos` truncates it to 16,683,333, and `frame_at`
    /// of that instant is 0.99999998, which truncates to 0. Both functions round down, so waking at the
    /// stored deadline can land one frame *behind*.
    ///
    /// What matters is the direction of the error and the fact that the clock absorbs it: `due` may lag
    /// by one but can never lead, and the clock takes `target = next.max(due)`. That `max` is therefore
    /// load-bearing arithmetic, not defensive coding — without it Program would present frame `next-1`
    /// on two consecutive ticks at every rate whose period is not a whole nanosecond.
    #[test]
    fn a_truncated_deadline_can_lag_one_frame_and_never_leads() {
        let rate = FrameRate {
            numerator: 60_000,
            denominator: 1_001,
        };

        let mut lagged = 0;
        for frame in 1..=2_000u64 {
            let deadline = rate.deadline_nanos(frame);
            let due = frame_at(&rate, deadline);

            assert!(
                due == frame || due + 1 == frame,
                "frame {frame}: due {due} must be that frame or exactly one behind"
            );
            assert!(due <= frame, "frame {frame}: due {due} must never lead the deadline");
            if due + 1 == frame {
                lagged += 1;
            }

            // One nanosecond past the truncated deadline is always inside the frame itself, which is
            // why the presentation sleep waking even marginally late resolves to the right target.
            assert_eq!(
                frame_at(&rate, deadline + 1),
                frame,
                "frame {frame}: one nanosecond past its deadline must be inside it"
            );

            // The clock's own resolution, reproduced exactly.
            assert_eq!(frame.max(due), frame, "the max must recover the intended frame");
        }

        assert!(
            lagged > 1_000,
            "the lag must be common rather than a rounding curiosity; observed {lagged} of 2000"
        );
    }

    /// Deadlines are strictly increasing, so a request point can never overtake the frame before it.
    #[test]
    fn deadlines_increase_strictly_at_a_non_integer_rate() {
        let rate = FrameRate {
            numerator: 60_000,
            denominator: 1_001,
        };
        for frame in 0..5_000u64 {
            assert!(
                rate.deadline_nanos(frame) < rate.deadline_nanos(frame + 1),
                "deadline for {frame} must precede {}",
                frame + 1
            );
        }
    }
}
