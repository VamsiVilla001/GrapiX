//! Authored scene camera resolution for the native Program renderer.
//!
//! # Why this exists
//!
//! The daemon used to ignore authored cameras entirely and frame every mesh
//! with a fixed 45-degree synthetic camera derived from the canvas size. The
//! editor's Three.js layer honours authored cameras, so Preview and Program
//! disagreed about the framing of the whole image, not just about one object.
//!
//! # Source of truth
//!
//! This module replicates TWO editor stages, in this order:
//!
//! 1. `normalizeScene`'s camera repair
//!    (`apps/editor-web/src/store/editorStore.ts:2477-2479` and `:2524-2532`),
//!    which fills defaults and, critically, rewrites a `zDepth` of exactly 0
//!    on a camera with no authored `target` to the scene focal distance.
//! 2. `resolveSceneCamera` (`apps/editor-web/src/rendering/ThreeSceneLayer.ts:239-283`)
//!    plus its helpers `safeCameraUp` (`:418-433`), `finiteNumber` (`:435-437`)
//!    and `clampFinite` (`:439-441`).
//!
//! Stage 1 is NOT optional for the daemon. `POST /api/render-daemon/scenes/
//! :sceneId/load` hands the raw persisted document straight to the daemon
//! (`services/api-server/src/index.ts:757-763`) and the API server performs no
//! camera normalization at all, so a document that never passed through the
//! editor store arrives unrepaired. Skipping stage 1 would put a camera
//! authored at `zDepth: 0` coplanar with its own target, which makes
//! `look_at_rh` degenerate -- while the scene reported itself Take-ready.
//!
//! Consolidating stage 1 into shared normalization so both renderers read
//! already-repaired documents is a recommended follow-up, not this change.
//!
//! # Scope
//!
//! Cameras affect the MESH path only, because that is what the editor does:
//! its camera lives solely inside `ThreeSceneLayer`, while the Pixi 2D layer
//! places objects unprojected. Making the daemon's 2D quad path follow the
//! camera would make the daemon diverge from the editor, which is the opposite
//! of the goal here. See `docs/rendering-engine.md`.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use super::diagnostics::{DiagnosticSeverity, DiagnosticSink};

pub const CAMERA_OBJECT_TYPE: &str = "camera";

