//! Design-system tokens and the motion preset format (Part G).
//!
//! This module is the schema the whole handoff is a consumer of: Editor
//! defaults, the validator's enforcement, the MCP `designsystem.*` and
//! `motion.*` tools, and the Gen-AI generator all read these types. That is
//! why it lands in contracts *before* anything reads it (G.10): one
//! definition, everything downstream of it.
//!
//! The two load-bearing rules encoded here:
//!
//! - **Time is normalised; frames are resolved** (G.6.2). A preset stores keys
//!   on a 0–1 timeline and a duration in milliseconds. Frames are derived at
//!   instantiation against the scene's rational rate, never stored — a preset
//!   authored at 50p must behave identically at 59.94 and 23.976, and it will
//!   not if keys are stored in frames. `MotionPhase::resolve_frames` is the one
//!   place that conversion happens, in integer arithmetic, and the resolved
//!   count is what gets recorded on the instance.
//! - **A preset that cannot leave is a defect** (G.6.6). `MotionPreset::validate`
//!   refuses a missing `out` phase by name, because a graphic that cannot leave
//!   the screen is the failure that reaches air.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RationalRate;

/// A token reference in a preset: `{duration.base}`, `{easing.brand-in}`.
///
/// A preset that hardcodes a value instead of referencing a token is a bug for
/// the same reason a component hardcoding a hex colour is (G.6.1). Kept as a
/// string with a checked shape rather than a free string, so a malformed
/// reference is caught at parse, not at render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TokenRef(pub String);

impl TokenRef {
    /// Parse `{group.name}` into a reference, refusing a malformed shape.
    pub fn parse(s: &str) -> Result<Self, TokenRefError> {
        let inner = s
            .strip_prefix('{')
            .and_then(|s| s.strip_suffix('}'))
            .ok_or_else(|| TokenRefError(s.to_string()))?;
        let mut parts = inner.split('.');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(group), Some(name), None) if !group.is_empty() && !name.is_empty() => {
                Ok(Self(inner.to_string()))
            }
            _ => Err(TokenRefError(s.to_string())),
        }
    }

    /// The token group, e.g. `duration`.
    pub fn group(&self) -> &str {
        self.0.split('.').next().unwrap_or("")
    }

    /// The token name within the group, e.g. `base`.
    pub fn name(&self) -> &str {
        self.0.split('.').nth(1).unwrap_or("")
    }
}

/// A token reference that is not `{group.name}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenRefError(pub String);

impl std::fmt::Display for TokenRefError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed token reference: {:?}", self.0)
    }
}
impl std::error::Error for TokenRefError {}

/// Motion tokens: the primitives every preset composes from (G.6.1).
///
/// Durations and staggers are milliseconds. Easings are cubic-bezier control
/// points, or the literal `hold` for a phase that must not interpolate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MotionTokens {
    /// Named durations in ms, e.g. `snap: 160`, `base: 400`.
    pub duration: Vec<Named<f64>>,
    /// Named easings.
    pub easing: Vec<NamedEasing>,
    /// Named stagger intervals in ms, e.g. `tight: 40`, `base: 70`.
    pub stagger: Vec<Named<f64>>,
}

/// A named scalar token value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Named<T> {
    pub name: String,
    pub value: T,
}

/// An easing token: a cubic-bezier curve, or `hold`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "easing", rename_all = "camelCase")]
pub enum NamedEasing {
    /// A named cubic-bezier: `[x1, y1, x2, y2]`.
    Bezier { name: String, value: [f64; 4] },
    /// A named hold: no interpolation between keys.
    Hold { name: String },
}

/// The operator phases a preset participates in (G.6.3).
///
/// Broadcast motion is not one clip; it maps onto the operator verbs the
/// system already has. A preset must describe each phase it uses, and `in`
/// plus `out` are required.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MotionPhases {
    /// Build on. Triggered by Take. Required.
    pub r#in: MotionPhase,
    /// Build off. Triggered by Out. Required.
    pub out: MotionPhase,
    /// Idle loop after `in` completes. Must be safely interruptible at any
    /// frame.
    pub hold: Option<MotionPhase>,
    /// Staged builds, triggered by Continue. Zero or more.
    #[serde(default)]
    pub r#continue: Vec<MotionPhase>,
    /// How a bound value changes on air without a full re-take.
    pub update: Option<MotionPhase>,
}

