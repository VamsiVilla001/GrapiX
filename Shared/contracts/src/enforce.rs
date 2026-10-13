//! Design-system enforcement and the override log (build plan 7.5).
//!
//! Part G.4 of ADR-0002 states the argument this module implements, and it is
//! worth restating because it shapes every decision here: **a system that
//! cannot be overridden gets bypassed entirely, which is worse.** A rule that
//! blocks legitimate work does not make the work stop; it makes people stop
//! using the tool that blocks it. So enforcement has three severities, only
//! the most urgent blocks, and every rule can be overridden.
//!
//! The price of an override is a reason, and that price is charged by the type
//! system rather than by a check. [`Override::new`] is the only way to build
//! one and it refuses an empty reason, so there is no path that records an
//! override without saying why. A runtime check on an `Option<String>` would
//! have been forgettable at exactly one call site, and that site would become
//! the one everybody used.
//!
//! **The log is signal, not bookkeeping.** G.4: *"the rules overridden most
//! often are the rules that are wrong."* An override does not delete its
//! refusal — it downgrades it to `Info` and keeps it, so the log can be read
//! at version bump to find the rules that need changing rather than the
//! designers who need talking to.

use crate::color::{ColorValue, Rgba};
use crate::design_system::DesignSystem;
use crate::scene::{SceneDocument, SceneObject};
use crate::{Refusal, RefusalSeverity, StructuredRefusal};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// An override that could not be created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverrideError {
    /// An override with no reason is an override nobody can review later,
    /// which defeats the only thing that makes overriding acceptable.
    ReasonRequired { rule: String },
}

impl std::fmt::Display for OverrideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReasonRequired { rule } => {
                write!(f, "overriding {rule} requires a reason")
            }
        }
    }
}

impl std::error::Error for OverrideError {}

/// A recorded decision to accept a design-system violation.
///
/// Fields are private so the only way to obtain one is [`Override::new`],
/// which requires a reason. `Deserialize` is deliberately *not* derived for
/// the same purpose: a log read back from disk goes through
/// [`OverrideLog::load_checked`], so a hand-edited file cannot introduce a
/// reasonless override either.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Override {
    rule: String,
    object_id: String,
    reason: String,
    /// Who accepted it. An unattributed override is not reviewable.
    accepted_by: String,
}

impl Override {
    /// Record an override. Refuses without a reason.
    pub fn new(
        rule: impl Into<String>,
        object_id: impl Into<String>,
        reason: impl Into<String>,
        accepted_by: impl Into<String>,
    ) -> Result<Self, OverrideError> {
        let rule = rule.into();
        let reason = reason.into();
        if reason.trim().is_empty() {
            return Err(OverrideError::ReasonRequired { rule });
        }
        Ok(Self {
            rule,
            object_id: object_id.into(),
            reason,
            accepted_by: accepted_by.into(),
        })
    }

    pub fn rule(&self) -> &str {
        &self.rule
    }
    pub fn object_id(&self) -> &str {
        &self.object_id
    }
    pub fn reason(&self) -> &str {
        &self.reason
    }
    pub fn accepted_by(&self) -> &str {
        &self.accepted_by
    }

    fn matches(&self, rule: &str, object_id: &str) -> bool {
        self.rule == rule && self.object_id == object_id
    }
}

/// The accumulated overrides, reviewed when the system versions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OverrideLog {
    entries: Vec<Override>,
}

/// The wire form, used only to re-check a log on load.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOverride {
    rule: String,
    object_id: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    accepted_by: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLog {
    #[serde(default)]
    entries: Vec<RawOverride>,
}

