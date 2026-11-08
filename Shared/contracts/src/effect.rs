//! The typed effect registry (build-plan 3.22).
//!
//! An object carries an ordered effect stack, applied to the layer's own
//! pixels before it is transformed and blended, as After Effects applies a
//! layer's effects. Every effect is one variant of [`Effect`] with its own
//! typed parameter struct; there are no string-keyed parameters in the scene
//! or in a renderer. A tag this build does not know fails to parse, naming
//! the tag. The design (per-object stack, tagged enum, stable effect ids,
//! keyframe paths through a typed table) was decided with Jev on 8 November
//! 2026; EffectCraft's string-keyed registry was studied and not ported.
//!
//! **Keyframing.** Every parameter is keyframable. A channel addresses one as
//! `effects.<effectId>.<path>` (`effects.grade.gamma`, `effects.tint.mapWhiteTo.r`,
//! `effects.curve.rgb.1.y`). The path is resolved through
//! [`Effect::visit`], the one table of each effect's parameters, which also
//! gives each parameter's domain. Switches and choices are keyed with hold
//! keys only, valued 0/1 or the choice's index.
//!
//! **Pixels.** Every effect works on the layer's premultiplied working-space
//! pixels and never creates a pixel where the layer drew none: a fully
//! transparent pixel stays transparent. Only the spatial effects (blurs, glow,
//! drop shadow) grow a layer, by a reach their parameters declare. That keeps
//! the result independent of how a renderer crops a layer's texture.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::{Rgba, SourceColorSpace};
use crate::Refusal;

fn yes() -> bool {
    true
}

/// One entry in an object's effect stack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EffectInstance {
    /// Stable within the object: keyframe channels address the effect by it,
    /// so reordering the stack keeps every channel valid.
    pub effect_id: String,
    /// A disabled effect is skipped entirely. Keyframable with hold keys.
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(flatten)]
    pub effect: Effect,
}

impl EffectInstance {
    pub fn new(effect_id: impl Into<String>, effect: Effect) -> Self {
        Self {
            effect_id: effect_id.into(),
            enabled: true,
            effect,
        }
    }
}

/// Every effect the authoring vocabulary contains. The wire tag is the
/// `effect` field, in kebab-case.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(tag = "effect", rename_all = "kebab-case")]
pub enum Effect {
    Fill(Fill),
    Tint(Tint),
    Levels(Levels),
    Curves(Curves),
    HueSaturation(HueSaturation),
    BrightnessContrast(BrightnessContrast),
    Exposure(Exposure),
    GaussianBlur(GaussianBlur),
    BoxBlur(BoxBlur),
    DirectionalBlur(DirectionalBlur),
    Glow(Glow),
    DropShadow(DropShadow),
    GradientRamp(GradientRamp),
    LinearWipe(LinearWipe),
    RadialWipe(RadialWipe),
    IrisWipe(IrisWipe),
}

/// Paints the layer's pixels with a colour, keeping their coverage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Fill {
    pub color: Rgba,
    /// 0–1: how much of the colour replaces the layer's own.
    pub opacity: f64,
}

/// Maps luminance to a colour ramp between two colours.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Tint {
    pub map_black_to: Rgba,
    pub map_white_to: Rgba,
    /// 0–1.
    pub amount: f64,
}

/// One channel's levels, in 0–1 units.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct LevelsChannel {
    pub input_black: f64,
    pub input_white: f64,
    /// 0.01–10; 1 is linear.
    pub gamma: f64,
    pub output_black: f64,
    pub output_white: f64,
}

/// Levels: the RGB controls map every colour channel, then each channel's
/// own; the alpha controls map coverage where the layer drew.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Levels {
    pub rgb: LevelsChannel,
    pub red: LevelsChannel,
    pub green: LevelsChannel,
    pub blue: LevelsChannel,
    pub alpha: LevelsChannel,
    /// Clip values below input black / above input white.
    pub clip_to_output_black: bool,
    pub clip_to_output_white: bool,
}

/// A control point of a tone curve, both coordinates 0–1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
    pub x: f64,
    pub y: f64,
}

/// Curves: each channel is a monotone cubic through its points (at least
/// two), extended linearly beyond the end points. Colour channels go through
/// the RGB curve first, then their own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Curves {
    pub rgb: Vec<CurvePoint>,
    pub red: Vec<CurvePoint>,
    pub green: Vec<CurvePoint>,
    pub blue: Vec<CurvePoint>,
    pub alpha: Vec<CurvePoint>,
}

