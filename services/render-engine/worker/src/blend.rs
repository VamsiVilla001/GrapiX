//! Layer blend modes: the CPU reference for build-plan 3.20.
//!
//! The formulas are After Effects' and Photoshop's as EffectCraft implements
//! them (`crates/color/src/blend.rs` and `crates/raster/src/lib.rs`
//! `hash_noise`, at 9a7d3e76991d5372448033b473dc12c2480a6a04; Copyright (c)
//! 2026 ArtCraft Team and the EffectCraft contributors; MIT OR Apache-2.0, see
//! EFFECTCRAFT-LICENSE). The structure and the numerical guards are GrapiX's:
//! EffectCraft's own DX12 32-bit runs emitted NaN for Darken (11 October 2026)
//! and Classic Difference (12 October 2026), so nothing here relies on a
//! comparison a shader compiler may fold or on the platform's handling of
//! subnormal values.
//!
//! `compositor/blend.wgsl` is this module's GPU twin, line for line: the same
//! formulas, the same order of operations, the same guards. Change both or
//! neither; `compositor::blend_tests` holds them to each other.
//!
//! Inputs and outputs are premultiplied working-space pixels; the layer's
//! opacity is already in `src`. Blending happens in the project working space
//! (3.15), so the same scene blends display-referred in `srgb` and
//! linear-light in `linear-srgb`, as Photoshop and After Effects do under the
//! corresponding project settings.

use gx_contracts::material::BlendMode;

use crate::colour_pipeline::WorkingRgba;

/// The mode's number on the GPU: its position in [`BlendMode::ALL`].
pub fn mode_index(mode: BlendMode) -> u32 {
    BlendMode::ALL
        .iter()
        .position(|candidate| *candidate == mode)
        .expect("ALL lists every mode") as u32
}

/// WGSL constants naming every mode by its position in [`BlendMode::ALL`].
/// Generated from the enum and prepended to the shader, so the GPU's mode
/// numbers cannot drift from the contract.
pub fn wgsl_mode_constants() -> String {
    let mut out = String::new();
    for (index, mode) in BlendMode::ALL.iter().enumerate() {
        out.push_str(&format!("const M_{mode:?}: u32 = {index}u;\n"));
    }
    out
}

const SIGN: u32 = 0x8000_0000;
const EXPONENT: u32 = 0x7f80_0000;
const MANTISSA: u32 = 0x007f_ffff;

/// Whether an alpha covers anything: positive, normal and finite. Zero,
/// negative, subnormal and non-finite alphas cover nothing. Tested on the bit
/// pattern, because a GPU may flush a subnormal to zero in arithmetic but not
/// in a comparison, and that disagreement is what turns `x / a` into NaN.
pub fn covers(alpha: f32) -> bool {
    let bits = alpha.to_bits();
    let exponent = bits & EXPONENT;
    bits & SIGN == 0 && exponent != 0 && exponent != EXPONENT
}

/// A subnormal is zero, as it is on a GPU that flushes. Applied to every
/// un-premultiplied colour before a formula branches or divides on it.
pub fn flush(value: f32) -> f32 {
    if value.to_bits() & EXPONENT == 0 {
        0.0
    } else {
        value
    }
}

/// Keep a result finite: NaN becomes 0, an infinity the largest finite value
/// of its sign, a subnormal 0. Applied to every component of every blended
/// pixel, so no non-finite value reaches the next layer or the output.
pub fn bound(value: f32) -> f32 {
    let bits = value.to_bits();
    let exponent = bits & EXPONENT;
    if exponent == 0 {
        return 0.0;
    }
    if exponent == EXPONENT {
        if bits & MANTISSA != 0 {
            return 0.0;
        }
        return f32::from_bits((bits & SIGN) | 0x7f7f_ffff);
    }
    value
}

/// A fixed per-pixel threshold in [0, 1) for Dissolve. `x` and `y` are the
/// stage pixel's integer index: a hash key, never a coordinate in float math.
pub fn hash_noise(x: u32, y: u32, seed: u32) -> f32 {
    let mut h =
        x.wrapping_mul(0x8da6_b343) ^ y.wrapping_mul(0xd816_3841) ^ seed.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    (h & 0x00ff_ffff) as f32 / 16_777_216.0
}

/// The Dissolve seed of one layer at one scene frame. Stable per object (an
/// FNV-1a hash of its id), so a Dissolve pattern does not change when other
/// layers are added; Dancing Dissolve mixes in the frame so the pattern moves.
pub fn dissolve_seed(object_id: &str, mode: BlendMode, scene_frame: u64) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in object_id.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    if mode == BlendMode::DancingDissolve {
        hash ^= (scene_frame as u32).wrapping_mul(0x9e37_79b9) ^ ((scene_frame >> 32) as u32);
    }
    hash
}

