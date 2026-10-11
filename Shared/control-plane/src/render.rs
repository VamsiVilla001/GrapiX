//! Headless render (11.41): one request renders one pinned revision at one
//! authored frame.
//!
//! The image itself does not travel here. The control plane is ordered and
//! kept small so a cue is never queued behind bulk bytes (ADR-001). A render
//! reply names the image by its content hash, and the bytes are fetched from
//! the asset plane, where they are verified against that hash.
//!
//! Thumbnails, golden frames, approval previews, `render.preview` and Phase 13
//! parity all ask for pixels this one way. The image is the scene's canvas at
//! the authored frame, encoded as an sRGB PNG: the Preview transform, because
//! every consumer of a headless image looks at it on a computer display.

use gx_contracts::{ContentHash, Refusal, Revision, TakeId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::intent::{check_reference, HeldRevision};

/// Render a published revision at a frame of its own timeline.
///
/// `frame` is a scene frame, counted from the start of the scene's timeline,
/// not an engine frame: the same request gives the same image whenever it is
/// asked, and Program's clock plays no part in it (invariant 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub take_id: TakeId,
    pub revision: Revision,
    /// The content hash the caller pinned, as on a take (invariant 61).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub content_hash: Option<ContentHash>,
    pub frame: u64,
}

/// What a headless render produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenderedFrame {
    pub take_id: TakeId,
    pub revision: Revision,
    /// The revision's content hash: what was rendered.
    pub content_hash: ContentHash,
    pub frame: u64,
    pub width: u32,
    pub height: u32,
    /// SHA-256 of the PNG bytes. The asset plane serves them by this address.
    pub image: ContentHash,
    pub image_bytes: u64,
}

/// The validation every peer runs before it renders, in this order: the
/// shared reference rule (unknown take, wrong revision, missing or wrong pin),
/// then a scene to render behind the revision, then a frame inside the
/// scene's timeline. `duration_frames` is the timeline length of the scene the
/// peer holds for this revision, or `None` when it holds no scene (an
/// identifier-only publish). The engine and the mock engine both call this,
/// so neither renders what the other refuses (invariant 45).
pub fn check_render(
    request: &RenderRequest,
    held: Option<&HeldRevision>,
    duration_frames: Option<u64>,
) -> Result<(), Refusal> {
    check_reference(
        &request.take_id,
        request.revision,
        request.content_hash.as_ref(),
        held,
    )?;
    let duration_frames = duration_frames.ok_or_else(|| Refusal::RenderSceneUnavailable {
        take_id: request.take_id.clone(),
        revision: request.revision,
    })?;
    // Program evaluates frames up to and including the timeline's last frame,
    // so a render may ask for exactly what Program can show.
    if request.frame > duration_frames {
        return Err(Refusal::RenderFrameOutOfRange {
            take_id: request.take_id.clone(),
            revision: request.revision,
            frame: request.frame,
            duration_frames,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(frame: u64, pin: Option<&str>) -> RenderRequest {
        RenderRequest {
            take_id: TakeId("lt".into()),
            revision: Revision(2),
            content_hash: pin.map(|pin| ContentHash(pin.into())),
            frame,
        }
    }

    #[test]
    fn a_render_is_refused_in_reference_then_scene_then_frame_order() {
        let held = HeldRevision {
            revision: Revision(2),
            content_hash: ContentHash("a".into()),
        };
        assert!(matches!(
            check_render(&request(0, Some("a")), None, Some(10)),
            Err(Refusal::UnknownTake { .. })
        ));
        assert!(matches!(
            check_render(&request(99, None), Some(&held), Some(10)),
            Err(Refusal::RevisionUnpinned { .. })
        ));
        assert!(matches!(
            check_render(&request(99, Some("a")), Some(&held), None),
            Err(Refusal::RenderSceneUnavailable { .. })
        ));
        assert!(matches!(
            check_render(&request(11, Some("a")), Some(&held), Some(10)),
            Err(Refusal::RenderFrameOutOfRange { frame: 11, duration_frames: 10, .. })
        ));
        assert_eq!(check_render(&request(10, Some("a")), Some(&held), Some(10)), Ok(()));
    }
}
