// 3.17: an image object's box raster from its decoded image and fit plan.
// The CPU twin is `image::FitPlan::sample`: the same operations in the same
// order.

struct Fit {
    // Raster width, height, buffer row stride; flags: 1 tile, 2 nearest,
    // 4 clip to the box.
    size: vec4<u32>,
    // Raster origin x, y in box coordinates; the box width and height.
    origin: vec4<f32>,
    xk: vec4<f32>,
    xa: vec4<f32>,
    xc: vec4<f32>,
    yk: vec4<f32>,
    ya: vec4<f32>,
    yc: vec4<f32>,
}

@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> raster: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> fit: Fit;

fn map_axis(b: f32, k: vec4<f32>, a: vec4<f32>, c: vec4<f32>) -> f32 {
    var s = 1u;
    if (b < k.x) {
        s = 0u;
    } else if (b > k.y) {
        s = 2u;
    }
    return a[s] * b + c[s];
}

fn texel(x: i32, y: i32, tile: bool) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(image));
    var p = vec2<i32>(x, y);
    if (tile) {
        p = ((p % size) + size) % size;
    } else {
        p = clamp(p, vec2<i32>(0), size - vec2<i32>(1));
    }
    return textureLoad(image, p, 0);
}

fn image_coverage(b: f32, k: vec4<f32>, a: vec4<f32>, c: vec4<f32>, size: f32) -> f32 {
    let t0 = map_axis(b - 0.5, k, a, c);
    let t1 = map_axis(b + 0.5, k, a, c);
    let span = t1 - t0;
    if (span > 0.0) {
        return clamp(min(t1, size) - max(t0, 0.0), 0.0, span) / span;
    }
    if (t0 >= 0.0 && t0 <= size) {
        return 1.0;
    }
    return 0.0;
}

fn coverage(b: f32, length: f32) -> f32 {
    return clamp(min(b + 0.5, length) - max(b - 0.5, 0.0), 0.0, 1.0);
}

fn lerp4(p: vec4<f32>, q: vec4<f32>, t: f32) -> vec4<f32> {
    return p + (q - p) * t;
}

@compute @workgroup_size(16, 16)
fn fit_raster(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= fit.size.xy)) { return; }
    let tile = (fit.size.w & 1u) != 0u;
    let nearest = (fit.size.w & 2u) != 0u;
    let clip = (fit.size.w & 4u) != 0u;
    let bx = fit.origin.x + f32(id.x) + 0.5;
    let by = fit.origin.y + f32(id.y) + 0.5;
    let size = vec2<f32>(textureDimensions(image));
    var covered = 1.0;
    if (!tile) {
        covered = image_coverage(bx, fit.xk, fit.xa, fit.xc, size.x)
            * image_coverage(by, fit.yk, fit.ya, fit.yc, size.y);
    }
    let tx = map_axis(bx, fit.xk, fit.xa, fit.xc);
    let ty = map_axis(by, fit.yk, fit.ya, fit.yc);
    var p = vec4<f32>(0.0);
    if (covered != 0.0) {
        if (nearest) {
            p = texel(i32(floor(tx)), i32(floor(ty)), tile);
        } else {
            let fx = tx - 0.5;
            let fy = ty - 0.5;
            let lx = floor(fx);
            let ly = floor(fy);
            let wx = fx - lx;
            let wy = fy - ly;
            let x0 = i32(lx);
            let y0 = i32(ly);
            let a = texel(x0, y0, tile);
            let b = texel(x0 + 1, y0, tile);
            let c = texel(x0, y0 + 1, tile);
            let d = texel(x0 + 1, y0 + 1, tile);
            p = lerp4(lerp4(a, b, wx), lerp4(c, d, wx), wy);
        }
        p = p * covered;
    }
    if (clip) {
        p = p * (coverage(bx, fit.origin.z) * coverage(by, fit.origin.w));
    }
    raster[id.y * fit.size.z + id.x] = p;
}
