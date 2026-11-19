//! The load governor (build plan 3.24): Program is never late because something
//! else spiked.
//!
//! The governor watches what Program's own frames cost and sheds *non-live* work
//! in a named, graded, reversible order. It never touches Program: ADR-0003 has
//! no CPU path for Program, so "move work to the CPU" can only mean work that was
//! never live. Jev and Laya's design review is `docs/evidence/3.24`.
//!
//! The governor is a pure state machine. It reads no clock and no GPU counter: it
//! is fed one [`Observation`] per emitted frame, so the same frames always give
//! the same transitions and a test can pin every one. Time is frames: "for 5
//! seconds" is `250` frames at 50 fps, which is also the right unit when the rate
//! is 29.97.
//!
//! **The signal** is leading indicators with hysteresis, plus an immediate trip:
//!
//! - *enter*: the 95th percentile of render time above [`ENTER_RATIO`] of the
//!   interval, or the readback more than [`LAG_FRAMES`] behind, or the ring full;
//! - *trip at once*: any late or missed Program frame (Program has already
//!   failed, so shed now);
//! - *leave*: only after [`RELEASE_AFTER`] consecutive calm frames, calm meaning
//!   p95 under [`LEAVE_RATIO`], readback not behind and no late or missed frame.
//!   Between the two ratios nothing moves (the dead band), so the level does not
//!   flap.
//!
//! **The order** is graded, cheapest to the operator first, and released in
//! reverse (`Level`). A level is only *claimed* when something sheds at it: the
//! governor is built with the highest level that is wired, and never reports a
//! level that would be a lie. Today that is [`Level::DetachedThrottled`].
//!
//! Nothing is measured here that the engine cannot measure: there is no GPU
//! utilisation, because wgpu timestamp queries are off (see `metrics.rs`).

use std::collections::VecDeque;
use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Condvar, Mutex};

/// Frames of render time the percentile is taken over.
pub const WINDOW: usize = 100;
/// The fewest samples a percentile is trusted with.
pub const MIN_SAMPLES: usize = 20;
/// Render time as a share of the interval at which pressure begins.
pub const ENTER_RATIO: f64 = 0.70;
/// Render time as a share of the interval under which a frame is calm.
pub const LEAVE_RATIO: f64 = 0.50;
/// Readback this many clock frames behind is pressure (1 to 2 is a healthy ring).
pub const LAG_FRAMES: u64 = 2;
/// Consecutive pressured frames before the next step up, for the soft signals.
pub const ESCALATE_AFTER: u32 = 25;
/// The shortest gap between two steps up when Program has already been late.
pub const HARD_HOLD: u32 = 5;
/// Consecutive calm frames before one step down.
pub const RELEASE_AFTER: u32 = 250;

/// What is being shed, cheapest first. Each level includes the ones below it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Level {
    Normal = 0,
    /// Detached work (headless renders) runs one at a time.
    DetachedThrottled = 1,
    /// Preview updates less often; Program is untouched.
    PreviewDecimated = 2,
    /// New scene preparation and asset builds wait until the pressure clears.
    PrepareDeferred = 3,
    /// New headless renders and prepares are refused by name, with a retry hint.
    NonLiveRefused = 4,
}

impl Level {
    pub const ALL: [Level; 5] = [
        Level::Normal,
        Level::DetachedThrottled,
        Level::PreviewDecimated,
        Level::PrepareDeferred,
        Level::NonLiveRefused,
    ];

    fn up(self) -> Option<Level> {
        Self::ALL.get(self as usize + 1).copied()
    }

    fn down(self) -> Option<Level> {
        (self as usize).checked_sub(1).map(|i| Self::ALL[i])
    }

    /// What is shed at this level, in words an operator can act on.
    pub fn describes(self) -> &'static str {
        match self {
            Level::Normal => "nothing is shed",
            Level::DetachedThrottled => "headless renders run one at a time",
            Level::PreviewDecimated => "Preview updates less often",
            Level::PrepareDeferred => "new scene preparation waits",
            Level::NonLiveRefused => "new headless renders and prepares are refused",
        }
    }
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Level::Normal => "normal",
            Level::DetachedThrottled => "detached-throttled",
            Level::PreviewDecimated => "preview-decimated",
            Level::PrepareDeferred => "prepare-deferred",
            Level::NonLiveRefused => "non-live-refused",
        })
    }
}

