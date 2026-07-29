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
  //   transform = projection * translate(x, y) * rotate_z(rotation)
  //             * scale(scale_x, scale_y) * translate(-anchor) * scale(width, height)
  // x/y is the world position of the object-local anchor. Legacy objects use
  // anchor=(0,0), scale=(1,1), preserving the old top-left pivot.
  transform: mat4x4<f32>,
  // Linear-light RGB premultiplied by alpha; alpha in .a.
  fill_color: vec4<f32>,
  // params.x = blend mode id (see layouts.json blendModes).
  // params.y = primitive kind: 0 rectangle, 1 ellipse.
  // params.z/w = canvas width/height for scene-coordinate gradients.
  params: vec4<f32>,
  // x = gradient kind (0 solid, 1 linear, 2 radial), y = stop count,
  // z = spread (0 pad, 1 repeat, 2 reflect), w = coordinates (0 object, 1 scene).
  gradient_params: vec4<f32>,
  // Linear: [0] = start.xy/end.xy. Radial: [0] = center.xy/radius.xy,
  // [1].xy = focal point.
  gradient_geometry: array<vec4<f32>, 2>,
  // Eight stop positions packed four per vector.
  gradient_positions: array<vec4<f32>, 2>,
  // Linear-light premultiplied stop colours.
  gradient_colors: array<vec4<f32>, 8>,
}

@group(0) @binding(0) var<uniform> quad: QuadUniforms;

// Unit quad in [0,1]^2 generated from the vertex index (no vertex buffer).
// Triangle list, 6 vertices: (0,0) (1,0) (0,1) / (1,0) (1,1) (0,1).
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local_position: vec2<f32>,
  @location(1) scene_position: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0)
  );

  var output: VertexOutput;
  output.position = quad.transform * vec4<f32>(corners[vertex_index], 0.0, 1.0);
  output.local_position = corners[vertex_index];
  output.scene_position = vec2<f32>(
    (output.position.x + 1.0) * quad.params.z * 0.5,
    (1.0 - output.position.y) * quad.params.w * 0.5
  );
  return output;
}

fn stop_position(index: u32) -> f32 {
  if (index < 4u) {
    return quad.gradient_positions[0][index];
  }
  return quad.gradient_positions[1][index - 4u];
}

fn spread_position(value: f32) -> f32 {
  if (quad.gradient_params.z == 1.0) {
    return fract(value);
  }
  if (quad.gradient_params.z == 2.0) {
    let wrapped = value - floor(value / 2.0) * 2.0;
    return select(2.0 - wrapped, wrapped, wrapped <= 1.0);
  }
  return clamp(value, 0.0, 1.0);
}

fn gradient_color(input: VertexOutput) -> vec4<f32> {
  if (quad.gradient_params.x == 0.0 || quad.gradient_params.y < 2.0) {
    return quad.fill_color;
  }
  let point = select(input.local_position, input.scene_position, quad.gradient_params.w == 1.0);
  var position = 0.0;
  if (quad.gradient_params.x == 1.0) {
    let start = quad.gradient_geometry[0].xy;
    let end = quad.gradient_geometry[0].zw;
    let axis = end - start;
    position = dot(point - start, axis) / max(0.000001, dot(axis, axis));
  } else {
    let center = quad.gradient_geometry[0].xy;
    let radii = max(quad.gradient_geometry[0].zw, vec2<f32>(0.0001));
    let focal = quad.gradient_geometry[1].xy;
    position = length((point - focal) / radii);
    if (all(focal == center)) {
      position = length((point - center) / radii);
    }
  }
  position = spread_position(position);
  let count = u32(quad.gradient_params.y);
  if (position <= stop_position(0u)) {
    return quad.gradient_colors[0];
  }
  for (var index = 1u; index < 8u; index += 1u) {
    if (index >= count) {
      break;
    }
    let upper_position = stop_position(index);
    if (position <= upper_position) {
      let lower_position = stop_position(index - 1u);
      let amount = (position - lower_position) / max(0.000001, upper_position - lower_position);
      return mix(quad.gradient_colors[index - 1u], quad.gradient_colors[index], amount);
    }
  }
  return quad.gradient_colors[count - 1u];
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (quad.params.y == 1.0) {
    let centered = input.local_position * 2.0 - vec2<f32>(1.0, 1.0);
    if (dot(centered, centered) > 1.0) {
      discard;
    }
  }
  return gradient_color(input);
}
