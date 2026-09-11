//! Per-frame performance measurement (Phase 3 instrumentation).
//!
//! The engine reports what it measures, and the metrics are attached to the
//! frame path that produces them — render time beside the rasteriser, clock
//! behaviour beside the clock — because a number measured somewhere else is a
//! number that can drift from the thing it claims to describe. Two rules this
//! module lives under:
//!
//! - **Never infer, never smooth over (invariants 11, 18).** A frame that
//!   took longer than its interval is reported as a *late frame*, with its
//!   actual duration, not averaged away. A stall is a drop, counted, not a
//!   pause that vanished.
//! - **GPU utilisation is not fabricatable through wgpu.** wgpu exposes
//!   timestamp queries behind `TIMESTAMP_QUERY`, which this crate does not
//!   enable, so there is no number to report. Where a caller wants a GPU
//!   figure, the answer is `None`, not a guess — a dashboard that shows a
//!   plausible-looking zero is worse than one that shows nothing, because the
//!   zero gets believed.
//!
//! The samples are serialised because the visualisation that consumes them is
//! generated: a JSON snapshot is the whole contract between this module and
//! the graph page, and it is checked by the codegen gate like every other
//! contract type.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use ts_rs::TS;

use gx_contracts::RationalRate;

/// One rendered Program frame, measured.
///
/// `render` is the wall time the rasteriser took, which on the software path
/// is the CPU cost of producing the frame. `interval` is the frame interval
/// the clock committed to, so a consumer can tell at a glance whether a frame
/// was produced inside its budget or overran it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrameSample {
    /// The committed frame number.
    pub frame: u64,
    /// Wall time to produce this frame.
    pub render_nanos: u64,
    /// The frame interval the clock committed to.
    pub interval_nanos: u64,
    /// True when the render overran its interval. A late frame is a fact, not
    /// a threshold somebody set later.
    pub late: bool,
    /// Frames dropped before this one because a consumer had not taken the
    /// previous one. Counted, never smoothed.
    pub drops_so_far: u64,
}

impl FrameSample {
    /// The render time as a fraction of the frame interval. Above 1.0 is a
    /// late frame; a consumer graphs the ratio, not the raw nanos, because a
    /// 20 ms budget at 50 fps and a 33 ms budget at 29.97 are different
    /// statements of the same health.
    pub fn budget_ratio(&self) -> f64 {
        if self.interval_nanos == 0 {
            return f64::INFINITY;
        }
        self.render_nanos as f64 / self.interval_nanos as f64
    }
}

/// A rolling window of frame samples.
///
/// Bounded: an engine that runs for hours cannot accumulate samples without
/// limit, and the oldest frames are the least useful, so the window evicts
/// them. The bound is a multiple of the frame rate, not a magic number.
#[derive(Debug)]
pub struct FrameMetrics {
    /// The samples, oldest first.
    samples: Vec<FrameSample>,
    /// The most the window may hold.
    capacity: usize,
    /// Total frames rendered, including those that fell off the window.
    total_rendered: u64,
    /// Total late frames, including those that fell off the window.
    total_late: u64,
    /// Total frames dropped because a consumer was behind.
    total_dropped: u64,
}

impl FrameMetrics {
    /// A window holding `seconds` worth of frames at `rate`.
    pub fn with_window(rate: RationalRate, seconds: u32) -> Self {
        let capacity = (u64::from(rate.num) * u64::from(seconds) / u64::from(rate.den)) as usize;
        Self {
            samples: Vec::with_capacity(capacity),
            capacity: capacity.max(1),
            total_rendered: 0,
            total_late: 0,
            total_dropped: 0,
        }
    }

    /// Record one frame.
    pub fn record(&mut self, sample: FrameSample) {
        self.total_rendered += 1;
        if sample.late {
            self.total_late += 1;
        }
        self.total_dropped += sample.drops_so_far.saturating_sub(self.last_drops());
        if self.samples.len() == self.capacity {
            self.samples.remove(0);
        }
        self.samples.push(sample);
    }

    fn last_drops(&self) -> u64 {
        self.samples.last().map(|s| s.drops_so_far).unwrap_or(0)
    }

    /// The samples in the window, oldest first.
    pub fn samples(&self) -> &[FrameSample] {
        &self.samples
    }

    pub fn total_rendered(&self) -> u64 {
        self.total_rendered
    }

    pub fn total_late(&self) -> u64 {
        self.total_late
    }

    pub fn total_dropped(&self) -> u64 {
        self.total_dropped
    }

    /// The mean render time over the window, as a fraction of the interval.
    /// None when the window is empty — an engine that has not rendered has no
    /// average, and reporting zero would imply it is fast.
    pub fn mean_budget_ratio(&self) -> Option<f64> {
        if self.samples.is_empty() {
            return None;
        }
        let sum: f64 = self.samples.iter().map(FrameSample::budget_ratio).sum();
        Some(sum / self.samples.len() as f64)
    }
}

