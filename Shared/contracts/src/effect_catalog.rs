//! The effect and preset surface the Editor's Effects & Presets and Effect
//! Controls panels are generated from (build plan 11.69, 11.70).
//!
//! **One list, never a second one.** The panel shows EffectCraft's whole
//! catalogue (306 effects in After Effects' categories; the listing is
//! `effect_catalog_data.rs`, generated from the pinned reference and attributed
//! there) and marks which of them this engine renders. An effect is *available*
//! exactly when the contract has it (`Effect`), so the panel cannot offer an
//! effect the validator would refuse, and a catalogued effect that is not ported
//! says so by name instead of pretending (invariant 18).
//!
//! **Parameters come from the one table.** `Effect::visit` is what keyframe
//! validation and evaluation read; the surface reads the same table, so a
//! parameter's path, domain and default in the panel are the engine's. A choice's
//! option labels are read back from the effect's own serialisation, so they are
//! the wire values and cannot drift from the enum.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::effect::{
    BoxBlur, BrightnessContrast, Curves, DirectionalBlur, Domain, DropShadow, Effect,
    EffectInstance, Exposure, Fill, GaussianBlur, Glow, GradientRamp, HueSaturation, Invert,
    IrisWipe, Levels, LinearWipe, Posterize, RadialWipe, Threshold, Tint, Vibrance,
};

#[path = "effect_catalog_data.rs"]
mod data;
pub use data::EFFECTCRAFT_CATALOG;

/// Who the catalogue's listing is from, shown in the panel.
pub const CATALOG_ATTRIBUTION: &str =
    "Effect catalogue from EffectCraft (the EffectCraft contributors, MIT OR Apache-2.0)";

/// Why a catalogued effect cannot be applied yet.
pub const NOT_PORTED: &str =
    "catalogued from EffectCraft, not yet ported to the GrapiX engine (build plan 3.25)";

/// Why EffectCraft's text-animator presets cannot be applied yet.
pub const NEEDS_TEXT_ANIMATORS: &str =
    "needs text animators, which the GrapiX engine does not have yet (build plan 11.61)";

/// The EffectCraft id of each effect this engine renders, with the contract tag.
pub const PORTED: &[(&str, &str)] = &[
    ("ec.generate.fill", "fill"),
    ("ec.color.tint", "tint"),
    ("ec.color.levels", "levels"),
    ("ec.color.curves", "curves"),
    ("ec.color.huesaturation", "hue-saturation"),
    ("ec.color.brightnesscontrast", "brightness-contrast"),
    ("ec.color.exposure", "exposure"),
    ("ec.blur.gaussian", "gaussian-blur"),
    ("ec.blur.fastbox", "box-blur"),
    ("ec.blur.directional", "directional-blur"),
    ("ec.stylize.glow", "glow"),
    ("ec.perspective.dropshadow", "drop-shadow"),
    ("ec.generate.gradientramp", "gradient-ramp"),
    ("ec.transition.linearwipe", "linear-wipe"),
    ("ec.transition.radialwipe", "radial-wipe"),
    ("ec.transition.iriswipe", "iris-wipe"),
    ("ec.channel.invert", "invert"),
    ("ec.stylize.posterize", "posterize"),
    ("ec.stylize.threshold", "threshold"),
    ("ec.color.vibrance", "vibrance"),
];

/// The effect a contract tag names, at its defaults.
pub fn default_effect(tag: &str) -> Option<Effect> {
    Some(match tag {
        "fill" => Effect::Fill(Fill::default()),
        "tint" => Effect::Tint(Tint::default()),
        "levels" => Effect::Levels(Levels::default()),
        "curves" => Effect::Curves(Curves::default()),
        "hue-saturation" => Effect::HueSaturation(HueSaturation::default()),
        "brightness-contrast" => Effect::BrightnessContrast(BrightnessContrast::default()),
        "exposure" => Effect::Exposure(Exposure::default()),
        "gaussian-blur" => Effect::GaussianBlur(GaussianBlur::default()),
        "box-blur" => Effect::BoxBlur(BoxBlur::default()),
        "directional-blur" => Effect::DirectionalBlur(DirectionalBlur::default()),
        "glow" => Effect::Glow(Glow::default()),
        "drop-shadow" => Effect::DropShadow(DropShadow::default()),
        "gradient-ramp" => Effect::GradientRamp(GradientRamp::default()),
        "linear-wipe" => Effect::LinearWipe(LinearWipe::default()),
        "radial-wipe" => Effect::RadialWipe(RadialWipe::default()),
        "iris-wipe" => Effect::IrisWipe(IrisWipe::default()),
        "invert" => Effect::Invert(Invert::default()),
        "posterize" => Effect::Posterize(Posterize::default()),
        "threshold" => Effect::Threshold(Threshold::default()),
        "vibrance" => Effect::Vibrance(Vibrance::default()),
        _ => return None,
    })
}

