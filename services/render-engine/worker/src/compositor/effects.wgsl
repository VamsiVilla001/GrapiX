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
const LUT_N: u32 = 1024u;
const CURVE_BLOCK: u32 = 1031u;

struct EffectParams {
    kind: vec4<u32>,
    p: array<vec4<f32>, 8>,
}

@group(0) @binding(0) var effect_src: texture_2d<f32>;
@group(0) @binding(1) var effect_out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> effect: EffectParams;
@group(0) @binding(3) var<storage, read> curve: array<f32>;

fn P(i: u32) -> f32 {
    return effect.p[i / 4u][i % 4u];
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
    }
    let r = vec4<f32>(bound(o.x * a), bound(o.y * a), bound(o.z * a), bound(a));
    if (!covers(r.w)) {
        return vec4<f32>(0.0);
    }
    return r;
}

@compute @workgroup_size(16, 16)
fn effect_step(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= textureDimensions(effect_out))) { return; }
    let px = textureLoad(effect_src, vec2<i32>(id.xy), 0);
    textureStore(effect_out, vec2<i32>(id.xy), apply_effect(px));
}
