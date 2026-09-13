//! Named animation phases on the scene timeline (build plan 11.25).
//!
//! **The contract was already half-committed to this.** `MOTION_PHASES` in
//! `crate::mcp` and `MotionPhases` in `crate::design_system` have named the
//! five operator phases — in, out, hold, continue, update — since presets
//! existed. But only *presets* spoke that vocabulary. An authored scene
//! timeline was a single undifferentiated span, so a scene could not say where
//! its take-in ended and its take-out began, and Playout could only cut.
//!
//! This gives the scene's own timeline those same five names, as frame spans
//! over channels that already exist. It deliberately does **not** reuse
//! `MotionPhase`: a preset phase is a normalised duration carrying its own
//! channels (G.6.2), instantiated into a scene later; a `TimelinePhase` is a
//! label over absolute frames that are already there. One type serving both
//! would drift (invariant 27).
//!
//! **Spans are half-open: `[start_frame, end_frame)`.** The frame numbered
//! `end_frame` belongs to whatever comes next. Half-open makes adjacency
//! expressible without an off-by-one — an `in` ending at 50 and a `hold`
//! starting at 50 are adjacent and legal, and no frame is claimed twice. With
//! inclusive ends the author writes 49, and every duration calculation carries
//! a `+ 1` that somebody eventually forgets.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::scene::SceneTimeline;
use crate::Refusal;

/// The operator phases a scene timeline can name.
///
/// These are exactly `crate::mcp::MOTION_PHASES`, and a test below pins them
/// against it: a phase added to one and not the other fails the gate rather
/// than producing a scene the agent surface cannot describe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PhaseKind {
    /// Build on. Triggered by Take.
    In,
    /// Idle loop after `in` completes. Interruptible at any frame.
    Hold,
    /// Build off. Triggered by Out.
    Out,
    /// A staged build, triggered by Continue. A timeline may carry several.
    Continue,
    /// How a bound value changes on air without a full re-take.
    Update,
}

impl PhaseKind {
    /// The wire name, matching the `MOTION_PHASES` vocabulary.
    pub const fn name(self) -> &'static str {
        match self {
            Self::In => "in",
            Self::Hold => "hold",
            Self::Out => "out",
            Self::Continue => "continue",
            Self::Update => "update",
        }
    }

    pub const ALL: [PhaseKind; 5] = [
        PhaseKind::In,
        PhaseKind::Hold,
        PhaseKind::Out,
        PhaseKind::Continue,
        PhaseKind::Update,
    ];
}

/// One named span of the scene timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePhase {
    pub kind: PhaseKind,
    /// Distinguishes several `continue` phases from each other. Absent means
    /// the kind names it uniquely, which is true of every kind but `continue`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    /// First frame of the phase, inclusive.
    pub start_frame: u64,
    /// One past the last frame. See the module note on why this is exclusive.
    pub end_frame: u64,
}

impl TimelinePhase {
    /// How a phase is addressed: its kind, plus its name when it has one. Two
    /// unnamed `continue` phases would be indistinguishable, which is why
    /// `set_phase` treats the second as replacing the first.
    pub fn address(&self) -> String {
        match &self.name {
            Some(name) => format!("{}:{name}", self.kind.name()),
            None => self.kind.name().to_owned(),
        }
    }

    /// Frames in the phase. Zero is unrepresentable: `validate_phase` refuses
    /// an empty span before one can be stored.
    pub fn frame_count(&self) -> u64 {
        self.end_frame.saturating_sub(self.start_frame)
    }

    fn overlaps(&self, other: &TimelinePhase) -> bool {
        self.start_frame < other.end_frame && other.start_frame < self.end_frame
    }
}

/// Check one phase against the timeline it would live on.
///
/// Order matters: an empty span is refused before the range check, so an
/// author who inverted start and end is told exactly that rather than being
/// told the end is out of range.
pub fn validate_phase(timeline: &SceneTimeline, phase: &TimelinePhase) -> Result<(), Refusal> {
    if phase.end_frame <= phase.start_frame {
        return Err(Refusal::TimelinePhaseInvalidSpan {
            phase: phase.address(),
            start_frame: phase.start_frame,
            end_frame: phase.end_frame,
        });
    }
    if phase.end_frame > timeline.duration_frames {
        return Err(Refusal::TimelinePhaseOutOfRange {
            phase: phase.address(),
            end_frame: phase.end_frame,
            duration_frames: timeline.duration_frames,
        });
    }
    Ok(())
}

