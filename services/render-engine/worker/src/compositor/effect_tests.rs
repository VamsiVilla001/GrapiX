//! 3.22 kernel gate: `effects.wgsl` against its CPU twin `crate::effects`,
//! every pointwise effect over a spread of parameter settings, on the same
//! packed parameter block and the same input pixels.
//!
//! Inputs include opaque, partial, tiny and subnormal coverage and colours
//! over range. Every GPU result must be finite with alpha in [0, 1], and equal
//! the CPU reference within 2e-4 (relative above 1): far below one 8-bit code
//! value (3.9e-3). Hardware only: run with `--ignored`; `GX_GPU_316_BACKEND`
//! picks dx12 or vulkan.

use gx_contracts::color::{Rgba, SourceColorSpace, WorkingColorSpace};
use gx_contracts::effect::*;
use wgpu::util::DeviceExt;

use crate::colour_pipeline::WorkingRgba;
use crate::effects::{apply_pixel, PackedEffect};
use crate::gpu::Gpu;

fn hardware() -> Gpu {
    let gpu = match std::env::var("GX_GPU_316_BACKEND").as_deref() {
        Ok("dx12") => crate::gpu::negotiate_for_test(wgpu::Backends::DX12),
        Ok("vulkan") => crate::gpu::negotiate_for_test(wgpu::Backends::VULKAN),
        Err(_) => crate::gpu::negotiate(),
        other => panic!("unsupported explicit proof backend: {other:?}"),
    };
    assert!(
        gpu.has_hardware(),
        "3.22 proof requires a hardware GPU, got {:?}",
        gpu.tier()
    );
    gpu
}

const WIDTH: u32 = 64;
const HEIGHT: u32 = 64;

fn pixels() -> Vec<WorkingRgba> {
    let mut state = 0x9e37_79b9_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 40) as f32 / 16_777_216.0
    };
    let special = [0.0, f32::from_bits(1), 1e-30, 1e-6, 1.0];
    (0..WIDTH * HEIGHT)
        .map(|i| {
            let a = if i % 5 == 0 {
                special[(i as usize / 5) % special.len()]
            } else {
                next()
            };
            let scale = if i % 9 == 0 { 2.5 } else { 1.0 };
            let [r, g, b] = [next() * scale, next() * scale, next() * scale];
            WorkingRgba {
                r: r * a,
                g: g * a,
                b: b * a,
                a,
            }
        })
        .collect()
}

fn colour(r: f64, g: f64, b: f64, a: f64) -> Rgba {
    Rgba::new(r, g, b, a, SourceColorSpace::Srgb)
}