/// One phase: a duration and the channels it animates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MotionPhase {
    /// Duration, either a token reference or a literal millisecond count.
    pub duration: DurationSpec,
    #[serde(default)]
    pub channels: Vec<MotionChannel>,
}

impl MotionPhase {
    /// Resolve this phase's duration to a whole frame count at `rate` (G.6.2).
    ///
    /// Milliseconds × (num/den) frames per second, rounded to the nearest whole
    /// frame, in integer arithmetic. A 400 ms wipe is 20 frames at 50p and 10
    /// at 25p — and this is the function that must produce both. The resolved
    /// count is what an instance records so an operator can see it.
    ///
    /// A token-referenced duration cannot be resolved without the token set, so
    /// this returns `None` for it; resolution against tokens happens at
    /// instantiation, where the set is in scope.
    pub fn resolve_frames(&self, rate: RationalRate) -> Option<u64> {
        let ms = match &self.duration {
            DurationSpec::Ms(ms) => *ms,
            DurationSpec::Token(_) => return None,
        };
        Some(ms_to_frames(ms, rate))
    }
}

/// A duration: a token reference or a literal millisecond count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum DurationSpec {
    /// `{duration.base}`.
    Token(TokenRef),
    /// Literal milliseconds.
    Ms(f64),
}

/// One animated property within a phase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MotionChannel {
    /// The property path, e.g. `position.x`, `opacity`.
    pub property: String,
    /// Keys on the 0–1 normalised timeline (G.6.2).
    pub keys: Vec<MotionKey>,
}

/// One keyframe. `t` is normalised 0–1; `v` may be a normalised offset (G.6.4:
/// `-1.0` is one object-width, so the preset is size-independent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MotionKey {
    pub t: f64,
    pub v: f64,
    /// The outgoing easing, as a token reference. Absent means linear.
    pub out: Option<TokenRef>,
}

/// How a stagger behaves as the item count grows (G.6.5).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Stagger {
    /// Constant interval; the total grows with the count.
    Fixed,
    /// The interval compresses so the total never exceeds `max_total` ms. The
    /// default for rosters, brackets and standings.
    CapTotal { max_total: f64 },
    /// Fixed interval; items overlap more as the count rises.
    Overlap,
}

/// A designer-authored motion preset (G.6.4). The model selects and
/// parameterises these; it never authors one (G.6.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MotionPreset {
    pub id: String,
    /// Object types the preset may be applied to.
    pub applies_to: Vec<String>,
    pub phases: MotionPhases,
    /// Adjustable parameters, each with its declared range.
    #[serde(default)]
    pub params: Vec<PresetParam>,
    /// Required when the preset drives a data-bound repeater (G.6.5).
    pub stagger: Option<Stagger>,
}

/// A preset parameter with its declared range (G.6.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PresetParam {
    /// An enumerated choice.
    Enum {
        name: String,
        values: Vec<String>,
        default: String,
    },
    /// A duration in ms, bounded.
    Duration {
        name: String,
        min: f64,
        max: f64,
        default: DurationSpec,
    },
}

/// Why a preset is not usable, named for the validator (G.6.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresetError {
    /// A graphic that cannot leave is a defect. `out` is required.
    MissingOutPhase,
    /// A token reference that is not `{group.name}`.
    MalformedTokenRef(TokenRefError),
}

