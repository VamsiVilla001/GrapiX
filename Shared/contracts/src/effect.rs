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
    /// Mask Reference (3.28): the ids of masks of the same object that limit
    /// this effect. The effect shows only where they cover, the rest of the
    /// layer keeps what it was before this effect. Absent or empty: the whole
    /// layer. A referenced mask counts even in mode `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mask_ids: Option<Vec<String>>,
    #[serde(flatten)]
    pub effect: Effect,
}

impl EffectInstance {
    pub fn new(effect_id: impl Into<String>, effect: Effect) -> Self {
        Self {
            effect_id: effect_id.into(),
            enabled: true,
            mask_ids: None,
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
    Invert(Invert),
    Posterize(Posterize),
    Threshold(Threshold),
    Vibrance(Vibrance),
    Tritone(Tritone),
    ChannelMixer(ChannelMixer),
    ColorBalance(ColorBalance),
    GammaPedestalGain(GammaPedestalGain),
    ColorBalanceHls(ColorBalanceHls),
    BlackWhite(BlackWhite),
    PhotoFilter(PhotoFilter),
    LeaveColor(LeaveColor),
    VideoLimiter(VideoLimiter),
    BroadcastColors(BroadcastColors),
    CcToner(CcToner),
    CcColorOffset(CcColorOffset),
    CcThreshold(CcThreshold),
    CcThresholdRgb(CcThresholdRgb),
    ChangeColor(ChangeColor),
    ShiftChannels(ShiftChannels),
    LinearColorKey(LinearColorKey),
    RemoveColorMatting(RemoveColorMatting),
    Extract(Extract),
    CcColorNeutralizer(CcColorNeutralizer),
    Unmult(Unmult),
    SpillSuppressor(SpillSuppressor),
    ColorRange(ColorRange),
    Arithmetic(Arithmetic),
    ColorDifferenceKey(ColorDifferenceKey),
    SelectiveColor(SelectiveColor),
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

/// Which channels Invert flips.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum InvertChannel {
    #[default]
    Rgb,
    Red,
    Green,
    Blue,
}

/// Invert: `1 - v` on the chosen channels, blended back toward the original.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Invert {
    pub channel: InvertChannel,
    /// 0–1: how much of the original comes back; 0 is a full inversion.
    pub blend_with_original: f64,
}

/// Posterize: each colour channel snaps to `level` evenly spaced values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Posterize {
    /// 2–255, rounded.
    pub level: f64,
}

/// Threshold: pixels at or above `level` luminance become white, the rest black.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Threshold {
    /// 0–1, on Rec. 709 luminance.
    pub level: f64,
}

/// Vibrance: saturation weighted `(1 - s) * min(s, 0.5)`: a grey and a fully
/// saturated colour are left alone, and a half-saturated one gains most.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Vibrance {
    /// -1–1, weighted toward low-saturation pixels.
    pub vibrance: f64,
    /// -1–1, applied evenly.
    pub saturation: f64,
}

/// Tritone: luminance maps to a ramp shadows, midtones, highlights; `blend_with_original`
/// brings the original colour back. The colours' alpha is not used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Tritone {
    pub highlights: Rgba,
    pub midtones: Rgba,
    pub shadows: Rgba,
    /// 0-1: how much of the original comes back; 0 is the full ramp.
    pub blend_with_original: f64,
}

/// One output channel's mix: how much of each input channel it takes, plus a constant.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerRow {
    /// -2-2 each, 1 is the whole channel.
    pub red: f64,
    pub green: f64,
    pub blue: f64,
    /// -2-2, added after the mix.
    pub constant: f64,
}

/// Channel Mixer: each output channel is a weighted sum of the input channels. With
/// `monochrome` the red row drives all three.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelMixer {
    pub red: MixerRow,
    pub green: MixerRow,
    pub blue: MixerRow,
    pub monochrome: bool,
}

/// A colour shift for one tonal range, -1-1 per channel.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorShift {
    pub red: f64,
    pub green: f64,
    pub blue: f64,
}

/// Color Balance: shifts the shadows, midtones and highlights (by luminance) toward a colour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorBalance {
    pub shadows: ColorShift,
    pub midtones: ColorShift,
    pub highlights: ColorShift,
    /// Keep each pixel's luminance and change only its colour.
    pub preserve_luminosity: bool,
}

/// One channel of Gamma/Pedestal/Gain: `pedestal + (gain - pedestal) * v^gamma`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct GammaChannel {
    /// 0.01-10; 1 is linear.
    pub gamma: f64,
    /// -1-1, the value black maps to.
    pub pedestal: f64,
    /// 0-10, the value white maps to.
    pub gain: f64,
}

/// Gamma/Pedestal/Gain, per colour channel, with a Black Stretch that lifts low values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct GammaPedestalGain {
    pub red: GammaChannel,
    pub green: GammaChannel,
    pub blue: GammaChannel,
    /// 0-10: lifts the dark end of every channel; 0 is off.
    pub black_stretch: f64,
}

/// Color Balance (HLS): shifts hue, lightness and saturation of every pixel. Lightness and
/// saturation move a share of the way to the extreme (or to zero); hue wraps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorBalanceHls {
    /// Degrees.
    pub hue: f64,
    /// -1-1.
    pub lightness: f64,
    /// -1-1.
    pub saturation: f64,
}

/// Black & White: a greyscale whose brightness per hue is set by six weights (red, yellow,
/// green, cyan, blue, magenta, interpolated round the wheel), optionally tinted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct BlackWhite {
    /// -2-3 each; 0.5 leaves the luminance alone, more brightens that hue, less darkens it.
    pub reds: f64,
    pub yellows: f64,
    pub greens: f64,
    pub cyans: f64,
    pub blues: f64,
    pub magentas: f64,
    /// Colour the greyscale with the hue and saturation of `tint_color`.
    pub tint: bool,
    pub tint_color: Rgba,
}

/// The camera and colour filters Photo Filter offers. `Custom` uses the effect's own colour.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum PhotoFilterPreset {
    #[default]
    #[serde(rename = "warming-85")]
    Warming85,
    WarmingLba,
    #[serde(rename = "warming-81")]
    Warming81,
    #[serde(rename = "cooling-80")]
    Cooling80,
    CoolingLbb,
    #[serde(rename = "cooling-82")]
    Cooling82,
    Red,
    Orange,
    Yellow,
    Green,
    Cyan,
    Blue,
    Violet,
    Magenta,
    Sepia,
    DeepRed,
    DeepBlue,
    DeepEmerald,
    DeepYellow,
    Underwater,
    Custom,
}

impl PhotoFilterPreset {
    /// The filter's 8-bit sRGB colour; `None` for `Custom`.
    pub const fn srgb8(self) -> Option<[u8; 3]> {
        Some(match self {
            Self::Warming85 => [240, 140, 30],
            Self::WarmingLba => [245, 155, 25],
            Self::Warming81 => [240, 180, 40],
            Self::Cooling80 => [20, 110, 250],
            Self::CoolingLbb => [20, 95, 245],
            Self::Cooling82 => [30, 180, 250],
            Self::Red => [230, 30, 30],
            Self::Orange => [240, 130, 30],
            Self::Yellow => [245, 225, 35],
            Self::Green => [30, 200, 30],
            Self::Cyan => [30, 200, 230],
            Self::Blue => [30, 55, 230],
            Self::Violet => [150, 30, 230],
            Self::Magenta => [225, 30, 225],
            Self::Sepia => [170, 120, 55],
            Self::DeepRed => [250, 0, 0],
            Self::DeepBlue => [0, 40, 200],
            Self::DeepEmerald => [0, 135, 0],
            Self::DeepYellow => [255, 210, 0],
            Self::Underwater => [0, 190, 175],
            Self::Custom => return None,
        })
    }
}

/// Photo Filter: multiplies the picture by a filter colour, `density` of the way, optionally
/// keeping the pixel's luminance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct PhotoFilter {
    pub filter: PhotoFilterPreset,
    /// Used when `filter` is `custom`.
    pub color: Rgba,
    /// 0-1.
    pub density: f64,
    pub preserve_luminosity: bool,
}

/// How Leave Color decides a pixel is the colour to keep.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum LeaveMatch {
    /// Distance in RGB.
    #[default]
    Rgb,
    /// Distance in hue only (greys match no hue).
    Hue,
}

/// Leave Color: greys everything but one colour. `tolerance` is how far a pixel may be from it and
/// keep its colour; `edge_softness` fades the rest in over that much more.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct LeaveColor {
    /// 0-1: how much of the greying is applied; 0 leaves the picture alone.
    pub amount: f64,
    pub color: Rgba,
    /// 0-1.
    pub tolerance: f64,
    /// 0-1.
    pub edge_softness: f64,
    pub match_colors: LeaveMatch,
}

/// The level Video Limiter clips to, as a share of white.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
pub enum LimiterLevel {
    #[serde(rename = "90")]
    P90,
    #[serde(rename = "95")]
    P95,
    #[default]
    #[serde(rename = "100")]
    P100,
    #[serde(rename = "105")]
    P105,
    #[serde(rename = "109")]
    P109,
}

