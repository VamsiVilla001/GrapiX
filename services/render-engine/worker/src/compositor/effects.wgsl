// Pointwise effects on the GPU (build-plan 3.22): the twin of src/effects.rs,
// reading the same packed parameter block. Formulas ported from EffectCraft
// at 9a7d3e76991d5372448033b473dc12c2480a6a04 (crates/effects/src/color_fx.rs,
// crates/color/src/lib.rs HSL). Copyright (c) 2026 ArtCraft Team and the
// EffectCraft contributors. MIT OR Apache-2.0; see EFFECTCRAFT-LICENSE.
// Prepended by the generated M_* constants and blend.wgsl (covers, bound).

const E_IDENTITY: u32 = 0u;
const E_FILL: u32 = 1u;
const E_TINT: u32 = 2u;
const E_LEVELS: u32 = 3u;
const E_CURVES: u32 = 4u;
const E_HUE_SATURATION: u32 = 5u;
const E_BRIGHTNESS_CONTRAST: u32 = 6u;
const E_EXPOSURE: u32 = 7u;
const E_RAMP: u32 = 8u;
const E_LINEAR_WIPE: u32 = 9u;
const E_RADIAL_WIPE: u32 = 10u;
const E_IRIS_WIPE: u32 = 11u;
const E_BOX: u32 = 12u;
const E_DIRECTIONAL: u32 = 13u;
const E_SAVE: u32 = 14u;
const E_GLOW_BRIGHT: u32 = 15u;
const E_GLOW_COMBINE: u32 = 16u;
const E_SHADOW_MAKE: u32 = 17u;
const E_SHADOW_COMBINE: u32 = 18u;
const E_INVERT: u32 = 19u;
const E_POSTERIZE: u32 = 20u;
const E_THRESHOLD: u32 = 21u;
const E_VIBRANCE: u32 = 22u;
const E_TRITONE: u32 = 23u;
const E_CHANNEL_MIXER: u32 = 24u;
const E_COLOR_BALANCE: u32 = 25u;
const E_GAMMA_PEDESTAL_GAIN: u32 = 26u;
const E_COLOR_BALANCE_HLS: u32 = 27u;
const E_BLACK_WHITE: u32 = 28u;
const E_PHOTO_FILTER: u32 = 29u;
const E_LEAVE_COLOR: u32 = 30u;
const E_VIDEO_LIMITER: u32 = 31u;
const E_BROADCAST_COLORS: u32 = 32u;
const E_CC_TONER: u32 = 33u;
const E_CC_COLOR_OFFSET: u32 = 34u;
const E_CC_THRESHOLD: u32 = 35u;
const E_CC_THRESHOLD_RGB: u32 = 36u;
const E_CHANGE_COLOR: u32 = 37u;
const E_SHIFT_CHANNELS: u32 = 38u;
const E_LINEAR_COLOR_KEY: u32 = 39u;
const E_REMOVE_COLOR_MATTING: u32 = 40u;
const E_EXTRACT: u32 = 41u;
const E_CC_COLOR_NEUTRALIZER: u32 = 42u;
const E_UNMULT: u32 = 43u;
const E_SPILL_SUPPRESSOR: u32 = 44u;
const E_COLOR_RANGE: u32 = 45u;
const E_ARITHMETIC: u32 = 46u;
const E_COLOR_DIFFERENCE_KEY: u32 = 47u;
const E_SELECTIVE_COLOR: u32 = 48u;
const E_MIX: u32 = 49u;
const SQRT_3: f32 = 1.7320508;
const ORIGIN_SLOT: u32 = 60u;
const DEPTH_SLOT: u32 = 62u;
const PI: f32 = 3.14159265358979;
const LUT_N: u32 = 1024u;
const CURVE_BLOCK: u32 = 1031u;

struct EffectParams {
    kind: vec4<u32>,
    p: array<vec4<f32>, 16>,
}

@group(0) @binding(0) var effect_src: texture_2d<f32>;
@group(0) @binding(1) var effect_out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> effect: EffectParams;
@group(0) @binding(3) var<storage, read> curve: array<f32>;
// The saved input of a glow or drop shadow, for its combine pass.
@group(0) @binding(4) var effect_aux: texture_2d<f32>;
// 3.28: the mask weights of a mix pass (alpha is the weight); a placeholder otherwise.
@group(0) @binding(5) var effect_weights: texture_2d<f32>;

fn P(i: u32) -> f32 {
    return effect.p[i / 4u][i % 4u];
}

// The project's colour depth: 8 and 16 bit store a whole level held to 0-1,
// 32 bit (levels 0) stores nothing; `blend::store_pixel` on the CPU.
fn store_depth(v: vec4<f32>) -> vec4<f32> {
    let levels = P(DEPTH_SLOT);
    if (levels > 0.0) {
        return floor(clamp(v, vec4<f32>(0.0), vec4<f32>(1.0)) * levels + 0.5) / levels;
    }
    return v;
}

// pow for x >= 0 with 0^y = 0 (y > 0), 1 (y == 0), as Rust's powf.
fn powz(x: f32, y: f32) -> f32 {
    if (x <= 0.0) {
        return select(0.0, 1.0, y == 0.0);
    }
    // An exponent of 1 is exact, as on the CPU: an identity setting (gamma 1,
    // no contrast) must not move a value by a GPU pow's rounding.
    if (y == 1.0) {
        return x;
    }
    return pow(x, y);
}

fn mirror_pow(v: f32, p: f32) -> f32 {
    let m = powz(abs(v), p);
    return select(m, -m, v < 0.0);
}

fn srgb_decode(v: f32) -> f32 {
    if (v <= 0.04045) { return v / 12.92; }
    return powz((v + 0.055) / 1.055, 2.4);
}

fn srgb_encode(v: f32) -> f32 {
    if (v <= 0.0031308) { return v * 12.92; }
    return 1.055 * powz(v, 1.0 / 2.4) - 0.055;
}

fn level(v: f32, base: u32, clip_black: bool, clip_white: bool) -> f32 {
    var t = (v - P(base)) / max(P(base + 1u) - P(base), 1e-6);
    if (clip_black) { t = max(t, 0.0); }
    if (clip_white) { t = min(t, 1.0); }
    let s = powz(max(t, 0.0), P(base + 2u));
    return P(base + 3u) + (P(base + 4u) - P(base + 3u)) * s;
}

