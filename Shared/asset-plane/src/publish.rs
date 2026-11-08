//! Asset-plane publication and fetch messages shared by an Editor, Playout,
//! an engine and its mock.
//!
//! A scene document is content, not a Program command: carrying it on the
//! restartable asset plane prevents a large publish from delaying control-plane
//! intent (ADR-001). The explicit refusal reply prevents malformed authoring
//! data from being silently skipped. The same holds in the other direction for
//! a headless render's image (11.41): the control reply names it by content
//! hash, and the bytes come back here, verified against that hash.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use gx_contracts::scene::{parse_scene_document, SceneDocument};
use gx_contracts::{ContentHash, Refusal, Revision, TakeId};
use serde::{Deserialize, Serialize};

use crate::store::content_hash;

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
    /// A new immutable revision. Takes must name this exact revision and pin
    /// this content hash (invariant 61).
    Published {
        take_id: TakeId,
        revision: Revision,
        content_hash: ContentHash,
    },
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
    /// A package offered by local path was refused before its scene reached
    /// the peer (5.8): no package directory, a path outside it, an unreadable
    /// package, or bytes that do not match their manifest or declared hash.
    PackageRefused { cause: gx_contracts::Refusal },
}

/// A peer that can atomically turn a strictly parsed scene into a revision,
/// and serve the bytes of images it rendered.
///
/// The listener owns framing and strict parsing so mock and real engines cannot
/// accidentally teach different publication contracts.
pub trait AssetPublishPeer: Send + 'static {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply;

    /// The bytes this peer serves under a content hash: images its headless
    /// renders produced (11.41). A peer that renders nothing serves nothing.
    fn fetch(&self, _hash: &ContentHash) -> Option<Arc<Vec<u8>>> {
        None
    }

    /// Whether this peer already holds verified bytes for `hash` (5.9): the
    /// preflight answer, so a publisher sends only what is missing.
    fn has_verified_asset(&self, _hash: &ContentHash) -> bool {
        false
    }

    /// Keep asset bytes the transfer dialect has re-hashed against `hash`
    /// (5.9). A peer that keeps no asset bytes refuses by name rather than
    /// acknowledging bytes it then drops.
    fn accept_verified_asset(&mut self, hash: ContentHash, _bytes: Vec<u8>) -> Result<(), Refusal> {
        Err(Refusal::NotImplemented {
            what: format!("this asset-plane peer keeps no asset bytes (asset {hash})"),
        })
    }

    /// The absolute directory a co-located publisher may hand packages from
    /// by local path (5.8). `None`, the default, reads no path at all.
    fn package_directory(&self) -> Option<PathBuf> {
        None
    }
}

/// A publish peer seen as the transfer dialect's receiver (5.9).
struct PeerAssets<P>(Arc<Mutex<P>>);

impl<P: AssetPublishPeer> crate::preflight::VerifiedAssets for PeerAssets<P> {
    fn has(&self, hash: &ContentHash) -> io::Result<bool> {
        Ok(self
            .0
            .lock()
            .map_err(|_| io::Error::other("asset publish peer mutex poisoned"))?
            .has_verified_asset(hash))
    }
    fn accept(&self, hash: &ContentHash, bytes: Vec<u8>) -> io::Result<Result<(), Refusal>> {
        Ok(self
            .0
            .lock()
            .map_err(|_| io::Error::other("asset publish peer mutex poisoned"))?
            .accept_verified_asset(hash.clone(), bytes))
    }
}

/// The asset-plane reply to one fetch. `Bytes` is followed on the stream by
/// exactly `byteLen` raw bytes, so an image is never inflated into JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "reply",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FetchReply {
    Bytes { hash: ContentHash, byte_len: u64 },
    Refused { cause: Refusal },
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
    ReplyTooLarge {
        bytes: usize,
    },
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
    let (_, header) = exchange(engine, &request)?;
    serde_json::from_slice(&header).map_err(PublishClientError::Malformed)
}

/// Offer a package by local path (5.8). Crate-private: a publisher goes
/// through `handoff::publish_package`, which chooses this route from the
/// declared locality, so no caller picks a route by hand.
pub(crate) fn publish_package_path(
    engine: SocketAddr,
    path: &str,
) -> Result<PublishReply, PublishClientError> {
    let request = serde_json::to_vec(&serde_json::json!({ "package": { "path": path } }))
        .map_err(PublishClientError::Malformed)?;
    let (_, header) = exchange(engine, &request)?;
    serde_json::from_slice(&header).map_err(PublishClientError::Malformed)
}

