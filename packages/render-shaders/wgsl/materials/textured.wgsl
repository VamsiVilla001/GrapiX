struct TexturedUniforms {
  transform: mat4x4<f32>,
  tint: vec4<f32>,
  uv_scale_offset: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> material: TexturedUniforms;
@group(0) @binding(1) var base_texture: texture_2d<f32>;
@group(0) @binding(2) var base_sampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let corner = corners[vertex_index];
  var output: VertexOutput;
  output.position = material.transform * vec4<f32>(corner, 0.0, 1.0);
  output.uv = corner * material.uv_scale_offset.xy + material.uv_scale_offset.zw;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Texture data is sampled as straight RGBA and premultiplied exactly once.
  let sampled = textureSample(base_texture, base_sampler, input.uv) * material.tint;
  return vec4<f32>(sampled.rgb * sampled.a, sampled.a);
}
