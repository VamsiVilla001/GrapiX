// Layer blend modes on the GPU (build-plan 3.20): the twin of src/blend.rs,
// line for line. Formulas ported from EffectCraft at
// 9a7d3e76991d5372448033b473dc12c2480a6a04: crates/gpu/src/shaders/common.wgsl
// (blend modes, hash_noise). Copyright (c) 2026 ArtCraft Team and the
// EffectCraft contributors. MIT OR Apache-2.0; see EFFECTCRAFT-LICENSE.
// GrapiX: mode numbers are positions in the contract's BlendMode::ALL, given
// as generated M_* constants; coverage, flush and bound are tested on bit
// patterns so no compiler folding or subnormal flushing can produce a NaN.

const SIGN_BIT: u32 = 0x80000000u;
const EXPONENT_BITS: u32 = 0x7f800000u;
const MANTISSA_BITS: u32 = 0x007fffffu;

fn covers(alpha: f32) -> bool {
    let bits = bitcast<u32>(alpha);
    let exponent = bits & EXPONENT_BITS;
    return (bits & SIGN_BIT) == 0u && exponent != 0u && exponent != EXPONENT_BITS;
}

fn flush(value: f32) -> f32 {
    if ((bitcast<u32>(value) & EXPONENT_BITS) == 0u) {
        return 0.0;
    }
    return value;
}

fn bound(value: f32) -> f32 {
    let bits = bitcast<u32>(value);
    let exponent = bits & EXPONENT_BITS;
    if (exponent == 0u) {
        return 0.0;
    }
    if (exponent == EXPONENT_BITS) {
        if ((bits & MANTISSA_BITS) != 0u) {
            return 0.0;
        }
        return bitcast<f32>((bits & SIGN_BIT) | 0x7f7fffffu);
    }
    return value;
}