fn curve_eval(channel: u32, v: f32) -> f32 {
    let b = channel * CURVE_BLOCK;
    let e = b + LUT_N + 1u;
    if (v < 0.0) { return curve[e + 1u] + (v - curve[e]) * curve[e + 2u]; }
    if (v > 1.0) { return curve[e + 4u] + (v - curve[e + 3u]) * curve[e + 5u]; }
    let f = v * f32(LUT_N);
    let i = min(u32(floor(f)), LUT_N - 1u);
    let w = f - f32(i);
    return curve[b + i] + (curve[b + i + 1u] - curve[b + i]) * w;
}

fn effect_luma(c: vec3<f32>) -> f32 {
    return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
}

// Rust's f32::round: halves go away from zero (WGSL's round goes to even), for non-negative values.
fn round_half_up(x: f32) -> f32 {
    let f = floor(x);
    return select(f, f + 1.0, x - f >= 0.5);
}

// How much a colour belongs to each Selective Color range, in the order reds, yellows, greens,
// cyans, blues, magentas, whites, neutrals, blacks (selective_weights in effects.rs). The channel
// order is a stable insertion sort, largest first, so a tie keeps red, green, blue order.
fn selective_weights(c0: vec3<f32>) -> array<f32, 9> {
    let c = clamp(c0, vec3<f32>(0.0), vec3<f32>(1.0));
    // The stable insertion sort of the three channel indices, largest first, unrolled by hand: a
    // loop whose trip count depends on the data, with stores by index, cannot be unrolled by FXC
    // (DX12, X3511). A strict > keeps a tie in red, green, blue order.
    var a0 = 0u;
    var a1 = 1u;
    var a2 = 2u;
    if (c[a1] > c[a0]) {
        let t = a0;
        a0 = a1;
        a1 = t;
    }
    if (c[a2] > c[a1]) {
        let t = a1;
        a1 = a2;
        a2 = t;
        if (c[a1] > c[a0]) {
            let u = a0;
            a0 = a1;
            a1 = u;
        }
    }
    let mx = c[a0];
    let md = c[a1];
    let mn = c[a2];
    // A primary takes the largest channel's lead over the middle (reds when red is largest, greens
    // for green, blues for blue); a secondary takes the middle's lead over the smallest (yellows
    // when blue is smallest, cyans for red, magentas for green).
    let lead = mx - md;
    let rest = md - mn;
    return array<f32, 9>(
        select(0.0, lead, a0 == 0u),
        select(0.0, rest, a2 == 2u),
        select(0.0, lead, a0 == 1u),
        select(0.0, rest, a2 == 0u),
        select(0.0, lead, a0 == 2u),
        select(0.0, rest, a2 == 1u),
        max((mn - 0.5) * 2.0, 0.0),
        clamp(1.0 - (abs(mx - 0.5) + abs(mn - 0.5)), 0.0, 1.0),
        max((0.5 - mx) * 2.0, 0.0),
    );
}

fn matte_levels(v: f32, in_b: f32, in_w: f32, gamma: f32, out_b: f32, out_w: f32) -> f32 {
    let t0 = clamp((v - in_b / 255.0) / max((in_w - in_b) / 255.0, 1e-4), 0.0, 1.0);
    let t = powz(t0, 1.0 / max(gamma, 0.01));
    return clamp(out_b / 255.0 + t * (out_w - out_b) / 255.0, 0.0, 1.0);
}

fn lab_f(t: f32) -> f32 {
    if (t > 0.008856) { return pow(t, 1.0 / 3.0); }
    return 7.787 * t + 16.0 / 116.0;
}

fn to_lab(c: vec3<f32>) -> vec3<f32> {
    let cc = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    let l = vec3<f32>(srgb_decode(cc.x), srgb_decode(cc.y), srgb_decode(cc.z));
    let x = (0.4124 * l.x + 0.3576 * l.y + 0.1805 * l.z) / 0.95047;
    let y = 0.2126 * l.x + 0.7152 * l.y + 0.0722 * l.z;
    let z = (0.0193 * l.x + 0.1192 * l.y + 0.9505 * l.z) / 1.08883;
    let fx = lab_f(x);
    let fy = lab_f(y);
    let fz = lab_f(z);
    return vec3<f32>(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

fn range_components(space: u32, c: vec3<f32>) -> vec3<f32> {
    if (space == 1u) {
        let y = 0.299 * c.x + 0.587 * c.y + 0.114 * c.z;
        let u = -0.14713 * c.x - 0.28886 * c.y + 0.436 * c.z;
        let v = 0.615 * c.x - 0.51499 * c.y - 0.10001 * c.z;
        return vec3<f32>(y * 255.0, u * 255.0 + 128.0, v * 255.0 + 128.0);
    }
    if (space == 2u) { return c * 255.0; }
    let lab = to_lab(c);
    return vec3<f32>(lab.x * 2.55, lab.y + 128.0, lab.z + 128.0);
}

fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
    let mx = max(max(c.x, c.y), c.z);
    let mn = min(min(c.x, c.y), c.z);
    let l = (mx + mn) * 0.5;
    let d = mx - mn;
    if (d < 1e-7) { return vec3<f32>(0.0, 0.0, l); }
    var s: f32;
    if (l > 0.5) { s = d / (2.0 - mx - mn); } else { s = d / (mx + mn); }
    var h: f32;
    if (mx == c.x) {
        h = ((c.y - c.z) / d + select(0.0, 6.0, c.y < c.z)) / 6.0;
    } else if (mx == c.y) {
        h = ((c.z - c.x) / d + 2.0) / 6.0;
    } else {
        h = ((c.x - c.y) / d + 4.0) / 6.0;
    }
    return vec3<f32>(h, s, l);
}

fn hsl_channel(p: f32, q: f32, t0: f32) -> f32 {
    let t = t0 - floor(t0);
    if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 0.5) { return q; }
    if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    return p;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
    let h = hsl.x;
    let s = hsl.y;
    let l = hsl.z;
    if (s <= 0.0) { return vec3<f32>(l); }
    var q: f32;
    if (l < 0.5) { q = l * (1.0 + s); } else { q = l + s - l * s; }
    let p = 2.0 * l - q;
    return vec3<f32>(hsl_channel(p, q, h + 1.0 / 3.0), hsl_channel(p, q, h), hsl_channel(p, q, h - 1.0 / 3.0));
}

fn bc_modern(v: f32, exponent: f32, gain: f32) -> f32 {
    if (v >= 1.0) { return v; }
    let w = powz(max(v, 0.0), exponent);
    if (w < 0.5) { return 0.5 * powz(2.0 * w, gain); }
    return 1.0 - 0.5 * powz(max(2.0 - 2.0 * w, 0.0), gain);
}