/// A render timed at the call site.
///
/// The caller owns the frame and the clock; this only measures. Kept separate
/// from `FrameMetrics::record` so the measurement and the accounting are two
/// steps a test can exercise alone.
pub fn time_frame<F>(render: F) -> (Duration, crate::Frame)
where
    F: FnOnce() -> crate::Frame,
{
    let start = Instant::now();
    let frame = render();
    (start.elapsed(), frame)
}

/// A point-in-time snapshot of the engine's measured performance.
///
/// This is the whole contract the graph page consumes. It is serialised so the
/// page is generated from real bytes rather than drawn from a description of
/// them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnginePerformance {
    /// The frame rate the engine committed to, rational (invariant 12).
    pub rate: RationalRate,
    /// The device tier this engine negotiated. A software tier and a hardware
    /// tier producing the same numbers are different statements.
    pub device_tier: gx_contracts::DeviceTier,
    /// The samples in the rolling window, oldest first.
    pub frames: Vec<FrameSample>,
    /// Totals over the engine's whole run, so a window that has evicted its
    /// slow frames does not hide them.
    pub total_rendered: u64,
    pub total_late: u64,
    pub total_dropped: u64,
    /// Mean render time over the window as a fraction of the frame interval.
    /// Absent when nothing has rendered yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mean_budget_ratio: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interval() -> u64 {
        // 50 fps: 20,000,000 ns.
        20_000_000
    }

    #[test]
    fn a_late_frame_is_named_by_its_own_duration_not_a_threshold() {
        let sample = FrameSample {
            frame: 1,
            render_nanos: 25_000_000,
            interval_nanos: interval(),
            late: true,
            drops_so_far: 0,
        };
        assert!(sample.late);
        assert!((sample.budget_ratio() - 1.25).abs() < 1e-9);
        // A 25 ms frame in a 20 ms budget is late by 25%; a caller does not
        // get to call it healthy because a different rate would absorb it.
    }

    #[test]
    fn an_on_time_frame_is_not_late() {
        let sample = FrameSample {
            frame: 1,
            render_nanos: 8_000_000,
            interval_nanos: interval(),
            late: false,
            drops_so_far: 0,
        };
        assert!(!sample.late);
        assert!(sample.budget_ratio() < 1.0);
    }

    #[test]
    fn the_window_is_bounded_and_evicts_the_oldest() {
        let mut metrics = FrameMetrics::with_window(RationalRate::P50, 1);
        assert_eq!(metrics.samples.capacity(), 50);
        for frame in 0..60 {
            metrics.record(FrameSample {
                frame,
                render_nanos: 1_000_000,
                interval_nanos: interval(),
                late: false,
                drops_so_far: 0,
            });
        }
        assert_eq!(metrics.samples().len(), 50, "the window holds its bound");
        assert_eq!(
            metrics.samples().first().unwrap().frame,
            10,
            "the oldest ten evicted"
        );
        assert_eq!(
            metrics.total_rendered(),
            60,
            "the total counts what fell off"
        );
    }

    #[test]
    fn drops_are_counted_never_smoothed() {
        let mut metrics = FrameMetrics::with_window(RationalRate::P50, 1);
        metrics.record(FrameSample {
            frame: 1,
            render_nanos: 1_000_000,
            interval_nanos: interval(),
            late: false,
            drops_so_far: 0,
        });
        metrics.record(FrameSample {
            frame: 2,
            render_nanos: 1_000_000,
            interval_nanos: interval(),
            late: false,
            drops_so_far: 3,
        });
        assert_eq!(metrics.total_dropped(), 3, "a drop is a fact, not noise");
    }

    #[test]
    fn an_empty_window_reports_no_average() {
        let metrics = FrameMetrics::with_window(RationalRate::P50, 1);
        assert!(
            metrics.mean_budget_ratio().is_none(),
            "an engine that has not rendered has no average, and zero would be a lie"
        );
    }

    #[test]
    fn the_snapshot_serialises_as_the_graph_page_reads_it() {
        // The page is generated from these bytes, so the field names are the
        // contract and a rename must fail here, not on a dashboard.
        let mut metrics = FrameMetrics::with_window(RationalRate::P50, 1);
        metrics.record(FrameSample {
            frame: 7,
            render_nanos: 12_000_000,
            interval_nanos: interval(),
            late: false,
            drops_so_far: 0,
        });
        let snapshot = EnginePerformance {
            rate: RationalRate::P50,
            device_tier: gx_contracts::DeviceTier::T0,
            frames: metrics.samples().to_vec(),
            total_rendered: metrics.total_rendered(),
            total_late: metrics.total_late(),
            total_dropped: metrics.total_dropped(),
            mean_budget_ratio: metrics.mean_budget_ratio(),
        };
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["rate"]["num"], 50);
        assert_eq!(wire["frames"][0]["renderNanos"], 12_000_000);
        assert_eq!(wire["frames"][0]["intervalNanos"], 20_000_000);
        assert!(!wire["frames"][0]["late"].as_bool().unwrap());
        assert!(wire["meanBudgetRatio"].is_number());
        let back: EnginePerformance = serde_json::from_value(wire).unwrap();
        assert_eq!(back.frames.len(), 1);
    }
}