/// Composite one premultiplied source pixel onto a premultiplied backdrop.
pub fn blend(mode: BlendMode, dst: WorkingRgba, src: WorkingRgba, noise: f32) -> WorkingRgba {
    let [r, g, b, a] = blend_pixel(
        mode,
        [dst.r, dst.g, dst.b, dst.a],
        [src.r, src.g, src.b, src.a],
        noise,
    );
    WorkingRgba { r, g, b, a }
}

/// [`blend`] on component arrays: the form the GPU twin is written in.
pub fn blend_pixel(mode: BlendMode, dst: [f32; 4], src: [f32; 4], noise: f32) -> [f32; 4] {
    let raw = blend_raw(mode, dst, src, noise);
    [
        bound(raw[0]),
        bound(raw[1]),
        bound(raw[2]),
        bound(raw[3]).clamp(0.0, 1.0),
    ]
}

fn rec709_luminance(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn blend_raw(mode: BlendMode, dst: [f32; 4], src: [f32; 4], noise: f32) -> [f32; 4] {
    let sa = src[3];
    let da = dst[3];
    let over = |alpha: f32| {
        let k = 1.0 - sa;
        [
            src[0] + dst[0] * k,
            src[1] + dst[1] * k,
            src[2] + dst[2] * k,
            alpha,
        ]
    };
    let scale = |k: f32| [dst[0] * k, dst[1] * k, dst[2] * k, dst[3] * k];
    match mode {
        BlendMode::Normal => return over(sa + da * (1.0 - sa)),
        BlendMode::Dissolve | BlendMode::DancingDissolve => {
            if !covers(sa) || noise >= sa {
                return dst;
            }
            let inv = 1.0 / sa;
            return [src[0] * inv, src[1] * inv, src[2] * inv, 1.0];
        }
        BlendMode::AlphaMask => return scale(sa.clamp(0.0, 1.0)),
        BlendMode::InverseAlphaMask => return scale(1.0 - sa.clamp(0.0, 1.0)),
        BlendMode::StencilLuma => {
            return scale(rec709_luminance([src[0], src[1], src[2]]).clamp(0.0, 1.0));
        }
        BlendMode::SilhouetteLuma => {
            return scale(1.0 - rec709_luminance([src[0], src[1], src[2]]).clamp(0.0, 1.0));
        }
        BlendMode::AlphaAdd => return over((sa + da).min(1.0)),
        BlendMode::LuminescentPremul => return over(sa + da - sa * da),
        _ => {}
    }
    if !covers(sa) {
        return dst;
    }
    if !covers(da) {
        return src;
    }
    let mut cs = [flush(src[0] / sa), flush(src[1] / sa), flush(src[2] / sa)];
    let mut cb = [flush(dst[0] / da), flush(dst[1] / da), flush(dst[2] / da)];
    if !keeps_over_range(mode) {
        cs = cs.map(|v| v.clamp(0.0, 1.0));
        cb = cb.map(|v| v.clamp(0.0, 1.0));
    }
    let ao = sa + da - sa * da;
    if let Some(neutral) = classic_neutral(mode) {
        // After Effects' classic modes fade the source toward the colour that
        // leaves the backdrop unchanged, by the layer's coverage, and then
        // apply the formula at full strength.
        let faded = cs.map(|v| neutral + sa * (v - neutral));
        let b = non_separable(mode, cb, faded);
        return [
            (1.0 - da) * src[0] + da * b[0],
            (1.0 - da) * src[1] + da * b[1],
            (1.0 - da) * src[2] + da * b[2],
            ao,
        ];
    }
    let b = non_separable(mode, cb, cs);
    // The shared coverage, flushed: a GPU flushes a subnormal product, and
    // `0 * inf` and `subnormal * inf` must not disagree.
    let both = flush(sa * da);
    [
        (1.0 - da) * src[0] + (1.0 - sa) * dst[0] + both * b[0],
        (1.0 - da) * src[1] + (1.0 - sa) * dst[1] + both * b[1],
        (1.0 - da) * src[2] + (1.0 - sa) * dst[2] + both * b[2],
        ao,
    ]
}

/// Modes whose formulas are defined above 1 (After Effects 32 bpc). The others
/// clamp their un-premultiplied inputs to [0, 1] first.
pub fn keeps_over_range(mode: BlendMode) -> bool {
    !matches!(
        mode,
        BlendMode::ColorDodge
            | BlendMode::ClassicColorDodge
            | BlendMode::SoftLight
            | BlendMode::HardLight
            | BlendMode::LinearLight
            | BlendMode::VividLight
            | BlendMode::PinLight
            | BlendMode::HardMix
            | BlendMode::Hue
            | BlendMode::Saturation
            | BlendMode::Color
    )
}

fn classic_neutral(mode: BlendMode) -> Option<f32> {
    match mode {
        BlendMode::ClassicColorDodge | BlendMode::ClassicDifference => Some(0.0),
        BlendMode::ClassicColorBurn => Some(1.0),
        _ => None,
    }
}

fn burn(cb: f32, cs: f32) -> f32 {
    if cb >= 1.0 {
        1.0
    } else if cs <= 0.0 {
        0.0
    } else {
        1.0 - ((1.0 - cb) / cs).min(1.0)
    }
}

fn dodge(cb: f32, cs: f32) -> f32 {
    if cb <= 0.0 {
        0.0
    } else if cs >= 1.0 {
        1.0
    } else {
        (cb / (1.0 - cs)).min(1.0)
    }
}

fn hard_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        cb * 2.0 * cs
    } else {
        let s = 2.0 * cs - 1.0;
        cb + s - cb * s
    }
}

