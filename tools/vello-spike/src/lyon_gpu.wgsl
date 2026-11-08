// GrapiX 3.17 benchmark: lyon triangles -> 4x MSAA stencil union -> paint.
// Stencil prevents overlapping stroke/join triangles from applying alpha twice.
struct Paint {
    geometry: vec4<f32>,
    flags: vec4<f32>, // kind (solid/linear/radial), stop count
    colors: array<vec4<f32>, 3>,
    stops: vec4<f32>,
}
@group(0) @binding(0) var<uniform> paint: Paint;

@vertex fn mesh(@location(0) p: vec2<f32>) -> @builtin(position) vec4<f32> {
    return vec4<f32>(p.x / 1920.0 * 2.0 - 1.0, 1.0 - p.y / 1080.0 * 2.0, 0.0, 1.0);
}
@vertex fn quad(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let points = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
    return vec4<f32>(points[index],0.0,1.0);
}
@fragment fn mask() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn color(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    if (paint.flags.x == 0.0) { return paint.colors[0]; }
    var t: f32;
    if (paint.flags.x == 1.0) {
        let delta = paint.geometry.zw - paint.geometry.xy;
        t = dot(p.xy - paint.geometry.xy, delta) / dot(delta, delta);
    } else {
        t = distance(p.xy, paint.geometry.xy) / paint.geometry.z;
    }
    t = clamp(t, 0.0, 1.0);
    var lo = 0u;
    var hi = 1u;
    if (paint.flags.y > 2.0 && t > paint.stops.y) { lo = 1u; hi = 2u; }
    let u = clamp((t - paint.stops[lo]) / (paint.stops[hi] - paint.stops[lo]), 0.0, 1.0);
    return mix(paint.colors[lo], paint.colors[hi], u);
}
