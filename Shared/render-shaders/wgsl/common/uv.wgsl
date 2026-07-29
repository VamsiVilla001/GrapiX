fn grapix_transform_uv(
  uv: vec2<f32>,
  scale: vec2<f32>,
  offset: vec2<f32>,
  pivot: vec2<f32>,
  rotation: f32
) -> vec2<f32> {
  let centered = (uv - pivot) * scale;
  let sine = sin(rotation);
  let cosine = cos(rotation);
  let rotated = vec2<f32>(
    centered.x * cosine - centered.y * sine,
    centered.x * sine + centered.y * cosine
  );
  return rotated + pivot + offset;
}