/// What one emitted Program frame cost.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Observation {
    pub render_nanos: u64,
    pub interval_nanos: u64,
    pub late: bool,
    /// Clock frames Program was never emitted for, before this one.
    pub missed: u64,
    /// Clock frames between the newest delivered frame's submission and now; `None`
    /// when Program is not on the GPU readback ring.
    pub frames_behind: Option<u64>,
    /// Times the readback ring was full since the last observation.
    pub ring_full: u64,
}

/// Why the level moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    LateFrame,
    MissedFrames(u64),
    RenderPercentile { percent: u32 },
    ReadbackBehind(u64),
    RingFull,
    Cleared { calm_frames: u32 },
    ProgramEmpty,
}

impl fmt::Display for Reason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Reason::LateFrame => f.write_str("a Program frame was late"),
            Reason::MissedFrames(n) => write!(f, "{n} Program clock frame(s) were missed"),
            Reason::RenderPercentile { percent } => write!(
                f,
                "render time at the 95th percentile is {percent}% of the frame interval (enters at {}%)",
                (ENTER_RATIO * 100.0) as u32
            ),
            Reason::ReadbackBehind(n) => write!(f, "GPU readback is {n} clock frames behind (healthy is 1 to 2)"),
            Reason::RingFull => f.write_str("the GPU readback ring was full"),
            Reason::Cleared { calm_frames } => write!(f, "calm for {calm_frames} frames"),
            Reason::ProgramEmpty => f.write_str("nothing is on Program"),
        }
    }
}

/// A move from one level to another, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transition {
    pub from: Level,
    pub to: Level,
    pub reason: Reason,
}

/// The governor. One per engine, under the engine's lock.
#[derive(Debug)]
pub struct LoadGovernor {
    max_level: Level,
    level: Level,
    ratios: VecDeque<f64>,
    pressure_run: u32,
    calm_run: u32,
    since_change: u32,
}

impl LoadGovernor {
    /// A governor that never goes above `max_level`: the highest level something
    /// is wired to shed at.
    pub fn new(max_level: Level) -> Self {
        Self {
            max_level,
            level: Level::Normal,
            ratios: VecDeque::with_capacity(WINDOW),
            pressure_run: 0,
            calm_run: 0,
            since_change: u32::MAX,
        }
    }

    pub fn level(&self) -> Level {
        self.level
    }

    pub fn max_level(&self) -> Level {
        self.max_level
    }

