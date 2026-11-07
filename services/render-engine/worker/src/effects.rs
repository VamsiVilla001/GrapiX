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
//! saturation, levels, exposure, fill, the Fritsch–Carlson curve; `crates/
//! color/src/lib.rs`: HSL), Copyright (c) 2026 ArtCraft Team and the
//! EffectCraft contributors, MIT OR Apache-2.0, see EFFECTCRAFT-LICENSE.
//! GrapiX's own: typed parameters instead of string keys, the packed block,
//! coverage tests on bit patterns, transparent pixels never gaining coverage,
//! alpha adjustments only where the layer drew, Exposure in linear light for
//! either working space, and colour alpha as an effect-strength factor.

use gx_contracts::color::WorkingColorSpace;
use gx_contracts::effect::{Curves, Effect, EffectInstance, LevelsChannel};

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

/// Parameters per effect: eight vec4s.
pub const PARAMS: usize = 32;
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
        Self { kind: IDENTITY, params: [0.0; PARAMS], curve: vec![0.0; CURVE_FLOATS] }
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
                    let LevelsChannel { input_black, input_white, gamma, output_black, output_white } = *c;
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
                let k = if c >= 0.0 { 1.0 / (1.0 - c * 0.99) } else { 1.0 + c };
                p[..6].copy_from_slice(&[b, c, f32::from(u8::from(e.use_legacy)), k, 2f32.powf(-b), 2f32.powf(2.0 * c)]);
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
    let d: Vec<f32> = (0..n - 1).map(|k| (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k])).collect();
    let mut ms = vec![0.0f32; n];
    ms[0] = d[0];
    ms[n - 1] = d[n - 2];
    for k in 1..n - 1 {
        ms[k] = if d[k - 1] * d[k] <= 0.0 { 0.0 } else { (d[k - 1] + d[k]) * 0.5 };
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
    out[LUT_N + 1..CURVE_BLOCK].copy_from_slice(&[xs[0], ys[0], ms[0], xs[n - 1], ys[n - 1], ms[n - 1]]);
}