/// Add a phase, or move the one that already carries this address.
///
/// A refused call writes nothing: the timeline is touched only once every
/// check has passed.
pub fn set_phase(timeline: &mut SceneTimeline, phase: TimelinePhase) -> Result<(), Refusal> {
    validate_phase(timeline, &phase)?;
    let address = phase.address();
    for existing in &timeline.phases {
        if existing.address() != address && existing.overlaps(&phase) {
            return Err(Refusal::TimelinePhaseOverlap {
                earlier: existing.address(),
                later: address,
            });
        }
    }
    match timeline
        .phases
        .iter()
        .position(|existing| existing.address() == address)
    {
        Some(index) => timeline.phases[index] = phase,
        None => timeline.phases.push(phase),
    }
    timeline.phases.sort_by_key(|entry| entry.start_frame);
    Ok(())
}

/// Remove a phase by address. An absent phase is reported, never treated as
/// success — a caller that believes it deleted something needs to be wrong out
/// loud.
pub fn remove_phase(timeline: &mut SceneTimeline, address: &str) -> Result<TimelinePhase, Refusal> {
    match timeline
        .phases
        .iter()
        .position(|phase| phase.address() == address)
    {
        Some(index) => Ok(timeline.phases.remove(index)),
        None => Err(Refusal::TimelinePhaseUnknown {
            phase: address.to_owned(),
        }),
    }
}

/// Re-check every phase on a timeline.
///
/// Needed when something else moves underneath them: shortening the scene's
/// duration puts a phase out of range without the phase itself changing.
pub fn validate_phases(timeline: &SceneTimeline) -> Result<(), Refusal> {
    for (index, phase) in timeline.phases.iter().enumerate() {
        validate_phase(timeline, phase)?;
        for other in &timeline.phases[index + 1..] {
            if phase.overlaps(other) {
                return Err(Refusal::TimelinePhaseOverlap {
                    earlier: phase.address(),
                    later: other.address(),
                });
            }
        }
    }
    Ok(())
}