impl OverrideLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, entry: Override) {
        self.entries.push(entry);
    }

    pub fn entries(&self) -> &[Override] {
        &self.entries
    }

    /// How often each rule was overridden, most-overridden first.
    ///
    /// This is the review artefact G.4 asks for. A rule at the top of this
    /// list is a candidate for being wrong, not a candidate for enforcement.
    pub fn by_frequency(&self) -> Vec<(&str, usize)> {
        let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
        for entry in &self.entries {
            *counts.entry(entry.rule.as_str()).or_default() += 1;
        }
        let mut out: Vec<_> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        out
    }

    /// Parse a log, re-applying the reason requirement.
    ///
    /// Deserialisation bypasses constructors, so a log that was hand-edited to
    /// drop a reason would otherwise re-enter the system as a valid override.
    pub fn load_checked(bytes: &[u8]) -> Result<Self, OverrideLogError> {
        let raw: RawLog = serde_json::from_slice(bytes).map_err(OverrideLogError::Malformed)?;
        let mut log = Self::new();
        for entry in raw.entries {
            log.record(
                Override::new(entry.rule, entry.object_id, entry.reason, entry.accepted_by)
                    .map_err(OverrideLogError::Invalid)?,
            );
        }
        Ok(log)
    }

    fn covers(&self, rule: &str, object_id: &str) -> Option<&Override> {
        self.entries
            .iter()
            .find(|entry| entry.matches(rule, object_id))
    }
}

/// A log that could not be read.
#[derive(Debug)]
pub enum OverrideLogError {
    Malformed(serde_json::Error),
    Invalid(OverrideError),
}

impl std::fmt::Display for OverrideLogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(e) => write!(f, "override log is not readable: {e}"),
            Self::Invalid(e) => write!(f, "override log contains an invalid entry: {e}"),
        }
    }
}

impl std::error::Error for OverrideLogError {}

/// The rule identifiers, so an override names a stable thing rather than a
/// message that changes when someone rewords it.
pub mod rule {
    pub const PALETTE: &str = "designSystem.palette";
    pub const SPACING_SCALE: &str = "designSystem.spacingScale";
    pub const MIN_TEXT_SIZE: &str = "designSystem.minTextSize";
}

/// Check a scene against a design system, honouring recorded overrides.
///
/// Returns everything it found, in document order. An overridden violation is
/// present but downgraded to `Info`: it no longer blocks, and it is still
/// visible, which is what makes the override log reviewable.
pub fn enforce(
    document: &SceneDocument,
    system: &DesignSystem,
    overrides: &OverrideLog,
) -> Vec<StructuredRefusal> {
    let mut found = Vec::new();

    for (index, object) in document.objects.iter().enumerate() {
        let base = object.base();

        if let Some(fill) = &base.fill {
            if let Some(colour) = solid(fill) {
                if !in_palette(colour, system) {
                    found.push(apply_override(
                        StructuredRefusal::error(Refusal::InvalidColor {
                            given: format!("#{:02x}{:02x}{:02x}", quantise(colour.r), quantise(colour.g), quantise(colour.b)),
                        })
                        .at(
                            format!("objects[{index}].fill"),
                            serde_json::json!(format!(
                                "#{:02x}{:02x}{:02x}",
                                quantise(colour.r),
                                quantise(colour.g),
                                quantise(colour.b)
                            )),
                        )
                        .allowing(palette_values(system)),
                        rule::PALETTE,
                        &base.id,
                        overrides,
                    ));
                }
            }
        }

        // Spacing is a warning, not an error: off-scale is usually a slip and
        // occasionally a deliberate optical correction, and G.4 reserves
        // blocking for things that are actually wrong on air.
        for (axis, value) in [("x", base.x), ("y", base.y)] {
            if value != 0.0 && !on_scale(value, system) {
                let mut refusal = StructuredRefusal::error(Refusal::NotImplemented {
                    what: format!("spacing {value} is not on the design system scale"),
                })
                .at(
                    format!("objects[{index}].{axis}"),
                    serde_json::json!(value),
                )
                .allowing(
                    system
                        .visual
                        .spacing
                        .iter()
                        .map(|s| serde_json::json!(s))
                        .collect(),
                );
                refusal.severity = RefusalSeverity::Warning;
                found.push(apply_override(
                    refusal,
                    rule::SPACING_SCALE,
                    &base.id,
                    overrides,
                ));
            }
        }

        if let SceneObject::Text(text) = object {
            if text.size < system.visual.min_text_size {
                found.push(apply_override(
                    StructuredRefusal::error(Refusal::NotImplemented {
                        what: format!(
                            "text size {} is below the legible minimum {}",
                            text.size, system.visual.min_text_size
                        ),
                    })
                    .at(
                        format!("objects[{index}].size"),
                        serde_json::json!(text.size),
                    ),
                    rule::MIN_TEXT_SIZE,
                    &base.id,
                    overrides,
                ));
            }
        }
    }

    found
}