/// Why a fetch returned no bytes.
#[derive(Debug)]
pub enum FetchError {
    /// No reply was obtained at all.
    Client(PublishClientError),
    /// The peer declined by name, or the bytes that arrived are not the bytes
    /// the hash names (`AssetHashMismatch`).
    Refused(Refusal),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Client(error) => write!(f, "{error}"),
            Self::Refused(refusal) => write!(f, "fetch refused: {refusal}"),
        }
    }
}

impl std::error::Error for FetchError {}

/// Fetch the bytes a peer serves under `hash`, such as a headless render's
/// image. The bytes are re-hashed on arrival: a reply that does not hash to
/// what was asked for is refused, never returned (invariant 28).
pub fn fetch_bytes(engine: SocketAddr, hash: &ContentHash) -> Result<Vec<u8>, FetchError> {
    let request = serde_json::to_vec(&serde_json::json!({ "fetch": { "hash": hash } }))
        .map_err(|error| FetchError::Client(PublishClientError::Malformed(error)))?;
    let (mut stream, header) = exchange(engine, &request).map_err(FetchError::Client)?;
    let byte_len = match serde_json::from_slice(&header)
        .map_err(|error| FetchError::Client(PublishClientError::Malformed(error)))?
    {
        FetchReply::Bytes { byte_len, .. } => byte_len as usize,
        FetchReply::Refused { cause } => return Err(FetchError::Refused(cause)),
    };
    if byte_len > MAX_PUBLISH_FRAME_BYTES {
        return Err(FetchError::Client(PublishClientError::ReplyTooLarge {
            bytes: byte_len,
        }));
    }
    let mut bytes = vec![0; byte_len];
    stream
        .read_exact(&mut bytes)
        .map_err(|error| FetchError::Client(PublishClientError::Transport(error)))?;
    let actual = content_hash(&bytes);
    if actual != *hash {
        return Err(FetchError::Refused(Refusal::AssetHashMismatch {
            expected: hash.clone(),
            actual,
        }));
    }
    Ok(bytes)
}

/// Send one framed request and read one framed reply header, bounded before
/// it is allocated: a peer cannot make this side reserve memory by claiming a
/// large frame.
fn exchange(
    engine: SocketAddr,
    request: &[u8],
) -> Result<(TcpStream, Vec<u8>), PublishClientError> {
    let mut stream = TcpStream::connect(engine).map_err(PublishClientError::Connect)?;
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .and_then(|()| stream.write_all(request))
        .and_then(|()| stream.flush())
        .map_err(PublishClientError::Transport)?;

    let mut prefix = [0_u8; 4];
    stream
        .read_exact(&mut prefix)
        .map_err(PublishClientError::Transport)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_PUBLISH_FRAME_BYTES {
        return Err(PublishClientError::ReplyTooLarge { bytes: length });
    }
    let mut header = vec![0; length];
    stream
        .read_exact(&mut header)
        .map_err(PublishClientError::Transport)?;
    Ok((stream, header))
}

/// One parsed asset-plane request.
// A request carries the scene document it publishes; the small variants are
// control messages. The size difference is the message set, not waste.
#[allow(clippy::large_enum_variant)]
enum AssetRequest {
    Publish(Result<SceneDocument, PublishRefusal>),
    Fetch(ContentHash),
    /// The opening frame of the 5.3 transfer dialect (5.9): the rest of the
    /// connection is preflight and chunks into this peer.
    Transfer(crate::preflight::AssetTransferRequest),
    /// A package offered by local path (5.8).
    Package(String),
}