fn exposure_channel(v: f32) -> f32 {
    if (P(3u) > 0.5) {
        let o = mirror_pow(srgb_decode(max(v, 0.0)) * P(0u) + P(1u), P(2u));
        let e = srgb_encode(abs(o));
        return select(e, -e, o < 0.0);
    }
    return mirror_pow(v * P(0u) + P(1u), P(2u));
}

// Gamma/Pedestal/Gain for one channel; `base` is its first parameter. Black Stretch
// (P(9)) lifts the low end, with (1 - x)^4 written as two squares, as on the CPU.
fn gpg_channel(v: f32, base: u32) -> f32 {
    var x = v;
    let stretch = P(9u);
    if (stretch > 0.0 && x > 0.0 && x < 1.0) {
        let t = 1.0 - x;
        let t2 = t * t;
        x = x + stretch * 0.25 * x * (t2 * t2);
    }
    let pd = P(base + 1u);
    return max(pd + (P(base + 2u) - pd) * powz(max(x, 0.0), P(base)), 0.0);
}

fn mixer_row(c: vec3<f32>, base: u32) -> f32 {
    return max(c.x * P(base) + c.y * P(base + 1u) + c.z * P(base + 2u) + P(base + 3u), 0.0);
}

fn apply_effect(px: vec4<f32>) -> vec4<f32> {
    let kind = effect.kind.x;
    if (kind == E_IDENTITY || !covers(px.w)) {
        return px;
    }
    var a = px.w;
    let c = px.xyz / a;
    var o = c;
    if (kind == E_FILL) {
        let k = P(3u);
        o = c + (vec3<f32>(P(0u), P(1u), P(2u)) - c) * k;
    } else if (kind == E_TINT) {
        let l = clamp(effect_luma(c), 0.0, 1.0);
        let black = vec3<f32>(P(0u), P(1u), P(2u));
        let white = vec3<f32>(P(4u), P(5u), P(6u));
        let t = black + (white - black) * l;
        let k = P(8u) * (P(3u) + (P(7u) - P(3u)) * l);
        o = c + (t - c) * k;
    } else if (kind == E_LEVELS) {
        let cb = P(25u) > 0.5;
        let cw = P(26u) > 0.5;
        let m = vec3<f32>(level(c.x, 0u, cb, cw), level(c.y, 0u, cb, cw), level(c.z, 0u, cb, cw));
        o = vec3<f32>(level(m.x, 5u, cb, cw), level(m.y, 10u, cb, cw), level(m.z, 15u, cb, cw));
        a = clamp(level(a, 20u, cb, cw), 0.0, 1.0);
    } else if (kind == E_CURVES) {
        o = vec3<f32>(curve_eval(1u, curve_eval(0u, c.x)), curve_eval(2u, curve_eval(0u, c.y)), curve_eval(3u, curve_eval(0u, c.z)));
        a = clamp(curve_eval(4u, a), 0.0, 1.0);
    } else if (kind == E_HUE_SATURATION && !(P(3u) <= 0.5 && fract(P(0u)) == 0.0 && P(1u) == 0.0 && P(2u) == 0.0)) {
        let hsl = rgb_to_hsl(c);
        var out_hsl: vec3<f32>;
        if (P(3u) > 0.5) {
            let cl = P(6u);
            var lift: f32;
            if (cl > 0.0) { lift = 1.0 - hsl.z; } else { lift = hsl.z; }
            out_hsl = vec3<f32>(P(4u), P(5u), clamp(hsl.z + cl * lift, 0.0, 1.0));
        } else {
            let sat = P(1u);
            var s2: f32;
            if (sat >= 0.0) { s2 = hsl.y + (1.0 - hsl.y) * sat * min(hsl.y, 1.0); } else { s2 = hsl.y * (1.0 + sat); }
            let light = P(2u);
            var l2: f32;
            if (light >= 0.0) { l2 = hsl.z + (1.0 - hsl.z) * light; } else { l2 = hsl.z * (1.0 + light); }
            let h2 = hsl.x + P(0u);
            out_hsl = vec3<f32>(h2 - floor(h2), clamp(s2, 0.0, 1.0), l2);
        }
        o = hsl_to_rgb(out_hsl);
    } else if (kind == E_BRIGHTNESS_CONTRAST) {
        if (P(2u) > 0.5) {
            o = max((c + P(0u) - 0.5) * P(3u) + 0.5, vec3<f32>(0.0));
        } else if (!(P(0u) == 0.0 && P(1u) == 0.0)) {
            o = vec3<f32>(bc_modern(c.x, P(4u), P(5u)), bc_modern(c.y, P(4u), P(5u)), bc_modern(c.z, P(4u), P(5u)));
        }
    } else if (kind == E_EXPOSURE) {
        o = vec3<f32>(exposure_channel(c.x), exposure_channel(c.y), exposure_channel(c.z));
    } else if (kind == E_INVERT) {
        let inverted = vec3<f32>(1.0) - c;
        let mask = vec3<f32>(P(0u), P(1u), P(2u)) > vec3<f32>(0.5);
        o = select(c, inverted + (c - inverted) * P(3u), mask);
    } else if (kind == E_POSTERIZE) {
        // Round half up, as the CPU: WGSL's round goes to even.
        let steps = P(0u);
        o = floor(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * steps + vec3<f32>(0.5)) / steps;
    } else if (kind == E_THRESHOLD) {
        o = vec3<f32>(select(0.0, 1.0, effect_luma(c) >= P(0u)));
    } else if (kind == E_VIBRANCE && !(P(0u) == 0.0 && P(1u) == 0.0)) {
        let hsl = rgb_to_hsl(c);
        let s2 = clamp(hsl.y * (1.0 + P(1u)) + P(0u) * (1.0 - hsl.y) * min(hsl.y, 0.5), 0.0, 1.0);
        o = hsl_to_rgb(vec3<f32>(hsl.x, s2, hsl.z));
    } else if (kind == E_TRITONE) {
        let l = clamp(effect_luma(c), 0.0, 1.0);
        let sh = vec3<f32>(P(0u), P(1u), P(2u));
        let md = vec3<f32>(P(4u), P(5u), P(6u));
        let hi = vec3<f32>(P(8u), P(9u), P(10u));
        var t: vec3<f32>;
        if (l < 0.5) {
            t = sh + (md - sh) * (l * 2.0);
        } else {
            t = md + (hi - md) * ((l - 0.5) * 2.0);
        }
        o = c + (t - c) * P(12u);
    } else if (kind == E_CHANNEL_MIXER) {
        if (P(12u) > 0.5) {
            o = vec3<f32>(mixer_row(c, 0u));
        } else {
            o = vec3<f32>(mixer_row(c, 0u), mixer_row(c, 4u), mixer_row(c, 8u));
        }
    } else if (kind == E_COLOR_BALANCE) {
        let l = clamp(effect_luma(c), 0.0, 1.0);
        let ws = clamp(1.0 - l * 2.0, 0.0, 1.0);
        let wh = clamp(l * 2.0 - 1.0, 0.0, 1.0);
        let wm = 1.0 - ws - wh;
        let shift = vec3<f32>(P(0u), P(1u), P(2u)) * ws + vec3<f32>(P(3u), P(4u), P(5u)) * wm + vec3<f32>(P(6u), P(7u), P(8u)) * wh;
        o = max(c + shift * 0.5, vec3<f32>(0.0));
        if (P(9u) > 0.5) {
            let d = effect_luma(c) - effect_luma(o);
            o = max(o + vec3<f32>(d), vec3<f32>(0.0));
        }
    } else if (kind == E_GAMMA_PEDESTAL_GAIN) {
        o = vec3<f32>(gpg_channel(c.x, 0u), gpg_channel(c.y, 3u), gpg_channel(c.z, 6u));
    } else if (kind == E_COLOR_BALANCE_HLS && !(P(0u) == 0.0 && P(1u) == 0.0 && P(2u) == 0.0)) {
        let hsl = rgb_to_hsl(c);
        var l2: f32;
        if (P(1u) > 0.0) { l2 = hsl.z + (1.0 - hsl.z) * P(1u); } else { l2 = hsl.z + hsl.z * P(1u); }
        var s2: f32;
        if (P(2u) > 0.0) { s2 = hsl.y + (1.0 - hsl.y) * P(2u); } else { s2 = hsl.y + hsl.y * P(2u); }
        let h2 = hsl.x + P(0u);
        o = hsl_to_rgb(vec3<f32>(h2 - floor(h2), clamp(s2, 0.0, 1.0), clamp(l2, 0.0, 1.0)));
    } else if (kind == E_BLACK_WHITE) {
        let hsl = rgb_to_hsl(c);
        let hp = hsl.x * 6.0;
        let i = u32(floor(hp)) % 6u;
        let f = hp - floor(hp);
        let w0 = P(i);
        let w1 = P((i + 1u) % 6u);
        let weight = w0 + (w1 - w0) * f;
        let gray = max(effect_luma(c) + (weight - 0.5) * hsl.y * 0.6, 0.0);
        if (P(6u) > 0.5) {
            o = hsl_to_rgb(vec3<f32>(P(7u), P(8u), min(gray, 1.0)));
        } else {
            o = vec3<f32>(gray);
        }
    } else if (kind == E_PHOTO_FILTER && P(3u) != 0.0) {
        let filtered = c * vec3<f32>(P(0u), P(1u), P(2u));
        o = c + (filtered - c) * P(3u);
        if (P(4u) > 0.5) {
            let l0 = effect_luma(c);
            let l1 = max(effect_luma(o), 1e-6);
            o = o * l0 / l1;
        }
    } else if (kind == E_LEAVE_COLOR && P(0u) > 0.0) {
        var distance: f32;
        if (P(6u) > 0.5) {
            let hsl = rgb_to_hsl(c);
            if (hsl.y < 0.02) {
                distance = 1.0;
            } else {
                let x = hsl.x - P(7u) + 0.5;
                distance = abs((x - floor(x)) - 0.5) * 2.0;
            }
        } else {
            let d = c - vec3<f32>(P(1u), P(2u), P(3u));
            distance = sqrt(d.x * d.x + d.y * d.y + d.z * d.z) / SQRT_3;
        }
        var keep: f32;
        if (P(4u) >= 1.0 || distance <= P(4u)) {
            keep = 1.0;
        } else if (P(5u) <= 1e-6) {
            keep = 0.0;
        } else {
            keep = clamp(1.0 - (distance - P(4u)) / P(5u), 0.0, 1.0);
        }
        let g = effect_luma(c);
        let k = P(0u) * (1.0 - keep);
        o = c + (vec3<f32>(g) - c) * k;
    } else if (kind == E_VIDEO_LIMITER) {
        let lim = P(0u);
        let start = P(2u);
        let y = effect_luma(c);
        var m = c;
        if (P(1u) != 1.0) {
            var y2 = min(max(y, 0.0), lim);
            if (max(y, 0.0) > start && lim > start) {
                let r = lim - start;
                y2 = start + r * (1.0 - exp(-(max(y, 0.0) - start) / r));
            }
            m = m + vec3<f32>(y2 - y);
        }
        if (P(1u) != 0.0) {
            let yl = effect_luma(m);
            var t = 1.0;
            for (var k = 0u; k < 3u; k = k + 1u) {
                let v = m[k];
                if (v > lim && v - yl > 1e-6) {
                    t = min(t, (lim - yl) / (v - yl));
                }
                if (v < 0.0 && yl - v > 1e-6) {
                    t = min(t, yl / (yl - v));
                }
            }
            t = clamp(t, 0.0, 1.0);
            if (t < 1.0) {
                m = vec3<f32>(yl) + (m - vec3<f32>(yl)) * t;
            }
        }
        m = clamp(m, vec3<f32>(0.0), vec3<f32>(lim));
        o = m;
        let d = abs(c - m);
        if (P(3u) > 0.5 && (d.x > 1e-4 || d.y > 1e-4 || d.z > 1e-4)) {
            o = vec3<f32>(P(4u), P(5u), P(6u));
        }
    } else if (kind == E_BROADCAST_COLORS) {
        let limit = P(2u);
        let y = 0.299 * c.x + 0.587 * c.y + 0.114 * c.z;
        var chroma: f32;
        if (P(0u) > 0.5) {
            let u = 0.492 * (c.z - y);
            let v = 0.877 * (c.x - y);
            chroma = sqrt(u * u + v * v);
        } else {
            let i = 0.596 * c.x - 0.274 * c.y - 0.322 * c.z;
            let q = 0.211 * c.x - 0.523 * c.y + 0.312 * c.z;
            chroma = sqrt(i * i + q * q);
        }
        let unsafe_ = y + chroma > limit + 1e-5;
        if (P(1u) == 2.0) {
            if (unsafe_) { a = 0.0; }
        } else if (P(1u) == 3.0) {
            if (!unsafe_) { a = 0.0; }
        } else if (unsafe_) {
            if (P(1u) == 1.0) {
                let room = max(limit - y, 0.0);
                var s = 1.0;
                if (chroma > 1e-6) { s = room / chroma; }
                o = vec3<f32>(y) + (c - vec3<f32>(y)) * s;
                if (y > limit) { o = o * (limit / y); }
            } else {
                o = c * (limit / (y + chroma));
            }
        }
    }
    if (kind == E_LINEAR_COLOR_KEY) {
        let key = vec3<f32>(P(0u), P(1u), P(2u));
        let tol = P(3u);
        let soft = P(4u);
        var d: f32;
        let mode = u32(P(5u));
        if (mode == 0u) {
            let dv = c - key;
            d = sqrt(dv.x * dv.x + dv.y * dv.y + dv.z * dv.z) / SQRT_3;
        } else if (mode == 1u) {
            let hsl = rgb_to_hsl(c);
            let dh0 = abs(hsl.x - P(10u));
            d = select(min(dh0, 1.0 - dh0) * 2.0, 1.0, hsl.y < 0.02);
        } else {
            let sum = c.x + c.y + c.z;
            var x = 1.0 / 3.0;
            var y = 1.0 / 3.0;
            if (sum > 1e-6) {
                x = c.x / sum;
                y = c.y / sum;
            }
            d = sqrt((x - P(8u)) * (x - P(8u)) + (y - P(9u)) * (y - P(9u))) / 1.4142135;
        }
        var keyed: f32;
        if (soft > 1e-6) {
            keyed = clamp((d - tol) / soft, 0.0, 1.0);
        } else {
            keyed = select(0.0, 1.0, d > tol);
        }
        var m = keyed;
        if (P(6u) > 0.5) {
            m = 1.0 - keyed;
        }
        let view = u32(P(7u));
        if (view == 2u) {
            o = vec3<f32>(clamp(a * m, 0.0, 1.0));
            a = 1.0;
        } else if (view == 0u) {
            a = a * m;
        }
    } else if (kind == E_REMOVE_COLOR_MATTING) {
        let bg = vec3<f32>(P(0u), P(1u), P(2u));
        var v = max(c - bg * (1.0 - a), vec3<f32>(0.0));
        if (P(3u) > 0.5) {
            v = min(v, vec3<f32>(a));
        }
        o = v / a;
    } else if (kind == E_CHANGE_COLOR) {
        let key = vec3<f32>(P(4u), P(5u), P(6u));
        let tol = P(7u);
        let soft = P(8u);
        var d: f32;
        let mode = u32(P(9u));
        if (mode == 0u) {
            let dv = c - key;
            d = sqrt(dv.x * dv.x + dv.y * dv.y + dv.z * dv.z) / SQRT_3;
        } else if (mode == 1u) {
            let hsl = rgb_to_hsl(c);
            let dh0 = abs(hsl.x - P(11u));
            let dh = min(dh0, 1.0 - dh0) * 2.0;
            d = select(dh, 1.0, hsl.y < 0.02);
        } else {
            let sum = max(c.x + c.y + c.z, 1e-6);
            let dx = c.x / sum - P(12u);
            let dy = c.y / sum - P(13u);
            d = sqrt(dx * dx + dy * dy) * 1.5;
        }
        var m: f32;
        if (d <= tol) {
            m = 1.0;
        } else if (soft <= 1e-6) {
            m = 0.0;
        } else {
            m = clamp(1.0 - (d - tol) / soft, 0.0, 1.0);
        }
        if (P(10u) > 0.5) {
            m = 1.0 - m;
        }
        if (P(0u) > 0.5) {
            o = vec3<f32>(m);
        } else if (m > 0.0) {
            let hsl = rgb_to_hsl(c);
            let h2 = hsl.x + P(1u);
            let h3 = h2 - floor(h2);
            let ds = P(3u);
            let dl = P(2u);
            let s2 = clamp(hsl.y + ds * select(hsl.y, 1.0 - hsl.y, ds > 0.0), 0.0, 1.0);
            let l2 = clamp(hsl.z + dl * select(hsl.z, 1.0 - hsl.z, dl > 0.0), 0.0, 1.0);
            let changed = hsl_to_rgb(vec3<f32>(h3, s2, l2));
            o = c + (changed - c) * m;
        }
    } else if (kind == E_EXTRACT) {
        let ch = u32(P(0u));
        var v = effect_luma(c);
        if (ch == 1u) {
            v = c.x;
        } else if (ch == 2u) {
            v = c.y;
        } else if (ch == 3u) {
            v = c.z;
        } else if (ch == 4u) {
            v = a;
        }
        v = v * 255.0;
        var k = 1.0;
        if (v < P(1u)) {
            k = 0.0;
            if (P(3u) > 0.0) {
                k = clamp(1.0 - (P(1u) - v) / P(3u), 0.0, 1.0);
            }
        } else if (v > P(2u)) {
            k = 0.0;
            if (P(4u) > 0.0) {
                k = clamp(1.0 - (v - P(2u)) / P(4u), 0.0, 1.0);
            }
        }
        if (P(5u) > 0.5) {
            k = 1.0 - k;
        }
        a = a * k;
    } else if (kind == E_CC_COLOR_NEUTRALIZER) {
        let l = clamp(effect_luma(c), 0.0, 1.0);
        let shadow = 1.0 - smoothstep(0.0, 0.5, l);
        let high = smoothstep(0.5, 1.0, l);
        let mid = 1.0 - shadow - high;
        let keep = 1.0 - P(9u) * clamp(1.0 - 4.0 * l * (1.0 - l), 0.0, 1.0);
        for (var k = 0u; k < 3u; k = k + 1u) {
            let push = P(k) * shadow + P(3u + k) * mid + P(6u + k) * high;
            var v = c[k] + push * keep;
            v = 0.5 + (v - 0.5) * (1.0 + P(11u));
            v = v + P(12u) * 0.25 * (1.0 - l) * (1.0 - l) + P(13u) * 0.25 * l * l;
            v = max(v, 0.0);
            o[k] = v + (c[k] - v) * P(10u);
        }
    } else if (kind == E_UNMULT) {
        let white = P(0u) > 0.5;
        var d = max(c.x, max(c.y, c.z));
        var start = P(1u);
        if (white) {
            d = 1.0 - min(c.x, min(c.y, c.z));
            start = 1.0 - P(1u);
        }
        d = clamp(d, 0.0, 1.0);
        let width = P(2u) * (1.0 - start);
        var m = 0.0;
        if (width > 1e-6) {
            m = clamp((d - start) / width, 0.0, 1.0);
        } else if (d > start) {
            m = 1.0;
        }
        if (m <= 1e-6) {
            a = 0.0;
        } else {
            var v = c;
            if (P(3u) > 0.5) {
                let bg = select(0.0, 1.0, white);
                v = (c - vec3<f32>(bg * (1.0 - m))) / m;
            }
            if (P(4u) > 0.5) {
                v = clamp(v, vec3<f32>(0.0), vec3<f32>(1.0));
            }
            o = v;
            a = a * m;
        }
    } else if (kind == E_ARITHMETIC) {
        let op = u32(P(0u));
        let clip = P(4u) > 0.5;
        var res = vec3<f32>(0.0);
        for (var i = 0u; i < 3u; i = i + 1u) {
            let v = c[i];
            let kv = P(1u + i);
            let iv = u32(round_half_up(clamp(v, 0.0, 1.0) * 255.0));
            let ik = u32(round_half_up(kv * 255.0));
            var r = 0.0;
            if (op == 0u) { r = f32(iv & ik) / 255.0; }
            else if (op == 1u) { r = f32(iv | ik) / 255.0; }
            else if (op == 2u) { r = f32(iv ^ ik) / 255.0; }
            else if (op == 3u) { r = v + kv; }
            else if (op == 4u) { r = v - kv; }
            else if (op == 5u) { r = abs(v - kv); }
            else if (op == 6u) { r = min(v, kv); }
            else if (op == 7u) { r = max(v, kv); }
            else if (op == 8u) { r = select(v, 0.0, v > kv); }
            else if (op == 9u) { r = select(v, 0.0, v < kv); }
            else if (op == 10u) { r = select(0.0, 1.0, v >= kv); }
            else if (op == 11u) { r = v * kv; }
            else { r = 1.0 - (1.0 - v) * (1.0 - kv); }
            if (clip) { res[i] = clamp(r, 0.0, 1.0); } else { res[i] = max(r, 0.0); }
        }
        o = res;
    } else if (kind == E_COLOR_DIFFERENCE_KEY) {
        var display = c;
        if (P(2u) > 0.5) {
            display = vec3<f32>(srgb_encode(c.x), srgb_encode(c.y), srgb_encode(c.z));
        }
        var lin = display;
        if (P(1u) > 0.5) {
            let d = clamp(display, vec3<f32>(0.0), vec3<f32>(1.0));
            lin = vec3<f32>(srgb_decode(d.x), srgb_decode(d.y), srgb_decode(d.z));
        }
        let pi = u32(P(3u));
        let o1 = u32(P(4u));
        let o2 = u32(P(5u));
        let ua = 1.0 - clamp((lin[pi] - lin[o1]) / P(6u), 0.0, 1.0);
        let ub = 1.0 - clamp((lin[pi] - lin[o2]) / P(7u), 0.0, 1.0);
        let ca = matte_levels(ua, P(8u), P(9u), P(10u), P(11u), P(12u));
        let cb = matte_levels(ub, P(13u), P(14u), P(15u), P(16u), P(17u));
        let um = max(ua, ub);
        let cm = matte_levels(max(ca, cb), P(18u), P(19u), P(20u), 0.0, 255.0);
        let stage = u32(P(0u));
        var shown = -1.0;
        if (stage == 1u) { shown = ua; }
        else if (stage == 2u) { shown = ca; }
        else if (stage == 3u) { shown = ub; }
        else if (stage == 4u) { shown = cb; }
        else if (stage == 5u) { shown = um; }
        else if (stage == 6u) { shown = cm; }
        if (shown >= 0.0) {
            o = vec3<f32>(shown * a);
            a = 1.0;
        } else {
            a = a * cm;
        }
    } else if (kind == E_SELECTIVE_COLOR) {
        let relative = P(0u) > 0.5;
        let w = selective_weights(c);
        var res = c;
        for (var r = 0u; r < 9u; r = r + 1u) {
            if (w[r] > 0.0) {
                let base = 1u + 4u * r;
                let black = P(base + 3u);
                for (var i = 0u; i < 3u; i = i + 1u) {
                    var delta = P(base + i) + black;
                    if (relative) { delta = delta * max(1.0 - c[i], 0.0); }
                    res[i] = res[i] - w[r] * delta;
                }
            }
        }
        o = max(res, vec3<f32>(0.0));
    } else if (kind == E_COLOR_RANGE) {
        var measured = c;
        if (P(8u) > 0.5) {
            measured = vec3<f32>(srgb_encode(c.x), srgb_encode(c.y), srgb_encode(c.z));
        }
        let v = range_components(u32(P(1u)), measured);
        var out = 0.0;
        out = max(out, max(P(2u) - v.x, v.x - P(3u)));
        out = max(out, max(P(4u) - v.y, v.y - P(5u)));
        out = max(out, max(P(6u) - v.z, v.z - P(7u)));
        var m = 1.0;
        if (out <= 0.0) {
            m = 0.0;
        } else if (P(0u) > 0.0) {
            m = clamp(out / P(0u), 0.0, 1.0);
        }
        a = a * m;
    } else if (kind == E_SPILL_SUPPRESSOR) {
        let amount = P(3u);
        if (P(4u) > 0.5) {
            let mean = (c.x + c.y + c.z) / 3.0;
            let dir = vec3<f32>(P(5u), P(6u), P(7u));
            let along = (c.x - mean) * dir.x + (c.y - mean) * dir.y + (c.z - mean) * dir.z;
            if (along > 0.0) {
                o = c - dir * (along * amount);
            }
        } else {
            let strong = u32(P(0u));
            let first = u32(P(1u));
            let second = u32(P(2u));
            let spill = max(c[strong] - max(c[first], c[second]), 0.0);
            // Only the strong channel moves. A select on constant indices, not a store through
            // c[strong]: FXC (DX12) cannot store through a non-constant vector index (X3500).
            o = select(
                c,
                c - vec3<f32>(spill * amount),
                vec3<bool>(strong == 0u, strong == 1u, strong == 2u),
            );
        }
    } else if (kind == E_SHIFT_CHANNELS) {
        let hsl = rgb_to_hsl(c);
        var picked = vec4<f32>(0.0);
        for (var k = 0u; k < 4u; k = k + 1u) {
            let code = u32(P(k));
            var v = 0.0;
            if (code == 0u) {
                v = a;
            } else if (code == 1u) {
                v = c.x;
            } else if (code == 2u) {
                v = c.y;
            } else if (code == 3u) {
                v = c.z;
            } else if (code == 4u) {
                v = effect_luma(c);
            } else if (code == 5u) {
                v = hsl.x;
            } else if (code == 6u) {
                v = hsl.z;
            } else if (code == 7u) {
                v = hsl.y;
            } else if (code == 8u) {
                v = 1.0;
            } else if (code == 9u) {
                v = 0.5;
            }
            picked[k] = v;
        }
        o = picked.xyz;
        a = clamp(picked.w, 0.0, 1.0);
    } else if (kind == E_CC_TONER) {
        let n = u32(P(15u));
        let t = clamp(effect_luma(c), 0.0, 1.0) * f32(n);
        let k = min(u32(floor(t)), n - 1u);
        let f = t - f32(k);
        let lo = vec3<f32>(P(3u * k), P(3u * k + 1u), P(3u * k + 2u));
        let hi = vec3<f32>(P(3u * k + 3u), P(3u * k + 4u), P(3u * k + 5u));
        let tone = lo + (hi - lo) * f;
        o = tone + (c - tone) * P(16u);
    } else if (kind == E_CC_COLOR_OFFSET && (P(0u) != 0.0 || P(1u) != 0.0 || P(2u) != 0.0)) {
        for (var k = 0u; k < 3u; k = k + 1u) {
            if (P(k) == 0.0) {
                continue;
            }
            let x = c[k] + P(k);
            var v = x;
            if (x > 1.0) {
                if (P(3u) == 1.0) {
                    v = max(2.0 - x, 0.0);
                } else if (P(3u) == 2.0) {
                    v = select(1.0, 0.0, x - 1.0 < 0.5);
                } else {
                    v = x - floor(x);
                }
            }
            o[k] = v;
        }
    } else if (kind == E_CC_THRESHOLD) {
        let t = P(0u);
        let inv = P(2u) > 0.5;
        let blend = P(3u);
        var m = vec3<f32>(0.0);
        var na = a;
        let mode = u32(P(1u));
        if (mode == 1u) {
            m = vec3<f32>(
                select(0.0, 1.0, (c.x >= t) != inv),
                select(0.0, 1.0, (c.y >= t) != inv),
                select(0.0, 1.0, (c.z >= t) != inv),
            );
        } else if (mode == 2u) {
            m = vec3<f32>(select(0.0, 1.0, (rgb_to_hsl(c).y >= t) != inv));
        } else if (mode == 3u) {
            m = c;
            na = select(0.0, 1.0, (a >= t) != inv);
        } else {
            m = vec3<f32>(select(0.0, 1.0, (effect_luma(c) >= t) != inv));
        }
        o = m + (c - m) * blend;
        a = na + (a - na) * blend;
    } else if (kind == E_CC_THRESHOLD_RGB) {
        let blend = P(6u);
        let m = vec3<f32>(
            select(0.0, 1.0, (c.x >= P(0u)) != (P(3u) > 0.5)),
            select(0.0, 1.0, (c.y >= P(1u)) != (P(4u) > 0.5)),
            select(0.0, 1.0, (c.z >= P(2u)) != (P(5u) > 0.5)),
        );
        o = m + (c - m) * blend;
    }
    let r = vec4<f32>(bound(o.x * a), bound(o.y * a), bound(o.z * a), bound(a));
    if (!covers(r.w)) {
        return vec4<f32>(0.0);
    }
    return r;
}

