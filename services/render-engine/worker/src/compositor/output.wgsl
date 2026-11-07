// GrapiX output pass (3.21). Reads the composited working-space tile and
// writes each output surface's RGBA8 bytes exactly once: Program through
// Rec.709, Preview through sRGB (the 3.15 output transforms).
//
// The transfer curve is not evaluated here. The CPU colour authority
// (`WorkingRgba::encode`) defines, for each output and working space, the
// smallest f32 straight value that reaches each code value; this pass finds
// the code by searching those thresholds. A float search finds a candidate,
// then the code is settled by an exact integer comparison of the
// correctly-rounded quotient `r / a` against the neighbouring thresholds. GPU
// float division (2.5 ULP in WGSL) and compiler contraction therefore cannot
// move a code value: the result is byte-identical to the CPU encode.

struct OutParams {
    // Core rectangle of this tile in stage pixels, and its offset inside the
    // tile's render bounds.
    core_origin: vec2<u32>,
    core_size: vec2<u32>,
    src_offset: vec2<u32>,
    stage_width: u32,
    _pad: u32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
// [0, 256): Program (Rec.709) RGB thresholds; [256, 512): Preview (sRGB) RGB
// thresholds; [512, 768): alpha thresholds. Entry k is the bit pattern of the
// smallest non-negative f32 whose code is >= k. Entry 0 is unused.
@group(0) @binding(1) var<storage, read> tables: array<u32, 768>;
@group(0) @binding(2) var<storage, read_write> program_out: array<u32>;
@group(0) @binding(3) var<storage, read_write> preview_out: array<u32>;
@group(0) @binding(4) var<uniform> params: OutParams;

const EXP_MASK: u32 = 0x7f800000u;
const FRAC_MASK: u32 = 0x007fffffu;

// A non-negative finite f32 as m * 2^e, m an integer below 2^24.
struct Dyadic { m: u32, e: i32, }

fn decompose(bits: u32) -> Dyadic {
    let raw = (bits >> 23u) & 0xffu;
    let frac = bits & FRAC_MASK;
    if (raw == 0u) {
        return Dyadic(frac, -149);
    }
    return Dyadic(frac | 0x00800000u, i32(raw) - 150);
}

// 32 x 32 -> 64-bit product, as (lo, hi), from 16-bit limbs. Exact.
fn mul64(a: u32, b: u32) -> vec2<u32> {
    let a0 = a & 0xffffu;
    let a1 = a >> 16u;
    let b0 = b & 0xffffu;
    let b1 = b >> 16u;
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 16u) + (p01 & 0xffffu) + (p10 & 0xffffu);
    let lo = (p00 & 0xffffu) | (mid << 16u);
    let hi = p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u);
    return vec2<u32>(lo, hi);
}

fn bitlen64(v: vec2<u32>) -> i32 {
    if (v.y != 0u) {
        return 64 - i32(countLeadingZeros(v.y));
    }
    return 32 - i32(countLeadingZeros(v.x));
}

// Shift left by n, 0 <= n < 64. Callers only shift values that still fit.
fn shl64(v: vec2<u32>, n: i32) -> vec2<u32> {
    if (n == 0) {
        return v;
    }
    if (n >= 32) {
        return vec2<u32>(0u, v.x << u32(n - 32));
    }
    let un = u32(n);
    return vec2<u32>(v.x << un, (v.y << un) | (v.x >> (32u - un)));
}

// -1, 0 or 1 for x < y, x == y, x > y.
fn cmp64(x: vec2<u32>, y: vec2<u32>) -> i32 {
    if (x.y != y.y) {
        return select(-1, 1, x.y > y.y);
    }
    if (x.x != y.x) {
        return select(-1, 1, x.x > y.x);
    }
    return 0;
}

