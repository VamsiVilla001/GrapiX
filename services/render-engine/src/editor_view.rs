//! Private native render view for Editor authoring.
//!
//! Editor receives pixels produced by the same prepared scene and WGSL pipelines as
//! Program. This module deliberately has no Program or output verbs: it renders an
//! explicitly bounded private view and returns premultiplied BGRA bytes plus the
//! metadata the browser needs for selection overlays.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use grapix_render_core::renderer::gpu::GpuContext;

use crate::animation::SceneAnimation;
use crate::protocol::SceneRef;
use crate::protocol::{ErrorCode, ProtocolError};
use crate::render::rebase_scene_json;
use crate::scene_renderer::SceneRenderer;
use crate::stage::{Point, Rect};

/// Editor-only view request. The requested rectangle and pixels are bounded before
/// a GPU target is resized, so authoring cannot use a huge stage as an allocation
/// request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorViewRequest {
    pub view_id: String,
    /// Monotonic per view, assigned by the Editor. The client drops a frame from
    /// an older generation after a resize, reconnect, or a new SceneRef.
    pub view_generation: u64,
    pub bounds: EditorViewBounds,
    pub pixel_width: u32,
    pub pixel_height: u32,
    #[serde(default)]
    pub frame: u64,
    /// A point in logical scene coordinates for hit-testing, if the Editor needs it.
    pub pick: Option<EditorViewPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EditorViewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl EditorViewBounds {
    fn rect(self) -> Rect {
        Rect::new(self.x, self.y, self.width, self.height)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EditorViewPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorObjectBounds {
    pub object_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Metadata is JSON-safe; bytes travel separately in a WebSocket binary message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorViewFrameMetadata {
    pub view_id: String,
    pub view_generation: u64,
    /// Request/session-scoped identifier. A transport writes this in both the JSON
    /// notification and binary frame header, so frames cannot be paired by arrival order.
    pub frame_id: String,
    pub scene_ref: SceneRef,
    pub width: u32,
    pub height: u32,
    pub pixel_format: &'static str,
    pub alpha_mode: &'static str,
    pub logical_bounds: EditorViewBounds,
    pub camera: EditorViewBounds,
    pub object_bounds: Vec<EditorObjectBounds>,
    pub picked_object_id: Option<String>,
    pub frame: u64,
}

/// A native, premultiplied BGRA frame. `pixels` are never JSON/base64 encoded: the
/// transport emits [`pack_binary_frame`] after the JSON event envelope so callers
/// retain an actual binary alpha path.
pub struct EditorViewFrame {
    pub metadata: EditorViewFrameMetadata,
    pub pixels: Vec<u8>,
}

/// A binary message has a fixed-size header length followed by UTF-8 metadata and
/// raw BGRA pixels. The header lets a client pair metadata and pixels without a
/// second base64 allocation or a fragile event ordering assumption.
pub fn pack_binary_frame(
    metadata: &EditorViewFrameMetadata,
    pixels: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    let header = serde_json::to_vec(metadata).map_err(|error| {
        ProtocolError::new(
            ErrorCode::InternalError,
            format!("editor view metadata encoding failed: {error}"),
        )
    })?;
    let expected = usize::try_from(metadata.width)
        .ok()
        .and_then(|width| {
            usize::try_from(metadata.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| {
            ProtocolError::new(ErrorCode::InvalidPayload, "editor view dimensions overflow")
        })?;
    if pixels.len() != expected {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            format!(
                "editor view frame contains {} bytes; expected {expected}",
                pixels.len()
            ),
        ));
    }
    let header_length = u32::try_from(header.len()).map_err(|_| {
        ProtocolError::new(
            ErrorCode::InvalidPayload,
            "editor view metadata is too large",
        )
    })?;
    let mut packet = Vec::with_capacity(4 + header.len() + pixels.len());
    packet.extend_from_slice(&header_length.to_be_bytes());
    packet.extend_from_slice(&header);
    packet.extend_from_slice(pixels);
    Ok(packet)
}

/// Render an authoring frame through the Engine's shared prepared runtime.
pub fn render_editor_view(
    gpu: &Arc<GpuContext>,
    renderer: &mut SceneRenderer,
    scene_ref: &SceneRef,
    source_document: &Value,
    request: &EditorViewRequest,
    max_pixels: u64,
) -> Result<EditorViewFrame, ProtocolError> {
    validate_request(request, max_pixels)?;
    let bounds = request.bounds.rect();
    let document = source_document.clone();
    renderer.resize(gpu, request.pixel_width, request.pixel_height);
    let video = renderer
        .render(
            gpu,
            &scene_ref.scene_id,
            scene_ref.revision,
            (bounds.x, bounds.y, bounds.width, bounds.height),
            request.frame,
            || {
                let rebased = rebase_scene_json(
                    &document,
                    Point::new(bounds.x, bounds.y),
                    bounds.width,
                    bounds.height,
                );
                let prepared = grapix_render_core::scene::prepare_scene(&rebased)
                    .map_err(|error| format!("editor view scene preparation failed: {error}"))?;
                Ok((prepared, SceneAnimation::from_document(&document)))
            },
        )
        .map_err(|error| ProtocolError::new(ErrorCode::InternalError, error))?;

    let object_bounds = object_bounds(&document);
    let picked_object_id = request.pick.and_then(|point| pick(&object_bounds, point));
    Ok(EditorViewFrame {
        metadata: EditorViewFrameMetadata {
            view_id: request.view_id.clone(),
            view_generation: request.view_generation,
            frame_id: format!(
                "{}:{}:{}:{}",
                scene_ref.cache_key(),
                request.view_id,
                request.view_generation,
                request.frame
            ),
            scene_ref: scene_ref.clone(),
            width: video.width,
            height: video.height,
            pixel_format: "bgra8-premultiplied",
            alpha_mode: "premultiplied",
            logical_bounds: request.bounds,
            camera: request.bounds,
            object_bounds,
            picked_object_id,
            frame: request.frame,
        },
        pixels: video.data.as_slice().to_vec(),
    })
}

fn validate_request(request: &EditorViewRequest, max_pixels: u64) -> Result<(), ProtocolError> {
    if request.view_id.trim().is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            "editor viewId must be non-empty",
        ));
    }
    if !request.bounds.width.is_finite()
        || !request.bounds.height.is_finite()
        || request.bounds.width <= 0.0
        || request.bounds.height <= 0.0
    {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            "editor view bounds must be finite and non-empty",
        ));
    }
    let pixels = u64::from(request.pixel_width) * u64::from(request.pixel_height);
    if request.pixel_width == 0 || request.pixel_height == 0 || pixels > max_pixels {
        return Err(ProtocolError::new(
            ErrorCode::PreviewTooLarge,
            format!(
                "editor view is {}x{} ({pixels} pixels); budget is {max_pixels}",
                request.pixel_width, request.pixel_height
            ),
        ));
    }
    Ok(())
}