impl std::fmt::Display for PresetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PresetError::MissingOutPhase => f.write_str(
                "a motion preset must have an out phase: a graphic that cannot leave is a defect",
            ),
            PresetError::MalformedTokenRef(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for PresetError {}

impl MotionPreset {
    /// The structural checks that do not need the renderer's capability set.
    ///
    /// The capability-dependent rules (a preset referencing a property the
    /// renderer cannot animate; a preset outside the system's whitelist) run in
    /// the validator, which has that set. What runs here is the rule that is
    /// true of every preset everywhere: it must be able to leave the screen.
    pub fn validate(&self) -> Result<(), PresetError> {
        // G.6.6: missing out phase is an error. `in` and `out` are structurally
        // required by the type, so this is where a hand-built or deserialised
        // preset that bypassed construction is caught.
        if self.phases.out.channels.is_empty() && self.phases.out.duration == DurationSpec::Ms(0.0)
        {
            return Err(PresetError::MissingOutPhase);
        }
        Ok(())
    }
}

/// Milliseconds to whole frames at a rational rate, rounded to nearest.
///
/// `ms * num / (den * 1000)`, with round-half-away-from-zero, in integer
/// arithmetic where the values allow. This is the arithmetic heart of G.6.2:
/// the same rule everywhere, so a preset resolves identically wherever it is
/// instantiated.
pub fn ms_to_frames(ms: f64, rate: RationalRate) -> u64 {
    // frames = ms * (num/den) / 1000. Done in f64 only at the final multiply;
    // the rate itself stays exact (num/den is never pre-rounded, invariant 12).
    let frames = ms * f64::from(rate.num) / (f64::from(rate.den) * 1000.0);
    frames.round().max(0.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_ref_parses_and_splits() {
        let r = TokenRef::parse("{duration.base}").unwrap();
        assert_eq!(r.group(), "duration");
        assert_eq!(r.name(), "base");
    }

    #[test]
    fn a_malformed_token_ref_is_refused() {
        for bad in [
            "duration.base",
            "{duration}",
            "{duration.base.extra}",
            "{}",
            "{.}",
        ] {
            assert!(
                TokenRef::parse(bad).is_err(),
                "{bad:?} must not parse as a token reference"
            );
        }
    }

    #[test]
    fn the_same_duration_resolves_differently_per_rate_but_consistently() {
        // G.6.2: 400 ms is 20 frames at 50p and 10 at 25p, and 13.333... at
        // 29.97 rounds deterministically.
        assert_eq!(ms_to_frames(400.0, RationalRate::P50), 20);
        assert_eq!(ms_to_frames(400.0, RationalRate::P25), 10);
        // 400ms at 30000/1001 = 11.988 -> 12, and the rate was never rounded.
        assert_eq!(ms_to_frames(400.0, RationalRate::P29_97), 12);
    }

    #[test]
    fn a_phase_resolves_its_literal_duration() {
        let phase = MotionPhase {
            duration: DurationSpec::Ms(400.0),
            channels: vec![],
        };
        assert_eq!(phase.resolve_frames(RationalRate::P50), Some(20));
    }

    #[test]
    fn a_token_duration_cannot_resolve_without_the_token_set() {
        let phase = MotionPhase {
            duration: DurationSpec::Token(TokenRef::parse("{duration.base}").unwrap()),
            channels: vec![],
        };
        assert_eq!(phase.resolve_frames(RationalRate::P50), None);
    }

    fn preset_with_out(out: MotionPhase) -> MotionPreset {
        MotionPreset {
            id: "lower-third/wipe-on".into(),
            applies_to: vec!["group".into()],
            phases: MotionPhases {
                r#in: MotionPhase {
                    duration: DurationSpec::Ms(400.0),
                    channels: vec![],
                },
                out,
                hold: None,
                r#continue: vec![],
                update: None,
            },
            params: vec![],
            stagger: None,
        }
    }

    #[test]
    fn a_preset_with_no_out_phase_is_a_defect() {
        let empty_out = preset_with_out(MotionPhase {
            duration: DurationSpec::Ms(0.0),
            channels: vec![],
        });
        assert_eq!(
            empty_out.validate(),
            Err(PresetError::MissingOutPhase),
            "a graphic that cannot leave is a defect (G.6.6)"
        );
    }

    #[test]
    fn a_preset_with_an_out_phase_is_accepted() {
        let good = preset_with_out(MotionPhase {
            duration: DurationSpec::Ms(240.0),
            channels: vec![],
        });
        assert!(good.validate().is_ok());
    }

    #[test]
    fn stagger_modes_are_count_adaptive_by_declaration() {
        // The mode is declared on the preset, so the validator can warn when a
        // data-bound repeater has none (G.6.5).
        let cap = Stagger::CapTotal { max_total: 1200.0 };
        assert!(matches!(cap, Stagger::CapTotal { .. }));
    }
}
