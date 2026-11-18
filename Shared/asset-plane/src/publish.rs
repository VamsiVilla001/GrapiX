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
use gx_contracts::{ContentHash, Locality, Refusal, Revision, TakeId};
use serde::{Deserialize, Serialize};

use crate::store::{content_hash, AssetStore};

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

/// The asset-plane answer to the closed `{"locality":{}}` read (5.10).
///
/// The engine declares its locality once, in one field. The control plane
/// carries it in `EngineCapability`; this read carries the same field to a
/// publisher that holds no control client (boundary rule R6) and may not
/// name a `Locality` (R9). Conformance holds the two answers equal on real
/// workers and both mocks (invariants 27, 45).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "reply",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LocalityReply {
    /// The locality the engine declares.
    Declared { locality: Locality },
    /// The engine did not take the request. An engine built before 5.10 answers
    /// with its existing `InvalidPublishRequest`, which a publisher reports by
    /// name rather than as a broken protocol.
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
    /// package, bytes that do not match their manifest or declared hash, or
    /// (5.11) a store that could not keep them.
    PackageRefused { cause: gx_contracts::Refusal },
}

/// A peer that can atomically turn a strictly parsed scene into a revision,
/// and serve the bytes of images it rendered.
///
/// The listener owns framing and strict parsing so mock and real engines cannot
/// accidentally teach different publication contracts.
pub trait AssetPublishPeer: Send + 'static {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply;

    /// The locality this peer declares (5.10): the single field its
    /// capability exchange reads as well. It has no default on purpose, so a
    /// peer cannot declare by omission, and a default added later would
    /// defeat the conformance check that holds this equal to the capability.
    fn locality(&self) -> Locality;

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

    /// The store this peer keeps verified asset bytes in across a restart
    /// (5.11). When it names one, this listener writes every asset there,
    /// without holding the peer, before the peer is handed the bytes, so a
    /// large write never delays a frame or a cue (ADR-001) and nothing is
    /// acknowledged that the store does not hold. `None`, the default, keeps
    /// bytes in the peer's memory only.
    fn asset_store(&self) -> Option<Arc<AssetStore>> {
        None
    }
}

/// A publish peer seen as the transfer dialect's receiver (5.9), with the
/// store it keeps bytes in across a restart (5.11).
struct PeerAssets<P> {
    peer: Arc<Mutex<P>>,
    store: Option<Arc<AssetStore>>,
    /// The longest asset the store keeps. A restore reads entries back with
    /// the same limit, so a longer one is refused here, by name, instead of
    /// being acknowledged and dropped at the next start (5.11 review).
    most_bytes: u64,
}

