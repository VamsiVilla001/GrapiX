//! The Editor's Tauri 2 shell (build plan 11.1).
//!
//! **This file is where invariants 4 and 5 are enforced.** The Editor owns
//! mutable authoring content and cannot change Program or outputs. That is
//! not a runtime check on a message here — it is the absence of a command:
//! the surface below has no `cue`, no `take`, no `clear` and no
//! `configure_output`, so a compromised or mistaken web layer cannot reach
//! one however it asks. A flag on a shared command would be a check that can
//! be forgotten; an absent command cannot be.
//!
//! What it does expose: create, load and save an authored `SceneDocument`,
//! and publish one over the asset plane. Publication is the whole of the
//! Editor's authority over Program — it produces a revision Playout may
//! later take, and nothing more (invariant 7: a mutable Editor scene never
//! replaces a published one in place).
//!
//! The shell never imports renderer internals (invariant 3). It speaks the
//! asset plane's published contract and holds no GPU state.

#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::path::PathBuf;

use gx_asset_plane::{publish_scene, PublishClientError, PublishRefusal, PublishReply};
use gx_contracts::scene::{parse_scene_document, SceneCanvas, SceneDocument, SceneTimeline};
use gx_contracts::{RationalRate, Revision, TakeId};
use serde::{Deserialize, Serialize};

/// The asset-plane endpoint an Editor publishes to by default.
///
/// The control port plus one, matching the worker's own default. Exposed to
/// the web layer as a starting value, never as a silent fallback: a failed
/// connection is reported with the address it tried.
pub const DEFAULT_ASSET_ENDPOINT: &str = "127.0.0.1:4401";

/// Everything the Editor shell can fail at, named.
///
/// One enum for the whole surface, because the web layer shows the same
/// message box for all of them and a stringly-typed error would let a
/// refusal be presented as a crash.
#[derive(Debug, Serialize)]
#[serde(tag = "error", rename_all = "camelCase")]
pub enum EditorError {
    /// The path could not be read.
    ReadScene { path: String, detail: String },
    /// The path could not be written.
    WriteScene { path: String, detail: String },
    /// The bytes are not a scene this schema accepts. Carries the contract's
    /// own refusal text, so an unknown field is named by its JSON path rather
    /// than reported as "invalid".
    InvalidScene { detail: String },
    /// The endpoint text is not a socket address.
    InvalidEndpoint { endpoint: String },
    /// The asset plane could not be reached at all. Distinct from a refusal:
    /// nothing was decided, so nothing was published.
    Unreachable { endpoint: String, detail: String },
    /// The engine understood the document and declined it, by name.
    PublishRefused { detail: String },
    /// A reply arrived that is not a reply.
    Protocol { detail: String },
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadScene { path, detail } => write!(f, "cannot read {path}: {detail}"),
            Self::WriteScene { path, detail } => write!(f, "cannot write {path}: {detail}"),
            Self::InvalidScene { detail } => write!(f, "scene is not valid: {detail}"),
            Self::InvalidEndpoint { endpoint } => {
                write!(f, "{endpoint} is not a host:port address")
            }
            Self::Unreachable { endpoint, detail } => {
                write!(f, "cannot reach the asset plane at {endpoint}: {detail}")
            }
            Self::PublishRefused { detail } => write!(f, "publication refused: {detail}"),
            Self::Protocol { detail } => write!(f, "asset plane protocol failed: {detail}"),
        }
    }
}

impl std::error::Error for EditorError {}

/// What a successful publication produced.
///
/// The revision is the point: Playout takes an exact revision, so the Editor
/// must report the one it created rather than "published successfully".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub take_id: TakeId,
    pub revision: Revision,
}

