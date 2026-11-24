//! Pointwise effects: the CPU reference for build-plan 3.22.
//!
//! Each effect is packed once per frame into a fixed block of f32 parameters
//! (`PackedEffect`), already expressed in the project working space. The CPU
//! reference here and the GPU kernel in `compositor/effects.wgsl` both read
//! that same block, so the two cannot disagree about a parameter; only the
//! per-pixel float arithmetic differs.
//!
//! Formulas ported from EffectCraft at 9a7d3e76991d5372448033b473dc12c2480a6a04
//! (`crates/effects/src/color_fx.rs`: tint, brightness/contrast, hue/
//! saturation, levels, exposure, fill, the Fritsch–Carlson curve, and from
//! 3.25 invert, posterize, threshold, vibrance, tritone,
//! channel mixer, color balance, gamma/pedestal/gain, color balance (HLS),
//! black & white, photo filter, leave color; `crates/
//! color/src/lib.rs`: HSL), Copyright (c) 2026 ArtCraft Team and the
//! EffectCraft contributors, MIT OR Apache-2.0, see EFFECTCRAFT-LICENSE.
//! GrapiX's own: typed parameters instead of string keys, the packed block,
//! coverage tests on bit patterns, transparent pixels never gaining coverage,
//! alpha adjustments only where the layer drew, Exposure in linear light for
//! either working space, and colour alpha as an effect-strength factor.

use gx_contracts::color::WorkingColorSpace;
use gx_contracts::effect::{Curves, Effect, EffectInstance, InvertChannel, LevelsChannel};

use crate::blend::{bound, covers};
use crate::colour_pipeline::WorkingRgba;

/// Kernel numbers; 0 copies the input (a disabled effect).
pub const IDENTITY: u32 = 0;
pub const FILL: u32 = 1;
pub const TINT: u32 = 2;
pub const LEVELS: u32 = 3;
pub const CURVES: u32 = 4;
pub const HUE_SATURATION: u32 = 5;
pub const BRIGHTNESS_CONTRAST: u32 = 6;
pub const EXPOSURE: u32 = 7;
// 8 to 18 are the coordinate and spatial passes in `effect_chain`.
pub const INVERT: u32 = 19;
pub const POSTERIZE: u32 = 20;
pub const THRESHOLD: u32 = 21;
pub const VIBRANCE: u32 = 22;
pub const TRITONE: u32 = 23;
pub const CHANNEL_MIXER: u32 = 24;
pub const COLOR_BALANCE: u32 = 25;
pub const GAMMA_PEDESTAL_GAIN: u32 = 26;
pub const COLOR_BALANCE_HLS: u32 = 27;
pub const BLACK_WHITE: u32 = 28;
pub const PHOTO_FILTER: u32 = 29;
pub const LEAVE_COLOR: u32 = 30;
pub const VIDEO_LIMITER: u32 = 31;
pub const BROADCAST_COLORS: u32 = 32;
pub const CC_TONER: u32 = 33;
pub const CC_COLOR_OFFSET: u32 = 34;
pub const CC_THRESHOLD: u32 = 35;
pub const CC_THRESHOLD_RGB: u32 = 36;
pub const CHANGE_COLOR: u32 = 37;
pub const SHIFT_CHANNELS: u32 = 38;
pub const LINEAR_COLOR_KEY: u32 = 39;
pub const REMOVE_COLOR_MATTING: u32 = 40;
pub const EXTRACT: u32 = 41;
pub const CC_COLOR_NEUTRALIZER: u32 = 42;
pub const UNMULT: u32 = 43;
pub const SPILL_SUPPRESSOR: u32 = 44;
pub const COLOR_RANGE: u32 = 45;
pub const ARITHMETIC: u32 = 46;
pub const COLOR_DIFFERENCE_KEY: u32 = 47;
pub const SELECTIVE_COLOR: u32 = 48;
/// 3.28: the mix of an effect's output with its input by a mask reference.
pub const MIX: u32 = 49;
/// sqrt(3): the longest distance between two RGB colours of unit range.
const SQRT_3: f32 = 1.732_050_8;

/// Parameters per effect: eight vec4s.
pub const PARAMS: usize = 64;
/// Curve table resolution: entries over 0..=1 are `LUT_N + 1`.
pub const LUT_N: usize = 1024;
/// One curve channel's block: the table, then x0, y0, m0, xn, yn, mn for the
/// linear extensions beyond the end points.
pub const CURVE_BLOCK: usize = LUT_N + 1 + 6;
/// Five channels: RGB, red, green, blue, alpha.
pub const CURVE_FLOATS: usize = CURVE_BLOCK * 5;

/// One effect, ready for either renderer. `curve` is sized once and reused.
#[derive(Debug, Clone, PartialEq)]
pub struct PackedEffect {
    pub kind: u32,
    pub params: [f32; PARAMS],
    pub curve: Vec<f32>,
}

impl PackedEffect {
    pub fn identity() -> Self {
        Self {
            kind: IDENTITY,
            params: [0.0; PARAMS],
            curve: vec![0.0; CURVE_FLOATS],
        }
    }

    /// Pack one effect instance for this frame, in place (no allocation once
    /// `curve` is sized). Non-pointwise effects never reach here: they refuse
    /// at publish.
    pub fn pack(&mut self, instance: &EffectInstance, space: WorkingColorSpace) {
        self.params = [0.0; PARAMS];
        if self.curve.len() != CURVE_FLOATS {
            self.curve.resize(CURVE_FLOATS, 0.0);
        }
        if !instance.enabled {
            self.kind = IDENTITY;
            return;
        }
        let p = &mut self.params;
        // A tagged colour in the working space, straight, with its alpha.
        let colour = |c: gx_contracts::color::Rgba| {
            let w = WorkingRgba::from_source(gx_contracts::color::Rgba { a: 1.0, ..c }, space);
            [w.r, w.g, w.b, c.a as f32]
        };
        self.kind = match &instance.effect {
            Effect::Fill(e) => {
                let c = colour(e.color);
                p[..3].copy_from_slice(&c[..3]);
                p[3] = e.opacity as f32 * c[3];
                FILL
            }
            Effect::Tint(e) => {
                p[..4].copy_from_slice(&colour(e.map_black_to));
                p[4..8].copy_from_slice(&colour(e.map_white_to));
                p[8] = e.amount as f32;
                TINT
            }
            Effect::Levels(e) => {
                for (i, c) in [e.rgb, e.red, e.green, e.blue, e.alpha].iter().enumerate() {
                    let LevelsChannel {
                        input_black,
                        input_white,
                        gamma,
                        output_black,
                        output_white,
                    } = *c;
                    p[i * 5..i * 5 + 5].copy_from_slice(&[
                        input_black as f32,
                        input_white as f32,
                        (1.0 / gamma) as f32,
                        output_black as f32,
                        output_white as f32,
                    ]);
                }
                p[25] = f32::from(u8::from(e.clip_to_output_black));
                p[26] = f32::from(u8::from(e.clip_to_output_white));
                LEVELS
            }
            Effect::Curves(e) => {
                fill_curves(e, &mut self.curve);
                CURVES
            }
            Effect::HueSaturation(e) => {
                p[..7].copy_from_slice(&[
                    (e.hue / 360.0) as f32,
                    e.saturation as f32,
                    e.lightness as f32,
                    f32::from(u8::from(e.colorize)),
                    (e.colorize_hue / 360.0).rem_euclid(1.0) as f32,
                    e.colorize_saturation as f32,
                    e.colorize_lightness as f32,
                ]);
                HUE_SATURATION
            }
            Effect::BrightnessContrast(e) => {
                let (b, c) = (e.brightness as f32, e.contrast as f32);
                // Legacy gain, and the modern curves' exponents.
                let k = if c >= 0.0 {
                    1.0 / (1.0 - c * 0.99)
                } else {
                    1.0 + c
                };
                p[..6].copy_from_slice(&[
                    b,
                    c,
                    f32::from(u8::from(e.use_legacy)),
                    k,
                    2f32.powf(-b),
                    2f32.powf(2.0 * c),
                ]);
                BRIGHTNESS_CONTRAST
            }
            Effect::Exposure(e) => {
                p[..4].copy_from_slice(&[
                    2f64.powf(e.exposure) as f32,
                    e.offset as f32,
                    (1.0 / e.gamma_correction) as f32,
                    f32::from(u8::from(space == WorkingColorSpace::Srgb)),
                ]);
                EXPOSURE
            }
            Effect::Invert(e) => {
                let on = |channel: InvertChannel| {
                    f32::from(u8::from(
                        e.channel == InvertChannel::Rgb || e.channel == channel,
                    ))
                };
                p[..4].copy_from_slice(&[
                    on(InvertChannel::Red),
                    on(InvertChannel::Green),
                    on(InvertChannel::Blue),
                    e.blend_with_original as f32,
                ]);
                INVERT
            }
            Effect::Posterize(e) => {
                // Steps are `level - 1`; the rounding happens once, here.
                p[0] = (e.level.round().clamp(2.0, 255.0) - 1.0) as f32;
                POSTERIZE
            }
            Effect::Threshold(e) => {
                p[0] = e.level as f32;
                THRESHOLD
            }
            Effect::Vibrance(e) => {
                p[..2].copy_from_slice(&[e.vibrance as f32, e.saturation as f32]);
                VIBRANCE
            }
            Effect::Tritone(e) => {
                // Shadows, midtones, highlights as rgb; p[12] is the share of the ramp.
                p[..3].copy_from_slice(&colour(e.shadows)[..3]);
                p[4..7].copy_from_slice(&colour(e.midtones)[..3]);
                p[8..11].copy_from_slice(&colour(e.highlights)[..3]);
                p[12] = (1.0 - e.blend_with_original) as f32;
                TRITONE
            }
            Effect::ChannelMixer(e) => {
                for (i, row) in [e.red, e.green, e.blue].iter().enumerate() {
                    p[i * 4..i * 4 + 4].copy_from_slice(&[
                        row.red as f32,
                        row.green as f32,
                        row.blue as f32,
                        row.constant as f32,
                    ]);
                }
                p[12] = f32::from(u8::from(e.monochrome));
                CHANNEL_MIXER
            }
            Effect::ColorBalance(e) => {
                for (i, s) in [e.shadows, e.midtones, e.highlights].iter().enumerate() {
                    p[i * 3..i * 3 + 3].copy_from_slice(&[
                        s.red as f32,
                        s.green as f32,
                        s.blue as f32,
                    ]);
                }
                p[9] = f32::from(u8::from(e.preserve_luminosity));
                COLOR_BALANCE
            }
            Effect::GammaPedestalGain(e) => {
                for (i, c) in [e.red, e.green, e.blue].iter().enumerate() {
                    p[i * 3..i * 3 + 3].copy_from_slice(&[
                        c.gamma as f32,
                        c.pedestal as f32,
                        c.gain as f32,
                    ]);
                }
                p[9] = e.black_stretch as f32;
                GAMMA_PEDESTAL_GAIN
            }
            Effect::ColorBalanceHls(e) => {
                p[..3].copy_from_slice(&[
                    (e.hue / 360.0) as f32,
                    e.lightness as f32,
                    e.saturation as f32,
                ]);
                COLOR_BALANCE_HLS
            }
            Effect::BlackWhite(e) => {
                p[..6].copy_from_slice(&[
                    e.reds as f32,
                    e.yellows as f32,
                    e.greens as f32,
                    e.cyans as f32,
                    e.blues as f32,
                    e.magentas as f32,
                ]);
                p[6] = f32::from(u8::from(e.tint));
                // The tint colour's hue and saturation, in the working space; the greyscale is its lightness.
                let tint = colour(e.tint_color);
                let [h, s, _] = rgb_to_hsl([tint[0], tint[1], tint[2]]);
                p[7] = h;
                p[8] = s;
                BLACK_WHITE
            }
            Effect::PhotoFilter(e) => {
                let filter = match e.filter.srgb8() {
                    Some([r, g, b]) => colour(gx_contracts::color::Rgba {
                        r: f64::from(r) / 255.0,
                        g: f64::from(g) / 255.0,
                        b: f64::from(b) / 255.0,
                        a: 1.0,
                        space: gx_contracts::color::SourceColorSpace::Srgb,
                    }),
                    None => colour(e.color),
                };
                p[..3].copy_from_slice(&filter[..3]);
                p[3] = e.density as f32;
                p[4] = f32::from(u8::from(e.preserve_luminosity));
                PHOTO_FILTER
            }
            Effect::LeaveColor(e) => {
                let keep = colour(e.color);
                p[0] = e.amount as f32;
                p[1..4].copy_from_slice(&keep[..3]);
                p[4] = e.tolerance as f32;
                p[5] = e.edge_softness as f32;
                p[6] = f32::from(u8::from(
                    e.match_colors == gx_contracts::effect::LeaveMatch::Hue,
                ));
                p[7] = rgb_to_hsl([keep[0], keep[1], keep[2]])[0];
                LEAVE_COLOR
            }
            Effect::VideoLimiter(e) => {
                use gx_contracts::effect::LimiterMethod;
                let level = e.clip_level.fraction() as f32;
                p[0] = level;
                p[1] = match e.clip_method {
                    LimiterMethod::Luma => 0.0,
                    LimiterMethod::Chroma => 1.0,
                    LimiterMethod::SmartLimit => 2.0,
                };
                // Where the soft knee starts.
                p[2] = level * (1.0 - e.compression_before_clipping.fraction() as f32);
                p[3] = f32::from(u8::from(e.gamut_warning));
                let warn = colour(e.gamut_warning_color);
                p[4..7].copy_from_slice(&warn[..3]);
                VIDEO_LIMITER
            }
            Effect::BroadcastColors(e) => {
                use gx_contracts::effect::{BroadcastAction, BroadcastLocale};
                let pal = e.locale == BroadcastLocale::Pal;
                p[0] = f32::from(u8::from(pal));
                p[1] = match e.how_to_make_safe {
                    BroadcastAction::ReduceLuminance => 0.0,
                    BroadcastAction::ReduceSaturation => 1.0,
                    BroadcastAction::KeyOutUnsafe => 2.0,
                    BroadcastAction::KeyOutSafe => 3.0,
                };
                // The largest luma plus chroma that is still inside the signal limit.
                let (setup, span) = if pal { (0.0, 100.0) } else { (7.5, 92.5) };
                p[2] = (e.max_signal as f32 - setup) / span;
                BROADCAST_COLORS
            }
            Effect::CcToner(e) => {
                use gx_contracts::effect::TonerTones;
                // The stops, dark to light, in the working space: two, three or five.
                let stops: Vec<[f32; 4]> = match e.tones {
                    TonerTones::Duotone => vec![e.shadows, e.highlights],
                    TonerTones::Tritone => vec![e.shadows, e.midtones, e.highlights],
                    TonerTones::Pentone => {
                        vec![e.shadows, e.darktones, e.midtones, e.brights, e.highlights]
                    }
                }
                .into_iter()
                .map(colour)
                .collect();
                for (k, stop) in stops.iter().enumerate() {
                    p[3 * k..3 * k + 3].copy_from_slice(&stop[..3]);
                }
                p[15] = (stops.len() - 1) as f32;
                p[16] = e.blend as f32;
                CC_TONER
            }
            Effect::CcColorOffset(e) => {
                // A full turn is the whole range; a negative phase wraps to its positive twin.
                let turn = |degrees: f64| (degrees / 360.0).rem_euclid(1.0) as f32;
                p[0] = turn(e.red_phase);
                p[1] = turn(e.green_phase);
                p[2] = turn(e.blue_phase);
                p[3] = match e.overflow {
                    gx_contracts::effect::ColorOverflow::Wrap => 0.0,
                    gx_contracts::effect::ColorOverflow::Solarize => 1.0,
                    gx_contracts::effect::ColorOverflow::Polarize => 2.0,
                };
                CC_COLOR_OFFSET
            }
            Effect::CcThreshold(e) => {
                use gx_contracts::effect::ThresholdChannel;
                p[0] = (e.threshold / 255.0) as f32;
                p[1] = match e.channel {
                    ThresholdChannel::Luminance => 0.0,
                    ThresholdChannel::Rgb => 1.0,
                    ThresholdChannel::Saturation => 2.0,
                    ThresholdChannel::Alpha => 3.0,
                };
                p[2] = f32::from(u8::from(e.invert));
                p[3] = e.blend as f32;
                CC_THRESHOLD
            }
            Effect::CcThresholdRgb(e) => {
                p[0] = (e.red_threshold / 255.0) as f32;
                p[1] = (e.green_threshold / 255.0) as f32;
                p[2] = (e.blue_threshold / 255.0) as f32;
                p[3] = f32::from(u8::from(e.invert_red));
                p[4] = f32::from(u8::from(e.invert_green));
                p[5] = f32::from(u8::from(e.invert_blue));
                p[6] = e.blend as f32;
                CC_THRESHOLD_RGB
            }
            Effect::ChangeColor(e) => {
                use gx_contracts::effect::{ChangeColorView, ChangeMatch};
                let view = e.view == ChangeColorView::ColorCorrectionMask;
                let (dh, dl, ds) = (
                    (e.hue_transform / 360.0) as f32,
                    e.lightness_transform as f32,
                    e.saturation_transform as f32,
                );
                // Nothing to change and no matte to show: the picture, exactly.
                if !view && dh == 0.0 && dl == 0.0 && ds == 0.0 {
                    self.kind = IDENTITY;
                    return;
                }
                let key = colour(e.color_to_change);
                p[0] = f32::from(u8::from(view));
                p[1] = dh;
                p[2] = dl;
                p[3] = ds;
                p[4..7].copy_from_slice(&key[..3]);
                p[7] = e.matching_tolerance as f32;
                p[8] = e.matching_softness as f32;
                p[9] = match e.match_colors {
                    ChangeMatch::Rgb => 0.0,
                    ChangeMatch::Hue => 1.0,
                    ChangeMatch::Chroma => 2.0,
                };
                p[10] = f32::from(u8::from(e.invert_mask));
                // The key's hue, and its chromaticity, as the matches compare against them.
                p[11] = rgb_to_hsl([key[0], key[1], key[2]])[0];
                let sum = (key[0] + key[1] + key[2]).max(1e-6);
                p[12] = key[0] / sum;
                p[13] = key[1] / sum;
                CHANGE_COLOR
            }
            Effect::ShiftChannels(e) => {
                use gx_contracts::effect::ChannelSource;
                p[0] = channel_source_code(e.take_red_from);
                p[1] = channel_source_code(e.take_green_from);
                p[2] = channel_source_code(e.take_blue_from);
                p[3] = channel_source_code(e.take_alpha_from);
                if e.take_red_from == ChannelSource::Red
                    && e.take_green_from == ChannelSource::Green
                    && e.take_blue_from == ChannelSource::Blue
                    && e.take_alpha_from == ChannelSource::Alpha
                {
                    // Every channel from itself: the picture, exactly.
                    self.kind = IDENTITY;
                    return;
                }
                SHIFT_CHANNELS
            }
            Effect::LinearColorKey(e) => {
                use gx_contracts::effect::{KeyMatch, KeyOperation, KeyView};
                let key = colour(e.key_color);
                p[0..3].copy_from_slice(&key[..3]);
                p[3] = e.tolerance as f32;
                p[4] = e.softness as f32;
                p[5] = match e.match_colors {
                    KeyMatch::Rgb => 0.0,
                    KeyMatch::Hue => 1.0,
                    KeyMatch::Chroma => 2.0,
                };
                p[6] = f32::from(u8::from(e.key_operation == KeyOperation::KeepColors));
                p[7] = match e.view {
                    KeyView::FinalOutput => 0.0,
                    KeyView::SourceOnly => 1.0,
                    KeyView::MatteOnly => 2.0,
                };
                // The key's chromaticity, and its hue, as every pixel is compared with them.
                let sum = key[0] + key[1] + key[2];
                let (kx, ky) = if sum <= 1e-6 {
                    (1.0 / 3.0, 1.0 / 3.0)
                } else {
                    (key[0] / sum, key[1] / sum)
                };
                p[8] = kx;
                p[9] = ky;
                p[10] = rgb_to_hsl([key[0], key[1], key[2]])[0];
                LINEAR_COLOR_KEY
            }
            Effect::RemoveColorMatting(e) => {
                let bg = colour(e.background_color);
                p[0..3].copy_from_slice(&bg[..3]);
                p[3] = f32::from(u8::from(e.clip_hdr));
                REMOVE_COLOR_MATTING
            }
            Effect::Extract(e) => {
                use gx_contracts::effect::ExtractChannel;
                p[0] = match e.channel {
                    ExtractChannel::Luminance => 0.0,
                    ExtractChannel::Red => 1.0,
                    ExtractChannel::Green => 2.0,
                    ExtractChannel::Blue => 3.0,
                    ExtractChannel::Alpha => 4.0,
                };
                p[1] = e.black_point as f32;
                p[2] = e.white_point as f32;
                p[3] = e.black_softness as f32;
                p[4] = e.white_softness as f32;
                p[5] = f32::from(u8::from(e.invert));
                EXTRACT
            }
            Effect::CcColorNeutralizer(e) => {
                // Each zone's push is its balance colour less its unbalance colour.
                let mut idle = true;
                for (zone, (unbalance, balance)) in [
                    (e.shadows_unbalance, e.shadows_balance),
                    (e.midtones_unbalance, e.midtones_balance),
                    (e.highlights_unbalance, e.highlights_balance),
                ]
                .into_iter()
                .enumerate()
                {
                    let (u, b) = (colour(unbalance), colour(balance));
                    for k in 0..3 {
                        let d = b[k] - u[k];
                        p[zone * 3 + k] = d;
                        idle &= d == 0.0;
                    }
                }
                p[9] = e.pinning as f32;
                p[10] = e.blend_with_original as f32;
                p[11] = e.contrast as f32;
                p[12] = e.darks as f32;
                p[13] = e.brights as f32;
                if idle && e.contrast == 0.0 && e.darks == 0.0 && e.brights == 0.0 {
                    self.kind = IDENTITY;
                    return;
                }
                CC_COLOR_NEUTRALIZER
            }
            Effect::Unmult(e) => {
                use gx_contracts::effect::UnmultBackground;
                let white = e.background == UnmultBackground::White;
                p[0] = f32::from(u8::from(white));
                p[1] = if white { e.white_level } else { e.black_level }.clamp(0.0, 1.0) as f32;
                p[2] = e.softness.clamp(0.0, 1.0) as f32;
                p[3] = f32::from(u8::from(e.remove_color_matting));
                p[4] = f32::from(u8::from(e.clip_hdr));
                UNMULT
            }
            Effect::SpillSuppressor(e) => {
                use gx_contracts::effect::SpillAccuracy;
                let key = colour(e.color_to_suppress);
                p[3] = e.suppression as f32;
                if e.color_accuracy == SpillAccuracy::Better {
                    let mean = (key[0] + key[1] + key[2]) / 3.0;
                    let kc = [key[0] - mean, key[1] - mean, key[2] - mean];
                    let norm = (kc[0] * kc[0] + kc[1] * kc[1] + kc[2] * kc[2]).sqrt();
                    if norm < 1e-5 {
                        // A grey has no cast to take out.
                        self.kind = IDENTITY;
                        return;
                    }
                    p[4] = 1.0;
                    p[5] = kc[0] / norm;
                    p[6] = kc[1] / norm;
                    p[7] = kc[2] / norm;
                } else {
                    // The key's strongest channel, then the other two in order.
                    let (strong, other_a, other_b) = if key[1] >= key[0] && key[1] >= key[2] {
                        (1.0, 0.0, 2.0)
                    } else if key[2] >= key[0] && key[2] >= key[1] {
                        (2.0, 0.0, 1.0)
                    } else {
                        (0.0, 1.0, 2.0)
                    };
                    p[0] = strong;
                    p[1] = other_a;
                    p[2] = other_b;
                }
                SPILL_SUPPRESSOR
            }
            Effect::ColorRange(e) => {
                use gx_contracts::effect::RangeSpace;
                p[0] = e.fuzziness as f32;
                p[1] = match e.color_space {
                    RangeSpace::Lab => 0.0,
                    RangeSpace::Yuv => 1.0,
                    RangeSpace::Rgb => 2.0,
                };
                p[2..8].copy_from_slice(&[
                    e.min_l as f32,
                    e.max_l as f32,
                    e.min_a as f32,
                    e.max_a as f32,
                    e.min_b as f32,
                    e.max_b as f32,
                ]);
                // The bounds are on display-encoded sRGB: a linear project encodes first.
                p[8] = f32::from(u8::from(space != WorkingColorSpace::Srgb));
                COLOR_RANGE
            }
            Effect::Arithmetic(e) => {
                use gx_contracts::effect::ArithmeticOperator as Op;
                p[0] = match e.operator {
                    Op::And => 0.0,
                    Op::Or => 1.0,
                    Op::Xor => 2.0,
                    Op::Add => 3.0,
                    Op::Subtract => 4.0,
                    Op::Difference => 5.0,
                    Op::Min => 6.0,
                    Op::Max => 7.0,
                    Op::BlockAbove => 8.0,
                    Op::BlockBelow => 9.0,
                    Op::Slice => 10.0,
                    Op::Multiply => 11.0,
                    Op::Screen => 12.0,
                };
                // Each setting on 0 to 1, as EffectCraft divides the f32 of the setting by 255.
                p[1] = e.red_value as f32 / 255.0;
                p[2] = e.green_value as f32 / 255.0;
                p[3] = e.blue_value as f32 / 255.0;
                p[4] = f32::from(u8::from(e.clip));
                ARITHMETIC
            }
            Effect::ColorDifferenceKey(e) => {
                use gx_contracts::effect::{ColorDiffView, MatchAccuracy};
                if e.view == ColorDiffView::Source {
                    // The picture as it came in: nothing to do.
                    self.kind = IDENTITY;
                    return;
                }
                p[0] = match e.view {
                    ColorDiffView::Source => 0.0,
                    ColorDiffView::UncorrectedMatteA => 1.0,
                    ColorDiffView::CorrectedMatteA => 2.0,
                    ColorDiffView::UncorrectedMatteB => 3.0,
                    ColorDiffView::CorrectedMatteB => 4.0,
                    ColorDiffView::UncorrectedMatte => 5.0,
                    ColorDiffView::CorrectedMatte => 6.0,
                    ColorDiffView::FinalOutput => 7.0,
                };
                let accurate = e.color_matching_accuracy == MatchAccuracy::MoreAccurate;
                let linear_project = space != WorkingColorSpace::Srgb;
                p[1] = f32::from(u8::from(accurate));
                // The key colour is measured as the pixels are: on display values, then on light
                // if the accuracy asks for it.
                let key = colour(e.key_color);
                let display = if linear_project {
                    [
                        srgb_encode(key[0]),
                        srgb_encode(key[1]),
                        srgb_encode(key[2]),
                    ]
                } else {
                    [key[0], key[1], key[2]]
                };
                let k = if accurate {
                    display.map(|v| srgb_decode(v.clamp(0.0, 1.0)))
                } else {
                    display
                };
                // The key's strongest channel and the other two (ties go to green, then blue).
                let (pi, o1, o2) = if k[1] >= k[0] && k[1] >= k[2] {
                    (1usize, 0usize, 2usize)
                } else if k[2] >= k[0] && k[2] >= k[1] {
                    (2, 0, 1)
                } else {
                    (0, 1, 2)
                };
                p[2] = f32::from(u8::from(linear_project));
                p[3] = pi as f32;
                p[4] = o1 as f32;
                p[5] = o2 as f32;
                p[6] = (k[pi] - k[o1]).max(1e-3);
                p[7] = (k[pi] - k[o2]).max(1e-3);
                for (slot, l) in [(8, e.partial_a), (13, e.partial_b)] {
                    p[slot..slot + 5].copy_from_slice(&[
                        l.in_black as f32,
                        l.in_white as f32,
                        l.gamma as f32,
                        l.out_black as f32,
                        l.out_white as f32,
                    ]);
                }
                p[18] = e.matte_black as f32;
                p[19] = e.matte_white as f32;
                p[20] = e.matte_gamma as f32;
                COLOR_DIFFERENCE_KEY
            }
            Effect::SelectiveColor(e) => {
                use gx_contracts::effect::SelectiveMethod;
                let ranges = [
                    e.reds, e.yellows, e.greens, e.cyans, e.blues, e.magentas, e.whites,
                    e.neutrals, e.blacks,
                ];
                if ranges
                    .iter()
                    .all(|r| r.cyan == 0.0 && r.magenta == 0.0 && r.yellow == 0.0 && r.black == 0.0)
                {
                    // Nothing to shift: the picture as it came in.
                    self.kind = IDENTITY;
                    return;
                }
                p[0] = f32::from(u8::from(e.method == SelectiveMethod::Relative));
                // Nine ranges of four inks from slot 1: cyan, magenta, yellow, black.
                for (r, ink) in ranges.iter().enumerate() {
                    let base = 1 + 4 * r;
                    p[base] = ink.cyan as f32;
                    p[base + 1] = ink.magenta as f32;
                    p[base + 2] = ink.yellow as f32;
                    p[base + 3] = ink.black as f32;
                }
                SELECTIVE_COLOR
            }
            _ => IDENTITY,
        };
    }
}