// ---------------------------------------------------------------- 3.22 spatial and coordinate passes
// The twin of src/effect_chain.rs.

fn finite4(v: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(bound(v.x), bound(v.y), bound(v.z), clamp(bound(v.w), 0.0, 1.0));
}

fn fx_get(p: vec2<i32>) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(effect_src));
    if (any(p < vec2<i32>(0)) || any(p >= size)) {
        return vec4<f32>(0.0);
    }
    return textureLoad(effect_src, p, 0);
}

// The compositor's sampler: centres at +0.5, transparent outside.
fn fx_sample(x: f32, y: f32) -> vec4<f32> {
    let f = vec2<f32>(x, y) - vec2<f32>(0.5);
    let lo = floor(f);
    let t = f - lo;
    let q = vec2<i32>(lo);
    let a = fx_get(q);
    let b = fx_get(q + vec2<i32>(1, 0));
    let c = fx_get(q + vec2<i32>(0, 1));
    let d = fx_get(q + vec2<i32>(1, 1));
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

// The wipes' trigonometry, the same polynomials as src/effect_chain.rs.
fn fx_atan(z: f32) -> f32 {
    let z2 = z * z;
    return z * (0.99997726 + z2 * (-0.33262347 + z2 * (0.19354346 + z2 * (-0.11643287 + z2 * (0.05265332 + z2 * -0.0117212)))));
}

fn fx_atan2(y: f32, x: f32) -> f32 {
    let ax = abs(x);
    let ay = abs(y);
    if (ax == 0.0 && ay == 0.0) { return 0.0; }
    var a: f32;
    if (ax >= ay) { a = fx_atan(ay / ax); } else { a = PI * 0.5 - fx_atan(ax / ay); }
    if (x < 0.0) { a = PI - a; }
    if (y < 0.0) { a = -a; }
    return a;
}

fn fx_sin(x: f32) -> f32 {
    let k = floor(x / PI + 0.5);
    let r = x - k * PI;
    let r2 = r * r;
    let s = r * (1.0 + r2 * (-1.0 / 6.0 + r2 * (1.0 / 120.0 + r2 * (-1.0 / 5040.0 + r2 * (1.0 / 362880.0 + r2 * (-1.0 / 39916800.0))))));
    if ((i32(k) % 2) != 0) { return -s; }
    return s;
}

fn fx_cos(x: f32) -> f32 {
    return fx_sin(x + PI * 0.5);
}

fn modulo(x: f32, m: f32) -> f32 {
    return x - floor(x / m) * m;
}

fn coordinate_effect(kind: u32, px: vec4<f32>, l: vec2<f32>) -> vec4<f32> {
    if (kind == E_RAMP) {
        if (!covers(px.w)) { return px; }
        let d = vec2<f32>(P(10u) - P(8u), P(11u) - P(9u));
        let v = vec2<f32>(l.x - P(8u), l.y - P(9u));
        var t: f32;
        if (P(12u) > 0.5) {
            t = sqrt(v.x * v.x + v.y * v.y) / max(sqrt(d.x * d.x + d.y * d.y), 1e-6);
        } else {
            t = (v.x * d.x + v.y * d.y) / max(d.x * d.x + d.y * d.y, 1e-12);
        }
        t = clamp(t, 0.0, 1.0);
        let a = px.w;
        let c = px.xyz / a;
        let ramp = vec3<f32>(mix(P(0u), P(4u), t), mix(P(1u), P(5u), t), mix(P(2u), P(6u), t));
        let k = (1.0 - P(13u)) * mix(P(3u), P(7u), t);
        let o = c + (ramp - c) * k;
        return finite4(vec4<f32>(o * a, a));
    }
    if (kind == E_LINEAR_WIPE) {
        let d = l.x * P(0u) + l.y * P(1u);
        return finite4(px * clamp((d - P(2u)) / P(3u) + 0.5, 0.0, 1.0));
    }
    if (kind == E_RADIAL_WIPE) {
        let v = vec2<f32>(l.x - P(0u), l.y - P(1u));
        let r = sqrt(v.x * v.x + v.y * v.y);
        let deg = fx_atan2(v.x, -v.y) * (180.0 / PI) - P(2u);
        var a = modulo(deg, 360.0);
        if (P(5u) > 1.5) {
            a = min(a, 360.0 - a);
        } else if (P(5u) > 0.5) {
            a = 360.0 - a;
        }
        let arc = (a - P(3u)) * (PI / 180.0) * r;
        return finite4(px * clamp(arc / P(4u) + 0.5, 0.0, 1.0));
    }
    if (kind == E_IRIS_WIPE) {
        let v = vec2<f32>(l.x - P(0u), l.y - P(1u));
        let d = sqrt(v.x * v.x + v.y * v.y);
        let n = P(2u);
        let step = PI / n;
        let th = modulo(fx_atan2(v.x, -v.y) - P(5u), 2.0 * PI);
        let k = min(floor(th / step), 2.0 * n - 1.0);
        let a0 = k * step;
        let a1 = (k + 1.0) * step;
        var r0 = P(3u);
        var r1 = P(4u);
        if ((i32(k) % 2) != 0) {
            r0 = P(4u);
            r1 = P(3u);
        }
        let p0 = vec2<f32>(r0 * fx_sin(a0), -r0 * fx_cos(a0));
        let p1 = vec2<f32>(r1 * fx_sin(a1), -r1 * fx_cos(a1));
        let u = vec2<f32>(fx_sin(th), -fx_cos(th));
        let e = p1 - p0;
        let denom = u.x * e.y - u.y * e.x;
        var radius = r0;
        if (abs(denom) >= 1e-12) {
            radius = (p0.x * p1.y - p0.y * p1.x) / denom;
        }
        return finite4(px * clamp((d - radius) / P(6u) + 0.5, 0.0, 1.0));
    }
    if (kind == E_GLOW_BRIGHT) {
        if (!covers(px.w)) { return vec4<f32>(0.0); }
        let c = px.xyz / px.w;
        let lum = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
        let k = clamp((lum - P(0u)) / max(1.0 - P(0u), 1e-3), 0.0, 1.0);
        return finite4(px * k);
    }
    return apply_effect(px);
}

@compute @workgroup_size(16, 16)
fn effect_step(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= textureDimensions(effect_out))) { return; }
    let kind = effect.kind.x;
    let q = vec2<i32>(id.xy);
    let px = textureLoad(effect_src, q, 0);
    var out = px;
    if (kind == E_IDENTITY || kind == E_SAVE) {
        out = px;
    } else if (kind == E_DIRECTIONAL) {
        let n = i32(P(3u));
        var acc = vec4<f32>(0.0);
        for (var i = 0; i < n; i++) {
            let t = (f32(i) / f32(n - 1) - 0.5) * P(2u);
            acc += fx_sample(f32(q.x) + 0.5 + P(0u) * t, f32(q.y) + 0.5 + P(1u) * t);
        }
        out = finite4(acc * (1.0 / f32(n)));
    } else if (kind == E_MIX) {
        // The effect's output where its masks cover, its input (the aux target) elsewhere.
        let o = textureLoad(effect_aux, q, 0);
        let m = clamp(textureLoad(effect_weights, q, 0).w, 0.0, 1.0);
        out = finite4(o * (1.0 - m) + px * m);
    } else if (kind == E_GLOW_COMBINE) {
        let o = textureLoad(effect_aux, q, 0);
        let g = px * P(0u);
        out = finite4(vec4<f32>(o.xyz + g.xyz, min(o.w + g.w * (1.0 - o.w), 1.0)));
    } else if (kind == E_SHADOW_MAKE) {
        let a = fx_sample(f32(q.x) + 0.5 - P(5u), f32(q.y) + 0.5 - P(6u)).w * P(4u) * P(3u);
        out = finite4(vec4<f32>(P(0u) * a, P(1u) * a, P(2u) * a, a));
    } else if (kind == E_SHADOW_COMBINE) {
        if (P(0u) > 0.5) {
            out = px;
        } else {
            let o = textureLoad(effect_aux, q, 0);
            let k = 1.0 - o.w;
            out = finite4(vec4<f32>(o.xyz + px.xyz * k, o.w + px.w * k));
        }
    } else {
        let l = vec2<f32>(P(ORIGIN_SLOT) + f32(q.x) + 0.5, P(ORIGIN_SLOT + 1u) + f32(q.y) + 0.5);
        out = coordinate_effect(kind, px, l);
    }
    if (kind != E_IDENTITY && kind != E_SAVE) {
        out = store_depth(out);
    }
    textureStore(effect_out, q, out);
}

