// Shared colour helpers. Hosts compose this source into custom material
// shaders during validation; no browser/Rust-specific implementation exists.
fn grapix_saturate(value: vec4<f32>) -> vec4<f32> {
  return clamp(value, vec4<f32>(0.0), vec4<f32>(1.0));
}

fn grapix_premultiply(value: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(value.rgb * value.a, value.a);
}