/// Hue/Saturation, master controls and Colorize.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct HueSaturation {
    /// Degrees.
    pub hue: f64,
    /// -1–1.
    pub saturation: f64,
    /// -1–1.
    pub lightness: f64,
    pub colorize: bool,
    /// Degrees.
    pub colorize_hue: f64,
    /// 0–1.
    pub colorize_saturation: f64,
    /// -1–1.
    pub colorize_lightness: f64,
}

/// Brightness & Contrast.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct BrightnessContrast {
    /// -1.5–1.5.
    pub brightness: f64,
    /// -1–1.
    pub contrast: f64,
    /// After Effects' legacy linear formula, which clips; otherwise tone
    /// curves that keep black and white fixed.
    pub use_legacy: bool,
}

/// Exposure, in linear light whatever the working space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Exposure {
    /// Stops, -20–20.
    pub exposure: f64,
    /// -1–1, added after the gain.
    pub offset: f64,
    /// 0.01–10.
    pub gamma_correction: f64,
}

/// Which axes a blur or glow spreads along.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum BlurDimensions {
    #[default]
    HorizontalAndVertical,
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct GaussianBlur {
    /// Pixels, 0–1000.
    pub blurriness: f64,
    pub dimensions: BlurDimensions,
    pub repeat_edge_pixels: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct BoxBlur {
    /// Pixels, 0–1000.
    pub radius: f64,
    /// 1–50, rounded.
    pub iterations: f64,
    pub dimensions: BlurDimensions,
    pub repeat_edge_pixels: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct DirectionalBlur {
    /// Degrees.
    pub direction: f64,
    /// Pixels, 0–1000.
    pub length: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Glow {
    /// 0–1.
    pub threshold: f64,
    /// Pixels, 0–1000.
    pub radius: f64,
    /// 0–10.
    pub intensity: f64,
    pub dimensions: BlurDimensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct DropShadow {
    pub color: Rgba,
    /// 0–1.
    pub opacity: f64,
    /// Degrees, clockwise from up.
    pub direction: f64,
    /// Pixels, 0–1000.
    pub distance: f64,
    /// Pixels, 0–1000.
    pub softness: f64,
    pub shadow_only: bool,
}

/// A point in the layer's own pixels.
#[derive(
    Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub struct EffectPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum RampShape {
    #[default]
    Linear,
    Radial,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct GradientRamp {
    pub start: EffectPoint,
    pub start_color: Rgba,
    pub end: EffectPoint,
    pub end_color: Rgba,
    pub shape: RampShape,
    /// 0–1.
    pub blend_with_original: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct LinearWipe {
    /// 0–1.
    pub completion: f64,
    /// Degrees.
    pub angle: f64,
    /// Pixels, 0–1000.
    pub feather: f64,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum WipeDirection {
    #[default]
    Clockwise,
    Counterclockwise,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct RadialWipe {
    /// 0–1.
    pub completion: f64,
    /// Degrees.
    pub start_angle: f64,
    pub center: EffectPoint,
    pub direction: WipeDirection,
    /// Pixels, 0–1000.
    pub feather: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct IrisWipe {
    pub center: EffectPoint,
    /// 6–32, rounded.
    pub points: f64,
    /// Pixels, 0–10000.
    pub outer_radius: f64,
    /// Pixels, 0–10000.
    pub inner_radius: f64,
    pub use_inner_radius: bool,
    /// Degrees.
    pub rotation: f64,
    /// Pixels, 0–1000.
    pub feather: f64,
}

fn srgb(r: f64, g: f64, b: f64) -> Rgba {
    Rgba::new(r, g, b, 1.0, SourceColorSpace::Srgb)
}

fn identity_curve() -> Vec<CurvePoint> {
    vec![CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 1.0, y: 1.0 }]
}

impl Default for Fill {
    fn default() -> Self {
        Self {
            color: srgb(1.0, 0.0, 0.0),
            opacity: 1.0,
        }
    }
}
impl Default for Tint {
    fn default() -> Self {
        Self {
            map_black_to: srgb(0.0, 0.0, 0.0),
            map_white_to: srgb(1.0, 1.0, 1.0),
            amount: 1.0,
        }
    }
}
impl Default for LevelsChannel {
    fn default() -> Self {
        Self {
            input_black: 0.0,
            input_white: 1.0,
            gamma: 1.0,
            output_black: 0.0,
            output_white: 1.0,
        }
    }
}
impl Default for Levels {
    fn default() -> Self {
        let c = LevelsChannel::default();
        Self {
            rgb: c,
            red: c,
            green: c,
            blue: c,
            alpha: c,
            clip_to_output_black: true,
            clip_to_output_white: true,
        }
    }
}
impl Default for Curves {
    fn default() -> Self {
        Self {
            rgb: identity_curve(),
            red: identity_curve(),
            green: identity_curve(),
            blue: identity_curve(),
            alpha: identity_curve(),
        }
    }
}
impl Default for HueSaturation {
    fn default() -> Self {
        Self {
            hue: 0.0,
            saturation: 0.0,
            lightness: 0.0,
            colorize: false,
            colorize_hue: 0.0,
            colorize_saturation: 0.25,
            colorize_lightness: 0.0,
        }
    }
}
impl Default for BrightnessContrast {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 0.0,
            use_legacy: false,
        }
    }
}
impl Default for Exposure {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            offset: 0.0,
            gamma_correction: 1.0,
        }
    }
}
impl Default for GaussianBlur {
    fn default() -> Self {
        Self {
            blurriness: 0.0,
            dimensions: BlurDimensions::default(),
            repeat_edge_pixels: false,
        }
    }
}
impl Default for BoxBlur {
    fn default() -> Self {
        Self {
            radius: 0.0,
            iterations: 1.0,
            dimensions: BlurDimensions::default(),
            repeat_edge_pixels: false,
        }
    }
}
impl Default for DirectionalBlur {
    fn default() -> Self {
        Self {
            direction: 0.0,
            length: 0.0,
        }
    }
}
impl Default for Glow {
    fn default() -> Self {
        Self {
            threshold: 0.6,
            radius: 10.0,
            intensity: 1.0,
            dimensions: BlurDimensions::default(),
        }
    }
}
impl Default for DropShadow {
    fn default() -> Self {
        Self {
            color: srgb(0.0, 0.0, 0.0),
            opacity: 0.5,
            direction: 135.0,
            distance: 5.0,
            softness: 0.0,
            shadow_only: false,
        }
    }
}
impl Default for GradientRamp {
    fn default() -> Self {
        Self {
            start: EffectPoint { x: 0.0, y: 0.0 },
            start_color: srgb(0.0, 0.0, 0.0),
            end: EffectPoint { x: 0.0, y: 100.0 },
            end_color: srgb(1.0, 1.0, 1.0),
            shape: RampShape::default(),
            blend_with_original: 0.0,
        }
    }
}
impl Default for LinearWipe {
    fn default() -> Self {
        Self {
            completion: 0.0,
            angle: 90.0,
            feather: 0.0,
        }
    }
}
impl Default for RadialWipe {
    fn default() -> Self {
        Self {
            completion: 0.0,
            start_angle: 0.0,
            center: EffectPoint::default(),
            direction: WipeDirection::default(),
            feather: 0.0,
        }
    }
}
impl Default for IrisWipe {
    fn default() -> Self {
        Self {
            center: EffectPoint::default(),
            points: 6.0,
            outer_radius: 0.0,
            inner_radius: 0.0,
            use_inner_radius: false,
            rotation: 0.0,
            feather: 0.0,
        }
    }
}

/// What values a parameter takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Domain {
    /// Any finite number.
    Finite,
    /// A finite number in `min..=max`.
    Range { min: f64, max: f64 },
    /// On or off: keyed 0 or 1 with hold keys.
    Switch,
    /// One of `count` options: keyed by index with hold keys.
    Choice { count: usize },
}

impl Domain {
    /// Whether keys on this parameter must hold.
    pub fn is_discrete(self) -> bool {
        matches!(self, Domain::Switch | Domain::Choice { .. })
    }

    /// Whether a value is in the domain.
    pub fn admits(self, value: f64) -> bool {
        if !value.is_finite() {
            return false;
        }
        match self {
            Domain::Finite => true,
            Domain::Range { min, max } => (min..=max).contains(&value),
            Domain::Switch => value == 0.0 || value == 1.0,
            Domain::Choice { count } => {
                value.fract() == 0.0 && value >= 0.0 && (value as usize) < count
            }
        }
    }

    /// The domain as a refusal's `allowed` text.
    pub fn describe(self) -> String {
        match self {
            Domain::Finite => "finite".into(),
            Domain::Range { min, max } => format!("{min}..={max}"),
            Domain::Switch => "0 or 1, hold keys".into(),
            Domain::Choice { count } => format!("an index 0..{count}, hold keys"),
        }
    }
}

/// A typed enum parameter, addressed by its option index.
pub trait ChoiceParam: Copy + PartialEq + 'static {
    const OPTIONS: &'static [Self];
}

impl ChoiceParam for BlurDimensions {
    const OPTIONS: &'static [Self] = &[
        Self::HorizontalAndVertical,
        Self::Horizontal,
        Self::Vertical,
    ];
}
impl ChoiceParam for RampShape {
    const OPTIONS: &'static [Self] = &[Self::Linear, Self::Radial];
}
impl ChoiceParam for WipeDirection {
    const OPTIONS: &'static [Self] = &[Self::Clockwise, Self::Counterclockwise, Self::Both];
}

/// A choice field seen through its index.
pub trait ChoiceSlot {
    fn index(&self) -> usize;
    fn count(&self) -> usize;
    fn set_index(&mut self, index: usize) -> bool;
}

impl<T: ChoiceParam> ChoiceSlot for T {
    fn index(&self) -> usize {
        T::OPTIONS.iter().position(|o| o == self).unwrap_or(0)
    }
    fn count(&self) -> usize {
        T::OPTIONS.len()
    }
    fn set_index(&mut self, index: usize) -> bool {
        match T::OPTIONS.get(index) {
            Some(option) => {
                *self = *option;
                true
            }
            None => false,
        }
    }
}

/// One parameter, borrowed from its effect.
pub enum Slot<'a> {
    Number(&'a mut f64, Domain),
    Switch(&'a mut bool),
    Choice(&'a mut dyn ChoiceSlot),
}

impl Slot<'_> {
    pub fn domain(&self) -> Domain {
        match self {
            Slot::Number(_, domain) => *domain,
            Slot::Switch(_) => Domain::Switch,
            Slot::Choice(choice) => Domain::Choice {
                count: choice.count(),
            },
        }
    }

    pub fn value(&self) -> f64 {
        match self {
            Slot::Number(value, _) => **value,
            Slot::Switch(on) => f64::from(u8::from(**on)),
            Slot::Choice(choice) => choice.index() as f64,
        }
    }

    /// Set from a keyframe value already checked against the domain.
    fn set(&mut self, value: f64) {
        match self {
            Slot::Number(slot, _) => **slot = value,
            Slot::Switch(slot) => **slot = value >= 0.5,
            Slot::Choice(choice) => {
                choice.set_index(value as usize);
            }
        }
    }
}

const UNIT: Domain = Domain::Range { min: 0.0, max: 1.0 };
const SIGNED_UNIT: Domain = Domain::Range {
    min: -1.0,
    max: 1.0,
};
const PIXELS: Domain = Domain::Range {
    min: 0.0,
    max: 1000.0,
};
const GAMMA: Domain = Domain::Range {
    min: 0.01,
    max: 10.0,
};

fn colour(prefix: &str, colour: &mut Rgba, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(&format!("{prefix}.r"), Slot::Number(&mut colour.r, UNIT));
    f(&format!("{prefix}.g"), Slot::Number(&mut colour.g, UNIT));
    f(&format!("{prefix}.b"), Slot::Number(&mut colour.b, UNIT));
    f(&format!("{prefix}.a"), Slot::Number(&mut colour.a, UNIT));
}

fn point(prefix: &str, p: &mut EffectPoint, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(
        &format!("{prefix}.x"),
        Slot::Number(&mut p.x, Domain::Finite),
    );
    f(
        &format!("{prefix}.y"),
        Slot::Number(&mut p.y, Domain::Finite),
    );
}

fn levels_channel(prefix: &str, c: &mut LevelsChannel, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(
        &format!("{prefix}.inputBlack"),
        Slot::Number(&mut c.input_black, UNIT),
    );
    f(
        &format!("{prefix}.inputWhite"),
        Slot::Number(&mut c.input_white, UNIT),
    );
    f(
        &format!("{prefix}.gamma"),
        Slot::Number(&mut c.gamma, GAMMA),
    );
    f(
        &format!("{prefix}.outputBlack"),
        Slot::Number(&mut c.output_black, UNIT),
    );
    f(
        &format!("{prefix}.outputWhite"),
        Slot::Number(&mut c.output_white, UNIT),
    );
}

fn curve(prefix: &str, points: &mut [CurvePoint], f: &mut dyn FnMut(&str, Slot<'_>)) {
    for (index, p) in points.iter_mut().enumerate() {
        f(&format!("{prefix}.{index}.x"), Slot::Number(&mut p.x, UNIT));
        f(&format!("{prefix}.{index}.y"), Slot::Number(&mut p.y, UNIT));
    }
}

impl Effect {
    /// The wire tag.
    pub fn name(&self) -> &'static str {
        match self {
            Effect::Fill(_) => "fill",
            Effect::Tint(_) => "tint",
            Effect::Levels(_) => "levels",
            Effect::Curves(_) => "curves",
            Effect::HueSaturation(_) => "hue-saturation",
            Effect::BrightnessContrast(_) => "brightness-contrast",
            Effect::Exposure(_) => "exposure",
            Effect::GaussianBlur(_) => "gaussian-blur",
            Effect::BoxBlur(_) => "box-blur",
            Effect::DirectionalBlur(_) => "directional-blur",
            Effect::Glow(_) => "glow",
            Effect::DropShadow(_) => "drop-shadow",
            Effect::GradientRamp(_) => "gradient-ramp",
            Effect::LinearWipe(_) => "linear-wipe",
            Effect::RadialWipe(_) => "radial-wipe",
            Effect::IrisWipe(_) => "iris-wipe",
        }
    }

    /// Whether the effect maps each pixel on its own, from its colour alone:
    /// no neighbours, no position, no growth.
    pub fn is_pointwise(&self) -> bool {
        matches!(
            self,
            Effect::Fill(_)
                | Effect::Tint(_)
                | Effect::Levels(_)
                | Effect::Curves(_)
                | Effect::HueSaturation(_)
                | Effect::BrightnessContrast(_)
                | Effect::Exposure(_)
        )
    }

    /// Every parameter, with its path below the effect and its domain: the
    /// one table keyframe validation, evaluation and the Editor read.
    pub fn visit(&mut self, f: &mut dyn FnMut(&str, Slot<'_>)) {
        match self {
            Effect::Fill(e) => {
                colour("color", &mut e.color, f);
                f("opacity", Slot::Number(&mut e.opacity, UNIT));
            }
            Effect::Tint(e) => {
                colour("mapBlackTo", &mut e.map_black_to, f);
                colour("mapWhiteTo", &mut e.map_white_to, f);
                f("amount", Slot::Number(&mut e.amount, UNIT));
            }
            Effect::Levels(e) => {
                levels_channel("rgb", &mut e.rgb, f);
                levels_channel("red", &mut e.red, f);
                levels_channel("green", &mut e.green, f);
                levels_channel("blue", &mut e.blue, f);
                levels_channel("alpha", &mut e.alpha, f);
                f(
                    "clipToOutputBlack",
                    Slot::Switch(&mut e.clip_to_output_black),
                );
                f(
                    "clipToOutputWhite",
                    Slot::Switch(&mut e.clip_to_output_white),
                );
            }
            Effect::Curves(e) => {
                curve("rgb", &mut e.rgb, f);
                curve("red", &mut e.red, f);
                curve("green", &mut e.green, f);
                curve("blue", &mut e.blue, f);
                curve("alpha", &mut e.alpha, f);
            }
            Effect::HueSaturation(e) => {
                f("hue", Slot::Number(&mut e.hue, Domain::Finite));
                f("saturation", Slot::Number(&mut e.saturation, SIGNED_UNIT));
                f("lightness", Slot::Number(&mut e.lightness, SIGNED_UNIT));
                f("colorize", Slot::Switch(&mut e.colorize));
                f(
                    "colorizeHue",
                    Slot::Number(&mut e.colorize_hue, Domain::Finite),
                );
                f(
                    "colorizeSaturation",
                    Slot::Number(&mut e.colorize_saturation, UNIT),
                );
                f(
                    "colorizeLightness",
                    Slot::Number(&mut e.colorize_lightness, SIGNED_UNIT),
                );
            }
            Effect::BrightnessContrast(e) => {
                f(
                    "brightness",
                    Slot::Number(
                        &mut e.brightness,
                        Domain::Range {
                            min: -1.5,
                            max: 1.5,
                        },
                    ),
                );
                f("contrast", Slot::Number(&mut e.contrast, SIGNED_UNIT));
                f("useLegacy", Slot::Switch(&mut e.use_legacy));
            }
            Effect::Exposure(e) => {
                f(
                    "exposure",
                    Slot::Number(
                        &mut e.exposure,
                        Domain::Range {
                            min: -20.0,
                            max: 20.0,
                        },
                    ),
                );
                f("offset", Slot::Number(&mut e.offset, SIGNED_UNIT));
                f(
                    "gammaCorrection",
                    Slot::Number(&mut e.gamma_correction, GAMMA),
                );
            }
            Effect::GaussianBlur(e) => {
                f("blurriness", Slot::Number(&mut e.blurriness, PIXELS));
                f("dimensions", Slot::Choice(&mut e.dimensions));
                f("repeatEdgePixels", Slot::Switch(&mut e.repeat_edge_pixels));
            }
            Effect::BoxBlur(e) => {
                f("radius", Slot::Number(&mut e.radius, PIXELS));
                f(
                    "iterations",
                    Slot::Number(
                        &mut e.iterations,
                        Domain::Range {
                            min: 1.0,
                            max: 50.0,
                        },
                    ),
                );
                f("dimensions", Slot::Choice(&mut e.dimensions));
                f("repeatEdgePixels", Slot::Switch(&mut e.repeat_edge_pixels));
            }
            Effect::DirectionalBlur(e) => {
                f("direction", Slot::Number(&mut e.direction, Domain::Finite));
                f("length", Slot::Number(&mut e.length, PIXELS));
            }
            Effect::Glow(e) => {
                f("threshold", Slot::Number(&mut e.threshold, UNIT));
                f("radius", Slot::Number(&mut e.radius, PIXELS));
                f(
                    "intensity",
                    Slot::Number(
                        &mut e.intensity,
                        Domain::Range {
                            min: 0.0,
                            max: 10.0,
                        },
                    ),
                );
                f("dimensions", Slot::Choice(&mut e.dimensions));
            }
            Effect::DropShadow(e) => {
                colour("color", &mut e.color, f);
                f("opacity", Slot::Number(&mut e.opacity, UNIT));
                f("direction", Slot::Number(&mut e.direction, Domain::Finite));
                f("distance", Slot::Number(&mut e.distance, PIXELS));
                f("softness", Slot::Number(&mut e.softness, PIXELS));
                f("shadowOnly", Slot::Switch(&mut e.shadow_only));
            }
            Effect::GradientRamp(e) => {
                point("start", &mut e.start, f);
                colour("startColor", &mut e.start_color, f);
                point("end", &mut e.end, f);
                colour("endColor", &mut e.end_color, f);
                f("shape", Slot::Choice(&mut e.shape));
                f(
                    "blendWithOriginal",
                    Slot::Number(&mut e.blend_with_original, UNIT),
                );
            }
            Effect::LinearWipe(e) => {
                f("completion", Slot::Number(&mut e.completion, UNIT));
                f("angle", Slot::Number(&mut e.angle, Domain::Finite));
                f("feather", Slot::Number(&mut e.feather, PIXELS));
            }
            Effect::RadialWipe(e) => {
                f("completion", Slot::Number(&mut e.completion, UNIT));
                f(
                    "startAngle",
                    Slot::Number(&mut e.start_angle, Domain::Finite),
                );
                point("center", &mut e.center, f);
                f("direction", Slot::Choice(&mut e.direction));
                f("feather", Slot::Number(&mut e.feather, PIXELS));
            }
            Effect::IrisWipe(e) => {
                point("center", &mut e.center, f);
                f(
                    "points",
                    Slot::Number(
                        &mut e.points,
                        Domain::Range {
                            min: 6.0,
                            max: 32.0,
                        },
                    ),
                );
                f(
                    "outerRadius",
                    Slot::Number(
                        &mut e.outer_radius,
                        Domain::Range {
                            min: 0.0,
                            max: 10000.0,
                        },
                    ),
                );
                f(
                    "innerRadius",
                    Slot::Number(
                        &mut e.inner_radius,
                        Domain::Range {
                            min: 0.0,
                            max: 10000.0,
                        },
                    ),
                );
                f("useInnerRadius", Slot::Switch(&mut e.use_inner_radius));
                f("rotation", Slot::Number(&mut e.rotation, Domain::Finite));
                f("feather", Slot::Number(&mut e.feather, PIXELS));
            }
        }
    }

    /// Every parameter path, in table order.
    pub fn parameter_paths(&self) -> Vec<String> {
        let mut copy = self.clone();
        let mut paths = Vec::new();
        copy.visit(&mut |path, _| paths.push(path.to_owned()));
        paths
    }
}

impl EffectInstance {
    /// Visit `enabled` and every parameter of the effect.
    pub fn visit(&mut self, f: &mut dyn FnMut(&str, Slot<'_>)) {
        f("enabled", Slot::Switch(&mut self.enabled));
        self.effect.visit(f);
    }

    /// A parameter's domain, or `None` if the path names nothing.
    pub fn domain(&self, path: &str) -> Option<Domain> {
        let mut copy = self.clone();
        let mut found = None;
        copy.visit(&mut |p, slot| {
            if p == path {
                found = Some(slot.domain());
            }
        });
        found
    }

    /// A parameter's current value, or `None` if the path names nothing.
    pub fn value(&self, path: &str) -> Option<f64> {
        let mut copy = self.clone();
        let mut found = None;
        copy.visit(&mut |p, slot| {
            if p == path {
                found = Some(slot.value());
            }
        });
        found
    }

    /// Set one parameter. The value must already be in the domain.
    pub fn set(&mut self, path: &str, value: f64) -> bool {
        let mut done = false;
        self.visit(&mut |p, mut slot| {
            if p == path && slot.domain().admits(value) {
                slot.set(value);
                done = true;
            }
        });
        done
    }
}

/// The channel prefix that addresses an effect parameter.
pub const EFFECT_PROPERTY_PREFIX: &str = "effects.";

/// Split `effects.<effectId>.<path>` into the effect id and the path.
pub fn split_effect_property(property: &str) -> Option<(&str, &str)> {
    let rest = property.strip_prefix(EFFECT_PROPERTY_PREFIX)?;
    let (id, path) = rest.split_once('.')?;
    (!id.is_empty() && !path.is_empty()).then_some((id, path))
}

/// Check one object's effect stack: unique non-empty ids, every parameter in
/// its domain, every curve with at least two points.
pub fn validate_effects(object: &str, effects: &[EffectInstance]) -> Result<(), Refusal> {
    let invalid = |effect_id: &str, detail: String| Refusal::EffectInvalid {
        object: object.into(),
        effect_id: effect_id.into(),
        detail,
    };
    let mut seen = std::collections::HashSet::new();
    for instance in effects {
        let id = instance.effect_id.as_str();
        if id.is_empty() || id.contains('.') {
            return Err(invalid(
                id,
                "effectId must be non-empty and contain no '.'".into(),
            ));
        }
        if !seen.insert(id) {
            return Err(invalid(id, "effectId is used twice on this object".into()));
        }
        if let Effect::Curves(c) = &instance.effect {
            for (name, points) in [
                ("rgb", &c.rgb),
                ("red", &c.red),
                ("green", &c.green),
                ("blue", &c.blue),
                ("alpha", &c.alpha),
            ] {
                if points.len() < 2 {
                    return Err(invalid(
                        id,
                        format!("curve {name} needs at least two points"),
                    ));
                }
            }
        }
        let mut copy = instance.clone();
        let mut bad = None;
        copy.visit(&mut |path, slot| {
            let (domain, value) = (slot.domain(), slot.value());
            if bad.is_none() && !domain.admits(value) {
                bad = Some(format!("{path} = {value} is outside {}", domain.describe()));
            }
        });
        if let Some(detail) = bad {
            return Err(invalid(id, detail));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_effect_round_trips_under_its_tag_with_typed_parameters() {
        let all = [
            Effect::Fill(Fill::default()),
            Effect::Tint(Tint::default()),
            Effect::Levels(Levels::default()),
            Effect::Curves(Curves::default()),
            Effect::HueSaturation(HueSaturation::default()),
            Effect::BrightnessContrast(BrightnessContrast::default()),
            Effect::Exposure(Exposure::default()),
            Effect::GaussianBlur(GaussianBlur::default()),
            Effect::BoxBlur(BoxBlur::default()),
            Effect::DirectionalBlur(DirectionalBlur::default()),
            Effect::Glow(Glow::default()),
            Effect::DropShadow(DropShadow::default()),
            Effect::GradientRamp(GradientRamp::default()),
            Effect::LinearWipe(LinearWipe::default()),
            Effect::RadialWipe(RadialWipe::default()),
            Effect::IrisWipe(IrisWipe::default()),
        ];
        assert_eq!(all.len(), 16, "the first broadcast set");
        for effect in all {
            let instance = EffectInstance::new("e", effect.clone());
            let wire = serde_json::to_value(&instance).unwrap();
            assert_eq!(wire["effect"], effect.name());
            assert_eq!(wire["effectId"], "e");
            let back: EffectInstance = serde_json::from_value(wire).unwrap();
            assert_eq!(back, instance);
            assert!(
                !effect.parameter_paths().is_empty(),
                "{} has parameters",
                effect.name()
            );
            assert!(
                validate_effects("o", &[instance]).is_ok(),
                "{} defaults are valid",
                effect.name()
            );
        }
    }

    #[test]
    fn an_unknown_effect_fails_to_parse_naming_it() {
        let error = serde_json::from_value::<EffectInstance>(serde_json::json!({
            "effectId": "x", "effect": "lens-flare"
        }))
        .unwrap_err()
        .to_string();
        assert!(error.contains("lens-flare"), "{error}");
    }

    #[test]
    fn parameters_are_addressed_through_the_typed_table() {
        let mut levels = EffectInstance::new("grade", Effect::Levels(Levels::default()));
        assert_eq!(levels.domain("rgb.gamma"), Some(GAMMA));
        assert_eq!(levels.domain("clipToOutputWhite"), Some(Domain::Switch));
        assert_eq!(levels.domain("enabled"), Some(Domain::Switch));
        assert_eq!(levels.domain("rgb.nope"), None);
        assert!(levels.set("rgb.gamma", 2.2));
        assert!(!levels.set("rgb.gamma", 0.0), "outside the domain");
        assert_eq!(levels.value("rgb.gamma"), Some(2.2));
        assert!(levels.set("clipToOutputWhite", 0.0));
        let Effect::Levels(l) = &levels.effect else {
            unreachable!()
        };
        assert_eq!(l.rgb.gamma, 2.2);
        assert!(!l.clip_to_output_white);

        let mut blur = EffectInstance::new("b", Effect::GaussianBlur(GaussianBlur::default()));
        assert_eq!(blur.domain("dimensions"), Some(Domain::Choice { count: 3 }));
        assert!(blur.set("dimensions", 2.0));
        assert!(!blur.set("dimensions", 3.0));
        let Effect::GaussianBlur(g) = &blur.effect else {
            unreachable!()
        };
        assert_eq!(g.dimensions, BlurDimensions::Vertical);

        let curves = EffectInstance::new("c", Effect::Curves(Curves::default()));
        assert_eq!(curves.domain("rgb.1.y"), Some(UNIT));
        assert_eq!(
            split_effect_property("effects.c.rgb.1.y"),
            Some(("c", "rgb.1.y"))
        );
        assert_eq!(split_effect_property("effects.c"), None);
        assert_eq!(split_effect_property("opacity"), None);
    }

    #[test]
    fn invalid_stacks_refuse_by_effect() {
        let a = EffectInstance::new("a", Effect::Tint(Tint::default()));
        assert!(matches!(validate_effects("o", &[a.clone(), a.clone()]),
            Err(Refusal::EffectInvalid { effect_id, .. }) if effect_id == "a"));
        let mut bad = a.clone();
        if let Effect::Tint(t) = &mut bad.effect {
            t.amount = 2.0;
        }
        assert!(
            matches!(validate_effects("o", &[bad]), Err(Refusal::EffectInvalid { detail, .. }) if detail.contains("amount"))
        );
        let mut short = EffectInstance::new("c", Effect::Curves(Curves::default()));
        if let Effect::Curves(c) = &mut short.effect {
            c.red.pop();
        }
        assert!(validate_effects("o", &[short]).is_err());
        assert!(validate_effects(
            "o",
            &[EffectInstance::new("a.b", Effect::Tint(Tint::default()))]
        )
        .is_err());
    }
}
