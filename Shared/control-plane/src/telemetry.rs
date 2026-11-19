//! Live telemetry (build plan 2.27): what the engine measures, one component
//! at a time, and what it means.
//!
//! The wording and the severity of every finding are decided here, once, as
//! `clock_summary` does for the clock: the Editor, Playout and an agent reading
//! the same reply over MCP (8.16) cannot disagree about how bad something is or
//! what to check. A surface draws the series and shows the findings; it never
//! derives a verdict from the numbers.
//!
//! Two rules this module lives under:
//!
//! - **Never fabricate a measurement** (`worker/src/metrics.rs`). A resource the
//!   engine does not measure is absent, or says it is not measured. There is no
//!   GPU-time series because timestamp queries are off; the adapter component
//!   says so, rather than showing a plausible zero.
//! - **A finding names a cause and a next step.** "Readback stalled 3 frames:
//!   the GPU is behind the compositor" and what to look at, not "performance
//!   degraded".
//!
//! The reply is additive: components carry a stable `id` and a `kind` with an
//! `other` catch-all, so an older surface shows a newer engine's component
//! generically instead of failing.

use gx_contracts::{DeviceTier, RationalRate, ReferenceState};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::status::{Degradation, FrameSampleSummary, Severity};

/// The most points one series carries: the newest, oldest first. A window is a
/// bounded part of a reply, not a stream.
pub const SERIES_POINTS: usize = 240;

/// Readback this many clock frames behind is a stall, not pipelining. The ring
/// is pipelined by design (1 to 2 frames); a third means the GPU is not
/// finishing frames.
pub const READBACK_STALL_FRAMES: u64 = 3;

/// A mean render time at or above this share of the frame interval leaves too
/// little headroom for a heavier scene.
pub const HEADROOM_WARNING_RATIO: f64 = 0.8;

/// What a component is. `Other` is what an older surface reads for a kind a
/// newer engine added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ComponentKind {
    FrameLoop,
    GpuAdapter,
    Readback,
    Output,
    Reference,
    /// 3.24: the load governor, which sheds non-live work to protect Program.
    LoadBalancer,
    #[serde(other)]
    Other,
}

/// How a component is doing. `NotMeasured` is a state of its own: it is never
/// shown as `Ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ComponentState {
    Ok,
    Degraded,
    Failed,
    NotMeasured,
}

/// A bounded series, newest last, with the limit it is judged against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MetricSeries {
    pub name: String,
    pub unit: String,
    pub values: Vec<f64>,
    /// The line a value is judged against (the frame interval, for a time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<f64>,
}

/// One part of the engine, its state and what is known of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComponentHealth {
    /// Stable across engine versions; a surface keys on it.
    pub id: String,
    pub kind: ComponentKind,
    pub label: String,
    pub state: ComponentState,
    /// One plain line: what it is and, when it is not measured, why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
    pub series: Vec<MetricSeries>,
}

/// Something wrong, or worth knowing, in plain words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// A stable code (`readback.stalled`), for a filter, an alert or an agent.
    pub id: String,
    /// The `id` of the component it concerns.
    pub component: String,
    pub severity: Severity,
    /// What failed, with the numbers that show it.
    pub what: String,
    /// What to look at next.
    pub check: String,
    /// The engine's log record that carries the detail, when it writes one:
    /// search the diagnostic bundle (2.14) for this `event`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub record: Option<String>,
}

/// What the readback ring reports, as plain data (the worker owns the ring).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadbackFacts {
    pub delivered: u64,
    pub ring_full: u64,
    pub superseded: u64,
    pub awaiting_first: u64,
    /// Clock frames between a frame's submission and its emission, newest last.
    pub frames_behind: Vec<u64>,
    /// Submit-to-delivery latency, nanoseconds, newest last.
    pub latency_nanos: Vec<u64>,
}

/// What the load governor (3.24) is doing, as plain data (the worker owns it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoadFacts {
    /// 0 is nothing shed; each step up sheds one more kind of non-live work.
    pub level: u8,
    /// The highest level anything is wired to shed at.
    pub max_level: u8,
    /// The level's name (`detached-throttled`).
    pub name: String,
    /// What is shed at this level, in words.
    pub shed: String,
    /// Moves since the engine started.
    pub shifts: u64,
    /// The latest move and why, when there has been one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_shift: Option<String>,
    /// Headless renders running now.
    pub detached_running: u32,
}