/// What kind of control a parameter is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ParameterKind {
    Number,
    Switch,
    Choice,
}

/// One parameter of an available effect, from the engine's parameter table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectParameter {
    /// The path below the effect: the JSON path into the effect's own value and
    /// the tail of its keyframe channel (`effects.<effectId>.<path>`).
    pub path: String,
    pub kind: ParameterKind,
    /// The inclusive range of a bounded number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max: Option<f64>,
    /// A choice's options, as their wire values, in index order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// The default, as the parameter table reads it (a switch 0 or 1, a choice
    /// its index).
    pub default: f64,
}

/// One effect in the catalogue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectListing {
    /// EffectCraft's id (`ec.blur.gaussian`).
    pub id: String,
    pub name: String,
    /// After Effects' category, as EffectCraft groups it.
    pub category: String,
    /// Whether this engine renders it. False means catalogued only.
    pub available: bool,
    /// The contract effect at its defaults, when available: what Apply adds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<Effect>,
    /// The parameters of an available effect; empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<EffectParameter>,
}

/// Where a preset is from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PresetSource {
    #[serde(rename = "EffectCraft")]
    EffectCraft,
    #[serde(rename = "GrapiX")]
    GrapiX,
}

/// One preset in the Effects & Presets panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PresetListing {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub source: PresetSource,
    /// The effect stack an effect preset adds, in order. Empty for a preset
    /// that is not an effect stack.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<EffectInstance>,
    /// Why it cannot be applied, when it cannot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unavailable: Option<String>,
}

/// Everything the Effects & Presets panel lists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectSurface {
    pub attribution: String,
    pub effects: Vec<EffectListing>,
    pub presets: Vec<PresetListing>,
}

/// EffectCraft's 8 original text-animator presets (`crates/engine/presets/
/// text_animators.json`, original work of the EffectCraft contributors, MIT OR
/// Apache-2.0): id, name, description. Listed; they apply once 11.61 exists.
pub const EFFECTCRAFT_PRESETS: &[(&str, &str, &str)] = &[
    (
        "typewriter",
        "Typewriter",
        "Characters appear one at a time, hard-edged.",
    ),
    (
        "fadeUpCharacters",
        "Fade Up Characters",
        "Characters fade in while rising into place, left to right.",
    ),
    (
        "bounceInWords",
        "Bounce In Words",
        "Words scale up from nothing with an overshoot, one after another.",
    ),
    (
        "trackingIn",
        "Tracking In",
        "Widely spaced text tightens up while fading in.",
    ),
    (
        "scramble",
        "Scramble",
        "Letters cycle through random characters before settling, left to right.",
    ),
    (
        "blurIn",
        "Blur In",
        "Characters come into focus and fade in, left to right.",
    ),
    (
        "jitter",
        "Jitter",
        "Characters wobble randomly in position and rotation, continuously.",
    ),
    (
        "dropInLines",
        "Drop In Lines",
        "Lines drop from above with a slight rotation, one after another.",
    ),
];

/// The value at a dotted path of a JSON value (`rgb.0.x`), if any.
fn at_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    path.split('.').try_fold(value, |node, segment| match node {
        serde_json::Value::Array(items) => items.get(segment.parse::<usize>().ok()?),
        other => other.get(segment),
    })
}

/// The parameters of an effect, from `Effect::visit`.
pub fn parameters_of(effect: &Effect) -> Vec<EffectParameter> {
    let mut table = Vec::new();
    effect
        .clone()
        .visit(&mut |path, slot| table.push((path.to_owned(), slot.domain(), slot.value())));
    table
        .into_iter()
        .map(|(path, domain, default)| {
            let (kind, min, max) = match domain {
                Domain::Finite => (ParameterKind::Number, None, None),
                Domain::Range { min, max } => (ParameterKind::Number, Some(min), Some(max)),
                Domain::Switch => (ParameterKind::Switch, None, None),
                Domain::Choice { .. } => (ParameterKind::Choice, None, None),
            };
            let options = match domain {
                Domain::Choice { count } => (0..count)
                    .map(|index| {
                        // Set the option on a copy and read its wire value back.
                        let mut copy = EffectInstance::new("probe", effect.clone());
                        copy.set(&path, index as f64);
                        serde_json::to_value(&copy)
                            .ok()
                            .and_then(|json| at_path(&json, &path)?.as_str().map(str::to_owned))
                            .unwrap_or_else(|| index.to_string())
                    })
                    .collect(),
                _ => Vec::new(),
            };
            EffectParameter {
                path,
                kind,
                min,
                max,
                options,
                default,
            }
        })
        .collect()
}

