// GrapiX shared composite shader.
//
// This file is consumed byte-for-byte by BOTH renderers:
//   * services/render-daemon  (Rust + wgpu, via include_str!)
//   * the future browser WebGPU preview (Vite `?raw` import)
//
// Do not fork this file per renderer. Any change here must be made together
// with layouts.json and the QuadUniforms struct in
// services/render-daemon/src/renderer/pipeline.rs.
// The full contract (coordinates, color pipeline, alpha, blending) is
// documented in docs/shader-contract.md.

struct QuadUniforms {
  // scene-space -> clip-space, includes the object model transform.
  // Composition (column-major, column vectors, right-to-left application):
  //   transform = projection * translate(x, y) * rotate_z(rotation) * scale(width, height)
  // Rotation pivots on the object's top-left corner, matching the editor
  // (PixiJS default pivot). See shader-contract.md for the projection matrix.
  transform: mat4x4<f32>,
  // Linear-light RGB premultiplied by alpha; alpha in .a.
  fill_color: vec4<f32>,
  // params.x = blend mode id (see layouts.json blendModes).
  // params.y/z/w are reserved and must be 0.
  params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> quad: QuadUniforms;

// Unit quad in [0,1]^2 generated from the vertex index (no vertex buffer).
// Triangle list, 6 vertices: (0,0) (1,0) (0,1) / (1,0) (1,1) (0,1).
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0)
  );

  return quad.transform * vec4<f32>(corners[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  // Solid fill only in contract v1. Blend mode 0 (normal) is applied by the
  // fixed-function blender: src * ONE + dst * (1 - src.alpha), i.e.
  // premultiplied source-over.
  return quad.fill_color;
}