fn line_get(horizontal: bool, line: i32, i: i32, n: i32, repeat: bool) -> vec4<f32> {
    var j = i;
    if (i < 0 || i >= n) {
        if (!repeat) {
            return vec4<f32>(0.0);
        }
        j = clamp(i, 0, n - 1);
    }
    if (horizontal) {
        return textureLoad(effect_src, vec2<i32>(j, line), 0);
    }
    return textureLoad(effect_src, vec2<i32>(line, j), 0);
}

// One box pass: one invocation per row (horizontal) or column, one running
// sum along it, in the CPU reference order of operations.
@compute @workgroup_size(64, 1)
fn effect_line(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(effect_out));
    let horizontal = P(2u) > 0.5;
    var lines = dims.x;
    var n = dims.y;
    if (horizontal) {
        lines = dims.y;
        n = dims.x;
    }
    let line = i32(id.x);
    if (line >= lines) { return; }
    let kind = effect.kind.x;
    if (kind != E_BOX) {
        for (var i = 0; i < n; i++) {
            var q = vec2<i32>(line, i);
            if (horizontal) { q = vec2<i32>(i, line); }
            textureStore(effect_out, q, textureLoad(effect_src, q, 0));
        }
        return;
    }
    let r = i32(P(0u));
    let repeat = P(1u) > 0.5;
    let norm = 1.0 / f32(2 * r + 1);
    var acc = vec4<f32>(0.0);
    for (var i = -r; i <= r; i++) {
        acc = acc + line_get(horizontal, line, i, n, repeat);
    }
    for (var i = 0; i < n; i++) {
        var q = vec2<i32>(line, i);
        if (horizontal) { q = vec2<i32>(i, line); }
        textureStore(effect_out, q, store_depth(acc * norm));
        let add = line_get(horizontal, line, i + r + 1, n, repeat);
        let sub = line_get(horizontal, line, i - r, n, repeat);
        acc = acc + (add - sub);
    }
}
