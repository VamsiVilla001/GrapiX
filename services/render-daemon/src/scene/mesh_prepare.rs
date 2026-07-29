//! Native mesh preparation for the Program renderer.
//!
//! Scene JSON, embedded glTF/GLB assets, and texture assets are decoded while
//! a scene is warmed. The render thread receives only CPU-ready vertices,
//! indices, pixels, and material parameters, so no file or network I/O occurs
//! on the broadcast frame clock.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use glam::{EulerRot, Mat3, Mat4, Vec3, Vec4};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct PreparedMeshVertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedCullMode {
    Back,
    Front,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedWrapMode {
    Clamp,
    Repeat,
    MirrorRepeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedFilterMode {
    Linear,
    Nearest,
}

#[derive(Debug, Clone)]
pub struct PreparedTexture {
    pub width: u32,
    pub height: u32,
    pub rgba8: Vec<u8>,
    pub srgb: bool,
}

#[derive(Debug, Clone)]
pub struct PreparedMeshMaterial {
    /// Straight-alpha linear-light RGBA. The mesh shader premultiplies output.
    pub base_color_linear: [f32; 4],
    /// Straight linear-light emissive RGB and a non-negative intensity.
    pub emissive_linear: [f32; 3],
    pub emissive_intensity: f32,
    /// Whether this surface consumes authored/fallback scene lighting.
    ///
    /// Canonical `pbr` materials and all legacy surface aliases enter the same
    /// physical-lighting branch. `additive-glow` remains the sole legacy
    /// self-lit exception until it is migrated to an explicit emissive value.
    pub lit: bool,
    pub metalness: f32,
    pub roughness: f32,
    pub alpha_cutoff: f32,
    pub texture: Option<PreparedTexture>,
    pub uv_scale: [f32; 2],
    pub uv_offset: [f32; 2],
    pub uv_rotation_radians: f32,
    pub uv_pivot: [f32; 2],
    pub wrap: PreparedWrapMode,
    pub filtering: PreparedFilterMode,
    pub cull_mode: PreparedCullMode,
    pub blend_mode: u32,
}

#[derive(Debug, Clone)]
pub struct PreparedMeshSurface {
    pub slot_key: String,
    pub vertices: Vec<PreparedMeshVertex>,
    pub indices: Vec<u32>,
    pub material: PreparedMeshMaterial,
}

#[derive(Debug, Clone)]
pub struct PreparedMesh {
    pub object_id: String,
    pub model_transform: [f32; 16],
    pub surfaces: Vec<PreparedMeshSurface>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeshSceneContext {
    #[serde(default)]
    assets: Vec<AssetDto>,
    #[serde(default)]
    materials: Vec<MaterialDto>,
    #[serde(default)]
    material_instances: Vec<MaterialInstanceDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetDto {
    asset_id: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    storage_asset_id: Option<String>,
    #[serde(default)]
    color_space: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialDto {
    material_id: String,
    name: String,
    #[serde(rename = "type")]
    material_type: String,
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default)]
    parameters: HashMap<String, Value>,
    #[serde(default)]
    texture_slots: Vec<TextureSlotDto>,
    #[serde(default)]
    blend_mode: Option<String>,
    #[serde(default)]
    alpha_mode: Option<String>,
    #[serde(default)]
    cull_mode: Option<String>,
    #[serde(default)]
    color_space: Option<String>,
    #[serde(default)]
    double_sided: bool,
    #[serde(default)]
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureSlotDto {
    #[serde(default)]
    name: String,
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    wrap: Option<String>,
    #[serde(default)]
    filtering: Option<String>,
    #[serde(default = "default_uv_scale")]
    uv_scale: [f64; 2],
    #[serde(default)]
    uv_offset: [f64; 2],
    #[serde(default)]
    uv_rotation: f64,
    #[serde(default = "default_uv_pivot")]
    uv_pivot: [f64; 2],
    #[serde(default)]
    flip_x: bool,
    #[serde(default)]
    flip_y: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialInstanceDto {
    material_instance_id: String,
    base_material_id: String,
    #[serde(default)]
    parameter_overrides: HashMap<String, Value>,
    #[serde(default)]
    texture_overrides: HashMap<String, String>,
}

#[derive(Debug)]
struct MaterialBindingRef {
    material_id: String,
    instance_id: Option<String>,
    overrides: HashMap<String, Value>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
struct Vec2Dto {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct Vec3Dto {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeshObjectDto {
    id: String,
    mesh_kind: String,
    x: f64,
    y: f64,
    #[serde(default)]
    z_depth: f64,
    width: f64,
    height: f64,
    depth: f64,
    #[serde(default)]
    rotation: f64,
    #[serde(default)]
    rotation_x: f64,
    #[serde(default)]
    rotation_y: f64,
    #[serde(default)]
    rotation_z: Option<f64>,
    #[serde(default = "default_scale")]
    scale_x: f64,
    #[serde(default = "default_scale")]
    scale_y: f64,
    #[serde(default = "default_scale")]
    scale_z: f64,
    #[serde(default)]
    anchor: Vec2Dto,
    #[serde(default)]
    anchor3d: Option<Vec3Dto>,
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default = "default_visible")]
    visible: bool,
    #[serde(default)]
    fill: String,
    #[serde(default)]
    src: Option<String>,
    #[serde(default)]
    model_asset_id: Option<String>,
    #[serde(default)]
    material_slots: HashMap<String, Value>,
    #[serde(default)]
    layer_id: String,
    #[serde(default)]
    z_index: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanarObjectDto {
    id: String,
    x: f64,
    y: f64,
    #[serde(default)]
    z_depth: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    rotation: f64,
    #[serde(default = "default_scale")]
    scale_x: f64,
    #[serde(default = "default_scale")]
    scale_y: f64,
    #[serde(default = "default_scale")]
    scale_z: f64,
    #[serde(default)]
    anchor: Vec2Dto,
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default = "default_visible")]
    visible: bool,
    #[serde(default)]
    fill: String,
    #[serde(default)]
    material_slots: HashMap<String, Value>,
    #[serde(default)]
    layer_id: String,
    #[serde(default)]
    z_index: f64,
}

#[derive(Default)]
struct AssetLoadCache {
    bytes: HashMap<String, Result<Vec<u8>, String>>,
    textures: HashMap<String, Result<PreparedTexture, String>>,
}

#[derive(Debug, Clone)]
struct RawSurface {
    slot_key: String,
    vertices: Vec<PreparedMeshVertex>,
    indices: Vec<u32>,
    authored_material: Option<PreparedMeshMaterial>,
}

fn default_opacity() -> f64 {
    1.0
}

fn default_visible() -> bool {
    true
}

fn default_scale() -> f64 {
    1.0
}

fn default_uv_scale() -> [f64; 2] {
    [1.0, 1.0]
}

fn default_uv_pivot() -> [f64; 2] {
    [0.5, 0.5]
}

pub fn prepare_meshes(
    scene_json: &Value,
    objects: &[Value],
    warnings: &mut Vec<String>,
) -> Vec<PreparedMesh> {
    let context: MeshSceneContext = match serde_json::from_value(scene_json.clone()) {
        Ok(context) => context,
        Err(error) => {
            warnings.push(format!(
                "mesh context is invalid and meshes are not rendered: {error}"
            ));
            return Vec::new();
        }
    };
    let assets: HashMap<_, _> = context
        .assets
        .iter()
        .map(|asset| (asset.asset_id.clone(), asset))
        .collect();
    let mut cache = AssetLoadCache::default();
    let mut prepared: Vec<(String, f64, f64, PreparedMesh)> = Vec::new();

    for value in objects {
        if value.get("type").and_then(Value::as_str) != Some("mesh") {
            continue;
        }
        let object: MeshObjectDto = match serde_json::from_value(value.clone()) {
            Ok(object) => object,
            Err(error) => {
                warnings.push(format!("mesh object skipped: {error}"));
                continue;
            }
        };
        if !object.visible {
            continue;
        }
        if object.width <= 0.0 || object.height <= 0.0 || object.depth <= 0.0 {
            warnings.push(format!(
                "mesh {} skipped: dimensions must be positive ({}x{}x{})",
                object.id, object.width, object.height, object.depth
            ));
            continue;
        }

        let raw_surfaces = match object.mesh_kind.as_str() {
            "cube" | "slab" => cube_surfaces(&object),
            "sphere" => sphere_surfaces(&object),
            "cylinder" => cylinder_surfaces(&object),
            "torus" => torus_surfaces(&object),
            "model" => match import_model_surfaces(&object, &assets, &mut cache, warnings) {
                Some(surfaces) => surfaces,
                None => continue,
            },
            unsupported => {
                warnings.push(format!(
                    "mesh {} uses unsupported mesh kind {unsupported:?} and is not rendered",
                    object.id
                ));
                continue;
            }
        };

        let mut surfaces = Vec::with_capacity(raw_surfaces.len());
        for raw in raw_surfaces {
            let main_override = object.material_slots.contains_key("main");
            let slot_override = object.material_slots.contains_key(&raw.slot_key);
            let material = if slot_override {
                resolve_surface_material(
                    &context,
                    &assets,
                    &object,
                    &raw.slot_key,
                    "#ffffff",
                    &mut cache,
                    warnings,
                )
            } else if main_override && (raw.slot_key == "main" || object.mesh_kind == "model") {
                // `main` is the primary/front primitive surface. Imported
                // models retain the documented whole-model main override,
                // while element:N remains the more specific model binding.
                resolve_surface_material(
                    &context, &assets, &object, "main", "#ffffff", &mut cache, warnings,
                )
            } else if let Some(authored) = raw.authored_material {
                Some(with_object_opacity(authored, object.opacity as f32))
            } else {
                resolve_surface_material(
                    &context,
                    &assets,
                    &object,
                    &raw.slot_key,
                    fallback_color(&object, &raw.slot_key),
                    &mut cache,
                    warnings,
                )
            };
            let Some(material) = material else {
                continue;
            };
            surfaces.push(PreparedMeshSurface {
                slot_key: raw.slot_key,
                vertices: raw.vertices,
                indices: raw.indices,
                material,
            });
        }

        if surfaces.is_empty() {
            warnings.push(format!(
                "mesh {} has no renderable surfaces and is not rendered",
                object.id
            ));
            continue;
        }

        let rotation_z = object.rotation_z.unwrap_or(object.rotation);
        let model = Mat4::from_translation(Vec3::new(
            object.x as f32,
            object.y as f32,
            object.z_depth as f32,
        )) * Mat4::from_euler(
            EulerRot::XYZ,
            (object.rotation_x as f32).to_radians(),
            (object.rotation_y as f32).to_radians(),
            (rotation_z as f32).to_radians(),
        ) * Mat4::from_scale(Vec3::new(
            object.scale_x as f32,
            object.scale_y as f32,
            object.scale_z as f32,
        ));

        prepared.push((
            object.layer_id,
            object.z_depth,
            object.z_index,
            PreparedMesh {
                object_id: object.id,
                model_transform: model.to_cols_array(),
                surfaces,
            },
        ));
    }

    // Canonical GrapiX materials are physical surfaces regardless of whether
    // they are assigned to a 3D primitive or a flat broadcast primitive.
    // Preparing bound rectangles/ellipses as real planes keeps base colour,
    // texture, UVs, opacity, metalness/roughness, emissive response, and scene
    // lighting on the same native material path instead of dropping `pbr`
    // materials in the legacy solid-colour quad path.
    for value in objects {
        let primitive_kind = match value.get("type").and_then(Value::as_str) {
            Some("rect") => "rect",
            Some("ellipse") => "ellipse",
            _ => continue,
        };
        let planar: PlanarObjectDto = match serde_json::from_value(value.clone()) {
            Ok(object) => object,
            Err(error) => {
                warnings.push(format!("physical {primitive_kind} object skipped: {error}"));
                continue;
            }
        };
        if !planar.visible || !planar.material_slots.contains_key("main") {
            continue;
        }
        let Some(binding) = planar
            .material_slots
            .get("main")
            .and_then(parse_material_binding)
        else {
            continue;
        };
        let Some(bound_material) = context
            .materials
            .iter()
            .find(|material| material.material_id == binding.material_id)
        else {
            continue;
        };
        // Keep the old solid-colour wire type on the established quad path
        // for backwards-compatible scene fixtures. All current writers emit
        // canonical `pbr`, which takes the physical plane path below.
        if bound_material.material_type == "solid-color" {
            continue;
        }
        if planar.width <= 0.0 || planar.height <= 0.0 {
            warnings.push(format!(
                "{} {} skipped: dimensions must be positive ({}x{})",
                primitive_kind, planar.id, planar.width, planar.height
            ));
            continue;
        }

        let adapter = MeshObjectDto {
            id: planar.id,
            mesh_kind: primitive_kind.to_string(),
            x: planar.x,
            y: planar.y,
            z_depth: planar.z_depth,
            width: planar.width,
            height: planar.height,
            depth: 0.0,
            rotation: planar.rotation,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: Some(planar.rotation),
            scale_x: planar.scale_x,
            scale_y: planar.scale_y,
            scale_z: planar.scale_z,
            anchor: planar.anchor,
            anchor3d: None,
            opacity: planar.opacity,
            visible: planar.visible,
            fill: planar.fill,
            src: None,
            model_asset_id: None,
            material_slots: planar.material_slots,
            layer_id: planar.layer_id,
            z_index: planar.z_index,
        };
        let material = resolve_surface_material(
            &context,
            &assets,
            &adapter,
            "main",
            &adapter.fill,
            &mut cache,
            warnings,
        );
        let Some(material) = material else {
            continue;
        };
        let surface = if primitive_kind == "ellipse" {
            ellipse_plane_surface(&adapter)
        } else {
            rect_plane_surface(&adapter)
        };
        let model = Mat4::from_translation(Vec3::new(
            adapter.x as f32,
            adapter.y as f32,
            adapter.z_depth as f32,
        )) * Mat4::from_rotation_z((adapter.rotation as f32).to_radians())
            * Mat4::from_scale(Vec3::new(
                adapter.scale_x as f32,
                adapter.scale_y as f32,
                adapter.scale_z as f32,
            ));
        prepared.push((
            adapter.layer_id,
            adapter.z_depth,
            adapter.z_index,
            PreparedMesh {
                object_id: adapter.id,
                model_transform: model.to_cols_array(),
                surfaces: vec![PreparedMeshSurface {
                    slot_key: "main".to_string(),
                    vertices: surface.vertices,
                    indices: surface.indices,
                    material,
                }],
            },
        ));
    }

    prepared.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.total_cmp(&right.1))
            .then(left.2.total_cmp(&right.2))
    });
    prepared.into_iter().map(|(_, _, _, mesh)| mesh).collect()
}

fn resolve_surface_material(
    context: &MeshSceneContext,
    assets: &HashMap<String, &AssetDto>,
    object: &MeshObjectDto,
    slot_key: &str,
    fallback: &str,
    cache: &mut AssetLoadCache,
    warnings: &mut Vec<String>,
) -> Option<PreparedMeshMaterial> {
    let Some(binding_value) = object.material_slots.get(slot_key) else {
        return fallback_material(fallback, object.opacity as f32);
    };
    let Some(binding) = parse_material_binding(binding_value) else {
        warnings.push(format!(
            "mesh {} surface {slot_key:?} has an invalid material binding and is not rendered",
            object.id
        ));
        return None;
    };
    let Some(material) = context
        .materials
        .iter()
        .find(|material| material.material_id == binding.material_id)
    else {
        warnings.push(format!(
            "mesh {} surface {slot_key:?} references missing material {} and is not rendered",
            object.id, binding.material_id
        ));
        return None;
    };
    if material.enabled == Some(false) {
        return None;
    }
    if !matches!(
        material.material_type.as_str(),
        "material"
            | "solid-color"
            | "basic-lit"
            | "pbr"
            | "image"
            | "unlit-texture"
            | "additive-glow"
    ) {
        warnings.push(format!(
            "mesh {} surface {slot_key:?} material {:?} has unsupported native type {:?} and is not rendered",
            object.id, material.name, material.material_type
        ));
        return None;
    }

    let instance = binding.instance_id.as_ref().and_then(|instance_id| {
        context.material_instances.iter().find(|instance| {
            instance.material_instance_id == *instance_id
                && instance.base_material_id == material.material_id
        })
    });
    if binding.instance_id.is_some() && instance.is_none() {
        warnings.push(format!(
            "mesh {} surface {slot_key:?} references a missing material instance; the base material is used",
            object.id
        ));
    }
    let instance_parameters = instance.map(|instance| &instance.parameter_overrides);
    let resolved_base_color = || {
        resolved_string_parameter(
            "baseColor",
            &binding.overrides,
            instance_parameters,
            &material.parameters,
        )
    };
    let resolved_tint = || {
        resolved_string_parameter(
            "tint",
            &binding.overrides,
            instance_parameters,
            &material.parameters,
        )
    };
    let resolved_emissive = || {
        resolved_string_parameter(
            "emissiveColor",
            &binding.overrides,
            instance_parameters,
            &material.parameters,
        )
        .or_else(|| {
            resolved_string_parameter(
                "emissive",
                &binding.overrides,
                instance_parameters,
                &material.parameters,
            )
        })
    };
    let base_color = if matches!(material.material_type.as_str(), "image" | "unlit-texture") {
        // Texture materials expose `tint` as their authored colour. Legacy
        // documents can still fall back to baseColor.
        resolved_tint().or_else(resolved_base_color)
    } else {
        resolved_base_color().or_else(resolved_tint)
    }
    .or_else(|| material.color.clone())
    .unwrap_or_else(|| {
        if material.material_type == "image" || material.material_type == "unlit-texture" {
            "#ffffff".to_string()
        } else {
            fallback.to_string()
        }
    });
    let mut color = match parse_hex_color(&base_color) {
        Some(color) => srgb_straight_to_linear(color),
        None => {
            warnings.push(format!(
                "mesh {} surface {slot_key:?} has invalid base color {base_color:?} and is not rendered",
                object.id
            ));
            return None;
        }
    };
    let opacity = resolved_number_parameter(
        "opacity",
        &binding.overrides,
        instance_parameters,
        &material.parameters,
    )
    .unwrap_or(material.opacity) as f32;
    color[3] *= (object.opacity as f32 * opacity).clamp(0.0, 1.0);
    let emissive_source = resolved_emissive().unwrap_or_else(|| "#000000".to_string());
    let emissive = match parse_hex_color(&emissive_source) {
        Some(color) => srgb_straight_to_linear(color),
        None => {
            warnings.push(format!(
                "mesh {} surface {slot_key:?} has invalid emissive color {emissive_source:?} and is not rendered",
                object.id
            ));
            return None;
        }
    };
    let emissive_intensity = resolved_number_parameter(
        "emissiveIntensity",
        &binding.overrides,
        instance_parameters,
        &material.parameters,
    )
    .or_else(|| {
        resolved_number_parameter(
            "emissiveStrength",
            &binding.overrides,
            instance_parameters,
            &material.parameters,
        )
    })
    .unwrap_or(1.0)
    .max(0.0) as f32;

    let texture_slot = material.texture_slots.first().cloned();
    let texture_asset_id = texture_slot
        .as_ref()
        .and_then(|slot| {
            instance
                .and_then(|instance| instance.texture_overrides.get(&slot.name))
                .cloned()
                .or_else(|| slot.asset_id.clone())
        })
        .or_else(|| material.asset_id.clone());
    let texture = if let Some(asset_id) = texture_asset_id {
        let Some(asset) = assets.get(&asset_id).copied() else {
            warnings.push(format!(
                "mesh {} surface {slot_key:?} references missing texture asset {asset_id} and is not rendered",
                object.id
            ));
            return None;
        };
        match load_asset_texture(asset, cache) {
            Ok(mut texture) => {
                texture.srgb = material
                    .color_space
                    .as_deref()
                    .or(asset.color_space.as_deref())
                    != Some("linear");
                Some(texture)
            }
            Err(error) => {
                warnings.push(format!(
                    "mesh {} surface {slot_key:?} texture {asset_id} failed to decode and is not rendered: {error}",
                    object.id
                ));
                return None;
            }
        }
    } else {
        None
    };

    let texture_slot = texture_slot.unwrap_or_else(default_texture_slot);
    let uv_scale_parameter = resolved_vec2_parameter(
        "uvScale",
        &binding.overrides,
        instance_parameters,
        &material.parameters,
    )
    .unwrap_or(texture_slot.uv_scale);
    let uv_offset = resolved_vec2_parameter(
        "uvOffset",
        &binding.overrides,
        instance_parameters,
        &material.parameters,
    )
    .unwrap_or(texture_slot.uv_offset);
    let uv_rotation = resolved_number_parameter(
        "uvRotation",
        &binding.overrides,
        instance_parameters,
        &material.parameters,
    )
    .unwrap_or(texture_slot.uv_rotation);
    let uv_scale = [
        uv_scale_parameter[0] as f32 * if texture_slot.flip_x { -1.0 } else { 1.0 },
        uv_scale_parameter[1] as f32 * if texture_slot.flip_y { -1.0 } else { 1.0 },
    ];
    let uv_offset = [
        uv_offset[0] as f32 + if texture_slot.flip_x { 1.0 } else { 0.0 },
        uv_offset[1] as f32 + if texture_slot.flip_y { 1.0 } else { 0.0 },
    ];

    let blend_mode = match blend_mode_id(material.blend_mode.as_deref().unwrap_or("normal")) {
        Some(mode) => mode,
        None => {
            warnings.push(format!(
                "mesh {} surface {slot_key:?} material {:?} uses unsupported blend mode {:?} and is not rendered",
                object.id, material.name, material.blend_mode
            ));
            return None;
        }
    };
    let alpha_cutoff = match material.alpha_mode.as_deref().unwrap_or("premultiplied") {
        "opaque" | "straight" | "premultiplied" => 0.0,
        "alpha-test" | "alpha-mask" => 0.5,
        unsupported => {
            warnings.push(format!(
                "mesh {} surface {slot_key:?} material {:?} uses unsupported alpha mode {unsupported:?} and is not rendered",
                object.id, material.name
            ));
            return None;
        }
    };
    let cull_mode = if material.double_sided || material.cull_mode.as_deref() == Some("none") {
        PreparedCullMode::None
    } else if material.cull_mode.as_deref() == Some("front") {
        PreparedCullMode::Front
    } else {
        PreparedCullMode::Back
    };
    let metalness = resolved_number_parameter(
        "metalness",
        &binding.overrides,
        instance_parameters,
        &material.parameters,
    )
    .unwrap_or(0.08) as f32;
    let roughness = resolved_number_parameter(
        "roughness",
        &binding.overrides,
        instance_parameters,
        &material.parameters,
    )
    .unwrap_or(0.62) as f32;

    Some(PreparedMeshMaterial {
        base_color_linear: color,
        emissive_linear: [emissive[0], emissive[1], emissive[2]],
        emissive_intensity,
        lit: material.material_type != "additive-glow",
        metalness: metalness.clamp(0.0, 1.0),
        roughness: roughness.clamp(0.0, 1.0),
        alpha_cutoff,
        texture,
        uv_scale,
        uv_offset,
        uv_rotation_radians: (uv_rotation as f32).to_radians(),
        uv_pivot: [
            texture_slot.uv_pivot[0] as f32,
            texture_slot.uv_pivot[1] as f32,
        ],
        wrap: match texture_slot.wrap.as_deref() {
            Some("repeat") => PreparedWrapMode::Repeat,
            Some("mirror-repeat") | Some("mirror") => PreparedWrapMode::MirrorRepeat,
            _ => PreparedWrapMode::Clamp,
        },
        filtering: if texture_slot.filtering.as_deref() == Some("nearest") {
            PreparedFilterMode::Nearest
        } else {
            PreparedFilterMode::Linear
        },
        cull_mode,
        blend_mode,
    })
}

fn with_object_opacity(
    mut material: PreparedMeshMaterial,
    object_opacity: f32,
) -> PreparedMeshMaterial {
    material.base_color_linear[3] *= object_opacity.clamp(0.0, 1.0);
    material
}

fn fallback_material(color: &str, object_opacity: f32) -> Option<PreparedMeshMaterial> {
    let mut color = srgb_straight_to_linear(parse_hex_color(color)?);
    color[3] *= object_opacity.clamp(0.0, 1.0);
    Some(PreparedMeshMaterial {
        base_color_linear: color,
        emissive_linear: [0.0; 3],
        emissive_intensity: 1.0,
        lit: true,
        metalness: 0.08,
        roughness: 0.62,
        alpha_cutoff: 0.0,
        texture: None,
        uv_scale: [1.0, 1.0],
        uv_offset: [0.0, 0.0],
        uv_rotation_radians: 0.0,
        uv_pivot: [0.5, 0.5],
        wrap: PreparedWrapMode::Clamp,
        filtering: PreparedFilterMode::Linear,
        cull_mode: PreparedCullMode::Back,
        blend_mode: 0,
    })
}

fn fallback_color<'a>(object: &'a MeshObjectDto, _slot: &str) -> &'a str {
    &object.fill
}

