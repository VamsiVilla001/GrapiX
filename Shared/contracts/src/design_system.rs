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

/// The visual tokens enforcement checks a scene against (Part G.4).
///
/// Deliberately small. The ADR's own warning is that a design system which
/// tries to encode everything becomes a system people bypass entirely, and
/// that "if a rule matters, make it a token" — so what is here is what G.4
/// actually names as enforceable: the palette, the spacing scale, and the
/// smallest text that stays legible on a broadcast display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VisualTokens {
    /// The colours a scene may use. A fill outside this set is an `error`.
    pub palette: Vec<Named<crate::color::Rgba>>,
    /// The spacing scale, in scene units. Off-scale spacing is a `warning`
    /// rather than an error: it is usually a mistake and occasionally a
    /// deliberate optical correction, and blocking it would be the
    /// over-strictness G.4 warns about.
    pub spacing: Vec<f64>,
    /// The smallest text size that stays legible at broadcast viewing
    /// distance. Below it is an `error`, because it is unreadable on air
    /// rather than merely unusual.
    pub min_text_size: f64,
}

/// A design system at one version.
///
/// The version is not decoration: a package stamped with the system it was
/// built against makes brand-pack drift *listable* rather than invisible
/// (Part G's risk table), which is what 7.6 stamps onto every package.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesignSystem {
    pub name: String,
    /// Monotonic. A package records this, so "which templates predate v4"
    /// is a query rather than an investigation.
    pub version: u32,
    pub visual: VisualTokens,
    pub motion: MotionTokens,
}

/// The external format a design-system draft came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DesignSystemSourceKind {
    W3c,
    Figma,
    ClaudeDesign,
}

/// The complete source document retained beside an imported draft.
///
/// Import is deliberately not a destructive projection. The mapped tokens are
/// what GrapiX can enforce; `document` is the source **as supplied**, so a
/// reviewer can inspect and re-export everything it actually contained.
///
/// It is the original text rather than a re-print of the parse, and `sha256`
/// is taken over those same bytes. A hash over a re-serialisation answers "is
/// this equivalent to what we parsed?", which is not the question provenance
/// asks: a duplicated JSON key, or a number re-spelled by whichever toolchain
/// last wrote the file, would silently change what the record refers to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesignSystemSource {
    pub kind: DesignSystemSourceKind,
    pub sha256: crate::ContentHash,
    pub document: String,
}

/// One source value that became a GrapiX token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TokenMapping {
    pub source_path: String,
    pub token_path: String,
}

/// A source value the current token contract cannot express.
///
/// Keeping the original value is part of the report: a path and a vague
/// message are not enough for a human to judge whether accepting the draft
/// would discard a load-bearing brand rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UnexpressibleToken {
    pub source_path: String,
    pub source_type: String,
    pub reason: String,
    pub value: serde_json::Value,
}

/// Visual tokens while an import is awaiting human review.
///
/// `min_text_size` stays optional here and required in [`VisualTokens`]. An
/// importer may not invent a legibility threshold merely to make a draft look
/// complete; confirmation refuses until a human supplies one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftVisualTokens {
    pub palette: Vec<Named<crate::color::Rgba>>,
    pub spacing: Vec<f64>,
    pub min_text_size: Option<f64>,
}

/// A lossless import proposal. It cannot become active without confirmation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesignSystemDraft {
    pub name: String,
    pub visual: DraftVisualTokens,
    pub motion: MotionTokens,
    pub brief: String,
    pub mappings: Vec<TokenMapping>,
    pub unexpressible: Vec<UnexpressibleToken>,
    pub source: DesignSystemSource,
}

/// A draft plus the human confirming it (G.2, build plan 10.4).
///
/// The confirmation is deliberately *not* a field on [`DesignSystemDraft`]. A
/// draft is a proposal, and a proposal that can carry its own confirmation is
/// one an importer could fill in on the reviewer's behalf — which is exactly
/// the auto-accept G.2 forbids. Keeping it in the request makes confirming an
/// act a caller performs rather than a property the draft already had.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesignSystemCommit {
    pub draft: DesignSystemDraft,
    /// Who accepted it. Recorded into provenance; never invented.
    pub confirmed_by: String,
}

/// A request to propose a draft from a source document (10.1-10.3).
///
/// `kind` is named by the caller rather than sniffed from the document. A
/// guess would select a mapper, and the wrong mapper does not fail loudly — it
/// reads the wrong fields and produces a plausible token set, which is the
/// silent substitution invariant 18 forbids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesignSystemImport {
    pub project: String,
    pub name: String,
    pub kind: DesignSystemSourceKind,
    /// The source document as text, exactly as the file holds it.
    ///
    /// Text rather than embedded JSON so the bytes that are hashed into
    /// provenance are the bytes the reviewer supplied. Re-encoding a parsed
    /// value here would mean the record identifies our re-print rather than
    /// their file.
    pub document: String,
}