fn soft_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
    } else {
        let d = if cb <= 0.25 {
            ((16.0 * cb - 12.0) * cb + 4.0) * cb
        } else {
            cb.max(0.0).sqrt()
        };
        cb + (2.0 * cs - 1.0) * (d - cb)
    }
}

fn separable(mode: BlendMode, cb: f32, cs: f32) -> f32 {
    match mode {
        BlendMode::Darken => cb.min(cs),
        BlendMode::Multiply => cb * cs,
        BlendMode::ColorBurn => burn(cb, cs),
        // Negative results are kept, as in After Effects.
        BlendMode::ClassicColorBurn => {
            if cs <= 0.0 {
                0.0
            } else {
                1.0 - (1.0 - cb) / cs
            }
        }
        BlendMode::LinearBurn => (cb + cs - 1.0).max(0.0),
        BlendMode::Add | BlendMode::LinearDodge => cb + cs,
        BlendMode::Lighten => cb.max(cs),
        BlendMode::Screen => cb + cs - cb * cs,
        BlendMode::ColorDodge => dodge(cb, cs),
        BlendMode::ClassicColorDodge => {
            if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        BlendMode::Overlay => hard_light(cs, cb),
        BlendMode::SoftLight => soft_light(cb, cs),
        BlendMode::HardLight => hard_light(cb, cs),
        BlendMode::LinearLight => (cb + 2.0 * cs - 1.0).clamp(0.0, 1.0),
        BlendMode::VividLight => {
            if cs <= 0.5 {
                burn(cb, 2.0 * cs)
            } else {
                dodge(cb, 2.0 * (cs - 0.5))
            }
        }
        BlendMode::PinLight => {
            if cs <= 0.5 {
                cb.min(2.0 * cs)
            } else {
                cb.max(2.0 * cs - 1.0)
            }
        }
        BlendMode::HardMix => {
            if cb + cs >= 1.0 {
                1.0
            } else {
                0.0
            }
        }
        BlendMode::Difference | BlendMode::ClassicDifference => (cb - cs).abs(),
        BlendMode::Exclusion => cb + cs - 2.0 * cb * cs,
        BlendMode::Subtract => (cb - cs).max(0.0),
        BlendMode::Divide => {
            if cs <= 0.0 {
                if cb > 0.0 {
                    1.0
                } else {
                    0.0
                }
            } else {
                cb / cs
            }
        }
        _ => cs,
    }
}

// The non-separable modes' luma weights are the PDF/Photoshop ones, not
// Rec.709; Darker and Lighter Color compare Rec.709 luminance.
fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn clip_color(c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    let mut o = c;
    // The ratio first: (v - l) * l can overflow for over-range colours where
    // the ratio cannot, and the GPU twin computes it in this order too.
    if n < 0.0 {
        let k = l / (l - n).max(1e-9);
        o = o.map(|v| l + (v - l) * k);
    }
    if x > 1.0 {
        let k = (1.0 - l) / (x - l).max(1e-9);
        o = o.map(|v| l + (v - l) * k);
    }
    o
}

fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let mx = c[0].max(c[1]).max(c[2]);
    let mn = c[0].min(c[1]).min(c[2]);
    if mx - mn <= 1e-9 {
        return [0.0; 3];
    }
    let k = s / (mx - mn);
    c.map(|v| (v - mn) * k)
}