fn cube_surfaces(object: &MeshObjectDto) -> Vec<RawSurface> {
    let (x0, x1, y0, y1, z0, z1) = local_bounds(object);
    vec![
        quad_surface(
            "main",
            [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            [0.0, 0.0, 1.0],
        ),
        quad_surface(
            "face:back",
            [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
            [0.0, 0.0, -1.0],
        ),
        quad_surface(
            "face:right",
            [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
            [1.0, 0.0, 0.0],
        ),
        quad_surface(
            "face:left",
            [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
            [-1.0, 0.0, 0.0],
        ),
        quad_surface(
            "face:top",
            [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            [0.0, -1.0, 0.0],
        ),
        quad_surface(
            "face:bottom",
            [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
            [0.0, 1.0, 0.0],
        ),
    ]
}

fn rect_plane_surface(object: &MeshObjectDto) -> RawSurface {
    let x0 = -(object.anchor.x as f32);
    let x1 = object.width as f32 - object.anchor.x as f32;
    let y0 = -(object.anchor.y as f32);
    let y1 = object.height as f32 - object.anchor.y as f32;
    quad_surface(
        "main",
        [[x0, y0, 0.0], [x1, y0, 0.0], [x1, y1, 0.0], [x0, y1, 0.0]],
        [0.0, 0.0, 1.0],
    )
}

fn ellipse_plane_surface(object: &MeshObjectDto) -> RawSurface {
    const SEGMENTS: u32 = 64;
    let center = Vec3::new(
        object.width as f32 * 0.5 - object.anchor.x as f32,
        object.height as f32 * 0.5 - object.anchor.y as f32,
        0.0,
    );
    let radius_x = object.width as f32 * 0.5;
    let radius_y = object.height as f32 * 0.5;
    let normal = Vec3::Z;
    let mut vertices = vec![vertex(center, normal, [0.5, 0.5])];
    for segment in 0..=SEGMENTS {
        let unit = segment as f32 / SEGMENTS as f32;
        let angle = std::f32::consts::TAU * unit;
        let u = angle.cos();
        let v = angle.sin();
        vertices.push(vertex(
            center + Vec3::new(u * radius_x, v * radius_y, 0.0),
            normal,
            [(u + 1.0) * 0.5, (v + 1.0) * 0.5],
        ));
    }
    let mut indices = Vec::with_capacity((SEGMENTS * 3) as usize);
    for segment in 0..SEGMENTS {
        indices.extend_from_slice(&[0, segment + 1, segment + 2]);
    }
    RawSurface {
        slot_key: "main".to_string(),
        vertices,
        indices,
        authored_material: None,
    }
}

fn sphere_surfaces(object: &MeshObjectDto) -> Vec<RawSurface> {
    const WIDTH_SEGMENTS: u32 = 40;
    const HEIGHT_SEGMENTS: u32 = 24;
    let anchor = anchor3d(object);
    let center = Vec3::new(
        object.width as f32 * 0.5 - anchor.x,
        object.height as f32 * 0.5 - anchor.y,
        object.depth as f32 * 0.5 - anchor.z,
    );
    let radius = Vec3::new(
        object.width as f32 * 0.5,
        object.height as f32 * 0.5,
        object.depth as f32 * 0.5,
    );
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for row in 0..=HEIGHT_SEGMENTS {
        let v = row as f32 / HEIGHT_SEGMENTS as f32;
        let phi = std::f32::consts::PI * v;
        for column in 0..=WIDTH_SEGMENTS {
            let u = column as f32 / WIDTH_SEGMENTS as f32;
            let theta = std::f32::consts::TAU * u;
            let unit = Vec3::new(phi.sin() * theta.cos(), phi.cos(), phi.sin() * theta.sin());
            let position = center + unit * radius;
            let normal = Vec3::new(
                unit.x / radius.x.max(0.0001),
                unit.y / radius.y.max(0.0001),
                unit.z / radius.z.max(0.0001),
            )
            .normalize_or_zero();
            vertices.push(vertex(position, normal, [u, v]));
        }
    }
    for row in 0..HEIGHT_SEGMENTS {
        for column in 0..WIDTH_SEGMENTS {
            let a = row * (WIDTH_SEGMENTS + 1) + column;
            let b = a + 1;
            let d = (row + 1) * (WIDTH_SEGMENTS + 1) + column;
            let c = d + 1;
            indices.extend_from_slice(&[a, b, c, a, c, d]);
        }
    }
    vec![RawSurface {
        slot_key: "main".to_string(),
        vertices,
        indices,
        authored_material: None,
    }]
}

fn cylinder_surfaces(object: &MeshObjectDto) -> Vec<RawSurface> {
    const SEGMENTS: u32 = 48;
    let (x0, x1, y0, y1, z0, z1) = local_bounds(object);
    let center_x = (x0 + x1) * 0.5;
    let center_z = (z0 + z1) * 0.5;
    let radius_x = (x1 - x0) * 0.5;
    let radius_z = (z1 - z0) * 0.5;
    let mut side_vertices = Vec::new();
    let mut side_indices = Vec::new();
    for segment in 0..=SEGMENTS {
        let u = segment as f32 / SEGMENTS as f32;
        let angle = std::f32::consts::TAU * u;
        let unit = Vec3::new(angle.cos(), 0.0, angle.sin());
        let normal = Vec3::new(
            unit.x / radius_x.max(0.0001),
            0.0,
            unit.z / radius_z.max(0.0001),
        )
        .normalize_or_zero();
        let x = center_x + unit.x * radius_x;
        let z = center_z + unit.z * radius_z;
        side_vertices.push(vertex(Vec3::new(x, y0, z), normal, [u, 0.0]));
        side_vertices.push(vertex(Vec3::new(x, y1, z), normal, [u, 1.0]));
    }
    for segment in 0..SEGMENTS {
        let a = segment * 2;
        side_indices.extend_from_slice(&[a, a + 2, a + 3, a, a + 3, a + 1]);
    }

    let top = cap_surface(
        "face:cap-top",
        center_x,
        center_z,
        radius_x,
        radius_z,
        y0,
        -1.0,
        SEGMENTS,
    );
    let bottom = cap_surface(
        "face:cap-bottom",
        center_x,
        center_z,
        radius_x,
        radius_z,
        y1,
        1.0,
        SEGMENTS,
    );
    vec![
        RawSurface {
            slot_key: "main".to_string(),
            vertices: side_vertices,
            indices: side_indices,
            authored_material: None,
        },
        top,
        bottom,
    ]
}

fn torus_surfaces(object: &MeshObjectDto) -> Vec<RawSurface> {
    const RING_SEGMENTS: u32 = 64;
    const TUBE_SEGMENTS: u32 = 24;
    let anchor = anchor3d(object);
    let center = Vec3::new(
        object.width as f32 * 0.5 - anchor.x,
        object.height as f32 * 0.5 - anchor.y,
        object.depth as f32 * 0.5 - anchor.z,
    );
    let scale = Vec3::new(
        object.width as f32,
        object.height as f32,
        object.depth as f32 / 0.3,
    );
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for ring in 0..=RING_SEGMENTS {
        let u = ring as f32 / RING_SEGMENTS as f32;
        let ring_angle = std::f32::consts::TAU * u;
        for tube in 0..=TUBE_SEGMENTS {
            let v = tube as f32 / TUBE_SEGMENTS as f32;
            let tube_angle = std::f32::consts::TAU * v;
            let radius = 0.35 + 0.15 * tube_angle.cos();
            let unscaled = Vec3::new(
                radius * ring_angle.cos(),
                radius * ring_angle.sin(),
                0.15 * tube_angle.sin(),
            );
            let source_normal = Vec3::new(
                tube_angle.cos() * ring_angle.cos(),
                tube_angle.cos() * ring_angle.sin(),
                tube_angle.sin(),
            );
            let normal = Vec3::new(
                source_normal.x / scale.x.max(0.0001),
                source_normal.y / scale.y.max(0.0001),
                source_normal.z / scale.z.max(0.0001),
            )
            .normalize_or_zero();
            vertices.push(vertex(center + unscaled * scale, normal, [u, v]));
        }
    }
    for ring in 0..RING_SEGMENTS {
        for tube in 0..TUBE_SEGMENTS {
            let a = ring * (TUBE_SEGMENTS + 1) + tube;
            let b = (ring + 1) * (TUBE_SEGMENTS + 1) + tube;
            let c = b + 1;
            let d = a + 1;
            indices.extend_from_slice(&[a, b, c, a, c, d]);
        }
    }
    vec![RawSurface {
        slot_key: "main".to_string(),
        vertices,
        indices,
        authored_material: None,
    }]
}

fn import_model_surfaces(
    object: &MeshObjectDto,
    assets: &HashMap<String, &AssetDto>,
    cache: &mut AssetLoadCache,
    warnings: &mut Vec<String>,
) -> Option<Vec<RawSurface>> {
    let asset = object
        .model_asset_id
        .as_ref()
        .and_then(|asset_id| assets.get(asset_id).copied())
        .or_else(|| {
            object.src.as_ref().and_then(|source| {
                assets
                    .values()
                    .copied()
                    .find(|asset| &asset.source == source)
            })
        });
    let Some(asset) = asset else {
        warnings.push(format!(
            "model mesh {} has no resolvable model asset and is not rendered",
            object.id
        ));
        return None;
    };
    let bytes = match load_asset_bytes(asset, cache) {
        Ok(bytes) => bytes,
        Err(error) => {
            warnings.push(format!(
                "model mesh {} asset {} could not be loaded and is not rendered: {error}",
                object.id, asset.asset_id
            ));
            return None;
        }
    };
    let (document, buffers, images) = match gltf::import_slice(&bytes) {
        Ok(imported) => imported,
        Err(error) => {
            warnings.push(format!(
                "model mesh {} asset {} is not valid embedded glTF/GLB and is not rendered: {error}",
                object.id, asset.asset_id
            ));
            return None;
        }
    };
    let model_textures: Vec<Option<PreparedTexture>> =
        images.iter().map(gltf_image_to_texture).collect();
    let mut raw = Vec::new();
    if let Some(scene) = document
        .default_scene()
        .or_else(|| document.scenes().next())
    {
        for node in scene.nodes() {
            collect_gltf_node(node, Mat4::IDENTITY, &buffers, &model_textures, &mut raw);
        }
    }
    if raw.is_empty() {
        warnings.push(format!(
            "model mesh {} contains no triangle primitives and is not rendered",
            object.id
        ));
        return None;
    }

    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    for surface in &raw {
        for vertex in &surface.vertices {
            let position = Vec3::from_array(vertex.position);
            min = min.min(position);
            max = max.max(position);
        }
    }
    let size = max - min;
    let fit = (object.width as f32 / size.x.max(0.0001))
        .min(object.height as f32 / size.y.max(0.0001))
        .min(object.depth as f32 / size.z.max(0.0001));
    let source_center = (min + max) * 0.5;
    let anchor = anchor3d(object);
    let destination_center = Vec3::new(
        object.width as f32 * 0.5 - anchor.x,
        object.height as f32 * 0.5 - anchor.y,
        object.depth as f32 * 0.5 - anchor.z,
    );
    for surface in &mut raw {
        for vertex in &mut surface.vertices {
            let fitted =
                (Vec3::from_array(vertex.position) - source_center) * fit + destination_center;
            vertex.position = fitted.to_array();
        }
    }
    Some(raw)
}

fn collect_gltf_node(
    node: gltf::Node<'_>,
    parent_transform: Mat4,
    buffers: &[gltf::buffer::Data],
    images: &[Option<PreparedTexture>],
    output: &mut Vec<RawSurface>,
) {
    let local = Mat4::from_cols_array_2d(&node.transform().matrix());
    let transform = parent_transform * local;
    let normal_transform = Mat3::from_mat4(transform).inverse().transpose();
    if let Some(mesh) = node.mesh() {
        for primitive in mesh.primitives() {
            if primitive.mode() != gltf::mesh::Mode::Triangles {
                continue;
            }
            let reader = primitive.reader(|buffer| Some(&buffers[buffer.index()].0));
            let material = primitive.material();
            let base_color_info = material.pbr_metallic_roughness().base_color_texture();
            let tex_coord_set = base_color_info
                .as_ref()
                .map(|info| info.tex_coord())
                .unwrap_or(0);
            let Some(positions) = reader.read_positions() else {
                continue;
            };
            let positions: Vec<[f32; 3]> = positions.collect();
            let normals: Vec<[f32; 3]> = reader
                .read_normals()
                .map(|values| values.collect())
                .unwrap_or_else(|| generate_normals(&positions, reader.read_indices()));
            let uvs: Vec<[f32; 2]> = reader
                .read_tex_coords(tex_coord_set)
                .map(|values| values.into_f32().collect())
                .unwrap_or_else(|| vec![[0.0, 0.0]; positions.len()]);
            let indices: Vec<u32> = reader
                .read_indices()
                .map(|indices| indices.into_u32().collect())
                .unwrap_or_else(|| (0..positions.len() as u32).collect());
            let vertices = positions
                .iter()
                .enumerate()
                .map(|(index, position)| {
                    let world_position =
                        transform * Vec4::new(position[0], position[1], position[2], 1.0);
                    let source_normal =
                        Vec3::from_array(normals.get(index).copied().unwrap_or([0.0, 0.0, 1.0]));
                    PreparedMeshVertex {
                        position: world_position.truncate().to_array(),
                        normal: (normal_transform * source_normal)
                            .normalize_or_zero()
                            .to_array(),
                        uv: uvs.get(index).copied().unwrap_or([0.0, 0.0]),
                    }
                })
                .collect();
            let material_index = material.index().unwrap_or(0);
            output.push(RawSurface {
                slot_key: format!("element:{material_index}"),
                vertices,
                indices,
                authored_material: Some(authored_gltf_material(material, images)),
            });
        }
    }
    for child in node.children() {
        collect_gltf_node(child, transform, buffers, images, output);
    }
}

fn authored_gltf_material(
    material: gltf::Material<'_>,
    images: &[Option<PreparedTexture>],
) -> PreparedMeshMaterial {
    let pbr = material.pbr_metallic_roughness();
    let factor = pbr.base_color_factor();
    let texture = pbr
        .base_color_texture()
        .and_then(|info| images.get(info.texture().source().index()))
        .cloned()
        .flatten();
    let sampler = pbr
        .base_color_texture()
        .map(|info| info.texture().sampler());
    let wrap = sampler
        .as_ref()
        .map(|sampler| {
            use gltf::texture::WrappingMode;
            match (sampler.wrap_s(), sampler.wrap_t()) {
                (WrappingMode::MirroredRepeat, _) | (_, WrappingMode::MirroredRepeat) => {
                    PreparedWrapMode::MirrorRepeat
                }
                (WrappingMode::Repeat, _) | (_, WrappingMode::Repeat) => PreparedWrapMode::Repeat,
                _ => PreparedWrapMode::Clamp,
            }
        })
        .unwrap_or(PreparedWrapMode::Repeat);
    let filtering = sampler
        .as_ref()
        .map(|sampler| {
            use gltf::texture::{MagFilter, MinFilter};
            let nearest_mag = sampler.mag_filter() == Some(MagFilter::Nearest);
            let nearest_min = matches!(
                sampler.min_filter(),
                Some(MinFilter::Nearest)
                    | Some(MinFilter::NearestMipmapNearest)
                    | Some(MinFilter::NearestMipmapLinear)
            );
            if nearest_mag || nearest_min {
                PreparedFilterMode::Nearest
            } else {
                PreparedFilterMode::Linear
            }
        })
        .unwrap_or(PreparedFilterMode::Linear);
    let alpha_cutoff = match material.alpha_mode() {
        gltf::material::AlphaMode::Mask => material.alpha_cutoff().unwrap_or(0.5),
        _ => 0.0,
    };
    PreparedMeshMaterial {
        base_color_linear: factor,
        emissive_linear: material.emissive_factor(),
        emissive_intensity: 1.0,
        // glTF's authored metallic/roughness material is PBR unless GrapiX
        // replaces the element with an explicit material slot.
        lit: true,
        metalness: pbr.metallic_factor(),
        roughness: pbr.roughness_factor(),
        alpha_cutoff,
        texture,
        uv_scale: [1.0, 1.0],
        uv_offset: [0.0, 0.0],
        uv_rotation_radians: 0.0,
        uv_pivot: [0.5, 0.5],
        wrap,
        filtering,
        cull_mode: if material.double_sided() {
            PreparedCullMode::None
        } else {
            PreparedCullMode::Back
        },
        blend_mode: 0,
    }
}

fn gltf_image_to_texture(image: &gltf::image::Data) -> Option<PreparedTexture> {
    use gltf::image::Format;
    let rgba8 = match image.format {
        Format::R8 => image
            .pixels
            .iter()
            .flat_map(|value| [*value, *value, *value, 255])
            .collect(),
        Format::R8G8 => image
            .pixels
            .chunks_exact(2)
            .flat_map(|pixel| [pixel[0], pixel[0], pixel[0], pixel[1]])
            .collect(),
        Format::R8G8B8 => image
            .pixels
            .chunks_exact(3)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
            .collect(),
        Format::R8G8B8A8 => image.pixels.clone(),
        _ => return None,
    };
    Some(PreparedTexture {
        width: image.width,
        height: image.height,
        rgba8,
        srgb: true,
    })
}

fn generate_normals(
    positions: &[[f32; 3]],
    indices: Option<gltf::mesh::util::ReadIndices<'_>>,
) -> Vec<[f32; 3]> {
    let indices: Vec<u32> = indices
        .map(|indices| indices.into_u32().collect())
        .unwrap_or_else(|| (0..positions.len() as u32).collect());
    let mut normals = vec![Vec3::ZERO; positions.len()];
    for triangle in indices.chunks_exact(3) {
        let a = Vec3::from_array(positions[triangle[0] as usize]);
        let b = Vec3::from_array(positions[triangle[1] as usize]);
        let c = Vec3::from_array(positions[triangle[2] as usize]);
        let face = (b - a).cross(c - a);
        for index in triangle {
            normals[*index as usize] += face;
        }
    }
    normals
        .into_iter()
        .map(|normal| normal.normalize_or_zero().to_array())
        .collect()
}

fn load_asset_texture(
    asset: &AssetDto,
    cache: &mut AssetLoadCache,
) -> Result<PreparedTexture, String> {
    if let Some(cached) = cache.textures.get(&asset.asset_id) {
        return cached.clone();
    }
    let result = load_asset_bytes(asset, cache).and_then(|bytes| {
        let image = image::load_from_memory(&bytes)
            .map_err(|error| format!("unsupported image data: {error}"))?
            .to_rgba8();
        let (width, height) = image.dimensions();
        Ok(PreparedTexture {
            width,
            height,
            rgba8: image.into_raw(),
            srgb: asset.color_space.as_deref() != Some("linear"),
        })
    });
    cache
        .textures
        .insert(asset.asset_id.clone(), result.clone());
    result
}

fn load_asset_bytes(asset: &AssetDto, cache: &mut AssetLoadCache) -> Result<Vec<u8>, String> {
    if let Some(cached) = cache.bytes.get(&asset.asset_id) {
        return cached.clone();
    }
    let result = if asset.source.starts_with("data:") {
        decode_data_url(&asset.source)
    } else {
        read_content_addressed_asset(asset)
    };
    cache.bytes.insert(asset.asset_id.clone(), result.clone());
    result
}

fn decode_data_url(source: &str) -> Result<Vec<u8>, String> {
    let (metadata, payload) = source
        .split_once(',')
        .ok_or_else(|| "data URL has no payload".to_string())?;
    if !metadata.ends_with(";base64") {
        return Err("only base64 data URLs are accepted by the native renderer".to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("invalid base64 data URL: {error}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAssetIndex {
    relative_path: String,
}

fn read_content_addressed_asset(asset: &AssetDto) -> Result<Vec<u8>, String> {
    let storage_id = asset
        .storage_asset_id
        .as_deref()
        .or_else(|| storage_id_from_source(&asset.source))
        .unwrap_or(&asset.asset_id);
    if storage_id.is_empty()
        || !storage_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err("unsafe storage asset id".to_string());
    }
    let data_root = std::env::var_os("GRAPIX_DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("data")
        });
    let index_path = data_root
        .join("assets")
        .join("index")
        .join(format!("{storage_id}.json"));
    let index: StoredAssetIndex =
        serde_json::from_slice(&std::fs::read(&index_path).map_err(|error| {
            format!("cannot read asset index {}: {error}", index_path.display())
        })?)
        .map_err(|error| format!("asset index is invalid: {error}"))?;
    let candidate = data_root.join(Path::new(&index.relative_path));
    let canonical_root = data_root
        .canonicalize()
        .map_err(|error| format!("cannot resolve data root: {error}"))?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|error| format!("cannot resolve stored asset: {error}"))?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err("stored asset path escapes the GrapiX data root".to_string());
    }
    std::fs::read(&canonical_candidate).map_err(|error| {
        format!(
            "cannot read stored asset {}: {error}",
            canonical_candidate.display()
        )
    })
}

fn storage_id_from_source(source: &str) -> Option<&str> {
    let marker = "/api/assets/";
    let start = source.find(marker)? + marker.len();
    let rest = &source[start..];
    let end = rest.find("/content")?;
    Some(&rest[..end])
}

fn parse_material_binding(value: &Value) -> Option<MaterialBindingRef> {
    if let Some(material_id) = value.as_str() {
        return Some(MaterialBindingRef {
            material_id: material_id.to_string(),
            instance_id: None,
            overrides: HashMap::new(),
        });
    }
    let object = value.as_object()?;
    Some(MaterialBindingRef {
        material_id: object.get("materialId")?.as_str()?.to_string(),
        instance_id: object
            .get("instanceId")
            .and_then(Value::as_str)
            .map(str::to_string),
        overrides: object
            .get("overrides")
            .and_then(Value::as_object)
            .map(|values| values.clone().into_iter().collect())
            .unwrap_or_default(),
    })
}

fn resolved_string_parameter(
    name: &str,
    binding: &HashMap<String, Value>,
    instance: Option<&HashMap<String, Value>>,
    material: &HashMap<String, Value>,
) -> Option<String> {
    binding
        .get(name)
        .or_else(|| instance.and_then(|values| values.get(name)))
        .or_else(|| material.get(name))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn resolved_number_parameter(
    name: &str,
    binding: &HashMap<String, Value>,
    instance: Option<&HashMap<String, Value>>,
    material: &HashMap<String, Value>,
) -> Option<f64> {
    binding
        .get(name)
        .or_else(|| instance.and_then(|values| values.get(name)))
        .or_else(|| material.get(name))
        .and_then(Value::as_f64)
}

fn resolved_vec2_parameter(
    name: &str,
    binding: &HashMap<String, Value>,
    instance: Option<&HashMap<String, Value>>,
    material: &HashMap<String, Value>,
) -> Option<[f64; 2]> {
    let value = binding
        .get(name)
        .or_else(|| instance.and_then(|values| values.get(name)))
        .or_else(|| material.get(name))?
        .as_array()?;
    if value.len() < 2 {
        return None;
    }
    Some([value[0].as_f64()?, value[1].as_f64()?])
}

fn default_texture_slot() -> TextureSlotDto {
    TextureSlotDto {
        name: "baseTexture".to_string(),
        asset_id: None,
        wrap: Some("clamp".to_string()),
        filtering: Some("linear".to_string()),
        uv_scale: [1.0, 1.0],
        uv_offset: [0.0, 0.0],
        uv_rotation: 0.0,
        uv_pivot: [0.5, 0.5],
        flip_x: false,
        flip_y: false,
    }
}

fn blend_mode_id(value: &str) -> Option<u32> {
    match value {
        "normal" => Some(0),
        "multiply" => Some(1),
        "screen" => Some(2),
        "add" => Some(3),
        "darken" => Some(4),
        "lighten" => Some(5),
        _ => None,
    }
}

fn local_bounds(object: &MeshObjectDto) -> (f32, f32, f32, f32, f32, f32) {
    let anchor = anchor3d(object);
    (
        -anchor.x,
        object.width as f32 - anchor.x,
        -anchor.y,
        object.height as f32 - anchor.y,
        -anchor.z,
        object.depth as f32 - anchor.z,
    )
}

fn anchor3d(object: &MeshObjectDto) -> Vec3 {
    object
        .anchor3d
        .map(|anchor| Vec3::new(anchor.x as f32, anchor.y as f32, anchor.z as f32))
        .unwrap_or_else(|| {
            Vec3::new(
                object.anchor.x as f32,
                object.anchor.y as f32,
                object.depth as f32 * 0.5,
            )
        })
}

fn quad_surface(slot_key: &str, corners: [[f32; 3]; 4], normal: [f32; 3]) -> RawSurface {
    let uvs = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    RawSurface {
        slot_key: slot_key.to_string(),
        vertices: corners
            .into_iter()
            .zip(uvs)
            .map(|(position, uv)| PreparedMeshVertex {
                position,
                normal,
                uv,
            })
            .collect(),
        indices: vec![0, 1, 2, 0, 2, 3],
        authored_material: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn cap_surface(
    slot_key: &str,
    center_x: f32,
    center_z: f32,
    radius_x: f32,
    radius_z: f32,
    y: f32,
    normal_y: f32,
    segments: u32,
) -> RawSurface {
    let mut vertices = vec![vertex(
        Vec3::new(center_x, y, center_z),
        Vec3::new(0.0, normal_y, 0.0),
        [0.5, 0.5],
    )];
    for segment in 0..=segments {
        let angle = std::f32::consts::TAU * segment as f32 / segments as f32;
        vertices.push(vertex(
            Vec3::new(
                center_x + angle.cos() * radius_x,
                y,
                center_z + angle.sin() * radius_z,
            ),
            Vec3::new(0.0, normal_y, 0.0),
            [angle.cos() * 0.5 + 0.5, angle.sin() * 0.5 + 0.5],
        ));
    }
    let mut indices = Vec::new();
    for segment in 0..segments {
        if normal_y < 0.0 {
            indices.extend_from_slice(&[0, segment + 2, segment + 1]);
        } else {
            indices.extend_from_slice(&[0, segment + 1, segment + 2]);
        }
    }
    RawSurface {
        slot_key: slot_key.to_string(),
        vertices,
        indices,
        authored_material: None,
    }
}

fn vertex(position: Vec3, normal: Vec3, uv: [f32; 2]) -> PreparedMeshVertex {
    PreparedMeshVertex {
        position: position.to_array(),
        normal: normal.to_array(),
        uv,
    }
}

fn parse_hex_color(raw: &str) -> Option<[f32; 4]> {
    let hex = raw.trim().strip_prefix('#')?;
    let (r, g, b, a) = match hex.len() {
        3 => {
            let mut digits = hex.chars().map(|character| character.to_digit(16));
            let r = digits.next()??;
            let g = digits.next()??;
            let b = digits.next()??;
            (r * 17, g * 17, b * 17, 255)
        }
        6 | 8 => {
            let r = u32::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u32::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u32::from_str_radix(&hex[4..6], 16).ok()?;
            let a = if hex.len() == 8 {
                u32::from_str_radix(&hex[6..8], 16).ok()?
            } else {
                255
            };
            (r, g, b, a)
        }
        _ => return None,
    };
    Some([
        r as f32 / 255.0,
        g as f32 / 255.0,
        b as f32 / 255.0,
        a as f32 / 255.0,
    ])
}

fn srgb_straight_to_linear(srgb: [f32; 4]) -> [f32; 4] {
    [
        srgb_to_linear(srgb[0]),
        srgb_to_linear(srgb[1]),
        srgb_to_linear(srgb[2]),
        srgb[3],
    ]
}

fn srgb_to_linear(channel: f32) -> f32 {
    if channel <= 0.04045 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mesh_object(kind: &str) -> Value {
        json!({
            "id": "mesh_1",
            "name": "Mesh",
            "type": "mesh",
            "meshKind": kind,
            "x": 960,
            "y": 540,
            "zDepth": 0,
            "zIndex": 0,
            "layerId": "main",
            "width": 320,
            "height": 240,
            "depth": 180,
            "rotation": 0,
            "rotationX": 10,
            "rotationY": 25,
            "rotationZ": 0,
            "scaleX": 1,
            "scaleY": 1,
            "scaleZ": 1,
            "anchor": { "x": 160, "y": 120 },
            "anchor3d": { "x": 160, "y": 120, "z": 90 },
            "opacity": 1,
            "visible": true,
            "fill": "#4080c0",
            "materialSlots": {}
        })
    }

    fn scene_with(object: Value) -> Value {
        json!({
            "assets": [],
            "materials": [],
            "materialInstances": [],
            "objects": [object]
        })
    }

    #[test]
    fn cube_has_six_real_triangle_surfaces() {
        let object = mesh_object("cube");
        let mut warnings = Vec::new();
        let meshes = prepare_meshes(&scene_with(object.clone()), &[object], &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(meshes.len(), 1);
        assert_eq!(meshes[0].surfaces.len(), 6);
        assert_eq!(
            meshes[0]
                .surfaces
                .iter()
                .map(|surface| surface.indices.len() / 3)
                .sum::<usize>(),
            12
        );
    }

    #[test]
    fn sphere_cylinder_and_torus_are_tessellated_not_symbols() {
        for kind in ["sphere", "cylinder", "torus"] {
            let object = mesh_object(kind);
            let mut warnings = Vec::new();
            let meshes = prepare_meshes(&scene_with(object.clone()), &[object], &mut warnings);
            assert!(warnings.is_empty(), "{kind}: {warnings:?}");
            let triangle_count = meshes[0]
                .surfaces
                .iter()
                .map(|surface| surface.indices.len() / 3)
                .sum::<usize>();
            assert!(
                triangle_count > 100,
                "{kind} has only {triangle_count} triangles"
            );
        }
    }

    #[test]
    fn one_cube_face_accepts_an_embedded_texture_material() {
        let mut object = mesh_object("cube");
        object["materialSlots"] = json!({ "face:right": "mat_texture" });
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let scene = json!({
            "assets": [{
                "assetId": "asset_texture",
                "source": format!("data:image/png;base64,{png}"),
                "mimeType": "image/png"
            }],
            "materials": [{
                "materialId": "mat_texture",
                "name": "Texture",
                "type": "image",
                "assetId": "asset_texture",
                "opacity": 1,
                "parameters": {},
                "textureSlots": [{
                    "name": "baseTexture",
                    "assetId": "asset_texture",
                    "fit": "stretch",
                    "wrap": "clamp",
                    "filtering": "linear",
                    "uvScale": [1, 1],
                    "uvOffset": [0, 0],
                    "uvRotation": 0,
                    "uvPivot": [0.5, 0.5],
                    "flipX": false,
                    "flipY": false
                }]
            }],
            "materialInstances": [],
            "objects": [object]
        });
        let mut warnings = Vec::new();
        let meshes = prepare_meshes(&scene, scene["objects"].as_array().unwrap(), &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        let right = meshes[0]
            .surfaces
            .iter()
            .find(|surface| surface.slot_key == "face:right")
            .unwrap();
        assert_eq!(right.material.texture.as_ref().unwrap().width, 1);
    }

    #[test]
    fn canonical_pbr_texture_on_rect_is_prepared_as_a_lit_plane() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let object = json!({
            "id": "rect_surface",
            "name": "Physical Rectangle",
            "type": "rect",
            "x": 100,
            "y": 80,
            "zDepth": 12,
            "zIndex": 3,
            "layerId": "main",
            "width": 320,
            "height": 180,
            "rotation": 15,
            "scaleX": 1,
            "scaleY": 1,
            "scaleZ": 1,
            "anchor": { "x": 160, "y": 90 },
            "opacity": 1,
            "visible": true,
            "fill": "#ffffff",
            "materialSlots": { "main": "mat_surface" }
        });
        let scene = json!({
            "assets": [{
                "assetId": "asset_texture",
                "source": format!("data:image/png;base64,{png}"),
                "colorSpace": "srgb"
            }],
            "materials": [{
                "materialId": "mat_surface",
                "name": "Standard Material",
                "type": "pbr",
                "opacity": 1,
                "parameters": {
                    "baseColor": "#ffffff",
                    "metalness": 0.3,
                    "roughness": 0.45
                },
                "textureSlots": [{
                    "name": "baseTexture",
                    "assetId": "asset_texture",
                    "wrap": "repeat",
                    "filtering": "linear",
                    "uvScale": [2, 1],
                    "uvOffset": [0.25, 0],
                    "uvRotation": 0,
                    "uvPivot": [0.5, 0.5]
                }]
            }],
            "materialInstances": [],
            "objects": [object]
        });
        let mut warnings = Vec::new();
        let meshes = prepare_meshes(&scene, scene["objects"].as_array().unwrap(), &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(meshes.len(), 1);
        let surface = &meshes[0].surfaces[0];
        assert_eq!(surface.vertices.len(), 4);
        assert_eq!(surface.indices.len(), 6);
        assert!(surface.material.lit);
        assert!(surface.material.texture.is_some());
        assert_eq!(surface.material.uv_scale, [2.0, 1.0]);
        assert_eq!(surface.material.wrap, PreparedWrapMode::Repeat);
    }

    #[test]
    fn imported_gltf_material_element_accepts_an_independent_texture_override() {
        let fixture_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            // The project API moved under Editor/ in the Phase 2 migration; the fixture
            // travelled with it.
            "/../../Editor/services/project-api/tests/fixtures/two-material-triangles.gltf"
        );
        let model_bytes = std::fs::read(fixture_path).expect("glTF fixture must exist");
        let model_base64 = base64::engine::general_purpose::STANDARD.encode(model_bytes);
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let mut object = mesh_object("model");
        object["modelAssetId"] = json!("asset_model");
        object["materialSlots"] = json!({ "element:1": "mat_texture" });
        let scene = json!({
            "assets": [
                {
                    "assetId": "asset_model",
                    "source": format!("data:model/gltf+json;base64,{model_base64}")
                },
                {
                    "assetId": "asset_texture",
                    "source": format!("data:image/png;base64,{png}")
                }
            ],
            "materials": [{
                "materialId": "mat_texture",
                "name": "Sponsor texture",
                "type": "image",
                "assetId": "asset_texture",
                "opacity": 1,
                "parameters": { "baseColor": "#ffffff" },
                "textureSlots": [{
                    "name": "baseTexture",
                    "assetId": "asset_texture",
                    "wrap": "clamp",
                    "filtering": "nearest",
                    "uvScale": [1, 1],
                    "uvOffset": [0, 0],
                    "uvRotation": 0,
                    "uvPivot": [0.5, 0.5]
                }]
            }],
            "materialInstances": [],
            "objects": [object]
        });
        let mut warnings = Vec::new();
        let meshes = prepare_meshes(&scene, scene["objects"].as_array().unwrap(), &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(meshes[0].surfaces.len(), 2);
        let body = meshes[0]
            .surfaces
            .iter()
            .find(|surface| surface.slot_key == "element:0")
            .unwrap();
        let sponsor = meshes[0]
            .surfaces
            .iter()
            .find(|surface| surface.slot_key == "element:1")
            .unwrap();
        assert!(body.material.texture.is_none());
        assert!(sponsor.material.texture.is_some());
    }

    #[test]
    fn legacy_material_aliases_share_the_native_physical_lighting_branch() {
        for (material_type, expected_lit) in [
            ("material", true),
            ("solid-color", true),
            ("image", true),
            ("unlit-texture", true),
            ("additive-glow", false),
            ("basic-lit", true),
            ("pbr", true),
        ] {
            let mut object = mesh_object("cube");
            object["materialSlots"] = json!({ "main": "mat_test" });
            let scene = json!({
                "assets": [],
                "materials": [{
                    "materialId": "mat_test",
                    "name": material_type,
                    "type": material_type,
                    "opacity": 1,
                    "parameters": { "baseColor": "#ffffff" }
                }],
                "materialInstances": [],
                "objects": [object]
            });
            let mut warnings = Vec::new();
            let meshes =
                prepare_meshes(&scene, scene["objects"].as_array().unwrap(), &mut warnings);
            assert!(warnings.is_empty(), "{material_type}: {warnings:?}");
            let main = meshes[0]
                .surfaces
                .iter()
                .find(|surface| surface.slot_key == "main")
                .unwrap();
            assert_eq!(
                main.material.lit, expected_lit,
                "{material_type} chose the wrong native lighting branch"
            );
        }
    }

    #[test]
    fn primitive_main_binding_changes_only_the_primary_surface() {
        let mut object = mesh_object("cube");
        object["materialSlots"] = json!({ "main": "mat_unlit" });
        let scene = json!({
            "assets": [],
            "materials": [{
                "materialId": "mat_unlit",
                "name": "Primary face",
                "type": "solid-color",
                "opacity": 1,
                "parameters": { "baseColor": "#ff0000" }
            }],
            "materialInstances": [],
            "objects": [object]
        });
        let mut warnings = Vec::new();
        let meshes = prepare_meshes(&scene, scene["objects"].as_array().unwrap(), &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(meshes[0].surfaces.len(), 6);
        for surface in &meshes[0].surfaces {
            assert!(surface.material.lit);
            let is_bound_red = surface.material.base_color_linear[0] > 0.99
                && surface.material.base_color_linear[1] < 0.01
                && surface.material.base_color_linear[2] < 0.01;
            assert_eq!(is_bound_red, surface.slot_key == "main");
        }
    }

    #[test]
    fn image_material_prefers_authored_tint_over_legacy_base_color() {
        let mut object = mesh_object("cube");
        object["materialSlots"] = json!({ "main": "mat_image" });
        let scene = json!({
            "assets": [],
            "materials": [{
                "materialId": "mat_image",
                "name": "Tinted image",
                "type": "image",
                "opacity": 1,
                "parameters": {
                    "baseColor": "#ff0000",
                    "tint": "#00ff00"
                }
            }],
            "materialInstances": [],
            "objects": [object]
        });
        let mut warnings = Vec::new();
        let meshes = prepare_meshes(&scene, scene["objects"].as_array().unwrap(), &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        let color = meshes[0]
            .surfaces
            .iter()
            .find(|surface| surface.slot_key == "main")
            .unwrap()
            .material
            .base_color_linear;
        assert_eq!(color, [0.0, 1.0, 0.0, 1.0]);
    }
}