// Does the correctly rounded f32 quotient r / a reach threshold t?
// r, a: f32 bit patterns of the premultiplied channel and alpha, a != 0.
// t: threshold bit pattern, positive and finite.
fn quotient_reaches(r_bits: u32, a_bits: u32, t: u32) -> bool {
    let r_neg = (r_bits >> 31u) == 1u;
    let a_neg = (a_bits >> 31u) == 1u;
    let ur = r_bits & 0x7fffffffu;
    let ua = a_bits & 0x7fffffffu;
    // NaN anywhere gives NaN, which the CPU quantises to 0.
    if (ur > EXP_MASK || ua > EXP_MASK) { return false; }
    if (ur == 0u) { return false; }
    if (r_neg != a_neg) { return false; }
    if (ua == EXP_MASK) { return false; }      // finite / inf = 0; inf / inf = NaN
    if (ur == EXP_MASK) { return true; }       // inf / finite = inf
    if (ua == 0u) { return true; }             // x / 0 = inf (x != 0)
    // fl(r / a) >= t  <=>  r / a > (p + t) / 2, or equal and t's mantissa is
    // even (round half to even), where p is t's predecessor.
    // Compare X = 2r = mr * 2^(er + 1) with Y = (p + t) * a = s * ma * 2^(e0 + ea).
    let rd = decompose(ur);
    let ad = decompose(ua);
    let td = decompose(t);
    let pd = decompose(t - 1u);
    let e0 = min(td.e, pd.e);
    let s = (pd.m << u32(pd.e - e0)) + (td.m << u32(td.e - e0));
    let y = mul64(s, ad.m);
    let x = vec2<u32>(rd.m, 0u);
    let d = (rd.e + 1) - (e0 + ad.e);   // X = mr * 2^d, Y = y, in units of 2^(e0 + ea)
    var order = 0;
    if (d >= 0) {
        let lx = bitlen64(x) + d;
        let ly = bitlen64(y);
        if (lx != ly) {
            order = select(-1, 1, lx > ly);
        } else {
            order = cmp64(shl64(x, d), y);
        }
    } else {
        let lx = bitlen64(x);
        let ly = bitlen64(y) - d;
        if (lx != ly) {
            order = select(-1, 1, lx > ly);
        } else {
            order = cmp64(x, shl64(y, -d));
        }
    }
    if (order > 0) { return true; }
    if (order < 0) { return false; }
    return (t & 1u) == 0u;
}

// Number of thresholds k in 1..=255 with value <= x, by float comparison.
fn search(base: u32, x: f32) -> u32 {
    var lo = 0u;   // invariant: code >= lo
    var hi = 256u; // invariant: code < hi
    for (var i = 0u; i < 8u; i = i + 1u) {
        let mid = (lo + hi) / 2u;
        if (mid == 0u) { break; }
        if (x >= bitcast<f32>(tables[base + mid])) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

fn channel_code(base: u32, r: f32, a: f32) -> u32 {
    let r_bits = bitcast<u32>(r);
    let a_bits = bitcast<u32>(a);
    // A transparent pixel has no straight colour; the CPU encodes it as 0.
    if ((a_bits & 0x7fffffffu) == 0u) {
        return 0u;
    }
    var code = search(base, r / a);
    for (var i = 0u; i < 4u; i = i + 1u) {
        if (code < 255u && quotient_reaches(r_bits, a_bits, tables[base + code + 1u])) {
            code = code + 1u;
        }
    }
    for (var i = 0u; i < 4u; i = i + 1u) {
        if (code > 0u && !quotient_reaches(r_bits, a_bits, tables[base + code])) {
            code = code - 1u;
        }
    }
    return code;
}

fn alpha_code(a: f32) -> u32 {
    // Straight comparison is exact: alpha is quantised without division.
    return search(512u, a);
}

fn pack(base: u32, c: vec4<f32>, alpha: u32) -> u32 {
    return channel_code(base, c.r, c.a)
        | (channel_code(base, c.g, c.a) << 8u)
        | (channel_code(base, c.b, c.a) << 16u)
        | (alpha << 24u);
}

@compute @workgroup_size(16, 16)
fn encode(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= params.core_size)) { return; }
    let c = textureLoad(src, vec2<i32>(id.xy + params.src_offset), 0);
    let stage = id.xy + params.core_origin;
    let index = stage.y * params.stage_width + stage.x;
    let alpha = alpha_code(c.a);
    program_out[index] = pack(0u, c, alpha);
    preview_out[index] = pack(256u, c, alpha);
}