/// `DEFAULT_FOV`, ThreeSceneLayer.ts:15.
const DEFAULT_FOV_DEGREES: f64 = 45.0;
/// `MIN_CAMERA_NEAR`, ThreeSceneLayer.ts:16.
const MIN_CAMERA_NEAR: f64 = 0.01;
/// `MIN_CAMERA_FAR_SPAN`, ThreeSceneLayer.ts:17.
const MIN_CAMERA_FAR_SPAN: f64 = 0.01;
/// `normalizeScene`'s `far` default, editorStore.ts:2528. Applied BEFORE
/// `resolveSceneCamera`'s clamp, so a document with no `far` resolves to this
/// and never to `fallback_far`.
const NORMALIZED_FAR_DEFAULT: f64 = 20_000.0;
/// Beyond this far/near ratio a `depth32float` attachment cannot separate
/// near-coplanar meshes reliably.
const IMPRECISE_DEPTH_RATIO: f64 = 1.0e6;

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Vec3PartialDto {
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub z: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraObjectDto {
    pub id: String,
    /// Required in TypeScript (`CameraSceneObject.cameraKind`) but defaulted
    /// here so documents written before the field existed still deserialize.
    /// An unrecognised value is a hard failure, never a silent fallback.
    #[serde(default = "default_camera_kind")]
    pub camera_kind: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub z_depth: Option<f64>,
    #[serde(default)]
    pub fov: Option<f64>,
    #[serde(default)]
    pub zoom: Option<f64>,
    #[serde(default)]
    pub near: Option<f64>,
    #[serde(default)]
    pub far: Option<f64>,
    #[serde(default)]
    pub target: Option<Vec3PartialDto>,
    #[serde(default)]
    pub up: Option<Vec3PartialDto>,
    #[serde(default)]
    pub bindings: HashMap<String, Value>,
    #[serde(default)]
    pub animation: HashMap<String, Value>,
}

fn default_camera_kind() -> String {
    "perspective".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PreparedCameraKind {
    /// `y_scale = zoom / tan(fov_radians / 2)`, computed in f64 then cast.
    ///
    /// `y_scale` is stored rather than recomputed from `fov_radians` on the
    /// render thread on purpose: folding `zoom` back into an effective fov
    /// pushes `fov/2` toward pi/2 for any `zoom < 1`, exactly where a
    /// `cos(fov/2)` term loses relative precision. `fov_radians` is retained
    /// for diagnostics and tests only.
    Perspective { fov_radians: f32, y_scale: f32 },
    /// Half-extents in scene pixels: `canvas / 2 / zoom`. Independent of camera
    /// distance, matching `THREE.OrthographicCamera` as the editor builds it.
    Orthographic { half_width: f32, half_height: f32 },
}

#[derive(Debug, Clone)]
pub struct PreparedCamera {
    pub object_id: String,
    pub kind: PreparedCameraKind,
    /// Resolved zoom, ALREADY folded into `kind`. Reporting and tests only --
    /// never apply it a second time.
    pub zoom: f32,
    pub near: f32,
    pub far: f32,
    pub position: [f32; 3],
    pub target: [f32; 3],
    /// Guaranteed unit length and guaranteed not parallel to
    /// `target - position`.
    pub up: [f32; 3],
}

/// `finiteNumber`, ThreeSceneLayer.ts:435-437.
fn finite_number(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(value) if value.is_finite() => value,
        _ => fallback,
    }
}

/// `clampFinite`, ThreeSceneLayer.ts:439-441.
///
/// Written as `min.max(max.min(v))` rather than `v.clamp(min, max)` because
/// Rust's `clamp` PANICS when `min > max` while the JavaScript original
/// silently returns `min`. The far clamp can invert on an absurd canvas.
fn clamp_finite(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    min.max(max.min(finite_number(value, fallback)))
}

/// `sceneVector`, ThreeSceneLayer.ts:410-416: resolved PER COMPONENT, so a
/// partially authored vector keeps its authored components.
fn scene_vector(value: Option<Vec3PartialDto>, fallback: [f64; 3]) -> [f64; 3] {
    let value = value.unwrap_or_default();
    [
        finite_number(value.x, fallback[0]),
        finite_number(value.y, fallback[1]),
        finite_number(value.z, fallback[2]),
    ]
}

/// `sceneFocalDistance`, editorStore.ts:2639-2641.
fn scene_focal_distance(canvas_height: f64) -> f64 {
    (canvas_height / 2.0) / (DEFAULT_FOV_DEGREES.to_radians() / 2.0).tan()
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn length_squared(v: [f64; 3]) -> f64 {
    v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let length = length_squared(v).sqrt();
    if length == 0.0 {
        return [0.0, 0.0, 0.0];
    }
    [v[0] / length, v[1] / length, v[2] / length]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `safeCameraUp`, ThreeSceneLayer.ts:418-433.
///
/// Guarantees the returned up is unit length and not parallel to the view
/// direction, which is what keeps `Mat4::look_at_rh` out of its NaN case.
/// glam normalizes the right vector itself, so the normalization here exists
/// to satisfy glam's optional `glam_assert!(up.is_normalized())` and to match
/// the editor bit for bit.
fn safe_camera_up(position: [f64; 3], target: [f64; 3], candidate: [f64; 3]) -> [f64; 3] {
    let up = if length_squared(candidate) > 0.000001 {
        normalize(candidate)
    } else {
        [0.0, -1.0, 0.0]
    };

    let view_direction = normalize(sub(target, position));
    if dot(view_direction, up).abs() < 0.999 {
        return up;
    }

    if view_direction[1].abs() < 0.9 {
        [0.0, -1.0, 0.0]
    } else {
        [1.0, 0.0, 0.0]
    }
}

/// Why an authored camera could not be honoured natively.
struct CameraRefusal {
    code: &'static str,
    detail: String,
}

/// Resolve the scene's active camera, emitting the diagnostics that describe
/// what the native renderer will actually do.
///
/// Returns `None` whenever the synthetic fallback will be used, which is the
/// same fallback the editor uses in the equivalent cases.
pub fn resolve_active_camera(
    active_camera_id: Option<&str>,
    scene_json: &Value,
    objects: &[Value],
    canvas_width: f64,
    canvas_height: f64,
    sink: &mut DiagnosticSink,
) -> Option<PreparedCamera> {
    let cameras: Vec<&Value> = objects
        .iter()
        .filter(|object| object.get("type").and_then(Value::as_str) == Some(CAMERA_OBJECT_TYPE))
        .collect();

    if cameras.is_empty() {
        return None;
    }

    let requested_id = active_camera_id.filter(|id| !id.is_empty());

    // normalizeScene's activeCameraId repair, editorStore.ts:2575-2577. The
    // requested lookup deliberately does NOT check visibility, so an invisible
    // requested id survives normalization and then falls through to the
    // synthetic camera -- exactly as ThreeSceneLayer.ts:243-247 does.
    let requested = requested_id.and_then(|id| {
        cameras
            .iter()
            .copied()
            .find(|camera| camera.get("id").and_then(Value::as_str) == Some(id))
    });
    let effective = requested.or_else(|| {
        cameras
            .iter()
            .copied()
            .find(|camera| camera.get("visible").and_then(Value::as_bool) == Some(true))
    });

    let Some(active) = effective else {
        emit_inactive(sink, cameras.len());
        return None;
    };

    // The editor requires `visible` truthy and never defaults it.
    if active.get("visible").and_then(Value::as_bool) != Some(true) {
        emit_inactive(sink, cameras.len());
        return None;
    }

    let camera_id = active
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("<unknown>")
        .to_string();

    match build_camera(active, objects, scene_json, canvas_width, canvas_height) {
        Ok(camera) => {
            if (camera.far as f64) / (camera.near as f64) > IMPRECISE_DEPTH_RATIO {
                // Deliberately Degraded, not Omitted: everything authored is
                // present and framed correctly. Only depth separation between
                // near-coplanar meshes is at risk, and the authored `far` is
                // used verbatim because clamping it would clip geometry the
                // editor shows -- a worse divergence than z-fighting.
                sink.emit_for_object(
                    "camera.depth-range.imprecise",
                    DiagnosticSeverity::Degraded,
                    format!(
                        "camera {camera_id:?} spans near {} to far {} (ratio {:.0}); a 32-bit \
                         depth buffer may not separate near-coplanar meshes at that range",
                        camera.near,
                        camera.far,
                        (camera.far as f64) / (camera.near as f64)
                    ),
                    camera_id.clone(),
                    CAMERA_OBJECT_TYPE,
                );
            }
            Some(camera)
        }
        Err(refusal) => {
            let name = active
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("<unnamed>");
            sink.emit_for_object(
                refusal.code,
                DiagnosticSeverity::Invalid,
                format!(
                    "scene selects camera {camera_id:?} ({name:?}) as active, but the native \
                     renderer cannot reproduce it: {}. It falls back to a fixed 45-degree \
                     perspective derived from the canvas size, so Program framing will not match \
                     Preview and the whole frame is untrustworthy -- not just this object",
                    refusal.detail
                ),
                camera_id,
                CAMERA_OBJECT_TYPE,
            );
            None
        }
    }
}

fn emit_inactive(sink: &mut DiagnosticSink, camera_count: usize) {
    // Cameras exist but none is honoured, so the native viewpoint is the same
    // one the editor falls back to. Nothing is mis-framed; the camera objects
    // are simply not drawn as gizmos, which is also true in the editor (their
    // gizmos are Pixi editor chrome, not scene content).
    sink.emit(
        "camera.inactive.not-rendered",
        DiagnosticSeverity::Info,
        format!(
            "{camera_count} camera object(s) are present but none is active and visible; the \
             native renderer uses its default viewpoint and does not draw camera gizmos"
        ),
    );
}

fn build_camera(
    active: &Value,
    objects: &[Value],
    scene_json: &Value,
    canvas_width: f64,
    canvas_height: f64,
) -> Result<PreparedCamera, CameraRefusal> {
    let dto: CameraObjectDto =
        serde_json::from_value(active.clone()).map_err(|error| CameraRefusal {
            code: "camera.active.unsupported",
            detail: format!("its camera fields could not be read ({error})"),
        })?;

    // The daemon performs no hierarchy resolution, so a container-parented
    // camera would be framed from its unparented transform while the editor
    // frames it from the inherited one. This also covers inherited
    // visibility: the editor ANDs a container's visibility onto its children.
    if let Some(parent_id) = container_parent_of(&dto.id, objects) {
        return Err(CameraRefusal {
            code: "camera.parented.unsupported",
            detail: format!(
                "it is a child of container {parent_id:?} and the native renderer does not \
                 resolve hierarchy transforms, so its inherited position and visibility are \
                 not applied"
            ),
        });
    }

    // The daemon performs no timeline evaluation, so an animated camera would
    // be frozen at its authored values while the editor moves it.
    if let Some(reason) = camera_animation_reason(&dto, scene_json) {
        return Err(CameraRefusal {
            code: "camera.animated.unsupported",
            detail: reason,
        });
    }

    if !dto.bindings.is_empty() {
        return Err(CameraRefusal {
            code: "camera.bound.unsupported",
            detail: format!(
                "it carries {} data binding(s) and the native renderer does not resolve \
                 bindings, so live data would not move it",
                dto.bindings.len()
            ),
        });
    }

    let width = canvas_width.max(1.0);
    let height = canvas_height.max(1.0);

    // --- Stage 1: normalizeScene's camera repair (editorStore.ts:2477-2479,
    // :2524-2532). A zDepth of exactly 0 with no authored target means "the
    // author did not place this camera", and the editor pulls it back to the
    // focal distance. Evaluated against the RAW authored target, before the
    // target default is applied.
    let repaired_z_depth = if dto.z_depth == Some(0.0) && dto.target.is_none() {
        Some(scene_focal_distance(height))
    } else {
        dto.z_depth
    };
    let normalized_far = Some(finite_number(dto.far, NORMALIZED_FAR_DEFAULT));

    // --- Stage 2: resolveSceneCamera (ThreeSceneLayer.ts:252-279).
    let fallback_far = 20_000.0_f64.max(width.max(height) * 10.0);
    let near = clamp_finite(dto.near, 1.0, MIN_CAMERA_NEAR, fallback_far);
    let far = clamp_finite(
        normalized_far,
        fallback_far,
        near + MIN_CAMERA_FAR_SPAN,
        1.0e9,
    );
    let zoom = clamp_finite(dto.zoom, 1.0, 0.01, 100.0);

    let position = [
        finite_number(dto.x, width / 2.0),
        finite_number(dto.y, height / 2.0),
        finite_number(repaired_z_depth, 0.0),
    ];
    let mut target = scene_vector(dto.target, [width / 2.0, height / 2.0, 0.0]);
    // ThreeSceneLayer.ts:274-276. Keeps look_at out of its degenerate case.
    if length_squared(sub(position, target)) < 0.000001 {
        target[2] = position[2] - 1.0;
    }
    let up = safe_camera_up(position, target, scene_vector(dto.up, [0.0, -1.0, 0.0]));

    let kind = match dto.camera_kind.as_str() {
        "perspective" => {
            let fov_radians = clamp_finite(dto.fov, DEFAULT_FOV_DEGREES, 1.0, 179.0).to_radians();
            // Three folds zoom into the projection, not the view:
            //   top = near * tan(fov/2) / zoom
            //   y_scale = 2*near/(top-bottom) = near/top = zoom / tan(fov/2)
            let y_scale = zoom / (fov_radians / 2.0).tan();
            PreparedCameraKind::Perspective {
                fov_radians: fov_radians as f32,
                y_scale: y_scale as f32,
            }
        }
        "orthographic" => PreparedCameraKind::Orthographic {
            half_width: (width / 2.0 / zoom) as f32,
            half_height: (height / 2.0 / zoom) as f32,
        },
        other => {
            return Err(CameraRefusal {
                code: "camera.kind.unsupported",
                detail: format!(
                    "its cameraKind {other:?} is neither \"perspective\" nor \"orthographic\""
                ),
            })
        }
    };

    let camera = PreparedCamera {
        object_id: dto.id,
        kind,
        zoom: zoom as f32,
        near: near as f32,
        far: far as f32,
        position: [position[0] as f32, position[1] as f32, position[2] as f32],
        target: [target[0] as f32, target[1] as f32, target[2] as f32],
        up: [up[0] as f32, up[1] as f32, up[2] as f32],
    };

    // An authored 1e300 is finite as f64 and becomes infinity when cast to
    // f32, which would poison the whole view-projection matrix.
    if !camera_is_finite(&camera) {
        return Err(CameraRefusal {
            code: "camera.values.unrepresentable",
            detail: "one of its resolved values is not representable as a 32-bit float".to_string(),
        });
    }

    Ok(camera)
}

fn camera_is_finite(camera: &PreparedCamera) -> bool {
    let mut values = vec![camera.zoom, camera.near, camera.far];
    values.extend_from_slice(&camera.position);
    values.extend_from_slice(&camera.target);
    values.extend_from_slice(&camera.up);
    match camera.kind {
        PreparedCameraKind::Perspective {
            fov_radians,
            y_scale,
        } => values.extend_from_slice(&[fov_radians, y_scale]),
        PreparedCameraKind::Orthographic {
            half_width,
            half_height,
        } => values.extend_from_slice(&[half_width, half_height]),
    }
    values.iter().all(|value| value.is_finite())
}

/// The id of a layer or group that lists `camera_id` in its `childIds`.
///
/// A raw `childIds` scan is intentionally coarser than the editor's
/// `resolveSceneObjectHierarchy`, which rejects self-references, cycles and
/// second parents. Being coarse here can only over-refuse a malformed
/// hierarchy, which is the safe direction: it falls back to the synthetic
/// camera and says so, rather than framing from a transform the editor did not
/// use.
fn container_parent_of(camera_id: &str, objects: &[Value]) -> Option<String> {
    objects.iter().find_map(|object| {
        let object_type = object.get("type").and_then(Value::as_str)?;
        if object_type != "layer" && object_type != "group" {
            return None;
        }
        let children = object.get("childIds").and_then(Value::as_array)?;
        let contains = children
            .iter()
            .any(|child| child.as_str() == Some(camera_id));
        if contains {
            Some(
                object
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("<unknown>")
                    .to_string(),
            )
        } else {
            None
        }
    })
}

/// Whether this specific camera is animated.
///
/// Scoped to the camera rather than the whole scene on purpose. A scene whose
/// *other* objects animate is a pre-existing native limitation unrelated to
/// framing, and refusing the camera for it would leave nearly every real
/// broadcast scene on the synthetic viewpoint for no camera-related reason.
fn camera_animation_reason(dto: &CameraObjectDto, scene_json: &Value) -> Option<String> {
    if !dto.animation.is_empty() {
        let mut channels: Vec<&str> = dto.animation.keys().map(String::as_str).collect();
        channels.sort_unstable();
        return Some(format!(
            "it has animated propert{} ({}) and the native renderer does not evaluate \
             animation channels",
            if channels.len() == 1 { "y" } else { "ies" },
            channels.join(", ")
        ));
    }

    let keyframe_count = scene_json
        .get("timeline")
        .and_then(|timeline| timeline.get("keyframes"))
        .and_then(Value::as_array)
        .map(|keyframes| {
            keyframes
                .iter()
                .filter(|keyframe| {
                    keyframe.get("objectId").and_then(Value::as_str) == Some(dto.id.as_str())
                })
                .count()
        })
        .unwrap_or(0);

    if keyframe_count > 0 {
        return Some(format!(
            "the scene timeline holds {keyframe_count} keyframe(s) for it and the native \
             renderer does not evaluate the timeline"
        ));
    }

    None
}