/// An empty authored document at the canvas and rate the Editor starts from.
///
/// 1920×1080 at 50/1 is a starting point an author changes, not a policy:
/// the rate is rational because every rate in this system is (invariant 12).
pub fn new_scene(id: &str, name: &str) -> SceneDocument {
    SceneDocument {
        id: id.to_owned(),
        name: name.to_owned(),
        version: 1,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas {
            width: 1920,
            height: 1080,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline::default(),
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        objects: Vec::new(),
    }
}

/// Read an authored document, refusing anything the closed schema rejects.
///
/// Parsing goes through `parse_scene_document`, the same function the engine
/// and every mock use (invariant 45), so a document the Editor accepts is one
/// the engine will also parse. An Editor with a laxer reader would let an
/// author save something that refuses only at publish.
pub fn load_scene(path: &PathBuf) -> Result<SceneDocument, EditorError> {
    let bytes = std::fs::read(path).map_err(|error| EditorError::ReadScene {
        path: path.display().to_string(),
        detail: error.to_string(),
    })?;
    parse_scene_document(&bytes).map_err(|refusal| EditorError::InvalidScene {
        detail: refusal.to_string(),
    })
}

/// Write an authored document.
///
/// Pretty-printed because this file is edited by people and diffed in review;
/// the wire form is produced fresh at publish, so formatting here costs
/// nothing downstream.
pub fn save_scene(path: &PathBuf, scene: &SceneDocument) -> Result<(), EditorError> {
    let bytes = serde_json::to_vec_pretty(scene).map_err(|error| EditorError::Protocol {
        detail: error.to_string(),
    })?;
    std::fs::write(path, bytes).map_err(|error| EditorError::WriteScene {
        path: path.display().to_string(),
        detail: error.to_string(),
    })
}

/// Publish one complete document and report the revision it became.
///
/// Publication is atomic at the far end: the engine either produces a new
/// immutable revision or refuses the whole document (invariant 30). This
/// function keeps the two outcomes distinct all the way to the web layer —
/// an unreachable engine is not a refusal, and a refusal is not a crash.
pub fn publish(endpoint: &str, scene: SceneDocument) -> Result<PublishResult, EditorError> {
    let address: SocketAddr = endpoint.parse().map_err(|_| EditorError::InvalidEndpoint {
        endpoint: endpoint.to_owned(),
    })?;
    match publish_scene(address, scene) {
        Ok(PublishReply::Published { take_id, revision }) => {
            Ok(PublishResult { take_id, revision })
        }
        Ok(PublishReply::Refused(PublishRefusal::InvalidPublishRequest { detail })) => {
            Err(EditorError::PublishRefused { detail })
        }
        Ok(PublishReply::Refused(
            PublishRefusal::SceneRefused { cause } | PublishRefusal::PreparationRefused { cause },
        )) => Err(EditorError::PublishRefused {
            detail: cause.to_string(),
        }),
        Err(PublishClientError::Connect(source)) => Err(EditorError::Unreachable {
            endpoint: endpoint.to_owned(),
            detail: source.to_string(),
        }),
        Err(other) => Err(EditorError::Protocol {
            detail: other.to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// The Tauri command surface.
//
// Every command the Editor has. Read the list: there is no way to reach
// Program from here, and that is the design.
// ---------------------------------------------------------------------------

#[tauri::command]
fn cmd_new_scene(id: String, name: String) -> SceneDocument {
    new_scene(&id, &name)
}

#[tauri::command]
fn cmd_load_scene(path: String) -> Result<SceneDocument, EditorError> {
    load_scene(&PathBuf::from(path))
}

#[tauri::command]
fn cmd_save_scene(path: String, scene: SceneDocument) -> Result<(), EditorError> {
    save_scene(&PathBuf::from(path), &scene)
}

#[tauri::command]
fn cmd_publish(endpoint: String, scene: SceneDocument) -> Result<PublishResult, EditorError> {
    publish(&endpoint, scene)
}

#[tauri::command]
fn cmd_default_endpoint() -> &'static str {
    DEFAULT_ASSET_ENDPOINT
}

/// Build and run the Editor window.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            cmd_new_scene,
            cmd_load_scene,
            cmd_save_scene,
            cmd_publish,
            cmd_default_endpoint,
        ])
        .run(tauri::generate_context!())
        .expect("the Editor shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_scene_is_complete_authoring_content() {
        let scene = new_scene("lower-third", "Lower Third");
        assert_eq!(scene.id, "lower-third");
        assert_eq!(scene.canvas.frame_rate, RationalRate::P50);
        // Never pre-pinned: a revision exists only after the engine issues
        // one, so an unpublished document carrying one would be a lie.
        assert_eq!(scene.revision, None);
    }

    #[test]
    fn a_scene_round_trips_through_the_shared_reader() {
        let directory = std::env::temp_dir().join(format!(
            "gx-editor-shell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("temp directory");
        let path = directory.join("scene.json");

        let authored = new_scene("demo", "Demo");
        save_scene(&path, &authored).expect("a new scene saves");
        let read_back = load_scene(&path).expect("what the Editor wrote, it can read");

        assert_eq!(read_back, authored);
        std::fs::remove_dir_all(&directory).expect("remove fixture");
    }

    #[test]
    fn an_unknown_field_refuses_by_name_rather_than_loading() {
        let directory = std::env::temp_dir().join(format!(
            "gx-editor-shell-unknown-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("temp directory");
        let path = directory.join("scene.json");

        let mut document =
            serde_json::to_value(new_scene("demo", "Demo")).expect("a scene serialises");
        document["notAField"] = serde_json::json!(true);
        std::fs::write(&path, serde_json::to_vec(&document).expect("bytes"))
            .expect("write the hostile document");

        // The Editor must not accept what the engine will refuse: an unknown
        // field is named here, at authoring time, not at publish.
        let error = load_scene(&path).expect_err("an unknown field must refuse");
        assert!(
            matches!(&error, EditorError::InvalidScene { detail } if detail.contains("notAField")),
            "the refusal must name the field, got {error}"
        );
        std::fs::remove_dir_all(&directory).expect("remove fixture");
    }

    #[test]
    fn an_unparseable_endpoint_is_refused_before_any_socket_opens() {
        let error = publish("not-an-address", new_scene("demo", "Demo"))
            .expect_err("a malformed endpoint cannot be dialled");
        assert!(matches!(error, EditorError::InvalidEndpoint { .. }));
    }
}