/// Everything the assessment reads.
pub struct TelemetryInputs<'a> {
    pub rate: RationalRate,
    pub tier: DeviceTier,
    /// The adapter's name and backend when the render device is hardware.
    pub gpu: Option<&'a str>,
    pub frames: &'a [FrameSampleSummary],
    pub readback: Option<&'a ReadbackFacts>,
    /// The output Program is going to.
    pub output: &'a str,
    pub output_inhibited: bool,
    pub reference: ReferenceState,
    pub degradations: &'a [Degradation],
    /// The load governor, when the engine has one.
    pub load: Option<&'a LoadFacts>,
}

/// The assessed engine.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    pub components: Vec<ComponentHealth>,
    pub findings: Vec<Finding>,
}

fn tail<T: Copy>(values: &[T]) -> &[T] {
    &values[values.len().saturating_sub(SERIES_POINTS)..]
}

fn millis(nanos: u64) -> f64 {
    nanos as f64 / 1_000_000.0
}

fn interval_millis(rate: RationalRate) -> f64 {
    if rate.num == 0 {
        return 0.0;
    }
    1000.0 * f64::from(rate.den) / f64::from(rate.num)
}

fn percentile95(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    Some(sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)])
}

/// Assess the engine from what it measured. Pure: the same facts give the same
/// components and findings, which is what lets a test pin every wording.
pub fn assess(inputs: &TelemetryInputs<'_>) -> Telemetry {
    let mut components = Vec::new();
    let mut findings = Vec::new();
    frame_loop(inputs, &mut components, &mut findings);
    gpu_adapter(inputs, &mut components, &mut findings);
    readback(inputs, &mut components, &mut findings);
    output(inputs, &mut components, &mut findings);
    reference(inputs, &mut components, &mut findings);
    load_balancer(inputs, &mut components, &mut findings);
    // The worst first, so a surface that shows one shows the right one.
    findings.sort_by(|a, b| b.severity.cmp(&a.severity));
    Telemetry {
        components,
        findings,
    }
}

fn frame_loop(
    inputs: &TelemetryInputs<'_>,
    components: &mut Vec<ComponentHealth>,
    findings: &mut Vec<Finding>,
) {
    let interval = interval_millis(inputs.rate);
    let frames = inputs.frames;
    let late = frames.iter().filter(|f| f.late).count();
    let missed: u64 = frames.iter().map(|f| f.missed_before).sum();
    let worst = frames.iter().map(|f| f.render_nanos).max().unwrap_or(0);
    let mean = (!frames.is_empty()).then(|| {
        frames.iter().map(|f| f.render_nanos as f64).sum::<f64>()
            / frames.len() as f64
            / 1_000_000.0
    });

    let mut state = ComponentState::Ok;
    if frames.is_empty() {
        state = ComponentState::NotMeasured;
    }
    if mean.is_some_and(|m| interval > 0.0 && m / interval >= HEADROOM_WARNING_RATIO) || late > 0 {
        state = ComponentState::Degraded;
    }
    if missed > 0 {
        state = ComponentState::Failed;
    }

    if missed > 0 {
        findings.push(Finding {
            id: "frame.missed".into(),
            component: "frame-loop".into(),
            severity: Severity::Critical,
            what: format!(
                "Program was not emitted for {missed} clock frame(s) in the last {} frames",
                frames.len()
            ),
            check: "The render loop was held away from the clock. Look for a scene that took long \
                    to prepare, other work on the GPU, or a stalled readback (below)."
                .into(),
            record: Some("frame.missed".into()),
        });
    }
    if late > 0 {
        findings.push(Finding {
            id: "frame.late".into(),
            component: "frame-loop".into(),
            severity: Severity::Warning,
            what: format!(
                "{late} of {} frames rendered later than their {interval:.1} ms interval \
                 (slowest {:.1} ms)",
                frames.len(),
                millis(worst)
            ),
            check: "The scene on Program costs more than one frame on this machine. Simplify the \
                    heaviest layers (blur, large masks, many effects) or move non-live work off \
                    this GPU."
                .into(),
            record: Some("frame.late".into()),
        });
    } else if let Some(mean) =
        mean.filter(|m| interval > 0.0 && m / interval >= HEADROOM_WARNING_RATIO)
    {
        findings.push(Finding {
            id: "frame.headroom".into(),
            component: "frame-loop".into(),
            severity: Severity::Warning,
            what: format!(
                "Frames use {:.0}% of their {interval:.1} ms interval on average: no headroom for \
                 a heavier scene",
                100.0 * mean / interval
            ),
            check: "Nothing is late yet. Check the next scene's cost before it is taken.".into(),
            record: None,
        });
    }

    components.push(ComponentHealth {
        id: "frame-loop".into(),
        kind: ComponentKind::FrameLoop,
        label: "Program render".into(),
        state,
        detail: Some(match mean {
            Some(mean) => format!(
                "{mean:.1} ms mean render against a {interval:.1} ms interval ({} frames)",
                frames.len()
            ),
            None => "No frame has been rendered yet".into(),
        }),
        series: vec![MetricSeries {
            name: "Render time".into(),
            unit: "ms".into(),
            values: tail(frames)
                .iter()
                .map(|f| millis(f.render_nanos))
                .collect(),
            limit: Some(interval),
        }],
    });
}

