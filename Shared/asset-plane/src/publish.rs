//! Asset-plane publication messages shared by an Editor and an engine mock.
//!
//! A scene document is content, not a Program command: carrying it on the
//! restartable asset plane prevents a large publish from delaying control-plane
//! intent (ADR-001). The explicit refusal reply prevents malformed authoring
//! data from being silently skipped.

use gx_contracts::scene::SceneDocument;
use gx_contracts::{Revision, TakeId};
use serde::{Deserialize, Serialize};

/// A complete, self-describing authored scene awaiting publication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub scene: SceneDocument,
}

/// The asset-plane reply to one publication request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "reply",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PublishReply {
    /// A new immutable revision. Takes must name this exact revision.
    Published { take_id: TakeId, revision: Revision },
    /// The request was rejected as one atomic unit; no partial revision exists.
    Refused(PublishRefusal),
}

/// A named reason an authored document cannot become a published revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "refusal",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PublishRefusal {
    /// The JSON document was not a known `SceneDocument`, including an unknown
    /// object kind. The detail is preserved for the author to correct it.
    InvalidSceneDocument { detail: String },
}