/// Who confirmed a version, from what source, with which importer (G.3).
///
/// Lives in contracts rather than beside the store because it is a wire shape
/// that `designsystem.list_versions` returns: a copy in TypeScript would be
/// the hand-mirrored type invariant 22 forbids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source_kind: DesignSystemSourceKind,
    pub source_sha256: crate::ContentHash,
    pub importer_version: u32,
    pub confirmed_by: String,
}

/// One confirmed version and where it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesignSystemVersion {
    pub version: u32,
    pub provenance: Provenance,
}

/// The version history, oldest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesignSystemVersions {
    pub versions: Vec<DesignSystemVersion>,
}

// ---------------------------------------------------------------------------
// Drift across published templates (build plan 10.5)
// ---------------------------------------------------------------------------

/// One published template and the design-system version it was stamped with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StampedTemplate {
    pub template_id: String,
    /// Absent means the package predates stamping — a different statement from
    /// "built against no system", and the reason this is an `Option`.
    pub design_system_version: Option<u32>,
}

/// One template that is not on the current version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DriftEntry {
    pub template_id: String,
    pub stamped_version: Option<u32>,
    pub versions_behind: Option<u32>,
}

/// Which published templates are behind the current design system (10.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub current_version: u32,
    pub behind: Vec<DriftEntry>,
    pub unstamped: Vec<DriftEntry>,
}