/// Monotone cubic (Fritsch–Carlson) through the sorted, de-duplicated
/// points, tabulated over 0..=1, with the end slopes for extension.
fn fill_curve(points: &[gx_contracts::effect::CurvePoint], out: &mut [f32]) {
    let mut pts: Vec<(f32, f32)> = points.iter().map(|p| (p.x as f32, p.y as f32)).collect();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-6);
    if pts.len() < 2 {
        pts = vec![(0.0, 0.0), (1.0, 1.0)];
    }
    let xs: Vec<f32> = pts.iter().map(|p| p.0).collect();
    let ys: Vec<f32> = pts.iter().map(|p| p.1).collect();
    let n = xs.len();
    let d: Vec<f32> = (0..n - 1)
        .map(|k| (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]))
        .collect();
    let mut ms = vec![0.0f32; n];
    ms[0] = d[0];
    ms[n - 1] = d[n - 2];
    for k in 1..n - 1 {
        ms[k] = if d[k - 1] * d[k] <= 0.0 {
            0.0
        } else {
            (d[k - 1] + d[k]) * 0.5
        };
    }
    for k in 0..n - 1 {
        if d[k].abs() < 1e-12 {
            ms[k] = 0.0;
            ms[k + 1] = 0.0;
        } else {
            let a = ms[k] / d[k];
            let b = ms[k + 1] / d[k];
            let s = a * a + b * b;
            if s > 9.0 {
                let t = 3.0 / s.sqrt();
                ms[k] = t * a * d[k];
                ms[k + 1] = t * b * d[k];
            }
        }
    }
    let eval = |x: f32| {
        if x <= xs[0] {
            return ys[0] + (x - xs[0]) * ms[0];
        }
        if x >= xs[n - 1] {
            return ys[n - 1] + (x - xs[n - 1]) * ms[n - 1];
        }
        let k = xs.partition_point(|&v| v <= x).saturating_sub(1).min(n - 2);
        let h = xs[k + 1] - xs[k];
        let t = (x - xs[k]) / h;
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * ys[k]
            + (t3 - 2.0 * t2 + t) * h * ms[k]
            + (-2.0 * t3 + 3.0 * t2) * ys[k + 1]
            + (t3 - t2) * h * ms[k + 1]
    };
    for (i, slot) in out[..=LUT_N].iter_mut().enumerate() {
        *slot = eval(i as f32 / LUT_N as f32);
    }
    out[LUT_N + 1..CURVE_BLOCK].copy_from_slice(&[
        xs[0],
        ys[0],
        ms[0],
        xs[n - 1],
        ys[n - 1],
        ms[n - 1],
    ]);
}

fn fill_curves(c: &Curves, out: &mut [f32]) {
    for (i, points) in [&c.rgb, &c.red, &c.green, &c.blue, &c.alpha]
        .into_iter()
        .enumerate()
    {
        fill_curve(points, &mut out[i * CURVE_BLOCK..(i + 1) * CURVE_BLOCK]);
    }
}

fn curve_eval(table: &[f32], channel: usize, v: f32) -> f32 {
    let t = &table[channel * CURVE_BLOCK..(channel + 1) * CURVE_BLOCK];
    let e = &t[LUT_N + 1..];
    if v < 0.0 {
        return e[1] + (v - e[0]) * e[2];
    }
    if v > 1.0 {
        return e[4] + (v - e[3]) * e[5];
    }
    let f = v * LUT_N as f32;
    let i = (f.floor() as usize).min(LUT_N - 1);
    let w = f - i as f32;
    t[i] + (t[i + 1] - t[i]) * w
}

/// A channel source's number in the kernel: its place in Shift Channels' own list.
fn channel_source_code(source: gx_contracts::effect::ChannelSource) -> f32 {
    use gx_contracts::effect::ChannelSource as S;
    match source {
        S::Alpha => 0.0,
        S::Red => 1.0,
        S::Green => 2.0,
        S::Blue => 3.0,
        S::Luminance => 4.0,
        S::Hue => 5.0,
        S::Lightness => 6.0,
        S::Saturation => 7.0,
        S::FullOn => 8.0,
        S::HalfOn => 9.0,
        S::FullOff => 10.0,
    }
}

/// The value Shift Channels reads for `source` (a code from [`channel_source_code`]).
fn channel_source_value(source: f32, c: [f32; 3], a: f32) -> f32 {
    match source as u32 {
        0 => a,
        1 => c[0],
        2 => c[1],
        3 => c[2],
        4 => rec709_luminance(c),
        5 => rgb_to_hsl(c)[0],
        6 => rgb_to_hsl(c)[2],
        7 => rgb_to_hsl(c)[1],
        8 => 1.0,
        9 => 0.5,
        _ => 0.0,
    }
}

/// Video Limiter's knee: unchanged up to `start`, then an exponential approach to `limit`.
fn soft_knee(v: f32, start: f32, limit: f32) -> f32 {
    if v <= start || limit <= start {
        return v.min(limit);
    }
    let r = limit - start;
    start + r * (1.0 - (-(v - start) / r).exp())
}