fn look(
    id: &str,
    name: &str,
    category: &str,
    description: &str,
    effects: Vec<(&str, Effect)>,
) -> PresetListing {
    PresetListing {
        id: id.to_owned(),
        name: name.to_owned(),
        category: category.to_owned(),
        description: description.to_owned(),
        source: PresetSource::GrapiX,
        effects: effects
            .into_iter()
            .map(|(effect_id, effect)| EffectInstance::new(effect_id, effect))
            .collect(),
        unavailable: None,
    }
}

/// GrapiX's own effect-stack presets: looks a broadcast graphic uses every day.
/// Each is a stack of contract effects, so it is validated like any other.
fn grapix_looks() -> Vec<PresetListing> {
    vec![
        look(
            "gx.look.lower-third-shadow",
            "Lower-third shadow",
            "Looks",
            "A soft, short drop shadow that lifts a strap off the picture.",
            vec![(
                "shadow",
                Effect::DropShadow(DropShadow {
                    opacity: 0.45,
                    distance: 6.0,
                    softness: 14.0,
                    ..DropShadow::default()
                }),
            )],
        ),
        look(
            "gx.look.soft-glow",
            "Soft glow",
            "Looks",
            "A gentle bloom on bright areas, for titles and score numerals.",
            vec![(
                "glow",
                Effect::Glow(Glow {
                    threshold: 0.6,
                    radius: 18.0,
                    intensity: 0.8,
                    ..Glow::default()
                }),
            )],
        ),
        look(
            "gx.look.punch-grade",
            "Punch grade",
            "Looks",
            "A little more contrast and saturation, for footage behind a graphic.",
            vec![
                (
                    "contrast",
                    Effect::BrightnessContrast(BrightnessContrast {
                        contrast: 0.15,
                        ..BrightnessContrast::default()
                    }),
                ),
                (
                    "saturation",
                    Effect::HueSaturation(HueSaturation {
                        saturation: 0.12,
                        ..HueSaturation::default()
                    }),
                ),
            ],
        ),
        look(
            "gx.look.frosted-backing",
            "Frosted backing",
            "Looks",
            "A blur and a slight dim, for a panel that sits behind text.",
            vec![
                (
                    "blur",
                    Effect::GaussianBlur(GaussianBlur {
                        blurriness: 24.0,
                        ..GaussianBlur::default()
                    }),
                ),
                (
                    "dim",
                    Effect::BrightnessContrast(BrightnessContrast {
                        brightness: -0.12,
                        ..BrightnessContrast::default()
                    }),
                ),
            ],
        ),
    ]
}

