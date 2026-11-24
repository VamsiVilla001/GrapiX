//! The engine preview (build plan 11.65): ask the engine to draw the document the
//! author is editing, and take back the picture.
//!
//! The Editor's draft viewport cannot draw effects, shaped text or masks; the
//! engine can, so the Preview shows the engine's frame and labels it. The request
//! is the asset plane's `preview`: the draft document and a frame, answered with a
//! PNG. It creates no revision and touches nothing on air, and the Editor holds no
//! control-plane client to ask it with (boundary rules R6, invariant 4).
//!
//! Two kinds of failure stay apart, as they do for publishing. An engine that
//! cannot be reached decided nothing; an engine that answers and declines does so
//! by name, with the refusal from the shared vocabulary, so the Preview can say
//! why rather than show a stale picture as current.

use std::net::SocketAddr;

use gx_asset_plane::{preview_scene, PreviewError, PreviewImage, PublishClientError};
use gx_contracts::scene::SceneDocument;
use gx_contracts::Refusal;

/// Why a preview was not drawn.
#[derive(Debug)]
pub enum PreviewFailure {
    /// The endpoint text is not a socket address. Nothing was opened.
    InvalidEndpoint { endpoint: String },
    /// The engine could not be reached, or the connection failed before a reply:
    /// nothing was decided.
    Unreachable { endpoint: String, detail: String },
    /// The engine understood the request and declined it, by name.
    EngineRefused(Refusal),
    /// A reply arrived that is not a reply.
    Protocol { detail: String },
}

impl std::fmt::Display for PreviewFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEndpoint { endpoint } => {
                write!(f, "{endpoint} is not a host:port address")
            }
            Self::Unreachable { endpoint, detail } => {
                write!(f, "cannot reach the engine at {endpoint}: {detail}")
            }
            Self::EngineRefused(refusal) => write!(f, "the engine declined the preview: {refusal}"),
            Self::Protocol { detail } => write!(f, "asset plane protocol failed: {detail}"),
        }
    }
}

impl std::error::Error for PreviewFailure {}

/// Draw `scene` at `frame` on the engine's asset plane at `endpoint`.
///
/// The one function the Editor shell's `cmd_engine_preview` and the tests both
/// call, so what is tested is what the shell does.
pub fn preview_document(
    endpoint: &str,
    scene: SceneDocument,
    frame: u64,
) -> Result<PreviewImage, PreviewFailure> {
    let address: SocketAddr = endpoint
        .parse()
        .map_err(|_| PreviewFailure::InvalidEndpoint {
            endpoint: endpoint.to_owned(),
        })?;
    // 2.24: an engine started with a token verifies a credential on the asset plane. A process that
    // holds one for it (`GX_ASSET_CREDENTIAL`, made with the engine's secret, Author scope) sends it.
    let _credential = gx_asset_plane::auth::enter_from_environment();
    preview_scene(address, scene, frame).map_err(|error| match error {
        PreviewError::Refused(refusal) => PreviewFailure::EngineRefused(refusal),
        PreviewError::Client(
            PublishClientError::Connect(source) | PublishClientError::Transport(source),
        ) => PreviewFailure::Unreachable {
            endpoint: endpoint.to_owned(),
            detail: source.to_string(),
        },
        PreviewError::Client(other) => PreviewFailure::Protocol {
            detail: other.to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nothing_listens() -> String {
        // A port that was just free and is not listening now.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        address.to_string()
    }

    fn scene() -> SceneDocument {
        serde_json::from_value(serde_json::json!({
            "version": gx_contracts::scene::SCENE_SCHEMA_VERSION,
            "id": "draft", "name": "Draft", "workingColorSpace": "linear-srgb", "colorDepth": "32",
            "canvas": { "width": 64, "height": 32, "frameRate": { "num": 50, "den": 1 } },
            "timeline": { "durationFrames": 10, "channels": [] },
            "objects": []
        }))
        .expect("a minimal scene parses")
    }

    #[test]
    fn a_bad_endpoint_is_named_and_nothing_is_opened() {
        match preview_document("not an address", scene(), 0) {
            Err(PreviewFailure::InvalidEndpoint { endpoint }) => {
                assert_eq!(endpoint, "not an address")
            }
            other => panic!("expected InvalidEndpoint, got {other:?}"),
        }
    }

    #[test]
    fn an_engine_that_is_not_there_is_unreachable_not_a_refusal() {
        let endpoint = nothing_listens();
        match preview_document(&endpoint, scene(), 0) {
            Err(PreviewFailure::Unreachable {
                endpoint: named, ..
            }) => assert_eq!(named, endpoint),
            other => panic!("expected Unreachable, got {other:?}"),
        }
    }
}