fn gpu_adapter(
    inputs: &TelemetryInputs<'_>,
    components: &mut Vec<ComponentHealth>,
    findings: &mut Vec<Finding>,
) {
    let hardware = inputs.gpu.is_some() && inputs.tier.live_capable();
    if !hardware {
        findings.push(Finding {
            id: "gpu.no_hardware".into(),
            component: "gpu-adapter".into(),
            severity: Severity::Critical,
            what: format!(
                "No hardware GPU: the render device is tier {:?}, which can never go to air",
                inputs.tier
            ),
            check: "Install or enable the GPU driver, or run the engine on the machine with the \
                    GPU. A software adapter (WARP, SwiftShader) is for tests and CPU reference \
                    renders only."
                .into(),
            record: None,
        });
    }
    components.push(ComponentHealth {
        id: "gpu-adapter".into(),
        kind: ComponentKind::GpuAdapter,
        label: "GPU adapter".into(),
        state: if hardware {
            ComponentState::Ok
        } else {
            ComponentState::Failed
        },
        detail: Some(match inputs.gpu {
            Some(name) if hardware => format!(
                "{name}. GPU time per frame is not measured (timestamp queries are off); \
                 the render series is the frame's wall time"
            ),
            Some(name) => format!("{name}: not a hardware adapter"),
            None => "No hardware adapter was found".into(),
        }),
        series: Vec::new(),
    });
}

fn readback(
    inputs: &TelemetryInputs<'_>,
    components: &mut Vec<ComponentHealth>,
    findings: &mut Vec<Finding>,
) {
    let Some(facts) = inputs.readback else {
        components.push(ComponentHealth {
            id: "readback".into(),
            kind: ComponentKind::Readback,
            label: "GPU readback".into(),
            state: ComponentState::NotMeasured,
            detail: Some(
                "Program is not on the GPU compositor, so there is no readback ring".into(),
            ),
            series: Vec::new(),
        });
        return;
    };
    let interval = interval_millis(inputs.rate);
    let behind = tail(&facts.frames_behind);
    let recent_max = behind.iter().copied().max().unwrap_or(0);
    let latency = tail(&facts.latency_nanos);
    let p95 = percentile95(latency);

    let mut state = ComponentState::Ok;
    if facts.ring_full > 0 || p95.is_some_and(|p| interval > 0.0 && millis(p) > interval) {
        state = ComponentState::Degraded;
    }
    if recent_max >= READBACK_STALL_FRAMES {
        state = ComponentState::Failed;
        findings.push(Finding {
            id: "readback.stalled".into(),
            component: "readback".into(),
            severity: Severity::Critical,
            what: format!(
                "GPU readback stalled: frames reached the output up to {recent_max} clock frames \
                 after they were submitted (a healthy ring is 1 to 2)"
            ),
            check: "The GPU is not finishing frames in time. Look for other GPU work (previews, \
                    headless renders, another application), a power or thermal limit, or a scene \
                    too heavy for this adapter."
                .into(),
            record: Some("frame.late".into()),
        });
    }
    if facts.ring_full > 0 {
        findings.push(Finding {
            id: "readback.ring_full".into(),
            component: "readback".into(),
            severity: Severity::Warning,
            what: format!(
                "Readback ring was full {} time(s): a frame was composited but could not be read \
                 back because every slot was still in flight",
                facts.ring_full
            ),
            check: "The GPU is behind the compositor. The same causes as a stall, earlier.".into(),
            record: None,
        });
    }
    if let Some(p) = p95.filter(|p| interval > 0.0 && millis(*p) > interval) {
        findings.push(Finding {
            id: "readback.slow".into(),
            component: "readback".into(),
            severity: Severity::Warning,
            what: format!(
                "Readback takes {:.1} ms for 1 frame in 20 (more than the {interval:.1} ms frame \
                 interval)",
                millis(p)
            ),
            check: "The GPU to CPU copy is slow: check the bus (PCIe link width), the driver, and \
                    other GPU work."
                .into(),
            record: None,
        });
    }

    components.push(ComponentHealth {
        id: "readback".into(),
        kind: ComponentKind::Readback,
        label: "GPU readback".into(),
        state,
        detail: Some(format!(
            "{} delivered, {} ring-full, {} superseded, {} awaiting first frame",
            facts.delivered, facts.ring_full, facts.superseded, facts.awaiting_first
        )),
        series: vec![
            MetricSeries {
                name: "Readback latency".into(),
                unit: "ms".into(),
                values: latency.iter().map(|n| millis(*n)).collect(),
                limit: Some(interval),
            },
            MetricSeries {
                name: "Frames behind".into(),
                unit: "frames".into(),
                values: behind.iter().map(|b| *b as f64).collect(),
                limit: Some(READBACK_STALL_FRAMES as f64),
            },
        ],
    });
}