fn smooth_step(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// CIE Lab of a straight sRGB colour, as EffectCraft's `to_lab`: clamped to 0 to 1, linearised,
/// to XYZ with the D65 white 0.95047 and 1.08883 (Y is 1), then the Lab companding.
fn to_lab(c: [f32; 3]) -> [f32; 3] {
    let l = c.map(|v| srgb_decode(v.clamp(0.0, 1.0)));
    let x = (0.4124 * l[0] + 0.3576 * l[1] + 0.1805 * l[2]) / 0.95047;
    let y = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
    let z = (0.0193 * l[0] + 0.1192 * l[1] + 0.9505 * l[2]) / 1.08883;
    let f = |t: f32| {
        if t > 0.008_856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// A colour on the 0 to 255 axes of the space Color Range measures in (1 is YUV, 2 is RGB, else Lab).
fn range_components(space: u32, c: [f32; 3]) -> [f32; 3] {
    match space {
        1 => {
            let y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
            let u = -0.147_13 * c[0] - 0.288_86 * c[1] + 0.436 * c[2];
            let v = 0.615 * c[0] - 0.514_99 * c[1] - 0.100_01 * c[2];
            [y * 255.0, u * 255.0 + 128.0, v * 255.0 + 128.0]
        }
        2 => c.map(|v| v * 255.0),
        _ => {
            let lab = to_lab(c);
            [lab[0] * 2.55, lab[1] + 128.0, lab[2] + 128.0]
        }
    }
}

/// How much a colour belongs to each Selective Color range, in the order reds, yellows, greens,
/// cyans, blues, magentas, whites, neutrals, blacks (EffectCraft's `color2::sc_weights`).
/// The channel order is a stable sort, largest first, so a tie keeps red, green, blue order; the
/// GPU kernel sorts the same way.
fn selective_weights(c: [f32; 3]) -> [f32; 9] {
    let c = c.map(|v| v.clamp(0.0, 1.0));
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&a, &b| c[b].total_cmp(&c[a]));
    let (mx, md, mn) = (c[idx[0]], c[idx[1]], c[idx[2]]);
    let mut w = [0.0f32; 9];
    // A primary's weight is its lead over the middle channel, when it is the largest.
    w[[0, 2, 4][idx[0]]] = mx - md;
    // A secondary's weight is the middle channel's lead over the smallest, when the primary
    // opposite it is the smallest.
    w[[3, 5, 1][idx[2]]] = md - mn;
    w[6] = ((mn - 0.5) * 2.0).max(0.0);
    w[8] = ((0.5 - mx) * 2.0).max(0.0);
    w[7] = (1.0 - ((mx - 0.5).abs() + (mn - 0.5).abs())).clamp(0.0, 1.0);
    w
}

/// Levels on a 0 to 1 matte value: input black and white (0 to 255), gamma, output black and white.
fn matte_levels(v: f32, in_b: f32, in_w: f32, gamma: f32, out_b: f32, out_w: f32) -> f32 {
    let t = ((v - in_b / 255.0) / ((in_w - in_b) / 255.0).max(1e-4)).clamp(0.0, 1.0);
    let t = powz(t, 1.0 / gamma.max(0.01));
    (out_b / 255.0 + t * (out_w - out_b) / 255.0).clamp(0.0, 1.0)
}

fn rec709_luminance(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn level(v: f32, p: &[f32], clip_black: bool, clip_white: bool) -> f32 {
    let mut t = (v - p[0]) / (p[1] - p[0]).max(1e-6);
    if clip_black {
        t = t.max(0.0);
    }
    if clip_white {
        t = t.min(1.0);
    }
    let t = powz(t.max(0.0), p[2]);
    p[3] + (p[4] - p[3]) * t
}

fn rgb_to_hsl(c: [f32; 3]) -> [f32; 3] {
    let max = c[0].max(c[1]).max(c[2]);
    let min = c[0].min(c[1]).min(c[2]);
    let l = (max + min) * 0.5;
    let d = max - min;
    if d < 1e-7 {
        return [0.0, 0.0, l];
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == c[0] {
        ((c[1] - c[2]) / d + if c[1] < c[2] { 6.0 } else { 0.0 }) / 6.0
    } else if max == c[1] {
        ((c[2] - c[0]) / d + 2.0) / 6.0
    } else {
        ((c[0] - c[1]) / d + 4.0) / 6.0
    };
    [h, s, l]
}

fn hsl_channel(p: f32, q: f32, t: f32) -> f32 {
    let t = t - t.floor();
    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 0.5 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

fn hsl_to_rgb([h, s, l]: [f32; 3]) -> [f32; 3] {
    if s <= 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    [
        hsl_channel(p, q, h + 1.0 / 3.0),
        hsl_channel(p, q, h),
        hsl_channel(p, q, h - 1.0 / 3.0),
    ]
}

/// The sRGB transfer in f32, the same expression the kernel evaluates.
pub fn srgb_decode(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        powz((v + 0.055) / 1.055, 2.4)
    }
}

pub fn srgb_encode(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * powz(v, 1.0 / 2.4) - 0.055
    }
}

/// `x^y` for x >= 0, exact for y == 1, as the kernel's `powz`.
fn powz(x: f32, y: f32) -> f32 {
    if x <= 0.0 {
        return if y == 0.0 { 1.0 } else { 0.0 };
    }
    if y == 1.0 {
        return x;
    }
    x.powf(y)
}

fn mirror_pow(v: f32, p: f32) -> f32 {
    powz(v.abs(), p).copysign(v)
}

fn bc_modern(v: f32, exponent: f32, gain: f32) -> f32 {
    if v >= 1.0 {
        return v;
    }
    let v = powz(v.max(0.0), exponent);
    if v < 0.5 {
        0.5 * powz(2.0 * v, gain)
    } else {
        1.0 - 0.5 * powz((2.0 - 2.0 * v).max(0.0), gain)
    }
}

/// Apply one packed effect to one premultiplied pixel.
pub fn apply_pixel(e: &PackedEffect, px: WorkingRgba) -> WorkingRgba {
    if e.kind == IDENTITY || !covers(px.a) {
        return px;
    }
    let p = &e.params;
    let a = px.a;
    let c = [px.r / a, px.g / a, px.b / a];
    let (c, a) = match e.kind {
        FILL => {
            // Repaint the colour, keeping coverage.
            let k = p[3];
            (
                [
                    c[0] + (p[0] - c[0]) * k,
                    c[1] + (p[1] - c[1]) * k,
                    c[2] + (p[2] - c[2]) * k,
                ],
                a,
            )
        }
        TINT => {
            let l = rec709_luminance(c).clamp(0.0, 1.0);
            let t = [
                p[0] + (p[4] - p[0]) * l,
                p[1] + (p[5] - p[1]) * l,
                p[2] + (p[6] - p[2]) * l,
            ];
            let k = p[8] * (p[3] + (p[7] - p[3]) * l);
            (
                [
                    c[0] + (t[0] - c[0]) * k,
                    c[1] + (t[1] - c[1]) * k,
                    c[2] + (t[2] - c[2]) * k,
                ],
                a,
            )
        }
        LEVELS => {
            let (cb, cw) = (p[25] > 0.5, p[26] > 0.5);
            let master = [0, 1, 2].map(|i| level(c[i], &p[0..5], cb, cw));
            let own = [0, 1, 2].map(|i| level(master[i], &p[5 + i * 5..10 + i * 5], cb, cw));
            (own, level(a, &p[20..25], cb, cw).clamp(0.0, 1.0))
        }
        CURVES => {
            let t = &e.curve;
            let own = [0, 1, 2].map(|i| curve_eval(t, 1 + i, curve_eval(t, 0, c[i])));
            (own, curve_eval(t, 4, a).clamp(0.0, 1.0))
        }
        // No hue shift, saturation or lightness change is an identity: the
        // HSL round trip would move a value by its rounding.
        HUE_SATURATION if p[3] <= 0.5 && p[0].fract() == 0.0 && p[1] == 0.0 && p[2] == 0.0 => {
            (c, a)
        }
        HUE_SATURATION => {
            let [h, s, l] = rgb_to_hsl(c);
            let hsl = if p[3] > 0.5 {
                let cl = p[6];
                [
                    p[4],
                    p[5],
                    (l + cl * if cl > 0.0 { 1.0 - l } else { l }).clamp(0.0, 1.0),
                ]
            } else {
                let sat = p[1];
                let s2 = if sat >= 0.0 {
                    s + (1.0 - s) * sat * s.min(1.0)
                } else {
                    s * (1.0 + sat)
                };
                let light = p[2];
                let l2 = if light >= 0.0 {
                    l + (1.0 - l) * light
                } else {
                    l * (1.0 + light)
                };
                let h2 = h + p[0];
                [h2 - h2.floor(), s2.clamp(0.0, 1.0), l2]
            };
            (hsl_to_rgb(hsl), a)
        }
        BRIGHTNESS_CONTRAST => {
            let out = if p[2] > 0.5 {
                c.map(|v| ((v + p[0] - 0.5) * p[3] + 0.5).max(0.0))
            } else if p[0] == 0.0 && p[1] == 0.0 {
                c
            } else {
                c.map(|v| bc_modern(v, p[4], p[5]))
            };
            (out, a)
        }
        EXPOSURE => {
            let out = c.map(|v| {
                if p[3] > 0.5 {
                    let o = mirror_pow(srgb_decode(v.max(0.0)) * p[0] + p[1], p[2]);
                    srgb_encode(o.abs()).copysign(o)
                } else {
                    mirror_pow(v * p[0] + p[1], p[2])
                }
            });
            (out, a)
        }
        INVERT => {
            let mut out = c;
            for (i, v) in out.iter_mut().enumerate() {
                if p[i] > 0.5 {
                    let inverted = 1.0 - *v;
                    *v = inverted + (*v - inverted) * p[3];
                }
            }
            (out, a)
        }
        POSTERIZE => {
            // Round half up on both sides: WGSL's `round` goes to even.
            let steps = p[0];
            (
                c.map(|v| (v.clamp(0.0, 1.0) * steps + 0.5).floor() / steps),
                a,
            )
        }
        THRESHOLD => {
            let v = if rec709_luminance(c) >= p[0] {
                1.0
            } else {
                0.0
            };
            ([v; 3], a)
        }
        // No vibrance and no saturation is an identity: the HSL round trip
        // would move a value by its rounding.
        VIBRANCE if p[0] == 0.0 && p[1] == 0.0 => (c, a),
        VIBRANCE => {
            let [h, s, l] = rgb_to_hsl(c);
            let s2 = (s * (1.0 + p[1]) + p[0] * (1.0 - s) * s.min(0.5)).clamp(0.0, 1.0);
            (hsl_to_rgb([h, s2, l]), a)
        }
        TRITONE => {
            let l = rec709_luminance(c).clamp(0.0, 1.0);
            let mix = |a: [f32; 3], b: [f32; 3], t: f32| {
                [
                    a[0] + (b[0] - a[0]) * t,
                    a[1] + (b[1] - a[1]) * t,
                    a[2] + (b[2] - a[2]) * t,
                ]
            };
            let (sh, md, hi) = ([p[0], p[1], p[2]], [p[4], p[5], p[6]], [p[8], p[9], p[10]]);
            let t = if l < 0.5 {
                mix(sh, md, l * 2.0)
            } else {
                mix(md, hi, (l - 0.5) * 2.0)
            };
            (mix(c, t, p[12]), a)
        }
        CHANNEL_MIXER => {
            let row =
                |r: usize| (c[0] * p[r] + c[1] * p[r + 1] + c[2] * p[r + 2] + p[r + 3]).max(0.0);
            if p[12] > 0.5 {
                ([row(0); 3], a)
            } else {
                ([row(0), row(4), row(8)], a)
            }
        }
        COLOR_BALANCE => {
            let l = rec709_luminance(c).clamp(0.0, 1.0);
            let ws = (1.0 - l * 2.0).clamp(0.0, 1.0);
            let wh = (l * 2.0 - 1.0).clamp(0.0, 1.0);
            let wm = 1.0 - ws - wh;
            let mut o = c;
            for (i, v) in o.iter_mut().enumerate() {
                *v = (c[i] + (p[i] * ws + p[3 + i] * wm + p[6 + i] * wh) * 0.5).max(0.0);
            }
            if p[9] > 0.5 {
                // Keep the pixel's luminance, change only its colour.
                let d = rec709_luminance(c) - rec709_luminance(o);
                o = o.map(|v| (v + d).max(0.0));
            }
            (o, a)
        }
        GAMMA_PEDESTAL_GAIN => {
            let stretch = p[9];
            let mut o = c;
            for (i, v) in o.iter_mut().enumerate() {
                // Black Stretch lifts the low end and fades out by mid grey.
                let x = c[i];
                let x = if stretch > 0.0 && x > 0.0 && x < 1.0 {
                    let t = 1.0 - x;
                    let t2 = t * t;
                    x + stretch * 0.25 * x * (t2 * t2)
                } else {
                    x
                };
                let (gm, pd, gn) = (p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
                *v = (pd + (gn - pd) * powz(x.max(0.0), gm)).max(0.0);
            }
            (o, a)
        }
        COLOR_BALANCE_HLS => {
            // All three zero is an identity: the HSL round trip would move a value by its rounding.
            if p[0] == 0.0 && p[1] == 0.0 && p[2] == 0.0 {
                (c, a)
            } else {
                let [h, s, l] = rgb_to_hsl(c);
                let l = if p[1] > 0.0 {
                    l + (1.0 - l) * p[1]
                } else {
                    l + l * p[1]
                };
                let s = if p[2] > 0.0 {
                    s + (1.0 - s) * p[2]
                } else {
                    s + s * p[2]
                };
                let h = h + p[0];
                (
                    hsl_to_rgb([h - h.floor(), s.clamp(0.0, 1.0), l.clamp(0.0, 1.0)]),
                    a,
                )
            }
        }
        BLACK_WHITE => {
            let [h, s, _] = rgb_to_hsl(c);
            // The six weights are interpolated round the colour wheel, red first.
            let hp = h * 6.0;
            let i = hp.floor() as usize % 6;
            let f = hp - hp.floor();
            let weight = p[i] + (p[(i + 1) % 6] - p[i]) * f;
            let gray = (rec709_luminance(c) + (weight - 0.5) * s * 0.6).max(0.0);
            if p[6] > 0.5 {
                (hsl_to_rgb([p[7], p[8], gray.min(1.0)]), a)
            } else {
                ([gray; 3], a)
            }
        }
        // Density 0 is an identity: keeping luminosity would scale by a ratio that is not exactly 1.
        PHOTO_FILTER if p[3] == 0.0 => (c, a),
        PHOTO_FILTER => {
            let filtered = [c[0] * p[0], c[1] * p[1], c[2] * p[2]];
            let mut o = [
                c[0] + (filtered[0] - c[0]) * p[3],
                c[1] + (filtered[1] - c[1]) * p[3],
                c[2] + (filtered[2] - c[2]) * p[3],
            ];
            if p[4] > 0.5 {
                let l0 = rec709_luminance(c);
                let l1 = rec709_luminance(o).max(1e-6);
                o = o.map(|v| v * l0 / l1);
            }
            (o, a)
        }
        LEAVE_COLOR if p[0] <= 0.0 => (c, a),
        LEAVE_COLOR => {
            let distance = if p[6] > 0.5 {
                let [h, s, _] = rgb_to_hsl(c);
                // A grey has no hue: it never matches one.
                if s < 0.02 {
                    1.0
                } else {
                    let x = h - p[7] + 0.5;
                    ((x - x.floor()) - 0.5).abs() * 2.0
                }
            } else {
                let (dr, dg, db) = (c[0] - p[1], c[1] - p[2], c[2] - p[3]);
                (dr * dr + dg * dg + db * db).sqrt() / SQRT_3
            };
            let keep = if p[4] >= 1.0 || distance <= p[4] {
                1.0
            } else if p[5] <= 1e-6 {
                0.0
            } else {
                (1.0 - (distance - p[4]) / p[5]).clamp(0.0, 1.0)
            };
            let g = rec709_luminance(c);
            let k = p[0] * (1.0 - keep);
            (
                [
                    c[0] + (g - c[0]) * k,
                    c[1] + (g - c[1]) * k,
                    c[2] + (g - c[2]) * k,
                ],
                a,
            )
        }
        VIDEO_LIMITER => {
            let (level, start) = (p[0], p[2]);
            let y = rec709_luminance(c);
            let mut o = c;
            // Luma and Smart Limit: bend the luminance below the level, keep the colour offsets.
            if p[1] != 1.0 {
                let y2 = soft_knee(y.max(0.0), start, level);
                let d = y2 - y;
                o = [o[0] + d, o[1] + d, o[2] + d];
            }
            // Chroma and Smart Limit: pull the colour towards its luminance until it fits.
            if p[1] != 0.0 {
                let yl = rec709_luminance(o);
                let mut t = 1.0f32;
                for v in o {
                    if v > level && v - yl > 1e-6 {
                        t = t.min((level - yl) / (v - yl));
                    }
                    if v < 0.0 && yl - v > 1e-6 {
                        t = t.min(yl / (yl - v));
                    }
                }
                let t = t.clamp(0.0, 1.0);
                if t < 1.0 {
                    o = [
                        yl + (o[0] - yl) * t,
                        yl + (o[1] - yl) * t,
                        yl + (o[2] - yl) * t,
                    ];
                }
            }
            let o = [
                o[0].clamp(0.0, level),
                o[1].clamp(0.0, level),
                o[2].clamp(0.0, level),
            ];
            let changed = (0..3).any(|k| (c[k] - o[k]).abs() > 1e-4);
            if p[3] > 0.5 && changed {
                ([p[4], p[5], p[6]], a)
            } else {
                (o, a)
            }
        }
        BROADCAST_COLORS => {
            let limit = p[2];
            let y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
            let chroma = if p[0] > 0.5 {
                let u = 0.492 * (c[2] - y);
                let v = 0.877 * (c[0] - y);
                (u * u + v * v).sqrt()
            } else {
                let i = 0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2];
                let q = 0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2];
                (i * i + q * q).sqrt()
            };
            let unsafe_ = y + chroma > limit + 1e-5;
            if p[1] == 2.0 {
                (c, if unsafe_ { 0.0 } else { a })
            } else if p[1] == 3.0 {
                (c, if unsafe_ { a } else { 0.0 })
            } else if !unsafe_ {
                (c, a)
            } else if p[1] == 1.0 {
                let target = (limit - y).max(0.0);
                let s = if chroma > 1e-6 { target / chroma } else { 1.0 };
                let mut o = [y + (c[0] - y) * s, y + (c[1] - y) * s, y + (c[2] - y) * s];
                if y > limit {
                    let k = limit / y;
                    o = [o[0] * k, o[1] * k, o[2] * k];
                }
                (o, a)
            } else {
                let k = limit / (y + chroma);
                ([c[0] * k, c[1] * k, c[2] * k], a)
            }
        }
        CC_TONER => {
            let n = p[15] as usize;
            let t = rec709_luminance(c).clamp(0.0, 1.0) * n as f32;
            let k = (t.floor() as usize).min(n - 1);
            let f = t - k as f32;
            let blend = p[16];
            let mut o = [0.0f32; 3];
            for (i, out) in o.iter_mut().enumerate() {
                let (lo, hi) = (p[3 * k + i], p[3 * (k + 1) + i]);
                let tone = lo + (hi - lo) * f;
                *out = tone + (c[i] - tone) * blend;
            }
            (o, a)
        }
        CC_COLOR_OFFSET if p[0] == 0.0 && p[1] == 0.0 && p[2] == 0.0 => (c, a),
        CC_COLOR_OFFSET => {
            let mut o = c;
            for k in 0..3 {
                if p[k] == 0.0 {
                    continue;
                }
                let x = c[k] + p[k];
                o[k] = if x <= 1.0 {
                    x
                } else if p[3] == 1.0 {
                    (2.0 - x).max(0.0)
                } else if p[3] == 2.0 {
                    if x - 1.0 < 0.5 {
                        0.0
                    } else {
                        1.0
                    }
                } else {
                    x - x.floor()
                };
            }
            (o, a)
        }
        CC_THRESHOLD => {
            let (t, invert, blend) = (p[0], p[2] > 0.5, p[3]);
            let bin = |v: f32| if (v >= t) != invert { 1.0f32 } else { 0.0 };
            let (o, na) = match p[1] as u32 {
                1 => ([bin(c[0]), bin(c[1]), bin(c[2])], a),
                2 => ([bin(rgb_to_hsl(c)[1]); 3], a),
                3 => (c, bin(a)),
                _ => ([bin(rec709_luminance(c)); 3], a),
            };
            (
                [
                    o[0] + (c[0] - o[0]) * blend,
                    o[1] + (c[1] - o[1]) * blend,
                    o[2] + (c[2] - o[2]) * blend,
                ],
                na + (a - na) * blend,
            )
        }
        CC_THRESHOLD_RGB => {
            let blend = p[6];
            let mut o = [0.0f32; 3];
            for k in 0..3 {
                let hit = (c[k] >= p[k]) != (p[3 + k] > 0.5);
                let bin = if hit { 1.0f32 } else { 0.0 };
                o[k] = bin + (c[k] - bin) * blend;
            }
            (o, a)
        }
        CHANGE_COLOR => {
            let key = [p[4], p[5], p[6]];
            let (tol, soft) = (p[7], p[8]);
            let d = match p[9] as u32 {
                0 => {
                    let (dr, dg, db) = (c[0] - key[0], c[1] - key[1], c[2] - key[2]);
                    (dr * dr + dg * dg + db * db).sqrt() / SQRT_3
                }
                1 => {
                    let [h, s, _] = rgb_to_hsl(c);
                    let dh = (h - p[11]).abs();
                    let dh = dh.min(1.0 - dh) * 2.0;
                    // A grey has no reliable hue: it never matches one.
                    if s < 0.02 {
                        1.0
                    } else {
                        dh
                    }
                }
                _ => {
                    let sum = (c[0] + c[1] + c[2]).max(1e-6);
                    let (x, y) = (c[0] / sum - p[12], c[1] / sum - p[13]);
                    (x * x + y * y).sqrt() * 1.5
                }
            };
            let mut m = if d <= tol {
                1.0
            } else if soft <= 1e-6 {
                0.0
            } else {
                (1.0 - (d - tol) / soft).clamp(0.0, 1.0)
            };
            if p[10] > 0.5 {
                m = 1.0 - m;
            }
            if p[0] > 0.5 {
                ([m; 3], a)
            } else if m <= 0.0 {
                (c, a)
            } else {
                let [h, s, l] = rgb_to_hsl(c);
                let h2 = (h + p[1]).rem_euclid(1.0);
                let s2 = (s + p[3] * if p[3] > 0.0 { 1.0 - s } else { s }).clamp(0.0, 1.0);
                let l2 = (l + p[2] * if p[2] > 0.0 { 1.0 - l } else { l }).clamp(0.0, 1.0);
                let changed = hsl_to_rgb([h2, s2, l2]);
                (
                    [
                        c[0] + (changed[0] - c[0]) * m,
                        c[1] + (changed[1] - c[1]) * m,
                        c[2] + (changed[2] - c[2]) * m,
                    ],
                    a,
                )
            }
        }
        LINEAR_COLOR_KEY => {
            let key = [p[0], p[1], p[2]];
            let (tol, soft) = (p[3], p[4]);
            let d = match p[5] as u32 {
                0 => {
                    let (dr, dg, db) = (c[0] - key[0], c[1] - key[1], c[2] - key[2]);
                    (dr * dr + dg * dg + db * db).sqrt() / SQRT_3
                }
                1 => {
                    let [h, s, _] = rgb_to_hsl(c);
                    if s < 0.02 {
                        1.0
                    } else {
                        let dh = (h - p[10]).abs();
                        dh.min(1.0 - dh) * 2.0
                    }
                }
                _ => {
                    let sum = c[0] + c[1] + c[2];
                    let (x, y) = if sum <= 1e-6 {
                        (1.0 / 3.0, 1.0 / 3.0)
                    } else {
                        (c[0] / sum, c[1] / sum)
                    };
                    let (dx, dy) = (x - p[8], y - p[9]);
                    (dx * dx + dy * dy).sqrt() / std::f32::consts::SQRT_2
                }
            };
            let keyed = if soft > 1e-6 {
                ((d - tol) / soft).clamp(0.0, 1.0)
            } else if d > tol {
                1.0
            } else {
                0.0
            };
            let m = if p[6] > 0.5 { 1.0 - keyed } else { keyed };
            match p[7] as u32 {
                1 => (c, a),
                2 => ([(a * m).clamp(0.0, 1.0); 3], 1.0),
                _ => (c, a * m),
            }
        }
        REMOVE_COLOR_MATTING => {
            let mut o = [0.0f32; 3];
            for (k, out) in o.iter_mut().enumerate() {
                let mut v = (c[k] - p[k] * (1.0 - a)).max(0.0);
                if p[3] > 0.5 {
                    v = v.min(a);
                }
                *out = v / a;
            }
            (o, a)
        }
        EXTRACT => {
            let v = 255.0
                * match p[0] as u32 {
                    1 => c[0],
                    2 => c[1],
                    3 => c[2],
                    4 => a,
                    _ => rec709_luminance(c),
                };
            let (black, white, black_soft, white_soft) = (p[1], p[2], p[3], p[4]);
            let mut k = 1.0f32;
            if v < black {
                k = if black_soft > 0.0 {
                    (1.0 - (black - v) / black_soft).clamp(0.0, 1.0)
                } else {
                    0.0
                };
            } else if v > white {
                k = if white_soft > 0.0 {
                    (1.0 - (v - white) / white_soft).clamp(0.0, 1.0)
                } else {
                    0.0
                };
            }
            if p[5] > 0.5 {
                k = 1.0 - k;
            }
            (c, a * k)
        }
        CC_COLOR_NEUTRALIZER => {
            let l = rec709_luminance(c).clamp(0.0, 1.0);
            let shadow = 1.0 - smooth_step(0.0, 0.5, l);
            let high = smooth_step(0.5, 1.0, l);
            let mid = 1.0 - shadow - high;
            // Pinning keeps pure black and pure white fixed.
            let keep = 1.0 - p[9] * (1.0 - 4.0 * l * (1.0 - l)).clamp(0.0, 1.0);
            let mut o = [0.0f32; 3];
            for (k, out) in o.iter_mut().enumerate() {
                let push = p[k] * shadow + p[3 + k] * mid + p[6 + k] * high;
                let mut v = c[k] + push * keep;
                v = 0.5 + (v - 0.5) * (1.0 + p[11]);
                v += p[12] * 0.25 * (1.0 - l).powi(2) + p[13] * 0.25 * l * l;
                let v = v.max(0.0);
                *out = v + (c[k] - v) * p[10];
            }
            (o, a)
        }
        UNMULT => {
            let white = p[0] > 0.5;
            let level = p[1];
            let (d, start) = if white {
                (1.0 - c[0].min(c[1]).min(c[2]), 1.0 - level)
            } else {
                (c[0].max(c[1]).max(c[2]), level)
            };
            let d = d.clamp(0.0, 1.0);
            let width = p[2] * (1.0 - start);
            let m = if width > 1e-6 {
                ((d - start) / width).clamp(0.0, 1.0)
            } else if d > start {
                1.0
            } else {
                0.0
            };
            if m <= 1e-6 {
                (c, 0.0)
            } else {
                let bg = if white { 1.0 } else { 0.0 };
                let mut o = c;
                if p[3] > 0.5 {
                    o = o.map(|v| (v - bg * (1.0 - m)) / m);
                }
                if p[4] > 0.5 {
                    o = o.map(|v| v.clamp(0.0, 1.0));
                }
                (o, a * m)
            }
        }
        ARITHMETIC => {
            // And, Or and Xor work on the 8-bit values; the rest on the values themselves.
            let mut o = [0.0f32; 3];
            for (i, out) in o.iter_mut().enumerate() {
                let (v, kv) = (c[i], p[1 + i]);
                let iv = (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                let ik = (kv * 255.0).round() as u8;
                let r = match p[0] as u32 {
                    0 => f32::from(iv & ik) / 255.0,
                    1 => f32::from(iv | ik) / 255.0,
                    2 => f32::from(iv ^ ik) / 255.0,
                    3 => v + kv,
                    4 => v - kv,
                    5 => (v - kv).abs(),
                    6 => v.min(kv),
                    7 => v.max(kv),
                    8 => {
                        if v > kv {
                            0.0
                        } else {
                            v
                        }
                    }
                    9 => {
                        if v < kv {
                            0.0
                        } else {
                            v
                        }
                    }
                    10 => {
                        if v >= kv {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    11 => v * kv,
                    _ => 1.0 - (1.0 - v) * (1.0 - kv),
                };
                *out = if p[4] > 0.5 {
                    r.clamp(0.0, 1.0)
                } else {
                    r.max(0.0)
                };
            }
            (o, a)
        }
        COLOR_DIFFERENCE_KEY => {
            let display = if p[2] > 0.5 { c.map(srgb_encode) } else { c };
            let lin = if p[1] > 0.5 {
                display.map(|v| srgb_decode(v.clamp(0.0, 1.0)))
            } else {
                display
            };
            let (pi, o1, o2) = (p[3] as usize, p[4] as usize, p[5] as usize);
            let ua = 1.0 - ((lin[pi] - lin[o1]) / p[6]).clamp(0.0, 1.0);
            let ub = 1.0 - ((lin[pi] - lin[o2]) / p[7]).clamp(0.0, 1.0);
            let ca = matte_levels(ua, p[8], p[9], p[10], p[11], p[12]);
            let cb = matte_levels(ub, p[13], p[14], p[15], p[16], p[17]);
            let um = ua.max(ub);
            let cm = matte_levels(ca.max(cb), p[18], p[19], p[20], 0.0, 255.0);
            // A stage of the matte is shown as an opaque grey of the matte times the alpha.
            let grey = |m: f32| ([m * a; 3], 1.0);
            match p[0] as u32 {
                1 => grey(ua),
                2 => grey(ca),
                3 => grey(ub),
                4 => grey(cb),
                5 => grey(um),
                6 => grey(cm),
                _ => (c, a * cm),
            }
        }
        SELECTIVE_COLOR => {
            let relative = p[0] > 0.5;
            let weights = selective_weights(c);
            let mut o = c;
            for (r, w) in weights.iter().enumerate() {
                if *w <= 0.0 {
                    continue;
                }
                let base = 1 + 4 * r;
                let black = p[base + 3];
                for i in 0..3 {
                    let delta = p[base + i] + black;
                    // Relative moves a share of the ink the pixel already has; Absolute a flat amount.
                    let delta = if relative {
                        delta * (1.0 - c[i]).max(0.0)
                    } else {
                        delta
                    };
                    o[i] -= w * delta;
                }
            }
            (o.map(|v| v.max(0.0)), a)
        }
        COLOR_RANGE => {
            // Pixels inside the box are keyed out; outside it the matte rises with the distance
            // past the nearest bound, over the fuzziness.
            let measured = if p[8] > 0.5 { c.map(srgb_encode) } else { c };
            let v = range_components(p[1] as u32, measured);
            let mut out = 0.0f32;
            for (i, v) in v.iter().enumerate() {
                out = out.max(p[2 + 2 * i] - v).max(v - p[3 + 2 * i]);
            }
            let m = if out <= 0.0 {
                0.0
            } else if p[0] > 0.0 {
                (out / p[0]).clamp(0.0, 1.0)
            } else {
                1.0
            };
            (c, a * m)
        }
        SPILL_SUPPRESSOR => {
            let amount = p[3];
            if p[4] > 0.5 {
                let mean = (c[0] + c[1] + c[2]) / 3.0;
                let along = (c[0] - mean) * p[5] + (c[1] - mean) * p[6] + (c[2] - mean) * p[7];
                if along <= 0.0 {
                    (c, a)
                } else {
                    (
                        [
                            c[0] - along * p[5] * amount,
                            c[1] - along * p[6] * amount,
                            c[2] - along * p[7] * amount,
                        ],
                        a,
                    )
                }
            } else {
                let (strong, a1, a2) = (p[0] as usize, p[1] as usize, p[2] as usize);
                let spill = (c[strong] - c[a1].max(c[a2])).max(0.0);
                let mut o = c;
                o[strong] -= spill * amount;
                (o, a)
            }
        }
        SHIFT_CHANNELS => (
            [
                channel_source_value(p[0], c, a),
                channel_source_value(p[1], c, a),
                channel_source_value(p[2], c, a),
            ],
            channel_source_value(p[3], c, a).clamp(0.0, 1.0),
        ),
        _ => (c, a),
    };
    let out = WorkingRgba {
        r: bound(c[0] * a),
        g: bound(c[1] * a),
        b: bound(c[2] * a),
        a: bound(a),
    };
    if covers(out.a) {
        out
    } else {
        WorkingRgba::transparent()
    }
}

/// Apply a packed chain to a surface's pixels, in order.
pub fn apply_chain(chain: &[PackedEffect], pixels: &mut [WorkingRgba]) {
    for effect in chain {
        if effect.kind == IDENTITY {
            continue;
        }
        for px in pixels.iter_mut() {
            *px = apply_pixel(effect, *px);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::color::{Rgba, SourceColorSpace};
    use gx_contracts::effect::*;

    fn packed(effect: Effect, space: WorkingColorSpace) -> PackedEffect {
        let mut p = PackedEffect::identity();
        p.pack(&EffectInstance::new("e", effect), space);
        p
    }

    fn grey(v: f32, a: f32) -> WorkingRgba {
        WorkingRgba {
            r: v * a,
            g: v * a,
            b: v * a,
            a,
        }
    }

    #[test]
    fn default_parameters_leave_pixels_unchanged() {
        let px = WorkingRgba {
            r: 0.3 * 0.7,
            g: 0.5 * 0.7,
            b: 0.2 * 0.7,
            a: 0.7,
        };
        for effect in [
            Effect::Levels(Levels::default()),
            Effect::Curves(Curves::default()),
            Effect::HueSaturation(HueSaturation::default()),
            Effect::BrightnessContrast(BrightnessContrast::default()),
            Effect::Exposure(Exposure::default()),
            Effect::Invert(Invert {
                blend_with_original: 1.0,
                ..Default::default()
            }),
            Effect::Vibrance(Vibrance::default()),
        ] {
            for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
                let o = apply_pixel(&packed(effect.clone(), space), px);
                for (got, want) in [(o.r, px.r), (o.g, px.g), (o.b, px.b), (o.a, px.a)] {
                    assert!(
                        (got - want).abs() < 2e-5,
                        "{} {space:?}: {o:?} vs {px:?}",
                        effect.name()
                    );
                }
            }
        }
    }

    #[test]
    fn transparent_pixels_stay_transparent_in_every_effect() {
        let levels = Levels {
            alpha: LevelsChannel {
                output_black: 0.5,
                ..Default::default()
            },
            ..Default::default()
        };
        let fill = Fill {
            opacity: 1.0,
            ..Default::default()
        };
        for effect in [
            Effect::Fill(fill),
            Effect::Tint(Tint::default()),
            Effect::Levels(levels),
        ] {
            let o = apply_pixel(
                &packed(effect, WorkingColorSpace::Srgb),
                WorkingRgba::transparent(),
            );
            assert_eq!(o, WorkingRgba::transparent());
        }
    }

    #[test]
    fn the_published_formulas_hold() {
        let s = WorkingColorSpace::LinearSrgb;
        // Fill at full opacity repaints, keeping coverage.
        let red = Fill {
            color: Rgba::new(1.0, 0.0, 0.0, 1.0, SourceColorSpace::Linear),
            opacity: 1.0,
        };
        let o = apply_pixel(&packed(Effect::Fill(red), s), grey(0.5, 0.5));
        assert!((o.r - 0.5).abs() < 1e-6 && o.g.abs() < 1e-6 && (o.a - 0.5).abs() < 1e-6);
        // Levels: input white 0.5 doubles, clipped at 1.
        let mut lv = Levels::default();
        lv.rgb.input_white = 0.5;
        let o = apply_pixel(&packed(Effect::Levels(lv.clone()), s), grey(0.25, 1.0));
        assert!((o.r - 0.5).abs() < 1e-6);
        let o = apply_pixel(&packed(Effect::Levels(lv), s), grey(0.8, 1.0));
        assert!((o.r - 1.0).abs() < 1e-6);
        // Exposure: +1 stop doubles linear light.
        let ex = Exposure {
            exposure: 1.0,
            ..Default::default()
        };
        let o = apply_pixel(&packed(Effect::Exposure(ex.clone()), s), grey(0.2, 1.0));
        assert!((o.r - 0.4).abs() < 1e-6);
        // ...and in an sRGB project it is still linear light.
        let o = apply_pixel(
            &packed(Effect::Exposure(ex), WorkingColorSpace::Srgb),
            grey(srgb_encode(0.2), 1.0),
        );
        assert!((srgb_decode(o.r) - 0.4).abs() < 1e-5);
        // Tint maps black to white across luminance.
        let tint = Tint::default();
        let o = apply_pixel(
            &packed(Effect::Tint(tint), s),
            WorkingRgba::opaque(1.0, 0.0, 0.0),
        );
        assert!((o.r - 0.2126).abs() < 1e-5 && (o.g - 0.2126).abs() < 1e-5);
        // Hue/Saturation: -1 saturation is grey at HSL lightness.
        let hs = HueSaturation {
            saturation: -1.0,
            ..Default::default()
        };
        let o = apply_pixel(
            &packed(Effect::HueSaturation(hs), s),
            WorkingRgba::opaque(1.0, 0.0, 0.0),
        );
        assert!((o.r - 0.5).abs() < 1e-6 && (o.g - 0.5).abs() < 1e-6);
        // Curves: a point at (0.5, 0.75) lifts mid grey there.
        let cv = Curves {
            rgb: vec![
                CurvePoint { x: 0.0, y: 0.0 },
                CurvePoint { x: 0.5, y: 0.75 },
                CurvePoint { x: 1.0, y: 1.0 },
            ],
            ..Default::default()
        };
        let o = apply_pixel(&packed(Effect::Curves(cv), s), grey(0.5, 1.0));
        assert!((o.r - 0.75).abs() < 1e-4, "{o:?}");
    }

    #[test]
    fn batch_one_matches_effectcraft_on_known_pixels() {
        let s = WorkingColorSpace::LinearSrgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let near = |o: WorkingRgba, want: [f32; 3], note: &str| {
            for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                assert!((got - want).abs() < 1e-6, "{note}: {o:?} vs {want:?}");
            }
        };
        // Invert: all channels, one channel, and the blend back to the original.
        let inv = |channel, blend| {
            packed(
                Effect::Invert(Invert {
                    channel,
                    blend_with_original: blend,
                }),
                s,
            )
        };
        near(
            apply_pixel(&inv(InvertChannel::Rgb, 0.0), rgb(0.2, 0.5, 1.0)),
            [0.8, 0.5, 0.0],
            "rgb",
        );
        near(
            apply_pixel(&inv(InvertChannel::Green, 0.0), rgb(0.2, 0.25, 1.0)),
            [0.2, 0.75, 1.0],
            "green only",
        );
        near(
            apply_pixel(&inv(InvertChannel::Red, 0.0), rgb(0.2, 0.25, 1.0)),
            [0.8, 0.25, 1.0],
            "red only",
        );
        near(
            apply_pixel(&inv(InvertChannel::Blue, 0.0), rgb(0.2, 0.25, 1.0)),
            [0.2, 0.25, 0.0],
            "blue only",
        );
        near(
            apply_pixel(&inv(InvertChannel::Rgb, 0.25), rgb(0.0, 0.0, 1.0)),
            [0.75, 0.75, 0.25],
            "blend 25%",
        );
        // Premultiplied input comes back premultiplied, with the same coverage.
        let o = apply_pixel(&inv(InvertChannel::Rgb, 0.0), grey(0.25, 0.5));
        assert!(
            (o.r - 0.375).abs() < 1e-6 && (o.a - 0.5).abs() < 1e-7,
            "{o:?}"
        );
        // Posterize: level 2 is black or white, level 5 has steps of a quarter.
        let post = |level| packed(Effect::Posterize(Posterize { level }), s);
        near(
            apply_pixel(&post(2.0), rgb(0.49, 0.5, 0.9)),
            [0.0, 1.0, 1.0],
            "level 2",
        );
        near(
            apply_pixel(&post(5.0), rgb(0.1, 0.4, 0.99)),
            [0.0, 0.5, 1.0],
            "level 5",
        );
        near(
            apply_pixel(&post(5.0), rgb(1.5, -0.5, 0.375)),
            [1.0, 0.0, 0.5],
            "out of range clamps",
        );
        // Posterize rounds its level, and below 2 it is 2.
        near(
            apply_pixel(&post(1.0), rgb(0.7, 0.2, 0.5)),
            [1.0, 0.0, 1.0],
            "level floor",
        );
        // Threshold: Rec. 709 luminance at or above the level is white.
        let thr = |level| packed(Effect::Threshold(Threshold { level }), s);
        near(
            apply_pixel(&thr(0.5), grey(0.5, 1.0)),
            [1.0; 3],
            "equal passes",
        );
        near(
            apply_pixel(&thr(0.5), grey(0.49, 1.0)),
            [0.0; 3],
            "below fails",
        );
        near(
            apply_pixel(&thr(0.2), rgb(1.0, 0.0, 0.0)),
            [1.0; 3],
            "red luma 0.2126 passes 0.2",
        );
        near(
            apply_pixel(&thr(0.22), rgb(1.0, 0.0, 0.0)),
            [0.0; 3],
            "red luma 0.2126 fails 0.22",
        );
        // Vibrance: the weight is (1 - s) * min(s, 0.5), so a grey and a fully
        // saturated colour are untouched and a half-saturated one gains s * 0.5.
        let vib = |vibrance, saturation| {
            packed(
                Effect::Vibrance(Vibrance {
                    vibrance,
                    saturation,
                }),
                s,
            )
        };
        near(
            apply_pixel(&vib(1.0, 0.0), grey(0.4, 1.0)),
            [0.4; 3],
            "grey stays grey",
        );
        near(
            apply_pixel(&vib(1.0, 0.0), rgb(1.0, 0.0, 0.0)),
            [1.0, 0.0, 0.0],
            "full saturation stays",
        );
        let sat_of = |p: WorkingRgba| rgb_to_hsl([p.r, p.g, p.b])[1];
        let mid = rgb(0.75, 0.25, 0.25);
        let gain = sat_of(apply_pixel(&vib(1.0, 0.0), mid)) - sat_of(mid);
        assert!((gain - 0.25).abs() < 1e-5, "{gain}");
        // Above half saturation the weight stops growing: s = 0.8 gains 0.2 * 0.5.
        let vivid = rgb(0.9, 0.1, 0.1);
        let gain = sat_of(apply_pixel(&vib(1.0, 0.0), vivid)) - sat_of(vivid);
        assert!((gain - 0.1).abs() < 1e-5, "{gain}");
        // Saturation alone scales by (1 + sat); -1 is grey at the same lightness.
        let half = apply_pixel(&vib(0.0, -1.0), rgb(1.0, 0.0, 0.0));
        near(half, [0.5, 0.5, 0.5], "saturation -1");
        // Hue and lightness survive.
        let before = rgb_to_hsl([0.6, 0.3, 0.2]);
        let after = apply_pixel(&vib(0.5, 0.2), rgb(0.6, 0.3, 0.2));
        let after = rgb_to_hsl([after.r, after.g, after.b]);
        assert!((before[0] - after[0]).abs() < 1e-5 && (before[2] - after[2]).abs() < 1e-5);
    }

    #[test]
    fn batch_two_matches_effectcraft_on_known_pixels() {
        let s = WorkingColorSpace::Srgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let near = |o: WorkingRgba, want: [f32; 3], note: &str| {
            for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                assert!((got - want).abs() < 1e-5, "{note}: {o:?} vs {want:?}");
            }
        };
        let col = |r, g, b| Rgba {
            r,
            g,
            b,
            a: 1.0,
            space: SourceColorSpace::Srgb,
        };
        // Tritone: the default ramp is a greyscale; a coloured ramp blends two stops.
        let tri = |t: Tritone| packed(Effect::Tritone(t), s);
        near(
            apply_pixel(&tri(Tritone::default()), grey(0.25, 1.0)),
            [0.25; 3],
            "default ramp, shadows half",
        );
        let ramp = Tritone {
            shadows: col(1.0, 0.0, 0.0),
            midtones: col(0.0, 1.0, 0.0),
            highlights: col(0.0, 0.0, 1.0),
            blend_with_original: 0.0,
        };
        near(
            apply_pixel(&tri(ramp.clone()), grey(0.25, 1.0)),
            [0.5, 0.5, 0.0],
            "shadow to mid",
        );
        near(
            apply_pixel(&tri(ramp.clone()), grey(0.75, 1.0)),
            [0.0, 0.5, 0.5],
            "mid to highlight",
        );
        near(
            apply_pixel(
                &tri(Tritone {
                    blend_with_original: 0.5,
                    ..ramp
                }),
                grey(0.25, 1.0),
            ),
            [0.375, 0.375, 0.125],
            "half back to the original",
        );
        // Channel Mixer: swapping red and blue, a mono mix, a constant, and the clamp at zero.
        let mix = |m: ChannelMixer| packed(Effect::ChannelMixer(m), s);
        let row = |red, green, blue, constant| MixerRow {
            red,
            green,
            blue,
            constant,
        };
        let swap = ChannelMixer {
            red: row(0.0, 0.0, 1.0, 0.0),
            blue: row(1.0, 0.0, 0.0, 0.0),
            ..ChannelMixer::default()
        };
        near(
            apply_pixel(&mix(swap), rgb(0.2, 0.5, 0.8)),
            [0.8, 0.5, 0.2],
            "red and blue swapped",
        );
        near(
            apply_pixel(
                &mix(ChannelMixer {
                    red: row(0.5, 0.5, 0.0, 0.0),
                    monochrome: true,
                    ..ChannelMixer::default()
                }),
                rgb(0.2, 0.5, 0.8),
            ),
            [0.35; 3],
            "monochrome from the red row",
        );
        near(
            apply_pixel(
                &mix(ChannelMixer {
                    red: row(1.0, 0.0, 0.0, 0.1),
                    green: row(-1.0, 0.0, 0.0, 0.0),
                    ..ChannelMixer::default()
                }),
                rgb(0.2, 0.5, 0.8),
            ),
            [0.3, 0.0, 0.8],
            "constant, and no negative values",
        );
        // Color Balance: shadows act on black, midtones on mid grey; luminosity can be kept.
        let bal = |b: ColorBalance| packed(Effect::ColorBalance(b), s);
        near(
            apply_pixel(
                &bal(ColorBalance {
                    shadows: ColorShift {
                        red: 0.4,
                        green: 0.0,
                        blue: -0.4,
                    },
                    preserve_luminosity: false,
                    ..ColorBalance::default()
                }),
                rgb(0.0, 0.0, 0.0),
            ),
            [0.2, 0.0, 0.0],
            "shadows on black",
        );
        let mid = ColorShift {
            red: 0.2,
            green: 0.0,
            blue: -0.2,
        };
        near(
            apply_pixel(
                &bal(ColorBalance {
                    midtones: mid,
                    preserve_luminosity: false,
                    ..ColorBalance::default()
                }),
                grey(0.5, 1.0),
            ),
            [0.6, 0.5, 0.4],
            "midtones on mid grey",
        );
        // At 0.75 grey the midtones and highlights each carry half the weight.
        near(
            apply_pixel(
                &bal(ColorBalance {
                    midtones: mid,
                    highlights: ColorShift {
                        red: 0.0,
                        green: 0.2,
                        blue: 0.0,
                    },
                    preserve_luminosity: false,
                    ..ColorBalance::default()
                }),
                grey(0.75, 1.0),
            ),
            [0.8, 0.8, 0.7],
            "midtones and highlights share the weight",
        );
        let kept = apply_pixel(
            &bal(ColorBalance {
                midtones: mid,
                ..ColorBalance::default()
            }),
            grey(0.5, 1.0),
        );
        let luma = rec709_luminance([kept.r, kept.g, kept.b]);
        assert!(
            (luma - 0.5).abs() < 1e-5 && kept.r > kept.g && kept.g > kept.b,
            "{kept:?}"
        );
        // Gamma/Pedestal/Gain: each channel on its own, then Black Stretch.
        let gpg = |g: GammaPedestalGain| packed(Effect::GammaPedestalGain(g), s);
        let chan = |gamma, pedestal, gain| GammaChannel {
            gamma,
            pedestal,
            gain,
        };
        near(
            apply_pixel(
                &gpg(GammaPedestalGain {
                    red: chan(2.0, 0.0, 1.0),
                    green: chan(1.0, 0.1, 1.0),
                    blue: chan(1.0, 0.0, 0.5),
                    black_stretch: 0.0,
                }),
                rgb(0.25, 0.5, 1.0),
            ),
            [0.0625, 0.55, 0.5],
            "gamma, pedestal and gain",
        );
        near(
            apply_pixel(
                &gpg(GammaPedestalGain {
                    black_stretch: 1.0,
                    ..GammaPedestalGain::default()
                }),
                rgb(0.5, 0.0, 1.0),
            ),
            [0.5078125, 0.0, 1.0],
            "black stretch lifts the middle, not black or white",
        );
    }

    #[test]
    fn batch_two_defaults_are_identities_where_they_should_be() {
        let px = WorkingRgba {
            r: 0.3 * 0.7,
            g: 0.5 * 0.7,
            b: 0.2 * 0.7,
            a: 0.7,
        };
        for effect in [
            Effect::ChannelMixer(ChannelMixer::default()),
            Effect::ColorBalance(ColorBalance::default()),
            Effect::GammaPedestalGain(GammaPedestalGain::default()),
        ] {
            let o = apply_pixel(&packed(effect.clone(), WorkingColorSpace::Srgb), px);
            for (got, want) in [(o.r, px.r), (o.g, px.g), (o.b, px.b), (o.a, px.a)] {
                assert!((got - want).abs() < 2e-5, "{}: {o:?}", effect.name());
            }
        }
    }

    #[test]
    fn batch_three_matches_effectcraft_on_known_pixels() {
        let s = WorkingColorSpace::Srgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let near = |o: WorkingRgba, want: [f32; 3], note: &str| {
            for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                assert!((got - want).abs() < 1e-5, "{note}: {o:?} vs {want:?}");
            }
        };
        let col = |r, g, b| Rgba {
            r,
            g,
            b,
            a: 1.0,
            space: SourceColorSpace::Srgb,
        };
        // Color Balance (HLS): zero is the picture; hue wraps; lightness and saturation move a
        // share of the way to the extreme (up) or to zero (down).
        let hls = |hue, lightness, saturation| {
            packed(
                Effect::ColorBalanceHls(ColorBalanceHls {
                    hue,
                    lightness,
                    saturation,
                }),
                s,
            )
        };
        near(
            apply_pixel(&hls(0.0, 0.0, 0.0), rgb(0.3, 0.6, 0.1)),
            [0.3, 0.6, 0.1],
            "identity",
        );
        near(
            apply_pixel(&hls(120.0, 0.0, 0.0), rgb(1.0, 0.0, 0.0)),
            [0.0, 1.0, 0.0],
            "red to green",
        );
        near(
            apply_pixel(&hls(-120.0, 0.0, 0.0), rgb(1.0, 0.0, 0.0)),
            [0.0, 0.0, 1.0],
            "red to blue",
        );
        near(
            apply_pixel(&hls(0.0, 0.5, 0.0), grey(0.4, 1.0)),
            [0.7; 3],
            "lighter",
        );
        near(
            apply_pixel(&hls(0.0, -0.5, 0.0), grey(0.4, 1.0)),
            [0.2; 3],
            "darker",
        );
        near(
            apply_pixel(&hls(0.0, 0.0, 1.0), rgb(0.6, 0.4, 0.4)),
            [1.0, 0.0, 0.0],
            "fully saturated",
        );
        near(
            apply_pixel(&hls(0.0, 0.0, -1.0), rgb(0.6, 0.4, 0.4)),
            [0.5; 3],
            "desaturated",
        );
        // Black & White: greys keep their luminance; a hue's weight lifts or lowers it; the tint
        // takes the tint colour's hue and saturation at the greyscale's lightness.
        let bw = |b: BlackWhite| packed(Effect::BlackWhite(b), s);
        near(
            apply_pixel(&bw(BlackWhite::default()), grey(0.4, 1.0)),
            [0.4; 3],
            "a grey is left alone",
        );
        near(
            apply_pixel(&bw(BlackWhite::default()), rgb(1.0, 0.0, 0.0)),
            [0.1526; 3],
            "red, weight 0.4",
        );
        near(
            apply_pixel(&bw(BlackWhite::default()), rgb(1.0, 1.0, 0.0)),
            [0.9878; 3],
            "yellow, weight 0.6",
        );
        near(
            apply_pixel(&bw(BlackWhite::default()), rgb(0.0, 0.0, 1.0)),
            [0.0; 3],
            "blue never goes below black",
        );
        near(
            apply_pixel(&bw(BlackWhite::default()), rgb(1.0, 0.5, 0.0)),
            [0.5702; 3],
            "orange, between red and yellow",
        );
        let tinted = apply_pixel(
            &bw(BlackWhite {
                tint: true,
                tint_color: col(1.0, 0.0, 0.0),
                ..BlackWhite::default()
            }),
            grey(0.4, 1.0),
        );
        near(
            tinted,
            [0.8, 0.0, 0.0],
            "a red tint at lightness 0.4 is (0.8, 0, 0)",
        );
        // Photo Filter: a custom colour, a preset, the density, and keeping the luminosity.
        let pf = |f: PhotoFilter| packed(Effect::PhotoFilter(f), s);
        let custom = |density, keep| PhotoFilter {
            filter: PhotoFilterPreset::Custom,
            color: col(0.5, 0.5, 1.0),
            density,
            preserve_luminosity: keep,
        };
        near(
            apply_pixel(&pf(custom(1.0, false)), grey(0.5, 1.0)),
            [0.25, 0.25, 0.5],
            "full density",
        );
        near(
            apply_pixel(&pf(custom(0.5, false)), grey(0.5, 1.0)),
            [0.375, 0.375, 0.5],
            "half density",
        );
        near(
            apply_pixel(&pf(custom(1.0, true)), grey(0.5, 1.0)),
            [0.46633, 0.46633, 0.93266],
            "luminosity kept",
        );
        near(
            apply_pixel(&pf(custom(0.0, true)), rgb(0.3, 0.6, 0.1)),
            [0.3, 0.6, 0.1],
            "density 0 is the picture",
        );
        near(
            apply_pixel(
                &pf(PhotoFilter {
                    filter: PhotoFilterPreset::Warming85,
                    density: 1.0,
                    preserve_luminosity: false,
                    ..PhotoFilter::default()
                }),
                rgb(1.0, 1.0, 1.0),
            ),
            [0.941_176_5, 0.549_019_6, 0.117_647_06],
            "the Warming (85) preset is its own colour",
        );
        // Leave Color: nothing at amount 0; the colour is kept; the rest goes to its luminance;
        // softness keeps part of the colour; by hue, a grey matches none.
        let lc = |l: LeaveColor| packed(Effect::LeaveColor(l), s);
        let leave = |tolerance, softness, by_hue| LeaveColor {
            amount: 1.0,
            color: col(1.0, 0.0, 0.0),
            tolerance,
            edge_softness: softness,
            match_colors: if by_hue {
                LeaveMatch::Hue
            } else {
                LeaveMatch::Rgb
            },
        };
        near(
            apply_pixel(&lc(LeaveColor::default()), rgb(0.1, 0.8, 0.1)),
            [0.1, 0.8, 0.1],
            "amount 0",
        );
        near(
            apply_pixel(&lc(leave(0.15, 0.0, false)), rgb(1.0, 0.0, 0.0)),
            [1.0, 0.0, 0.0],
            "the colour is kept",
        );
        near(
            apply_pixel(&lc(leave(0.15, 0.0, false)), rgb(0.1, 0.8, 0.1)),
            [0.60064; 3],
            "green goes grey",
        );
        near(
            apply_pixel(&lc(leave(0.15, 1.0, false)), rgb(0.1, 0.8, 0.1)),
            [0.374_158, 0.690_827, 0.374_158],
            "softness keeps part of the colour",
        );
        near(
            apply_pixel(&lc(leave(1.0, 0.0, false)), rgb(0.1, 0.8, 0.1)),
            [0.1, 0.8, 0.1],
            "tolerance 1 keeps everything",
        );
        near(
            apply_pixel(&lc(leave(0.15, 0.0, true)), rgb(0.8, 0.1, 0.1)),
            [0.8, 0.1, 0.1],
            "by hue, the same hue is kept",
        );
        near(
            apply_pixel(&lc(leave(0.15, 0.0, true)), rgb(0.1, 0.1, 0.8)),
            [0.15054; 3],
            "by hue, blue goes grey",
        );
        // A grey matches no hue, so it is decoloured (it stays the same grey).
        near(
            apply_pixel(&lc(leave(0.15, 0.0, true)), grey(0.5, 1.0)),
            [0.5; 3],
            "a grey stays grey",
        );
        // A shift past a whole turn must wrap: blue turned 340 degrees is a blue-green, and
        // (0.2, 0.5, 0.7) turned 300 degrees is (0.2, 0.7, 0.4).
        near(
            apply_pixel(&hls(340.0, 0.0, 0.0), rgb(0.0, 0.0, 1.0)),
            [0.0, 0.333_333_3, 1.0],
            "wraps past one turn",
        );
        near(
            apply_pixel(&hls(300.0, 0.0, 0.0), rgb(0.2, 0.5, 0.7)),
            [0.2, 0.7, 0.4],
            "wraps again",
        );
        // The default tint colour is not a pure red: its hue and saturation both matter.
        near(
            apply_pixel(
                &bw(BlackWhite {
                    tint: true,
                    ..BlackWhite::default()
                }),
                grey(0.4, 1.0),
            ),
            [0.615_384_6, 0.430_769_2, 0.184_615_4],
            "the default tint at lightness 0.4",
        );
        // Softness is the width of the fade: tolerance 0.4 and softness 0.5 keep 40% of the colour.
        near(
            apply_pixel(&lc(leave(0.4, 0.5, false)), rgb(0.1, 0.8, 0.1)),
            [0.397_996, 0.681_335, 0.397_996],
            "softness is the width of the fade, not a flag",
        );
        // Almost a grey (saturation 0.005) with the kept hue: below 0.02 it matches no hue, so it
        // is decoloured to its luminosity.
        near(
            apply_pixel(&lc(leave(0.15, 0.0, true)), rgb(0.505, 0.5, 0.5)),
            [0.501_063; 3],
            "a nearly-grey pixel matches no hue",
        );
        // The two modes disagree on a dark red: it has the kept red's hue, so by hue it is kept,
        // but it is far from it in RGB, so by RGB it goes grey (0.2126 * 0.3).
        near(
            apply_pixel(&lc(leave(0.15, 0.0, true)), rgb(0.3, 0.0, 0.0)),
            [0.3, 0.0, 0.0],
            "by hue, a dark red is still the red",
        );
        near(
            apply_pixel(&lc(leave(0.15, 0.0, false)), rgb(0.3, 0.0, 0.0)),
            [0.063_78; 3],
            "by RGB, a dark red is far from the red",
        );
    }

    /// Expected values were computed independently in Python from EffectCraft's `video_limiter`
    /// and `broadcast_colors` (color3.rs, color2.rs).
    #[test]
    fn batch_four_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::{
            BroadcastAction, BroadcastLocale, LimiterCompression, LimiterLevel, LimiterMethod,
        };
        let s = WorkingColorSpace::Srgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let near = |o: WorkingRgba, want: [f32; 3], note: &str| {
            for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                assert!((got - want).abs() < 1e-5, "{note}: {o:?} vs {want:?}");
            }
        };
        let lim = |level, method, compression| VideoLimiter {
            clip_level: level,
            clip_method: method,
            compression_before_clipping: compression,
            ..VideoLimiter::default()
        };
        let vl = |l: VideoLimiter| packed(Effect::VideoLimiter(l), s);
        // A legal colour below the knee is untouched (the defaults are 100%, Smart Limit, 5%).
        near(
            apply_pixel(&vl(VideoLimiter::default()), rgb(0.4, 0.5, 0.3)),
            [0.4, 0.5, 0.3],
            "legal and below the knee",
        );
        near(
            apply_pixel(&vl(VideoLimiter::default()), rgb(1.6, 1.2, 0.9)),
            [1.0, 0.999_887_3, 0.999_802_8],
            "a hot colour, default limiter",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P90,
                    LimiterMethod::Luma,
                    LimiterCompression::None,
                )),
                rgb(1.0, 1.0, 1.0),
            ),
            [0.9; 3],
            "luma clips white to the level",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P90,
                    LimiterMethod::Luma,
                    LimiterCompression::None,
                )),
                rgb(1.0, 0.5, 0.0),
            ),
            [0.9, 0.5, 0.0],
            "luma keeps the offsets, then clips each channel",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P100,
                    LimiterMethod::Chroma,
                    LimiterCompression::None,
                )),
                rgb(1.5, 0.5, 0.0),
            ),
            [1.0, 0.607_164_5, 0.410_746_8],
            "chroma pulls towards the luminance",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P95,
                    LimiterMethod::Chroma,
                    LimiterCompression::None,
                )),
                rgb(1.0, 1.0, 1.0),
            ),
            [0.95; 3],
            "chroma still clamps a grey that is over the level",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P100,
                    LimiterMethod::Chroma,
                    LimiterCompression::None,
                )),
                rgb(-0.2, 0.5, 0.5),
            ),
            [0.0, 0.445_999_5, 0.445_999_5],
            "chroma lifts a negative channel to zero",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P100,
                    LimiterMethod::Luma,
                    LimiterCompression::P20,
                )),
                rgb(0.9, 0.9, 0.9),
            ),
            [0.878_693_9; 3],
            "20% compression starts the knee at 0.8",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P109,
                    LimiterMethod::SmartLimit,
                    LimiterCompression::P5,
                )),
                rgb(1.2, 0.3, 0.1),
            ),
            [1.09, 0.326_910_5, 0.157_335_1],
            "smart limit does both, to 109%",
        );
        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P90,
                    LimiterMethod::SmartLimit,
                    LimiterCompression::P5,
                )),
                rgb(1.0, 0.5, 0.2),
            ),
            [0.9, 0.520_377_5, 0.292_604],
            "smart limit at 90%",
        );
        // The gamut warning paints a changed pixel and leaves a legal one alone.
        let warn = |level, method| VideoLimiter {
            gamut_warning: true,
            gamut_warning_color: Rgba {
                r: 0.0,
                g: 1.0,
                b: 0.0,
                a: 1.0,
                space: SourceColorSpace::Srgb,
            },
            ..lim(level, method, LimiterCompression::None)
        };
        near(
            apply_pixel(
                &vl(warn(LimiterLevel::P100, LimiterMethod::Luma)),
                rgb(1.6, 1.2, 0.9),
            ),
            [0.0, 1.0, 0.0],
            "a limited pixel shows the warning colour",
        );
        near(
            apply_pixel(
                &vl(warn(LimiterLevel::P100, LimiterMethod::Luma)),
                rgb(0.4, 0.5, 0.3),
            ),
            [0.4, 0.5, 0.3],
            "a legal pixel does not",
        );

        near(
            apply_pixel(
                &vl(lim(
                    LimiterLevel::P100,
                    LimiterMethod::Luma,
                    LimiterCompression::None,
                )),
                rgb(0.5, 0.5, -0.2),
            ),
            [0.5, 0.5, 0.0],
            "a negative blue is lifted to zero",
        );
        // The warning counts a change over 1e-4 and ignores a smaller one.
        near(
            apply_pixel(
                &vl(warn(LimiterLevel::P100, LimiterMethod::Luma)),
                rgb(1.0005, 0.5, 0.5),
            ),
            [0.0, 1.0, 0.0],
            "a change of 5e-4 is flagged",
        );
        near(
            apply_pixel(
                &vl(warn(LimiterLevel::P100, LimiterMethod::Luma)),
                rgb(1.00005, 0.5, 0.5),
            ),
            [1.0, 0.5, 0.5],
            "a change of 5e-5 is not",
        );

        // Broadcast Colors.
        let bc = |locale, how, max_signal| {
            packed(
                Effect::BroadcastColors(BroadcastColors {
                    locale,
                    how_to_make_safe: how,
                    max_signal,
                }),
                s,
            )
        };
        use BroadcastAction::{KeyOutSafe, KeyOutUnsafe, ReduceLuminance, ReduceSaturation};
        use BroadcastLocale::{Ntsc, Pal};
        near(
            apply_pixel(&bc(Ntsc, ReduceLuminance, 110.0), rgb(1.0, 1.0, 0.0)),
            [0.830_440_7, 0.830_440_7, 0.0],
            "NTSC yellow, reduce luminance",
        );
        near(
            apply_pixel(&bc(Ntsc, ReduceSaturation, 110.0), rgb(1.0, 1.0, 0.0)),
            [0.942_473, 0.942_473, 0.447_095_7],
            "NTSC yellow, reduce saturation",
        );
        near(
            apply_pixel(&bc(Pal, ReduceLuminance, 110.0), rgb(1.0, 1.0, 0.0)),
            [0.825_063_8, 0.825_063_8, 0.0],
            "PAL yellow, reduce luminance",
        );
        near(
            apply_pixel(&bc(Pal, ReduceSaturation, 110.0), rgb(1.0, 1.0, 0.0)),
            [0.940_549_1, 0.940_549_1, 0.462_048_3],
            "PAL yellow, reduce saturation",
        );
        near(
            apply_pixel(&bc(Ntsc, ReduceLuminance, 90.0), rgb(1.0, 0.0, 0.0)),
            [0.957_738_8, 0.0, 0.0],
            "a lower limit catches pure red",
        );
        near(
            apply_pixel(&bc(Ntsc, ReduceSaturation, 90.0), rgb(1.0, 0.0, 0.0)),
            [0.956_364_7, 0.018_611_9, 0.018_611_9],
            "and desaturates it",
        );
        near(
            apply_pixel(&bc(Ntsc, ReduceSaturation, 90.0), rgb(1.0, 1.0, 1.0)),
            [0.891_891_9; 3],
            "a white over the limit is scaled by its luminance",
        );
        near(
            apply_pixel(&bc(Pal, ReduceLuminance, 100.0), rgb(1.0, 0.0, 0.0)),
            [1.0, 0.0, 0.0],
            "PAL red at 100 is safe",
        );
        near(
            apply_pixel(&bc(Ntsc, ReduceLuminance, 110.0), rgb(0.5, 0.5, 0.5)),
            [0.5, 0.5, 0.5],
            "a grey is safe",
        );
        // Keying: the unsafe pixel goes (or, the other way, the safe one).
        let yellow = rgb(1.0, 1.0, 0.0);
        let grey = rgb(0.5, 0.5, 0.5);
        assert_eq!(
            apply_pixel(&bc(Ntsc, KeyOutUnsafe, 110.0), yellow),
            WorkingRgba::transparent()
        );
        assert_eq!(apply_pixel(&bc(Ntsc, KeyOutUnsafe, 110.0), grey), grey);
        assert_eq!(apply_pixel(&bc(Ntsc, KeyOutSafe, 110.0), yellow), yellow);
        assert_eq!(
            apply_pixel(&bc(Ntsc, KeyOutSafe, 110.0), grey),
            WorkingRgba::transparent()
        );
    }

    /// Expected values were computed independently in Python from EffectCraft's `cc_toner`,
    /// `cc_color_offset`, `cc_threshold` and `cc_threshold_rgb` (color2.rs, stylize2.rs).
    #[test]
    fn batch_five_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::{ColorOverflow, ThresholdChannel, TonerTones};
        let s = WorkingColorSpace::Srgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let near = |o: WorkingRgba, want: [f32; 3], note: &str| {
            for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                assert!((got - want).abs() < 1e-5, "{note}: {o:?} vs {want:?}");
            }
        };
        // CC Toner.
        let toner = |tones, blend| {
            packed(
                Effect::CcToner(CcToner {
                    tones,
                    blend,
                    ..CcToner::default()
                }),
                s,
            )
        };
        near(
            apply_pixel(&toner(TonerTones::Tritone, 0.0), rgb(0.25, 0.25, 0.25)),
            [0.275, 0.215, 0.14],
            "tritone, halfway from shadows to midtones",
        );
        near(
            apply_pixel(&toner(TonerTones::Duotone, 0.0), rgb(0.25, 0.25, 0.25)),
            [0.25, 0.25, 0.25],
            "duotone, a quarter of the way",
        );
        near(
            apply_pixel(&toner(TonerTones::Pentone, 0.0), rgb(0.6, 0.6, 0.6)),
            [0.674, 0.57, 0.424],
            "pentone, between the midtones and the brights",
        );
        near(
            apply_pixel(&toner(TonerTones::Tritone, 0.5), rgb(0.25, 0.25, 0.25)),
            [0.2625, 0.2325, 0.195],
            "half the original comes back",
        );
        near(
            apply_pixel(&toner(TonerTones::Tritone, 0.0), rgb(1.0, 1.0, 1.0)),
            [1.0, 1.0, 1.0],
            "white is the highlights",
        );
        near(
            apply_pixel(&toner(TonerTones::Tritone, 0.0), rgb(0.8, 0.2, 0.1)),
            [0.352_374, 0.275_492_4, 0.179_390_4],
            "a colour is toned by its luminance alone",
        );
        // CC Color Offset.
        let offset = |red, green, blue, overflow| {
            packed(
                Effect::CcColorOffset(CcColorOffset {
                    red_phase: red,
                    green_phase: green,
                    blue_phase: blue,
                    overflow,
                }),
                s,
            )
        };
        near(
            apply_pixel(
                &offset(90.0, 0.0, 0.0, ColorOverflow::Wrap),
                rgb(0.5, 0.5, 0.5),
            ),
            [0.75, 0.5, 0.5],
            "a quarter turn on red",
        );
        for (overflow, phase, want, note) in [
            (ColorOverflow::Wrap, 90.0, 0.15, "wrap 0.9 + 0.25"),
            (ColorOverflow::Solarize, 90.0, 0.85, "solarize 0.9 + 0.25"),
            (ColorOverflow::Polarize, 90.0, 0.0, "polarize, 0.15 over"),
            (ColorOverflow::Polarize, 270.0, 1.0, "polarize, 0.65 over"),
            (ColorOverflow::Solarize, 270.0, 0.35, "solarize 0.9 + 0.75"),
            (
                ColorOverflow::Wrap,
                450.0,
                0.15,
                "a turn and a quarter is a quarter",
            ),
            (ColorOverflow::Wrap, -270.0, 0.15, "a negative phase wraps"),
        ] {
            near(
                apply_pixel(&offset(phase, 0.0, 0.0, overflow), rgb(0.9, 0.5, 0.5)),
                [want, 0.5, 0.5],
                note,
            );
        }
        near(
            apply_pixel(
                &offset(-270.0, 0.0, 0.0, ColorOverflow::Wrap),
                rgb(0.5, 0.5, 0.5),
            ),
            [0.75, 0.5, 0.5],
            "a negative phase is the positive one a turn away",
        );
        near(
            apply_pixel(
                &offset(234.0, 0.0, 0.0, ColorOverflow::Polarize),
                rgb(0.9, 0.5, 0.5),
            ),
            [1.0, 0.5, 0.5],
            "polarize: 0.55 past white is over the half",
        );
        near(
            apply_pixel(
                &offset(360.0, 720.0, 0.0, ColorOverflow::Wrap),
                rgb(0.3, 0.6, 0.9),
            ),
            [0.3, 0.6, 0.9],
            "whole turns are the picture",
        );
        // CC Threshold.
        let threshold = |channel, invert, blend| {
            packed(
                Effect::CcThreshold(CcThreshold {
                    channel,
                    invert,
                    blend,
                    ..CcThreshold::default()
                }),
                s,
            )
        };
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Luminance, false, 0.0),
                rgb(0.6, 0.6, 0.6),
            ),
            [1.0; 3],
            "luminance over the level",
        );
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Luminance, false, 0.0),
                rgb(0.4, 0.4, 0.4),
            ),
            [0.0; 3],
            "luminance under the level",
        );
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Luminance, true, 0.0),
                rgb(0.6, 0.6, 0.6),
            ),
            [0.0; 3],
            "inverted",
        );
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Rgb, false, 0.0),
                rgb(0.6, 0.3, 0.5),
            ),
            [1.0, 0.0, 1.0],
            "each channel on its own",
        );
        // At the level exactly, the channel counts as reaching it.
        let at = 127.0_f32 / 255.0;
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Rgb, false, 0.0),
                rgb(at, at, at),
            ),
            [1.0; 3],
            "a channel exactly at the level is over it",
        );
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Saturation, false, 0.0),
                rgb(0.8, 0.2, 0.2),
            ),
            [1.0; 3],
            "a saturated colour",
        );
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Saturation, false, 0.0),
                rgb(0.6, 0.3, 0.3),
            ),
            [0.0; 3],
            "a duller colour",
        );
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Luminance, false, 0.5),
                rgb(0.6, 0.6, 0.6),
            ),
            [0.8; 3],
            "half the original comes back",
        );
        let alpha = |a: f32, blend| {
            apply_pixel(
                &threshold(ThresholdChannel::Alpha, false, blend),
                grey(0.4, a),
            )
        };
        let hardened = alpha(0.7, 0.0);
        assert!((hardened.a - 1.0).abs() < 1e-6, "{hardened:?}");
        assert!(
            (hardened.r - 0.4).abs() < 1e-6,
            "colour unchanged: {hardened:?}"
        );
        assert_eq!(
            alpha(0.3, 0.0),
            WorkingRgba::transparent(),
            "coverage under the level goes"
        );
        let halfway = alpha(0.7, 0.5);
        assert!((halfway.a - 0.85).abs() < 1e-6, "{halfway:?}");
        near(
            apply_pixel(
                &threshold(ThresholdChannel::Rgb, false, 0.0),
                rgb(0.497, 0.497, 0.497),
            ),
            [0.0; 3],
            "127 of 255 is 0.498, not 0.496",
        );
        // CC Threshold RGB.
        let rgb_threshold = |red: f64, invert_green: bool, blend: f64| {
            packed(
                Effect::CcThresholdRgb(CcThresholdRgb {
                    red_threshold: red,
                    invert_green,
                    blend,
                    ..CcThresholdRgb::default()
                }),
                s,
            )
        };
        near(
            apply_pixel(&rgb_threshold(127.0, false, 0.0), rgb(0.6, 0.3, 0.5)),
            [1.0, 0.0, 1.0],
            "each channel at its own level",
        );
        near(
            apply_pixel(&rgb_threshold(127.0, true, 0.0), rgb(0.6, 0.3, 0.5)),
            [1.0, 1.0, 1.0],
            "green inverted",
        );
        near(
            apply_pixel(&rgb_threshold(200.0, false, 0.0), rgb(0.6, 0.3, 0.5)),
            [0.0, 0.0, 1.0],
            "red has its own, higher level",
        );
        // Each channel reads its own level and its own invert.
        let own = |t: [f64; 3], inv: [bool; 3]| {
            packed(
                Effect::CcThresholdRgb(CcThresholdRgb {
                    red_threshold: t[0],
                    green_threshold: t[1],
                    blue_threshold: t[2],
                    invert_red: inv[0],
                    invert_green: inv[1],
                    invert_blue: inv[2],
                    blend: 0.0,
                }),
                s,
            )
        };
        near(
            apply_pixel(&own([50.0, 200.0, 100.0], [false; 3]), rgb(0.4, 0.4, 0.4)),
            [1.0, 0.0, 1.0],
            "green has the high level, blue its own",
        );
        near(
            apply_pixel(
                &own([50.0, 200.0, 100.0], [true, false, true]),
                rgb(0.4, 0.4, 0.4),
            ),
            [0.0, 0.0, 0.0],
            "red and blue inverted",
        );
        near(
            apply_pixel(
                &own([50.0, 200.0, 100.0], [false, false, true]),
                rgb(0.4, 0.4, 0.4),
            ),
            [1.0, 0.0, 0.0],
            "only blue inverted",
        );
        near(
            apply_pixel(&own([127.0; 3], [false; 3]), rgb(at, at, at)),
            [1.0; 3],
            "a channel exactly at its level is over it",
        );
        near(
            apply_pixel(&rgb_threshold(127.0, false, 0.25), rgb(0.6, 0.3, 0.5)),
            [0.9, 0.075, 0.875],
            "a quarter of the original comes back",
        );
    }

    /// Expected values computed independently in Python from EffectCraft's `change_color`
    /// (color3.rs) and `shift_channels` / `pick` (channel.rs, util.rs).
    #[test]
    fn batch_six_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::{ChangeColorView, ChangeMatch, ChannelSource as S};
        let s = WorkingColorSpace::Srgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let near = |o: WorkingRgba, want: [f32; 3], note: &str| {
            for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                assert!((got - want).abs() < 1e-5, "{note}: {o:?} vs {want:?}");
            }
        };
        let change = |c: ChangeColor| packed(Effect::ChangeColor(c), s);
        let hue = |dh: f64| ChangeColor {
            hue_transform: dh,
            ..ChangeColor::default()
        };
        let red = rgb(0.8, 0.2, 0.2);
        near(
            apply_pixel(&change(hue(120.0)), red),
            [0.2, 0.8, 0.2],
            "red turned to green",
        );
        near(
            apply_pixel(&change(hue(-120.0)), red),
            [0.2, 0.2, 0.8],
            "and the other way",
        );
        near(
            apply_pixel(&change(hue(120.0)), rgb(0.1, 0.2, 0.9)),
            [0.1, 0.2, 0.9],
            "a blue is not the colour to change",
        );
        let mask = |c: ChangeColor| {
            change(ChangeColor {
                view: ChangeColorView::ColorCorrectionMask,
                ..c
            })
        };
        near(
            apply_pixel(&mask(ChangeColor::default()), red),
            [1.0; 3],
            "the matte, match",
        );
        near(
            apply_pixel(&mask(ChangeColor::default()), rgb(0.1, 0.2, 0.9)),
            [0.0; 3],
            "the matte, no match",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    lightness_transform: 0.5,
                    ..ChangeColor::default()
                }),
                red,
            ),
            [0.9, 0.6, 0.6],
            "lightness half way to white",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    saturation_transform: -0.5,
                    ..ChangeColor::default()
                }),
                red,
            ),
            [0.65, 0.35, 0.35],
            "saturation half way to none",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    saturation_transform: 0.5,
                    ..ChangeColor::default()
                }),
                rgb(0.6, 0.3, 0.3),
            ),
            [0.75, 0.15, 0.15],
            "saturation half way to full",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    invert_mask: true,
                    ..hue(120.0)
                }),
                rgb(0.1, 0.2, 0.9),
            ),
            [0.9, 0.1, 0.2],
            "inverted: everything but the match changes",
        );
        let by = |match_colors, tolerance, softness| ChangeColor {
            match_colors,
            matching_tolerance: tolerance,
            matching_softness: softness,
            ..hue(120.0)
        };
        near(
            apply_pixel(
                &change(by(ChangeMatch::Rgb, 0.15, 0.0)),
                rgb(0.7, 0.25, 0.2),
            ),
            [0.2, 0.7, 0.25],
            "by RGB, near enough",
        );
        near(
            apply_pixel(
                &change(by(ChangeMatch::Rgb, 0.05, 0.2)),
                rgb(0.7, 0.25, 0.2),
            ),
            [0.236_374_3, 0.667_263_1, 0.246_362_6],
            "by RGB, softly at the edge",
        );
        near(
            apply_pixel(
                &change(by(ChangeMatch::Chroma, 0.15, 0.0)),
                rgb(0.4, 0.1, 0.1),
            ),
            [0.1, 0.4, 0.1],
            "by chroma, a dim red still matches",
        );
        near(
            apply_pixel(&change(by(ChangeMatch::Rgb, 0.15, 0.0)), rgb(0.4, 0.1, 0.1)),
            [0.4, 0.1, 0.1],
            "by RGB, the same dim red does not",
        );
        near(
            apply_pixel(&change(hue(120.0)), rgb(0.5, 0.5, 0.5)),
            [0.5; 3],
            "a grey matches no hue",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    lightness_transform: 0.5,
                    matching_tolerance: 1.0,
                    ..ChangeColor::default()
                }),
                rgb(0.5, 0.5, 0.5),
            ),
            [0.75; 3],
            "unless the tolerance takes everything",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    lightness_transform: -0.5,
                    ..ChangeColor::default()
                }),
                red,
            ),
            [0.4, 0.1, 0.1],
            "lightness half way to black",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    lightness_transform: -0.5,
                    ..ChangeColor::default()
                }),
                rgb(0.5, 0.1, 0.1),
            ),
            [0.25, 0.05, 0.05],
            "going down is a share of the lightness there is, not of what is left to white",
        );
        near(
            apply_pixel(&change(hue(120.0)), rgb(0.8, 0.2, 0.25)),
            [0.25, 0.8, 0.2],
            "a hue just the other side of the key's still matches (the distance wraps)",
        );
        near(
            apply_pixel(&change(hue(120.0)), rgb(0.505, 0.5, 0.5)),
            [0.505, 0.5, 0.5],
            "a nearly-grey pixel matches no hue",
        );
        near(
            apply_pixel(
                &change(by(ChangeMatch::Chroma, 0.15, 0.0)),
                rgb(0.6, 0.28, 0.2),
            ),
            [0.6, 0.28, 0.2],
            "chroma distance is scaled: just outside the tolerance",
        );
        near(
            apply_pixel(
                &change(by(ChangeMatch::Chroma, 0.15, 0.0)),
                rgb(0.8, 0.0, 0.0),
            ),
            [0.8, 0.0, 0.0],
            "a red of another chroma is not matched by chroma, though its hue is the key's",
        );
        near(
            apply_pixel(
                &change(ChangeColor {
                    color_to_change: Rgba {
                        r: 0.2,
                        g: 0.8,
                        b: 0.2,
                        a: 1.0,
                        space: SourceColorSpace::Srgb,
                    },
                    ..hue(120.0)
                }),
                rgb(0.2, 0.8, 0.2),
            ),
            [0.2, 0.2, 0.8],
            "the key's own hue is what a pixel's compared with",
        );
        // Shift Channels.
        let shift = |red, green, blue, alpha| {
            packed(
                Effect::ShiftChannels(ShiftChannels {
                    take_red_from: red,
                    take_green_from: green,
                    take_blue_from: blue,
                    take_alpha_from: alpha,
                }),
                s,
            )
        };
        let px = rgb(0.8, 0.2, 0.4);
        near(
            apply_pixel(&shift(S::Green, S::Green, S::Blue, S::Alpha), px),
            [0.2, 0.2, 0.4],
            "red taken from green",
        );
        near(
            apply_pixel(&shift(S::Blue, S::Red, S::Green, S::Alpha), px),
            [0.4, 0.8, 0.2],
            "a rotation of the channels",
        );
        near(
            apply_pixel(&shift(S::Red, S::Green, S::FullOn, S::Alpha), px),
            [0.8, 0.2, 1.0],
            "blue full on",
        );
        near(
            apply_pixel(&shift(S::HalfOn, S::FullOff, S::Luminance, S::Alpha), px),
            [0.5, 0.0, 0.342],
            "half on, off, and the luminance",
        );
        near(
            apply_pixel(
                &shift(S::Saturation, S::Lightness, S::Hue, S::Alpha),
                rgb(0.8, 0.2, 0.2),
            ),
            [0.6, 0.5, 0.0],
            "saturation, lightness and hue of a red",
        );
        let hot = apply_pixel(
            &shift(S::Red, S::Green, S::Blue, S::Red),
            rgb(1.5, 0.2, 0.4),
        );
        assert!(
            (hot.a - 1.0).abs() < 1e-6,
            "an alpha over 1 is held at 1: {hot:?}"
        );
        let alpha = apply_pixel(&shift(S::Red, S::Green, S::Blue, S::Red), px);
        assert!(
            (alpha.a - 0.8).abs() < 1e-6,
            "alpha taken from red: {alpha:?}"
        );
        assert!(
            (alpha.r - 0.64).abs() < 1e-6,
            "premultiplied by it: {alpha:?}"
        );
        assert_eq!(
            apply_pixel(&shift(S::Red, S::Green, S::Blue, S::FullOff), px),
            WorkingRgba::transparent(),
            "alpha taken from nothing: nothing is covered"
        );
    }

    #[test]
    fn batch_eight_defaults_that_are_identities_are() {
        let s = WorkingColorSpace::Srgb;
        let px = WorkingRgba {
            r: 0.3,
            g: 0.2,
            b: 0.1,
            a: 0.5,
        };
        assert_eq!(
            packed(Effect::CcColorNeutralizer(CcColorNeutralizer::default()), s).kind,
            IDENTITY,
            "balance equal to unbalance everywhere moves nothing"
        );
        assert_ne!(
            packed(
                Effect::CcColorNeutralizer(CcColorNeutralizer {
                    contrast: 0.1,
                    ..CcColorNeutralizer::default()
                }),
                s
            )
            .kind,
            IDENTITY
        );
        for lift in [
            CcColorNeutralizer {
                darks: 0.1,
                ..CcColorNeutralizer::default()
            },
            CcColorNeutralizer {
                brights: 0.1,
                ..CcColorNeutralizer::default()
            },
        ] {
            assert_ne!(
                packed(Effect::CcColorNeutralizer(lift), s).kind,
                IDENTITY,
                "darks or brights alone are an edit"
            );
        }
        let grey_key = SpillSuppressor {
            color_to_suppress: Rgba {
                r: 0.5,
                g: 0.5,
                b: 0.5,
                a: 1.0,
                space: SourceColorSpace::Srgb,
            },
            color_accuracy: SpillAccuracy::Better,
            suppression: 1.0,
        };
        assert_eq!(
            packed(Effect::SpillSuppressor(grey_key), s).kind,
            IDENTITY,
            "a grey key has no cast"
        );
        assert_eq!(
            apply_pixel(&packed(Effect::Extract(Extract::default()), s), px),
            px,
            "every channel inside 0 to 255 stays"
        );
    }

    /// Expected values computed independently in Python (float64) from `arithmetic`
    /// (channel.rs) in EffectCraft's source at the pinned commit: every operator with and without
    /// the clip, the 8-bit rounding of And, Or and Xor on the halves, and unclipped HDR.
    #[test]
    // The expected values are float64 results of the independent reference, kept as computed.
    #[allow(clippy::excessive_precision)]
    fn batch_ten_arithmetic_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::ArithmeticOperator;
        type Case = (
            &'static str,
            ArithmeticOperator,
            [f32; 3],
            f32,
            [f64; 3],
            bool,
            [f32; 3],
        );
        let cases: &[Case] = &[
            (
                "And clip=True",
                ArithmeticOperator::And,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.0, 0.25098039215686274, 0.13333333333333333],
            ),
            (
                "And clip=False",
                ArithmeticOperator::And,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.0, 0.25098039215686274, 0.13333333333333333],
            ),
            (
                "Or clip=True",
                ArithmeticOperator::Or,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.8941176470588236, 0.7843137254901961, 0.9647058823529412],
            ),
            (
                "Or clip=False",
                ArithmeticOperator::Or,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.8941176470588236, 0.7843137254901961, 0.9647058823529412],
            ),
            (
                "Xor clip=True",
                ArithmeticOperator::Xor,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.8941176470588236, 0.5333333333333333, 0.8313725490196079],
            ),
            (
                "Xor clip=False",
                ArithmeticOperator::Xor,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.8941176470588236, 0.5333333333333333, 0.8313725490196079],
            ),
            (
                "Add clip=True",
                ArithmeticOperator::Add,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.8921568691730499, 1.0, 1.0],
            ),
            (
                "Add clip=False",
                ArithmeticOperator::Add,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.8921568691730499, 1.0343137383460999, 1.0960784345865249],
            ),
            (
                "Subtract clip=True",
                ArithmeticOperator::Subtract,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.10784313082695007, 0.0, 0.7039215654134751],
            ),
            (
                "Subtract clip=False",
                ArithmeticOperator::Subtract,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.10784313082695007, 0.0, 0.7039215654134751],
            ),
            (
                "Difference clip=True",
                ArithmeticOperator::Difference,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.10784313082695007, 0.5343137383460999, 0.7039215654134751],
            ),
            (
                "Difference clip=False",
                ArithmeticOperator::Difference,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.10784313082695007, 0.5343137383460999, 0.7039215654134751],
            ),
            (
                "Min clip=True",
                ArithmeticOperator::Min,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.3921568691730499, 0.25, 0.19607843458652496],
            ),
            (
                "Min clip=False",
                ArithmeticOperator::Min,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.3921568691730499, 0.25, 0.19607843458652496],
            ),
            (
                "Max clip=True",
                ArithmeticOperator::Max,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.5, 0.7843137383460999, 0.9],
            ),
            (
                "Max clip=False",
                ArithmeticOperator::Max,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.5, 0.7843137383460999, 0.9],
            ),
            (
                "BlockAbove clip=True",
                ArithmeticOperator::BlockAbove,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.0, 0.25, 0.0],
            ),
            (
                "BlockAbove clip=False",
                ArithmeticOperator::BlockAbove,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.0, 0.25, 0.0],
            ),
            (
                "BlockBelow clip=True",
                ArithmeticOperator::BlockBelow,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.5, 0.0, 0.9],
            ),
            (
                "BlockBelow clip=False",
                ArithmeticOperator::BlockBelow,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.5, 0.0, 0.9],
            ),
            (
                "Slice clip=True",
                ArithmeticOperator::Slice,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [1.0, 0.0, 1.0],
            ),
            (
                "Slice clip=False",
                ArithmeticOperator::Slice,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [1.0, 0.0, 1.0],
            ),
            (
                "Multiply clip=True",
                ArithmeticOperator::Multiply,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [
                    0.19607843458652496,
                    0.19607843458652496,
                    0.17647059112787247,
                ],
            ),
            (
                "Multiply clip=False",
                ArithmeticOperator::Multiply,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [
                    0.19607843458652496,
                    0.19607843458652496,
                    0.17647059112787247,
                ],
            ),
            (
                "Screen clip=True",
                ArithmeticOperator::Screen,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                true,
                [0.696078434586525, 0.8382353037595749, 0.9196078434586525],
            ),
            (
                "Screen clip=False",
                ArithmeticOperator::Screen,
                [0.5, 0.25, 0.9],
                0.8,
                [100.0, 200.0, 50.0],
                false,
                [0.696078434586525, 0.8382353037595749, 0.9196078434586525],
            ),
            (
                "And on the half",
                ArithmeticOperator::And,
                [0.5, 0.5, 0.5],
                1.0,
                [128.0, 127.0, 0.0],
                true,
                [0.5019607843137255, 0.0, 0.0],
            ),
            (
                "Or on the half",
                ArithmeticOperator::Or,
                [0.5, 0.5, 0.5],
                1.0,
                [128.0, 127.0, 0.0],
                true,
                [0.5019607843137255, 1.0, 0.5019607843137255],
            ),
            (
                "Xor on the half",
                ArithmeticOperator::Xor,
                [0.5, 0.5, 0.5],
                1.0,
                [128.0, 127.0, 0.0],
                true,
                [0.0, 1.0, 0.5019607843137255],
            ),
            (
                "Add hdr unclipped",
                ArithmeticOperator::Add,
                [2.0, 0.1, 0.5],
                1.0,
                [50.0, 50.0, 255.0],
                false,
                [2.196078434586525, 0.29607843458652494, 1.5],
            ),
            (
                "Subtract hdr unclipped",
                ArithmeticOperator::Subtract,
                [2.0, 0.1, 0.5],
                1.0,
                [50.0, 50.0, 255.0],
                false,
                [1.803921565413475, 0.0, 0.0],
            ),
            (
                "Multiply hdr unclipped",
                ArithmeticOperator::Multiply,
                [2.0, 0.1, 0.5],
                1.0,
                [50.0, 50.0, 255.0],
                false,
                [0.3921568691730499, 0.019607843458652498, 0.5],
            ),
            (
                "BlockAbove on the setting",
                ArithmeticOperator::BlockAbove,
                [0.3921568691730499, 0.7843137383460999, 0.19607843458652496],
                1.0,
                [100.0, 200.0, 50.0],
                true,
                [0.3921568691730499, 0.7843137383460999, 0.19607843458652496],
            ),
            (
                "BlockBelow on the setting",
                ArithmeticOperator::BlockBelow,
                [0.3921568691730499, 0.7843137383460999, 0.19607843458652496],
                1.0,
                [100.0, 200.0, 50.0],
                true,
                [0.3921568691730499, 0.7843137383460999, 0.19607843458652496],
            ),
            (
                "Slice on the setting",
                ArithmeticOperator::Slice,
                [0.3921568691730499, 0.7843137383460999, 0.19607843458652496],
                1.0,
                [100.0, 200.0, 50.0],
                true,
                [1.0, 1.0, 1.0],
            ),
        ];
        for (name, operator, c, a, values, clip, want) in cases {
            let k = packed(
                Effect::Arithmetic(Arithmetic {
                    operator: *operator,
                    red_value: values[0],
                    green_value: values[1],
                    blue_value: values[2],
                    clip: *clip,
                }),
                WorkingColorSpace::Srgb,
            );
            let o = apply_pixel(
                &k,
                WorkingRgba {
                    r: c[0] * a,
                    g: c[1] * a,
                    b: c[2] * a,
                    a: *a,
                },
            );
            assert!((o.a - a).abs() < 1e-6, "{name}: alpha {} vs {a}", o.a);
            for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                assert!((got / o.a - want).abs() < 1e-5, "{name}: {o:?} vs {want:?}");
            }
        }
    }

    /// Expected values computed independently in Python (float64) from `color_difference_key`
    /// and `matte_levels` (keying.rs) at the pinned commit: every stage of the matte, levels on
    /// both partial mattes and the matte, green, red and grey keys (a tie goes to green), More
    /// Accurate, and a linear project. The four-up view needs the pixel position and is not here.
    #[test]
    // The expected values are float64 results of the independent reference, kept as computed.
    #[allow(clippy::excessive_precision)]
    fn batch_ten_color_difference_key_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::{ColorDiffView, MatchAccuracy};
        const LV_DEFAULT: [f64; 5] = [0.0, 255.0, 1.0, 0.0, 255.0];
        const LV_A: [f64; 5] = [50.0, 200.0, 1.5, 10.0, 240.0];
        const LV_B: [f64; 5] = [30.0, 220.0, 0.7, 0.0, 255.0];
        const MATTE_DEFAULT: [f64; 3] = [0.0, 255.0, 1.0];
        const MATTE_LEVELS: [f64; 3] = [20.0, 230.0, 1.2];
        let levels = |l: [f64; 5]| MatteLevels {
            in_black: l[0],
            in_white: l[1],
            gamma: l[2],
            out_black: l[3],
            out_white: l[4],
        };
        let views = [
            ColorDiffView::Source,
            ColorDiffView::UncorrectedMatteA,
            ColorDiffView::CorrectedMatteA,
            ColorDiffView::UncorrectedMatteB,
            ColorDiffView::CorrectedMatteB,
            ColorDiffView::UncorrectedMatte,
            ColorDiffView::CorrectedMatte,
            ColorDiffView::FinalOutput,
        ];
        // (name, view, key, colour, alpha, more accurate, linear project, levels A, levels B,
        // matte levels, expected straight colour, expected alpha)
        type Case = (
            &'static str,
            usize,
            [f32; 3],
            [f32; 3],
            f32,
            bool,
            bool,
            [f64; 5],
            [f64; 5],
            [f64; 3],
            [f32; 3],
            f32,
        );
        let cases: &[Case] = &[
            (
                "view 1 mix",
                1,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.5, 0.5, 0.5],
                1.0,
            ),
            (
                "view 1 mix half alpha",
                1,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.25, 0.25, 0.25],
                1.0,
            ),
            (
                "view 2 mix",
                2,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.5, 0.5, 0.5],
                1.0,
            ),
            (
                "view 2 mix half alpha",
                2,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.25, 0.25, 0.25],
                1.0,
            ),
            (
                "view 3 mix",
                3,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.6000000000000001, 0.6000000000000001, 0.6000000000000001],
                1.0,
            ),
            (
                "view 3 mix half alpha",
                3,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [
                    0.30000000000000004,
                    0.30000000000000004,
                    0.30000000000000004,
                ],
                1.0,
            ),
            (
                "view 4 mix",
                4,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.6000000000000001, 0.6000000000000001, 0.6000000000000001],
                1.0,
            ),
            (
                "view 4 mix half alpha",
                4,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [
                    0.30000000000000004,
                    0.30000000000000004,
                    0.30000000000000004,
                ],
                1.0,
            ),
            (
                "view 5 mix",
                5,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.6000000000000001, 0.6000000000000001, 0.6000000000000001],
                1.0,
            ),
            (
                "view 5 mix half alpha",
                5,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [
                    0.30000000000000004,
                    0.30000000000000004,
                    0.30000000000000004,
                ],
                1.0,
            ),
            (
                "view 6 mix",
                6,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.6000000000000001, 0.6000000000000001, 0.6000000000000001],
                1.0,
            ),
            (
                "view 6 mix half alpha",
                6,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [
                    0.30000000000000004,
                    0.30000000000000004,
                    0.30000000000000004,
                ],
                1.0,
            ),
            (
                "view 7 mix",
                7,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.2, 0.3, 0.7],
                0.6000000000000001,
            ),
            (
                "view 7 mix half alpha",
                7,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.2, 0.3, 0.7],
                0.30000000000000004,
            ),
            (
                "final blue",
                7,
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.0, 0.0, 1.0],
                0.0,
            ),
            (
                "final green",
                7,
                [0.0, 0.0, 1.0],
                [0.0, 1.0, 0.0],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.0, 1.0, 0.0],
                1.0,
            ),
            (
                "final mix",
                7,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.2, 0.3, 0.7],
                0.6000000000000001,
            ),
            (
                "final mix half alpha",
                7,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                0.5,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.2, 0.3, 0.7],
                0.30000000000000004,
            ),
            (
                "final light",
                7,
                [0.0, 0.0, 1.0],
                [0.6, 0.65, 0.8],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.6, 0.65, 0.8],
                0.85,
            ),
            (
                "levels view 2",
                2,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_A,
                LV_B,
                MATTE_LEVELS,
                [0.6199729065547962, 0.6199729065547962, 0.6199729065547962],
                1.0,
            ),
            (
                "levels view 4",
                4,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_A,
                LV_B,
                MATTE_LEVELS,
                [0.5372995088198185, 0.5372995088198185, 0.5372995088198185],
                1.0,
            ),
            (
                "levels view 6",
                6,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_A,
                LV_B,
                MATTE_LEVELS,
                [0.7051700853885572, 0.7051700853885572, 0.7051700853885572],
                1.0,
            ),
            (
                "levels view 7",
                7,
                [0.0, 0.0, 1.0],
                [0.2, 0.3, 0.7],
                1.0,
                false,
                false,
                LV_A,
                LV_B,
                MATTE_LEVELS,
                [0.2, 0.3, 0.7],
                0.7051700853885572,
            ),
            (
                "green key accurate=False",
                5,
                [0.1, 0.8, 0.2],
                [0.3, 0.6, 0.35],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.5833333333333334, 0.5833333333333334, 0.5833333333333334],
                1.0,
            ),
            (
                "green key accurate=True",
                5,
                [0.1, 0.8, 0.2],
                [0.3, 0.6, 0.35],
                1.0,
                true,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.6179137136375903, 0.6179137136375903, 0.6179137136375903],
                1.0,
            ),
            (
                "red key accurate=False",
                5,
                [0.9, 0.1, 0.1],
                [0.3, 0.6, 0.35],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [1.0, 1.0, 1.0],
                1.0,
            ),
            (
                "red key accurate=True",
                5,
                [0.9, 0.1, 0.1],
                [0.3, 0.6, 0.35],
                1.0,
                true,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [1.0, 1.0, 1.0],
                1.0,
            ),
            (
                "grey key accurate=False",
                5,
                [0.5, 0.5, 0.5],
                [0.3, 0.6, 0.35],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.0, 0.0, 0.0],
                1.0,
            ),
            (
                "grey key accurate=True",
                5,
                [0.5, 0.5, 0.5],
                [0.3, 0.6, 0.35],
                1.0,
                true,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.0, 0.0, 0.0],
                1.0,
            ),
            (
                "linear project accurate=False",
                5,
                [0.0, 0.0, 1.0],
                [0.1, 0.3, 0.2],
                1.0,
                false,
                true,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [1.0, 1.0, 1.0],
                1.0,
            ),
            (
                "linear project accurate=True",
                5,
                [0.0, 0.0, 1.0],
                [0.1, 0.3, 0.2],
                1.0,
                true,
                true,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [1.0, 1.0, 1.0],
                1.0,
            ),
            (
                "linear project, blue-dominant, view 5 accurate=False",
                5,
                [0.0, 0.0, 1.0],
                [0.1, 0.2, 0.5],
                1.0,
                false,
                true,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.7491722214292574, 0.7491722214292574, 0.7491722214292574],
                1.0,
            ),
            (
                "linear project, blue-dominant, view 7 accurate=False",
                7,
                [0.0, 0.0, 1.0],
                [0.1, 0.2, 0.5],
                1.0,
                false,
                true,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.1, 0.2, 0.5],
                0.7491722214292574,
            ),
            (
                "linear project, blue-dominant, view 5 accurate=True",
                5,
                [0.0, 0.0, 1.0],
                [0.1, 0.2, 0.5],
                1.0,
                true,
                true,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.7, 0.7, 0.7],
                1.0,
            ),
            (
                "linear project, blue-dominant, view 7 accurate=True",
                7,
                [0.0, 0.0, 1.0],
                [0.1, 0.2, 0.5],
                1.0,
                true,
                true,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.1, 0.2, 0.5],
                0.7,
            ),
            (
                "a key whose channels are nearly equal",
                5,
                [0.5, 0.504, 0.5],
                [0.5, 0.5015, 0.5],
                1.0,
                false,
                false,
                LV_DEFAULT,
                LV_DEFAULT,
                MATTE_DEFAULT,
                [0.6250000000000139, 0.6250000000000139, 0.6250000000000139],
                1.0,
            ),
        ];
        for (name, view, key, c, a, accurate, linear, la, lb, m, want, want_a) in cases {
            let working = if *linear {
                WorkingColorSpace::LinearSrgb
            } else {
                WorkingColorSpace::Srgb
            };
            let k = packed(
                Effect::ColorDifferenceKey(ColorDifferenceKey {
                    view: views[*view],
                    key_color: Rgba {
                        r: f64::from(key[0]),
                        g: f64::from(key[1]),
                        b: f64::from(key[2]),
                        a: 1.0,
                        space: SourceColorSpace::Srgb,
                    },
                    color_matching_accuracy: if *accurate {
                        MatchAccuracy::MoreAccurate
                    } else {
                        MatchAccuracy::Faster
                    },
                    partial_a: levels(*la),
                    partial_b: levels(*lb),
                    matte_black: m[0],
                    matte_white: m[1],
                    matte_gamma: m[2],
                }),
                working,
            );
            let o = apply_pixel(
                &k,
                WorkingRgba {
                    r: c[0] * a,
                    g: c[1] * a,
                    b: c[2] * a,
                    a: *a,
                },
            );
            assert!(
                (o.a - want_a).abs() < 1e-4,
                "{name}: alpha {} vs {want_a}",
                o.a
            );
            if o.a > 1e-6 {
                for (got, want) in [(o.r, want[0]), (o.g, want[1]), (o.b, want[2])] {
                    assert!((got / o.a - want).abs() < 1e-4, "{name}: {o:?} vs {want:?}");
                }
            }
        }
    }

    #[test]
    fn selective_color_moves_inks_by_range_as_worked_by_hand() {
        let s = WorkingColorSpace::Srgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let ink = |cyan, magenta, yellow, black| InkShift {
            cyan,
            magenta,
            yellow,
            black,
        };
        let run = |sc: SelectiveColor, px: WorkingRgba| {
            let o = apply_pixel(&packed(Effect::SelectiveColor(sc), s), px);
            [o.r, o.g, o.b]
        };
        let near = |got: [f32; 3], want: [f32; 3], note: &str| {
            for (g, w) in got.iter().zip(want) {
                assert!((g - w).abs() < 1e-5, "{note}: {got:?} vs {want:?}");
            }
        };
        // Pure red belongs wholly to Reds. Absolute +100% cyan removes all the red.
        near(
            run(
                SelectiveColor {
                    method: SelectiveMethod::Absolute,
                    reds: ink(1.0, 0.0, 0.0, 0.0),
                    ..SelectiveColor::default()
                },
                rgb(1.0, 0.0, 0.0),
            ),
            [0.0, 0.0, 0.0],
            "absolute cyan on red",
        );
        // Relative moves a share of the ink the pixel has: (0.8, 0.2, 0.2) has 0.2 cyan ink, and
        // its Reds weight is 0.6 (0.8 less 0.2). -50% cyan: red rises by 0.6 * 0.5 * 0.2 = 0.06.
        near(
            run(
                SelectiveColor {
                    reds: ink(-0.5, 0.0, 0.0, 0.0),
                    ..SelectiveColor::default()
                },
                rgb(0.8, 0.2, 0.2),
            ),
            [0.86, 0.2, 0.2],
            "relative cyan on a mid red",
        );
        // Black moves all three: inks are 0.2, 0.8, 0.8; +50% of each at weight 0.6 takes 0.06,
        // 0.24 and 0.24 away, and the channels hold at 0 below it.
        near(
            run(
                SelectiveColor {
                    reds: ink(0.0, 0.0, 0.0, 0.5),
                    ..SelectiveColor::default()
                },
                rgb(0.8, 0.2, 0.2),
            ),
            [0.74, 0.0, 0.0],
            "relative black on a mid red",
        );
        // Mid grey is all Neutrals; Absolute +20% black takes 0.2 off every channel.
        near(
            run(
                SelectiveColor {
                    method: SelectiveMethod::Absolute,
                    neutrals: ink(0.0, 0.0, 0.0, 0.2),
                    ..SelectiveColor::default()
                },
                rgb(0.5, 0.5, 0.5),
            ),
            [0.3, 0.3, 0.3],
            "absolute black on grey",
        );
        // White is all Whites. Relative has no ink to add to it; Absolute does.
        let whites = |method| SelectiveColor {
            method,
            whites: ink(0.0, 0.0, 0.0, 0.5),
            ..SelectiveColor::default()
        };
        near(
            run(whites(SelectiveMethod::Relative), rgb(1.0, 1.0, 1.0)),
            [1.0, 1.0, 1.0],
            "relative black on white",
        );
        near(
            run(whites(SelectiveMethod::Absolute), rgb(1.0, 1.0, 1.0)),
            [0.5, 0.5, 0.5],
            "absolute black on white",
        );
        // Yellow is a secondary: pure yellow is wholly Yellows, and -100% yellow ink makes white.
        near(
            run(
                SelectiveColor {
                    method: SelectiveMethod::Absolute,
                    yellows: ink(0.0, 0.0, -1.0, 0.0),
                    ..SelectiveColor::default()
                },
                rgb(1.0, 1.0, 0.0),
            ),
            [1.0, 1.0, 1.0],
            "yellow ink out of yellow",
        );
        // A range the pixel is not in does nothing: Blues leave red alone.
        near(
            run(
                SelectiveColor {
                    method: SelectiveMethod::Absolute,
                    blues: ink(1.0, 1.0, 1.0, 1.0),
                    ..SelectiveColor::default()
                },
                rgb(1.0, 0.0, 0.0),
            ),
            [1.0, 0.0, 0.0],
            "an unrelated range",
        );
        // Over-bright: red 1.5 has no cyan ink left to take a share of, so Relative leaves it
        // (the ink is held at 0), where a negative ink would push it down.
        near(
            run(
                SelectiveColor {
                    reds: ink(-0.5, 0.0, 0.0, 0.0),
                    ..SelectiveColor::default()
                },
                rgb(1.5, 0.2, 0.2),
            ),
            [1.5, 0.2, 0.2],
            "relative on an over-bright channel",
        );
        // Partly in Neutrals: (0.8, 0.2, 0.2) has a Neutrals weight of 1 - (0.3 + 0.3) = 0.4,
        // so Absolute +25% black takes 0.4 * 0.25 = 0.1 off each channel.
        near(
            run(
                SelectiveColor {
                    method: SelectiveMethod::Absolute,
                    neutrals: ink(0.0, 0.0, 0.0, 0.25),
                    ..SelectiveColor::default()
                },
                rgb(0.8, 0.2, 0.2),
            ),
            [0.7, 0.1, 0.1],
            "a partial Neutrals weight",
        );
        // The weights themselves, in the order reds, yellows, greens, cyans, blues, magentas,
        // whites, neutrals, blacks. (0.9, 0.8, 0.7): red leads green by 0.1, green leads blue by
        // 0.1 with blue smallest (Yellows), Whites (0.7 - 0.5) * 2, Neutrals 1 - (0.4 + 0.2).
        // (0.2, 0.6, 0.6) ties green and blue, so the sort keeps green first and the smallest,
        // red, makes the middle's lead over it Cyans. (0.1, 0.2, 0.3): Blues lead by 0.1, red smallest
        // gives Cyans 0.1, Blacks (0.5 - 0.3) * 2, Neutrals 1 - (0.2 + 0.4).
        for (c, want) in [
            (
                [0.9, 0.8, 0.7],
                [0.1, 0.1, 0.0, 0.0, 0.0, 0.0, 0.4, 0.4, 0.0],
            ),
            (
                [0.2, 0.6, 0.6],
                [0.0, 0.0, 0.0, 0.4, 0.0, 0.0, 0.0, 0.6, 0.0],
            ),
            (
                [0.1, 0.2, 0.3],
                [0.0, 0.0, 0.0, 0.1, 0.1, 0.0, 0.0, 0.4, 0.4],
            ),
        ] {
            let got = selective_weights(c);
            for (r, (g, w)) in got.iter().zip(want).enumerate() {
                assert!(
                    (g - w).abs() < 1e-5,
                    "{c:?}: range {r}: {got:?} vs {want:?}"
                );
            }
        }
        // No shift at all is the picture, and transparent stays transparent.
        let none = packed(Effect::SelectiveColor(SelectiveColor::default()), s);
        let px = WorkingRgba {
            r: 0.3 * 0.7,
            g: 0.5 * 0.7,
            b: 0.2 * 0.7,
            a: 0.7,
        };
        assert_eq!(apply_pixel(&none, px), px);
        assert_eq!(
            apply_pixel(&none, WorkingRgba::transparent()),
            WorkingRgba::transparent()
        );
        // Coverage is the layer's own: a shift never makes a transparent pixel appear.
        let shifted = packed(
            Effect::SelectiveColor(SelectiveColor {
                method: SelectiveMethod::Absolute,
                neutrals: ink(-1.0, -1.0, -1.0, -1.0),
                ..SelectiveColor::default()
            }),
            s,
        );
        assert_eq!(
            apply_pixel(&shifted, WorkingRgba::transparent()),
            WorkingRgba::transparent()
        );
    }

    #[test]
    fn batch_ten_source_view_and_defaults_are_the_identity_or_a_keep() {
        use gx_contracts::effect::ColorDiffView;
        let px = WorkingRgba {
            r: 0.1,
            g: 0.2,
            b: 0.7,
            a: 1.0,
        };
        let source = packed(
            Effect::ColorDifferenceKey(ColorDifferenceKey {
                view: ColorDiffView::Source,
                ..ColorDifferenceKey::default()
            }),
            WorkingColorSpace::Srgb,
        );
        assert_eq!(
            apply_pixel(&source, px),
            px,
            "the source view is the picture"
        );
        // Arithmetic's default is Add 0: nothing added, so the picture stays.
        let add_nothing = packed(
            Effect::Arithmetic(Arithmetic::default()),
            WorkingColorSpace::Srgb,
        );
        let o = apply_pixel(&add_nothing, px);
        assert!(
            (o.r - px.r).abs() < 1e-7 && (o.g - px.g).abs() < 1e-7 && (o.b - px.b).abs() < 1e-7
        );
        assert_eq!(
            apply_pixel(&add_nothing, WorkingRgba::transparent()),
            WorkingRgba::transparent()
        );
    }

    /// Expected values computed independently in Python (float64) from a reading of EffectCraft's
    /// `color_range`, `range_components` and `to_lab` (keying.rs): Lab, YUV and RGB boxes, the
    /// fuzziness, the edge, the alpha it had, HDR, and a linear project.
    #[test]
    fn batch_nine_color_range_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::RangeSpace;
        let px = |c: [f32; 3], a: f32| WorkingRgba {
            r: c[0] * a,
            g: c[1] * a,
            b: c[2] * a,
            a,
        };
        // (name, space, colour, alpha, low, high, fuzziness, linear project, expected alpha)
        #[allow(clippy::type_complexity)]
        let cases: &[(
            &str,
            RangeSpace,
            [f32; 3],
            f32,
            [f64; 3],
            [f64; 3],
            f64,
            bool,
            f32,
        )] = &[
            (
                "lab grey inside, hard",
                RangeSpace::Lab,
                [0.5, 0.5, 0.5],
                1.0,
                [100.0, 100.0, 100.0],
                [255.0, 160.0, 160.0],
                0.0,
                false,
                0.0,
            ),
            (
                "lab red outside, hard",
                RangeSpace::Lab,
                [1.0, 0.0, 0.0],
                1.0,
                [100.0, 100.0, 100.0],
                [255.0, 160.0, 160.0],
                0.0,
                false,
                1.0,
            ),
            (
                "lab red outside, fuzzy",
                RangeSpace::Lab,
                [1.0, 0.0, 0.0],
                1.0,
                [100.0, 100.0, 100.0],
                [255.0, 160.0, 160.0],
                100.0,
                false,
                0.481_093,
            ),
            (
                "lab red, half alpha",
                RangeSpace::Lab,
                [1.0, 0.0, 0.0],
                0.5,
                [100.0, 100.0, 100.0],
                [255.0, 160.0, 160.0],
                100.0,
                false,
                0.240_547,
            ),
            (
                "lab near the box",
                RangeSpace::Lab,
                [0.5, 0.45, 0.5],
                1.0,
                [100.0, 100.0, 100.0],
                [255.0, 130.0, 130.0],
                20.0,
                false,
                0.270_701,
            ),
            (
                "lab default box, blue",
                RangeSpace::Lab,
                [0.0, 0.0, 1.0],
                1.0,
                [0.0, 0.0, 128.0],
                [255.0, 100.0, 255.0],
                0.0,
                false,
                1.0,
            ),
            (
                "lab hdr white clamps",
                RangeSpace::Lab,
                [2.0, 2.0, 2.0],
                1.0,
                [250.0, 120.0, 120.0],
                [255.0, 136.0, 136.0],
                0.0,
                false,
                0.0,
            ),
            (
                "yuv grey inside",
                RangeSpace::Yuv,
                [0.5, 0.5, 0.5],
                1.0,
                [100.0, 100.0, 100.0],
                [200.0, 160.0, 160.0],
                0.0,
                false,
                0.0,
            ),
            (
                "yuv red outside",
                RangeSpace::Yuv,
                [1.0, 0.0, 0.0],
                1.0,
                [100.0, 100.0, 100.0],
                [200.0, 160.0, 160.0],
                50.0,
                false,
                1.0,
            ),
            (
                "yuv green, fuzzy 200",
                RangeSpace::Yuv,
                [0.0, 1.0, 0.0],
                1.0,
                [100.0, 100.0, 100.0],
                [200.0, 160.0, 160.0],
                200.0,
                false,
                0.516_612,
            ),
            (
                "rgb blue inside",
                RangeSpace::Rgb,
                [0.1, 0.2, 0.9],
                1.0,
                [0.0, 0.0, 200.0],
                [100.0, 100.0, 255.0],
                0.0,
                false,
                0.0,
            ),
            (
                "rgb half outside",
                RangeSpace::Rgb,
                [0.5, 0.2, 0.9],
                1.0,
                [0.0, 0.0, 200.0],
                [100.0, 100.0, 255.0],
                55.0,
                false,
                0.5,
            ),
            (
                "rgb on the bound is inside",
                RangeSpace::Rgb,
                [1.0, 0.0, 0.0],
                1.0,
                [255.0, 0.0, 0.0],
                [255.0, 0.0, 0.0],
                0.0,
                false,
                0.0,
            ),
            (
                "rgb past the bound",
                RangeSpace::Rgb,
                [1.0, 0.0, 0.1],
                1.0,
                [255.0, 0.0, 0.0],
                [255.0, 0.0, 0.0],
                100.0,
                false,
                0.255,
            ),
            (
                "rgb hdr is not clamped",
                RangeSpace::Rgb,
                [2.0, 0.0, 0.0],
                1.0,
                [0.0, 0.0, 0.0],
                [255.0, 255.0, 255.0],
                0.0,
                false,
                1.0,
            ),
            (
                "linear project grey",
                RangeSpace::Rgb,
                [0.214_041_14; 3],
                1.0,
                [127.0; 3],
                [128.0; 3],
                0.0,
                true,
                0.0,
            ),
            (
                "srgb project, same value",
                RangeSpace::Rgb,
                [0.214_041_14; 3],
                1.0,
                [127.0; 3],
                [128.0; 3],
                0.0,
                false,
                1.0,
            ),
            (
                "lab: L decides",
                RangeSpace::Lab,
                [0.5, 0.5, 0.5],
                1.0,
                [135.0, 0.0, 0.0],
                [255.0, 255.0, 255.0],
                10.0,
                false,
                0.0,
            ),
            (
                "lab: b decides, red",
                RangeSpace::Lab,
                [1.0, 0.0, 0.0],
                1.0,
                [0.0, 0.0, 200.0],
                [255.0, 255.0, 255.0],
                20.0,
                false,
                0.238_997,
            ),
            (
                "lab: b decides, blue",
                RangeSpace::Lab,
                [0.0, 0.0, 1.0],
                1.0,
                [0.0, 0.0, 30.0],
                [255.0, 255.0, 255.0],
                20.0,
                false,
                0.493_184,
            ),
            (
                "lab: a dark grey on the linear segment",
                RangeSpace::Lab,
                [0.05, 0.05, 0.05],
                1.0,
                [11.066, 0.0, 0.0],
                [255.0, 255.0, 255.0],
                10.0,
                false,
                0.2,
            ),
            (
                "lab: a dark grey just above the segment",
                RangeSpace::Lab,
                [0.12, 0.12, 0.12],
                1.0,
                [31.4792, 0.0, 0.0],
                [255.0, 255.0, 255.0],
                10.0,
                false,
                0.2,
            ),
            (
                "yuv: Y decides, inside",
                RangeSpace::Yuv,
                [0.5, 0.5, 0.5],
                1.0,
                [127.0, 0.0, 0.0],
                [128.0, 255.0, 255.0],
                10.0,
                false,
                0.0,
            ),
            (
                "yuv: Y decides, outside",
                RangeSpace::Yuv,
                [0.5, 0.5, 0.5],
                1.0,
                [130.0, 0.0, 0.0],
                [255.0, 255.0, 255.0],
                10.0,
                false,
                0.25,
            ),
        ];
        for (name, space, c, a, lo, hi, fuzziness, linear, want) in cases {
            let working = if *linear {
                WorkingColorSpace::LinearSrgb
            } else {
                WorkingColorSpace::Srgb
            };
            let key = packed(
                Effect::ColorRange(ColorRange {
                    fuzziness: *fuzziness,
                    color_space: *space,
                    min_l: lo[0],
                    max_l: hi[0],
                    min_a: lo[1],
                    max_a: hi[1],
                    min_b: lo[2],
                    max_b: hi[2],
                }),
                working,
            );
            let o = apply_pixel(&key, px(*c, *a));
            assert!((o.a - want).abs() < 1e-4, "{name}: alpha {} vs {want}", o.a);
            // The colour is untouched: straight, it is what went in.
            if o.a > 1e-6 {
                for (got, want) in [(o.r, c[0]), (o.g, c[1]), (o.b, c[2])] {
                    assert!((got / o.a - want).abs() < 1e-4, "{name}: colour {o:?}");
                }
            }
        }
    }

    #[test]
    fn batch_nine_defaults_and_transparent_pixels_behave() {
        // EffectCraft's defaults: a Lab box that most colours are outside, so most are kept; a
        // transparent pixel stays transparent whatever the box.
        let key = packed(
            Effect::ColorRange(ColorRange::default()),
            WorkingColorSpace::Srgb,
        );
        assert_eq!(
            apply_pixel(&key, WorkingRgba::transparent()),
            WorkingRgba::transparent()
        );
        let kept = apply_pixel(
            &key,
            WorkingRgba {
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            },
        );
        assert_eq!(kept.a, 1.0, "a red is outside the default box, so it stays");
    }

    /// Expected values computed independently in Python from EffectCraft's `extract`,
    /// `spill_suppressor` (keying.rs), `unmult` (keying2.rs) and `color_neutralizer` (color3.rs).
    #[test]
    fn batch_eight_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::{ExtractChannel, SpillAccuracy, UnmultBackground};
        let s = WorkingColorSpace::Srgb;
        let px = |r: f32, g: f32, b: f32, a: f32| WorkingRgba {
            r: r * a,
            g: g * a,
            b: b * a,
            a,
        };
        let near = |o: WorkingRgba, want: [f32; 4], note: &str| {
            for (got, want) in [
                (o.r, want[0]),
                (o.g, want[1]),
                (o.b, want[2]),
                (o.a, want[3]),
            ] {
                assert!((got - want).abs() < 1e-5, "{note}: {o:?} vs {want:?}");
            }
        };
        let gone = |o: WorkingRgba, note: &str| {
            assert_eq!(o, WorkingRgba::transparent(), "{note}");
        };
        // Extract.
        let extract = |channel, black, white, black_soft, white_soft, invert| {
            packed(
                Effect::Extract(Extract {
                    channel,
                    black_point: black,
                    white_point: white,
                    black_softness: black_soft,
                    white_softness: white_soft,
                    invert,
                }),
                s,
            )
        };
        let lum = ExtractChannel::Luminance;
        let window = extract(lum, 50.0, 200.0, 0.0, 0.0, false);
        gone(
            apply_pixel(&window, px(0.1, 0.1, 0.1, 1.0)),
            "under the black point",
        );
        near(
            apply_pixel(&window, px(0.5, 0.5, 0.5, 1.0)),
            [0.5, 0.5, 0.5, 1.0],
            "between the points",
        );
        gone(
            apply_pixel(&window, px(0.9, 0.9, 0.9, 1.0)),
            "over the white point",
        );
        near(
            apply_pixel(
                &extract(lum, 50.0, 200.0, 100.0, 0.0, false),
                px(0.1, 0.1, 0.1, 1.0),
            ),
            [0.0755, 0.0755, 0.0755, 0.755],
            "black softness fades the dark side",
        );
        near(
            apply_pixel(
                &extract(lum, 50.0, 200.0, 0.0, 50.0, false),
                px(0.85, 0.85, 0.85, 1.0),
            ),
            [0.565_25, 0.565_25, 0.565_25, 0.665],
            "white softness fades the bright side",
        );
        gone(
            apply_pixel(
                &extract(ExtractChannel::Red, 0.0, 100.0, 0.0, 0.0, false),
                px(0.8, 0.2, 0.2, 1.0),
            ),
            "red 204 is over 100",
        );
        near(
            apply_pixel(
                &extract(ExtractChannel::Green, 0.0, 100.0, 0.0, 0.0, false),
                px(0.8, 0.2, 0.2, 1.0),
            ),
            [0.8, 0.2, 0.2, 1.0],
            "green 51 is under 100",
        );
        gone(
            apply_pixel(
                &extract(ExtractChannel::Blue, 0.0, 200.0, 0.0, 0.0, false),
                px(0.2, 0.3, 0.9, 1.0),
            ),
            "blue 229.5 is over 200",
        );
        gone(
            apply_pixel(
                &extract(ExtractChannel::Alpha, 150.0, 255.0, 0.0, 0.0, false),
                px(0.5, 0.5, 0.5, 0.5),
            ),
            "alpha 127.5 is under 150",
        );
        near(
            apply_pixel(
                &extract(lum, 50.0, 200.0, 0.0, 0.0, true),
                px(0.1, 0.1, 0.1, 1.0),
            ),
            [0.1, 0.1, 0.1, 1.0],
            "invert keeps what was dropped",
        );
        gone(
            apply_pixel(
                &extract(lum, 50.0, 200.0, 0.0, 0.0, true),
                px(0.5, 0.5, 0.5, 1.0),
            ),
            "invert drops what was kept",
        );
        gone(
            apply_pixel(
                &extract(lum, 60.0, 200.0, 0.0, 0.0, false),
                px(1.0, 0.0, 0.0, 1.0),
            ),
            "red's luminance is 54, under 60 (a plain mean would be 85)",
        );
        gone(
            apply_pixel(
                &extract(lum, 0.0, 170.0, 0.0, 0.0, false),
                px(0.0, 1.0, 0.0, 1.0),
            ),
            "green's luminance is 182 (Rec.709), over 170",
        );
        // CC Color Neutralizer: shadows lose 0.1 of red, midtones 0.1 of blue, highlights gain 0.1.
        let colour = |r: f32, g: f32, b: f32| Rgba {
            r: f64::from(r),
            g: f64::from(g),
            b: f64::from(b),
            a: 1.0,
            space: SourceColorSpace::Srgb,
        };
        let neutral = |pinning: f64, blend: f64, contrast: f64, darks: f64, brights: f64| {
            packed(
                Effect::CcColorNeutralizer(CcColorNeutralizer {
                    shadows_unbalance: colour(0.1, 0.0, 0.0),
                    shadows_balance: colour(0.0, 0.0, 0.0),
                    midtones_unbalance: colour(0.5, 0.5, 0.6),
                    midtones_balance: colour(0.5, 0.5, 0.5),
                    highlights_unbalance: colour(1.0, 1.0, 0.9),
                    highlights_balance: colour(1.0, 1.0, 1.0),
                    pinning,
                    blend_with_original: blend,
                    darks,
                    brights,
                    contrast,
                }),
                s,
            )
        };
        let plain = neutral(0.0, 0.0, 0.0, 0.0, 0.0);
        for (l, want) in [
            (0.0, [0.0, 0.0, 0.0]),
            (0.25, [0.2, 0.25, 0.2]),
            (0.5, [0.5, 0.5, 0.4]),
            (0.75, [0.75, 0.75, 0.75]),
            (1.0, [1.0, 1.0, 1.1]),
        ] {
            near(
                apply_pixel(&plain, px(l, l, l, 1.0)),
                [want[0], want[1], want[2], 1.0],
                "a grey at each zone",
            );
        }
        near(
            apply_pixel(&plain, px(0.4, 0.5, 0.6, 1.0)),
            [0.399_767_9, 0.5, 0.500_232_1, 1.0],
            "a colour between zones",
        );
        near(
            apply_pixel(&neutral(1.0, 0.0, 0.0, 0.0, 0.0), px(0.4, 0.5, 0.6, 1.0)),
            [0.399_768_07, 0.5, 0.500_310_8, 1.0],
            "pinning eases the push near the middle",
        );
        near(
            apply_pixel(&neutral(1.0, 0.0, 0.0, 0.0, 0.0), px(0.05, 0.05, 0.05, 1.0)),
            [0.031_532, 0.05, 0.049_468, 1.0],
            "pinning near black",
        );
        near(
            apply_pixel(&neutral(0.0, 0.5, 0.0, 0.0, 0.0), px(0.4, 0.5, 0.6, 1.0)),
            [0.399_883_94, 0.5, 0.550_116_06, 1.0],
            "half back to the original",
        );
        near(
            apply_pixel(&neutral(0.0, 0.0, 0.5, 0.0, 0.0), px(0.4, 0.5, 0.6, 1.0)),
            [0.349_651_8, 0.5, 0.500_348_2, 1.0],
            "contrast",
        );
        near(
            apply_pixel(&neutral(0.0, 0.0, 0.0, 0.4, 0.0), px(0.2, 0.2, 0.2, 1.0)),
            [0.1992, 0.264, 0.2288, 1.0],
            "darks lift the shadows",
        );
        near(
            apply_pixel(&neutral(0.0, 0.0, 0.0, 0.0, -0.4), px(0.8, 0.8, 0.8, 1.0)),
            [0.736, 0.736, 0.7656, 1.0],
            "brights pull the highlights down",
        );
        near(
            apply_pixel(&neutral(0.0, 0.0, 1.0, -1.0, 0.0), px(0.0, 0.0, 0.0, 1.0)),
            [0.0, 0.0, 0.0, 1.0],
            "never below black",
        );
        // Unmult.
        let unmult = |background, black: f64, white: f64, softness: f64, decon, clip| {
            packed(
                Effect::Unmult(Unmult {
                    background,
                    black_level: black,
                    white_level: white,
                    softness,
                    remove_color_matting: decon,
                    clip_hdr: clip,
                }),
                s,
            )
        };
        let black = UnmultBackground::Black;
        let white = UnmultBackground::White;
        let classic = unmult(black, 0.0, 1.0, 1.0, true, true);
        near(
            apply_pixel(&classic, px(0.5, 0.25, 0.0, 1.0)),
            [0.5, 0.25, 0.0, 0.5],
            "alpha is the brightest channel, the colour is divided by it",
        );
        gone(
            apply_pixel(&classic, px(0.0, 0.0, 0.0, 1.0)),
            "black is nothing",
        );
        near(
            apply_pixel(&classic, px(0.5, 0.5, 0.5, 0.5)),
            [0.25, 0.25, 0.25, 0.25],
            "the alpha it had is kept",
        );
        near(
            apply_pixel(
                &unmult(black, 0.2, 1.0, 0.5, true, true),
                px(0.4, 0.1, 0.1, 1.0),
            ),
            [0.4, 0.1, 0.1, 0.5],
            "a level and a softness",
        );
        near(
            apply_pixel(
                &unmult(black, 0.0, 1.0, 1.0, false, true),
                px(0.5, 0.25, 0.0, 1.0),
            ),
            [0.25, 0.125, 0.0, 0.5],
            "matting left in",
        );
        near(
            apply_pixel(&classic, px(1.5, 0.5, 0.5, 1.0)),
            [1.0, 0.5, 0.5, 1.0],
            "clipped",
        );
        near(
            apply_pixel(
                &unmult(black, 0.0, 1.0, 1.0, true, false),
                px(1.5, 0.5, 0.5, 1.0),
            ),
            [1.5, 0.5, 0.5, 1.0],
            "unclipped",
        );
        near(
            apply_pixel(
                &unmult(black, 0.3, 1.0, 0.0, true, true),
                px(0.5, 0.2, 0.2, 1.0),
            ),
            [0.5, 0.2, 0.2, 1.0],
            "no softness: a step, above it",
        );
        gone(
            apply_pixel(
                &unmult(black, 0.3, 1.0, 0.0, true, true),
                px(0.3, 0.2, 0.2, 1.0),
            ),
            "no softness: exactly at the level is under it",
        );
        let on_white = unmult(white, 0.0, 1.0, 1.0, true, true);
        near(
            apply_pixel(&on_white, px(1.0, 0.8, 0.9, 1.0)),
            [0.2, 0.0, 0.1, 0.2],
            "on white, coverage is the distance from white",
        );
        near(
            apply_pixel(
                &unmult(white, 0.0, 1.0, 1.0, false, true),
                px(1.0, 0.8, 0.9, 1.0),
            ),
            [0.2, 0.16, 0.18, 0.2],
            "on white, matting left in",
        );
        gone(
            apply_pixel(
                &unmult(white, 0.0, 0.5, 0.5, true, true),
                px(1.0, 0.7, 0.7, 1.0),
            ),
            "on white, under the white level",
        );
        near(
            apply_pixel(
                &unmult(white, 0.0, 0.5, 0.5, true, true),
                px(1.0, 0.4, 0.4, 1.0),
            ),
            [0.4, 0.0, 0.0, 0.4],
            "on white, a level and a softness (the unclipped blue goes under 0 and is clipped)",
        );
        // Spill Suppressor.
        let spill = |key: Rgba, accuracy, amount: f64| {
            packed(
                Effect::SpillSuppressor(SpillSuppressor {
                    color_to_suppress: key,
                    color_accuracy: accuracy,
                    suppression: amount,
                }),
                s,
            )
        };
        let faster = SpillAccuracy::Faster;
        let better = SpillAccuracy::Better;
        let blue = colour(0.0, 0.0, 1.0);
        near(
            apply_pixel(&spill(blue, faster, 1.0), px(0.2, 0.3, 0.8, 1.0)),
            [0.2, 0.3, 0.3, 1.0],
            "blue held to the larger of the others",
        );
        near(
            apply_pixel(&spill(blue, faster, 0.5), px(0.2, 0.3, 0.8, 1.0)),
            [0.2, 0.3, 0.55, 1.0],
            "half the spill",
        );
        near(
            apply_pixel(&spill(blue, faster, 1.5), px(0.2, 0.3, 0.8, 1.0)),
            [0.2, 0.3, 0.05, 1.0],
            "one and a half times the spill",
        );
        near(
            apply_pixel(&spill(blue, faster, 1.0), px(0.2, 0.3, 0.8, 0.5)),
            [0.1, 0.15, 0.15, 0.5],
            "the alpha stays",
        );
        near(
            apply_pixel(
                &spill(colour(0.0, 1.0, 0.0), faster, 1.0),
                px(0.2, 0.9, 0.3, 1.0),
            ),
            [0.2, 0.3, 0.3, 1.0],
            "green key",
        );
        near(
            apply_pixel(
                &spill(colour(1.0, 0.0, 0.0), faster, 1.0),
                px(0.9, 0.2, 0.3, 1.0),
            ),
            [0.3, 0.2, 0.3, 1.0],
            "red key",
        );
        near(
            apply_pixel(
                &spill(colour(1.0, 0.0, 1.0), faster, 1.0),
                px(0.2, 0.1, 0.7, 1.0),
            ),
            [0.2, 0.1, 0.2, 1.0],
            "a magenta key's strongest channel is its blue (the tie goes to blue)",
        );
        near(
            apply_pixel(
                &spill(colour(1.0, 0.0, 1.0), faster, 1.0),
                px(0.8, 0.1, 0.7, 1.0),
            ),
            [0.8, 0.1, 0.7, 1.0],
            "no spill when blue is not over the others",
        );
        near(
            apply_pixel(&spill(blue, faster, 1.0), px(0.9, 0.5, 0.1, 1.0)),
            [0.9, 0.5, 0.1, 1.0],
            "no blue to take out",
        );
        near(
            apply_pixel(&spill(blue, better, 1.0), px(0.2, 0.3, 0.8, 1.0)),
            [0.383_333_34, 0.483_333_34, 0.433_333_34, 1.0],
            "better: the part along the key's chroma comes out",
        );
        near(
            apply_pixel(&spill(blue, better, 0.5), px(0.2, 0.3, 0.8, 1.0)),
            [0.291_666_67, 0.391_666_67, 0.616_666_7, 1.0],
            "better, half",
        );
        near(
            apply_pixel(&spill(blue, better, 1.0), px(0.9, 0.5, 0.1, 1.0)),
            [0.9, 0.5, 0.1, 1.0],
            "better: a pixel pointing away is left alone",
        );
        near(
            apply_pixel(
                &spill(colour(1.0, 0.5, 0.0), better, 1.0),
                px(0.9, 0.6, 0.2, 1.0),
            ),
            [0.55, 0.6, 0.55, 1.0],
            "better works for a key that is not a primary",
        );
        near(
            apply_pixel(
                &spill(colour(0.5, 0.5, 0.5), better, 1.0),
                px(0.2, 0.3, 0.8, 1.0),
            ),
            [0.2, 0.3, 0.8, 1.0],
            "better: a grey key has no cast to remove",
        );
        near(
            apply_pixel(
                &spill(colour(1.0, 1.0, 0.0), faster, 1.0),
                px(0.2, 0.9, 0.1, 1.0),
            ),
            [0.2, 0.2, 0.1, 1.0],
            "a yellow key's strongest channel is its green (the tie goes to green)",
        );
        // Values past white: the zone weights and the lift use luminance held to 0..1.
        near(
            apply_pixel(&neutral(0.0, 0.0, 0.0, 0.0, 0.4), px(2.0, 2.0, 2.0, 1.0)),
            [2.1, 2.1, 2.2, 1.0],
            "an HDR grey is in the highlights, lifted by the brights as white is",
        );
        gone(
            apply_pixel(
                &extract(ExtractChannel::Alpha, 150.0, 255.0, 0.0, 0.0, false),
                px(0.9, 0.1, 0.1, 0.5),
            ),
            "alpha is measured, not red (red 229 would pass)",
        );
        // The window's edges are inside it.
        let edge_a = extract(ExtractChannel::Alpha, 127.5, 255.0, 0.0, 0.0, false);
        near(
            apply_pixel(&edge_a, px(0.5, 0.5, 0.5, 0.5)),
            [0.25, 0.25, 0.25, 0.5],
            "exactly on the black point stays",
        );
        let edge_b = extract(ExtractChannel::Alpha, 0.0, 127.5, 0.0, 0.0, false);
        near(
            apply_pixel(&edge_b, px(0.5, 0.5, 0.5, 0.5)),
            [0.25, 0.25, 0.25, 0.5],
            "exactly on the white point stays",
        );
    }

    /// Expected values computed independently in Python from EffectCraft's `linear_color_key`
    /// (keying.rs) and `remove_color_matting` (channel.rs).
    #[test]
    fn batch_seven_matches_effectcraft_on_known_pixels() {
        use gx_contracts::effect::{KeyMatch, KeyOperation, KeyView};
        let s = WorkingColorSpace::Srgb;
        let rgb = |r, g, b| WorkingRgba::opaque(r, g, b);
        let near = |o: WorkingRgba, want: [f32; 4], note: &str| {
            for (got, want) in [
                (o.r, want[0]),
                (o.g, want[1]),
                (o.b, want[2]),
                (o.a, want[3]),
            ] {
                assert!((got - want).abs() < 1e-5, "{note}: {o:?} vs {want:?}");
            }
        };
        let key = |k: LinearColorKey| packed(Effect::LinearColorKey(k), s);
        let by = |match_colors, keep| LinearColorKey {
            match_colors,
            key_operation: if keep {
                KeyOperation::KeepColors
            } else {
                KeyOperation::KeyColors
            },
            ..LinearColorKey::default()
        };
        let plain = LinearColorKey::default();
        assert_eq!(
            apply_pixel(&key(plain.clone()), rgb(0.0, 0.0, 1.0)),
            WorkingRgba::transparent(),
            "the key colour itself goes"
        );
        near(
            apply_pixel(&key(plain.clone()), rgb(1.0, 0.0, 0.0)),
            [1.0, 0.0, 0.0, 1.0],
            "a red is far from the key",
        );
        let edge = apply_pixel(&key(plain.clone()), rgb(0.0, 0.0, 0.8));
        assert!(
            (edge.a - 0.154_700_5).abs() < 1e-5 && (edge.b - 0.8 * 0.154_700_5).abs() < 1e-5,
            "soft edge: {edge:?}"
        );
        let hard = apply_pixel(
            &key(LinearColorKey {
                softness: 0.0,
                ..plain.clone()
            }),
            rgb(0.0, 0.0, 0.8),
        );
        assert!((hard.a - 1.0).abs() < 1e-6, "no softness: a step: {hard:?}");
        assert_eq!(
            apply_pixel(&key(by(KeyMatch::Hue, false)), rgb(0.1, 0.1, 0.9)),
            WorkingRgba::transparent(),
            "by hue, a dim blue is the key's hue"
        );
        near(
            apply_pixel(&key(by(KeyMatch::Hue, false)), rgb(0.2, 0.9, 0.2)),
            [0.2, 0.9, 0.2, 1.0],
            "by hue, a green is far",
        );
        near(
            apply_pixel(&key(by(KeyMatch::Hue, false)), rgb(0.5, 0.5, 0.5)),
            [0.5, 0.5, 0.5, 1.0],
            "a grey has no hue to key",
        );
        near(
            apply_pixel(&key(by(KeyMatch::Chroma, false)), rgb(0.5, 0.0, 0.5)),
            [0.5, 0.0, 0.5, 1.0],
            "by chroma, a magenta is far",
        );
        assert_eq!(
            apply_pixel(&key(by(KeyMatch::Chroma, false)), rgb(0.02, 0.02, 0.96)),
            WorkingRgba::transparent(),
            "by chroma, a dark blue is the key's chromaticity"
        );
        near(
            apply_pixel(&key(by(KeyMatch::Rgb, true)), rgb(0.0, 0.0, 1.0)),
            [0.0, 0.0, 1.0, 1.0],
            "keep colours: the key colour stays",
        );
        assert_eq!(
            apply_pixel(&key(by(KeyMatch::Rgb, true)), rgb(1.0, 0.0, 0.0)),
            WorkingRgba::transparent(),
            "keep colours: the rest goes"
        );
        // A red key, whose hue and chromaticity are not degenerate.
        let red_key = |match_colors| {
            key(LinearColorKey {
                key_color: Rgba {
                    r: 1.0,
                    g: 0.0,
                    b: 0.0,
                    a: 1.0,
                    space: SourceColorSpace::Srgb,
                },
                match_colors,
                ..plain.clone()
            })
        };
        assert_eq!(
            apply_pixel(&red_key(KeyMatch::Hue), rgb(0.9, 0.1, 0.15)),
            WorkingRgba::transparent(),
            "by hue, a magenta-red just across the wrap is the key's hue"
        );
        near(
            apply_pixel(&red_key(KeyMatch::Hue), rgb(0.505, 0.5, 0.5)),
            [0.505, 0.5, 0.5, 1.0],
            "by hue, a nearly-grey pixel is no hue at all",
        );
        assert_eq!(
            apply_pixel(&red_key(KeyMatch::Chroma), rgb(0.92, 0.08, 0.0)),
            WorkingRgba::transparent(),
            "by chroma, the distance is over the root of two: just inside the tolerance"
        );
        near(
            apply_pixel(&red_key(KeyMatch::Chroma), rgb(0.5, 0.1, 0.1)),
            [0.5, 0.1, 0.1, 1.0],
            "by chroma, a dim red is another chromaticity though its hue is the key's",
        );
        assert_eq!(
            apply_pixel(&red_key(KeyMatch::Chroma), rgb(1.0, 0.0, 0.0)),
            WorkingRgba::transparent(),
            "by chroma, the key itself"
        );
        near(
            apply_pixel(&red_key(KeyMatch::Chroma), rgb(0.0, 0.0, 0.0)),
            [0.0, 0.0, 0.0, 1.0],
            "by chroma, black has the even chromaticity of a grey, not the key's",
        );
        assert_eq!(
            apply_pixel(
                &key(LinearColorKey {
                    key_color: Rgba {
                        r: 0.5,
                        g: 0.5,
                        b: 0.5,
                        a: 1.0,
                        space: SourceColorSpace::Srgb,
                    },
                    match_colors: KeyMatch::Chroma,
                    ..plain.clone()
                }),
                rgb(0.0, 0.0, 0.0),
            ),
            WorkingRgba::transparent(),
            "by chroma, black is the even chromaticity a grey key has"
        );
        let matte = |view, c| {
            apply_pixel(
                &key(LinearColorKey {
                    view,
                    ..plain.clone()
                }),
                c,
            )
        };
        near(
            matte(KeyView::MatteOnly, rgb(1.0, 0.0, 0.0)),
            [1.0, 1.0, 1.0, 1.0],
            "matte, kept",
        );
        near(
            matte(KeyView::MatteOnly, rgb(0.0, 0.0, 1.0)),
            [0.0, 0.0, 0.0, 1.0],
            "matte, keyed",
        );
        near(
            matte(KeyView::SourceOnly, rgb(0.0, 0.0, 1.0)),
            [0.0, 0.0, 1.0, 1.0],
            "source only is the picture",
        );
        let half = matte(KeyView::MatteOnly, grey(1.0, 0.5));
        assert!(
            (half.r - 0.5).abs() < 1e-6,
            "the matte carries the alpha it had: {half:?}"
        );
        // Remove Color Matting.
        let matting = |clip: bool| {
            packed(
                Effect::RemoveColorMatting(RemoveColorMatting {
                    background_color: Rgba {
                        r: 0.2,
                        g: 0.6,
                        b: 0.9,
                        a: 1.0,
                        space: SourceColorSpace::Srgb,
                    },
                    clip_hdr: clip,
                }),
                s,
            )
        };
        let matted = |r: f32| WorkingRgba {
            r: r * 0.4,
            g: 0.3 * 0.4,
            b: 0.1 * 0.4,
            a: 0.4,
        };
        let out = apply_pixel(&matting(true), matted(0.5));
        // straight red 0.5 - 0.2 * 0.6 = 0.38, of alpha 0.4 is 0.95 straight; green and blue go to 0.
        assert!(
            (out.r - 0.38).abs() < 1e-5 && out.g.abs() < 1e-6 && out.b.abs() < 1e-6,
            "{out:?}"
        );
        let clipped = apply_pixel(&matting(true), matted(0.8));
        assert!(
            (clipped.r - 0.4).abs() < 1e-5,
            "held at the alpha: {clipped:?}"
        );
        let hdr = apply_pixel(&matting(false), matted(0.8));
        assert!(
            (hdr.r - 0.68).abs() < 1e-5,
            "(0.8 - 0.12) over, not held: {hdr:?}"
        );
    }

    #[test]
    fn batch_six_defaults_are_exactly_the_picture() {
        let px = WorkingRgba {
            r: 0.3 * 0.7,
            g: 0.5 * 0.7,
            b: 0.2 * 0.7,
            a: 0.7,
        };
        for effect in [
            Effect::ChangeColor(ChangeColor::default()),
            Effect::ShiftChannels(ShiftChannels::default()),
        ] {
            let packed = packed(effect.clone(), WorkingColorSpace::Srgb);
            assert_eq!(packed.kind, IDENTITY, "{}", effect.name());
            assert_eq!(apply_pixel(&packed, px), px);
        }
    }

    #[test]
    fn batch_five_defaults_that_are_identities_are() {
        let px = WorkingRgba {
            r: 0.3 * 0.7,
            g: 0.5 * 0.7,
            b: 0.2 * 0.7,
            a: 0.7,
        };
        let o = apply_pixel(
            &packed(
                Effect::CcColorOffset(CcColorOffset::default()),
                WorkingColorSpace::Srgb,
            ),
            px,
        );
        assert_eq!(o, px, "no phase is exactly the picture");
        for effect in [
            Effect::CcToner(CcToner::default()),
            Effect::CcThreshold(CcThreshold::default()),
            Effect::CcThresholdRgb(CcThresholdRgb::default()),
        ] {
            let o = apply_pixel(&packed(effect.clone(), WorkingColorSpace::Srgb), px);
            assert_eq!(o.a, px.a, "{}: coverage is kept", effect.name());
        }
    }

    #[test]
    fn batch_three_defaults_are_identities_where_they_should_be() {
        let px = WorkingRgba {
            r: 0.3 * 0.7,
            g: 0.5 * 0.7,
            b: 0.2 * 0.7,
            a: 0.7,
        };
        for effect in [
            Effect::ColorBalanceHls(ColorBalanceHls::default()),
            Effect::LeaveColor(LeaveColor::default()),
            Effect::PhotoFilter(PhotoFilter {
                density: 0.0,
                ..PhotoFilter::default()
            }),
        ] {
            let o = apply_pixel(&packed(effect.clone(), WorkingColorSpace::Srgb), px);
            for (got, want) in [(o.r, px.r), (o.g, px.g), (o.b, px.b), (o.a, px.a)] {
                assert!((got - want).abs() < 2e-5, "{}: {o:?}", effect.name());
            }
        }
    }

    #[test]
    fn batch_one_leaves_transparent_pixels_transparent() {
        for effect in [
            Effect::Invert(Invert::default()),
            Effect::Posterize(Posterize::default()),
            Effect::Threshold(Threshold { level: 0.0 }),
            Effect::Vibrance(Vibrance {
                vibrance: 1.0,
                saturation: 1.0,
            }),
            Effect::Tritone(Tritone::default()),
            Effect::ChannelMixer(ChannelMixer {
                red: MixerRow {
                    constant: 1.0,
                    ..MixerRow::default()
                },
                ..ChannelMixer::default()
            }),
            Effect::ColorBalance(ColorBalance::default()),
            Effect::GammaPedestalGain(GammaPedestalGain {
                red: GammaChannel {
                    pedestal: 0.5,
                    ..GammaChannel::default()
                },
                ..GammaPedestalGain::default()
            }),
            Effect::ColorBalanceHls(ColorBalanceHls {
                lightness: 0.5,
                ..ColorBalanceHls::default()
            }),
            Effect::BlackWhite(BlackWhite::default()),
            Effect::PhotoFilter(PhotoFilter::default()),
            Effect::LeaveColor(LeaveColor {
                amount: 1.0,
                ..LeaveColor::default()
            }),
            Effect::VideoLimiter(VideoLimiter::default()),
            Effect::BroadcastColors(BroadcastColors::default()),
            Effect::CcToner(CcToner::default()),
            Effect::CcColorOffset(CcColorOffset {
                red_phase: 90.0,
                ..CcColorOffset::default()
            }),
            Effect::CcThreshold(CcThreshold::default()),
            Effect::CcThresholdRgb(CcThresholdRgb::default()),
        ] {
            let o = apply_pixel(
                &packed(effect.clone(), WorkingColorSpace::Srgb),
                WorkingRgba::transparent(),
            );
            assert_eq!(o, WorkingRgba::transparent(), "{}", effect.name());
        }
    }

    #[test]
    fn a_disabled_effect_is_an_identity() {
        let mut instance = EffectInstance::new("e", Effect::Fill(Fill::default()));
        instance.enabled = false;
        let mut p = PackedEffect::identity();
        p.pack(&instance, WorkingColorSpace::Srgb);
        assert_eq!(p.kind, IDENTITY);
        let px = grey(0.4, 0.9);
        assert_eq!(apply_pixel(&p, px), px);
    }
}
