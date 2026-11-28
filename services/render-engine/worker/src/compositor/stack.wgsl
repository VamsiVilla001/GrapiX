// GrapiX layer stack pass (task 112, rows 12.10 and 12.13). One scene's finished working-space tile goes over what the scenes below it have
// already made, in the working space and before any output encode, exactly as `blend.wgsl`'s Normal mode composites one layer over
// another: premultiplied, `upper + lower * (1 - upper.a)` in every channel, alpha included. With no lower scene (the lowest layer) the lower
// pixel is zero. The result is held to the project's colour depth the way each blended layer is (`composite.wgsl`: 8 and 16 bit store a
// whole level held to 0-1), so a stack at 8 bit is quantised at every step as a single scene's layers are.

struct Params {
    size: vec2<u32>,
    has_lower: u32,
    // The depth's level count; 0 for 32-bit float.
    levels: f32,
}

@group(0) @binding(0) var upper: texture_2d<f32>;
@group(0) @binding(1) var lower: texture_2d<f32>;
@group(0) @binding(2) var out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn over(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= params.size.x || id.y >= params.size.y) {
        return;
    }
    let p = vec2<i32>(id.xy);
    let u = textureLoad(upper, p, 0);
    var d = vec4<f32>(0.0);
    if (params.has_lower != 0u) {
        d = textureLoad(lower, p, 0);
    }
    var r = u + d * (1.0 - u.w);
    if (params.levels > 0.0) {
        r = floor(clamp(r, vec4<f32>(0.0), vec4<f32>(1.0)) * params.levels + 0.5) / params.levels;
    }
    textureStore(out, p, r);
}