fn non_separable(mode: BlendMode, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    match mode {
        BlendMode::Hue => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        BlendMode::Saturation => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        BlendMode::Color => set_lum(cs, lum(cb)),
        BlendMode::Luminosity => set_lum(cb, lum(cs)),
        BlendMode::DarkerColor => {
            if rec709_luminance(cs) < rec709_luminance(cb) {
                cs
            } else {
                cb
            }
        }
        BlendMode::LighterColor => {
            if rec709_luminance(cs) > rec709_luminance(cb) {
                cs
            } else {
                cb
            }
        }
        _ => [
            separable(mode, cb[0], cs[0]),
            separable(mode, cb[1], cs[1]),
            separable(mode, cb[2], cs[2]),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque(v: f32) -> [f32; 4] {
        [v, v, v, 1.0]
    }

    fn close(a: f32, e: f32) -> bool {
        (a - e).abs() < 1e-5
    }

    #[test]
    fn opaque_formulas_match_the_published_definitions() {
        let r = |m| blend_pixel(m, opaque(0.6), opaque(0.3), 0.5)[0];
        assert!(close(r(BlendMode::Normal), 0.3));
        assert!(close(r(BlendMode::Multiply), 0.18));
        assert!(close(r(BlendMode::Screen), 0.6 + 0.3 - 0.18));
        assert!(close(r(BlendMode::Add), 0.9));
        assert!(close(r(BlendMode::LinearDodge), 0.9));
        assert!(close(r(BlendMode::Difference), 0.3));
        assert!(close(r(BlendMode::Darken), 0.3));
        assert!(close(r(BlendMode::Lighten), 0.6));
        assert!(close(r(BlendMode::Subtract), 0.3));
        assert!(close(r(BlendMode::Divide), 1.0) || r(BlendMode::Divide) > 1.0);
        assert!(close(r(BlendMode::LinearBurn), 0.0));
        assert!(close(r(BlendMode::Exclusion), 0.9 - 0.36));
        // Overlay over a 0.6 backdrop is the screen half: hard_light(0.3, 0.6).
        assert!(close(r(BlendMode::Overlay), 0.3 + 0.2 - 0.06));
        assert!(close(r(BlendMode::HardMix), 0.0));
        assert!(close(r(BlendMode::PinLight), 0.6f32.min(0.6)));
    }

    #[test]
    fn a_transparent_source_leaves_the_backdrop_except_for_the_stencils() {
        let d = [0.2, 0.3, 0.4, 0.8];
        for m in BlendMode::ALL {
            let o = blend_pixel(m, d, [0.0; 4], 0.5);
            let expected = match m {
                BlendMode::AlphaMask | BlendMode::StencilLuma => [0.0; 4],
                _ => d,
            };
            assert!((0..4).all(|i| close(o[i], expected[i])), "{m:?} {o:?}");
        }
    }

    #[test]
    fn a_source_over_a_transparent_backdrop_is_the_source() {
        let s = [0.25, 0.1, 0.05, 0.5];
        for m in BlendMode::ALL {
            if m.acts_on_whole_backdrop()
                || matches!(m, BlendMode::Dissolve | BlendMode::DancingDissolve)
            {
                continue;
            }
            let o = blend_pixel(m, [0.0; 4], s, 0.9);
            assert!((0..4).all(|i| close(o[i], s[i])), "{m:?} {o:?}");
        }
    }

    #[test]
    fn the_after_effects_32_bit_formulas_hold() {
        let at =
            |m, b: f32, o: f32, k: f32| blend_pixel(m, opaque(b), [o * k, o * k, o * k, k], 0.5)[0];
        for (b, o) in [(0.4, 0.5), (0.8, 0.9), (0.1, 0.3)] {
            let k = 0.15;
            assert!(close(
                at(BlendMode::ClassicColorDodge, b, o, k),
                (b / (1.0 - k * o)).min(1.0)
            ));
            assert!(close(
                at(BlendMode::ClassicDifference, b, o, k),
                (b - k * o).abs()
            ));
            assert!(close(
                at(BlendMode::ClassicColorBurn, b, o, k),
                1.0 - (1.0 - b) / (1.0 - k * (1.0 - o))
            ));
        }
        assert!(close(at(BlendMode::ClassicDifference, 0.6, 0.3, 1.0), 0.3));
        let (b, o) = (0.7, 3.0);
        assert!(close(
            at(BlendMode::Exclusion, b, o, 1.0),
            b + o - 2.0 * b * o
        ));
        let s = 2.0 * b - 1.0;
        assert!(close(at(BlendMode::Overlay, b, o, 1.0), o + s - o * s));
        assert!(
            close(at(BlendMode::ClassicColorBurn, 0.0, 0.1, 1.0), -9.0),
            "negative results are kept"
        );
        // Add and Screen keep over-range values; Soft Light clamps its inputs.
        let d = [2.0, 2.0, 2.0, 1.0];
        let h = [0.5, 0.5, 0.5, 1.0];
        assert!(close(blend_pixel(BlendMode::Add, d, h, 0.5)[0], 2.5));
        assert!(close(blend_pixel(BlendMode::Screen, d, h, 0.5)[0], 1.5));
        assert!(blend_pixel(BlendMode::SoftLight, d, h, 0.5)[0] <= 1.0);
        let l = blend_pixel(
            BlendMode::Luminosity,
            [0.2, 0.4, 0.6, 1.0],
            [2.0, 2.0, 2.0, 1.0],
            0.5,
        );
        let e = set_lum([0.2, 0.4, 0.6], 2.0);
        assert!((0..3).all(|i| close(l[i], e[i])), "{l:?} {e:?}");
    }

    #[test]
    fn dissolve_shows_the_layer_where_the_threshold_is_below_its_alpha() {
        let d = [0.1, 0.1, 0.1, 1.0];
        let s = [0.3, 0.2, 0.1, 0.5];
        assert_eq!(blend_pixel(BlendMode::Dissolve, d, s, 0.7), d);
        let shown = blend_pixel(BlendMode::Dissolve, d, s, 0.2);
        assert!(close(shown[0], 0.6) && close(shown[3], 1.0));
        assert_ne!(
            dissolve_seed("a", BlendMode::Dissolve, 0),
            dissolve_seed("b", BlendMode::Dissolve, 0)
        );
        assert_eq!(
            dissolve_seed("a", BlendMode::Dissolve, 0),
            dissolve_seed("a", BlendMode::Dissolve, 9)
        );
        assert_ne!(
            dissolve_seed("a", BlendMode::DancingDissolve, 0),
            dissolve_seed("a", BlendMode::DancingDissolve, 1)
        );
    }

    #[test]
    fn no_input_makes_a_non_finite_or_out_of_range_result() {
        // Subnormal and tiny alphas, over-range and huge colours, the inputs
        // behind EffectCraft's DX12 NaNs among them.
        let alphas = [
            0.0,
            f32::from_bits(1),
            1e-39,
            f32::MIN_POSITIVE,
            1e-30,
            1e-7,
            0.5,
            1.0,
        ];
        let colours = [0.0, 1e-39, 1e-20, 0.25, 1.0, 3.0, 1e20, 3e38];
        let mut checked = 0u64;
        for m in BlendMode::ALL {
            for &sa in &alphas {
                for &da in &alphas {
                    for &c in &colours {
                        for &e in &colours {
                            let src = [c * sa.clamp(1e-30, 1.0), c * 0.5, c, sa];
                            let dst = [e, e * 0.25, e * sa, da];
                            let o = blend_pixel(m, dst, src, 0.37);
                            assert!(
                                o.iter().all(|v| v.is_finite()),
                                "{m:?} {dst:?} {src:?} -> {o:?}"
                            );
                            assert!((0.0..=1.0).contains(&o[3]), "{m:?} alpha {o:?}");
                            checked += 1;
                        }
                    }
                }
            }
        }
        assert!(checked > 100_000);
        assert_eq!(bound(f32::NAN), 0.0);
        assert_eq!(bound(f32::INFINITY), f32::MAX);
        assert_eq!(bound(f32::NEG_INFINITY), -f32::MAX);
        assert_eq!(bound(f32::from_bits(1)), 0.0);
        assert!(!covers(f32::from_bits(1)) && !covers(-0.5) && !covers(f32::NAN) && covers(1e-30));
    }

    #[test]
    fn the_gpu_mode_numbers_are_the_contract_order() {
        let constants = wgsl_mode_constants();
        assert_eq!(constants.lines().count(), BlendMode::ALL.len());
        assert!(constants.contains("const M_Normal: u32 = 0u;"));
        assert!(constants.contains("const M_LuminescentPremul: u32 = 37u;"));
        assert_eq!(mode_index(BlendMode::Overlay), 4);
    }
}
