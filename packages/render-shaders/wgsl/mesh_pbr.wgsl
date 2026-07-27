// GrapiX native mesh shader.
//
// Textures are sampled as sRGB GPU resources where appropriate, so sampled
// RGB reaches this shader in linear light. The fragment output is
// premultiplied for the same compositor contract as composite_quad.wgsl.

struct MeshUniforms {
  model: mat4x4<f32>,
  view_projection: mat4x4<f32>,
  normal_model: mat4x4<f32>,
  base_color: vec4<f32>,
  material_params: vec4<f32>, // x metalness, y roughness, z alpha cutoff, w textured
  uv_scale_offset: vec4<f32>, // xy scale, zw offset
  uv_rotation_pivot: vec4<f32>, // x radians, yz pivot, w lit (0 unlit, 1 lit)
  emissive: vec4<f32>, // xyz linear emissive RGB, w intensity
};

struct SceneLight {
  color_intensity: vec4<f32>, // xyz linear RGB, w intensity
  position_kind: vec4<f32>, // xyz world position, w 0 directional / 1 point / 2 spot
  direction_range: vec4<f32>, // xyz light-to-target unit direction, w range (0 unlimited)
  spot_decay: vec4<f32>, // x outer cosine, y inner cosine, z distance decay, w reserved
};

struct SceneLighting {
  params: vec4<f32>, // x authored light count, yzw camera world position
  lights: array<SceneLight, 16>,
};

@group(0) @binding(0)
var<uniform> mesh: MeshUniforms;

@group(0) @binding(1)
var base_color_texture: texture_2d<f32>;

@group(0) @binding(2)
var base_color_sampler: sampler;

@group(0) @binding(3)
var<uniform> scene_lighting: SceneLighting;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) world_normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) world_position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let world_position = mesh.model * vec4<f32>(input.position, 1.0);
  output.clip_position = mesh.view_projection * world_position;
  output.world_normal = normalize((mesh.normal_model * vec4<f32>(input.normal, 0.0)).xyz);
  output.world_position = world_position.xyz;

  let pivot = mesh.uv_rotation_pivot.yz;
  let angle = mesh.uv_rotation_pivot.x;
  let scaled = (input.uv - pivot) * mesh.uv_scale_offset.xy;
  let rotated = vec2<f32>(
    scaled.x * cos(angle) - scaled.y * sin(angle),
    scaled.x * sin(angle) + scaled.y * cos(angle)
  );
  output.uv = rotated + pivot + mesh.uv_scale_offset.zw;
  return output;
}

fn punctual_attenuation(distance: f32, range: f32, decay: f32) -> f32 {
  var attenuation = 1.0 / max(pow(max(distance, 0.01), decay), 0.01);
  if (range > 0.0) {
    let cutoff = clamp(1.0 - distance / range, 0.0, 1.0);
    attenuation *= cutoff * cutoff;
  }
  return attenuation;
}

fn spot_attenuation(light_to_surface: vec3<f32>, light: SceneLight) -> f32 {
  let cone_cosine = dot(light_to_surface, normalize(light.direction_range.xyz));
  let outer = light.spot_decay.x;
  let inner = light.spot_decay.y;
  if (inner - outer <= 0.00001) {
    return select(0.0, 1.0, cone_cosine >= outer);
  }
  return smoothstep(outer, inner, cone_cosine);
}

const PI: f32 = 3.141592653589793;

// Trowbridge-Reitz GGX normal distribution. `roughness` is the perceptual
// roughness authored by the material, matching the metallic-roughness model.
fn distribution_ggx(
  normal: vec3<f32>,
  halfway: vec3<f32>,
  roughness: f32
) -> f32 {
  let alpha = roughness * roughness;
  let alpha_squared = alpha * alpha;
  let n_dot_h = max(dot(normal, halfway), 0.0);
  let denominator_term = n_dot_h * n_dot_h * (alpha_squared - 1.0) + 1.0;
  return alpha_squared / max(PI * denominator_term * denominator_term, 0.000001);
}

fn geometry_schlick_ggx(n_dot_direction: f32, roughness: f32) -> f32 {
  let remapped = roughness + 1.0;
  let k = remapped * remapped / 8.0;
  return n_dot_direction / max(n_dot_direction * (1.0 - k) + k, 0.000001);
}

fn geometry_smith(
  normal: vec3<f32>,
  view_direction: vec3<f32>,
  light_direction: vec3<f32>,
  roughness: f32
) -> f32 {
  let n_dot_v = max(dot(normal, view_direction), 0.0);
  let n_dot_l = max(dot(normal, light_direction), 0.0);
  return geometry_schlick_ggx(n_dot_v, roughness)
    * geometry_schlick_ggx(n_dot_l, roughness);
}

fn fresnel_schlick(cosine: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);
}