fn object_bounds(document: &Value) -> Vec<EditorObjectBounds> {
    document
        .get("objects")
        .and_then(Value::as_array)
        .map(|objects| {
            objects
                .iter()
                .filter(|object| {
                    object
                        .get("visible")
                        .and_then(Value::as_bool)
                        .unwrap_or(true)
                })
                .filter_map(|object| {
                    let object_id = object.get("id")?.as_str()?.to_string();
                    let x = object.get("x").and_then(Value::as_f64).unwrap_or(0.0);
                    let y = object.get("y").and_then(Value::as_f64).unwrap_or(0.0);
                    let width = object
                        .get("width")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        .abs();
                    let height = object
                        .get("height")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        .abs();
                    (width > 0.0 && height > 0.0).then_some(EditorObjectBounds {
                        object_id,
                        x,
                        y,
                        width,
                        height,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pick(bounds: &[EditorObjectBounds], point: EditorViewPoint) -> Option<String> {
    // Reverse painter order: the last object painted is the one the operator sees.
    bounds
        .iter()
        .rev()
        .find(|bounds| {
            point.x >= bounds.x
                && point.x <= bounds.x + bounds.width
                && point.y >= bounds.y
                && point.y <= bounds.y + bounds.height
        })
        .map(|bounds| bounds.object_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_preserves_metadata_and_binary_alpha_bytes() {
        let metadata = EditorViewFrameMetadata {
            view_id: "authoring-1".to_string(),
            view_generation: 3,
            frame_id: "project-1:authoring:scene-1:4:authoring-1:3:9".to_string(),
            scene_ref: SceneRef {
                project_id: "project-1".to_string(),
                domain: crate::protocol::SceneDomain::Authoring,
                scene_id: "scene-1".to_string(),
                revision: 4,
            },
            width: 2,
            height: 1,
            pixel_format: "bgra8-premultiplied",
            alpha_mode: "premultiplied",
            logical_bounds: EditorViewBounds {
                x: 0.0,
                y: 0.0,
                width: 2.0,
                height: 1.0,
            },
            camera: EditorViewBounds {
                x: 0.0,
                y: 0.0,
                width: 2.0,
                height: 1.0,
            },
            object_bounds: Vec::new(),
            picked_object_id: None,
            frame: 9,
        };
        let packet = pack_binary_frame(&metadata, &[1, 2, 3, 255, 4, 5, 6, 0]).unwrap();
        let header_len = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
        let decoded: Value = serde_json::from_slice(&packet[4..4 + header_len]).unwrap();
        assert_eq!(decoded["frameId"], metadata.frame_id);
        assert_eq!(decoded["sceneRef"]["sceneId"], metadata.scene_ref.scene_id);
        assert_eq!(&packet[4 + header_len..], &[1, 2, 3, 255, 4, 5, 6, 0]);
    }

    #[test]
    fn pick_uses_topmost_painter_order() {
        let document = serde_json::json!({"objects": [
            {"id": "back", "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0},
            {"id": "front", "x": 5.0, "y": 5.0, "width": 10.0, "height": 10.0}
        ]});
        assert_eq!(
            pick(
                &object_bounds(&document),
                EditorViewPoint { x: 6.0, y: 6.0 }
            ),
            Some("front".to_string())
        );
    }
}