    /// The 95th percentile of the window as a share of the interval, once there
    /// are enough samples to trust it.
    pub fn percentile95(&self) -> Option<f64> {
        if self.ratios.len() < MIN_SAMPLES {
            return None;
        }
        let mut sorted: Vec<f64> = self.ratios.iter().copied().collect();
        sorted.sort_by(|a, b| a.total_cmp(b));
        Some(sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)])
    }

    /// Nothing is on Program: nothing is at risk, so nothing is shed. An idle
    /// engine (a dev build, a machine with no scene) must not shed anyone's work.
    pub fn program_empty(&mut self) -> Option<Transition> {
        self.ratios.clear();
        self.pressure_run = 0;
        self.calm_run = 0;
        if self.level == Level::Normal {
            return None;
        }
        let from = self.level;
        self.level = Level::Normal;
        self.since_change = u32::MAX;
        Some(Transition {
            from,
            to: Level::Normal,
            reason: Reason::ProgramEmpty,
        })
    }

    /// Feed one emitted frame. Returns the transition if the level moved.
    pub fn observe(&mut self, o: Observation) -> Option<Transition> {
        self.since_change = self.since_change.saturating_add(1);
        let ratio = if o.interval_nanos == 0 {
            f64::INFINITY
        } else {
            o.render_nanos as f64 / o.interval_nanos as f64
        };
        if self.ratios.len() == WINDOW {
            self.ratios.pop_front();
        }
        self.ratios.push_back(ratio);

        let p95 = self.percentile95();
        let behind = o.frames_behind.unwrap_or(0);
        // The trips that mean Program has already failed.
        let hard = if o.missed > 0 {
            Some(Reason::MissedFrames(o.missed))
        } else if o.late {
            Some(Reason::LateFrame)
        } else {
            None
        };
        // The leading indicators.
        let soft = if behind > LAG_FRAMES {
            Some(Reason::ReadbackBehind(behind))
        } else if o.ring_full > 0 {
            Some(Reason::RingFull)
        } else {
            p95.filter(|p| *p > ENTER_RATIO)
                .map(|p| Reason::RenderPercentile {
                    percent: (p * 100.0).round() as u32,
                })
        };
        let calm = hard.is_none()
            && soft.is_none()
            && behind <= LAG_FRAMES
            && p95.is_none_or(|p| p < LEAVE_RATIO);

        if let Some(reason) = hard {
            self.calm_run = 0;
            self.pressure_run = self.pressure_run.saturating_add(1);
            if self.since_change >= HARD_HOLD {
                return self.step_up(reason);
            }
        } else if let Some(reason) = soft {
            self.calm_run = 0;
            self.pressure_run = self.pressure_run.saturating_add(1);
            if self.pressure_run >= ESCALATE_AFTER && self.since_change >= ESCALATE_AFTER {
                return self.step_up(reason);
            }
        } else if calm {
            self.pressure_run = 0;
            self.calm_run = self.calm_run.saturating_add(1);
            if self.calm_run >= RELEASE_AFTER {
                let calm_frames = self.calm_run;
                self.calm_run = 0;
                return self.step_down(Reason::Cleared { calm_frames });
            }
        } else {
            // The dead band: neither pressured nor calm. Hold.
            self.pressure_run = 0;
            self.calm_run = 0;
        }
        None
    }

    fn step_up(&mut self, reason: Reason) -> Option<Transition> {
        let to = self.level.up().filter(|next| *next <= self.max_level)?;
        let from = std::mem::replace(&mut self.level, to);
        self.since_change = 0;
        self.pressure_run = 0;
        Some(Transition { from, to, reason })
    }

    fn step_down(&mut self, reason: Reason) -> Option<Transition> {
        let to = self.level.down()?;
        let from = std::mem::replace(&mut self.level, to);
        self.since_change = 0;
        Some(Transition { from, to, reason })
    }
}

/// How many detached (headless) renders may run at once at each level. They run
/// on the CPU reference rasteriser, off Program's thread, so the cap is what
/// keeps them from taking every core from the render loop.
pub const DETACHED_CAP_NORMAL: usize = 4;
pub const DETACHED_CAP_THROTTLED: usize = 1;

/// The gate detached work passes through. The governor sets its level; the work
/// waits for a slot. Shared between the engine (which sets it) and the closures
/// it hands out (which wait on it), so it is atomic and a condition variable, not
/// the engine's lock.
#[derive(Debug, Default)]
pub struct NonLiveGate {
    level: AtomicU8,
    running: Mutex<usize>,
    freed: Condvar,
}

/// A slot held while a detached render runs.
pub struct Slot<'a>(&'a NonLiveGate);

impl NonLiveGate {
    pub fn set_level(&self, level: Level) {
        self.level.store(level as u8, Ordering::SeqCst);
        // A lower level may let waiters in.
        self.freed.notify_all();
    }

    pub fn level(&self) -> Level {
        Level::ALL[usize::from(self.level.load(Ordering::SeqCst)).min(Level::ALL.len() - 1)]
    }

    /// How many may run at the current level.
    pub fn cap(&self) -> usize {
        if self.level() >= Level::DetachedThrottled {
            DETACHED_CAP_THROTTLED
        } else {
            DETACHED_CAP_NORMAL
        }
    }