// Energy-conserving Cook-Torrance direct-light response. Metals have no
// diffuse lobe; the Fresnel term removes reflected energy from dielectrics'
// Lambertian lobe.
fn evaluate_direct_brdf(
  base_color: vec3<f32>,
  metalness: f32,
  roughness: f32,
  normal: vec3<f32>,
  view_direction: vec3<f32>,
  light_direction: vec3<f32>,
  radiance: vec3<f32>
) -> vec3<f32> {
  let n_dot_l = max(dot(normal, light_direction), 0.0);
  let n_dot_v = max(dot(normal, view_direction), 0.0);
  let halfway_sum = view_direction + light_direction;
  let halfway_length = length(halfway_sum);
  if (n_dot_l <= 0.0 || n_dot_v <= 0.0 || halfway_length <= 0.00001) {
    return vec3<f32>(0.0);
  }
  let halfway = halfway_sum / halfway_length;
  let dielectric_f0 = vec3<f32>(0.04);
  let f0 = mix(dielectric_f0, base_color, metalness);
  let fresnel = fresnel_schlick(max(dot(halfway, view_direction), 0.0), f0);
  let distribution = distribution_ggx(normal, halfway, roughness);
  let geometry = geometry_smith(normal, view_direction, light_direction, roughness);
  let specular = distribution * geometry * fresnel
    / max(4.0 * n_dot_v * n_dot_l, 0.0001);
  let diffuse_weight = (vec3<f32>(1.0) - fresnel) * (1.0 - metalness);
  let diffuse = diffuse_weight * base_color / PI;
  return (diffuse + specular) * radiance * n_dot_l;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  var texel = vec4<f32>(1.0);
  if (mesh.material_params.w > 0.5) {
    texel = textureSample(base_color_texture, base_color_sampler, input.uv);
  }

  let straight = texel * mesh.base_color;
  if (straight.a <= mesh.material_params.z) {
    discard;
  }

  let emissive = max(mesh.emissive.xyz, vec3<f32>(0.0)) * max(mesh.emissive.w, 0.0);

  // Explicit self-lit effects (currently the additive-glow legacy alias)
  // bypass direct lighting. Ordinary solid/image/unlit-texture aliases are
  // normalized to the physical branch by the native scene preparer.
  if (mesh.uv_rotation_pivot.w < 0.5) {
    let self_lit = straight.rgb + emissive;
    return vec4<f32>(self_lit * straight.a, straight.a);
  }

  let normal = normalize(input.world_normal);
  let roughness = clamp(mesh.material_params.y, 0.045, 1.0);
  let metalness = clamp(mesh.material_params.x, 0.0, 1.0);
  let base_color = max(straight.rgb, vec3<f32>(0.0));
  let view_delta = scene_lighting.params.yzw - input.world_position;
  let view_distance = length(view_delta);
  var view_direction = normal;
  if (view_distance > 0.00001) {
    view_direction = view_delta / view_distance;
  }

  // No authored lights: retain the editor/native readable fallback. The
  // presence of even a zero-intensity authored light deliberately suppresses
  // this branch, so lighting mistakes are visible rather than silently fixed.
  if (scene_lighting.params.x < 0.5) {
    let key_direction = normalize(vec3<f32>(-0.35, -0.55, 1.0));
    let sky = normal.z * 0.5 + 0.5;
    let key = evaluate_direct_brdf(
      base_color,
      metalness,
      roughness,
      normal,
      view_direction,
      key_direction,
      vec3<f32>(3.2)
    );
    // A small environment approximation keeps fallback-only scenes readable.
    // Authored-light scenes do not receive this term.
    let ambient_diffuse =
      base_color * (1.0 - metalness) * (0.18 + sky * 0.12);
    let ambient_specular =
      mix(vec3<f32>(0.015), base_color * 0.08, metalness) * (1.0 - roughness * 0.5);
    let fallback_rgb = ambient_diffuse + ambient_specular + key + emissive;
    return vec4<f32>(fallback_rgb * straight.a, straight.a);
  }

  var lit_rgb = vec3<f32>(0.0);
  let light_count = min(u32(scene_lighting.params.x), 16u);
  for (var index = 0u; index < 16u; index += 1u) {
    if (index >= light_count) {
      break;
    }
    let light = scene_lighting.lights[index];
    let kind = u32(light.position_kind.w + 0.5);
    var to_light = -normalize(light.direction_range.xyz);
    var attenuation = 1.0;
    if (kind != 0u) {
      let delta = light.position_kind.xyz - input.world_position;
      let distance = length(delta);
      if (distance > 0.00001) {
        to_light = delta / distance;
      } else {
        to_light = vec3<f32>(0.0, 0.0, 1.0);
      }
      attenuation = punctual_attenuation(
        distance,
        light.direction_range.w,
        light.spot_decay.z
      );
      if (kind == 2u) {
        attenuation *= spot_attenuation(-to_light, light);
      }
    }

    let radiance = light.color_intensity.rgb * light.color_intensity.w * attenuation;
    lit_rgb += evaluate_direct_brdf(
      base_color,
      metalness,
      roughness,
      normal,
      view_direction,
      to_light,
      radiance
    );
  }
  let output_rgb = lit_rgb + emissive;
  return vec4<f32>(output_rgb * straight.a, straight.a);
}
