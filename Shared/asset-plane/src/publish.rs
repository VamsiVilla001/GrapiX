//! Asset-plane publication messages shared by an Editor and an engine mock.
//!
//! A scene document is content, not a Program command: carrying it on the
//! restartable asset plane prevents a large publish from delaying control-plane
//! intent (ADR-001). The explicit refusal reply prevents malformed authoring
//! data from being silently skipped.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use gx_contracts::scene::{parse_scene_document, SceneDocument};
use gx_contracts::{Revision, TakeId};
use serde::{Deserialize, Serialize};

/// A complete, self-describing authored scene awaiting publication.
///
/// This envelope is deliberately closed as well: an unrecognised request
/// field must not become a version-dependent publication side channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    /// The wire envelope was malformed or exceeded its bounded frame size.
    InvalidPublishRequest { detail: String },
    /// The authored document was refused by the closed scene schema. Keeping
    /// the contract refusal intact lets callers distinguish an extra field,
    /// a renamed field and an unknown object kind by name.
    SceneRefused { cause: gx_contracts::Refusal },
    /// The peer could parse the scene but cannot prepare it from the assets
    /// and render support it actually has.
    PreparationRefused { cause: gx_contracts::Refusal },
}

/// A peer that can atomically turn a strictly parsed scene into a revision.
///
/// The listener owns framing and strict parsing so mock and real engines cannot
/// accidentally teach different publication contracts.
pub trait AssetPublishPeer: Send + 'static {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply;
}

/// A restartable, bounded asset-plane scene-publication listener.
///
/// Scene bytes never travel over the control plane: this endpoint admits one
/// complete publication frame, strictly parses it, then forwards the authored
/// document to the peer that prepares it. A malformed request produces an
/// explicit refusal without mutating peer state.
pub struct AssetPublishServer<P: AssetPublishPeer> {
    listener: TcpListener,
    peer: Arc<Mutex<P>>,
}

impl<P: AssetPublishPeer> AssetPublishServer<P> {
    pub fn bind(addr: SocketAddr, peer: Arc<Mutex<P>>) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(addr)?,
            peer,
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    pub fn serve_in_background(self) -> JoinHandle<()> {
        thread::spawn(move || {
            for stream in self.listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let peer = Arc::clone(&self.peer);
                        thread::spawn(move || {
                            let _ = handle_publish(stream, peer);
                        });
                    }
                    Err(error) => {
                        eprintln!("asset publish listener stopping: {error}");
                        return;
                    }
                }
            }
        })
    }
}

/// The maximum one-shot publication payload. Larger scene packages are
/// transferred as assets first; accepting an unbounded frame would let content
/// exhaust the engine process before it has a chance to refuse.
pub const MAX_PUBLISH_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// A failure to complete one publication round-trip.
///
/// A refusal is a reply, not an error: `Refused` means the engine understood
/// the request and declined it by name. The other variants are the cases
/// where no reply was obtained at all, which a caller must not report as a
/// refusal it never received.
#[derive(Debug)]
pub enum PublishClientError {
    Connect(io::Error),
    Transport(io::Error),
    /// The reply frame exceeded the plane's bound, so it was not read.
    ReplyTooLarge { bytes: usize },
    /// A reply arrived but is not a `PublishReply`.
    Malformed(serde_json::Error),
}

impl std::fmt::Display for PublishClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(source) => write!(f, "cannot reach the asset plane: {source}"),
            Self::Transport(source) => write!(f, "asset-plane transport failed: {source}"),
            Self::ReplyTooLarge { bytes } => {
                write!(f, "asset-plane reply frame is {bytes} bytes")
            }
            Self::Malformed(source) => write!(f, "asset-plane reply is not a reply: {source}"),
        }
    }
}

impl std::error::Error for PublishClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Connect(source) | Self::Transport(source) => Some(source),
            Self::Malformed(source) => Some(source),
            Self::ReplyTooLarge { .. } => None,
        }
    }
}

/// Publish one complete authored document over the asset plane.
///
/// The single client implementation. Framing and the bound live here beside
/// the server that enforces them, so an Editor and a mock cannot drift into
/// two dialects of the same plane (invariant 27).
pub fn publish_scene(
    engine: SocketAddr,
    scene: SceneDocument,
) -> Result<PublishReply, PublishClientError> {
    let request =
        serde_json::to_vec(&PublishRequest { scene }).map_err(PublishClientError::Malformed)?;
    let mut stream = TcpStream::connect(engine).map_err(PublishClientError::Connect)?;
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .and_then(|()| stream.write_all(&request))
        .and_then(|()| stream.flush())
        .map_err(PublishClientError::Transport)?;

    let mut prefix = [0_u8; 4];
    stream
        .read_exact(&mut prefix)
        .map_err(PublishClientError::Transport)?;
    let length = u32::from_be_bytes(prefix) as usize;
    // The bound is checked before allocating: a peer cannot make this side
    // reserve memory by claiming a large frame.
    if length > MAX_PUBLISH_FRAME_BYTES {
        return Err(PublishClientError::ReplyTooLarge { bytes: length });
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .map_err(PublishClientError::Transport)?;
    serde_json::from_slice(&bytes).map_err(PublishClientError::Malformed)
}

fn handle_publish<P: AssetPublishPeer>(
    mut stream: TcpStream,
    peer: Arc<Mutex<P>>,
) -> io::Result<()> {
    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix)?;
    let length = u32::from_be_bytes(prefix) as usize;
    let reply = if length > MAX_PUBLISH_FRAME_BYTES {
        PublishReply::Refused(PublishRefusal::InvalidPublishRequest {
            detail: format!(
                "publish frame is {length} bytes; maximum is {MAX_PUBLISH_FRAME_BYTES}"
            ),
        })
    } else {
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes)?;
        match parse_request(&bytes) {
            Ok(scene) => peer
                .lock()
                .map_err(|_| io::Error::other("asset publish peer mutex poisoned"))?
                .publish_scene(scene),
            Err(refusal) => PublishReply::Refused(refusal),
        }
    };
    let bytes = serde_json::to_vec(&reply).map_err(io::Error::other)?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()
}

