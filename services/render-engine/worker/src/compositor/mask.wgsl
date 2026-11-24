// 3.19: layer masks on the GPU at prepare. The CPU twin is
// `rasterise::mask::mask_alpha`: the same steps, the same f32 operations and
// the same Gaussian weights.

struct MaskParams {
    // Width, height, the layer buffer's row stride, the mode (0 none, 1 add,
    // 2 subtract, 3 intersect, 4 difference, 5 lighten, 6 darken).
    size: vec4<u32>,
    // grow, has band, inverted, feather radius.
    flags: vec4<u32>,
    // opacity, initial alpha.
    values: vec4<f32>,
    // The layer's own width and height, and where its first texel sits in the padded window the passes
    // work over (the feather's reach on each side, so a mask that goes past the layer feathers as it does in the plane).
    layer: vec4<u32>,
}

@group(0) @binding(0) var fill_cov: texture_2d<f32>;
@group(0) @binding(1) var band_cov: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> cov: array<f32>;
@group(0) @binding(3) var<storage, read_write> tmp: array<f32>;
@group(0) @binding(4) var<storage, read_write> alpha: array<f32>;
@group(0) @binding(5) var<storage, read_write> layer: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> weights: array<f32>;
@group(0) @binding(7) var<uniform> p: MaskParams;

fn index(id: vec3<u32>) -> u32 {
    return id.y * p.size.x + id.x;
}

fn outside(id: vec3<u32>) -> bool {
    return any(id.xy >= p.size.xy);
}

@compute @workgroup_size(16, 16)
fn init(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    alpha[index(id)] = p.values.y;
}

@compute @workgroup_size(16, 16)
fn shape(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let f = textureLoad(fill_cov, vec2<i32>(id.xy), 0).a;
    var c = f;
    if (p.flags.y != 0u) {
        let b = textureLoad(band_cov, vec2<i32>(id.xy), 0).a;
        if (p.flags.x != 0u) {
            c = f + b - f * b;
        } else {
            c = f * (1.0 - b);
        }
    }
    cov[index(id)] = c;
}

fn blur_at(id: vec3<u32>, horizontal: bool) -> f32 {
    let radius = i32(p.flags.w);
    var sum = 0.0;
    for (var k = 0; k <= 2 * radius; k++) {
        let d = k - radius;
        var s = vec2<i32>(id.xy);
        if (horizontal) { s.x += d; } else { s.y += d; }
        if (s.x >= 0 && s.y >= 0 && s.x < i32(p.size.x) && s.y < i32(p.size.y)) {
            var value = 0.0;
            if (horizontal) {
                value = cov[u32(s.y) * p.size.x + u32(s.x)];
            } else {
                value = tmp[u32(s.y) * p.size.x + u32(s.x)];
            }
            sum += weights[k] * value;
        }
    }
    return sum;
}

@compute @workgroup_size(16, 16)
fn blur_h(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    tmp[index(id)] = blur_at(id, true);
}

@compute @workgroup_size(16, 16)
fn blur_v(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    cov[index(id)] = blur_at(id, false);
}

@compute @workgroup_size(16, 16)
fn fold(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let i = index(id);
    var c = cov[i];
    if (p.flags.z != 0u) { c = 1.0 - c; }
    c = c * p.values.x;
    let a = alpha[i];
    var out = a;
    switch p.size.w {
        case 1u { out = a + c - a * c; }
        case 2u { out = a * (1.0 - c); }
        case 3u { out = a * c; }
        case 4u { out = abs(a - c); }
        case 5u { out = max(a, c); }
        case 6u { out = min(a, c); }
        default { out = a; }
    }
    alpha[i] = out;
}

@compute @workgroup_size(16, 16)
fn apply(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= p.layer.xy)) { return; }
    let l = id.y * p.size.z + id.x;
    layer[l] = layer[l] * alpha[(id.y + p.layer.w) * p.size.x + id.x + p.layer.z];
}

// 11.108: the variable feather. `weights` holds `[segment count, point count, total length, expansion, smooth, window origin x, y, 0]`, the
// flattened segments (x0, y0, x1, y1, arc at x0) and the feather points (arc, radius, tension): the same data and the same steps as
// `rasterise::variable_feather::VariableFeather::coverage_at`, which is the CPU twin.
fn smooth_step(w: f32) -> f32 {
    return w * w * (3.0 - 2.0 * w);
}

fn feather_radius(s: f32, nseg: u32, npts: u32, total: f32) -> f32 {
    let base = 8u + nseg * 5u;
    if (npts == 1u) { return weights[base + 1u]; }
    var j = npts - 1u;
    for (var k = 0u; k < npts; k++) {
        if (weights[base + k * 3u] <= s) { j = k; }
    }
    let next = (j + 1u) % npts;
    var a0 = weights[base + j * 3u];
    if (a0 > s) { a0 = a0 - total; }
    var a1 = weights[base + next * 3u];
    if (next <= j) { a1 = a1 + total; }
    let span = a1 - a0;
    var w = 0.0;
    if (span > 1e-9) { w = clamp((s - a0) / span, 0.0, 1.0); }
    let tension = weights[base + j * 3u + 2u];
    let blended = w + (smooth_step(w) - w) * tension;
    let r0 = weights[base + j * 3u + 1u];
    let r1 = weights[base + next * 3u + 1u];
    return r0 + (r1 - r0) * blended;
}

@compute @workgroup_size(16, 16)
fn variable(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let nseg = u32(weights[0]);
    let npts = u32(weights[1]);
    let total = weights[2];
    let expansion = weights[3];
    let smooth_falloff = weights[4] > 0.5;
    let px = weights[5] + f32(id.x) + 0.5;
    let py = weights[6] + f32(id.y) + 0.5;
    var best = 3.4e38;
    var arc = 0.0;
    var winding = 0;
    for (var i = 0u; i < nseg; i++) {
        let o = 8u + i * 5u;
        let x0 = weights[o];
        let y0 = weights[o + 1u];
        let x1 = weights[o + 2u];
        let y1 = weights[o + 3u];
        let ex = x1 - x0;
        let ey = y1 - y0;
        let len2 = ex * ex + ey * ey;
        var u = 0.0;
        if (len2 > 0.0) { u = clamp(((px - x0) * ex + (py - y0) * ey) / len2, 0.0, 1.0); }
        let dx = px - (x0 + ex * u);
        let dy = py - (y0 + ey * u);
        let d2 = dx * dx + dy * dy;
        if (d2 < best) {
            best = d2;
            arc = weights[o + 4u] + u * sqrt(len2);
        }
        let cross = ex * (py - y0) - ey * (px - x0);
        if (y0 <= py) {
            if (y1 > py && cross > 0.0) { winding += 1; }
        } else {
            if (y1 <= py && cross < 0.0) { winding -= 1; }
        }
    }
    var signed_distance = -sqrt(best);
    if (winding != 0) { signed_distance = sqrt(best); }
    signed_distance = signed_distance + expansion;
    let r = feather_radius(arc, nseg, npts, total);
    let r_out = max(r, 0.0);
    let r_in = max(-r, 0.0);
    let width = r_in + r_out;
    var c = 0.0;
    if (width < 1e-4) {
        c = clamp(signed_distance + 0.5, 0.0, 1.0);
    } else {
        let u = clamp((signed_distance + r_out) / width, 0.0, 1.0);
        if (smooth_falloff) { c = smooth_step(u); } else { c = u; }
    }
    cov[index(id)] = c;
}