/// Each pointwise effect at several settings, including switches on and off.
pub(crate) fn cases() -> Vec<(String, Effect)> {
    let mut out = Vec::new();
    let mut push = |name: &str, e: Effect| out.push((name.to_owned(), e));
    push(
        "fill",
        Effect::Fill(Fill {
            color: colour(0.9, 0.3, 0.1, 1.0),
            opacity: 0.7,
        }),
    );
    push(
        "fill-alpha",
        Effect::Fill(Fill {
            color: colour(0.1, 0.8, 0.9, 0.5),
            opacity: 1.0,
        }),
    );
    push(
        "tint",
        Effect::Tint(Tint {
            map_black_to: colour(0.1, 0.0, 0.3, 1.0),
            map_white_to: colour(1.0, 0.9, 0.6, 0.8),
            amount: 0.8,
        }),
    );
    let mut lv = Levels {
        rgb: LevelsChannel {
            input_black: 0.1,
            input_white: 0.8,
            gamma: 1.8,
            output_black: 0.05,
            output_white: 0.95,
        },
        red: LevelsChannel {
            gamma: 0.6,
            ..Default::default()
        },
        alpha: LevelsChannel {
            output_white: 0.8,
            ..Default::default()
        },
        ..Default::default()
    };
    push("levels", Effect::Levels(lv.clone()));
    lv.clip_to_output_black = false;
    lv.clip_to_output_white = false;
    push("levels-unclipped", Effect::Levels(lv));
    let cv = Curves {
        rgb: vec![
            CurvePoint { x: 0.0, y: 0.05 },
            CurvePoint { x: 0.3, y: 0.4 },
            CurvePoint { x: 0.7, y: 0.65 },
            CurvePoint { x: 1.0, y: 0.98 },
        ],
        green: vec![
            CurvePoint { x: 0.0, y: 0.0 },
            CurvePoint { x: 0.5, y: 0.7 },
            CurvePoint { x: 1.0, y: 1.0 },
        ],
        alpha: vec![CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 1.0, y: 0.9 }],
        ..Default::default()
    };
    push("curves", Effect::Curves(cv));
    push(
        "hue-saturation",
        Effect::HueSaturation(HueSaturation {
            hue: 75.0,
            saturation: 0.4,
            lightness: -0.2,
            ..Default::default()
        }),
    );
    push(
        "hue-saturation-down",
        Effect::HueSaturation(HueSaturation {
            hue: -200.0,
            saturation: -0.6,
            lightness: 0.3,
            ..Default::default()
        }),
    );
    push(
        "colorize",
        Effect::HueSaturation(HueSaturation {
            colorize: true,
            colorize_hue: 210.0,
            colorize_saturation: 0.6,
            colorize_lightness: 0.25,
            ..Default::default()
        }),
    );
    push(
        "brightness-contrast",
        Effect::BrightnessContrast(BrightnessContrast {
            brightness: 0.3,
            contrast: 0.4,
            use_legacy: false,
        }),
    );
    push(
        "brightness-contrast-low",
        Effect::BrightnessContrast(BrightnessContrast {
            brightness: -0.8,
            contrast: -0.5,
            use_legacy: false,
        }),
    );
    push(
        "brightness-contrast-legacy",
        Effect::BrightnessContrast(BrightnessContrast {
            brightness: 0.2,
            contrast: 0.5,
            use_legacy: true,
        }),
    );
    push(
        "exposure",
        Effect::Exposure(Exposure {
            exposure: 1.3,
            offset: -0.02,
            gamma_correction: 1.4,
        }),
    );
    push(
        "exposure-down",
        Effect::Exposure(Exposure {
            exposure: -2.0,
            offset: 0.05,
            gamma_correction: 0.7,
        }),
    );
    push(
        "invert",
        Effect::Invert(Invert {
            channel: InvertChannel::Rgb,
            blend_with_original: 0.0,
        }),
    );
    push(
        "invert-green-blended",
        Effect::Invert(Invert {
            channel: InvertChannel::Green,
            blend_with_original: 0.3,
        }),
    );
    push("posterize", Effect::Posterize(Posterize { level: 5.0 }));
    push(
        "posterize-fine",
        Effect::Posterize(Posterize { level: 64.0 }),
    );
    push("threshold", Effect::Threshold(Threshold { level: 0.45 }));
    push(
        "vibrance",
        Effect::Vibrance(Vibrance {
            vibrance: 0.7,
            saturation: -0.1,
        }),
    );
    push(
        "vibrance-down",
        Effect::Vibrance(Vibrance {
            vibrance: -0.5,
            saturation: 0.3,
        }),
    );
    let ramp_colour = |r, g, b| Rgba {
        r,
        g,
        b,
        a: 1.0,
        space: SourceColorSpace::Srgb,
    };
    push("tritone-grey", Effect::Tritone(Tritone::default()));
    push(
        "tritone-coloured-blended",
        Effect::Tritone(Tritone {
            shadows: ramp_colour(0.9, 0.1, 0.2),
            midtones: ramp_colour(0.1, 0.8, 0.3),
            highlights: ramp_colour(0.2, 0.3, 1.0),
            blend_with_original: 0.35,
        }),
    );
    let row = |red, green, blue, constant| MixerRow {
        red,
        green,
        blue,
        constant,
    };
    push(
        "channel-mixer-swap-and-mix",
        Effect::ChannelMixer(ChannelMixer {
            red: row(0.1, 0.2, 0.9, 0.05),
            green: row(-0.5, 1.2, 0.3, 0.0),
            blue: row(1.0, 0.0, 0.0, -0.1),
            monochrome: false,
        }),
    );
    push(
        "channel-mixer-mono",
        Effect::ChannelMixer(ChannelMixer {
            red: row(0.3, 0.59, 0.11, 0.0),
            monochrome: true,
            ..ChannelMixer::default()
        }),
    );
    let shift = |red, green, blue| ColorShift { red, green, blue };
    push(
        "color-balance-kept",
        Effect::ColorBalance(ColorBalance {
            shadows: shift(0.3, 0.0, -0.2),
            midtones: shift(-0.2, 0.25, 0.1),
            highlights: shift(0.0, -0.1, 0.4),
            preserve_luminosity: true,
        }),
    );
    push(
        "color-balance-free",
        Effect::ColorBalance(ColorBalance {
            shadows: shift(0.3, 0.0, -0.2),
            midtones: shift(-0.2, 0.25, 0.1),
            highlights: shift(0.0, -0.1, 0.4),
            preserve_luminosity: false,
        }),
    );
    let chan = |gamma, pedestal, gain| GammaChannel {
        gamma,
        pedestal,
        gain,
    };
    push(
        "gamma-pedestal-gain",
        Effect::GammaPedestalGain(GammaPedestalGain {
            red: chan(2.2, 0.0, 1.0),
            green: chan(0.7, 0.1, 0.9),
            blue: chan(1.0, -0.05, 1.5),
            black_stretch: 0.0,
        }),
    );
    push(
        "color-balance-hls",
        Effect::ColorBalanceHls(ColorBalanceHls {
            hue: 75.0,
            lightness: 0.2,
            saturation: -0.3,
        }),
    );
    push(
        "color-balance-hls-down",
        Effect::ColorBalanceHls(ColorBalanceHls {
            hue: -200.0,
            lightness: -0.4,
            saturation: 0.6,
        }),
    );
    push("black-white", Effect::BlackWhite(BlackWhite::default()));
    push(
        "black-white-tinted",
        Effect::BlackWhite(BlackWhite {
            reds: 1.4,
            yellows: -0.5,
            greens: 0.9,
            cyans: 0.1,
            blues: 2.2,
            magentas: 0.3,
            tint: true,
            tint_color: ramp_colour(0.88, 0.5, 0.3),
        }),
    );
    push(
        "photo-filter-preset",
        Effect::PhotoFilter(PhotoFilter {
            filter: PhotoFilterPreset::Cooling82,
            density: 0.6,
            preserve_luminosity: true,
            ..PhotoFilter::default()
        }),
    );
    push(
        "photo-filter-custom",
        Effect::PhotoFilter(PhotoFilter {
            filter: PhotoFilterPreset::Custom,
            color: ramp_colour(0.2, 0.9, 0.4),
            density: 0.8,
            preserve_luminosity: false,
        }),
    );
    push(
        "leave-color-rgb",
        Effect::LeaveColor(LeaveColor {
            amount: 0.9,
            color: ramp_colour(0.9, 0.2, 0.2),
            tolerance: 0.2,
            edge_softness: 0.4,
            match_colors: LeaveMatch::Rgb,
        }),
    );
    push(
        "leave-color-hue",
        Effect::LeaveColor(LeaveColor {
            amount: 1.0,
            color: ramp_colour(0.2, 0.3, 0.9),
            tolerance: 0.1,
            edge_softness: 0.3,
            match_colors: LeaveMatch::Hue,
        }),
    );
    push(
        "video-limiter-smart-90",
        Effect::VideoLimiter(VideoLimiter {
            clip_level: LimiterLevel::P90,
            ..VideoLimiter::default()
        }),
    );
    push(
        "video-limiter-chroma-warning",
        Effect::VideoLimiter(VideoLimiter {
            clip_level: LimiterLevel::P95,
            clip_method: LimiterMethod::Chroma,
            compression_before_clipping: LimiterCompression::P20,
            gamut_warning: true,
            gamut_warning_color: ramp_colour(0.1, 0.9, 0.2),
        }),
    );
    for (name, locale, how) in [
        (
            "broadcast-ntsc-luminance",
            BroadcastLocale::Ntsc,
            BroadcastAction::ReduceLuminance,
        ),
        (
            "broadcast-pal-saturation",
            BroadcastLocale::Pal,
            BroadcastAction::ReduceSaturation,
        ),
        (
            "broadcast-key-unsafe",
            BroadcastLocale::Ntsc,
            BroadcastAction::KeyOutUnsafe,
        ),
        (
            "broadcast-key-safe",
            BroadcastLocale::Pal,
            BroadcastAction::KeyOutSafe,
        ),
    ] {
        push(
            name,
            Effect::BroadcastColors(BroadcastColors {
                locale,
                how_to_make_safe: how,
                max_signal: 95.0,
            }),
        );
    }
    push(
        "cc-toner-pentone",
        Effect::CcToner(CcToner {
            tones: TonerTones::Pentone,
            blend: 0.2,
            ..CcToner::default()
        }),
    );
    push(
        "cc-toner-duotone",
        Effect::CcToner(CcToner {
            tones: TonerTones::Duotone,
            shadows: ramp_colour(0.1, 0.0, 0.3),
            highlights: ramp_colour(1.0, 0.9, 0.5),
            ..CcToner::default()
        }),
    );
    for (name, overflow) in [
        ("cc-color-offset-wrap", ColorOverflow::Wrap),
        ("cc-color-offset-solarize", ColorOverflow::Solarize),
        ("cc-color-offset-polarize", ColorOverflow::Polarize),
    ] {
        push(
            name,
            Effect::CcColorOffset(CcColorOffset {
                red_phase: 200.0,
                green_phase: 0.0,
                blue_phase: -120.0,
                overflow,
            }),
        );
    }
    for (name, channel, invert, blend) in [
        (
            "cc-threshold-luminance",
            ThresholdChannel::Luminance,
            false,
            0.0,
        ),
        ("cc-threshold-rgb-mode", ThresholdChannel::Rgb, true, 0.3),
        (
            "cc-threshold-saturation",
            ThresholdChannel::Saturation,
            false,
            0.0,
        ),
        ("cc-threshold-alpha", ThresholdChannel::Alpha, false, 0.4),
    ] {
        push(
            name,
            Effect::CcThreshold(CcThreshold {
                threshold: 110.0,
                channel,
                invert,
                blend,
            }),
        );
    }
    push(
        "cc-threshold-rgb",
        Effect::CcThresholdRgb(CcThresholdRgb {
            red_threshold: 90.0,
            green_threshold: 140.0,
            blue_threshold: 200.0,
            invert_red: false,
            invert_green: true,
            invert_blue: false,
            blend: 0.15,
        }),
    );
    for (name, match_colors) in [
        ("change-color-hue", ChangeMatch::Hue),
        ("change-color-rgb", ChangeMatch::Rgb),
        ("change-color-chroma", ChangeMatch::Chroma),
    ] {
        push(
            name,
            Effect::ChangeColor(ChangeColor {
                hue_transform: 140.0,
                lightness_transform: 0.2,
                saturation_transform: -0.3,
                color_to_change: ramp_colour(0.8, 0.3, 0.2),
                matching_tolerance: 0.3,
                matching_softness: 0.3,
                match_colors,
                ..ChangeColor::default()
            }),
        );
    }
    push(
        "change-color-matte-inverted",
        Effect::ChangeColor(ChangeColor {
            view: ChangeColorView::ColorCorrectionMask,
            matching_tolerance: 0.2,
            matching_softness: 0.2,
            invert_mask: true,
            ..ChangeColor::default()
        }),
    );
    push(
        "shift-channels-rotate",
        Effect::ShiftChannels(ShiftChannels {
            take_red_from: ChannelSource::Blue,
            take_green_from: ChannelSource::Red,
            take_blue_from: ChannelSource::Luminance,
            take_alpha_from: ChannelSource::Alpha,
        }),
    );
    push(
        "shift-channels-hsl",
        Effect::ShiftChannels(ShiftChannels {
            take_red_from: ChannelSource::Hue,
            take_green_from: ChannelSource::Saturation,
            take_blue_from: ChannelSource::Lightness,
            take_alpha_from: ChannelSource::HalfOn,
        }),
    );
    for (name, match_colors, keep, view) in [
        ("linear-key-rgb", KeyMatch::Rgb, false, KeyView::FinalOutput),
        (
            "linear-key-hue-keep",
            KeyMatch::Hue,
            true,
            KeyView::FinalOutput,
        ),
        (
            "linear-key-chroma-matte",
            KeyMatch::Chroma,
            false,
            KeyView::MatteOnly,
        ),
    ] {
        push(
            name,
            Effect::LinearColorKey(LinearColorKey {
                view,
                key_color: ramp_colour(0.2, 0.3, 0.9),
                match_colors,
                tolerance: 0.2,
                softness: 0.25,
                key_operation: if keep {
                    KeyOperation::KeepColors
                } else {
                    KeyOperation::KeyColors
                },
            }),
        );
    }
    push(
        "remove-color-matting",
        Effect::RemoveColorMatting(RemoveColorMatting {
            background_color: ramp_colour(0.2, 0.6, 0.9),
            clip_hdr: true,
        }),
    );
    push(
        "remove-color-matting-hdr",
        Effect::RemoveColorMatting(RemoveColorMatting {
            background_color: ramp_colour(0.5, 0.1, 0.1),
            clip_hdr: false,
        }),
    );
    for (name, channel, soft) in [
        ("extract-luminance", ExtractChannel::Luminance, 60.0),
        ("extract-red-inverted", ExtractChannel::Red, 0.0),
    ] {
        push(
            name,
            Effect::Extract(Extract {
                channel,
                black_point: 60.0,
                white_point: 190.0,
                black_softness: soft,
                white_softness: soft,
                invert: soft == 0.0,
            }),
        );
    }
    push(
        "cc-color-neutralizer",
        Effect::CcColorNeutralizer(CcColorNeutralizer {
            shadows_unbalance: ramp_colour(0.1, 0.0, 0.0),
            midtones_unbalance: ramp_colour(0.5, 0.5, 0.6),
            highlights_unbalance: ramp_colour(1.0, 1.0, 0.9),
            pinning: 0.5,
            blend_with_original: 0.25,
            contrast: 0.2,
            darks: 0.3,
            brights: -0.2,
            ..CcColorNeutralizer::default()
        }),
    );
    push("unmult-black", Effect::Unmult(Unmult::default()));
    push(
        "unmult-white",
        Effect::Unmult(Unmult {
            background: UnmultBackground::White,
            white_level: 0.8,
            softness: 0.5,
            ..Unmult::default()
        }),
    );
    push(
        "spill-faster",
        Effect::SpillSuppressor(SpillSuppressor {
            color_to_suppress: ramp_colour(0.1, 0.9, 0.2),
            suppression: 1.5,
            ..SpillSuppressor::default()
        }),
    );
    push(
        "spill-better",
        Effect::SpillSuppressor(SpillSuppressor {
            color_to_suppress: ramp_colour(0.1, 0.3, 0.9),
            color_accuracy: SpillAccuracy::Better,
            suppression: 1.0,
        }),
    );
    for (name, space, lo, hi, fuzziness) in [
        (
            "color-range-lab",
            gx_contracts::effect::RangeSpace::Lab,
            [90.0, 110.0, 110.0],
            [180.0, 150.0, 150.0],
            40.0,
        ),
        (
            "color-range-yuv-hard",
            gx_contracts::effect::RangeSpace::Yuv,
            [60.0, 100.0, 100.0],
            [200.0, 160.0, 160.0],
            0.0,
        ),
        (
            "color-range-rgb",
            gx_contracts::effect::RangeSpace::Rgb,
            [40.0, 20.0, 80.0],
            [140.0, 120.0, 230.0],
            55.0,
        ),
    ] {
        push(
            name,
            Effect::ColorRange(gx_contracts::effect::ColorRange {
                fuzziness,
                color_space: space,
                min_l: lo[0],
                max_l: hi[0],
                min_a: lo[1],
                max_a: hi[1],
                min_b: lo[2],
                max_b: hi[2],
            }),
        );
    }
    // And, Or and Xor are left out on purpose: they quantise each channel to 8 bits first, so the
    // half-precision texture the GPU reads can flip a pixel across a rounding boundary that the
    // CPU's f32 does not (one code value, on a few pixels). The CPU is their reference
    // (`batch_ten_arithmetic_matches_effectcraft_on_known_pixels`).
    for (name, operator, clip) in [
        (
            "arithmetic-add",
            gx_contracts::effect::ArithmeticOperator::Add,
            true,
        ),
        (
            "arithmetic-add-unclipped",
            gx_contracts::effect::ArithmeticOperator::Add,
            false,
        ),
        (
            "arithmetic-difference",
            gx_contracts::effect::ArithmeticOperator::Difference,
            true,
        ),
        (
            "arithmetic-block-above",
            gx_contracts::effect::ArithmeticOperator::BlockAbove,
            true,
        ),
        (
            "arithmetic-slice",
            gx_contracts::effect::ArithmeticOperator::Slice,
            true,
        ),
        (
            "arithmetic-multiply",
            gx_contracts::effect::ArithmeticOperator::Multiply,
            true,
        ),
        (
            "arithmetic-screen",
            gx_contracts::effect::ArithmeticOperator::Screen,
            true,
        ),
    ] {
        push(
            name,
            Effect::Arithmetic(gx_contracts::effect::Arithmetic {
                operator,
                red_value: 100.0,
                green_value: 170.0,
                blue_value: 60.0,
                clip,
            }),
        );
    }
    for (name, view, accurate) in [
        (
            "color-difference-final",
            gx_contracts::effect::ColorDiffView::FinalOutput,
            false,
        ),
        (
            "color-difference-corrected-a",
            gx_contracts::effect::ColorDiffView::CorrectedMatteA,
            false,
        ),
        (
            "color-difference-matte-accurate",
            gx_contracts::effect::ColorDiffView::CorrectedMatte,
            true,
        ),
        (
            "color-difference-uncorrected-b",
            gx_contracts::effect::ColorDiffView::UncorrectedMatteB,
            true,
        ),
    ] {
        push(
            name,
            Effect::ColorDifferenceKey(gx_contracts::effect::ColorDifferenceKey {
                view,
                key_color: ramp_colour(0.2, 0.8, 0.3),
                color_matching_accuracy: if accurate {
                    gx_contracts::effect::MatchAccuracy::MoreAccurate
                } else {
                    gx_contracts::effect::MatchAccuracy::Faster
                },
                partial_a: gx_contracts::effect::MatteLevels {
                    in_black: 20.0,
                    in_white: 220.0,
                    gamma: 1.4,
                    out_black: 5.0,
                    out_white: 250.0,
                },
                partial_b: gx_contracts::effect::MatteLevels::default(),
                matte_black: 10.0,
                matte_white: 240.0,
                matte_gamma: 0.8,
            }),
        );
    }
    // Selective Color across both methods, with shifts in the primaries, a secondary, whites,
    // neutrals and blacks so every range weight is exercised against the sample pixels.
    for (name, method) in [
        (
            "selective-color-relative",
            gx_contracts::effect::SelectiveMethod::Relative,
        ),
        (
            "selective-color-absolute",
            gx_contracts::effect::SelectiveMethod::Absolute,
        ),
    ] {
        let ink = |cyan, magenta, yellow, black| gx_contracts::effect::InkShift {
            cyan,
            magenta,
            yellow,
            black,
        };
        push(
            name,
            Effect::SelectiveColor(gx_contracts::effect::SelectiveColor {
                method,
                reds: ink(-0.4, 0.2, 0.1, 0.05),
                yellows: ink(0.1, -0.3, 0.5, 0.0),
                greens: ink(0.3, -0.2, 0.2, -0.1),
                cyans: ink(-0.5, 0.0, 0.1, 0.1),
                blues: ink(0.2, 0.4, -0.3, 0.0),
                magentas: ink(0.0, -0.4, 0.2, 0.15),
                whites: ink(0.1, 0.1, -0.2, 0.2),
                neutrals: ink(-0.2, 0.3, 0.1, -0.25),
                blacks: ink(0.3, -0.1, 0.0, 0.4),
            }),
        );
    }
    push(
        "gamma-pedestal-gain-stretch",
        Effect::GammaPedestalGain(GammaPedestalGain {
            black_stretch: 2.5,
            ..GammaPedestalGain::default()
        }),
    );
    out
}