impl LimiterLevel {
    /// The level as a fraction of white.
    pub const fn fraction(self) -> f64 {
        match self {
            Self::P90 => 0.90,
            Self::P95 => 0.95,
            Self::P100 => 1.00,
            Self::P105 => 1.05,
            Self::P109 => 1.09,
        }
    }
}

/// What Video Limiter limits: brightness, colour, or both.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum LimiterMethod {
    /// Compress the luminance, keep each channel's offset from it.
    Luma,
    /// Pull the colour towards its luminance until every channel fits.
    Chroma,
    /// Both, luminance first.
    #[default]
    SmartLimit,
}

/// How far below the clip level the soft knee starts.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
pub enum LimiterCompression {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "3")]
    P3,
    #[default]
    #[serde(rename = "5")]
    P5,
    #[serde(rename = "10")]
    P10,
    #[serde(rename = "20")]
    P20,
}

impl LimiterCompression {
    /// The knee's share of the clip level.
    pub const fn fraction(self) -> f64 {
        match self {
            Self::None => 0.0,
            Self::P3 => 0.03,
            Self::P5 => 0.05,
            Self::P10 => 0.10,
            Self::P20 => 0.20,
        }
    }
}

/// Video Limiter: keeps every pixel inside a legal range, softly bending the highlights first;
/// optionally paints the pixels it had to change in a warning colour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoLimiter {
    pub clip_level: LimiterLevel,
    pub clip_method: LimiterMethod,
    pub compression_before_clipping: LimiterCompression,
    pub gamut_warning: bool,
    pub gamut_warning_color: Rgba,
}

/// The broadcast standard Broadcast Colors measures against.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum BroadcastLocale {
    /// NTSC: 7.5 IRE setup, chroma as I and Q.
    #[default]
    Ntsc,
    /// PAL: no setup, chroma as U and V.
    Pal,
}

/// What Broadcast Colors does to a colour whose signal is too high.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum BroadcastAction {
    /// Scale the whole colour down.
    #[default]
    ReduceLuminance,
    /// Pull the colour towards grey until it fits.
    ReduceSaturation,
    /// Make the unsafe pixels transparent.
    KeyOutUnsafe,
    /// Make the safe pixels transparent.
    KeyOutSafe,
}

/// How many colours CC Toner maps the tones of the picture to.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum TonerTones {
    /// Shadows and highlights.
    Duotone,
    /// Shadows, midtones and highlights.
    #[default]
    Tritone,
    /// Shadows, darktones, midtones, brights and highlights.
    Pentone,
}

/// CC Toner: maps the luminance of each pixel onto two, three or five colours, `blend` of the way
/// back to the original.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct CcToner {
    pub tones: TonerTones,
    pub highlights: Rgba,
    pub brights: Rgba,
    pub midtones: Rgba,
    pub darktones: Rgba,
    pub shadows: Rgba,
    /// 0-1: how much of the original comes back.
    pub blend: f64,
}

/// What CC Color Offset does with a channel pushed past white.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ColorOverflow {
    /// Start again from black.
    #[default]
    Wrap,
    /// Fold back down from white.
    Solarize,
    /// Snap to black or white.
    Polarize,
}

/// CC Color Offset: adds a phase to each channel (a full turn is the whole range), so a colour
/// cycles through the range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct CcColorOffset {
    /// Degrees: 360 is a whole turn of the range.
    pub red_phase: f64,
    pub green_phase: f64,
    pub blue_phase: f64,
    pub overflow: ColorOverflow,
}

/// What CC Threshold compares with the level.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ThresholdChannel {
    #[default]
    Luminance,
    /// Each of red, green and blue on its own.
    Rgb,
    Saturation,
    /// The coverage: the result is hard-edged.
    Alpha,
}

/// CC Threshold: black and white by whether the chosen channel reaches the level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct CcThreshold {
    /// 0-255, as the level is set on an 8-bit picture.
    pub threshold: f64,
    pub channel: ThresholdChannel,
    pub invert: bool,
    /// 0-1: how much of the original comes back.
    pub blend: f64,
}

/// CC Threshold RGB: each of red, green and blue made 0 or 1 at its own level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct CcThresholdRgb {
    /// 0-255 each.
    pub red_threshold: f64,
    pub green_threshold: f64,
    pub blue_threshold: f64,
    pub invert_red: bool,
    pub invert_green: bool,
    pub invert_blue: bool,
    /// 0-1: how much of the original comes back.
    pub blend: f64,
}

/// What Change Color shows.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeColorView {
    /// The picture with the change applied.
    #[default]
    CorrectedLayer,
    /// The matte of what matches, white on black.
    ColorCorrectionMask,
}

/// How Change Color decides a pixel is the colour to change.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeMatch {
    /// Distance in RGB.
    Rgb,
    /// Distance in hue only (greys match no hue).
    #[default]
    Hue,
    /// Distance in chromaticity, whatever the brightness.
    Chroma,
}

/// Change Color: shifts the hue, lightness and saturation of the pixels that match one colour,
/// softly at the edge of the match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeColor {
    pub view: ChangeColorView,
    /// Degrees; hue wraps.
    pub hue_transform: f64,
    /// -1-1: a share of the way to white (or to black).
    pub lightness_transform: f64,
    /// -1-1: a share of the way to full (or no) saturation.
    pub saturation_transform: f64,
    pub color_to_change: Rgba,
    /// 0-1: how far from the colour a pixel may be and still match fully.
    pub matching_tolerance: f64,
    /// 0-1: the fade from a full match to none, past the tolerance.
    pub matching_softness: f64,
    pub match_colors: ChangeMatch,
    /// Change everything but the match.
    pub invert_mask: bool,
}

/// Where Shift Channels takes a channel's value from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ChannelSource {
    Alpha,
    Red,
    Green,
    Blue,
    Luminance,
    Hue,
    Lightness,
    Saturation,
    FullOn,
    HalfOn,
    FullOff,
}

/// Shift Channels: each of alpha, red, green and blue takes its value from any channel of the
/// pixel (or a constant). The defaults take each from itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ShiftChannels {
    pub take_alpha_from: ChannelSource,
    pub take_red_from: ChannelSource,
    pub take_green_from: ChannelSource,
    pub take_blue_from: ChannelSource,
}

/// What a keyer shows.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum KeyView {
    /// The picture with the key applied.
    #[default]
    FinalOutput,
    /// The picture as it came in.
    SourceOnly,
    /// The matte: white where the picture is kept, on opaque black.
    MatteOnly,
}

/// How Linear Color Key measures how far a pixel is from the key colour.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum KeyMatch {
    #[default]
    Rgb,
    Hue,
    Chroma,
}

/// Which side of the key Linear Color Key makes transparent.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum KeyOperation {
    /// The colours that match go transparent.
    #[default]
    KeyColors,
    /// Only the colours that match stay.
    KeepColors,
}

/// Linear Color Key: makes the pixels near one colour transparent (or keeps only them), fading
/// over the softness past the tolerance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct LinearColorKey {
    pub view: KeyView,
    pub key_color: Rgba,
    pub match_colors: KeyMatch,
    /// 0-1: how far from the key a pixel may be and still be keyed out fully.
    pub tolerance: f64,
    /// 0-1: the fade past the tolerance.
    pub softness: f64,
    pub key_operation: KeyOperation,
}

/// What Arithmetic does to each colour channel with the value set for that channel.
///
/// And, Or and Xor work on the 8-bit values of the channel and the setting (0 to 255), as After
/// Effects does; the rest work on the values themselves, so a pixel above 1 stays above 1.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ArithmeticOperator {
    And,
    Or,
    Xor,
    #[default]
    Add,
    Subtract,
    Difference,
    Min,
    Max,
    /// A channel above the value goes to 0; one at or below it stays.
    BlockAbove,
    /// A channel below the value goes to 0; one at or above it stays.
    BlockBelow,
    /// 1 where the channel reaches the value, 0 where it does not.
    Slice,
    Multiply,
    Screen,
}

/// Arithmetic: combines each colour channel with a value of your choice, on the colour as it was
/// before its alpha. Alpha is left alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Arithmetic {
    pub operator: ArithmeticOperator,
    /// 0-255 on each channel.
    pub red_value: f64,
    pub green_value: f64,
    pub blue_value: f64,
    /// Keep every result between 0 and 1. Off, results may go above 1 but never below 0.
    pub clip: bool,
}

/// Which stage of Color Difference Key Color Difference Key shows. (EffectCraft also has a
/// four-up view; it needs each pixel's position, so it comes with the coordinate pass.)
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ColorDiffView {
    /// The picture as it came in.
    Source,
    UncorrectedMatteA,
    CorrectedMatteA,
    UncorrectedMatteB,
    CorrectedMatteB,
    UncorrectedMatte,
    CorrectedMatte,
    /// The picture with the key applied.
    #[default]
    FinalOutput,
}

/// How exactly Color Difference Key measures colour: on the values as they are, or on light.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum MatchAccuracy {
    #[default]
    Faster,
    MoreAccurate,
}

/// A levels control on a matte: input black and white and output black and white on a 0 to 255
/// scale, and a gamma.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct MatteLevels {
    pub in_black: f64,
    pub in_white: f64,
    /// 0.01-10; 1 is linear.
    pub gamma: f64,
    pub out_black: f64,
    pub out_white: f64,
}