fn fill_curves(c: &Curves, out: &mut [f32]) {
    for (i, points) in [&c.rgb, &c.red, &c.green, &c.blue, &c.alpha].into_iter().enumerate() {
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
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
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
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    [hsl_channel(p, q, h + 1.0 / 3.0), hsl_channel(p, q, h), hsl_channel(p, q, h - 1.0 / 3.0)]
}

/// The sRGB transfer in f32, the same expression the kernel evaluates.
pub fn srgb_decode(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { powz((v + 0.055) / 1.055, 2.4) }
}

pub fn srgb_encode(v: f32) -> f32 {
    if v <= 0.0031308 { v * 12.92 } else { 1.055 * powz(v, 1.0 / 2.4) - 0.055 }
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
    if v < 0.5 { 0.5 * powz(2.0 * v, gain) } else { 1.0 - 0.5 * powz((2.0 - 2.0 * v).max(0.0), gain) }
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
            ([c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k, c[2] + (p[2] - c[2]) * k], a)
        }
        TINT => {
            let l = rec709_luminance(c).clamp(0.0, 1.0);
            let t = [p[0] + (p[4] - p[0]) * l, p[1] + (p[5] - p[1]) * l, p[2] + (p[6] - p[2]) * l];
            let k = p[8] * (p[3] + (p[7] - p[3]) * l);
            ([c[0] + (t[0] - c[0]) * k, c[1] + (t[1] - c[1]) * k, c[2] + (t[2] - c[2]) * k], a)
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
        HUE_SATURATION if p[3] <= 0.5 && p[0].fract() == 0.0 && p[1] == 0.0 && p[2] == 0.0 => (c, a),
        HUE_SATURATION => {
            let [h, s, l] = rgb_to_hsl(c);
            let hsl = if p[3] > 0.5 {
                let cl = p[6];
                [p[4], p[5], (l + cl * if cl > 0.0 { 1.0 - l } else { l }).clamp(0.0, 1.0)]
            } else {
                let sat = p[1];
                let s2 = if sat >= 0.0 { s + (1.0 - s) * sat * s.min(1.0) } else { s * (1.0 + sat) };
                let light = p[2];
                let l2 = if light >= 0.0 { l + (1.0 - l) * light } else { l * (1.0 + light) };
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
        _ => (c, a),
    };
    let out = WorkingRgba { r: bound(c[0] * a), g: bound(c[1] * a), b: bound(c[2] * a), a: bound(a) };
    if covers(out.a) { out } else { WorkingRgba::transparent() }
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
        WorkingRgba { r: v * a, g: v * a, b: v * a, a }
    }

    #[test]
    fn default_parameters_leave_pixels_unchanged() {
        let px = WorkingRgba { r: 0.3 * 0.7, g: 0.5 * 0.7, b: 0.2 * 0.7, a: 0.7 };
        for effect in [
            Effect::Levels(Levels::default()),
            Effect::Curves(Curves::default()),
            Effect::HueSaturation(HueSaturation::default()),
            Effect::BrightnessContrast(BrightnessContrast::default()),
            Effect::Exposure(Exposure::default()),
        ] {
            for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
                let o = apply_pixel(&packed(effect.clone(), space), px);
                for (got, want) in [(o.r, px.r), (o.g, px.g), (o.b, px.b), (o.a, px.a)] {
                    assert!((got - want).abs() < 2e-5, "{} {space:?}: {o:?} vs {px:?}", effect.name());
                }
            }
        }
    }

    #[test]
    fn transparent_pixels_stay_transparent_in_every_effect() {
        let mut levels = Levels::default();
        levels.alpha.output_black = 0.5;
        let mut fill = Fill::default();
        fill.opacity = 1.0;
        for effect in [Effect::Fill(fill), Effect::Tint(Tint::default()), Effect::Levels(levels)] {
            let o = apply_pixel(&packed(effect, WorkingColorSpace::Srgb), WorkingRgba::transparent());
            assert_eq!(o, WorkingRgba::transparent());
        }
    }

    #[test]
    fn the_published_formulas_hold() {
        let s = WorkingColorSpace::LinearSrgb;
        // Fill at full opacity repaints, keeping coverage.
        let red = Fill { color: Rgba::new(1.0, 0.0, 0.0, 1.0, SourceColorSpace::Linear), opacity: 1.0 };
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
        let ex = Exposure { exposure: 1.0, ..Default::default() };
        let o = apply_pixel(&packed(Effect::Exposure(ex.clone()), s), grey(0.2, 1.0));
        assert!((o.r - 0.4).abs() < 1e-6);
        // ...and in an sRGB project it is still linear light.
        let o = apply_pixel(&packed(Effect::Exposure(ex), WorkingColorSpace::Srgb), grey(srgb_encode(0.2), 1.0));
        assert!((srgb_decode(o.r) - 0.4).abs() < 1e-5);
        // Tint maps black to white across luminance.
        let tint = Tint::default();
        let o = apply_pixel(&packed(Effect::Tint(tint), s), WorkingRgba::opaque(1.0, 0.0, 0.0));
        assert!((o.r - 0.2126).abs() < 1e-5 && (o.g - 0.2126).abs() < 1e-5);
        // Hue/Saturation: -1 saturation is grey at HSL lightness.
        let hs = HueSaturation { saturation: -1.0, ..Default::default() };
        let o = apply_pixel(&packed(Effect::HueSaturation(hs), s), WorkingRgba::opaque(1.0, 0.0, 0.0));
        assert!((o.r - 0.5).abs() < 1e-6 && (o.g - 0.5).abs() < 1e-6);
        // Curves: a point at (0.5, 0.75) lifts mid grey there.
        let mut cv = Curves::default();
        cv.rgb = vec![CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 0.5, y: 0.75 }, CurvePoint { x: 1.0, y: 1.0 }];
        let o = apply_pixel(&packed(Effect::Curves(cv), s), grey(0.5, 1.0));
        assert!((o.r - 0.75).abs() < 1e-4, "{o:?}");
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
