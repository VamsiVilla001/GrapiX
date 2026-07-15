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

/// Only rects render in v1. Every other object type produces an explicit
/// warning so nobody believes text or images are on air when they are not.
const SUPPORTED_VERSION: u64 = 1;

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
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default = "default_visible")]
    visible: bool,
    #[serde(default)]
    fill: String,
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
    pub fill_linear_premultiplied: [f32; 4],
    /// Shared blend-mode id from packages/render-shaders/layouts.json.
    pub blend_mode: u32,
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
    /// Render-ordered (layerId, zDepth, zIndex).
    pub rects: Vec<PreparedRect>,
    pub object_count: usize,
    /// Human-readable warnings for everything the v1 renderer does NOT draw.
    pub warnings: Vec<String>,
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

    let mut warnings = Vec::new();
    let mut rects: Vec<(String, f64, f64, PreparedRect)> = Vec::new();
    let mut unsupported_counts: Vec<(String, usize)> = Vec::new();

    for object in &document.objects {
        let object_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("<missing type>");

        if object_type != "rect" {
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
            warnings.push(format!(
                "rect {} has radius {}; rounded corners are not rendered yet (drawn sharp)",
                rect.id, rect.radius
            ));
        }

        let mut fill_source = rect.fill.clone();
        let mut opacity = rect.opacity;
        let mut blend_mode = 0;
        let mut force_opaque = false;

        if let Some(binding_value) = rect.material_slots.get("main") {
            if let Some(binding) = parse_material_binding(binding_value) {
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

                blend_mode = match material.blend_mode.as_deref().unwrap_or("normal") {
                    "normal" => 0,
                    "add" => 3,
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

        let prepared = PreparedRect {
            object_id: rect.id,
            x: rect.x as f32,
            y: rect.y as f32,
            width: rect.width as f32,
            height: rect.height as f32,
            rotation_degrees: rect.rotation as f32,
            fill_linear_premultiplied: to_linear_premultiplied(fill, opacity as f32),
            blend_mode,
        };

        rects.push((rect.layer_id, rect.z_depth, rect.z_index, prepared));
    }

    for (kind, count) in &unsupported_counts {
        warnings.push(format!(
            "{count} object(s) of type {kind:?} are NOT rendered: v1 renders solid-color rects only"
        ));
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

    Ok(PreparedScene {
        scene_id: document.id,
        name: document.name,
        revision: document.updated_at,
        canvas_width: document.canvas.width as f32,
        canvas_height: document.canvas.height as f32,
        background_linear_premultiplied: to_linear_premultiplied(background, 1.0),
        rects: rects.into_iter().map(|(_, _, _, rect)| rect).collect(),
        object_count: document.objects.len(),
        warnings,
    })
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
