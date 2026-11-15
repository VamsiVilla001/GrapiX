// 3.17: composite one path's paint onto a layer source, scaled by the
// coverage Vello GPU drew for it. Colour is the path's premultiplied paint in
// the scene's working space, in float; Vello supplies coverage only. The CPU
// twin is `VelloCpuRasteriser` with `rasterise::paint::PathGradient::colour`:
// the same operations in the same order.

struct Draw {
    paint: vec4<f32>,
    // The coverage window on the layer: x, y, width, height.
    window: vec4<u32>,
    // x: the accumulation buffer's row stride in pixels; y: 0 solid,
    // 1 linear, 2 radial; z: spread 0 pad, 1 repeat, 2 reflect; w: stops.
    config: vec4<u32>,
    // Window pixel centre (x, y) to u = row_u.x x + row_u.y y + row_u.z, and
    // v likewise; a radial gradient's parameter is |(u, v)|.
    row_u: vec4<f32>,
    row_v: vec4<f32>,
    positions: array<vec4<f32>, 4>,
    colours: array<vec4<f32>, 16>,
}

@group(0) @binding(0) var coverage: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> layer: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> draw: Draw;

fn spread(mode: u32, t: f32) -> f32 {
    if (mode == 1u) {
        return t - floor(t);
    }
    if (mode == 2u) {
        let m = t - 2.0 * floor(t * 0.5);
        if (m > 1.0) {
            return 2.0 - m;
        }
        return m;
    }
    return t;
}

fn stop_position(k: u32) -> f32 {
    return draw.positions[k / 4u][k % 4u];
}

fn gradient(i: u32, j: u32) -> vec4<f32> {
    let x = f32(i) + 0.5;
    let y = f32(j) + 0.5;
    let u = draw.row_u.x * x + draw.row_u.y * y + draw.row_u.z;
    var t = u;
    if (draw.config.y == 2u) {
        let v = draw.row_v.x * x + draw.row_v.y * y + draw.row_v.z;
        t = sqrt(u * u + v * v);
    }
    t = spread(draw.config.z, t);
    let last = draw.config.w - 1u;
    if (!(t > stop_position(0u))) {
        return draw.colours[0];
    }
    if (t >= stop_position(last)) {
        return draw.colours[last];
    }
    for (var k = 0u; k < last; k++) {
        let p0 = stop_position(k);
        let p1 = stop_position(k + 1u);
        if (t < p1) {
            let span = p1 - p0;
            var w = 0.0;
            if (span > 0.0) {
                w = (t - p0) / span;
            }
            return draw.colours[k] * (1.0 - w) + draw.colours[k + 1u] * w;
        }
    }
    return draw.colours[last];
}

@compute @workgroup_size(16, 16)
fn compose(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= draw.window.zw)) { return; }
    let c = textureLoad(coverage, vec2<i32>(id.xy), 0).a;
    if (c == 0.0) { return; }
    var paint = draw.paint;
    if (draw.config.y != 0u) {
        paint = gradient(id.x, id.y);
    }
    let p = draw.window.xy + id.xy;
    let i = p.y * draw.config.x + p.x;
    let s = paint * c;
    layer[i] = s + layer[i] * (1.0 - s.a);
}