/// The phase covering a frame, if any.
///
/// Phases need not tile the timeline: a scene may name only its `in` and
/// `out`, leaving the frames between unnamed. `None` for an unnamed frame is
/// the honest answer, not a gap to paper over.
pub fn phase_at_frame(timeline: &SceneTimeline, frame: u64) -> Option<&TimelinePhase> {
    timeline
        .phases
        .iter()
        .find(|phase| frame >= phase.start_frame && frame < phase.end_frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeline(duration_frames: u64) -> SceneTimeline {
        SceneTimeline {
            duration_frames,
            ..Default::default()
        }
    }

    fn phase(kind: PhaseKind, start_frame: u64, end_frame: u64) -> TimelinePhase {
        TimelinePhase {
            kind,
            name: None,
            start_frame,
            end_frame,
        }
    }

    #[test]
    fn the_phase_names_are_the_motion_phase_vocabulary() {
        // The whole argument for this step is that presets and scenes finally
        // speak one vocabulary. If these drift, they do not.
        let declared: std::collections::BTreeSet<&str> =
            PhaseKind::ALL.iter().map(|kind| kind.name()).collect();
        let motion: std::collections::BTreeSet<&str> =
            crate::mcp::MOTION_PHASES.iter().copied().collect();
        assert_eq!(declared, motion);
    }

    #[test]
    fn adjacent_phases_are_legal_and_overlapping_ones_are_refused() {
        let mut t = timeline(100);
        set_phase(&mut t, phase(PhaseKind::In, 0, 50)).expect("in lands");
        // Half-open: 50 belongs to hold, not to in. Adjacency is not overlap.
        set_phase(&mut t, phase(PhaseKind::Hold, 50, 80)).expect("adjacent hold lands");
        assert_eq!(t.phases.len(), 2);

        let clash = set_phase(&mut t, phase(PhaseKind::Out, 49, 90))
            .expect_err("a span claiming frame 49 twice is refused");
        assert!(matches!(clash, Refusal::TimelinePhaseOverlap { .. }));
        assert_eq!(t.phases.len(), 2, "a refused call writes nothing");
    }

    #[test]
    fn a_span_past_the_duration_is_refused_and_an_empty_one_names_itself() {
        let mut t = timeline(100);
        let over = set_phase(&mut t, phase(PhaseKind::In, 90, 101)).expect_err("past the end");
        assert!(matches!(
            over,
            Refusal::TimelinePhaseOutOfRange {
                end_frame: 101,
                duration_frames: 100,
                ..
            }
        ));

        // Inverted bounds get their own diagnosis, not "out of range".
        let empty = set_phase(&mut t, phase(PhaseKind::Out, 60, 60)).expect_err("empty span");
        assert!(matches!(empty, Refusal::TimelinePhaseInvalidSpan { .. }));
        assert!(t.phases.is_empty());
    }

    #[test]
    fn setting_a_phase_twice_moves_it_rather_than_stacking_a_second() {
        let mut t = timeline(100);
        set_phase(&mut t, phase(PhaseKind::In, 0, 20)).expect("first");
        set_phase(&mut t, phase(PhaseKind::In, 0, 40)).expect("second replaces");
        assert_eq!(t.phases.len(), 1);
        assert_eq!(t.phases[0].end_frame, 40);
    }

    #[test]
    fn several_continue_phases_are_distinguished_by_name() {
        let mut t = timeline(100);
        set_phase(
            &mut t,
            TimelinePhase {
                kind: PhaseKind::Continue,
                name: Some("stat".into()),
                start_frame: 0,
                end_frame: 10,
            },
        )
        .expect("first continue");
        set_phase(
            &mut t,
            TimelinePhase {
                kind: PhaseKind::Continue,
                name: Some("score".into()),
                start_frame: 10,
                end_frame: 20,
            },
        )
        .expect("a differently-named continue is a different phase");
        assert_eq!(t.phases.len(), 2);
        assert_eq!(t.phases[0].address(), "continue:stat");
    }

    #[test]
    fn phases_are_kept_in_frame_order_however_they_were_authored() {
        let mut t = timeline(100);
        set_phase(&mut t, phase(PhaseKind::Out, 80, 100)).expect("out");
        set_phase(&mut t, phase(PhaseKind::In, 0, 20)).expect("in");
        assert_eq!(
            t.phases.iter().map(|p| p.start_frame).collect::<Vec<_>>(),
            vec![0, 80]
        );
    }

    #[test]
    fn an_unnamed_frame_reports_no_phase_rather_than_guessing_one() {
        let mut t = timeline(100);
        set_phase(&mut t, phase(PhaseKind::In, 0, 20)).expect("in");
        set_phase(&mut t, phase(PhaseKind::Out, 80, 100)).expect("out");

        assert_eq!(phase_at_frame(&t, 0).map(|p| p.kind), Some(PhaseKind::In));
        // 20 is exclusive on `in`, so it lies outside it.
        assert!(phase_at_frame(&t, 20).is_none());
        assert!(phase_at_frame(&t, 50).is_none());
        assert_eq!(phase_at_frame(&t, 99).map(|p| p.kind), Some(PhaseKind::Out));
        // And the frame numbered `duration_frames` is past the end entirely.
        assert!(phase_at_frame(&t, 100).is_none());
    }

    #[test]
    fn removing_an_absent_phase_is_reported_not_silently_accepted() {
        let mut t = timeline(100);
        set_phase(&mut t, phase(PhaseKind::In, 0, 20)).expect("in");
        assert_eq!(
            remove_phase(&mut t, "in").expect("removed").kind,
            PhaseKind::In
        );
        let missing = remove_phase(&mut t, "in").expect_err("already gone");
        assert!(matches!(missing, Refusal::TimelinePhaseUnknown { .. }));
    }

    #[test]
    fn shortening_the_scene_puts_a_phase_out_of_range_and_validation_says_so() {
        // The phase did not change; the timeline moved underneath it. That is
        // why re-validation exists separately from `set_phase`.
        let mut t = timeline(100);
        set_phase(&mut t, phase(PhaseKind::Out, 80, 100)).expect("out");
        validate_phases(&t).expect("valid at full duration");

        t.duration_frames = 60;
        let refusal = validate_phases(&t).expect_err("the phase now runs past the end");
        assert!(matches!(refusal, Refusal::TimelinePhaseOutOfRange { .. }));
    }

    #[test]
    fn a_scene_authored_before_phases_existed_still_parses() {
        // `#[serde(default)]` on the field is what makes this true; the test
        // exists so removing it fails here rather than in the field.
        let json = r#"{"durationFrames":100,"channels":[]}"#;
        let timeline: SceneTimeline = serde_json::from_str(json).expect("old timeline parses");
        assert!(timeline.phases.is_empty());
    }
}