fn parse_request(bytes: &[u8]) -> Result<SceneDocument, PublishRefusal> {
    let mut request = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(bytes)
        .map_err(|error| PublishRefusal::InvalidPublishRequest {
        detail: error.to_string(),
    })?;
    if request.len() != 1 {
        return Err(PublishRefusal::InvalidPublishRequest {
            detail: "publish request must contain exactly the `scene` field".to_string(),
        });
    }
    let scene = request
        .remove("scene")
        .ok_or_else(|| PublishRefusal::InvalidPublishRequest {
            detail: "publish request has no scene".to_string(),
        })?;
    let scene =
        serde_json::to_vec(&scene).map_err(|error| PublishRefusal::InvalidPublishRequest {
            detail: error.to_string(),
        })?;
    parse_scene_document(&scene).map_err(|cause| PublishRefusal::SceneRefused { cause })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::Revision;
    use std::net::{IpAddr, Ipv4Addr};

    #[derive(Default)]
    struct Peer {
        published: Vec<SceneDocument>,
    }

    impl AssetPublishPeer for Peer {
        fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
            let take_id = TakeId(scene.id.clone());
            self.published.push(scene);
            PublishReply::Published {
                take_id,
                revision: Revision(self.published.len() as u64),
            }
        }
    }

    fn scene_json() -> serde_json::Value {
        serde_json::json!({
            "id": "scene_1",
            "name": "Scene",
            "version": 1,
            "canvas": {"width": 1920, "height": 1080, "frameRate": {"num": 50, "den": 1}},
            "timeline": {"durationFrames": 1},
            "dataContext": {},
            "assets": [],
            "fonts": [],
            "materials": [],
            "objects": [{"type": "rect", "id": "bg", "name": "Background"}]
        })
    }

    fn server() -> (AssetPublishServer<Peer>, Arc<Mutex<Peer>>) {
        let peer = Arc::new(Mutex::new(Peer::default()));
        let server = AssetPublishServer::bind(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            Arc::clone(&peer),
        )
        .expect("loopback listener binds");
        (server, peer)
    }

    fn request(addr: SocketAddr, request: serde_json::Value) -> PublishReply {
        let mut stream = TcpStream::connect(addr).expect("publication client connects");
        let bytes = serde_json::to_vec(&request).expect("request serializes");
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .expect("prefix writes");
        stream.write_all(&bytes).expect("request writes");
        let mut prefix = [0_u8; 4];
        stream.read_exact(&mut prefix).expect("reply prefix reads");
        let mut reply = vec![0; u32::from_be_bytes(prefix) as usize];
        stream.read_exact(&mut reply).expect("reply reads");
        serde_json::from_slice(&reply).expect("reply deserializes")
    }

    #[test]
    fn an_extra_scene_key_refuses_without_publishing() {
        let (server, peer) = server();
        let address = server.local_addr().expect("address is known");
        let _listener = server.serve_in_background();
        let mut scene = scene_json();
        scene["objects"][0]["unknownProperty"] = serde_json::json!(true);

        let reply = request(address, serde_json::json!({"scene": scene}));

        assert!(matches!(
            reply,
            PublishReply::Refused(PublishRefusal::SceneRefused {
                cause: gx_contracts::Refusal::SceneUnknownField { path },
                ..
            }) if path == "objects[0].unknownProperty"
        ));
        assert!(peer.lock().expect("peer lock").published.is_empty());
    }

    #[test]
    fn a_renamed_scene_key_refuses_without_publishing() {
        let (server, peer) = server();
        let address = server.local_addr().expect("address is known");
        let _listener = server.serve_in_background();
        let mut scene = scene_json();
        let objects = scene
            .as_object_mut()
            .expect("scene object")
            .remove("objects")
            .expect("objects exists");
        scene["objectList"] = objects;

        let reply = request(address, serde_json::json!({"scene": scene}));

        assert!(matches!(
            reply,
            PublishReply::Refused(PublishRefusal::SceneRefused {
                cause: gx_contracts::Refusal::SceneUnknownField { path },
                ..
            }) if path == "objectList"
        ));
        assert!(peer.lock().expect("peer lock").published.is_empty());
    }

    #[test]
    fn an_unknown_object_kind_refuses_without_publishing() {
        let (server, peer) = server();
        let address = server.local_addr().expect("address is known");
        let _listener = server.serve_in_background();
        let mut scene = scene_json();
        scene["objects"][0]["type"] = serde_json::json!("notADrawnThing");

        let reply = request(address, serde_json::json!({"scene": scene}));

        assert!(matches!(
            reply,
            PublishReply::Refused(PublishRefusal::SceneRefused {
                cause: gx_contracts::Refusal::SceneParseFailed { detail },
                ..
            }) if detail.contains("notADrawnThing")
        ));
        assert!(peer.lock().expect("peer lock").published.is_empty());
    }
}