/// Color Difference Key: the difference between the key colour's strongest channel and each of
/// the other two is a partial matte (A against the first other channel, B against the second);
/// the larger of the two, after their own levels, is the matte, which has levels of its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorDifferenceKey {
    pub view: ColorDiffView,
    pub key_color: Rgba,
    pub color_matching_accuracy: MatchAccuracy,
    pub partial_a: MatteLevels,
    pub partial_b: MatteLevels,
    /// The matte's own levels (its output stays 0 to 255): input black and white, and gamma.
    pub matte_black: f64,
    pub matte_white: f64,
    pub matte_gamma: f64,
}

/// How Selective Color reads its adjustments: a share of the ink a pixel already has
/// (Relative), or a flat amount (Absolute).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum SelectiveMethod {
    #[default]
    Relative,
    Absolute,
}

/// One colour range's adjustment in print inks, -1 to 1 each (-100% to 100%). Positive adds the
/// ink, negative removes it. `black` moves all three colour channels together.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct InkShift {
    pub cyan: f64,
    pub magenta: f64,
    pub yellow: f64,
    pub black: f64,
}

/// Selective Color: changes the amount of cyan, magenta, yellow and black ink in one range of
/// colours without touching the others. A pixel belongs to the primary and secondary range its
/// hue falls in, to whites by how light its darkest channel is, to blacks by how dark its
/// lightest channel is, and to neutrals by how close it sits to mid grey; the ranges' shifts are
/// summed by those weights.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct SelectiveColor {
    pub method: SelectiveMethod,
    pub reds: InkShift,
    pub yellows: InkShift,
    pub greens: InkShift,
    pub cyans: InkShift,
    pub blues: InkShift,
    pub magentas: InkShift,
    pub whites: InkShift,
    pub neutrals: InkShift,
    pub blacks: InkShift,
}

/// The colour space Color Range measures a pixel in. Lab is the default.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum RangeSpace {
    /// CIE Lab, scaled so L runs 0 to 255 and a and b are centred on 128.
    #[default]
    Lab,
    /// Y, U and V, with U and V centred on 128.
    Yuv,
    /// Red, green and blue, 0 to 255.
    Rgb,
}

/// Color Range: keys out every pixel inside a box in a colour space, fading over the fuzziness
/// past the box. All bounds are on the 0 to 255 scale of the space chosen, whose three axes are
/// named L, a, b for Lab; Y, U, V for YUV; and R, G, B for RGB.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorRange {
    /// 0-255: the fade past the box, in the same units. 0 is a hard edge.
    pub fuzziness: f64,
    pub color_space: RangeSpace,
    /// The box's lower and upper bound on the first axis (L, Y or R).
    pub min_l: f64,
    pub max_l: f64,
    /// On the second axis (a, U or G).
    pub min_a: f64,
    pub max_a: f64,
    /// On the third axis (b, V or B).
    pub min_b: f64,
    pub max_b: f64,
}

/// Remove Color Matting: takes a background colour back out of a picture that was matted against
/// it, so its edges stop carrying a halo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoveColorMatting {
    pub background_color: Rgba,
    /// Keep every channel at or under the alpha.
    pub clip_hdr: bool,
}

/// What Extract measures.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum ExtractChannel {
    #[default]
    Luminance,
    Red,
    Green,
    Blue,
    Alpha,
}

/// Extract: keeps the pixels whose chosen channel lies between the black and white points (0 to
/// 255) and fades the rest over the softness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Extract {
    pub channel: ExtractChannel,
    pub black_point: f64,
    pub white_point: f64,
    /// 0-255: the fade below the black point.
    pub black_softness: f64,
    /// 0-255: the fade above the white point.
    pub white_softness: f64,
    pub invert: bool,
}

/// CC Color Neutralizer: moves the shadows, midtones and highlights each by the difference between
/// a balance colour and an unbalance colour (the cast to take out and the colour it should be).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct CcColorNeutralizer {
    pub shadows_unbalance: Rgba,
    pub shadows_balance: Rgba,
    pub midtones_unbalance: Rgba,
    pub midtones_balance: Rgba,
    pub highlights_unbalance: Rgba,
    pub highlights_balance: Rgba,
    /// 0-1: keeps pure black and pure white where they are.
    pub pinning: f64,
    /// 0-1: how much of the original comes back.
    pub blend_with_original: f64,
    /// -1 to 1.
    pub darks: f64,
    pub brights: f64,
    pub contrast: f64,
}

/// The colour Unmult takes out of the picture.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum UnmultBackground {
    #[default]
    Black,
    White,
}

/// Unmult: turns the distance from a black or white background into coverage, and (by default)
/// takes the background back out of the colour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Unmult {
    pub background: UnmultBackground,
    /// 0-1: how bright a pixel on a black background has to be to start to show.
    pub black_level: f64,
    /// 0-1: how far from white a pixel on a white background has to be to start to show.
    pub white_level: f64,
    /// 0-1: the ramp from clear to solid.
    pub softness: f64,
    pub remove_color_matting: bool,
    pub clip_hdr: bool,
}

/// How exactly Spill Suppressor finds the spill.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum SpillAccuracy {
    /// The key's strongest channel is held to the larger of the other two.
    #[default]
    Faster,
    /// The part of each pixel that points along the key's colour is removed.
    Better,
}

/// Spill Suppressor: takes the cast of a keyed screen's colour out of the picture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct SpillSuppressor {
    pub color_to_suppress: Rgba,
    pub color_accuracy: SpillAccuracy,
    /// 0-2: how much of the spill goes.
    pub suppression: f64,
}