fn handle_publish<P: AssetPublishPeer>(
    mut stream: TcpStream,
    peer: Arc<Mutex<P>>,
) -> io::Result<()> {
    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix)?;
    let length = u32::from_be_bytes(prefix) as usize;
    let request = if length > MAX_PUBLISH_FRAME_BYTES {
        AssetRequest::Publish(Err(PublishRefusal::InvalidPublishRequest {
            detail: format!(
                "publish frame is {length} bytes; maximum is {MAX_PUBLISH_FRAME_BYTES}"
            ),
        }))
    } else {
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes)?;
        parse_request(&bytes)
    };
    let locked = || {
        peer.lock()
            .map_err(|_| io::Error::other("asset publish peer mutex poisoned"))
    };
    match request {
        AssetRequest::Transfer(first) => crate::preflight::serve_transfer(
            &mut stream,
            Some(first),
            &PeerAssets(Arc::clone(&peer)),
            &crate::preflight::AssetTransferMetrics::new(),
        ),
        AssetRequest::Package(path) => {
            let directory = locked()?.package_directory();
            // Read and verified without the peer lock, so a large package
            // never holds up a take.
            let reply = match crate::handoff::open_package_in(directory.as_deref(), &path) {
                Ok(packaged) => deliver_packaged(&mut *locked()?, packaged),
                Err(cause) => PublishReply::Refused(PublishRefusal::PackageRefused { cause }),
            };
            write_header(&mut stream, &reply)
        }
        AssetRequest::Publish(scene) => {
            let reply = match scene {
                Ok(scene) => locked()?.publish_scene(scene),
                Err(refusal) => PublishReply::Refused(refusal),
            };
            write_header(&mut stream, &reply)
        }
        AssetRequest::Fetch(hash) => {
            // The peer is held only long enough to share the bytes.
            let served = locked()?.fetch(&hash);
            match served {
                Some(bytes) => {
                    write_header(
                        &mut stream,
                        &FetchReply::Bytes {
                            hash,
                            byte_len: bytes.len() as u64,
                        },
                    )?;
                    stream.write_all(&bytes)?;
                    stream.flush()
                }
                None => write_header(
                    &mut stream,
                    &FetchReply::Refused {
                        cause: Refusal::AssetMissing { hash },
                    },
                ),
            }
        }
    }
}

/// Hand a package's verified assets to the peer through the same receipt the
/// chunked route uses, then publish its scene through the same entry point.
fn deliver_packaged<P: AssetPublishPeer>(
    peer: &mut P,
    packaged: crate::handoff::PackagedScene,
) -> PublishReply {
    for asset in packaged.assets {
        if peer.has_verified_asset(&asset.hash) {
            continue;
        }
        if let Err(cause) = peer.accept_verified_asset(asset.hash, asset.bytes) {
            return PublishReply::Refused(PublishRefusal::PackageRefused { cause });
        }
    }
    peer.publish_scene(packaged.scene)
}

fn write_header<T: Serialize>(stream: &mut TcpStream, header: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(header).map_err(io::Error::other)?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()
}

fn parse_request(bytes: &[u8]) -> AssetRequest {
    let invalid = |detail: String| {
        AssetRequest::Publish(Err(PublishRefusal::InvalidPublishRequest { detail }))
    };
    let mut request =
        match serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(bytes) {
            Ok(request) => request,
            Err(error) => return invalid(error.to_string()),
        };
    // The transfer dialect's frames carry a `request` tag (preflight, begin,
    // chunk); a publication carries `scene`, a fetch `fetch` and a package
    // offered by local path `package` (5.8).
    if request.contains_key("request") {
        return match serde_json::from_value(serde_json::Value::Object(request)) {
            Ok(transfer) => AssetRequest::Transfer(transfer),
            Err(error) => invalid(format!("asset transfer request: {error}")),
        };
    }
    if request.len() != 1 {
        return invalid(
            "an asset-plane request must contain exactly one of `scene`, `fetch` or `package`"
                .to_string(),
        );
    }
    if let Some(package) = request.remove("package") {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Package {
            path: String,
        }
        return match serde_json::from_value::<Package>(package) {
            Ok(package) => AssetRequest::Package(package.path),
            Err(error) => invalid(format!("package request: {error}")),
        };
    }
    if let Some(fetch) = request.remove("fetch") {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fetch {
            hash: ContentHash,
        }
        return match serde_json::from_value::<Fetch>(fetch) {
            Ok(fetch) => AssetRequest::Fetch(fetch.hash),
            Err(error) => invalid(format!("fetch request: {error}")),
        };
    }
    let Some(scene) = request.remove("scene") else {
        return invalid(
            "an asset-plane request must contain exactly one of `scene`, `fetch` or `package`"
                .to_string(),
        );
    };
    AssetRequest::Publish(
        serde_json::to_vec(&scene)
            .map_err(|error| PublishRefusal::InvalidPublishRequest {
                detail: error.to_string(),
            })
            .and_then(|scene| {
                parse_scene_document(&scene).map_err(|cause| PublishRefusal::SceneRefused { cause })
            }),
    )
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
            let content_hash = scene.content_hash();
            self.published.push(scene);
            PublishReply::Published {
                take_id,
                revision: Revision(self.published.len() as u64),
                content_hash,
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