impl<P: AssetPublishPeer> crate::preflight::VerifiedAssets for PeerAssets<P> {
    fn has(&self, hash: &ContentHash) -> io::Result<bool> {
        Ok(self
            .peer
            .lock()
            .map_err(|_| io::Error::other("asset publish peer mutex poisoned"))?
            .has_verified_asset(hash))
    }
    fn accept(&self, hash: &ContentHash, bytes: Vec<u8>) -> io::Result<Result<(), Refusal>> {
        // Written before the peer is held: a large asset's durable write
        // never waits on, or delays, the peer's frames (ADR-001).
        if let Some(store) = &self.store {
            let length = bytes.len() as u64;
            if length > self.most_bytes {
                return Ok(Err(Refusal::AssetStoreFailed {
                    hash: hash.clone(),
                    detail: format!(
                        "the asset is {length} bytes, more than the {} the engine's store keeps",
                        self.most_bytes
                    ),
                }));
            }
            if let Err(error) = store.promote_verified(hash, &bytes) {
                return Ok(Err(error.into_refusal(hash)));
            }
        }
        Ok(self
            .peer
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
    metrics: crate::preflight::AssetTransferMetrics,
    /// What every connection is held to (2.22).
    limits: crate::limits::AssetLimits,
    /// Connections held now, against `limits.max_connections`.
    connections: Arc<std::sync::atomic::AtomicUsize>,
}

/// The asset plane's case of the one bind policy (2.21): it verifies no
/// credential today, so it listens on loopback only, and on no reserved port.
/// The refusal is `PermissionDenied`, naming the plane and the reason.
pub(crate) fn check_asset_listen(addr: SocketAddr) -> io::Result<()> {
    gx_contracts::endpoints::check_listen_io(gx_contracts::endpoints::Plane::Asset, addr, None)
}

impl<P: AssetPublishPeer> AssetPublishServer<P> {
    pub fn bind(addr: SocketAddr, peer: Arc<Mutex<P>>) -> io::Result<Self> {
        check_asset_listen(addr)?;
        Ok(Self {
            listener: TcpListener::bind(addr)?,
            peer,
            metrics: crate::preflight::AssetTransferMetrics::new(),
            limits: crate::limits::AssetLimits::default(),
            connections: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        })
    }

    /// Hold every connection to `limits` instead of the defaults.
    #[must_use]
    pub fn with_limits(mut self, limits: crate::limits::AssetLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// The asset bytes this listener's transfer dialect has admitted, over
    /// every connection: what crossed the asset plane into this peer.
    pub fn metrics(&self) -> crate::preflight::AssetTransferMetrics {
        self.metrics.clone()
    }

    pub fn serve_in_background(self) -> JoinHandle<()> {
        thread::spawn(move || {
            for stream in self.listener.incoming() {
                match stream {
                    Ok(stream) => {
                        // 2.22: a connection over the cap is closed at once, and the
                        // listener keeps accepting.
                        let Some(permit) = crate::limits::take_permit(
                            &self.connections,
                            self.limits.max_connections,
                        ) else {
                            tracing::warn!(
                                event = "asset.connection_refused",
                                cap = self.limits.max_connections,
                                reason = "the listener is holding its most connections",
                            );
                            continue;
                        };
                        let peer = Arc::clone(&self.peer);
                        let metrics = self.metrics.clone();
                        let limits = self.limits;
                        thread::spawn(move || {
                            let _permit = permit;
                            for problem in crate::limits::configure(&stream, &limits) {
                                tracing::warn!(
                                    event = "asset.limits_not_applied",
                                    detail = problem.as_str(),
                                );
                            }
                            let _ = handle_publish(stream, peer, &metrics, &limits);
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

/// Ask an engine for the locality it declares (5.10), on the asset-plane
/// address a publisher is about to use. Read fresh on every publish: never
/// configured, never inferred from the address, never probed. Crate-level so
/// a publisher goes through `handoff::publish_as_package`, which uses the
/// answer and returns no `Locality` to its caller (R9).
pub fn declared_locality(engine: SocketAddr) -> Result<LocalityReply, PublishClientError> {
    let request = serde_json::to_vec(&serde_json::json!({ "locality": {} }))
        .map_err(PublishClientError::Malformed)?;
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
    let request = with_correlation(request, gx_telemetry::corr::current().as_deref());
    let request = with_carries(&request, &gx_telemetry::corr::carried());
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
    if length > MAX_PUBLISH_FRAME_BYTES {
        return Err(PublishClientError::ReplyTooLarge { bytes: length });
    }
    let mut header = vec![0; length];
    stream
        .read_exact(&mut header)
        .map_err(PublishClientError::Transport)?;
    Ok((stream, header))
}

/// The key a request header carries its correlation id under (2.13).
pub(crate) const CORRELATION_KEY: &str = "corr";

/// `request`, a JSON object, with `"corr":"<id>"` added as its first member when
/// the caller is working for a correlated action. An id passes the shape check
/// (letters, digits, `_`, `:`, `-`), so it needs no escaping. The server reads and
/// removes the key before it checks the request has exactly one member.
pub(crate) fn with_correlation(request: &[u8], correlation: Option<&str>) -> Vec<u8> {
    match (correlation, request.first(), request.get(1)) {
        (Some(id), Some(b'{'), Some(next)) if gx_telemetry::corr::is_valid(id) => {
            let mut out = Vec::with_capacity(request.len() + id.len() + 10);
            out.extend_from_slice(b"{\"");
            out.extend_from_slice(CORRELATION_KEY.as_bytes());
            out.extend_from_slice(b"\":\"");
            out.extend_from_slice(id.as_bytes());
            out.push(b'"');
            if *next != b'}' {
                out.push(b',');
            }
            out.extend_from_slice(&request[1..]);
            out
        }
        _ => request.to_vec(),
    }
}

/// The key a request header names the edits it carries under (2.17).
pub(crate) const CARRIES_KEY: &str = "carries";

/// `request`, a JSON object, with `"carries":["<id>",...]` added as its first
/// member when the caller's publish names edits (a carry scope is entered). Only
/// ids that pass the shape check are written, so none needs escaping. The server
/// removes the key before it checks the request has exactly one member, as it
/// does `corr`. A server built before this key existed does not remove it and
/// refuses the request by that rule: Editor and engine are built from one tree.
pub(crate) fn with_carries(request: &[u8], ids: &[String]) -> Vec<u8> {
    let ids: Vec<&String> = ids
        .iter()
        .filter(|id| gx_telemetry::corr::is_valid(id))
        .collect();
    match (ids.is_empty(), request.first(), request.get(1)) {
        (false, Some(b'{'), Some(next)) => {
            let mut out = Vec::with_capacity(request.len() + ids.len() * 20 + 16);
            out.extend_from_slice(b"{\"");
            out.extend_from_slice(CARRIES_KEY.as_bytes());
            out.extend_from_slice(b"\":[");
            for (index, id) in ids.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                out.push(b'"');
                out.extend_from_slice(id.as_bytes());
                out.push(b'"');
            }
            out.push(b']');
            if *next != b'}' {
                out.push(b',');
            }
            out.extend_from_slice(&request[1..]);
            out
        }
        _ => request.to_vec(),
    }
}

/// What a request header presented besides its own members: the correlation id
/// (2.13) and the edits it carries (2.17). Neither is trusted: each id is
/// checked before it is entered or written.
#[derive(Default)]
struct Presented {
    correlation: Option<String>,
    carries: Vec<String>,
    /// Entries of `carries` that were not strings.
    not_ids: u64,
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
    /// The closed read of the engine's declared locality (5.10).
    Locality,
}

fn handle_publish<P: AssetPublishPeer>(
    mut stream: TcpStream,
    peer: Arc<Mutex<P>>,
    metrics: &crate::preflight::AssetTransferMetrics,
    limits: &crate::limits::AssetLimits,
) -> io::Result<()> {
    // 2.22: the first frame has `first_frame_deadline` from accept to begin and
    // `frame_deadline` to arrive whole.
    let Some(start) = crate::limits::read_frame_start(
        &mut stream,
        limits.first_frame_deadline,
        limits.frame_deadline,
    )?
    else {
        return Ok(());
    };
    let length = start.length;
    let mut presented = Presented::default();
    let request = if length > MAX_PUBLISH_FRAME_BYTES {
        AssetRequest::Publish(Err(PublishRefusal::InvalidPublishRequest {
            detail: format!(
                "publish frame is {length} bytes; maximum is {MAX_PUBLISH_FRAME_BYTES}"
            ),
        }))
    } else {
        let bytes = crate::limits::read_frame_body(&mut stream, &start, limits.frame_deadline)?;
        let (request, presenting) = parse_request(&bytes);
        presented = presenting;
        request
    };
    // 2.13: everything this connection causes, the publish the engine logs
    // among it, is written under the id the request arrived with. An id that
    // does not pass the shape check is not entered.
    let _scope = presented
        .correlation
        .as_deref()
        .filter(|id| gx_telemetry::corr::is_valid(id))
        .map(gx_telemetry::corr::enter);
    // 2.17: a publish that names the edits it carries writes them on every
    // record it causes here. Ids that fail the shape check, repeats and any
    // beyond the limit are counted, not named.
    let _carries = (!presented.carries.is_empty() || presented.not_ids > 0)
        .then(|| gx_telemetry::corr::carry(&presented.carries, presented.not_ids));
    let locked = || {
        peer.lock()
            .map_err(|_| io::Error::other("asset publish peer mutex poisoned"))
    };
    match request {
        AssetRequest::Transfer(first) => {
            let store = locked()?.asset_store();
            crate::preflight::serve_transfer(
                &mut stream,
                Some(first),
                &PeerAssets {
                    peer: Arc::clone(&peer),
                    store,
                    most_bytes: crate::package::MAX_PACKAGE_BYTES,
                },
                metrics,
                limits,
            )
        }
        AssetRequest::Locality => {
            let declared = locked()?.locality();
            write_header(&mut stream, &LocalityReply::Declared { locality: declared })
        }
        AssetRequest::Package(path) => {
            let (directory, store) = {
                let held = locked()?;
                // A LAN-declared engine reads no path (5.10): the handoff its
                // locality negotiates is the chunked upload, so a by-path
                // offer is refused by name even if the peer holds a
                // directory. One rule for the worker and the mock alike.
                let directory = match crate::handoff::handoff_for(held.locality()) {
                    crate::handoff::AssetHandoff::LocalPath => held.package_directory(),
                    crate::handoff::AssetHandoff::ChunkedUpload => None,
                };
                (directory, held.asset_store())
            };
            // Read, verified and stored without the peer lock, so a large
            // package never holds up a take.
            let reply = match crate::handoff::open_package_in(directory.as_deref(), &path)
                .and_then(|packaged| store_packaged(store.as_deref(), packaged))
            {
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

/// Write a package's verified assets to the peer's store, if it keeps one,
/// before the peer is handed any of them (5.11).
fn store_packaged(
    store: Option<&AssetStore>,
    packaged: crate::handoff::PackagedScene,
) -> Result<crate::handoff::PackagedScene, Refusal> {
    if let Some(store) = store {
        for asset in &packaged.assets {
            store
                .promote_verified(&asset.hash, &asset.bytes)
                .map_err(|error| error.into_refusal(&asset.hash))?;
        }
    }
    Ok(packaged)
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

/// The request, and what its header presented besides its own members (removed
/// first: a request must contain exactly one of its own members).
fn parse_request(bytes: &[u8]) -> (AssetRequest, Presented) {
    let mut request =
        match serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(bytes) {
            Ok(request) => request,
            Err(error) => {
                return (
                    AssetRequest::Publish(Err(PublishRefusal::InvalidPublishRequest {
                        detail: error.to_string(),
                    })),
                    Presented::default(),
                )
            }
        };
    let correlation = match request.remove(CORRELATION_KEY) {
        Some(serde_json::Value::String(id)) => Some(id),
        _ => None,
    };
    let (carries, not_ids) = match request.remove(CARRIES_KEY) {
        Some(serde_json::Value::Array(items)) => {
            let total = items.len() as u64;
            let ids: Vec<String> = items
                .into_iter()
                .filter_map(|item| match item {
                    serde_json::Value::String(id) => Some(id),
                    _ => None,
                })
                .collect();
            let strings = ids.len() as u64;
            (ids, total - strings)
        }
        // A key that is not a list names nothing; it is not the request.
        _ => (Vec::new(), 0),
    };
    (
        parse_members(request),
        Presented {
            correlation,
            carries,
            not_ids,
        },
    )
}

fn parse_members(mut request: serde_json::Map<String, serde_json::Value>) -> AssetRequest {
    let invalid = |detail: String| {
        AssetRequest::Publish(Err(PublishRefusal::InvalidPublishRequest { detail }))
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
            "an asset-plane request must contain exactly one of `scene`, `fetch`, `package` or `locality`"
                .to_string(),
        );
    }
    if let Some(locality) = request.remove("locality") {
        // Closed: the read takes no argument, so there is nothing to guess.
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Declared {}
        return match serde_json::from_value::<Declared>(locality) {
            Ok(Declared {}) => AssetRequest::Locality,
            Err(error) => invalid(format!("locality request: {error}")),
        };
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
            "an asset-plane request must contain exactly one of `scene`, `fetch`, `package` or `locality`"
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

    struct Peer {
        published: Vec<SceneDocument>,
        locality: Locality,
        /// The correlation scope the server had entered when each scene was
        /// published (2.13).
        scopes: Vec<Option<String>>,
        /// The edit ids the server had entered when each scene was published,
        /// and how many it counted without naming (2.17).
        carried: Vec<(Vec<String>, u64)>,
    }

    impl Default for Peer {
        fn default() -> Self {
            Self {
                published: Vec::new(),
                locality: Locality::CoLocated,
                scopes: Vec::new(),
                carried: Vec::new(),
            }
        }
    }

    impl AssetPublishPeer for Peer {
        fn locality(&self) -> Locality {
            self.locality
        }

        fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
            let take_id = TakeId(scene.id.clone());
            let content_hash = scene.content_hash();
            self.scopes.push(gx_telemetry::corr::current());
            self.carried.push((
                gx_telemetry::corr::carried(),
                gx_telemetry::corr::carried_dropped(),
            ));
            self.published.push(scene);
            PublishReply::Published {
                take_id,
                revision: Revision(self.published.len() as u64),
                content_hash,
            }
        }
    }

    #[test]
    fn the_locality_read_answers_what_the_peer_declares() {
        for locality in [Locality::CoLocated, Locality::Lan] {
            let peer = Arc::new(Mutex::new(Peer {
                locality,
                ..Peer::default()
            }));
            let server =
                AssetPublishServer::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0), peer)
                    .unwrap();
            let address = server.local_addr().unwrap();
            let _listener = server.serve_in_background();
            assert_eq!(
                declared_locality(address).unwrap(),
                LocalityReply::Declared { locality }
            );
            // On the wire: the same words the capability exchange uses.
            let (_, header) = exchange(address, br#"{"locality":{}}"#).unwrap();
            let wire: serde_json::Value = serde_json::from_slice(&header).unwrap();
            assert_eq!(
                wire,
                serde_json::json!({"reply": "declared", "locality": serde_json::to_value(locality).unwrap()})
            );
        }
    }

    /// 2.21: the asset plane asks the one bind policy before it opens a socket.
    /// It verifies no credential, so it is refused every interface but loopback
    /// (a token would not protect it) and every reserved port, by name. A refusal
    /// comes before any bind: an address that is not even this machine's is
    /// refused as a policy, not as an address that cannot be bound.
    #[test]
    fn the_publish_server_asks_the_bind_policy_before_it_opens_a_socket() {
        for (ip, port, because) in [
            ("0.0.0.0", 0, "verifies no credential"),
            ("192.168.1.50", 0, "verifies no credential"),
            ("::", 0, "verifies no credential"),
            ("127.0.0.1", 4100, "port 4100 is reserved"),
            ("127.0.0.1", 4200, "port 4200 is reserved"),
            ("127.0.0.1", 4300, "port 4300 is reserved"),
        ] {
            let addr = SocketAddr::new(ip.parse().unwrap(), port);
            let refused =
                match AssetPublishServer::bind(addr, Arc::new(Mutex::new(Peer::default()))) {
                    Ok(_) => panic!("{addr} must be refused"),
                    Err(refused) => refused,
                };
            assert_eq!(
                refused.kind(),
                io::ErrorKind::PermissionDenied,
                "{addr}: {refused}"
            );
            assert!(
                refused.to_string().contains("asset plane")
                    && refused.to_string().contains(because),
                "{addr}: {refused}"
            );
        }
        // Loopback on a free port is what the plane is for.
        assert!(
            AssetPublishServer::bind(
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
                Arc::new(Mutex::new(Peer::default())),
            )
            .is_ok(),
            "loopback is allowed"
        );
    }

    /// 2.22: the publish listener holds its connections to the same bounds: a peer
    /// that sends nothing is dropped, and one connection too many is closed at once.
    #[test]
    fn the_publish_listener_drops_a_silent_peer_and_caps_its_connections() {
        use std::io::Read as _;
        let limits = crate::limits::AssetLimits {
            max_connections: 2,
            first_frame_deadline: std::time::Duration::from_millis(500),
            ..crate::limits::AssetLimits::default()
        };
        let server = AssetPublishServer::bind(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            Arc::new(Mutex::new(Peer::default())),
        )
        .unwrap_or_else(|_| panic!("loopback binds"))
        .with_limits(limits);
        let address = server.local_addr().unwrap();
        let _listener = server.serve_in_background();

        let closed = |stream: &mut TcpStream, limit: std::time::Duration| {
            let started = std::time::Instant::now();
            stream.set_read_timeout(Some(limit)).unwrap();
            let mut sink = [0u8; 16];
            match stream.read(&mut sink) {
                Ok(0) => Some(started.elapsed()),
                Ok(_) => None,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    None
                }
                Err(_) => Some(started.elapsed()),
            }
        };

        // Two held, a third closed at once.
        let mut first = TcpStream::connect(address).unwrap();
        let mut second = TcpStream::connect(address).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let mut third = TcpStream::connect(address).unwrap();
        let took = closed(&mut third, std::time::Duration::from_secs(3))
            .expect("a connection over the cap was held");
        assert!(
            took < std::time::Duration::from_millis(400),
            "closed after {took:?}, not at once"
        );

        // The two held ones send nothing and are dropped at the first-frame deadline.
        let took = closed(&mut first, std::time::Duration::from_secs(5))
            .expect("a silent peer was still held after 5 s");
        assert!(
            took >= std::time::Duration::from_millis(300)
                && took < std::time::Duration::from_secs(3),
            "dropped after {took:?}, deadline 500 ms"
        );
        // The other was accepted at the same moment, so it went with it.
        assert!(
            closed(&mut second, std::time::Duration::from_secs(2)).is_some(),
            "the second silent peer was still held"
        );
    }

    #[test]
    fn the_locality_read_takes_no_argument_and_no_company() {
        let (server, peer) = server();
        let address = server.local_addr().expect("address is known");
        let _listener = server.serve_in_background();
        for bad in [
            serde_json::json!({"locality": {"x": 1}}),
            serde_json::json!({"locality": null}),
            serde_json::json!({"locality": {}, "scene": {}}),
            serde_json::json!({"locality": {}, "fetch": {"hash": "00"}}),
        ] {
            let reply = request(address, bad.clone());
            assert!(
                matches!(
                    reply,
                    PublishReply::Refused(PublishRefusal::InvalidPublishRequest { .. })
                ),
                "{bad}: {reply:?}"
            );
        }
        assert!(peer.lock().unwrap().published.is_empty());
    }

    #[test]
    fn an_asset_longer_than_the_store_keeps_is_refused_by_name_and_not_stored() {
        use crate::preflight::VerifiedAssets;
        let root = std::env::temp_dir().join(format!("gx-publish-most-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let store = Arc::new(AssetStore::at_root(root.clone()));
        let assets = PeerAssets {
            peer: Arc::new(Mutex::new(Peer::default())),
            store: Some(Arc::clone(&store)),
            most_bytes: 8,
        };
        let long = vec![3_u8; 9];
        let hash = crate::content_hash(&long);
        let refused = assets.accept(&hash, long).unwrap();
        assert!(
            matches!(&refused, Err(Refusal::AssetStoreFailed { hash: named, detail })
                if *named == hash && detail.contains('9') && detail.contains('8')),
            "{refused:?}"
        );
        assert!(
            !store.holds_entry(&hash, 9),
            "a refused asset is not stored"
        );
        // At the limit it is stored; the peer here keeps no bytes, which is
        // its own refusal, not the store's.
        let exact = vec![4_u8; 8];
        let exact_hash = crate::content_hash(&exact);
        let taken = assets.accept(&exact_hash, exact).unwrap();
        assert!(
            !matches!(&taken, Err(Refusal::AssetStoreFailed { .. })),
            "{taken:?}"
        );
        assert!(store.holds_entry(&exact_hash, 8));
        let _ = std::fs::remove_dir_all(root);
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
    fn a_request_header_carries_the_callers_correlation_id_as_its_first_member() {
        let with = |request: &[u8], id: Option<&str>| with_correlation(request, id);
        let parsed = |bytes: &[u8]| -> serde_json::Value { serde_json::from_slice(bytes).unwrap() };
        assert_eq!(
            parsed(&with(br#"{"scene":{"id":"s"}}"#, Some("ed-1a-2"))),
            serde_json::json!({"corr": "ed-1a-2", "scene": {"id": "s"}})
        );
        assert_eq!(with(br#"{}"#, Some("ed-1a-2")), br#"{"corr":"ed-1a-2"}"#);
        // No scope, an id that fails the shape check, or a body that is not an
        // object: the bytes go out exactly as they were.
        assert_eq!(with(br#"{"locality":{}}"#, None), br#"{"locality":{}}"#);
        for bad in ["has space", "gx1.a.b", "quo\"te", ""] {
            assert_eq!(
                with(br#"{"locality":{}}"#, Some(bad)),
                br#"{"locality":{}}"#,
                "{bad}"
            );
        }
        assert_eq!(with(b"[1]", Some("ed-1")), b"[1]");
    }

    #[test]
    fn the_server_enters_the_requests_correlation_scope_around_the_publish() {
        let (server, peer) = server();
        let address = server.local_addr().expect("address is known");
        let _listener = server.serve_in_background();

        // Through the client's own `exchange`, which is what adds the id.
        let send = |address: SocketAddr| -> PublishReply {
            let bytes = serde_json::to_vec(&serde_json::json!({"scene": scene_json()})).unwrap();
            let (_, header) = exchange(address, &bytes).expect("the exchange completes");
            serde_json::from_slice(&header).expect("a reply")
        };
        // From a client working for a correlated action (the call a shell makes).
        {
            let _scope = gx_telemetry::corr::enter("ed-pub-5");
            let reply = send(address);
            assert!(matches!(reply, PublishReply::Published { .. }), "{reply:?}");
        }
        // With no scope, nothing is added and nothing is entered.
        let reply = send(address);
        assert!(matches!(reply, PublishReply::Published { .. }), "{reply:?}");
        // A header whose id fails the shape check is not entered, and the
        // request is still served: the id is not the request.
        let reply = request(
            address,
            serde_json::json!({"corr": "gx1.pretend.credential", "scene": scene_json()}),
        );
        assert!(matches!(reply, PublishReply::Published { .. }), "{reply:?}");
        // And a request with the key and nothing else is still the one-member rule's
        // refusal, not a pass.
        let reply = request(address, serde_json::json!({"corr": "ed-1"}));
        assert!(
            matches!(
                reply,
                PublishReply::Refused(PublishRefusal::InvalidPublishRequest { .. })
            ),
            "{reply:?}"
        );

        assert_eq!(
            peer.lock().expect("peer lock").scopes,
            [Some("ed-pub-5".to_owned()), None, None]
        );
    }

    #[test]
    fn a_request_header_names_the_edits_it_carries_as_a_list() {
        let with = |request: &[u8], ids: &[&str]| {
            let ids: Vec<String> = ids.iter().map(|id| (*id).to_owned()).collect();
            with_carries(request, &ids)
        };
        let parsed = |bytes: &[u8]| -> serde_json::Value { serde_json::from_slice(bytes).unwrap() };
        assert_eq!(
            parsed(&with(br#"{"scene":{"id":"s"}}"#, &["ed-1", "ed-2"])),
            serde_json::json!({"carries": ["ed-1", "ed-2"], "scene": {"id": "s"}})
        );
        assert_eq!(with(br#"{}"#, &["ed-1"]), br#"{"carries":["ed-1"]}"#);
        // After a correlation id is added, both members are there.
        let both = with_carries(
            &with_correlation(br#"{"scene":{"id":"s"}}"#, Some("ed-pub")),
            &["ed-1".to_owned()],
        );
        assert_eq!(
            parsed(&both),
            serde_json::json!({"carries": ["ed-1"], "corr": "ed-pub", "scene": {"id": "s"}})
        );
        // Nothing to name, or an id that fails the shape check: unchanged bytes
        // or only the good ids.
        assert_eq!(with(br#"{"locality":{}}"#, &[]), br#"{"locality":{}}"#);
        assert_eq!(
            with(br#"{"locality":{}}"#, &["bad id", "gx1.a.b"]),
            br#"{"locality":{}}"#
        );
        assert_eq!(
            parsed(&with(br#"{"locality":{}}"#, &["bad id", "ed-9"])),
            serde_json::json!({"carries": ["ed-9"], "locality": {}})
        );
        assert_eq!(with(b"[1]", &["ed-1"]), b"[1]");
    }

    /// 2.17: a publish that names its edits reaches the engine's publish listener
    /// with them entered, from the client's own carry scope. Hostile headers are
    /// counted, not named, and never make the request fail.
    #[test]
    fn the_server_enters_the_edits_a_publish_names_around_the_publish() {
        let (server, peer) = server();
        let address = server.local_addr().expect("address is known");
        let _listener = server.serve_in_background();

        // Through the client's own `exchange`, inside a correlation and a carry scope.
        {
            let _corr = gx_telemetry::corr::enter("ed-pub-7");
            let _carry =
                gx_telemetry::corr::carry(&["ed-edit-1".to_owned(), "ed-edit-2".to_owned()], 3);
            let bytes = serde_json::to_vec(&serde_json::json!({"scene": scene_json()})).unwrap();
            let (_, header) = exchange(address, &bytes).expect("the exchange completes");
            let reply: PublishReply = serde_json::from_slice(&header).expect("a reply");
            assert!(matches!(reply, PublishReply::Published { .. }), "{reply:?}");
        }
        // A hostile header: ids with text and a credential, a repeat, a number,
        // and more than the limit. Served, and only the valid distinct ids named.
        let mut ids: Vec<serde_json::Value> = vec![
            "ed-a".into(),
            "has space".into(),
            "gx1.pretend.credential".into(),
            "ed-a".into(),
            7.into(),
        ];
        ids.extend((0..70).map(|n| serde_json::Value::from(format!("ed-n{n}"))));
        let reply = request(
            address,
            serde_json::json!({"carries": ids, "scene": scene_json()}),
        );
        assert!(matches!(reply, PublishReply::Published { .. }), "{reply:?}");
        // A `carries` that is not a list names nothing and is not the request.
        let reply = request(
            address,
            serde_json::json!({"carries": "ed-a", "scene": scene_json()}),
        );
        assert!(matches!(reply, PublishReply::Published { .. }), "{reply:?}");
        // The key alone is still the one-member rule's refusal.
        let reply = request(address, serde_json::json!({"carries": ["ed-1"]}));
        assert!(
            matches!(
                reply,
                PublishReply::Refused(PublishRefusal::InvalidPublishRequest { .. })
            ),
            "{reply:?}"
        );

        let peer = peer.lock().expect("peer lock");
        assert_eq!(peer.scopes[0], Some("ed-pub-7".to_owned()));
        // The client's own: the two ids it named. The count its caller could not keep
        // (3) is the shell's own record's; the header carries ids only.
        assert_eq!(
            peer.carried[0],
            (vec!["ed-edit-1".to_owned(), "ed-edit-2".to_owned()], 0)
        );
        // The hostile header: 71 valid distinct ids go in ("ed-a" and 70 "ed-n"), the
        // newest 64 are named, and "ed-a" is among the oldest seven left out.
        let (named, dropped) = &peer.carried[1];
        assert_eq!(named.len(), gx_telemetry::corr::MAX_CARRIED);
        assert_eq!(named.first().map(String::as_str), Some("ed-n6"));
        assert_eq!(named.last().map(String::as_str), Some("ed-n69"));
        assert!(!named.iter().any(|id| id.contains(' ') || id.contains('.')));
        // Counted, not named: the number, the two bad ids, the repeat and the
        // seven past the limit.
        assert_eq!(*dropped, 1 + 2 + 1 + 7, "{named:?}");
        // Not a list: nothing entered.
        assert_eq!(peer.carried[2], (Vec::new(), 0));
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