/// Downgrade a violation the operator has accepted, keeping it visible.
fn apply_override(
    mut refusal: StructuredRefusal,
    rule: &str,
    object_id: &str,
    overrides: &OverrideLog,
) -> StructuredRefusal {
    if overrides.covers(rule, object_id).is_some() {
        refusal.severity = RefusalSeverity::Info;
    }
    refusal
}

fn solid(value: &ColorValue) -> Option<&Rgba> {
    match value {
        ColorValue::Solid { color } => Some(color),
        _ => None,
    }
}

fn quantise(component: f64) -> u8 {
    (component.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn in_palette(colour: &Rgba, system: &DesignSystem) -> bool {
    system.visual.palette.iter().any(|token| {
        quantise(token.value.r) == quantise(colour.r)
            && quantise(token.value.g) == quantise(colour.g)
            && quantise(token.value.b) == quantise(colour.b)
    })
}

fn palette_values(system: &DesignSystem) -> Vec<serde_json::Value> {
    system
        .visual
        .palette
        .iter()
        .map(|token| {
            serde_json::json!(format!(
                "#{:02x}{:02x}{:02x}",
                quantise(token.value.r),
                quantise(token.value.g),
                quantise(token.value.b)
            ))
        })
        .collect()
}

fn on_scale(value: f64, system: &DesignSystem) -> bool {
    system
        .visual
        .spacing
        .iter()
        .any(|step| (step - value.abs()).abs() < f64::EPSILON)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design_system::{MotionTokens, Named, VisualTokens};
    use crate::scene::{ObjectBase, RectObject, SceneCanvas, SceneTimeline, TextObject};
    use crate::{RationalRate, Revision};

    fn system() -> DesignSystem {
        DesignSystem {
            name: "Brand".into(),
            version: 3,
            visual: VisualTokens {
                palette: vec![Named {
                    name: "brand-blue".into(),
                    value: Rgba::srgb(0.2, 0.4, 0.8, 1.0),
                }],
                spacing: vec![18.0, 24.0, 48.0],
                min_text_size: 24.0,
            },
            motion: MotionTokens {
                duration: Vec::new(),
                easing: Vec::new(),
                stagger: Vec::new(),
            },
        }
    }

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        SceneDocument {
            working_color_space: crate::color::WorkingColorSpace::LinearSrgb,
            id: "s".into(),
            name: "S".into(),
            version: crate::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline { duration_frames: 1, ..Default::default() },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects,
        }
    }

    fn rect(id: &str, fill: Rgba, x: f64) -> SceneObject {
        let mut base = ObjectBase::new(id, id);
        base.fill = Some(ColorValue::Solid { color: fill });
        base.x = x;
        SceneObject::Rect(RectObject { base, radius: 0.0 })
    }

    #[test]
    fn an_override_cannot_exist_without_a_reason() {
        // The done-when of 7.5. This is a type-level property: there is no
        // other constructor, so no call site can forget.
        assert_eq!(
            Override::new(rule::PALETTE, "logo", "   ", "designer"),
            Err(OverrideError::ReasonRequired {
                rule: rule::PALETTE.into()
            })
        );
        Override::new(rule::PALETTE, "logo", "one-off sponsor colour", "designer")
            .expect("a reason is all it takes");
    }

    #[test]
    fn a_colour_outside_the_palette_is_an_error_naming_the_palette() {
        let scene = document(vec![rect("logo", Rgba::srgb(1.0, 0.0, 0.0, 1.0), 18.0)]);
        let found = enforce(&scene, &system(), &OverrideLog::new());

        let refusal = found
            .iter()
            .find(|r| r.field.as_deref() == Some("objects[0].fill"))
            .expect("an off-palette fill must be reported");
        assert_eq!(refusal.severity, RefusalSeverity::Error);
        assert_eq!(
            refusal.allowed,
            Some(vec![serde_json::json!("#3366cc")]),
            "the refusal must name the palette so it can be corrected in one step"
        );
    }

    #[test]
    fn off_scale_spacing_is_a_warning_and_does_not_block() {
        // G.4 reserves blocking for what is wrong on air. Off-scale spacing is
        // usually a slip and sometimes deliberate.
        let scene = document(vec![rect("bar", Rgba::srgb(0.2, 0.4, 0.8, 1.0), 23.0)]);
        let found = enforce(&scene, &system(), &OverrideLog::new());

        let refusal = found
            .iter()
            .find(|r| r.field.as_deref() == Some("objects[0].x"))
            .expect("off-scale spacing must be reported");
        assert_eq!(refusal.severity, RefusalSeverity::Warning);
        assert_eq!(
            refusal.allowed,
            Some(vec![
                serde_json::json!(18.0),
                serde_json::json!(24.0),
                serde_json::json!(48.0)
            ]),
            "the scale travels with the refusal, as ADR G.4's own example shows"
        );
    }

    #[test]
    fn text_below_the_legible_minimum_is_an_error() {
        let mut base = ObjectBase::new("caption", "caption");
        base.x = 18.0;
        let scene = document(vec![SceneObject::Text(TextObject {
            base,
            text: "small".into(),
            font_id: "f".into(),
            size: 12.0,
            layout: Default::default(),
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: Default::default(),
            text_case: Default::default(),
            decoration: Default::default(),
            overflow: Default::default(),
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
        })]);

        let found = enforce(&scene, &system(), &OverrideLog::new());
        let refusal = found
            .iter()
            .find(|r| r.field.as_deref() == Some("objects[0].size"))
            .expect("illegible text must be reported");
        assert_eq!(refusal.severity, RefusalSeverity::Error);
    }

    #[test]
    fn an_override_downgrades_a_violation_without_hiding_it() {
        // The rule that makes the log worth keeping: an accepted violation is
        // still reported, so it can be counted at version bump.
        let scene = document(vec![rect("logo", Rgba::srgb(1.0, 0.0, 0.0, 1.0), 18.0)]);
        let mut log = OverrideLog::new();
        log.record(
            Override::new(rule::PALETTE, "logo", "sponsor mandated red", "head-of-design")
                .expect("a reason was given"),
        );

        let found = enforce(&scene, &system(), &log);
        let refusal = found
            .iter()
            .find(|r| r.field.as_deref() == Some("objects[0].fill"))
            .expect("an overridden violation is still reported");
        assert_eq!(
            refusal.severity,
            RefusalSeverity::Info,
            "an override downgrades; it does not delete"
        );
    }

    #[test]
    fn the_log_ranks_the_rules_most_often_overridden() {
        // "The rules overridden most often are the rules that are wrong."
        let mut log = OverrideLog::new();
        for object in ["a", "b", "c"] {
            log.record(Override::new(rule::SPACING_SCALE, object, "optical", "d").unwrap());
        }
        log.record(Override::new(rule::PALETTE, "a", "sponsor", "d").unwrap());

        assert_eq!(
            log.by_frequency(),
            vec![(rule::SPACING_SCALE, 3), (rule::PALETTE, 1)]
        );
    }

    #[test]
    fn a_hand_edited_log_that_drops_a_reason_is_refused_on_load() {
        // Deserialisation bypasses constructors, so the requirement is
        // re-applied here. Otherwise editing the file is the way around it.
        let bytes = br#"{"entries":[{"rule":"designSystem.palette","objectId":"logo","reason":"","acceptedBy":"x"}]}"#;
        assert!(matches!(
            OverrideLog::load_checked(bytes),
            Err(OverrideLogError::Invalid(OverrideError::ReasonRequired { .. }))
        ));
    }

    #[test]
    fn a_log_survives_a_write_and_read_cycle() {
        let mut log = OverrideLog::new();
        log.record(Override::new(rule::PALETTE, "logo", "sponsor red", "design").unwrap());
        let bytes = serde_json::to_vec(&log).expect("a log serialises");
        let read_back = OverrideLog::load_checked(&bytes).expect("and reads back");
        assert_eq!(read_back, log);
        assert_eq!(read_back.entries()[0].reason(), "sponsor red");
    }

    #[test]
    fn a_conforming_scene_reports_nothing() {
        let scene = document(vec![rect("bar", Rgba::srgb(0.2, 0.4, 0.8, 1.0), 24.0)]);
        assert!(enforce(&scene, &system(), &OverrideLog::new()).is_empty());
    }
}