fn close(gpu: f32, cpu: f32) -> bool {
    gpu == cpu || (gpu - cpu).abs() <= 2e-4 * cpu.abs().max(1.0)
}

#[test]
#[ignore = "requires hardware GPU; 3.22 pointwise effect kernel gate"]
fn gpu_effect_kernels_equal_the_cpu_reference() {
    let gpu = hardware();
    let (device, queue) = gpu.device_queue().expect("hardware device");
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gx-effect-kernel-test"),
        source: wgpu::ShaderSource::Wgsl(super::effects_shader().into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("effect_step"),
        layout: None,
        module: &module,
        entry_point: Some("effect_step"),
        compilation_options: Default::default(),
        cache: None,
    });
    let input = pixels();
    let size = wgpu::Extent3d {
        width: WIDTH,
        height: HEIGHT,
        depth_or_array_layers: 1,
    };
    let texture = |usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage,
            view_formats: &[],
        })
    };
    let src = texture(wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
    let words: Vec<u8> = input
        .iter()
        .flat_map(|p| [p.r, p.g, p.b, p.a])
        .flat_map(|v| v.to_bits().to_le_bytes())
        .collect();
    queue.write_texture(
        src.as_image_copy(),
        &words,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(WIDTH * 16),
            rows_per_image: Some(HEIGHT),
        },
        size,
    );
    let src_view = src.create_view(&Default::default());
    let mut failures = Vec::new();
    let mut report = Vec::new();
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        for (name, effect) in cases() {
            let mut packed = PackedEffect::identity();
            packed.pack(&EffectInstance::new("e", effect), space);
            let out = texture(wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC);
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &super::effect_uniform(&packed),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let mut curve_bytes = Vec::new();
            super::write_curve(&mut curve_bytes, &packed);
            let curve = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &curve_bytes,
                usage: wgpu::BufferUsages::STORAGE,
            });
            let out_view = out.create_view(&Default::default());
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&src_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&out_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: curve.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(&src_view),
                    },
                    // 3.28: the mask weights a mix pass reads; none of these kernels do.
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::TextureView(&src_view),
                    },
                ],
            });
            let readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: u64::from(WIDTH * 16 * HEIGHT),
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(WIDTH / 16, HEIGHT / 16, 1);
            }
            encoder.copy_texture_to_buffer(
                out.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(WIDTH * 16),
                        rows_per_image: Some(HEIGHT),
                    },
                },
                size,
            );
            queue.submit([encoder.finish()]);
            let slice = readback.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(10)),
                })
                .unwrap();
            rx.recv().unwrap().unwrap();
            let view = slice.get_mapped_range().unwrap();
            let gpu_px: Vec<f32> = view
                .chunks_exact(4)
                .map(|b| f32::from_bits(u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
                .collect();
            drop(view);
            readback.unmap();
            let mut mismatched = 0;
            let mut first = None;
            for (i, px) in input.iter().enumerate() {
                let g = &gpu_px[i * 4..i * 4 + 4];
                assert!(
                    g.iter().all(|v| v.is_finite()) && (0.0..=1.0).contains(&g[3]),
                    "{name} {space:?}: {g:?} from {px:?}"
                );
                let c = apply_pixel(&packed, *px);
                if !(close(g[0], c.r) && close(g[1], c.g) && close(g[2], c.b) && close(g[3], c.a)) {
                    mismatched += 1;
                    first.get_or_insert((i, *px, c, [g[0], g[1], g[2], g[3]]));
                }
            }
            if mismatched > 0 {
                failures.push(format!(
                    "{name} {}: {mismatched}/{} differ; first {first:?}",
                    space.as_str(),
                    input.len()
                ));
            }
            report.push(format!("{name}/{}: {mismatched}", space.as_str()));
        }
    }
    eprintln!(
        "3.22 kernel gate on {:?}: {}",
        gpu.diagnostic_description(),
        report.join(", ")
    );
    assert!(failures.is_empty(), "{failures:#?}");
}
