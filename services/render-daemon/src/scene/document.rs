//! `SceneDocument` deserialization and render preparation.
//!
//! Type-alignment strategy (documented in docs/render-daemon-architecture.md):
//! the repository has no JSON Schema for `SceneDocument` and no schema
//! generation from TypeScript, so this is a **versioned Rust DTO layer with
//! contract tests** — option 3 of the preferred integration order. The structs
//! below mirror `packages/shared-types/src/index.ts` for the fields the
//! renderer consumes; drift is caught by tests/scene_contract.rs, which parses
//! the fixture JSON emitted from the TypeScript source of truth
//! (`packages/shared-types/fixtures/scene-document.v1.json`).
//!
//! Deserialization is deliberately tolerant of *unknown* fields (the editor
//! may add fields the daemon does not use yet) but strict about the fields it
//! renders from: a scene with the wrong `version` or a malformed canvas is
//! rejected, not guessed at.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

use super::camera::{resolve_active_camera, PreparedCamera, CAMERA_OBJECT_TYPE};
use super::diagnostics::{DiagnosticSeverity, DiagnosticSink, SceneDiagnostic};
use super::mesh_prepare::{prepare_meshes, PreparedMesh};

/// SceneDocument v1 now includes native 2D rect/ellipse and depth-tested mesh
/// paths. Every other object type still produces an explicit warning.
const SUPPORTED_VERSION: u64 = 1;
pub const MAX_PREPARED_LIGHTS: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum SceneError {
    #[error("scene is not a valid SceneDocument: {0}")]
    InvalidDocument(String),
    #[error("unsupported SceneDocument version {found}; this daemon supports version {SUPPORTED_VERSION}")]
    UnsupportedVersion { found: u64 },
    #[error("scene canvas must have positive dimensions (got {width}x{height})")]
    InvalidCanvas { width: f64, height: f64 },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneDocumentDto {
    id: String,
    name: String,
    version: u64,
    canvas: SceneCanvasDto,
    #[serde(default)]
    objects: Vec<Value>,
    #[serde(default)]
    materials: Vec<MaterialDto>,
    #[serde(default)]
    material_instances: Vec<MaterialInstanceDto>,
    #[serde(default)]
    updated_at: String,
    /// Consumed by camera resolution. It lives in the typed DTO rather than
    /// being read from raw JSON so that a TypeScript rename is caught by the
    /// fixture drift test instead of silently degrading every camera to the
    /// synthetic viewpoint.
    #[serde(default)]
    active_camera_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialDto {
    material_id: String,
    name: String,
    #[serde(rename = "type")]
    material_type: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default)]
    parameters: HashMap<String, Value>,
    #[serde(default)]
    blend_mode: Option<String>,
    #[serde(default)]
    alpha_mode: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    dynamic: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialInstanceDto {
    material_instance_id: String,
    base_material_id: String,
    #[serde(default)]
    parameter_overrides: HashMap<String, Value>,
}

#[derive(Debug)]
struct MaterialBindingRef {
    material_id: String,
    instance_id: Option<String>,
    overrides: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
struct SceneCanvasDto {
    width: f64,
    height: f64,
    background: String,
    #[serde(default, rename = "backgroundStyle")]
    background_style: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
struct Vec2Dto {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
struct Vec3Dto {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LightObjectDto {
    id: String,
    light_kind: String,
    x: f64,
    y: f64,
    #[serde(default)]
    z_depth: f64,
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default = "default_visible")]
    visible: bool,
    #[serde(default = "default_light_color")]
    color: String,
    #[serde(default = "default_light_intensity")]
    intensity: f64,
    #[serde(default)]
    range: f64,
    #[serde(default = "default_light_decay")]
    decay: f64,
    #[serde(default = "default_light_cone")]
    cone_angle_deg: f64,
    #[serde(default = "default_light_penumbra")]
    penumbra: f64,
    #[serde(default)]
    target: Option<Vec3Dto>,
}

fn default_light_color() -> String {
    "#ffffff".to_string()
}

fn default_light_intensity() -> f64 {
    1.0
}

fn default_light_decay() -> f64 {
    2.0
}

fn default_light_cone() -> f64 {
    45.0
}

fn default_light_penumbra() -> f64 {
    0.25
}

/// Base fields shared by every scene object, per `BaseSceneObject` in
/// shared-types. Unknown extra fields are ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RectObjectDto {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    rotation: f64,
    #[serde(default = "default_scale")]
    scale_x: f64,
    #[serde(default = "default_scale")]
    scale_y: f64,
    #[serde(default)]
    anchor: Vec2Dto,
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default = "default_visible")]
    visible: bool,
    #[serde(default)]
    fill: String,
    #[serde(default)]
    fill_style: Option<Value>,
    #[serde(default)]
    z_depth: f64,
    #[serde(default)]
    z_index: f64,
    #[serde(default)]
    layer_id: String,
    #[serde(default)]
    radius: f64,
    #[serde(default)]
    material_slots: HashMap<String, Value>,
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

/// A rect ready for uniform building: geometry in scene pixels plus a
/// linear-light premultiplied fill color (see shader-contract.md).
#[derive(Debug, Clone)]
pub struct PreparedRect {
    pub object_id: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub anchor_x: f32,
    pub anchor_y: f32,
    pub fill_linear_premultiplied: [f32; 4],
    pub gradient: PreparedGradient,
    /// Shared blend-mode id from packages/render-shaders/layouts.json.
    pub blend_mode: u32,
    /// 0 = rectangle, 1 = ellipse (shared shader param).
    pub primitive_kind: u32,
}

/// Fixed-size native gradient payload shared with the composite quad shader.
/// Kind: 0 solid, 1 linear, 2 radial. At most eight authored stops are used.
#[derive(Debug, Clone, Copy)]
pub struct PreparedGradient {
    pub kind: u32,
    pub stop_count: u32,
    pub spread: u32,
    pub coordinate_mode: u32,
    pub geometry: [[f32; 4]; 2],
    pub positions: [f32; 8],
    pub colors_linear_premultiplied: [[f32; 4]; 8],
}

impl Default for PreparedGradient {
    fn default() -> Self {
        Self {
            kind: 0,
            stop_count: 0,
            spread: 0,
            coordinate_mode: 0,
            geometry: [[0.0; 4]; 2],
            positions: [0.0; 8],
            colors_linear_premultiplied: [[0.0; 4]; 8],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedLightKind {
    Directional,
    Point,
    Spot,
}

/// A visible authored scene light ready for the mesh lighting uniform.
#[derive(Debug, Clone)]
pub struct PreparedLight {
    pub object_id: String,
    pub kind: PreparedLightKind,
    /// Straight linear-light RGB.
    pub color_linear: [f32; 3],
    /// Authored intensity after object opacity, before the editor-compatible
    /// canvas-unit scale applied to point and spot lights.
    pub intensity: f32,
    pub position: [f32; 3],
    /// Unit vector pointing from the light position toward its target.
    pub direction: [f32; 3],
    /// Zero means unlimited, matching Three.js.
    pub range: f32,
    pub decay: f32,
    /// Cosines of the spot light's outer and fully-lit inner half angles.
    pub spot_outer_cos: f32,
    pub spot_inner_cos: f32,
}

#[derive(Debug, Clone)]
pub struct PreparedScene {
    pub scene_id: String,
    pub name: String,
    /// `updatedAt` from the document — used as the revision in status reports.
    pub revision: String,
    pub canvas_width: f32,
    pub canvas_height: f32,
    /// Canvas background as linear-light premultiplied RGBA. Drawn as a
    /// full-canvas quad (matching the editor), not as the clear color.
    pub background_linear_premultiplied: [f32; 4],
    pub background_gradient: PreparedGradient,
    /// Render-ordered (layerId, zDepth, zIndex).
    pub rects: Vec<PreparedRect>,
    /// Depth-tested native primitive or imported glTF surfaces.
    pub meshes: Vec<PreparedMesh>,
    /// Visible authored lights. An empty list selects the renderer's readable
    /// synthetic fallback; a non-empty list suppresses that fallback even if
    /// every authored light has zero intensity, matching the editor.
    pub lights: Vec<PreparedLight>,
    pub object_count: usize,
    /// The resolved authored camera, or `None` when the renderer must use its
    /// synthetic viewpoint. Affects the MESH path only, matching the editor.
    pub camera: Option<PreparedCamera>,
    /// Typed diagnostics with stable codes and explicit severities. This is
    /// the authoritative report; `warnings` and `take_blockers` are derived
    /// views kept for wire compatibility.
    pub diagnostics: Vec<SceneDiagnostic>,
    /// Human-readable messages for every diagnostic, in emission order.
    pub warnings: Vec<String>,
    /// Messages for the diagnostics severe enough to make a Take unsafe
    /// (severity `omitted` or worse). Preview/warm remains allowed so the
    /// operator can inspect the report and choose an explicit fallback.
    pub take_blockers: Vec<String>,
    /// Canonical source used for revision-safe small patches. It is retained
    /// in the prepared cache so patch handling performs no disk/network I/O.
    pub source_document: Value,
}

/// Parse and prepare a full `SceneDocument` JSON value for rendering.
pub fn prepare_scene(scene_json: &Value) -> Result<PreparedScene, SceneError> {
    let document: SceneDocumentDto = serde_json::from_value(scene_json.clone())
        .map_err(|error| SceneError::InvalidDocument(error.to_string()))?;

    if document.version != SUPPORTED_VERSION {
        return Err(SceneError::UnsupportedVersion {
            found: document.version,
        });
    }

    if document.canvas.width <= 0.0 || document.canvas.height <= 0.0 {
        return Err(SceneError::InvalidCanvas {
            width: document.canvas.width,
            height: document.canvas.height,
        });
    }

    let mut warnings = DiagnosticSink::new();
    let camera = resolve_active_camera(
        document.active_camera_id.as_deref(),
        scene_json,
        &document.objects,
        document.canvas.width,
        document.canvas.height,
        &mut warnings,
    );
    let meshes = prepare_meshes(scene_json, &document.objects, &mut warnings);
    let lights = prepare_lights(
        &document.objects,
        document.canvas.width,
        document.canvas.height,
        &mut warnings,
    );
    let mut rects: Vec<(String, f64, f64, PreparedRect)> = Vec::new();
    let mut unsupported_counts: Vec<(String, usize)> = Vec::new();

    for object in &document.objects {
        let object_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("<missing type>");

        if object_type == "mesh" || object_type == "light" {
            continue;
        }

        if object_type != "rect" && object_type != "ellipse" {
            match unsupported_counts
                .iter_mut()
                .find(|(kind, _)| kind == object_type)
            {
                Some((_, count)) => *count += 1,
                None => unsupported_counts.push((object_type.to_string(), 1)),
            }
            continue;
        }

        let rect: RectObjectDto = match serde_json::from_value(object.clone()) {
            Ok(rect) => rect,
            Err(error) => {
                warnings.push(format!("rect object skipped: {error}"));
                continue;
            }
        };

        if !rect.visible {
            continue;
        }

        if rect.radius > 0.0 {
            // Degraded, not Omitted: the rect is fully present in the frame,
            // only its corner treatment is wrong. This must not block Take.
            warnings.emit_for_object(
                "rect.radius.unsupported",
                DiagnosticSeverity::Degraded,
                format!(
                    "rect {} has radius {}; rounded corners are not rendered yet (drawn sharp)",
                    rect.id, rect.radius
                ),
                rect.id.clone(),
                object_type,
            );
        }

        let mut fill_source = rect.fill.clone();
        let mut opacity = rect.opacity;
        let mut blend_mode = 0;
        let mut force_opaque = false;
        let mut use_authored_color_style = true;

        if let Some(binding_value) = rect.material_slots.get("main") {
            if let Some(binding) = parse_material_binding(binding_value) {
                use_authored_color_style = false;
                let Some(material) = document
                    .materials
                    .iter()
                    .find(|item| item.material_id == binding.material_id)
                else {
                    warnings.push(format!(
                        "rect {} references missing material {} and is not rendered",
                        rect.id, binding.material_id
                    ));
                    continue;
                };

                if material.enabled == Some(false) {
                    continue;
                }

                if material.material_type != "solid-color" {
                    warnings.push(format!(
                        "rect {} material {:?} is type {:?} and is NOT rendered by the daemon yet; textured materials remain editor-preview only",
                        rect.id, material.name, material.material_type
                    ));
                    continue;
                }

                if material.dynamic {
                    warnings.push(format!(
                        "rect {} material {:?} has a dynamic binding; the daemon currently uses its stored fallback parameters",
                        rect.id, material.name
                    ));
                }

                let instance = binding.instance_id.as_ref().and_then(|instance_id| {
                    document.material_instances.iter().find(|instance| {
                        instance.material_instance_id == *instance_id
                            && instance.base_material_id == material.material_id
                    })
                });
                if binding.instance_id.is_some() && instance.is_none() {
                    warnings.push(format!(
                        "rect {} references a missing or mismatched material instance; using base material {:?}",
                        rect.id, material.name
                    ));
                }

                fill_source = resolved_string_parameter(
                    "baseColor",
                    &binding.overrides,
                    instance.map(|value| &value.parameter_overrides),
                    &material.parameters,
                )
                .or_else(|| material.color.clone())
                .unwrap_or_else(|| "#ffffff".to_string());
                let material_opacity = resolved_number_parameter(
                    "opacity",
                    &binding.overrides,
                    instance.map(|value| &value.parameter_overrides),
                    &material.parameters,
                )
                .unwrap_or(material.opacity);
                opacity *= material_opacity;

                // Shared blend ids from packages/render-shaders/layouts.json.
                // Only the modes implemented in BOTH renderers are accepted;
                // anything else is skipped with a warning rather than silently
                // falling back to normal.
                blend_mode = match material.blend_mode.as_deref().unwrap_or("normal") {
                    "normal" => 0,
                    "multiply" => 1,
                    "screen" => 2,
                    "add" => 3,
                    "darken" => 4,
                    "lighten" => 5,
                    unsupported => {
                        warnings.push(format!(
                            "rect {} material {:?} uses unsupported blend mode {:?}; it is not rendered instead of silently falling back",
                            rect.id, material.name, unsupported
                        ));
                        continue;
                    }
                };

                match material.alpha_mode.as_deref().unwrap_or("premultiplied") {
                    "opaque" => force_opaque = true,
                    "straight" | "premultiplied" => {}
                    unsupported => {
                        warnings.push(format!(
                            "rect {} material {:?} uses unsupported alpha mode {:?}; it is not rendered",
                            rect.id, material.name, unsupported
                        ));
                        continue;
                    }
                }
            }
        }

        let mut fill = match parse_hex_color(&fill_source) {
            Some(srgb) => srgb,
            None => {
                warnings.push(format!(
                    "rect {} skipped: fill {:?} is not a supported hex color",
                    rect.id, fill_source
                ));
                continue;
            }
        };
        if force_opaque {
            fill[3] = 1.0;
        }
        let fallback_fill = to_linear_premultiplied(fill, opacity as f32);
        let (fill_linear_premultiplied, gradient) = if use_authored_color_style {
            prepare_color_value(
                rect.fill_style.as_ref(),
                fallback_fill,
                opacity as f32,
                &rect.id,
                &mut warnings,
            )
        } else {
            (fallback_fill, PreparedGradient::default())
        };

        let prepared = PreparedRect {
            object_id: rect.id,
            x: rect.x as f32,
            y: rect.y as f32,
            width: rect.width as f32,
            height: rect.height as f32,
            rotation_degrees: rect.rotation as f32,
            scale_x: rect.scale_x as f32,
            scale_y: rect.scale_y as f32,
            anchor_x: rect.anchor.x as f32,
            anchor_y: rect.anchor.y as f32,
            fill_linear_premultiplied,
            gradient,
            blend_mode,
            primitive_kind: if object_type == "ellipse" { 1 } else { 0 },
        };

        rects.push((rect.layer_id, rect.z_depth, rect.z_index, prepared));
    }

    for (kind, count) in &unsupported_counts {
        // `camera` is intentionally not reported here. A camera is not content
        // that failed to draw -- it is a viewpoint. Saying "1 camera is NOT
        // rendered" understates the impact, because an unhonoured camera
        // mis-frames every *other* object too. resolve_active_camera handles
        // it at Invalid severity.
        if kind == CAMERA_OBJECT_TYPE {
            continue;
        }

        warnings.emit(
            "object.type.unsupported",
            DiagnosticSeverity::Omitted,
            format!(
                "{count} object(s) of type {kind:?} are NOT rendered: native v1 currently renders rects, ellipses, and real 3D meshes"
            ),
        );
    }

    // Same ordering rule as apps/editor-web/src/rendering/sceneMaterial.ts.
    // Deviation: layerId compares byte-wise here vs localeCompare in the
    // editor; identical for the ASCII ids GrapiX generates (documented in
    // shader-contract.md).
    rects.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.total_cmp(&right.1))
            .then(left.2.total_cmp(&right.2))
    });

    let background = parse_hex_color(&document.canvas.background).unwrap_or_else(|| {
        warnings.push(format!(
            "canvas background {:?} is not a supported hex color; using transparent",
            document.canvas.background
        ));
        [0.0, 0.0, 0.0, 0.0]
    });

    let background_fill = to_linear_premultiplied(background, 1.0);
    let (background_linear_premultiplied, background_gradient) = prepare_color_value(
        document.canvas.background_style.as_ref(),
        background_fill,
        1.0,
        "canvas background",
        &mut warnings,
    );

    let (diagnostics, warning_messages, take_blockers) = warnings.into_parts();

    Ok(PreparedScene {
        scene_id: document.id,
        name: document.name,
        revision: document.updated_at,
        canvas_width: document.canvas.width as f32,
        canvas_height: document.canvas.height as f32,
        background_linear_premultiplied,
        background_gradient,
        rects: rects.into_iter().map(|(_, _, _, rect)| rect).collect(),
        meshes,
        lights,
        object_count: document.objects.len(),
        camera,
        diagnostics,
        warnings: warning_messages,
        take_blockers,
        source_document: scene_json.clone(),
    })
}

fn prepare_lights(
    objects: &[Value],
    canvas_width: f64,
    canvas_height: f64,
    warnings: &mut DiagnosticSink,
) -> Vec<PreparedLight> {
    let mut lights = Vec::new();
    for value in objects {
        if value.get("type").and_then(Value::as_str) != Some("light") {
            continue;
        }
        let light: LightObjectDto = match serde_json::from_value(value.clone()) {
            Ok(light) => light,
            Err(error) => {
                warnings.push(format!("light object skipped: {error}"));
                continue;
            }
        };
        if !light.visible {
            continue;
        }
        let kind = match light.light_kind.as_str() {
            "directional" => PreparedLightKind::Directional,
            "point" => PreparedLightKind::Point,
            "spot" => PreparedLightKind::Spot,
            unsupported => {
                warnings.push(format!(
                    "light {} uses unsupported kind {unsupported:?} and is not rendered",
                    light.id
                ));
                continue;
            }
        };
        let Some(srgb) = parse_hex_color(&light.color) else {
            warnings.push(format!(
                "light {} has invalid color {:?} and is not rendered",
                light.id, light.color
            ));
            continue;
        };
        let position = [
            finite_f64(light.x, canvas_width * 0.5) as f32,
            finite_f64(light.y, canvas_height * 0.5) as f32,
            finite_f64(light.z_depth, 0.0) as f32,
        ];
        let fallback_target = Vec3Dto {
            x: canvas_width * 0.5,
            y: canvas_height * 0.5,
            z: 0.0,
        };
        let target = light.target.unwrap_or(fallback_target);
        let mut direction = [
            finite_f64(target.x, fallback_target.x) as f32 - position[0],
            finite_f64(target.y, fallback_target.y) as f32 - position[1],
            finite_f64(target.z, fallback_target.z) as f32 - position[2],
        ];
        let direction_length = (direction[0] * direction[0]
            + direction[1] * direction[1]
            + direction[2] * direction[2])
            .sqrt();
        if direction_length > 1e-6 {
            for component in &mut direction {
                *component /= direction_length;
            }
        } else {
            direction = [0.0, 0.0, -1.0];
        }

        let cone_degrees = finite_f64(light.cone_angle_deg, 45.0).clamp(1.0, 179.0);
        let outer_half_radians = (cone_degrees as f32 * 0.5).to_radians();
        let penumbra = finite_f64(light.penumbra, 0.25).clamp(0.0, 1.0) as f32;
        lights.push(PreparedLight {
            object_id: light.id,
            kind,
            color_linear: [
                srgb_to_linear(srgb[0]),
                srgb_to_linear(srgb[1]),
                srgb_to_linear(srgb[2]),
            ],
            intensity: (finite_f64(light.intensity, 1.0).max(0.0)
                * finite_f64(light.opacity, 1.0).clamp(0.0, 1.0)) as f32,
            position,
            direction,
            range: finite_f64(light.range, 0.0).max(0.0) as f32,
            decay: finite_f64(light.decay, 2.0).max(0.0) as f32,
            spot_outer_cos: outer_half_radians.cos(),
            spot_inner_cos: (outer_half_radians * (1.0 - penumbra)).cos(),
        });
    }
    if lights.len() > MAX_PREPARED_LIGHTS {
        warnings.push(format!(
            "scene has {} visible authored lights; only the first {MAX_PREPARED_LIGHTS} are rendered by the native Program shader and the remainder are not rendered",
            lights.len()
        ));
        lights.truncate(MAX_PREPARED_LIGHTS);
    }
    lights
}

fn finite_f64(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn prepare_color_value(
    value: Option<&Value>,
    fallback: [f32; 4],
    object_opacity: f32,
    label: &str,
    warnings: &mut DiagnosticSink,
) -> ([f32; 4], PreparedGradient) {
    let Some(value) = value else {
        return (fallback, PreparedGradient::default());
    };
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        warnings.push(format!(
            "{label} has a malformed fillStyle; using its legacy fill"
        ));
        return (fallback, PreparedGradient::default());
    };
    if kind == "none" {
        return ([0.0; 4], PreparedGradient::default());
    }
    if kind == "solid" {
        let color = value
            .get("color")
            .and_then(Value::as_str)
            .and_then(parse_hex_color);
        return match color {
            Some(color) => (
                to_linear_premultiplied(color, object_opacity),
                PreparedGradient::default(),
            ),
            None => {
                warnings.push(format!(
                    "{label} has an invalid solid fillStyle; using its legacy fill"
                ));
                (fallback, PreparedGradient::default())
            }
        };
    }
    if kind != "linear-gradient" && kind != "radial-gradient" {
        warnings.push(format!(
            "{label} uses unknown fillStyle type {kind:?}; using its legacy fill"
        ));
        return (fallback, PreparedGradient::default());
    }

    let mut stops: Vec<(f32, [f32; 4])> = value
        .get("stops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|stop| {
            let position = stop.get("position")?.as_f64()?.clamp(0.0, 1.0) as f32;
            let color = parse_hex_color(stop.get("color")?.as_str()?)?;
            let opacity = stop
                .get("opacity")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .clamp(0.0, 1.0) as f32;
            Some((
                position,
                to_linear_premultiplied(color, object_opacity * opacity),
            ))
        })
        .collect();
    stops.sort_by(|left, right| left.0.total_cmp(&right.0));
    if stops.len() < 2 {
        warnings.push(format!(
            "{label} gradient has fewer than two valid stops; using its legacy fill"
        ));
        return (fallback, PreparedGradient::default());
    }
    if stops.len() > 8 {
        warnings.push(format!(
            "{label} gradient has {} stops; native output uses the first 8",
            stops.len()
        ));
        stops.truncate(8);
    }

    let number = |name: &str, default: f64| {
        value
            .get(name)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
            .unwrap_or(default) as f32
    };
    let mut gradient = PreparedGradient {
        kind: if kind == "linear-gradient" { 1 } else { 2 },
        stop_count: stops.len() as u32,
        spread: match value.get("spread").and_then(Value::as_str).unwrap_or("pad") {
            "repeat" => 1,
            "reflect" => 2,
            _ => 0,
        },
        coordinate_mode: if value
            .get("coordinateMode")
            .and_then(Value::as_str)
            .unwrap_or("object")
            == "scene"
        {
            1
        } else {
            0
        },
        ..PreparedGradient::default()
    };
    gradient.geometry = if gradient.kind == 1 {
        [
            [
                number("startX", 0.0),
                number("startY", 0.5),
                number("endX", 1.0),
                number("endY", 0.5),
            ],
            [0.0; 4],
        ]
    } else {
        let center_x = number("centerX", 0.5);
        let center_y = number("centerY", 0.5);
        [
            [
                center_x,
                center_y,
                number("radiusX", 0.5).abs().max(0.0001),
                number("radiusY", 0.5).abs().max(0.0001),
            ],
            [
                number("focalX", center_x as f64),
                number("focalY", center_y as f64),
                0.0,
                0.0,
            ],
        ]
    };
    for (index, (position, color)) in stops.into_iter().enumerate() {
        gradient.positions[index] = position;
        gradient.colors_linear_premultiplied[index] = color;
    }
    (fallback, gradient)
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

/// Decode `#rgb`, `#rrggbb`, or `#rrggbbaa` into straight sRGB floats.
fn parse_hex_color(raw: &str) -> Option<[f32; 4]> {
    let hex = raw.trim().strip_prefix('#')?;

    let (r, g, b, a) = match hex.len() {
        3 => {
            let mut digits = hex.chars().map(|c| c.to_digit(16));
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

/// sRGB straight -> linear-light premultiplied, per the shader contract.
fn to_linear_premultiplied(srgb: [f32; 4], opacity: f32) -> [f32; 4] {
    let alpha = (srgb[3] * opacity).clamp(0.0, 1.0);

    [
        srgb_to_linear(srgb[0]) * alpha,
        srgb_to_linear(srgb[1]) * alpha,
        srgb_to_linear(srgb[2]) * alpha,
        alpha,
    ]
}

/// IEC 61966-2-1 sRGB electro-optical transfer function.
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

    fn minimal_scene(objects: Vec<Value>) -> Value {
        json!({
            "id": "scene_test",
            "name": "Test Scene",
            "version": 1,
            "canvas": { "width": 1920, "height": 1080, "background": "#103050" },
            "dataContext": {},
            "assets": [],
            "materials": [],
            "objects": objects,
            "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
            "createdAt": "2026-07-15T00:00:00.000Z",
            "updatedAt": "2026-07-15T00:00:00.000Z"
        })
    }

    fn rect_object() -> Value {
        json!({
            "id": "rect_1", "name": "Plate", "type": "rect",
            "x": 100, "y": 200, "zDepth": 0, "zIndex": 1, "layerId": "main",
            "width": 400, "height": 120, "rotation": 0, "opacity": 1,
            "visible": true, "locked": false,
            "fill": "#ff0000", "stroke": "#ffffff", "strokeWidth": 0,
            "bindings": {}, "materialSlots": {}, "radius": 0
        })
    }

    #[test]
    fn prepares_a_rect() {
        let scene = prepare_scene(&minimal_scene(vec![rect_object()])).expect("scene must prepare");
        assert_eq!(scene.rects.len(), 1);
        assert_eq!(scene.rects[0].object_id, "rect_1");
        assert_eq!(scene.rects[0].width, 400.0);
        // #ff0000 premultiplied at opacity 1: pure red stays 1.0 linear.
        assert!((scene.rects[0].fill_linear_premultiplied[0] - 1.0).abs() < 1e-6);
        assert_eq!(scene.warnings.len(), 0);
    }

    #[test]
    fn prepares_an_analytic_ellipse() {
        let mut ellipse = rect_object();
        ellipse["type"] = json!("ellipse");
        ellipse["id"] = json!("ellipse_1");
        let scene = prepare_scene(&minimal_scene(vec![ellipse])).expect("scene must prepare");
        assert_eq!(scene.rects.len(), 1);
        assert_eq!(scene.rects[0].primitive_kind, 1);
        assert!(scene.warnings.is_empty());
    }

    #[test]
    fn rounded_rect_is_a_cosmetic_degradation_not_a_take_blocker() {
        let mut rounded = rect_object();
        rounded["radius"] = json!(12);

        let scene = prepare_scene(&minimal_scene(vec![rounded])).expect("scene must prepare");

        assert_eq!(scene.rects.len(), 1, "the rect still renders, just sharp");
        assert!(
            scene.warnings.iter().any(|w| w.contains("rounded corners")),
            "the degradation must still be reported, got {:?}",
            scene.warnings
        );
        assert!(
            scene.take_blockers.is_empty(),
            "drawing a rect with sharp corners degrades fidelity but omits no content; \
             it must not block Take, got {:?}",
            scene.take_blockers
        );
    }

    fn camera_object(id: &str) -> Value {
        json!({
            "id": id, "name": "Beauty Cam", "type": "camera",
            "x": 0, "y": 0, "zDepth": 0, "zIndex": 0, "layerId": "main",
            "width": 0, "height": 0, "rotation": 0, "opacity": 1,
            "visible": true, "locked": false,
            "bindings": {}, "materialSlots": {}
        })
    }

    /// Replaces the first half of the retired
    /// `an_active_camera_invalidates_the_whole_frame_not_just_the_camera`.
    /// A camera the daemon genuinely cannot reproduce must still invalidate the
    /// whole frame, because an unhonoured camera mis-frames every other object.
    #[test]
    fn a_container_parented_active_camera_still_invalidates_the_whole_frame() {
        let mut layer = rect_object();
        layer["id"] = json!("layer_1");
        layer["type"] = json!("layer");
        layer["childIds"] = json!(["cam_1"]);

        let mut scene_json = minimal_scene(vec![rect_object(), camera_object("cam_1"), layer]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");

        assert!(
            scene.camera.is_none(),
            "a parented camera must not be honoured -- the daemon resolves no hierarchy"
        );

        let camera_diagnostic = scene
            .diagnostics
            .iter()
            .find(|d| d.code == "camera.parented.unsupported")
            .expect("a parented active camera must be reported");

        assert_eq!(camera_diagnostic.severity, DiagnosticSeverity::Invalid);
        assert_eq!(camera_diagnostic.object_id.as_deref(), Some("cam_1"));
        assert!(
            !scene.take_blockers.is_empty(),
            "Take must stay blocked while Program framing cannot match Preview"
        );

        // The generic "object of type X is NOT rendered" line would understate
        // this, so it must not also be emitted for the camera.
        assert!(
            !scene
                .diagnostics
                .iter()
                .any(|d| d.code == "object.type.unsupported" && d.message.contains("camera")),
            "camera must not be double-reported as ordinary undrawn content, got {:?}",
            scene.warnings
        );
    }

    /// Replaces the second half of the retired test: the case that is now
    /// genuinely supported must be honoured silently and must NOT block Take.
    #[test]
    fn a_plain_active_camera_is_honoured_and_does_not_block_take() {
        let mut scene_json = minimal_scene(vec![rect_object(), camera_object("cam_1")]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");

        let camera = scene
            .camera
            .as_ref()
            .expect("a plain visible active camera must be honoured");
        assert_eq!(camera.object_id, "cam_1");

        assert!(
            scene.take_blockers.is_empty(),
            "an honoured camera frames faithfully, so nothing blocks Take; got {:?}",
            scene.take_blockers
        );
        assert!(
            !scene
                .diagnostics
                .iter()
                .any(|d| d.code.starts_with("camera.") && d.severity.blocks_take()),
            "no blocking camera diagnostic may survive, got {:?}",
            scene.warnings
        );
    }

    /// `camera_object()` authors `zDepth: 0` with no `target`, which is exactly
    /// the shape `normalizeScene` repairs to the scene focal distance
    /// (editorStore.ts:2477-2479). If the daemon took the 0 literally the
    /// camera would sit on its own target and `look_at` would degenerate, so
    /// this pins the repair with the real number.
    #[test]
    fn a_zero_z_depth_camera_is_repaired_to_the_scene_focal_distance() {
        let mut scene_json = minimal_scene(vec![camera_object("cam_1")]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");
        let camera = scene.camera.as_ref().expect("camera must be honoured");

        // (1080 / 2) / tan(22.5 deg) = 1303.5375
        let expected = (1080.0_f64 / 2.0) / (22.5_f64.to_radians()).tan();
        assert!(
            ((camera.position[2] as f64) - expected).abs() < 0.01,
            "expected focal distance {expected}, got {}",
            camera.position[2]
        );
        assert!(
            camera.position[2] > 1.0,
            "a repaired camera must never sit on the canvas plane"
        );
    }

    /// An invisible camera is NOT an error: the editor requires `visible`
    /// truthy and otherwise falls through to its synthetic camera, so the two
    /// renderers agree and nothing is mis-framed.
    #[test]
    fn an_invisible_camera_falls_back_like_the_editor_and_does_not_block_take() {
        let mut camera = camera_object("cam_1");
        camera["visible"] = json!(false);
        let mut scene_json = minimal_scene(vec![rect_object(), camera]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");

        assert!(
            scene.camera.is_none(),
            "an invisible camera is not honoured"
        );
        let diagnostic = scene
            .diagnostics
            .iter()
            .find(|d| d.code == "camera.inactive.not-rendered")
            .expect("an invisible camera must still be reported");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Info);
        assert!(
            scene.take_blockers.is_empty(),
            "both renderers use the synthetic camera here, got {:?}",
            scene.take_blockers
        );
    }

    /// `normalizeScene` auto-assigns the first VISIBLE camera when no
    /// `activeCameraId` is set (editorStore.ts:2575-2577). The daemon must
    /// replicate that, because it receives raw persisted documents that never
    /// passed through the editor store. Without this, such a scene would frame
    /// through the camera in Preview and synthetically in Program while
    /// reporting only Info -- an unreported whole-frame divergence.
    #[test]
    fn a_visible_camera_is_auto_assigned_when_no_active_id_is_set() {
        let scene = prepare_scene(&minimal_scene(vec![rect_object(), camera_object("cam_1")]))
            .expect("scene must prepare");

        let camera = scene
            .camera
            .as_ref()
            .expect("the first visible camera must be auto-assigned, matching normalizeScene");
        assert_eq!(camera.object_id, "cam_1");
    }

    /// An animated camera cannot be honoured: the daemon evaluates no timeline,
    /// so it would freeze at the authored values while Preview moves.
    #[test]
    fn an_animated_active_camera_still_invalidates_the_whole_frame() {
        let mut camera = camera_object("cam_1");
        camera["animation"] = json!({ "x": { "keyframes": [] } });
        let mut scene_json = minimal_scene(vec![camera]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");

        assert!(scene.camera.is_none());
        let diagnostic = scene
            .diagnostics
            .iter()
            .find(|d| d.code == "camera.animated.unsupported")
            .expect("an animated camera must be reported");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Invalid);
        assert!(!scene.take_blockers.is_empty());
    }

    /// Timeline keyframes are attributed per object, so only keyframes naming
    /// THIS camera may refuse it. A scene whose other objects animate is a
    /// pre-existing native limitation unrelated to framing.
    #[test]
    fn timeline_keyframes_for_other_objects_do_not_refuse_the_camera() {
        let mut scene_json = minimal_scene(vec![rect_object(), camera_object("cam_1")]);
        scene_json["activeCameraId"] = json!("cam_1");
        scene_json["timeline"]["keyframes"] = json!([
            { "id": "k1", "objectId": "rect_1", "frame": 0, "properties": {} }
        ]);

        let scene = prepare_scene(&scene_json).expect("scene must prepare");
        assert!(
            scene.camera.is_some(),
            "another object's keyframes say nothing about the camera"
        );

        scene_json["timeline"]["keyframes"] = json!([
            { "id": "k1", "objectId": "cam_1", "frame": 0, "properties": {} }
        ]);
        let animated = prepare_scene(&scene_json).expect("scene must prepare");
        assert!(
            animated.camera.is_none(),
            "a keyframe naming the camera must refuse it"
        );
        assert!(animated
            .diagnostics
            .iter()
            .any(|d| d.code == "camera.animated.unsupported"));
    }

    /// An unrecognised `cameraKind` must fail closed rather than silently
    /// falling back to perspective.
    #[test]
    fn an_unknown_camera_kind_fails_closed() {
        let mut camera = camera_object("cam_1");
        camera["cameraKind"] = json!("fisheye");
        let mut scene_json = minimal_scene(vec![camera]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");
        assert!(scene.camera.is_none());
        assert!(scene
            .diagnostics
            .iter()
            .any(|d| d.code == "camera.kind.unsupported" && d.severity.blocks_take()));
    }

    /// An orthographic camera's frustum is the canvas size divided by zoom, and
    /// does not depend on camera distance.
    #[test]
    fn an_orthographic_camera_resolves_canvas_sized_half_extents() {
        let mut camera = camera_object("cam_1");
        camera["cameraKind"] = json!("orthographic");
        camera["zoom"] = json!(2.0);
        let mut scene_json = minimal_scene(vec![camera]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");
        let camera = scene.camera.as_ref().expect("camera must be honoured");

        match camera.kind {
            crate::scene::PreparedCameraKind::Orthographic {
                half_width,
                half_height,
            } => {
                assert!((half_width - 480.0).abs() < 1e-3, "1920/2/2 = 480");
                assert!((half_height - 270.0).abs() < 1e-3, "1080/2/2 = 270");
            }
            other => panic!("expected an orthographic camera, got {other:?}"),
        }
        assert_eq!(camera.zoom, 2.0);
    }

    /// `zoom` folds into the projection, and is stored pre-folded as `y_scale`
    /// so the render thread never has to invert it back through an `atan`.
    #[test]
    fn perspective_zoom_folds_into_the_projection_y_scale() {
        let mut camera = camera_object("cam_1");
        camera["fov"] = json!(45.0);
        camera["zoom"] = json!(2.0);
        let mut scene_json = minimal_scene(vec![camera]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");
        let camera = scene.camera.as_ref().expect("camera must be honoured");

        match camera.kind {
            crate::scene::PreparedCameraKind::Perspective {
                fov_radians,
                y_scale,
            } => {
                let expected_fov = 45.0_f64.to_radians();
                assert!(((fov_radians as f64) - expected_fov).abs() < 1e-6);
                // y_scale = zoom / tan(fov/2) = 2 / tan(22.5 deg) = 4.828427
                let expected = 2.0 / (22.5_f64.to_radians()).tan();
                assert!(
                    ((y_scale as f64) - expected).abs() < 1e-4,
                    "expected y_scale {expected}, got {y_scale}"
                );
            }
            other => panic!("expected a perspective camera, got {other:?}"),
        }
    }

    /// A camera with a data binding cannot be honoured: live data would move it
    /// in the editor while the daemon resolves no bindings.
    #[test]
    fn a_data_bound_camera_still_invalidates_the_whole_frame() {
        let mut camera = camera_object("cam_1");
        camera["bindings"] = json!({ "x": "team.cameraX" });
        let mut scene_json = minimal_scene(vec![camera]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");
        assert!(scene.camera.is_none());
        assert!(scene
            .diagnostics
            .iter()
            .any(|d| d.code == "camera.bound.unsupported" && d.severity.blocks_take()));
    }

    /// An extreme depth range degrades depth precision but omits nothing, so it
    /// must warn without blocking Take. The authored `far` is used verbatim
    /// because clamping it would clip geometry the editor shows.
    #[test]
    fn an_extreme_depth_range_degrades_without_blocking_take() {
        let mut camera = camera_object("cam_1");
        camera["near"] = json!(0.01);
        camera["far"] = json!(1.0e9);
        let mut scene_json = minimal_scene(vec![camera]);
        scene_json["activeCameraId"] = json!("cam_1");

        let scene = prepare_scene(&scene_json).expect("scene must prepare");
        assert!(
            scene.camera.is_some(),
            "the camera is still faithfully framed"
        );

        let diagnostic = scene
            .diagnostics
            .iter()
            .find(|d| d.code == "camera.depth-range.imprecise")
            .expect("an extreme depth range must be reported");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Degraded);
        assert!(
            scene.take_blockers.is_empty(),
            "depth imprecision omits no content, got {:?}",
            scene.take_blockers
        );
    }

    #[test]
    fn a_scene_with_no_cameras_reports_nothing_about_cameras() {
        let scene = prepare_scene(&minimal_scene(vec![rect_object()])).expect("scene must prepare");
        assert!(!scene
            .diagnostics
            .iter()
            .any(|d| d.code.starts_with("camera.")));
    }

    #[test]
    fn every_diagnostic_carries_a_stable_code_and_matches_the_derived_views() {
        let mut rounded = rect_object();
        rounded["radius"] = json!(8);
        let mut text = rect_object();
        text["type"] = json!("text");
        text["id"] = json!("text_1");

        let scene = prepare_scene(&minimal_scene(vec![rounded, text])).expect("scene must prepare");

        assert!(!scene.diagnostics.is_empty());
        assert_eq!(
            scene.warnings.len(),
            scene.diagnostics.len(),
            "warnings is a plain projection of diagnostics"
        );
        assert_eq!(
            scene.take_blockers.len(),
            scene
                .diagnostics
                .iter()
                .filter(|d| d.severity.blocks_take())
                .count(),
            "take_blockers is derived from severity, not from message wording"
        );
        assert!(
            scene.diagnostics.iter().all(|d| !d.code.is_empty()),
            "every diagnostic needs a machine-readable code"
        );
    }

    #[test]
    fn prepares_authored_linear_gradient_for_native_output() {
        let mut rect = rect_object();
        rect["fillStyle"] = json!({
            "type": "linear-gradient",
            "angle": 0,
            "startX": 0,
            "startY": 0.5,
            "endX": 1,
            "endY": 0.5,
            "spread": "reflect",
            "coordinateMode": "object",
            "stops": [
                { "id": "left", "position": 0, "color": "#ff0000", "opacity": 1 },
                { "id": "right", "position": 1, "color": "#0000ff", "opacity": 0.5 }
            ]
        });
        let scene = prepare_scene(&minimal_scene(vec![rect])).expect("gradient scene must prepare");
        let gradient = scene.rects[0].gradient;
        assert_eq!(gradient.kind, 1);
        assert_eq!(gradient.stop_count, 2);
        assert_eq!(gradient.spread, 2);
        assert_eq!(gradient.geometry[0], [0.0, 0.5, 1.0, 0.5]);
        assert!((gradient.colors_linear_premultiplied[1][3] - 0.5).abs() < 1e-6);
        assert!(scene.take_blockers.is_empty());
    }

    #[test]
    fn warns_for_unsupported_types_instead_of_pretending() {
        let mut text = rect_object();
        text["type"] = json!("text");
        text["id"] = json!("text_1");

        let scene =
            prepare_scene(&minimal_scene(vec![rect_object(), text])).expect("scene must prepare");
        assert_eq!(scene.rects.len(), 1);
        assert!(
            scene
                .warnings
                .iter()
                .any(|w| w.contains("\"text\"") && w.contains("NOT rendered")),
            "expected an explicit unsupported-type warning, got {:?}",
            scene.warnings
        );
    }

    #[test]
    fn skips_invisible_rects() {
        let mut hidden = rect_object();
        hidden["visible"] = json!(false);
        let scene = prepare_scene(&minimal_scene(vec![hidden])).expect("scene must prepare");
        assert!(scene.rects.is_empty());
    }

    #[test]
    fn sorts_by_layer_then_zdepth_then_zindex() {
        let mut back = rect_object();
        back["id"] = json!("rect_back");
        back["zIndex"] = json!(0);
        let mut front = rect_object();
        front["id"] = json!("rect_front");
        front["zIndex"] = json!(5);

        let scene = prepare_scene(&minimal_scene(vec![front, back])).expect("scene must prepare");
        assert_eq!(scene.rects[0].object_id, "rect_back");
        assert_eq!(scene.rects[1].object_id, "rect_front");
    }

    #[test]
    fn rejects_wrong_version() {
        let mut scene = minimal_scene(vec![]);
        scene["version"] = json!(2);
        assert!(matches!(
            prepare_scene(&scene),
            Err(SceneError::UnsupportedVersion { found: 2 })
        ));
    }

    #[test]
    fn resolves_solid_material_instance_and_additive_blend() {
        let mut rect = rect_object();
        rect["materialSlots"] = json!({
            "main": {
                "materialId": "mat_base",
                "instanceId": "matinst_green",
                "overrides": { "opacity": 0.5 }
            }
        });
        let mut scene = minimal_scene(vec![rect]);
        scene["materials"] = json!([{
            "materialId": "mat_base",
            "name": "Shared Plate",
            "type": "solid-color",
            "color": "#ff0000",
            "dynamic": false,
            "opacity": 1,
            "readiness": "READY",
            "parameters": { "baseColor": "#ff0000", "opacity": 1 },
            "blendMode": "add",
            "alphaMode": "premultiplied"
        }]);
        scene["materialInstances"] = json!([{
            "materialInstanceId": "matinst_green",
            "name": "Green Plate",
            "baseMaterialId": "mat_base",
            "parameterOverrides": { "baseColor": "#00ff00" },
            "textureOverrides": {},
            "createdAt": "2026-07-15T00:00:00.000Z",
            "updatedAt": "2026-07-15T00:00:00.000Z"
        }]);

        let prepared = prepare_scene(&scene).expect("material scene must prepare");
        assert_eq!(prepared.rects.len(), 1);
        assert_eq!(prepared.rects[0].blend_mode, 3);
        assert!((prepared.rects[0].fill_linear_premultiplied[1] - 0.5).abs() < 1e-6);
        assert!((prepared.rects[0].fill_linear_premultiplied[3] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn refuses_unsupported_material_blend_instead_of_falling_back() {
        let mut rect = rect_object();
        rect["materialSlots"] = json!({ "main": "mat_overlay" });
        let mut scene = minimal_scene(vec![rect]);
        scene["materials"] = json!([{
            "materialId": "mat_overlay", "name": "Overlay", "type": "solid-color",
            "dynamic": false, "opacity": 1, "readiness": "READY",
            "parameters": { "baseColor": "#ffffff" }, "blendMode": "overlay"
        }]);

        let prepared = prepare_scene(&scene).expect("scene must prepare with warnings");
        assert!(prepared.rects.is_empty());
        assert!(prepared
            .warnings
            .iter()
            .any(|warning| warning.contains("unsupported blend mode")));
    }

    #[test]
    fn reports_textured_materials_as_not_rendered() {
        let mut rect = rect_object();
        rect["materialSlots"] = json!({ "main": "mat_image" });
        let mut scene = minimal_scene(vec![rect]);
        scene["materials"] = json!([{
            "materialId": "mat_image", "name": "Image", "type": "image",
            "dynamic": false, "opacity": 1, "readiness": "READY"
        }]);

        let prepared = prepare_scene(&scene).expect("scene must prepare with warnings");
        assert!(prepared.rects.is_empty());
        assert!(prepared
            .warnings
            .iter()
            .any(|warning| warning.contains("editor-preview only")));
    }

    #[test]
    fn prepares_visible_authored_lights_without_unsupported_object_warnings() {
        let directional = json!({
            "id": "key",
            "name": "Key",
            "type": "light",
            "lightKind": "directional",
            "x": 100,
            "y": 200,
            "zDepth": 800,
            "opacity": 0.5,
            "visible": true,
            "intensity": 2,
            "color": "#ff8040",
            "target": { "x": 100, "y": 200, "z": 0 }
        });
        let hidden = json!({
            "id": "hidden",
            "type": "light",
            "lightKind": "point",
            "x": 0,
            "y": 0,
            "visible": false,
            "intensity": 100,
            "color": "#ffffff"
        });
        let prepared =
            prepare_scene(&minimal_scene(vec![directional, hidden])).expect("lights must prepare");
        assert_eq!(prepared.lights.len(), 1);
        let light = &prepared.lights[0];
        assert_eq!(light.object_id, "key");
        assert_eq!(light.kind, PreparedLightKind::Directional);
        assert!((light.intensity - 1.0).abs() < 1e-6);
        assert_eq!(light.position, [100.0, 200.0, 800.0]);
        assert!((light.direction[2] + 1.0).abs() < 1e-6);
        assert!(light.color_linear[0] > light.color_linear[1]);
        assert!(prepared
            .warnings
            .iter()
            .all(|warning| !warning.contains("object(s) of type \"light\"")));
    }

    #[test]
    fn zero_intensity_authored_light_is_retained_to_suppress_fallback_lighting() {
        let light = json!({
            "id": "blackout",
            "type": "light",
            "lightKind": "point",
            "x": 960,
            "y": 540,
            "zDepth": 500,
            "visible": true,
            "opacity": 1,
            "intensity": 0,
            "color": "#ffffff",
            "range": 1000,
            "decay": 2
        });
        let prepared = prepare_scene(&minimal_scene(vec![light])).expect("light must prepare");
        assert_eq!(prepared.lights.len(), 1);
        assert_eq!(prepared.lights[0].intensity, 0.0);
    }

    #[test]
    fn native_light_budget_is_explicit_and_take_blocking() {
        let lights = (0..MAX_PREPARED_LIGHTS + 1)
            .map(|index| {
                json!({
                    "id": format!("light_{index}"),
                    "type": "light",
                    "lightKind": "directional",
                    "x": 0,
                    "y": 0,
                    "zDepth": 100,
                    "visible": true,
                    "intensity": 1,
                    "color": "#ffffff"
                })
            })
            .collect();
        let prepared = prepare_scene(&minimal_scene(lights)).expect("lights must prepare");
        assert_eq!(prepared.lights.len(), MAX_PREPARED_LIGHTS);
        assert!(prepared
            .take_blockers
            .iter()
            .any(|warning| warning.contains("first 16")));
    }

    #[test]
    fn rejects_bad_canvas() {
        let mut scene = minimal_scene(vec![]);
        scene["canvas"]["width"] = json!(0);
        assert!(matches!(
            prepare_scene(&scene),
            Err(SceneError::InvalidCanvas { .. })
        ));
    }

    #[test]
    fn parses_hex_forms() {
        assert_eq!(parse_hex_color("#fff"), Some([1.0, 1.0, 1.0, 1.0]));
        assert_eq!(parse_hex_color("#ff0000"), Some([1.0, 0.0, 0.0, 1.0]));
        let with_alpha = parse_hex_color("#ff000080").expect("8-digit hex must parse");
        assert!((with_alpha[3] - 128.0 / 255.0).abs() < 1e-6);
        assert_eq!(parse_hex_color("red"), None);
        assert_eq!(parse_hex_color("#12345"), None);
    }
}