fn hash_noise(x: u32, y: u32, seed: u32) -> f32 {
    var h = (x * 0x8da6b343u) ^ (y * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
    h = h ^ (h >> 13u);
    h = h * 0x5bd1e995u;
    h = h ^ (h >> 15u);
    return f32(h & 0x00ffffffu) / 16777216.0;
}

fn rec709_luminance(c: vec3<f32>) -> f32 {
    return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
}

fn keeps_over_range(mode: u32) -> bool {
    return !(mode == M_ColorDodge || mode == M_ClassicColorDodge || mode == M_SoftLight
        || mode == M_HardLight || mode == M_LinearLight || mode == M_VividLight
        || mode == M_PinLight || mode == M_HardMix || mode == M_Hue
        || mode == M_Saturation || mode == M_Color);
}

fn burn(cb: f32, cs: f32) -> f32 {
    if (cb >= 1.0) {
        return 1.0;
    }
    if (cs <= 0.0) {
        return 0.0;
    }
    return 1.0 - min((1.0 - cb) / cs, 1.0);
}

fn dodge(cb: f32, cs: f32) -> f32 {
    if (cb <= 0.0) {
        return 0.0;
    }
    if (cs >= 1.0) {
        return 1.0;
    }
    return min(cb / (1.0 - cs), 1.0);
}

fn hard_light(cb: f32, cs: f32) -> f32 {
    if (cs <= 0.5) {
        return cb * 2.0 * cs;
    }
    let s = 2.0 * cs - 1.0;
    return cb + s - cb * s;
}

fn soft_light(cb: f32, cs: f32) -> f32 {
    if (cs <= 0.5) {
        return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    }
    var d: f32;
    if (cb <= 0.25) {
        d = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
    } else {
        d = sqrt(max(cb, 0.0));
    }
    return cb + (2.0 * cs - 1.0) * (d - cb);
}

fn separable(mode: u32, cb: f32, cs: f32) -> f32 {
    if (mode == M_Darken) { return min(cb, cs); }
    if (mode == M_Multiply) { return cb * cs; }
    if (mode == M_ColorBurn) { return burn(cb, cs); }
    if (mode == M_ClassicColorBurn) {
        if (cs <= 0.0) { return 0.0; }
        return 1.0 - (1.0 - cb) / cs;
    }
    if (mode == M_LinearBurn) { return max(cb + cs - 1.0, 0.0); }
    if (mode == M_Add || mode == M_LinearDodge) { return cb + cs; }
    if (mode == M_Lighten) { return max(cb, cs); }
    if (mode == M_Screen) { return cb + cs - cb * cs; }
    if (mode == M_ColorDodge) { return dodge(cb, cs); }
    if (mode == M_ClassicColorDodge) {
        if (cs >= 1.0) { return 1.0; }
        return min(cb / (1.0 - cs), 1.0);
    }
    if (mode == M_Overlay) { return hard_light(cs, cb); }
    if (mode == M_SoftLight) { return soft_light(cb, cs); }
    if (mode == M_HardLight) { return hard_light(cb, cs); }
    if (mode == M_LinearLight) { return clamp(cb + 2.0 * cs - 1.0, 0.0, 1.0); }
    if (mode == M_VividLight) {
        if (cs <= 0.5) { return burn(cb, 2.0 * cs); }
        return dodge(cb, 2.0 * (cs - 0.5));
    }
    if (mode == M_PinLight) {
        if (cs <= 0.5) { return min(cb, 2.0 * cs); }
        return max(cb, 2.0 * cs - 1.0);
    }
    if (mode == M_HardMix) {
        if (cb + cs >= 1.0) { return 1.0; }
        return 0.0;
    }
    if (mode == M_Difference || mode == M_ClassicDifference) { return abs(cb - cs); }
    if (mode == M_Exclusion) { return cb + cs - 2.0 * cb * cs; }
    if (mode == M_Subtract) { return max(cb - cs, 0.0); }
    if (mode == M_Divide) {
        if (cs <= 0.0) {
            if (cb > 0.0) { return 1.0; }
            return 0.0;
        }
        return cb / cs;
    }
    return cs;
}

fn lum(c: vec3<f32>) -> f32 {
    return 0.3 * c.x + 0.59 * c.y + 0.11 * c.z;
}

fn clip_color(c: vec3<f32>) -> vec3<f32> {
    let l = lum(c);
    let n = min(min(c.x, c.y), c.z);
    let x = max(max(c.x, c.y), c.z);
    var o = c;
    if (n < 0.0) {
        let k = l / max(l - n, 1e-9);
        o = l + (o - l) * k;
    }
    if (x > 1.0) {
        let k = (1.0 - l) / max(x - l, 1e-9);
        o = l + (o - l) * k;
    }
    return o;
}

fn set_lum(c: vec3<f32>, l: f32) -> vec3<f32> {
    let d = l - lum(c);
    return clip_color(c + d);
}

fn sat(c: vec3<f32>) -> f32 {
    return max(max(c.x, c.y), c.z) - min(min(c.x, c.y), c.z);
}

fn set_sat(c: vec3<f32>, s: f32) -> vec3<f32> {
    let mx = max(max(c.x, c.y), c.z);
    let mn = min(min(c.x, c.y), c.z);
    if (mx - mn <= 1e-9) {
        return vec3<f32>(0.0);
    }
    let k = s / (mx - mn);
    return (c - mn) * k;
}

fn non_separable(mode: u32, cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    if (mode == M_Hue) { return set_lum(set_sat(cs, sat(cb)), lum(cb)); }
    if (mode == M_Saturation) { return set_lum(set_sat(cb, sat(cs)), lum(cb)); }
    if (mode == M_Color) { return set_lum(cs, lum(cb)); }
    if (mode == M_Luminosity) { return set_lum(cb, lum(cs)); }
    if (mode == M_DarkerColor) {
        if (rec709_luminance(cs) < rec709_luminance(cb)) { return cs; }
        return cb;
    }
    if (mode == M_LighterColor) {
        if (rec709_luminance(cs) > rec709_luminance(cb)) { return cs; }
        return cb;
    }
    return vec3<f32>(separable(mode, cb.x, cs.x), separable(mode, cb.y, cs.y), separable(mode, cb.z, cs.z));
}

fn classic_neutral(mode: u32) -> f32 {
    // Only read for the three classic modes; -1 marks the rest.
    if (mode == M_ClassicColorDodge || mode == M_ClassicDifference) { return 0.0; }
    if (mode == M_ClassicColorBurn) { return 1.0; }
    return -1.0;
}

fn blend_raw(mode: u32, dst: vec4<f32>, src: vec4<f32>, noise: f32) -> vec4<f32> {
    let sa = src.w;
    let da = dst.w;
    let k = 1.0 - sa;
    if (mode == M_Normal) {
        return vec4<f32>(src.xyz + dst.xyz * k, sa + da * (1.0 - sa));
    }
    if (mode == M_Dissolve || mode == M_DancingDissolve) {
        if (!covers(sa) || noise >= sa) {
            return dst;
        }
        let inv = 1.0 / sa;
        return vec4<f32>(src.xyz * inv, 1.0);
    }
    if (mode == M_AlphaMask) { return dst * clamp(sa, 0.0, 1.0); }
    if (mode == M_InverseAlphaMask) { return dst * (1.0 - clamp(sa, 0.0, 1.0)); }
    if (mode == M_StencilLuma) { return dst * clamp(rec709_luminance(src.xyz), 0.0, 1.0); }
    if (mode == M_SilhouetteLuma) { return dst * (1.0 - clamp(rec709_luminance(src.xyz), 0.0, 1.0)); }
    if (mode == M_AlphaAdd) { return vec4<f32>(src.xyz + dst.xyz * k, min(sa + da, 1.0)); }
    if (mode == M_LuminescentPremul) { return vec4<f32>(src.xyz + dst.xyz * k, sa + da - sa * da); }
    if (!covers(sa)) {
        return dst;
    }
    if (!covers(da)) {
        return src;
    }
    var cs = vec3<f32>(flush(src.x / sa), flush(src.y / sa), flush(src.z / sa));
    var cb = vec3<f32>(flush(dst.x / da), flush(dst.y / da), flush(dst.z / da));
    if (!keeps_over_range(mode)) {
        cs = clamp(cs, vec3<f32>(0.0), vec3<f32>(1.0));
        cb = clamp(cb, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let ao = sa + da - sa * da;
    let neutral = classic_neutral(mode);
    if (neutral >= 0.0) {
        let faded = neutral + sa * (cs - neutral);
        let bc = non_separable(mode, cb, faded);
        return vec4<f32>((1.0 - da) * src.xyz + da * bc, ao);
    }
    let b = non_separable(mode, cb, cs);
    let both = flush(sa * da);
    return vec4<f32>((1.0 - da) * src.xyz + (1.0 - sa) * dst.xyz + both * b, ao);
}

fn blend_pixel(mode: u32, dst: vec4<f32>, src: vec4<f32>, noise: f32) -> vec4<f32> {
    let raw = blend_raw(mode, dst, src, noise);
    return vec4<f32>(bound(raw.x), bound(raw.y), bound(raw.z), clamp(bound(raw.w), 0.0, 1.0));
}
