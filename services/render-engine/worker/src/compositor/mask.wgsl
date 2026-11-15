// 3.19: layer masks on the GPU at prepare. The CPU twin is
// `rasterise::mask::mask_alpha`: the same steps, the same f32 operations and
// the same Gaussian weights.

struct MaskParams {
    // Width, height, the layer buffer's row stride, the mode (0 none, 1 add,
    // 2 subtract, 3 intersect, 4 difference).
    size: vec4<u32>,
    // grow, has band, inverted, feather radius.
    flags: vec4<u32>,
    // opacity, initial alpha.
    values: vec4<f32>,
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
        case 4u { out = a + c - 2.0 * a * c; }
        default { out = a; }
    }
    alpha[i] = out;
}

@compute @workgroup_size(16, 16)
fn apply(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let l = id.y * p.size.z + id.x;
    layer[l] = layer[l] * alpha[index(id)];
}
