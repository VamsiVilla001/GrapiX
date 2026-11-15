// 3.17: composite one path's paint onto a layer source, scaled by the
// coverage Vello GPU drew for it. Colour is the path's premultiplied paint in
// the scene's working space, in float; Vello supplies coverage only. The CPU
// twin is `VelloCpuRasteriser` (paint.scaled(coverage).over(destination)).

struct Draw {
    paint: vec4<f32>,
    // The coverage window on the layer: x, y, width, height.
    window: vec4<u32>,
    // x: the accumulation buffer's row stride in pixels.
    stride: vec4<u32>,
}

@group(0) @binding(0) var coverage: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> layer: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> draw: Draw;

@compute @workgroup_size(16, 16)
fn compose(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= draw.window.zw)) { return; }
    let c = textureLoad(coverage, vec2<i32>(id.xy), 0).a;
    if (c == 0.0) { return; }
    let p = draw.window.xy + id.xy;
    let i = p.y * draw.stride.x + p.x;
    let s = draw.paint * c;
    layer[i] = s + layer[i] * (1.0 - s.a);
}