/// Broadcast Colors: finds colours whose luma plus chroma goes over the maximum signal
/// amplitude of the chosen standard, and reduces or keys them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct BroadcastColors {
    pub locale: BroadcastLocale,
    pub how_to_make_safe: BroadcastAction,
    /// IRE, 90-120.
    pub max_signal: f64,
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
impl Default for Invert {
    fn default() -> Self {
        Self {
            channel: InvertChannel::default(),
            blend_with_original: 0.0,
        }
    }
}
impl Default for Posterize {
    fn default() -> Self {
        Self { level: 6.0 }
    }
}
impl Default for Threshold {
    fn default() -> Self {
        Self { level: 0.5 }
    }
}
impl Default for Vibrance {
    fn default() -> Self {
        Self {
            vibrance: 0.0,
            saturation: 0.0,
        }
    }
}
impl Default for Tritone {
    fn default() -> Self {
        Self {
            highlights: srgb(1.0, 1.0, 1.0),
            midtones: srgb(0.5, 0.5, 0.5),
            shadows: srgb(0.0, 0.0, 0.0),
            blend_with_original: 0.0,
        }
    }
}
impl Default for MixerRow {
    fn default() -> Self {
        Self {
            red: 0.0,
            green: 0.0,
            blue: 0.0,
            constant: 0.0,
        }
    }
}
impl Default for ChannelMixer {
    fn default() -> Self {
        Self {
            red: MixerRow {
                red: 1.0,
                ..MixerRow::default()
            },
            green: MixerRow {
                green: 1.0,
                ..MixerRow::default()
            },
            blue: MixerRow {
                blue: 1.0,
                ..MixerRow::default()
            },
            monochrome: false,
        }
    }
}
impl Default for ColorShift {
    fn default() -> Self {
        Self {
            red: 0.0,
            green: 0.0,
            blue: 0.0,
        }
    }
}
impl Default for ColorBalance {
    fn default() -> Self {
        Self {
            shadows: ColorShift::default(),
            midtones: ColorShift::default(),
            highlights: ColorShift::default(),
            preserve_luminosity: true,
        }
    }
}
impl Default for GammaChannel {
    fn default() -> Self {
        Self {
            gamma: 1.0,
            pedestal: 0.0,
            gain: 1.0,
        }
    }
}
impl Default for GammaPedestalGain {
    fn default() -> Self {
        Self {
            red: GammaChannel::default(),
            green: GammaChannel::default(),
            blue: GammaChannel::default(),
            black_stretch: 0.0,
        }
    }
}
impl Default for ColorBalanceHls {
    fn default() -> Self {
        Self {
            hue: 0.0,
            lightness: 0.0,
            saturation: 0.0,
        }
    }
}
impl Default for BlackWhite {
    fn default() -> Self {
        Self {
            reds: 0.4,
            yellows: 0.6,
            greens: 0.4,
            cyans: 0.6,
            blues: 0.2,
            magentas: 0.8,
            tint: false,
            tint_color: srgb(0.88, 0.76, 0.6),
        }
    }
}
impl Default for PhotoFilter {
    fn default() -> Self {
        Self {
            filter: PhotoFilterPreset::default(),
            color: srgb(0.93, 0.54, 0.09),
            density: 0.25,
            preserve_luminosity: true,
        }
    }
}
impl Default for LeaveColor {
    fn default() -> Self {
        Self {
            amount: 0.0,
            color: srgb(1.0, 0.0, 0.0),
            tolerance: 0.15,
            edge_softness: 0.0,
            match_colors: LeaveMatch::default(),
        }
    }
}
impl Default for VideoLimiter {
    fn default() -> Self {
        Self {
            clip_level: LimiterLevel::default(),
            clip_method: LimiterMethod::default(),
            compression_before_clipping: LimiterCompression::default(),
            gamut_warning: false,
            gamut_warning_color: srgb(1.0, 0.0, 0.0),
        }
    }
}
impl Default for BroadcastColors {
    fn default() -> Self {
        Self {
            locale: BroadcastLocale::default(),
            how_to_make_safe: BroadcastAction::default(),
            max_signal: 110.0,
        }
    }
}
impl Default for CcToner {
    fn default() -> Self {
        Self {
            tones: TonerTones::default(),
            highlights: srgb(1.0, 1.0, 1.0),
            brights: srgb(0.86, 0.78, 0.64),
            midtones: srgb(0.55, 0.43, 0.28),
            darktones: srgb(0.26, 0.18, 0.1),
            shadows: srgb(0.0, 0.0, 0.0),
            blend: 0.0,
        }
    }
}
impl Default for CcColorOffset {
    fn default() -> Self {
        Self {
            red_phase: 0.0,
            green_phase: 0.0,
            blue_phase: 0.0,
            overflow: ColorOverflow::default(),
        }
    }
}
impl Default for CcThreshold {
    fn default() -> Self {
        Self {
            threshold: 127.0,
            channel: ThresholdChannel::default(),
            invert: false,
            blend: 0.0,
        }
    }
}
impl Default for CcThresholdRgb {
    fn default() -> Self {
        Self {
            red_threshold: 127.0,
            green_threshold: 127.0,
            blue_threshold: 127.0,
            invert_red: false,
            invert_green: false,
            invert_blue: false,
            blend: 0.0,
        }
    }
}
impl Default for ChangeColor {
    fn default() -> Self {
        Self {
            view: ChangeColorView::default(),
            hue_transform: 0.0,
            lightness_transform: 0.0,
            saturation_transform: 0.0,
            color_to_change: srgb(0.8, 0.2, 0.2),
            matching_tolerance: 0.15,
            matching_softness: 0.0,
            match_colors: ChangeMatch::default(),
            invert_mask: false,
        }
    }
}
impl Default for ShiftChannels {
    fn default() -> Self {
        Self {
            take_alpha_from: ChannelSource::Alpha,
            take_red_from: ChannelSource::Red,
            take_green_from: ChannelSource::Green,
            take_blue_from: ChannelSource::Blue,
        }
    }
}
impl Default for Arithmetic {
    fn default() -> Self {
        Self {
            operator: ArithmeticOperator::default(),
            red_value: 0.0,
            green_value: 0.0,
            blue_value: 0.0,
            clip: true,
        }
    }
}
impl Default for MatteLevels {
    fn default() -> Self {
        Self {
            in_black: 0.0,
            in_white: 255.0,
            gamma: 1.0,
            out_black: 0.0,
            out_white: 255.0,
        }
    }
}
impl Default for ColorDifferenceKey {
    fn default() -> Self {
        Self {
            view: ColorDiffView::default(),
            key_color: srgb(0.0, 0.0, 1.0),
            color_matching_accuracy: MatchAccuracy::default(),
            partial_a: MatteLevels::default(),
            partial_b: MatteLevels::default(),
            matte_black: 0.0,
            matte_white: 255.0,
            matte_gamma: 1.0,
        }
    }
}
impl Default for InkShift {
    fn default() -> Self {
        Self {
            cyan: 0.0,
            magenta: 0.0,
            yellow: 0.0,
            black: 0.0,
        }
    }
}
impl Default for ColorRange {
    fn default() -> Self {
        Self {
            fuzziness: 0.0,
            color_space: RangeSpace::default(),
            min_l: 0.0,
            max_l: 255.0,
            min_a: 0.0,
            max_a: 100.0,
            min_b: 128.0,
            max_b: 255.0,
        }
    }
}
impl Default for LinearColorKey {
    fn default() -> Self {
        Self {
            view: KeyView::default(),
            key_color: srgb(0.0, 0.0, 1.0),
            match_colors: KeyMatch::default(),
            tolerance: 0.10,
            softness: 0.10,
            key_operation: KeyOperation::default(),
        }
    }
}
impl Default for RemoveColorMatting {
    fn default() -> Self {
        Self {
            background_color: srgb(0.0, 0.0, 0.0),
            clip_hdr: true,
        }
    }
}
impl Default for Extract {
    fn default() -> Self {
        Self {
            channel: ExtractChannel::default(),
            black_point: 0.0,
            white_point: 255.0,
            black_softness: 0.0,
            white_softness: 0.0,
            invert: false,
        }
    }
}
impl Default for CcColorNeutralizer {
    fn default() -> Self {
        Self {
            shadows_unbalance: srgb(0.0, 0.0, 0.0),
            shadows_balance: srgb(0.0, 0.0, 0.0),
            midtones_unbalance: srgb(0.5, 0.5, 0.5),
            midtones_balance: srgb(0.5, 0.5, 0.5),
            highlights_unbalance: srgb(1.0, 1.0, 1.0),
            highlights_balance: srgb(1.0, 1.0, 1.0),
            pinning: 0.0,
            blend_with_original: 0.0,
            darks: 0.0,
            brights: 0.0,
            contrast: 0.0,
        }
    }
}
impl Default for Unmult {
    fn default() -> Self {
        Self {
            background: UnmultBackground::default(),
            black_level: 0.0,
            white_level: 1.0,
            softness: 1.0,
            remove_color_matting: true,
            clip_hdr: true,
        }
    }
}
impl Default for SpillSuppressor {
    fn default() -> Self {
        Self {
            color_to_suppress: srgb(0.0, 0.0, 1.0),
            color_accuracy: SpillAccuracy::default(),
            suppression: 1.0,
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
impl ChoiceParam for InvertChannel {
    const OPTIONS: &'static [Self] = &[Self::Rgb, Self::Red, Self::Green, Self::Blue];
}
impl ChoiceParam for PhotoFilterPreset {
    const OPTIONS: &'static [Self] = &[
        Self::Warming85,
        Self::WarmingLba,
        Self::Warming81,
        Self::Cooling80,
        Self::CoolingLbb,
        Self::Cooling82,
        Self::Red,
        Self::Orange,
        Self::Yellow,
        Self::Green,
        Self::Cyan,
        Self::Blue,
        Self::Violet,
        Self::Magenta,
        Self::Sepia,
        Self::DeepRed,
        Self::DeepBlue,
        Self::DeepEmerald,
        Self::DeepYellow,
        Self::Underwater,
        Self::Custom,
    ];
}
impl ChoiceParam for LeaveMatch {
    const OPTIONS: &'static [Self] = &[Self::Rgb, Self::Hue];
}
impl ChoiceParam for LimiterLevel {
    const OPTIONS: &'static [Self] = &[Self::P90, Self::P95, Self::P100, Self::P105, Self::P109];
}
impl ChoiceParam for LimiterMethod {
    const OPTIONS: &'static [Self] = &[Self::Luma, Self::Chroma, Self::SmartLimit];
}
impl ChoiceParam for LimiterCompression {
    const OPTIONS: &'static [Self] = &[Self::None, Self::P3, Self::P5, Self::P10, Self::P20];
}
impl ChoiceParam for BroadcastLocale {
    const OPTIONS: &'static [Self] = &[Self::Ntsc, Self::Pal];
}
impl ChoiceParam for BroadcastAction {
    const OPTIONS: &'static [Self] = &[
        Self::ReduceLuminance,
        Self::ReduceSaturation,
        Self::KeyOutUnsafe,
        Self::KeyOutSafe,
    ];
}
impl ChoiceParam for TonerTones {
    const OPTIONS: &'static [Self] = &[Self::Duotone, Self::Tritone, Self::Pentone];
}
impl ChoiceParam for ColorOverflow {
    const OPTIONS: &'static [Self] = &[Self::Wrap, Self::Solarize, Self::Polarize];
}
impl ChoiceParam for ThresholdChannel {
    const OPTIONS: &'static [Self] = &[Self::Luminance, Self::Rgb, Self::Saturation, Self::Alpha];
}
impl ChoiceParam for ChangeColorView {
    const OPTIONS: &'static [Self] = &[Self::CorrectedLayer, Self::ColorCorrectionMask];
}
impl ChoiceParam for ChangeMatch {
    const OPTIONS: &'static [Self] = &[Self::Rgb, Self::Hue, Self::Chroma];
}
impl ChoiceParam for ChannelSource {
    const OPTIONS: &'static [Self] = &[
        Self::Alpha,
        Self::Red,
        Self::Green,
        Self::Blue,
        Self::Luminance,
        Self::Hue,
        Self::Lightness,
        Self::Saturation,
        Self::FullOn,
        Self::HalfOn,
        Self::FullOff,
    ];
}
impl ChoiceParam for KeyView {
    const OPTIONS: &'static [Self] = &[Self::FinalOutput, Self::SourceOnly, Self::MatteOnly];
}
impl ChoiceParam for ArithmeticOperator {
    const OPTIONS: &'static [Self] = &[
        Self::And,
        Self::Or,
        Self::Xor,
        Self::Add,
        Self::Subtract,
        Self::Difference,
        Self::Min,
        Self::Max,
        Self::BlockAbove,
        Self::BlockBelow,
        Self::Slice,
        Self::Multiply,
        Self::Screen,
    ];
}
impl ChoiceParam for ColorDiffView {
    const OPTIONS: &'static [Self] = &[
        Self::Source,
        Self::UncorrectedMatteA,
        Self::CorrectedMatteA,
        Self::UncorrectedMatteB,
        Self::CorrectedMatteB,
        Self::UncorrectedMatte,
        Self::CorrectedMatte,
        Self::FinalOutput,
    ];
}
impl ChoiceParam for MatchAccuracy {
    const OPTIONS: &'static [Self] = &[Self::Faster, Self::MoreAccurate];
}
impl ChoiceParam for SelectiveMethod {
    const OPTIONS: &'static [Self] = &[Self::Relative, Self::Absolute];
}
impl ChoiceParam for RangeSpace {
    const OPTIONS: &'static [Self] = &[Self::Lab, Self::Yuv, Self::Rgb];
}
impl ChoiceParam for KeyMatch {
    const OPTIONS: &'static [Self] = &[Self::Rgb, Self::Hue, Self::Chroma];
}
impl ChoiceParam for KeyOperation {
    const OPTIONS: &'static [Self] = &[Self::KeyColors, Self::KeepColors];
}
impl ChoiceParam for ExtractChannel {
    const OPTIONS: &'static [Self] = &[
        Self::Luminance,
        Self::Red,
        Self::Green,
        Self::Blue,
        Self::Alpha,
    ];
}
impl ChoiceParam for UnmultBackground {
    const OPTIONS: &'static [Self] = &[Self::Black, Self::White];
}
impl ChoiceParam for SpillAccuracy {
    const OPTIONS: &'static [Self] = &[Self::Faster, Self::Better];
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
const TEN: Domain = Domain::Range {
    min: 0.0,
    max: 10.0,
};
const MIX: Domain = Domain::Range {
    min: -2.0,
    max: 2.0,
};
const HUE_TURNS: Domain = Domain::Range {
    min: -360.0,
    max: 360.0,
};
const ZERO_TO_TWO: Domain = Domain::Range { min: 0.0, max: 2.0 };
const LEVEL_255: Domain = Domain::Range {
    min: 0.0,
    max: 255.0,
};
const SIGNAL: Domain = Domain::Range {
    min: 90.0,
    max: 120.0,
};
const HUE_WEIGHT: Domain = Domain::Range {
    min: -2.0,
    max: 3.0,
};

fn colour(prefix: &str, colour: &mut Rgba, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(&format!("{prefix}.r"), Slot::Number(&mut colour.r, UNIT));
    f(&format!("{prefix}.g"), Slot::Number(&mut colour.g, UNIT));
    f(&format!("{prefix}.b"), Slot::Number(&mut colour.b, UNIT));
    f(&format!("{prefix}.a"), Slot::Number(&mut colour.a, UNIT));
}

fn mixer_row(prefix: &str, row: &mut MixerRow, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(&format!("{prefix}.red"), Slot::Number(&mut row.red, MIX));
    f(
        &format!("{prefix}.green"),
        Slot::Number(&mut row.green, MIX),
    );
    f(&format!("{prefix}.blue"), Slot::Number(&mut row.blue, MIX));
    f(
        &format!("{prefix}.constant"),
        Slot::Number(&mut row.constant, MIX),
    );
}

fn colour_shift(prefix: &str, shift: &mut ColorShift, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(
        &format!("{prefix}.red"),
        Slot::Number(&mut shift.red, SIGNED_UNIT),
    );
    f(
        &format!("{prefix}.green"),
        Slot::Number(&mut shift.green, SIGNED_UNIT),
    );
    f(
        &format!("{prefix}.blue"),
        Slot::Number(&mut shift.blue, SIGNED_UNIT),
    );
}

fn ink_shift(prefix: &str, ink: &mut InkShift, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(
        &format!("{prefix}.cyan"),
        Slot::Number(&mut ink.cyan, SIGNED_UNIT),
    );
    f(
        &format!("{prefix}.magenta"),
        Slot::Number(&mut ink.magenta, SIGNED_UNIT),
    );
    f(
        &format!("{prefix}.yellow"),
        Slot::Number(&mut ink.yellow, SIGNED_UNIT),
    );
    f(
        &format!("{prefix}.black"),
        Slot::Number(&mut ink.black, SIGNED_UNIT),
    );
}

fn gamma_channel(prefix: &str, c: &mut GammaChannel, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(
        &format!("{prefix}.gamma"),
        Slot::Number(&mut c.gamma, GAMMA),
    );
    f(
        &format!("{prefix}.pedestal"),
        Slot::Number(&mut c.pedestal, SIGNED_UNIT),
    );
    f(&format!("{prefix}.gain"), Slot::Number(&mut c.gain, TEN));
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

fn matte_levels(prefix: &str, c: &mut MatteLevels, f: &mut dyn FnMut(&str, Slot<'_>)) {
    f(
        &format!("{prefix}.inBlack"),
        Slot::Number(&mut c.in_black, LEVEL_255),
    );
    f(
        &format!("{prefix}.inWhite"),
        Slot::Number(&mut c.in_white, LEVEL_255),
    );
    f(
        &format!("{prefix}.gamma"),
        Slot::Number(&mut c.gamma, GAMMA),
    );
    f(
        &format!("{prefix}.outBlack"),
        Slot::Number(&mut c.out_black, LEVEL_255),
    );
    f(
        &format!("{prefix}.outWhite"),
        Slot::Number(&mut c.out_white, LEVEL_255),
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
            Effect::Invert(_) => "invert",
            Effect::Posterize(_) => "posterize",
            Effect::Threshold(_) => "threshold",
            Effect::Vibrance(_) => "vibrance",
            Effect::Tritone(_) => "tritone",
            Effect::ChannelMixer(_) => "channel-mixer",
            Effect::ColorBalance(_) => "color-balance",
            Effect::GammaPedestalGain(_) => "gamma-pedestal-gain",
            Effect::ColorBalanceHls(_) => "color-balance-hls",
            Effect::BlackWhite(_) => "black-white",
            Effect::PhotoFilter(_) => "photo-filter",
            Effect::LeaveColor(_) => "leave-color",
            Effect::VideoLimiter(_) => "video-limiter",
            Effect::BroadcastColors(_) => "broadcast-colors",
            Effect::CcToner(_) => "cc-toner",
            Effect::CcColorOffset(_) => "cc-color-offset",
            Effect::CcThreshold(_) => "cc-threshold",
            Effect::CcThresholdRgb(_) => "cc-threshold-rgb",
            Effect::ChangeColor(_) => "change-color",
            Effect::ShiftChannels(_) => "shift-channels",
            Effect::LinearColorKey(_) => "linear-color-key",
            Effect::RemoveColorMatting(_) => "remove-color-matting",
            Effect::Extract(_) => "extract",
            Effect::CcColorNeutralizer(_) => "cc-color-neutralizer",
            Effect::Unmult(_) => "unmult",
            Effect::SpillSuppressor(_) => "spill-suppressor",
            Effect::ColorRange(_) => "color-range",
            Effect::Arithmetic(_) => "arithmetic",
            Effect::ColorDifferenceKey(_) => "color-difference-key",
            Effect::SelectiveColor(_) => "selective-color",
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
                | Effect::Invert(_)
                | Effect::Posterize(_)
                | Effect::Threshold(_)
                | Effect::Vibrance(_)
                | Effect::Tritone(_)
                | Effect::ChannelMixer(_)
                | Effect::ColorBalance(_)
                | Effect::GammaPedestalGain(_)
                | Effect::ColorBalanceHls(_)
                | Effect::BlackWhite(_)
                | Effect::PhotoFilter(_)
                | Effect::LeaveColor(_)
                | Effect::VideoLimiter(_)
                | Effect::BroadcastColors(_)
                | Effect::CcToner(_)
                | Effect::CcColorOffset(_)
                | Effect::CcThreshold(_)
                | Effect::CcThresholdRgb(_)
                | Effect::ChangeColor(_)
                | Effect::ShiftChannels(_)
                | Effect::LinearColorKey(_)
                | Effect::RemoveColorMatting(_)
                | Effect::Extract(_)
                | Effect::CcColorNeutralizer(_)
                | Effect::Unmult(_)
                | Effect::SpillSuppressor(_)
                | Effect::ColorRange(_)
                | Effect::Arithmetic(_)
                | Effect::ColorDifferenceKey(_)
                | Effect::SelectiveColor(_)
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
            Effect::Invert(e) => {
                f("channel", Slot::Choice(&mut e.channel));
                f(
                    "blendWithOriginal",
                    Slot::Number(&mut e.blend_with_original, UNIT),
                );
            }
            Effect::Posterize(e) => {
                f(
                    "level",
                    Slot::Number(
                        &mut e.level,
                        Domain::Range {
                            min: 2.0,
                            max: 255.0,
                        },
                    ),
                );
            }
            Effect::Threshold(e) => {
                f("level", Slot::Number(&mut e.level, UNIT));
            }
            Effect::Vibrance(e) => {
                f("vibrance", Slot::Number(&mut e.vibrance, SIGNED_UNIT));
                f("saturation", Slot::Number(&mut e.saturation, SIGNED_UNIT));
            }
            Effect::Tritone(e) => {
                colour("highlights", &mut e.highlights, f);
                colour("midtones", &mut e.midtones, f);
                colour("shadows", &mut e.shadows, f);
                f(
                    "blendWithOriginal",
                    Slot::Number(&mut e.blend_with_original, UNIT),
                );
            }
            Effect::ChannelMixer(e) => {
                mixer_row("red", &mut e.red, f);
                mixer_row("green", &mut e.green, f);
                mixer_row("blue", &mut e.blue, f);
                f("monochrome", Slot::Switch(&mut e.monochrome));
            }
            Effect::ColorBalance(e) => {
                colour_shift("shadows", &mut e.shadows, f);
                colour_shift("midtones", &mut e.midtones, f);
                colour_shift("highlights", &mut e.highlights, f);
                f(
                    "preserveLuminosity",
                    Slot::Switch(&mut e.preserve_luminosity),
                );
            }
            Effect::GammaPedestalGain(e) => {
                gamma_channel("red", &mut e.red, f);
                gamma_channel("green", &mut e.green, f);
                gamma_channel("blue", &mut e.blue, f);
                f("blackStretch", Slot::Number(&mut e.black_stretch, TEN));
            }
            Effect::ColorBalanceHls(e) => {
                f("hue", Slot::Number(&mut e.hue, Domain::Finite));
                f("lightness", Slot::Number(&mut e.lightness, SIGNED_UNIT));
                f("saturation", Slot::Number(&mut e.saturation, SIGNED_UNIT));
            }
            Effect::BlackWhite(e) => {
                f("reds", Slot::Number(&mut e.reds, HUE_WEIGHT));
                f("yellows", Slot::Number(&mut e.yellows, HUE_WEIGHT));
                f("greens", Slot::Number(&mut e.greens, HUE_WEIGHT));
                f("cyans", Slot::Number(&mut e.cyans, HUE_WEIGHT));
                f("blues", Slot::Number(&mut e.blues, HUE_WEIGHT));
                f("magentas", Slot::Number(&mut e.magentas, HUE_WEIGHT));
                f("tint", Slot::Switch(&mut e.tint));
                colour("tintColor", &mut e.tint_color, f);
            }
            Effect::PhotoFilter(e) => {
                f("filter", Slot::Choice(&mut e.filter));
                colour("color", &mut e.color, f);
                f("density", Slot::Number(&mut e.density, UNIT));
                f(
                    "preserveLuminosity",
                    Slot::Switch(&mut e.preserve_luminosity),
                );
            }
            Effect::LeaveColor(e) => {
                f("amount", Slot::Number(&mut e.amount, UNIT));
                colour("color", &mut e.color, f);
                f("tolerance", Slot::Number(&mut e.tolerance, UNIT));
                f("edgeSoftness", Slot::Number(&mut e.edge_softness, UNIT));
                f("matchColors", Slot::Choice(&mut e.match_colors));
            }
            Effect::Extract(e) => {
                f("channel", Slot::Choice(&mut e.channel));
                f("blackPoint", Slot::Number(&mut e.black_point, LEVEL_255));
                f("whitePoint", Slot::Number(&mut e.white_point, LEVEL_255));
                f(
                    "blackSoftness",
                    Slot::Number(&mut e.black_softness, LEVEL_255),
                );
                f(
                    "whiteSoftness",
                    Slot::Number(&mut e.white_softness, LEVEL_255),
                );
                f("invert", Slot::Switch(&mut e.invert));
            }
            Effect::CcColorNeutralizer(e) => {
                colour("shadowsUnbalance", &mut e.shadows_unbalance, f);
                colour("shadowsBalance", &mut e.shadows_balance, f);
                colour("midtonesUnbalance", &mut e.midtones_unbalance, f);
                colour("midtonesBalance", &mut e.midtones_balance, f);
                colour("highlightsUnbalance", &mut e.highlights_unbalance, f);
                colour("highlightsBalance", &mut e.highlights_balance, f);
                f("pinning", Slot::Number(&mut e.pinning, UNIT));
                f(
                    "blendWithOriginal",
                    Slot::Number(&mut e.blend_with_original, UNIT),
                );
                f("darks", Slot::Number(&mut e.darks, SIGNED_UNIT));
                f("brights", Slot::Number(&mut e.brights, SIGNED_UNIT));
                f("contrast", Slot::Number(&mut e.contrast, SIGNED_UNIT));
            }
            Effect::Unmult(e) => {
                f("background", Slot::Choice(&mut e.background));
                f("blackLevel", Slot::Number(&mut e.black_level, UNIT));
                f("whiteLevel", Slot::Number(&mut e.white_level, UNIT));
                f("softness", Slot::Number(&mut e.softness, UNIT));
                f(
                    "removeColorMatting",
                    Slot::Switch(&mut e.remove_color_matting),
                );
                f("clipHdr", Slot::Switch(&mut e.clip_hdr));
            }
            Effect::SpillSuppressor(e) => {
                colour("colorToSuppress", &mut e.color_to_suppress, f);
                f("colorAccuracy", Slot::Choice(&mut e.color_accuracy));
                f("suppression", Slot::Number(&mut e.suppression, ZERO_TO_TWO));
            }
            Effect::LinearColorKey(e) => {
                f("view", Slot::Choice(&mut e.view));
                colour("keyColor", &mut e.key_color, f);
                f("matchColors", Slot::Choice(&mut e.match_colors));
                f("tolerance", Slot::Number(&mut e.tolerance, UNIT));
                f("softness", Slot::Number(&mut e.softness, UNIT));
                f("keyOperation", Slot::Choice(&mut e.key_operation));
            }
            Effect::RemoveColorMatting(e) => {
                colour("backgroundColor", &mut e.background_color, f);
                f("clipHdr", Slot::Switch(&mut e.clip_hdr));
            }
            Effect::ChangeColor(e) => {
                f("view", Slot::Choice(&mut e.view));
                f(
                    "hueTransform",
                    Slot::Number(&mut e.hue_transform, HUE_TURNS),
                );
                f(
                    "lightnessTransform",
                    Slot::Number(&mut e.lightness_transform, SIGNED_UNIT),
                );
                f(
                    "saturationTransform",
                    Slot::Number(&mut e.saturation_transform, SIGNED_UNIT),
                );
                colour("colorToChange", &mut e.color_to_change, f);
                f(
                    "matchingTolerance",
                    Slot::Number(&mut e.matching_tolerance, UNIT),
                );
                f(
                    "matchingSoftness",
                    Slot::Number(&mut e.matching_softness, UNIT),
                );
                f("matchColors", Slot::Choice(&mut e.match_colors));
                f("invertMask", Slot::Switch(&mut e.invert_mask));
            }
            Effect::Arithmetic(e) => {
                f("operator", Slot::Choice(&mut e.operator));
                f("redValue", Slot::Number(&mut e.red_value, LEVEL_255));
                f("greenValue", Slot::Number(&mut e.green_value, LEVEL_255));
                f("blueValue", Slot::Number(&mut e.blue_value, LEVEL_255));
                f("clip", Slot::Switch(&mut e.clip));
            }
            Effect::ColorDifferenceKey(e) => {
                f("view", Slot::Choice(&mut e.view));
                colour("keyColor", &mut e.key_color, f);
                f(
                    "colorMatchingAccuracy",
                    Slot::Choice(&mut e.color_matching_accuracy),
                );
                matte_levels("partialA", &mut e.partial_a, f);
                matte_levels("partialB", &mut e.partial_b, f);
                f("matteBlack", Slot::Number(&mut e.matte_black, LEVEL_255));
                f("matteWhite", Slot::Number(&mut e.matte_white, LEVEL_255));
                f("matteGamma", Slot::Number(&mut e.matte_gamma, GAMMA));
            }
            Effect::SelectiveColor(e) => {
                f("method", Slot::Choice(&mut e.method));
                ink_shift("reds", &mut e.reds, f);
                ink_shift("yellows", &mut e.yellows, f);
                ink_shift("greens", &mut e.greens, f);
                ink_shift("cyans", &mut e.cyans, f);
                ink_shift("blues", &mut e.blues, f);
                ink_shift("magentas", &mut e.magentas, f);
                ink_shift("whites", &mut e.whites, f);
                ink_shift("neutrals", &mut e.neutrals, f);
                ink_shift("blacks", &mut e.blacks, f);
            }
            Effect::ColorRange(e) => {
                f("fuzziness", Slot::Number(&mut e.fuzziness, LEVEL_255));
                f("colorSpace", Slot::Choice(&mut e.color_space));
                f("minL", Slot::Number(&mut e.min_l, LEVEL_255));
                f("maxL", Slot::Number(&mut e.max_l, LEVEL_255));
                f("minA", Slot::Number(&mut e.min_a, LEVEL_255));
                f("maxA", Slot::Number(&mut e.max_a, LEVEL_255));
                f("minB", Slot::Number(&mut e.min_b, LEVEL_255));
                f("maxB", Slot::Number(&mut e.max_b, LEVEL_255));
            }
            Effect::ShiftChannels(e) => {
                f("takeAlphaFrom", Slot::Choice(&mut e.take_alpha_from));
                f("takeRedFrom", Slot::Choice(&mut e.take_red_from));
                f("takeGreenFrom", Slot::Choice(&mut e.take_green_from));
                f("takeBlueFrom", Slot::Choice(&mut e.take_blue_from));
            }
            Effect::CcToner(e) => {
                f("tones", Slot::Choice(&mut e.tones));
                colour("highlights", &mut e.highlights, f);
                colour("brights", &mut e.brights, f);
                colour("midtones", &mut e.midtones, f);
                colour("darktones", &mut e.darktones, f);
                colour("shadows", &mut e.shadows, f);
                f("blend", Slot::Number(&mut e.blend, UNIT));
            }
            Effect::CcColorOffset(e) => {
                f("redPhase", Slot::Number(&mut e.red_phase, Domain::Finite));
                f(
                    "greenPhase",
                    Slot::Number(&mut e.green_phase, Domain::Finite),
                );
                f("bluePhase", Slot::Number(&mut e.blue_phase, Domain::Finite));
                f("overflow", Slot::Choice(&mut e.overflow));
            }
            Effect::CcThreshold(e) => {
                f("threshold", Slot::Number(&mut e.threshold, LEVEL_255));
                f("channel", Slot::Choice(&mut e.channel));
                f("invert", Slot::Switch(&mut e.invert));
                f("blend", Slot::Number(&mut e.blend, UNIT));
            }
            Effect::CcThresholdRgb(e) => {
                f(
                    "redThreshold",
                    Slot::Number(&mut e.red_threshold, LEVEL_255),
                );
                f(
                    "greenThreshold",
                    Slot::Number(&mut e.green_threshold, LEVEL_255),
                );
                f(
                    "blueThreshold",
                    Slot::Number(&mut e.blue_threshold, LEVEL_255),
                );
                f("invertRed", Slot::Switch(&mut e.invert_red));
                f("invertGreen", Slot::Switch(&mut e.invert_green));
                f("invertBlue", Slot::Switch(&mut e.invert_blue));
                f("blend", Slot::Number(&mut e.blend, UNIT));
            }
            Effect::VideoLimiter(e) => {
                f("clipLevel", Slot::Choice(&mut e.clip_level));
                f("clipMethod", Slot::Choice(&mut e.clip_method));
                f(
                    "compressionBeforeClipping",
                    Slot::Choice(&mut e.compression_before_clipping),
                );
                f("gamutWarning", Slot::Switch(&mut e.gamut_warning));
                colour("gamutWarningColor", &mut e.gamut_warning_color, f);
            }
            Effect::BroadcastColors(e) => {
                f("locale", Slot::Choice(&mut e.locale));
                f("howToMakeSafe", Slot::Choice(&mut e.how_to_make_safe));
                f("maxSignal", Slot::Number(&mut e.max_signal, SIGNAL));
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
    fn batch_one_parameters_are_bounded_and_the_channel_is_a_wire_word() {
        let out_of_range = [
            Effect::Posterize(Posterize { level: 1.0 }),
            Effect::Posterize(Posterize { level: 256.0 }),
            Effect::Threshold(Threshold { level: 1.01 }),
            Effect::Vibrance(Vibrance {
                vibrance: 1.5,
                saturation: 0.0,
            }),
            Effect::Vibrance(Vibrance {
                vibrance: 0.0,
                saturation: -1.5,
            }),
            Effect::Invert(Invert {
                channel: InvertChannel::Rgb,
                blend_with_original: 1.5,
            }),
        ];
        for effect in out_of_range {
            let instance = EffectInstance::new("e", effect.clone());
            assert!(validate_effects("o", &[instance]).is_err(), "{effect:?}");
        }
        let wire = serde_json::to_value(EffectInstance::new(
            "e",
            Effect::Invert(Invert {
                channel: InvertChannel::Green,
                ..Default::default()
            }),
        ))
        .unwrap();
        assert_eq!(wire["effect"], "invert");
        assert_eq!(wire["channel"], "green");
        assert_eq!(wire["blendWithOriginal"], 0.0);
        let mut invert = Effect::Invert(Invert::default());
        let mut options = 0;
        invert.visit(&mut |path, slot| {
            if path == "channel" {
                options = slot.domain().describe().len();
                assert_eq!(slot.domain(), Domain::Choice { count: 4 });
            }
        });
        assert!(options > 0);
    }

    #[test]
    fn batch_two_parameters_are_bounded_and_keyed_by_path() {
        let out_of_range = [
            Effect::ChannelMixer(ChannelMixer {
                red: MixerRow {
                    red: 2.5,
                    ..MixerRow::default()
                },
                ..ChannelMixer::default()
            }),
            Effect::ColorBalance(ColorBalance {
                midtones: ColorShift {
                    blue: -1.2,
                    ..ColorShift::default()
                },
                ..ColorBalance::default()
            }),
            Effect::GammaPedestalGain(GammaPedestalGain {
                green: GammaChannel {
                    gamma: 0.0,
                    ..GammaChannel::default()
                },
                ..GammaPedestalGain::default()
            }),
            Effect::GammaPedestalGain(GammaPedestalGain {
                black_stretch: -1.0,
                ..GammaPedestalGain::default()
            }),
            Effect::Tritone(Tritone {
                blend_with_original: 1.5,
                ..Tritone::default()
            }),
        ];
        for effect in out_of_range {
            let instance = EffectInstance::new("e", effect.clone());
            assert!(validate_effects("o", &[instance]).is_err(), "{effect:?}");
        }
        let paths = |effect: Effect| effect.parameter_paths();
        assert!(paths(Effect::ChannelMixer(ChannelMixer::default()))
            .contains(&"green.constant".to_owned()));
        assert!(paths(Effect::ColorBalance(ColorBalance::default()))
            .contains(&"highlights.red".to_owned()));
        assert!(
            paths(Effect::GammaPedestalGain(GammaPedestalGain::default()))
                .contains(&"blue.pedestal".to_owned())
        );
        assert_eq!(paths(Effect::Tritone(Tritone::default())).len(), 13);
        assert_eq!(
            paths(Effect::ChannelMixer(ChannelMixer::default())).len(),
            13
        );
        assert_eq!(
            paths(Effect::ColorBalance(ColorBalance::default())).len(),
            10
        );
        let wire = serde_json::to_value(EffectInstance::new(
            "e",
            Effect::GammaPedestalGain(GammaPedestalGain::default()),
        ))
        .unwrap();
        assert_eq!(wire["effect"], "gamma-pedestal-gain");
        assert_eq!(wire["red"]["gamma"], 1.0);
    }

    #[test]
    fn batch_three_parameters_are_bounded_and_the_choices_are_wire_words() {
        let out_of_range = [
            Effect::ColorBalanceHls(ColorBalanceHls {
                lightness: 1.5,
                ..ColorBalanceHls::default()
            }),
            Effect::BlackWhite(BlackWhite {
                reds: 3.5,
                ..BlackWhite::default()
            }),
            Effect::BlackWhite(BlackWhite {
                blues: -2.5,
                ..BlackWhite::default()
            }),
            Effect::PhotoFilter(PhotoFilter {
                density: 1.2,
                ..PhotoFilter::default()
            }),
            Effect::LeaveColor(LeaveColor {
                tolerance: -0.1,
                ..LeaveColor::default()
            }),
            Effect::LeaveColor(LeaveColor {
                edge_softness: 1.1,
                ..LeaveColor::default()
            }),
            Effect::BroadcastColors(BroadcastColors {
                max_signal: 89.9,
                ..BroadcastColors::default()
            }),
            Effect::BroadcastColors(BroadcastColors {
                max_signal: 120.1,
                ..BroadcastColors::default()
            }),
            Effect::Extract(Extract {
                black_point: 300.0,
                ..Extract::default()
            }),
            Effect::Unmult(Unmult {
                softness: 2.0,
                ..Unmult::default()
            }),
            Effect::SpillSuppressor(SpillSuppressor {
                suppression: 3.0,
                ..SpillSuppressor::default()
            }),
            Effect::Arithmetic(Arithmetic {
                red_value: 256.0,
                ..Arithmetic::default()
            }),
            Effect::SelectiveColor(SelectiveColor {
                reds: InkShift {
                    cyan: 1.5,
                    ..InkShift::default()
                },
                ..SelectiveColor::default()
            }),
            Effect::ColorDifferenceKey(ColorDifferenceKey {
                matte_gamma: 0.0,
                ..ColorDifferenceKey::default()
            }),
            Effect::ColorDifferenceKey(ColorDifferenceKey {
                partial_a: MatteLevels {
                    in_white: 300.0,
                    ..MatteLevels::default()
                },
                ..ColorDifferenceKey::default()
            }),
            Effect::ColorRange(ColorRange {
                fuzziness: 300.0,
                ..ColorRange::default()
            }),
            Effect::ColorRange(ColorRange {
                min_a: -1.0,
                ..ColorRange::default()
            }),
            Effect::LinearColorKey(LinearColorKey {
                tolerance: 1.5,
                ..LinearColorKey::default()
            }),
            Effect::LinearColorKey(LinearColorKey {
                softness: -0.5,
                ..LinearColorKey::default()
            }),
            Effect::ChangeColor(ChangeColor {
                hue_transform: 361.0,
                ..ChangeColor::default()
            }),
            Effect::ChangeColor(ChangeColor {
                lightness_transform: 1.1,
                ..ChangeColor::default()
            }),
            Effect::ChangeColor(ChangeColor {
                matching_softness: -0.1,
                ..ChangeColor::default()
            }),
            Effect::CcToner(CcToner {
                blend: 1.5,
                ..CcToner::default()
            }),
            Effect::CcThreshold(CcThreshold {
                threshold: 256.0,
                ..CcThreshold::default()
            }),
            Effect::CcThreshold(CcThreshold {
                threshold: -1.0,
                ..CcThreshold::default()
            }),
            Effect::CcThresholdRgb(CcThresholdRgb {
                green_threshold: 300.0,
                ..CcThresholdRgb::default()
            }),
            Effect::CcThresholdRgb(CcThresholdRgb {
                blend: -0.1,
                ..CcThresholdRgb::default()
            }),
        ];
        for effect in out_of_range {
            let instance = EffectInstance::new("e", effect.clone());
            assert!(validate_effects("o", &[instance]).is_err(), "{effect:?}");
        }
        let wire = serde_json::to_value(EffectInstance::new(
            "e",
            Effect::PhotoFilter(PhotoFilter {
                filter: PhotoFilterPreset::DeepEmerald,
                ..PhotoFilter::default()
            }),
        ))
        .unwrap();
        assert_eq!(wire["effect"], "photo-filter");
        assert_eq!(wire["filter"], "deep-emerald");
        for (preset, word) in [
            (PhotoFilterPreset::Warming85, "warming-85"),
            (PhotoFilterPreset::CoolingLbb, "cooling-lbb"),
            (PhotoFilterPreset::Cooling82, "cooling-82"),
            (PhotoFilterPreset::Custom, "custom"),
        ] {
            assert_eq!(serde_json::to_value(preset).unwrap(), word);
        }
        // Every preset but Custom has a colour; the table has 21 entries.
        assert_eq!(PhotoFilterPreset::OPTIONS.len(), 21);
        for preset in PhotoFilterPreset::OPTIONS {
            assert_eq!(
                preset.srgb8().is_none(),
                *preset == PhotoFilterPreset::Custom
            );
        }
        let leave = serde_json::to_value(EffectInstance::new(
            "e",
            Effect::LeaveColor(LeaveColor {
                match_colors: LeaveMatch::Hue,
                ..LeaveColor::default()
            }),
        ))
        .unwrap();
        assert_eq!(leave["effect"], "leave-color");
        assert_eq!(leave["matchColors"], "hue");
        let paths = |effect: Effect| effect.parameter_paths();
        assert!(
            paths(Effect::BlackWhite(BlackWhite::default())).contains(&"tintColor.g".to_owned())
        );
        assert!(
            paths(Effect::LeaveColor(LeaveColor::default())).contains(&"edgeSoftness".to_owned())
        );
        assert_eq!(
            paths(Effect::ColorBalanceHls(ColorBalanceHls::default())).len(),
            3
        );
        assert_eq!(paths(Effect::PhotoFilter(PhotoFilter::default())).len(), 7);
    }

    /// The limiter's words and fractions are EffectCraft's (`color3.rs` CLIP_LEVELS and its
    /// compression list); a wrong one would clip every picture at the wrong level.
    #[test]
    fn the_video_limiter_and_broadcast_words_are_pinned() {
        let level: Vec<(String, f64)> = LimiterLevel::OPTIONS
            .iter()
            .map(|l| {
                (
                    serde_json::to_value(l)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    l.fraction(),
                )
            })
            .collect();
        let want = [
            ("90", 0.90),
            ("95", 0.95),
            ("100", 1.00),
            ("105", 1.05),
            ("109", 1.09),
        ];
        assert_eq!(level.len(), want.len());
        for ((word, fraction), (w, f)) in level.iter().zip(want) {
            assert_eq!((word.as_str(), *fraction), (w, f));
        }
        let comp: Vec<(String, f64)> = LimiterCompression::OPTIONS
            .iter()
            .map(|l| {
                (
                    serde_json::to_value(l)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    l.fraction(),
                )
            })
            .collect();
        let want = [
            ("none", 0.0),
            ("3", 0.03),
            ("5", 0.05),
            ("10", 0.10),
            ("20", 0.20),
        ];
        assert_eq!(comp.len(), want.len());
        for ((word, fraction), (w, f)) in comp.iter().zip(want) {
            assert_eq!((word.as_str(), *fraction), (w, f));
        }
        let word = |v: serde_json::Value| v.as_str().unwrap().to_owned();
        assert_eq!(
            word(serde_json::to_value(LimiterMethod::SmartLimit).unwrap()),
            "smart-limit"
        );
        assert_eq!(
            word(serde_json::to_value(BroadcastAction::KeyOutUnsafe).unwrap()),
            "key-out-unsafe"
        );
        // EffectCraft's defaults: 100%, Smart Limit, 5% compression; NTSC, reduce luminance, 110.
        let d = VideoLimiter::default();
        assert_eq!(
            (d.clip_level, d.clip_method, d.compression_before_clipping),
            (
                LimiterLevel::P100,
                LimiterMethod::SmartLimit,
                LimiterCompression::P5
            )
        );
        assert!(!d.gamut_warning);
        let b = BroadcastColors::default();
        assert_eq!(
            (b.locale, b.how_to_make_safe, b.max_signal),
            (
                BroadcastLocale::Ntsc,
                BroadcastAction::ReduceLuminance,
                110.0
            )
        );
    }

    /// The filter colours are EffectCraft's (`color_fx.rs` PHOTO_FILTERS, 8-bit sRGB), in its order;
    /// a typo in one would tint every picture that uses it, and nothing else would notice.
    #[test]
    fn the_photo_filter_table_is_effectcrafts_in_its_order() {
        let table: [(&str, [u8; 3]); 20] = [
            ("warming-85", [240, 140, 30]),
            ("warming-lba", [245, 155, 25]),
            ("warming-81", [240, 180, 40]),
            ("cooling-80", [20, 110, 250]),
            ("cooling-lbb", [20, 95, 245]),
            ("cooling-82", [30, 180, 250]),
            ("red", [230, 30, 30]),
            ("orange", [240, 130, 30]),
            ("yellow", [245, 225, 35]),
            ("green", [30, 200, 30]),
            ("cyan", [30, 200, 230]),
            ("blue", [30, 55, 230]),
            ("violet", [150, 30, 230]),
            ("magenta", [225, 30, 225]),
            ("sepia", [170, 120, 55]),
            ("deep-red", [250, 0, 0]),
            ("deep-blue", [0, 40, 200]),
            ("deep-emerald", [0, 135, 0]),
            ("deep-yellow", [255, 210, 0]),
            ("underwater", [0, 190, 175]),
        ];
        for (index, (word, colour)) in table.iter().enumerate() {
            let preset = PhotoFilterPreset::OPTIONS[index];
            assert_eq!(
                serde_json::to_value(preset).unwrap(),
                *word,
                "option {index}"
            );
            assert_eq!(preset.srgb8(), Some(*colour), "{word}");
        }
        assert_eq!(PhotoFilterPreset::OPTIONS[20], PhotoFilterPreset::Custom);
    }

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
            Effect::Invert(Invert::default()),
            Effect::Posterize(Posterize::default()),
            Effect::Threshold(Threshold::default()),
            Effect::Vibrance(Vibrance::default()),
            Effect::Tritone(Tritone::default()),
            Effect::ChannelMixer(ChannelMixer::default()),
            Effect::ColorBalance(ColorBalance::default()),
            Effect::GammaPedestalGain(GammaPedestalGain::default()),
            Effect::ColorBalanceHls(ColorBalanceHls::default()),
            Effect::BlackWhite(BlackWhite::default()),
            Effect::PhotoFilter(PhotoFilter::default()),
            Effect::LeaveColor(LeaveColor::default()),
            Effect::VideoLimiter(VideoLimiter::default()),
            Effect::BroadcastColors(BroadcastColors::default()),
            Effect::CcToner(CcToner::default()),
            Effect::CcColorOffset(CcColorOffset::default()),
            Effect::CcThreshold(CcThreshold::default()),
            Effect::CcThresholdRgb(CcThresholdRgb::default()),
            Effect::ChangeColor(ChangeColor::default()),
            Effect::ShiftChannels(ShiftChannels::default()),
            Effect::LinearColorKey(LinearColorKey::default()),
            Effect::RemoveColorMatting(RemoveColorMatting::default()),
            Effect::Extract(Extract::default()),
            Effect::CcColorNeutralizer(CcColorNeutralizer::default()),
            Effect::Unmult(Unmult::default()),
            Effect::SpillSuppressor(SpillSuppressor::default()),
            Effect::ColorRange(ColorRange::default()),
            Effect::Arithmetic(Arithmetic::default()),
            Effect::ColorDifferenceKey(ColorDifferenceKey::default()),
            Effect::SelectiveColor(SelectiveColor::default()),
        ];
        assert_eq!(
            all.len(),
            46,
            "the first broadcast set and batches 1 to 11 of 3.25"
        );
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