    /// Wait for a slot. Work queues rather than being dropped: a throttled render
    /// is late, never lost.
    pub fn acquire(&self) -> Slot<'_> {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *running >= self.cap() {
            running = self
                .freed
                .wait(running)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *running += 1;
        Slot(self)
    }

    /// Renders running now.
    pub fn running(&self) -> usize {
        *self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut running = self
            .0
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *running -= 1;
        self.0.freed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTERVAL: u64 = 20_000_000;

    fn frame(render_ms: f64) -> Observation {
        Observation {
            render_nanos: (render_ms * 1_000_000.0) as u64,
            interval_nanos: INTERVAL,
            late: false,
            missed: 0,
            frames_behind: Some(1),
            ring_full: 0,
        }
    }

    fn feed(g: &mut LoadGovernor, o: Observation, frames: u32) -> Vec<Transition> {
        (0..frames).filter_map(|_| g.observe(o)).collect()
    }

    #[test]
    fn calm_frames_never_shed_anything() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        assert!(feed(&mut g, frame(4.0), 1000).is_empty());
        assert_eq!(g.level(), Level::Normal);
    }

    #[test]
    fn a_late_frame_sheds_at_once_one_step_and_says_why() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        let late = Observation {
            late: true,
            ..frame(24.0)
        };
        let moved = g
            .observe(late)
            .expect("the first late frame moves the level");
        assert_eq!(
            (moved.from, moved.to),
            (Level::Normal, Level::DetachedThrottled)
        );
        assert_eq!(moved.reason, Reason::LateFrame);
        assert!(moved.reason.to_string().contains("late"));
    }

    #[test]
    fn a_missed_clock_frame_is_named_with_its_count() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        let moved = g
            .observe(Observation {
                missed: 3,
                ..frame(4.0)
            })
            .unwrap();
        assert_eq!(moved.reason, Reason::MissedFrames(3));
        assert!(moved.reason.to_string().contains("3 Program clock frame"));
    }

    #[test]
    fn continuing_lateness_climbs_one_step_every_few_frames_and_stops_at_the_top() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        let late = Observation {
            late: true,
            ..frame(24.0)
        };
        let moves = feed(&mut g, late, 200);
        let levels: Vec<_> = moves.iter().map(|t| t.to).collect();
        assert_eq!(
            levels,
            [
                Level::DetachedThrottled,
                Level::PreviewDecimated,
                Level::PrepareDeferred,
                Level::NonLiveRefused
            ]
        );
        assert_eq!(g.level(), Level::NonLiveRefused);
    }

    #[test]
    fn a_governor_never_claims_a_level_nothing_is_wired_to() {
        let mut g = LoadGovernor::new(Level::DetachedThrottled);
        let late = Observation {
            late: true,
            ..frame(24.0)
        };
        feed(&mut g, late, 500);
        assert_eq!(
            g.level(),
            Level::DetachedThrottled,
            "capped at the wired level"
        );
    }

    #[test]
    fn a_heavy_percentile_is_pressure_before_anything_is_late() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        // 16 ms of a 20 ms interval: 80%, over the 70% bar, never late.
        let moves = feed(&mut g, frame(16.0), 200);
        assert!(
            !moves.is_empty(),
            "leading indicator acted without a late frame"
        );
        assert!(matches!(moves[0].reason, Reason::RenderPercentile { percent } if percent >= 80));
        assert!(moves.iter().all(|t| t.from < t.to));
    }

    #[test]
    fn a_readback_three_frames_behind_is_pressure_and_so_is_a_full_ring() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        let behind = Observation {
            frames_behind: Some(3),
            ..frame(4.0)
        };
        let moves = feed(&mut g, behind, ESCALATE_AFTER + 1);
        assert_eq!(moves[0].reason, Reason::ReadbackBehind(3));

        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        let full = Observation {
            ring_full: 1,
            ..frame(4.0)
        };
        assert_eq!(
            feed(&mut g, full, ESCALATE_AFTER + 1)[0].reason,
            Reason::RingFull
        );
    }

    #[test]
    fn a_healthy_readback_two_frames_behind_is_not_pressure() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        let ok = Observation {
            frames_behind: Some(2),
            ..frame(4.0)
        };
        assert!(feed(&mut g, ok, 500).is_empty());
    }

    #[test]
    fn pressure_clears_one_step_at_a_time_in_reverse_after_a_long_calm() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        feed(
            &mut g,
            Observation {
                late: true,
                ..frame(24.0)
            },
            200,
        );
        assert_eq!(g.level(), Level::NonLiveRefused);
        // The window still holds the slow frames: they have to wash out first.
        let moves = feed(&mut g, frame(4.0), 2000);
        let levels: Vec<_> = moves.iter().map(|t| t.to).collect();
        assert_eq!(
            levels,
            [
                Level::PrepareDeferred,
                Level::PreviewDecimated,
                Level::DetachedThrottled,
                Level::Normal
            ]
        );
        assert!(
            matches!(moves[0].reason, Reason::Cleared { calm_frames } if calm_frames >= RELEASE_AFTER)
        );
    }

    #[test]
    fn one_good_second_does_not_release_a_shed_level() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        g.observe(Observation {
            late: true,
            ..frame(24.0)
        });
        let moves = feed(&mut g, frame(4.0), 100);
        assert!(moves.is_empty(), "released too early: {moves:?}");
        assert_eq!(g.level(), Level::DetachedThrottled);
    }

    #[test]
    fn the_dead_band_between_the_bars_holds_the_level() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        g.observe(Observation {
            late: true,
            ..frame(24.0)
        });
        // 12 ms of 20: 60%, between 50% and 70%: neither pressure nor calm.
        let moves = feed(&mut g, frame(12.0), 2000);
        assert!(moves.is_empty(), "{moves:?}");
        assert_eq!(g.level(), Level::DetachedThrottled);
    }

    #[test]
    fn alternating_good_and_bad_does_not_flap() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        let mut changes = 0;
        for i in 0..600 {
            let o = if i % 2 == 0 {
                Observation {
                    late: true,
                    ..frame(24.0)
                }
            } else {
                frame(4.0)
            };
            changes += usize::from(g.observe(o).is_some());
        }
        assert!(changes <= 4, "{changes} changes in 600 frames");
        assert!(g.level() >= Level::DetachedThrottled);
    }

    #[test]
    fn an_empty_program_sheds_nothing_and_releases_at_once() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        g.observe(Observation {
            late: true,
            ..frame(24.0)
        });
        let moved = g
            .program_empty()
            .expect("a shed level is dropped when Program is empty");
        assert_eq!(
            (moved.from, moved.to, moved.reason),
            (
                Level::DetachedThrottled,
                Level::Normal,
                Reason::ProgramEmpty
            )
        );
        assert!(g.program_empty().is_none());
        assert_eq!(g.percentile95(), None, "the window is forgotten");
    }

    #[test]
    fn a_percentile_needs_enough_samples() {
        let mut g = LoadGovernor::new(Level::NonLiveRefused);
        feed(&mut g, frame(18.0), (MIN_SAMPLES - 1) as u32);
        assert_eq!(g.percentile95(), None);
        g.observe(frame(18.0));
        assert!(g.percentile95().is_some());
    }

    #[test]
    fn the_gate_runs_four_at_normal_and_one_when_throttled() {
        let gate = NonLiveGate::default();
        assert_eq!(gate.cap(), DETACHED_CAP_NORMAL);
        gate.set_level(Level::DetachedThrottled);
        assert_eq!(gate.cap(), 1);
        gate.set_level(Level::PreviewDecimated);
        assert_eq!(gate.cap(), 1, "higher levels keep the throttle");
    }

    #[test]
    fn a_throttled_gate_queues_the_second_render_and_lets_it_in_when_the_first_ends() {
        use std::sync::Arc;
        let gate = Arc::new(NonLiveGate::default());
        gate.set_level(Level::DetachedThrottled);
        let first = gate.acquire();
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let waiter = {
            let (gate, started) = (Arc::clone(&gate), Arc::clone(&started));
            std::thread::spawn(move || {
                let _slot = gate.acquire();
                started.store(true, Ordering::SeqCst);
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !started.load(Ordering::SeqCst),
            "the second render must wait while one runs"
        );
        assert_eq!(gate.running(), 1);
        drop(first);
        waiter.join().unwrap();
        assert!(started.load(Ordering::SeqCst));
        assert_eq!(gate.running(), 0);
    }

    #[test]
    fn lowering_the_level_lets_a_waiting_render_in() {
        use std::sync::Arc;
        let gate = Arc::new(NonLiveGate::default());
        gate.set_level(Level::DetachedThrottled);
        let _held = gate.acquire();
        let waiter = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                let _slot = gate.acquire();
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        gate.set_level(Level::Normal);
        waiter.join().unwrap();
    }
}