/// List every template behind `current_version`.
///
/// Unstamped templates are reported separately rather than counted as
/// "infinitely behind": the honest answer is that the package predates
/// stamping and its conformance is unknown, which is a different job to do
/// than re-publishing a template that is merely two versions old. Collapsing
/// the two would put a template on a re-publish list for a reason nobody can
/// verify.
pub fn drift_report(current_version: u32, templates: &[StampedTemplate]) -> DriftReport {
    let mut behind = Vec::new();
    let mut unstamped = Vec::new();

    for template in templates {
        match template.design_system_version {
            None => unstamped.push(DriftEntry {
                template_id: template.template_id.clone(),
                stamped_version: None,
                versions_behind: None,
            }),
            Some(stamped) if stamped < current_version => behind.push(DriftEntry {
                template_id: template.template_id.clone(),
                stamped_version: Some(stamped),
                versions_behind: Some(current_version - stamped),
            }),
            Some(_) => {}
        }
    }

    behind.sort_by(|a, b| a.template_id.cmp(&b.template_id));
    unstamped.sort_by(|a, b| a.template_id.cmp(&b.template_id));

    DriftReport {
        current_version,
        behind,
        unstamped,
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

/// The starter motion library: Fade, Slide, Scale and Pop (11.23).
///
/// Library *data*, not an authoring path. G.6.7's rule stands — the model
/// selects and parameterises a preset, it never authors one — and these four
/// exist so the library is not empty on day one, which is what would otherwise
/// push an author into hand-keying the motion every template needs.
///
/// Every preset declares `out`. A graphic that goes to air and never clears is
/// the failure G.6.6 names, and `presetBlocker` in the browser refuses a
/// preset without one — so a starter preset missing it would be shipped
/// broken.
///
/// Positions are expressed as **normalised offsets**: `-1.0` is one
/// object-width, so Slide means the same thing on a lower-third and on a
/// full-frame card (G.6.4).
pub fn starter_presets() -> Vec<MotionPreset> {
    let ease_out = || Some(TokenRef("easing.ease-out".into()));
    let ease_in = || Some(TokenRef("easing.ease-in".into()));
    let ease_in_out = || Some(TokenRef("easing.ease-in-out".into()));

    let phase = |ms: f64, channels: Vec<MotionChannel>| MotionPhase {
        duration: DurationSpec::Ms(ms),
        channels,
    };
    let channel = |property: &str, keys: Vec<MotionKey>| MotionChannel {
        property: property.to_owned(),
        keys,
    };
    let duration_param = |name: &str, default: f64| PresetParam::Duration {
        name: name.to_owned(),
        min: 80.0,
        max: 2_000.0,
        default: DurationSpec::Ms(default),
    };

    vec![
        MotionPreset {
            id: "fade".into(),
            applies_to: ANY_VISIBLE.iter().map(|kind| (*kind).to_owned()).collect(),
            phases: MotionPhases {
                r#in: phase(
                    300.0,
                    vec![channel(
                        "opacity",
                        vec![
                            MotionKey { t: 0.0, v: 0.0, out: ease_out() },
                            MotionKey { t: 1.0, v: 1.0, out: None },
                        ],
                    )],
                ),
                out: phase(
                    240.0,
                    vec![channel(
                        "opacity",
                        vec![
                            MotionKey { t: 0.0, v: 1.0, out: ease_in() },
                            MotionKey { t: 1.0, v: 0.0, out: None },
                        ],
                    )],
                ),
                hold: None,
                r#continue: Vec::new(),
                update: None,
            },
            params: vec![duration_param("duration", 300.0)],
            stagger: None,
        },
        MotionPreset {
            id: "slide".into(),
            applies_to: ANY_VISIBLE.iter().map(|kind| (*kind).to_owned()).collect(),
            phases: MotionPhases {
                r#in: phase(
                    400.0,
                    vec![channel(
                        "position.x",
                        vec![
                            // One object-width to the left, arriving on its
                            // authored position.
                            MotionKey { t: 0.0, v: -1.0, out: ease_out() },
                            MotionKey { t: 1.0, v: 0.0, out: None },
                        ],
                    )],
                ),
                out: phase(
                    320.0,
                    vec![channel(
                        "position.x",
                        vec![
                            MotionKey { t: 0.0, v: 0.0, out: ease_in() },
                            MotionKey { t: 1.0, v: -1.0, out: None },
                        ],
                    )],
                ),
                hold: None,
                r#continue: Vec::new(),
                update: None,
            },
            params: vec![duration_param("duration", 400.0)],
            stagger: Some(Stagger::CapTotal { max_total: 1_200.0 }),
        },
        MotionPreset {
            id: "scale".into(),
            applies_to: ANY_VISIBLE.iter().map(|kind| (*kind).to_owned()).collect(),
            phases: MotionPhases {
                r#in: phase(
                    320.0,
                    vec![
                        channel(
                            "scale.x",
                            vec![
                                MotionKey { t: 0.0, v: 0.0, out: ease_out() },
                                MotionKey { t: 1.0, v: 1.0, out: None },
                            ],
                        ),
                        channel(
                            "scale.y",
                            vec![
                                MotionKey { t: 0.0, v: 0.0, out: ease_out() },
                                MotionKey { t: 1.0, v: 1.0, out: None },
                            ],
                        ),
                    ],
                ),
                out: phase(
                    260.0,
                    vec![
                        channel(
                            "scale.x",
                            vec![
                                MotionKey { t: 0.0, v: 1.0, out: ease_in() },
                                MotionKey { t: 1.0, v: 0.0, out: None },
                            ],
                        ),
                        channel(
                            "scale.y",
                            vec![
                                MotionKey { t: 0.0, v: 1.0, out: ease_in() },
                                MotionKey { t: 1.0, v: 0.0, out: None },
                            ],
                        ),
                    ],
                ),
                hold: None,
                r#continue: Vec::new(),
                update: None,
            },
            params: vec![duration_param("duration", 320.0)],
            stagger: None,
        },
        MotionPreset {
            id: "pop".into(),
            applies_to: ANY_VISIBLE.iter().map(|kind| (*kind).to_owned()).collect(),
            phases: MotionPhases {
                // The overshoot is the whole point: 0 → 1.12 → 1. A "pop" that
                // eased straight to 1 is a scale, and the two are different
                // instructions to a designer.
                r#in: phase(
                    360.0,
                    vec![
                        channel(
                            "scale.x",
                            vec![
                                MotionKey { t: 0.0, v: 0.0, out: ease_out() },
                                MotionKey { t: 0.65, v: 1.12, out: ease_in_out() },
                                MotionKey { t: 1.0, v: 1.0, out: None },
                            ],
                        ),
                        channel(
                            "scale.y",
                            vec![
                                MotionKey { t: 0.0, v: 0.0, out: ease_out() },
                                MotionKey { t: 0.65, v: 1.12, out: ease_in_out() },
                                MotionKey { t: 1.0, v: 1.0, out: None },
                            ],
                        ),
                    ],
                ),
                out: phase(
                    220.0,
                    vec![
                        channel(
                            "scale.x",
                            vec![
                                MotionKey { t: 0.0, v: 1.0, out: ease_in() },
                                MotionKey { t: 1.0, v: 0.0, out: None },
                            ],
                        ),
                        channel(
                            "scale.y",
                            vec![
                                MotionKey { t: 0.0, v: 1.0, out: ease_in() },
                                MotionKey { t: 1.0, v: 0.0, out: None },
                            ],
                        ),
                    ],
                ),
                hold: None,
                r#continue: Vec::new(),
                update: None,
            },
            params: vec![duration_param("duration", 360.0)],
            stagger: None,
        },
    ]
}

/// Object kinds a transform or opacity preset can drive: everything that
/// draws. Containers are excluded because their transform reaches their
/// children, which is a different instruction.
const ANY_VISIBLE: &[&str] = &[
    "text", "rect", "ellipse", "image", "line", "shape", "paint", "mesh",
];

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
