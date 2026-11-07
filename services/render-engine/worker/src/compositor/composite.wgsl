// Ported from EffectCraft at 9a7d3e76991d5372448033b473dc12c2480a6a04:
// crates/gpu/src/shaders/common.wgsl (tex_get, sample_bilinear, normal blend)
// and kernels.wgsl (warp_blend). Copyright (c) 2026 ArtCraft Team and the
// EffectCraft contributors. MIT OR Apache-2.0; see EFFECTCRAFT-LICENSE.
// GrapiX: tile-local affine uniforms, working-space premultiplied float
// output. No quantisation or transfer curve in this pass. 3.20: every layer
// composites through blend_pixel (blend.wgsl, prepended with the generated
// M_* mode constants), in every contract blend mode.

struct Params {
    row_x: vec4<f32>,
    row_y: vec4<f32>,
    state: vec4<f32>, // opacity, reserved
    // mode (position in BlendMode::ALL), Dissolve seed, and the tile's first
    // stage pixel as integers: a hash key for Dissolve, never a coordinate.
    key: vec4<u32>,
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_2d<f32>;
@group(0) @binding(2) var out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<uniform> params: Params;

fn tex_get(p: vec2<i32>) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(src));
    if (any(p < vec2<i32>(0)) || any(p >= size)) {
        return vec4<f32>(0.0);
    }
    return textureLoad(src, p, 0);
}

fn sample_bilinear(p: vec2<f32>) -> vec4<f32> {
    // Pixel centres are at +0.5. Outside the layer is transparent, never
    // clamped to its edge or sampled from another object.
    let f = p - vec2<f32>(0.5);
    let lo = floor(f);
    let t = f - lo;
    let q = vec2<i32>(lo);
    let a = tex_get(q);
    let b = tex_get(q + vec2<i32>(1, 0));
    let c = tex_get(q + vec2<i32>(0, 1));
    let d = tex_get(q + vec2<i32>(1, 1));
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

@compute @workgroup_size(16, 16)
fn clear(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= textureDimensions(out))) { return; }
    textureStore(out, vec2<i32>(id.xy), vec4<f32>(0.0));
}

@compute @workgroup_size(16, 16)
fn composite(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= textureDimensions(out))) { return; }
    let d = textureLoad(dst, vec2<i32>(id.xy), 0);
    // A layer at zero opacity, hidden or zero-scale, does nothing at all: a
    // hidden stencil must not clear the backdrop.
    if (!(params.state.x > 0.0)) {
        textureStore(out, vec2<i32>(id.xy), d);
        return;
    }
    let p = vec3<f32>(vec2<f32>(id.xy) + vec2<f32>(0.5), 1.0);
    let source_p = vec2<f32>(dot(params.row_x.xyz, p), dot(params.row_y.xyz, p));
    let size = vec2<f32>(textureDimensions(src));
    var s = vec4<f32>(0.0);
    // Bound before float-to-int conversion: huge but finite transforms must
    // never overflow a sample coordinate or read an unrelated texel.
    if (all(source_p > vec2<f32>(-1.0)) && all(source_p < size + vec2<f32>(1.0))) {
        s = sample_bilinear(source_p) * params.state.x;
    }
    let mode = params.key.x;
    var noise = 0.5;
    if (mode == M_Dissolve || mode == M_DancingDissolve) {
        noise = hash_noise(params.key.z + id.x, params.key.w + id.y, params.key.y);
    }
    textureStore(out, vec2<i32>(id.xy), blend_pixel(mode, d, s, noise));
}