fn output(
    inputs: &TelemetryInputs<'_>,
    components: &mut Vec<ComponentHealth>,
    findings: &mut Vec<Finding>,
) {
    if inputs.output_inhibited {
        findings.push(Finding {
            id: "output.inhibited".into(),
            component: "output".into(),
            severity: Severity::Critical,
            what: format!(
                "Program output is inhibited: output \"{}\" could not take Program",
                inputs.output
            ),
            check: "Configure the output again in Playout (Output panel); the engine log record \
                    for the refusal names the adapter's reason."
                .into(),
            record: None,
        });
    }
    components.push(ComponentHealth {
        id: "output".into(),
        kind: ComponentKind::Output,
        label: format!("Output {}", inputs.output),
        state: if inputs.output_inhibited {
            ComponentState::Failed
        } else {
            ComponentState::Ok
        },
        detail: Some(if inputs.output_inhibited {
            "Inhibited: Program is not being delivered".into()
        } else {
            "Receiving Program".into()
        }),
        series: Vec::new(),
    });
}

fn reference(
    inputs: &TelemetryInputs<'_>,
    components: &mut Vec<ComponentHealth>,
    findings: &mut Vec<Finding>,
) {
    for degradation in inputs.degradations {
        match degradation {
            Degradation::ReferenceLost { was } => findings.push(Finding {
                id: "reference.lost".into(),
                component: "reference".into(),
                severity: Severity::Critical,
                what: format!(
                    "Reference lock lost: Program cadence is held at {}/{} and drifts from the \
                     house reference",
                    was.num, was.den
                ),
                check: "Check the reference cable and the sync generator. New live outputs are \
                        refused until the lock returns."
                    .into(),
                record: Some("clock.changed".into()),
            }),
            Degradation::FreeRunning => findings.push(Finding {
                id: "reference.free_run".into(),
                component: "reference".into(),
                severity: Severity::Warning,
                what: "Free-running: Program cadence is not locked to any reference".into(),
                check:
                    "Fine for a test; for air, connect a reference or accept free-run knowingly."
                        .into(),
                record: Some("clock.changed".into()),
            }),
            // Reported by the GPU adapter component.
            Degradation::DeviceBelowT0 { .. } => {}
        }
    }
    let (state, detail) = match inputs.reference {
        ReferenceState::Locked => (ComponentState::Ok, "Locked to the reference"),
        ReferenceState::NotPresent => {
            (ComponentState::Degraded, "No reference input: free-running")
        }
        ReferenceState::Unlocked => (
            ComponentState::Failed,
            "A reference input is present and not locked",
        ),
    };
    components.push(ComponentHealth {
        id: "reference".into(),
        kind: ComponentKind::Reference,
        label: "Reference".into(),
        state,
        detail: Some(detail.into()),
        series: Vec::new(),
    });
}