/// The whole surface: every catalogued effect, then every preset.
pub fn effect_surface() -> EffectSurface {
    let effects = EFFECTCRAFT_CATALOG
        .iter()
        .map(|(category, name, id, _params, _gpu)| {
            let template = PORTED
                .iter()
                .find(|(ec, _)| ec == id)
                .and_then(|(_, tag)| default_effect(tag));
            EffectListing {
                id: (*id).to_owned(),
                name: (*name).to_owned(),
                category: (*category).to_owned(),
                available: template.is_some(),
                parameters: template.as_ref().map(parameters_of).unwrap_or_default(),
                template,
            }
        })
        .collect();
    let mut presets = grapix_looks();
    presets.extend(
        EFFECTCRAFT_PRESETS
            .iter()
            .map(|(id, name, description)| PresetListing {
                id: format!("ec.textanimator.{id}"),
                name: (*name).to_owned(),
                category: "Text animators".to_owned(),
                description: (*description).to_owned(),
                source: PresetSource::EffectCraft,
                effects: Vec::new(),
                unavailable: Some(NEEDS_TEXT_ANIMATORS.to_owned()),
            }),
    );
    EffectSurface {
        attribution: CATALOG_ATTRIBUTION.to_owned(),
        effects,
        presets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effect::validate_effects;

    #[test]
    fn the_surface_lists_all_306_effects_and_exactly_the_20_the_engine_renders() {
        let surface = effect_surface();
        assert_eq!(surface.effects.len(), 306);
        let available: Vec<_> = surface.effects.iter().filter(|e| e.available).collect();
        assert_eq!(available.len(), 20);
        assert_eq!(PORTED.len(), 20);
        // Every ported id is in the catalogue once, and every contract effect is offered.
        let mut tags: Vec<&str> = available
            .iter()
            .map(|e| e.template.as_ref().unwrap().name())
            .collect();
        tags.sort_unstable();
        let mut expected: Vec<&str> = PORTED.iter().map(|(_, tag)| *tag).collect();
        expected.sort_unstable();
        assert_eq!(tags, expected);
        let mut ids: Vec<&str> = surface.effects.iter().map(|e| e.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 306, "ids are unique");
    }

    #[test]
    fn an_effect_that_is_not_ported_has_no_template_and_no_parameters() {
        let surface = effect_surface();
        let warp = surface
            .effects
            .iter()
            .find(|e| e.id == "ec.distort.warp")
            .expect("Warp is catalogued");
        assert!(!warp.available);
        assert!(warp.template.is_none());
        assert!(warp.parameters.is_empty());
        assert_eq!(warp.category, "Distort");
    }

    #[test]
    fn every_template_is_an_effect_the_validator_accepts() {
        for listing in effect_surface().effects.iter().filter(|e| e.available) {
            let instance = EffectInstance::new("probe", listing.template.clone().unwrap());
            validate_effects("card", &[instance])
                .unwrap_or_else(|refusal| panic!("{}: {refusal:?}", listing.id));
        }
    }

    /// The panel edits an effect by writing its JSON at the parameter's path, so
    /// every path must be a real JSON path whose value is the parameter's.
    #[test]
    fn every_parameter_path_is_the_json_path_of_its_value() {
        for listing in effect_surface().effects.iter().filter(|e| e.available) {
            let instance = EffectInstance::new("probe", listing.template.clone().unwrap());
            let json = serde_json::to_value(&instance).unwrap();
            assert!(!listing.parameters.is_empty(), "{}", listing.id);
            for parameter in &listing.parameters {
                let value = at_path(&json, &parameter.path)
                    .unwrap_or_else(|| panic!("{} has no JSON at {}", listing.id, parameter.path));
                match parameter.kind {
                    ParameterKind::Number => {
                        assert_eq!(
                            value.as_f64(),
                            Some(parameter.default),
                            "{}",
                            parameter.path
                        )
                    }
                    ParameterKind::Switch => assert_eq!(
                        value.as_bool(),
                        Some(parameter.default == 1.0),
                        "{}",
                        parameter.path
                    ),
                    ParameterKind::Choice => {
                        let label = value.as_str().expect("a choice is a string on the wire");
                        assert_eq!(
                            parameter.options[parameter.default as usize], label,
                            "{}",
                            parameter.path
                        );
                        let mut unique = parameter.options.clone();
                        unique.sort();
                        unique.dedup();
                        assert_eq!(unique.len(), parameter.options.len(), "{}", parameter.path);
                    }
                }
            }
        }
    }

    #[test]
    fn a_bounded_number_carries_its_range_and_its_default_is_inside_it() {
        let surface = effect_surface();
        let fill = surface
            .effects
            .iter()
            .find(|e| e.id == "ec.generate.fill")
            .unwrap();
        let opacity = fill
            .parameters
            .iter()
            .find(|p| p.path == "opacity")
            .unwrap();
        assert_eq!((opacity.min, opacity.max), (Some(0.0), Some(1.0)));
        for listing in surface.effects.iter().filter(|e| e.available) {
            for p in &listing.parameters {
                if let (Some(min), Some(max)) = (p.min, p.max) {
                    assert!(
                        (min..=max).contains(&p.default),
                        "{} {}",
                        listing.id,
                        p.path
                    );
                }
            }
        }
    }

    #[test]
    fn grapix_looks_are_valid_stacks_and_effectcraft_presets_say_why_they_wait() {
        let surface = effect_surface();
        let looks: Vec<_> = surface
            .presets
            .iter()
            .filter(|p| p.source == PresetSource::GrapiX)
            .collect();
        assert!(looks.len() >= 4);
        for preset in &looks {
            assert!(preset.unavailable.is_none());
            assert!(!preset.effects.is_empty(), "{}", preset.id);
            validate_effects("card", &preset.effects)
                .unwrap_or_else(|refusal| panic!("{}: {refusal:?}", preset.id));
        }
        let ported: Vec<_> = surface
            .presets
            .iter()
            .filter(|p| p.source == PresetSource::EffectCraft)
            .collect();
        assert_eq!(ported.len(), 8);
        for preset in ported {
            assert_eq!(preset.unavailable.as_deref(), Some(NEEDS_TEXT_ANIMATORS));
            assert!(preset.effects.is_empty());
        }
    }

    #[test]
    fn the_surface_round_trips_on_the_wire() {
        let surface = effect_surface();
        let json = serde_json::to_string(&surface).unwrap();
        assert_eq!(
            serde_json::from_str::<EffectSurface>(&json).unwrap(),
            surface
        );
    }
}