fn load_balancer(
    inputs: &TelemetryInputs<'_>,
    components: &mut Vec<ComponentHealth>,
    findings: &mut Vec<Finding>,
) {
    let Some(load) = inputs.load else {
        return;
    };
    let shedding = load.level > 0;
    if shedding {
        findings.push(Finding {
            id: "load.shedding".into(),
            component: "load-balancer".into(),
            severity: Severity::Warning,
            what: format!(
                "Program is under load: shedding non-live work (level {} of {}): {}{}",
                load.level,
                load.max_level,
                load.shed,
                load.last_shift
                    .as_deref()
                    .map_or_else(String::new, |s| format!(". Latest: {s}"))
            ),
            check: "Program is protected and nothing on air is affected; the shed work is slower or                     waiting, not lost. Find what is heavy: the scene on Program, other GPU work, or                     another application. The level falls by itself after a calm spell."
                .into(),
            record: Some("load.shift".into()),
        });
    }
    components.push(ComponentHealth {
        id: "load-balancer".into(),
        kind: ComponentKind::LoadBalancer,
        label: "Load balancer".into(),
        state: if shedding {
            ComponentState::Degraded
        } else {
            ComponentState::Ok
        },
        detail: Some(format!(
            "{} ({}), {} move(s) since start, {} headless render(s) running; sheds up to level {}",
            load.name, load.shed, load.shifts, load.detached_running, load.max_level
        )),
        series: Vec::new(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: RationalRate = RationalRate { num: 50, den: 1 };

    fn frame(n: u64, render_ms: f64, late: bool, missed: u64) -> FrameSampleSummary {
        FrameSampleSummary {
            frame: n,
            render_nanos: (render_ms * 1_000_000.0) as u64,
            interval_nanos: 20_000_000,
            late,
            drops_so_far: 0,
            missed_before: missed,
        }
    }

    fn healthy_frames() -> Vec<FrameSampleSummary> {
        (0..100).map(|n| frame(n, 4.0, false, 0)).collect()
    }

    fn healthy<'a>(
        frames: &'a [FrameSampleSummary],
        readback: &'a ReadbackFacts,
    ) -> TelemetryInputs<'a> {
        TelemetryInputs {
            rate: RATE,
            tier: DeviceTier::T0,
            gpu: Some("NVIDIA RTX (Dx12)"),
            frames,
            readback: Some(readback),
            output: "decklink",
            output_inhibited: false,
            reference: ReferenceState::Locked,
            degradations: &[],
            load: None,
        }
    }

    fn ring(behind: u64, latency_ms: u64) -> ReadbackFacts {
        ReadbackFacts {
            delivered: 100,
            frames_behind: vec![behind; 100],
            latency_nanos: vec![latency_ms * 1_000_000; 100],
            ..ReadbackFacts::default()
        }
    }

    fn component<'a>(t: &'a Telemetry, id: &str) -> &'a ComponentHealth {
        t.components.iter().find(|c| c.id == id).unwrap()
    }

    fn has(t: &Telemetry, id: &str) -> bool {
        t.findings.iter().any(|f| f.id == id)
    }

    #[test]
    fn a_healthy_engine_has_every_component_ok_and_no_findings() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let t = assess(&healthy(&frames, &readback));
        assert!(t.findings.is_empty(), "{:?}", t.findings);
        for id in [
            "frame-loop",
            "gpu-adapter",
            "readback",
            "output",
            "reference",
        ] {
            assert_eq!(component(&t, id).state, ComponentState::Ok, "{id}");
        }
    }

    #[test]
    fn a_readback_three_frames_behind_is_a_stall_that_says_so() {
        let frames = healthy_frames();
        let readback = ring(3, 8);
        let t = assess(&healthy(&frames, &readback));
        let finding = t
            .findings
            .iter()
            .find(|f| f.id == "readback.stalled")
            .unwrap();
        assert_eq!(finding.severity, Severity::Critical);
        assert!(finding.what.contains("up to 3 clock frames"));
        assert!(finding.check.contains("GPU"));
        assert_eq!(component(&t, "readback").state, ComponentState::Failed);
    }

    #[test]
    fn two_frames_behind_is_the_pipeline_working_not_a_stall() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        assert!(!has(
            &assess(&healthy(&frames, &readback)),
            "readback.stalled"
        ));
    }

    #[test]
    fn a_missed_clock_frame_is_critical_and_never_averaged_away() {
        let mut frames = healthy_frames();
        frames[40] = frame(40, 4.0, false, 2);
        let readback = ring(2, 8);
        let t = assess(&healthy(&frames, &readback));
        let finding = t.findings.iter().find(|f| f.id == "frame.missed").unwrap();
        assert_eq!(finding.severity, Severity::Critical);
        assert!(finding.what.contains("2 clock frame(s)"));
        assert_eq!(finding.record.as_deref(), Some("frame.missed"));
        assert_eq!(component(&t, "frame-loop").state, ComponentState::Failed);
        assert_eq!(
            t.findings[0].id, "frame.missed",
            "the worst finding is first"
        );
    }

    #[test]
    fn the_worst_finding_is_first_even_when_a_milder_one_was_found_earlier() {
        // The frame loop is assessed before the readback, so its warning is
        // pushed first; the stall is critical and must still lead.
        let mut frames = healthy_frames();
        frames[10] = frame(10, 31.5, true, 0);
        let readback = ring(3, 8);
        let t = assess(&healthy(&frames, &readback));
        let ids: Vec<_> = t.findings.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["readback.stalled", "frame.late"]);
    }

    #[test]
    fn a_late_frame_is_a_warning_with_the_slowest_time() {
        let mut frames = healthy_frames();
        frames[10] = frame(10, 31.5, true, 0);
        let readback = ring(2, 8);
        let t = assess(&healthy(&frames, &readback));
        let finding = t.findings.iter().find(|f| f.id == "frame.late").unwrap();
        assert_eq!(finding.severity, Severity::Warning);
        assert!(finding.what.contains("1 of 100 frames"));
        assert!(finding.what.contains("31.5 ms"));
        assert_eq!(component(&t, "frame-loop").state, ComponentState::Degraded);
    }

    #[test]
    fn no_headroom_warns_before_anything_is_late() {
        let frames: Vec<_> = (0..100).map(|n| frame(n, 17.0, false, 0)).collect();
        let readback = ring(2, 8);
        let t = assess(&healthy(&frames, &readback));
        assert!(has(&t, "frame.headroom"));
        assert!(!has(&t, "frame.late"));
        assert_eq!(component(&t, "frame-loop").state, ComponentState::Degraded);
    }

    #[test]
    fn a_software_adapter_is_a_critical_finding_and_a_failed_component() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let mut inputs = healthy(&frames, &readback);
        inputs.tier = DeviceTier::T2;
        inputs.gpu = None;
        let t = assess(&inputs);
        assert!(has(&t, "gpu.no_hardware"));
        assert_eq!(component(&t, "gpu-adapter").state, ComponentState::Failed);
        assert!(component(&t, "gpu-adapter")
            .detail
            .as_deref()
            .unwrap()
            .contains("No hardware adapter"));
    }

    #[test]
    fn gpu_time_is_never_invented() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let t = assess(&healthy(&frames, &readback));
        let gpu = component(&t, "gpu-adapter");
        assert!(gpu.series.is_empty());
        assert!(gpu.detail.as_deref().unwrap().contains("not measured"));
    }

    #[test]
    fn an_inhibited_output_names_the_output() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let mut inputs = healthy(&frames, &readback);
        inputs.output_inhibited = true;
        let t = assess(&inputs);
        let finding = t
            .findings
            .iter()
            .find(|f| f.id == "output.inhibited")
            .unwrap();
        assert!(finding.what.contains("\"decklink\""));
        assert_eq!(component(&t, "output").state, ComponentState::Failed);
    }

    #[test]
    fn a_lost_reference_is_critical_and_free_run_is_a_warning() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let lost = [Degradation::ReferenceLost { was: RATE }];
        let mut inputs = healthy(&frames, &readback);
        inputs.reference = ReferenceState::Unlocked;
        inputs.degradations = &lost;
        let t = assess(&inputs);
        assert_eq!(
            t.findings
                .iter()
                .find(|f| f.id == "reference.lost")
                .unwrap()
                .severity,
            Severity::Critical
        );
        assert_eq!(component(&t, "reference").state, ComponentState::Failed);

        let free = [Degradation::FreeRunning];
        let mut inputs = healthy(&frames, &readback);
        inputs.reference = ReferenceState::NotPresent;
        inputs.degradations = &free;
        let t = assess(&inputs);
        assert_eq!(
            t.findings
                .iter()
                .find(|f| f.id == "reference.free_run")
                .unwrap()
                .severity,
            Severity::Warning
        );
        assert_eq!(component(&t, "reference").state, ComponentState::Degraded);
    }

    fn load(level: u8) -> LoadFacts {
        LoadFacts {
            level,
            max_level: 1,
            name: if level == 0 {
                "normal"
            } else {
                "detached-throttled"
            }
            .into(),
            shed: if level == 0 {
                "nothing is shed"
            } else {
                "headless renders run one at a time"
            }
            .into(),
            shifts: u64::from(level),
            last_shift: (level > 0).then(|| "a Program frame was late".to_string()),
            detached_running: 1,
        }
    }

    #[test]
    fn a_shedding_governor_is_a_warning_that_says_what_is_shed_and_why() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let facts = load(1);
        let mut inputs = healthy(&frames, &readback);
        inputs.load = Some(&facts);
        let t = assess(&inputs);
        let finding = t.findings.iter().find(|f| f.id == "load.shedding").unwrap();
        assert_eq!(finding.severity, Severity::Warning);
        assert!(finding.what.contains("headless renders run one at a time"));
        assert!(finding.what.contains("a Program frame was late"));
        assert!(finding.check.contains("nothing on air is affected"));
        assert_eq!(finding.record.as_deref(), Some("load.shift"));
        assert_eq!(
            component(&t, "load-balancer").state,
            ComponentState::Degraded
        );
    }

    #[test]
    fn a_governor_at_normal_is_ok_with_no_finding_and_none_means_no_component() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let facts = load(0);
        let mut inputs = healthy(&frames, &readback);
        inputs.load = Some(&facts);
        let t = assess(&inputs);
        assert!(!has(&t, "load.shedding"));
        assert_eq!(component(&t, "load-balancer").state, ComponentState::Ok);

        let t = assess(&healthy(&frames, &readback));
        assert!(t.components.iter().all(|c| c.id != "load-balancer"));
    }

    #[test]
    fn no_readback_ring_is_not_measured_rather_than_ok() {
        let frames = healthy_frames();
        let readback = ring(2, 8);
        let mut inputs = healthy(&frames, &readback);
        inputs.readback = None;
        let t = assess(&inputs);
        assert_eq!(component(&t, "readback").state, ComponentState::NotMeasured);
        assert!(component(&t, "readback").series.is_empty());
    }

    #[test]
    fn no_frames_yet_is_not_measured_rather_than_fast() {
        let readback = ring(2, 8);
        let t = assess(&healthy(&[], &readback));
        assert_eq!(
            component(&t, "frame-loop").state,
            ComponentState::NotMeasured
        );
        assert!(component(&t, "frame-loop").series[0].values.is_empty());
    }

    #[test]
    fn a_series_is_the_newest_points_and_bounded() {
        let frames: Vec<_> = (0..1000)
            .map(|n| frame(n, (n % 10) as f64, false, 0))
            .collect();
        let readback = ring(2, 8);
        let t = assess(&healthy(&frames, &readback));
        let series = &component(&t, "frame-loop").series[0];
        assert_eq!(series.values.len(), SERIES_POINTS);
        assert_eq!(series.values[SERIES_POINTS - 1], 9.0, "newest last");
        assert_eq!(series.limit, Some(20.0));
    }

    #[test]
    fn an_unknown_kind_from_a_newer_engine_reads_as_other() {
        let kind: ComponentKind = serde_json::from_str("\"thermal\"").unwrap();
        assert_eq!(kind, ComponentKind::Other);
    }

    #[test]
    fn the_reply_round_trips_on_the_wire() {
        let frames = healthy_frames();
        let readback = ring(3, 8);
        let t = assess(&healthy(&frames, &readback));
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<Telemetry>(&json).unwrap(), t);
    }
}
