//! Local asset preflight and chunk-transfer wire dialect.
//!
//! A preflight identifies content the receiver has already verified; transfer
//! frames then carry only that difference. The byte counter counts asset payload
//! rather than JSON framing so the no-republish contract is directly observable.

use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use gx_contracts::{ContentHash, Refusal};
use serde::{Deserialize, Serialize};

use crate::{
    content_hash, AssetStore, PreflightRequest, PreflightResponse, Transfer,
    MAX_PUBLISH_FRAME_BYTES,
};

/// Chunk payloads stay small enough that their JSON representation remains
/// comfortably below the plane frame bound, which is checked before allocation
/// (invariant 51).
pub const ASSET_TRANSFER_CHUNK_BYTES: usize = 64 * 1024;

/// The one bounded framing limit shared by local asset-plane dialects.
pub const MAX_ASSET_FRAME_BYTES: usize = MAX_PUBLISH_FRAME_BYTES;

/// One request in the local asset transfer dialect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "request",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AssetTransferRequest {
    Preflight {
        hashes: Vec<ContentHash>,
    },
    Begin {
        hash: ContentHash,
        total_chunks: u32,
    },
    Chunk {
        hash: ContentHash,
        index: u32,
        bytes: Vec<u8>,
    },
}

/// One reply in the local asset transfer dialect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "reply",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AssetTransferReply {
    Preflight { missing: Vec<ContentHash> },
    Started { hash: ContentHash, resume_from: u32 },
    ChunkAccepted { hash: ContentHash, next_chunk: u32 },
    Stored { hash: ContentHash },
    Refused { cause: Refusal },
}

/// Bytes available for transfer under a declared content address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetBytes {
    pub hash: ContentHash,
    pub bytes: Vec<u8>,
}

impl AssetBytes {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        let hash = content_hash(&bytes);
        Self { hash, bytes }
    }
}

/// The observable outcome of one preflight-and-transfer publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetPublishSummary {
    pub missing: Vec<ContentHash>,
    pub transferred_bytes: u64,
}

/// Shared measurement of raw asset bytes admitted by a transfer listener.
#[derive(Debug, Clone)]
pub struct AssetTransferMetrics(Arc<AtomicU64>);

impl AssetTransferMetrics {
    pub fn received_asset_bytes(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// A bounded local listener that answers preflight before receiving asset bytes.
pub struct AssetTransferServer {
    listener: TcpListener,
    store: Arc<Mutex<AssetStore>>,
    metrics: AssetTransferMetrics,
    /// What every connection is held to (2.22).
    limits: crate::limits::AssetLimits,
    /// Connections held now, against `limits.max_connections`.
    connections: Arc<std::sync::atomic::AtomicUsize>,
}

impl AssetTransferServer {
    pub fn bind(addr: SocketAddr, store: Arc<Mutex<AssetStore>>) -> io::Result<Self> {
        crate::publish::check_asset_listen(addr)?;
        Ok(Self {
            listener: TcpListener::bind(addr)?,
            store,
            metrics: AssetTransferMetrics(Arc::new(AtomicU64::new(0))),
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

    pub fn metrics(&self) -> AssetTransferMetrics {
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
                        let store = Arc::clone(&self.store);
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
                            let _ = handle_connection(stream, store, metrics, &limits);
                        });
                    }
                    Err(error) => {
                        eprintln!("asset transfer listener stopping: {error}");
                        return;
                    }
                }
            }
        })
    }
}

/// A connection-scoped client so preflight and every required chunk use exactly
/// the same wire implementation as the listener (invariant 27).
pub struct AssetTransferClient {
    stream: TcpStream,
    transferred_bytes: u64,
    /// Whether this connection's first frame, the one that names the action
    /// (2.13), has been sent.
    opened: bool,
}

impl AssetTransferClient {
    pub fn connect(engine: SocketAddr) -> Result<Self, AssetTransferClientError> {
        Ok(Self {
            stream: TcpStream::connect(engine).map_err(AssetTransferClientError::Connect)?,
            transferred_bytes: 0,
            opened: false,
        })
    }

    pub fn preflight(
        &mut self,
        request: PreflightRequest,
    ) -> Result<PreflightResponse, AssetTransferClientError> {
        match self.request(AssetTransferRequest::Preflight {
            hashes: request.hashes,
        })? {
            AssetTransferReply::Preflight { missing } => Ok(PreflightResponse { missing }),
            AssetTransferReply::Refused { cause } => Err(AssetTransferClientError::Refused(cause)),
            reply => Err(AssetTransferClientError::UnexpectedReply { reply }),
        }
    }

    pub fn transfer(&mut self, asset: &AssetBytes) -> Result<(), AssetTransferClientError> {
        let chunks = asset.bytes.len() / ASSET_TRANSFER_CHUNK_BYTES
            + usize::from(asset.bytes.len() % ASSET_TRANSFER_CHUNK_BYTES != 0);
        let total_chunks =
            u32::try_from(chunks).map_err(|_| AssetTransferClientError::RequestTooLarge {
                bytes: asset.bytes.len(),
            })?;
        match self.request(AssetTransferRequest::Begin {
            hash: asset.hash.clone(),
            total_chunks,
        })? {
            AssetTransferReply::Started { .. } => {}
            AssetTransferReply::Refused { cause } => {
                return Err(AssetTransferClientError::Refused(cause))
            }
            reply => return Err(AssetTransferClientError::UnexpectedReply { reply }),
        }

        for (index, bytes) in asset.bytes.chunks(ASSET_TRANSFER_CHUNK_BYTES).enumerate() {
            let index =
                u32::try_from(index).map_err(|_| AssetTransferClientError::RequestTooLarge {
                    bytes: asset.bytes.len(),
                })?;
            let bytes = bytes.to_vec();
            let byte_count = bytes.len() as u64;
            match self.request(AssetTransferRequest::Chunk {
                hash: asset.hash.clone(),
                index,
                bytes,
            })? {
                AssetTransferReply::ChunkAccepted { .. } => {
                    self.transferred_bytes += byte_count;
                }
                AssetTransferReply::Stored { .. } => {
                    self.transferred_bytes += byte_count;
                    return Ok(());
                }
                AssetTransferReply::Refused { cause } => {
                    return Err(AssetTransferClientError::Refused(cause));
                }
                reply => return Err(AssetTransferClientError::UnexpectedReply { reply }),
            }
        }

        Err(AssetTransferClientError::UnexpectedReply {
            reply: AssetTransferReply::Started {
                hash: asset.hash.clone(),
                resume_from: 0,
            },
        })
    }

    pub fn publish(
        &mut self,
        assets: &[AssetBytes],
    ) -> Result<AssetPublishSummary, AssetTransferClientError> {
        let response = self.preflight(PreflightRequest {
            hashes: assets.iter().map(|asset| asset.hash.clone()).collect(),
        })?;
        let missing: HashSet<_> = response.missing.iter().cloned().collect();
        let mut transferred = HashSet::new();
        let before = self.transferred_bytes;
        for asset in assets {
            if missing.contains(&asset.hash) && transferred.insert(asset.hash.clone()) {
                self.transfer(asset)?;
            }
        }
        Ok(AssetPublishSummary {
            missing: response.missing,
            transferred_bytes: self.transferred_bytes - before,
        })
    }

    fn request(
        &mut self,
        request: AssetTransferRequest,
    ) -> Result<AssetTransferReply, AssetTransferClientError> {
        // 2.13: the connection's first frame carries the correlation id of the
        // action it belongs to; the listener enters it for the whole connection.
        let correlation = if std::mem::replace(&mut self.opened, true) {
            None
        } else {
            gx_telemetry::corr::current()
        };
        write_frame_for(&mut self.stream, &request, correlation.as_deref())
            .map_err(AssetTransferClientError::Transport)?;
        read_frame(&mut self.stream)
            .map_err(AssetTransferClientError::Transport)?
            .ok_or_else(|| {
                AssetTransferClientError::Transport(io::Error::from(io::ErrorKind::UnexpectedEof))
            })
    }
}

/// Publish the missing difference through the sole local asset-plane client.
pub fn publish_assets(
    engine: SocketAddr,
    assets: &[AssetBytes],
) -> Result<AssetPublishSummary, AssetTransferClientError> {
    let mut client = AssetTransferClient::connect(engine)?;
    client.publish(assets)
}

/// A client-side failure. Refusals remain values so callers retain the exact
/// condition the receiver rejected rather than inventing a local substitute.
#[derive(Debug)]
pub enum AssetTransferClientError {
    Connect(io::Error),
    Transport(io::Error),
    RequestTooLarge { bytes: usize },
    Refused(Refusal),
    UnexpectedReply { reply: AssetTransferReply },
}

impl std::fmt::Display for AssetTransferClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(source) => write!(f, "cannot reach the asset plane: {source}"),
            Self::Transport(source) => write!(f, "asset-plane transport failed: {source}"),
            Self::RequestTooLarge { bytes } => {
                write!(f, "asset-plane request frame is {bytes} bytes")
            }
            Self::Refused(cause) => write!(f, "asset-plane request refused: {cause}"),
            Self::UnexpectedReply { reply } => {
                write!(f, "asset-plane received unexpected reply: {reply:?}")
            }
        }
    }
}

impl std::error::Error for AssetTransferClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Connect(source) | Self::Transport(source) => Some(source),
            Self::RequestTooLarge { .. } | Self::Refused(_) | Self::UnexpectedReply { .. } => None,
        }
    }
}

struct ActiveTransfer {
    transfer: Transfer,
    bytes: Vec<u8>,
}

/// Where a transfer's verified bytes go (5.9): the on-disk [`AssetStore`] for
/// the standalone listener, or an engine that keeps them in memory behind the
/// publish port. Both answer the same two questions, so the dialect has one
/// implementation whichever receiver it serves (invariant 27).
pub(crate) trait VerifiedAssets {
    /// Whether verified bytes for `hash` are already held.
    fn has(&self, hash: &ContentHash) -> io::Result<bool>;
    /// Keep bytes the dialect has re-hashed against `hash`.
    fn accept(&self, hash: &ContentHash, bytes: Vec<u8>) -> io::Result<Result<(), Refusal>>;
}

impl VerifiedAssets for Arc<Mutex<AssetStore>> {
    fn has(&self, hash: &ContentHash) -> io::Result<bool> {
        self.lock()
            .map_err(|_| io::Error::other("asset store mutex poisoned"))?
            .contains(hash)
            .map_err(io::Error::other)
    }
    fn accept(&self, hash: &ContentHash, bytes: Vec<u8>) -> io::Result<Result<(), Refusal>> {
        self.lock()
            .map_err(|_| io::Error::other("asset store mutex poisoned"))?
            .promote_verified(hash, &bytes)
            .map_err(io::Error::other)?;
        Ok(Ok(()))
    }
}

fn handle_connection(
    mut stream: TcpStream,
    store: Arc<Mutex<AssetStore>>,
    metrics: AssetTransferMetrics,
    limits: &crate::limits::AssetLimits,
) -> io::Result<()> {
    serve_transfer(&mut stream, None, &store, &metrics, limits)
}

/// Serve the transfer dialect on one connection, starting with `first` when a
/// caller has already read the opening frame (the publish port does, to tell
/// the two dialects apart).
pub(crate) fn serve_transfer<A: VerifiedAssets>(
    stream: &mut TcpStream,
    first: Option<AssetTransferRequest>,
    assets: &A,
    metrics: &AssetTransferMetrics,
    limits: &crate::limits::AssetLimits,
) -> io::Result<()> {
    let mut active = None;
    let mut next = first;
    // 2.22: a connection that has not sent its first request has the shorter
    // first-frame deadline; one that has begun may pause for `idle_deadline`.
    let mut wait = if next.is_some() {
        limits.idle_deadline
    } else {
        limits.first_frame_deadline
    };
    let mut carried = 0u64;
    loop {
        let request = match next.take() {
            Some(request) => request,
            None => {
                match read_frame_bounded::<AssetTransferRequest>(
                    stream,
                    wait,
                    limits.frame_deadline,
                )? {
                    Some(request) => request,
                    None => return Ok(()),
                }
            }
        };
        wait = limits.idle_deadline;
        within_limits(&request, limits, &mut carried)?;
        let reply = handle_request(request, assets, metrics, &mut active)?;
        write_frame(stream, &reply)?;
    }
}

/// Bound a transfer as it arrives (2.22), before any byte of it is held: a
/// transfer may not declare more chunks than a package can hold, a chunk may be no
/// larger than the chunk size, and a connection may send no more than a package's
/// worth in all. A request over a bound ends the connection with the bound named,
/// on record; nothing it carried is stored.
fn within_limits(
    request: &AssetTransferRequest,
    limits: &crate::limits::AssetLimits,
    carried: &mut u64,
) -> io::Result<()> {
    let refuse = |hash: &ContentHash, detail: String| {
        tracing::warn!(
            event = "asset.transfer_refused",
            hash = hash.0.as_str(),
            detail = detail.as_str(),
        );
        Err(io::Error::new(io::ErrorKind::InvalidData, detail))
    };
    match request {
        AssetTransferRequest::Begin { hash, total_chunks }
            if *total_chunks > limits.max_transfer_chunks =>
        {
            refuse(
                hash,
                format!(
                    "a transfer declares {total_chunks} chunks; at most {} are accepted",
                    limits.max_transfer_chunks
                ),
            )
        }
        AssetTransferRequest::Chunk { hash, bytes, .. } => {
            if bytes.len() > ASSET_TRANSFER_CHUNK_BYTES {
                return refuse(
                    hash,
                    format!(
                        "a chunk of {} bytes; at most {ASSET_TRANSFER_CHUNK_BYTES} are accepted",
                        bytes.len()
                    ),
                );
            }
            *carried = carried.saturating_add(bytes.len() as u64);
            if *carried > limits.max_connection_bytes {
                return refuse(
                    hash,
                    format!(
                        "this connection has sent more than the {} bytes it may send",
                        limits.max_connection_bytes
                    ),
                );
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// [`read_frame`] on a TCP stream, under the deadlines of 2.22: `first` to wait
/// for the frame to begin, `frame` for the rest of it. The declared length is
/// checked before the buffer for it is allocated (invariant 51).
fn read_frame_bounded<T: for<'de> Deserialize<'de>>(
    stream: &mut TcpStream,
    first: std::time::Duration,
    frame: std::time::Duration,
) -> io::Result<Option<T>> {
    let Some(start) = crate::limits::read_frame_start(stream, first, frame)? else {
        return Ok(None);
    };
    if start.length > MAX_ASSET_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "asset frame is {} bytes; maximum is {MAX_ASSET_FRAME_BYTES}",
                start.length
            ),
        ));
    }
    let bytes = crate::limits::read_frame_body(stream, &start, frame)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}

impl AssetTransferMetrics {
    /// A fresh counter, for a listener other than [`AssetTransferServer`].
    pub(crate) fn new() -> Self {
        Self(Arc::new(AtomicU64::new(0)))
    }
}

fn handle_request<A: VerifiedAssets>(
    request: AssetTransferRequest,
    assets: &A,
    metrics: &AssetTransferMetrics,
    active: &mut Option<ActiveTransfer>,
) -> io::Result<AssetTransferReply> {
    match request {
        AssetTransferRequest::Preflight { hashes } => {
            let mut seen = HashSet::new();
            let mut missing = Vec::new();
            for hash in hashes {
                if seen.insert(hash.clone()) && !assets.has(&hash)? {
                    missing.push(hash);
                }
            }
            Ok(AssetTransferReply::Preflight { missing })
        }
        AssetTransferRequest::Begin { hash, total_chunks } => {
            if assets.has(&hash)? {
                return Ok(AssetTransferReply::Refused {
                    cause: Refusal::AssetTransferAlreadyComplete { hash },
                });
            }
            match Transfer::new(hash.clone(), total_chunks) {
                Ok(transfer) => {
                    *active = Some(ActiveTransfer {
                        transfer,
                        bytes: Vec::new(),
                    });
                    Ok(AssetTransferReply::Started {
                        hash,
                        resume_from: 0,
                    })
                }
                Err(cause) => Ok(AssetTransferReply::Refused { cause }),
            }
        }
        AssetTransferRequest::Chunk { hash, index, bytes } => {
            let complete = {
                let active_transfer = active.as_mut().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "asset chunk arrived before begin",
                    )
                })?;
                if active_transfer.transfer.hash() != &hash {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "asset chunk named a different transfer",
                    ));
                }
                if let Err(cause) = active_transfer.transfer.accept_chunk(index) {
                    return Ok(AssetTransferReply::Refused { cause });
                }
                metrics.0.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                active_transfer.bytes.extend_from_slice(&bytes);
                active_transfer.transfer.is_complete()
            };
            if !complete {
                return Ok(AssetTransferReply::ChunkAccepted {
                    hash,
                    next_chunk: index + 1,
                });
            }

            let mut completed = active
                .take()
                .expect("completed transfer must remain active");
            let actual = content_hash(&completed.bytes);
            if let Err(cause) = completed.transfer.verify(&actual) {
                return Ok(AssetTransferReply::Refused { cause });
            }
            match assets.accept(&hash, completed.bytes)? {
                Ok(()) => Ok(AssetTransferReply::Stored { hash }),
                Err(cause) => Ok(AssetTransferReply::Refused { cause }),
            }
        }
    }
}

fn write_frame<W: Write, T: Serialize>(stream: &mut W, value: &T) -> io::Result<()> {
    write_frame_for(stream, value, None)
}

/// [`write_frame`], with the frame's correlation id when it has one.
fn write_frame_for<W: Write, T: Serialize>(
    stream: &mut W,
    value: &T,
    correlation: Option<&str>,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    let bytes = crate::publish::with_correlation(&bytes, correlation);
    if bytes.len() > MAX_ASSET_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "asset frame is {} bytes; maximum is {MAX_ASSET_FRAME_BYTES}",
                bytes.len()
            ),
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "asset frame exceeds u32"))?;
    stream.write_all(&length.to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()
}

fn read_frame<R: Read, T: for<'de> Deserialize<'de>>(stream: &mut R) -> io::Result<Option<T>> {
    let mut prefix = [0_u8; 4];
    match stream.read(&mut prefix[..1])? {
        0 => return Ok(None),
        _ => stream.read_exact(&mut prefix[1..])?,
    }
    let length = u32::from_be_bytes(prefix) as usize;
    // A declared length is validated before the allocation it requests
    // (invariant 51).
    if length > MAX_ASSET_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("asset frame is {length} bytes; maximum is {MAX_ASSET_FRAME_BYTES}"),
        ));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::net::{IpAddr, Ipv4Addr};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use std::io::Cursor;

    use super::*;

    static NEXT_TEMPORARY_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn temporary_directory() -> PathBuf {
        let sequence = NEXT_TEMPORARY_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gx-asset-preflight-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temporary asset cache directory must be creatable");
        path
    }

    fn server() -> (SocketAddr, AssetTransferMetrics, PathBuf) {
        let directory = temporary_directory();
        let store = Arc::new(Mutex::new(AssetStore::at_root(directory.clone())));
        let server =
            AssetTransferServer::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0), store)
                .expect("asset transfer server must bind");
        let address = server.local_addr().expect("bound listener has an address");
        let metrics = server.metrics();
        server.serve_in_background();
        (address, metrics, directory)
    }

    /// 2.21: the transfer server asks the one bind policy before it opens a
    /// socket, as the publish server does: loopback only, no reserved port.
    #[test]
    fn the_transfer_server_asks_the_bind_policy_before_it_opens_a_socket() {
        let directory = temporary_directory();
        for (ip, port, because) in [
            ("0.0.0.0", 0, "verifies no credential"),
            ("192.168.1.50", 0, "verifies no credential"),
            ("::", 0, "verifies no credential"),
            ("127.0.0.1", 4100, "port 4100 is reserved"),
        ] {
            let addr = SocketAddr::new(ip.parse().unwrap(), port);
            let store = Arc::new(Mutex::new(AssetStore::at_root(directory.clone())));
            let refused = match AssetTransferServer::bind(addr, store) {
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
        let _ = fs::remove_dir_all(directory);
    }

    // --- 2.22: a stalled or hostile peer costs a bounded thread for a bounded time ---

    fn quick() -> crate::limits::AssetLimits {
        crate::limits::AssetLimits {
            max_connections: 3,
            first_frame_deadline: std::time::Duration::from_millis(400),
            idle_deadline: std::time::Duration::from_millis(600),
            frame_deadline: std::time::Duration::from_millis(400),
            write_deadline: std::time::Duration::from_secs(2),
            max_transfer_chunks: 4,
            max_connection_bytes: 100 * 1024,
        }
    }

    fn server_within(
        limits: crate::limits::AssetLimits,
    ) -> (SocketAddr, AssetTransferMetrics, PathBuf) {
        let directory = temporary_directory();
        let store = Arc::new(Mutex::new(AssetStore::at_root(directory.clone())));
        let server =
            AssetTransferServer::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0), store)
                .expect("asset transfer server must bind")
                .with_limits(limits);
        let address = server.local_addr().expect("bound listener has an address");
        let metrics = server.metrics();
        server.serve_in_background();
        (address, metrics, directory)
    }

    /// How long until the server closes `stream`, or `None` if it is still open
    /// after `limit`. Anything it sends meanwhile is read and thrown away.
    fn closed_after(
        stream: &mut TcpStream,
        limit: std::time::Duration,
    ) -> Option<std::time::Duration> {
        let started = std::time::Instant::now();
        let mut sink = [0u8; 256];
        while started.elapsed() < limit {
            let left = limit
                .saturating_sub(started.elapsed())
                .max(std::time::Duration::from_millis(1));
            stream.set_read_timeout(Some(left)).expect("a read timeout");
            match stream.read(&mut sink) {
                Ok(0) => return Some(started.elapsed()),
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return None
                }
                Err(_) => return Some(started.elapsed()),
            }
        }
        None
    }

    fn hash() -> ContentHash {
        ContentHash("a".repeat(64))
    }

    #[test]
    fn a_peer_that_sends_nothing_is_dropped_at_the_first_frame_deadline() {
        let (address, _, directory) = server_within(quick());
        let mut silent = TcpStream::connect(address).expect("connects");
        let took = closed_after(&mut silent, std::time::Duration::from_secs(5))
            .expect("a silent peer was still held after 5 s");
        assert!(
            took >= std::time::Duration::from_millis(300)
                && took < std::time::Duration::from_secs(2),
            "dropped after {took:?}, deadline 400 ms"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_peer_that_pauses_between_requests_is_dropped_at_the_idle_deadline() {
        let (address, _, directory) = server_within(quick());
        let mut peer = TcpStream::connect(address).expect("connects");
        write_frame(
            &mut peer,
            &AssetTransferRequest::Preflight {
                hashes: vec![hash()],
            },
        )
        .expect("a request is sent");
        let reply: AssetTransferReply = read_frame(&mut peer)
            .expect("a reply reads")
            .expect("a reply arrives");
        assert!(
            matches!(reply, AssetTransferReply::Preflight { .. }),
            "{reply:?}"
        );
        let took = closed_after(&mut peer, std::time::Duration::from_secs(5))
            .expect("a paused peer was still held after 5 s");
        assert!(
            took >= std::time::Duration::from_millis(450)
                && took < std::time::Duration::from_secs(3),
            "dropped after {took:?}, idle deadline 600 ms"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_frame_that_begins_and_stalls_is_dropped_at_the_frame_deadline() {
        let mut limits = quick();
        // Long enough that only the frame deadline can be what closes it.
        limits.idle_deadline = std::time::Duration::from_secs(30);
        let (address, _, directory) = server_within(limits);
        let mut peer = TcpStream::connect(address).expect("connects");
        peer.write_all(&[0, 0]).expect("half a prefix is sent");
        let took = closed_after(&mut peer, std::time::Duration::from_secs(5))
            .expect("a frame that stalled was still held after 5 s");
        assert!(
            took >= std::time::Duration::from_millis(300)
                && took < std::time::Duration::from_secs(2),
            "dropped after {took:?}, frame deadline 400 ms"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_connection_over_the_cap_is_closed_at_once_and_a_place_is_given_back() {
        let mut limits = quick();
        limits.max_connections = 2;
        limits.first_frame_deadline = std::time::Duration::from_secs(30);
        let (address, _, directory) = server_within(limits);
        let first = TcpStream::connect(address).expect("the first connects");
        let _second = TcpStream::connect(address).expect("the second connects");
        // Let the server take both places before the third arrives.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let mut third = TcpStream::connect(address).expect("the socket opens");
        let took = closed_after(&mut third, std::time::Duration::from_secs(3))
            .expect("a connection over the cap was held");
        assert!(
            took < std::time::Duration::from_secs(1),
            "closed after {took:?}, not at once"
        );

        drop(first);
        let started = std::time::Instant::now();
        let mut served = false;
        while started.elapsed() < std::time::Duration::from_secs(5) && !served {
            let mut again = TcpStream::connect(address).expect("connects");
            write_frame(
                &mut again,
                &AssetTransferRequest::Preflight {
                    hashes: vec![hash()],
                },
            )
            .expect("a request is sent");
            again
                .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                .expect("a read timeout");
            served = matches!(
                read_frame::<_, AssetTransferReply>(&mut again),
                Ok(Some(AssetTransferReply::Preflight { .. }))
            );
            if !served {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        assert!(served, "a place was never given back");
        let _ = fs::remove_dir_all(directory);
    }

    /// A transfer is bounded as it arrives: a Begin that declares more chunks than
    /// a package can hold, a chunk larger than the chunk size and a connection that
    /// has sent more than it may each end the connection before a byte of the
    /// offending request is held, and nothing is stored.
    #[test]
    fn a_transfer_is_bounded_as_it_arrives_not_after_it_is_assembled() {
        // The idle deadline is long here: a connection that is closed within the
        // wait was closed by the bound, not by a timeout that would close any
        // silent connection (a mutation that removed the chunk-count bound passed
        // this test while the idle deadline was 600 ms).
        let mut limits = quick();
        limits.idle_deadline = std::time::Duration::from_secs(30);
        let (address, metrics, directory) = server_within(limits);
        let closed = |peer: &mut TcpStream| {
            closed_after(peer, std::time::Duration::from_secs(3))
                .expect("a request over a bound was answered and the connection held")
        };

        // (a) more chunks than may be declared (the limit here is 4).
        let mut peer = TcpStream::connect(address).expect("connects");
        write_frame(
            &mut peer,
            &AssetTransferRequest::Begin {
                hash: hash(),
                total_chunks: 5,
            },
        )
        .expect("a begin is sent");
        assert!(closed(&mut peer) < std::time::Duration::from_secs(2));

        // (b) a chunk over the chunk size.
        let mut peer = TcpStream::connect(address).expect("connects");
        write_frame(
            &mut peer,
            &AssetTransferRequest::Begin {
                hash: hash(),
                total_chunks: 2,
            },
        )
        .expect("a begin is sent");
        let started: AssetTransferReply = read_frame(&mut peer).expect("reads").expect("a reply");
        assert!(
            matches!(started, AssetTransferReply::Started { .. }),
            "{started:?}"
        );
        write_frame(
            &mut peer,
            &AssetTransferRequest::Chunk {
                hash: hash(),
                index: 0,
                bytes: vec![7; ASSET_TRANSFER_CHUNK_BYTES + 1],
            },
        )
        .expect("a chunk is sent");
        assert!(closed(&mut peer) < std::time::Duration::from_secs(2));
        assert_eq!(
            metrics.received_asset_bytes(),
            0,
            "an oversize chunk was counted as received"
        );

        // (c) more bytes in all than the connection may send (the limit here is 100 KiB).
        let mut peer = TcpStream::connect(address).expect("connects");
        write_frame(
            &mut peer,
            &AssetTransferRequest::Begin {
                hash: hash(),
                total_chunks: 4,
            },
        )
        .expect("a begin is sent");
        let _: Option<AssetTransferReply> = read_frame(&mut peer).expect("reads");
        let chunk = |index| AssetTransferRequest::Chunk {
            hash: hash(),
            index,
            bytes: vec![7; ASSET_TRANSFER_CHUNK_BYTES],
        };
        write_frame(&mut peer, &chunk(0)).expect("a chunk is sent");
        let accepted: AssetTransferReply = read_frame(&mut peer).expect("reads").expect("a reply");
        assert!(
            matches!(accepted, AssetTransferReply::ChunkAccepted { .. }),
            "{accepted:?}"
        );
        write_frame(&mut peer, &chunk(1)).expect("a chunk is sent");
        assert!(closed(&mut peer) < std::time::Duration::from_secs(2));
        assert_eq!(
            metrics.received_asset_bytes(),
            ASSET_TRANSFER_CHUNK_BYTES as u64,
            "only the chunk inside the bound was admitted"
        );
        let _ = fs::remove_dir_all(directory);
    }

    /// The limits do not touch a transfer that stays inside them.
    #[test]
    fn a_transfer_inside_every_bound_is_served() {
        let (address, _, directory) = server_within(quick());
        let bytes = vec![3u8; ASSET_TRANSFER_CHUNK_BYTES + 10];
        let asset = AssetBytes {
            hash: content_hash(&bytes),
            bytes,
        };
        let mut client = AssetTransferClient::connect(address).expect("connects");
        client
            .transfer(&asset)
            .expect("a two-chunk transfer inside the bounds is stored");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn an_accepted_stream_is_low_latency_and_its_writes_are_bounded() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a listener");
        let address = listener.local_addr().expect("an address");
        let _client = TcpStream::connect(address).expect("connects");
        let (accepted, _) = listener.accept().expect("accepts");
        let problems = crate::limits::configure(&accepted, &quick());
        assert!(problems.is_empty(), "{problems:?}");
        assert!(
            accepted.nodelay().expect("nodelay reads"),
            "Nagle is still on"
        );
        assert_eq!(
            accepted.write_timeout().expect("a write timeout reads"),
            Some(std::time::Duration::from_secs(2))
        );
    }

    #[test]
    fn a_first_frame_may_carry_a_correlation_id_and_still_reads_as_the_same_request() {
        // 2.13: the LAN route's connection names its action in its first frame.
        let request = AssetTransferRequest::Preflight { hashes: Vec::new() };
        let mut plain = Vec::new();
        write_frame(&mut plain, &request).expect("a plain frame writes");
        let mut tagged = Vec::new();
        write_frame_for(&mut tagged, &request, Some("ed-1a-2")).expect("a tagged frame writes");
        assert!(String::from_utf8_lossy(&tagged).contains(r#""corr":"ed-1a-2""#));
        assert!(!String::from_utf8_lossy(&plain).contains("corr"));
        let read: Option<AssetTransferRequest> =
            read_frame(&mut Cursor::new(tagged)).expect("the tagged frame reads");
        assert!(
            matches!(read, Some(AssetTransferRequest::Preflight { hashes }) if hashes.is_empty()),
            "the id does not change what the request is"
        );
    }

    #[test]
    fn the_client_names_its_action_in_its_first_frame_and_in_no_other() {
        // 2.13: the id travels once per connection, on the frame that opens it. A
        // raw listener reads what the real client puts on the wire.
        let listener =
            std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a listener must bind");
        let address = listener
            .local_addr()
            .expect("a bound listener has an address");
        let peer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("the client must connect");
            let mut frames = Vec::new();
            for _ in 0..2 {
                let frame: serde_json::Value = read_frame(&mut stream)
                    .expect("a frame must read")
                    .expect("the client must send a frame");
                frames.push(frame);
                write_frame(
                    &mut stream,
                    &AssetTransferReply::Preflight {
                        missing: Vec::new(),
                    },
                )
                .expect("the reply must write");
            }
            frames
        });

        let _scope = gx_telemetry::corr::enter("ed-test-1");
        let mut client = AssetTransferClient::connect(address).expect("client must connect");
        for _ in 0..2 {
            client
                .preflight(PreflightRequest { hashes: Vec::new() })
                .expect("preflight must reply");
        }

        let frames = peer.join().expect("the listener thread must finish");
        assert_eq!(
            frames[0]["corr"], "ed-test-1",
            "the first frame names the action it belongs to"
        );
        assert!(
            frames[1].get("corr").is_none(),
            "a later frame of the same connection does not repeat it"
        );
    }

    #[test]
    fn republish_sends_only_the_changed_asset_bytes() {
        let (address, metrics, directory) = server();
        let unchanged_a = AssetBytes::from_bytes(b"alpha".to_vec());
        let unchanged_b = AssetBytes::from_bytes(b"bravo".to_vec());
        let changed_original = AssetBytes::from_bytes(b"charlie-v1".to_vec());
        let first = publish_assets(
            address,
            &[unchanged_a.clone(), unchanged_b.clone(), changed_original],
        )
        .expect("the first publication must transfer every missing asset");
        assert_eq!(first.transferred_bytes, 20);
        assert_eq!(metrics.received_asset_bytes(), 20);

        let changed = AssetBytes::from_bytes(b"charlie-v2".to_vec());
        let before = metrics.received_asset_bytes();
        let second = publish_assets(address, &[unchanged_a, unchanged_b, changed.clone()])
            .expect("the second publication must transfer its preflight difference");
        assert_eq!(second.missing, vec![changed.hash.clone()]);
        assert_eq!(second.transferred_bytes, changed.bytes.len() as u64);
        assert_eq!(
            metrics.received_asset_bytes() - before,
            changed.bytes.len() as u64,
            "unchanged asset payloads must contribute zero bytes on republish"
        );

        fs::remove_dir_all(directory).expect("test cache directory must be removable");
    }

    #[test]
    fn preflight_reports_only_hashes_absent_from_the_verified_store() {
        let (address, _, directory) = server();
        let present = AssetBytes::from_bytes(b"present".to_vec());
        let absent = AssetBytes::from_bytes(b"absent".to_vec());
        publish_assets(address, std::slice::from_ref(&present))
            .expect("the present asset must be stored first");

        let mut client = AssetTransferClient::connect(address).expect("client must connect");
        assert_eq!(
            client
                .preflight(PreflightRequest {
                    hashes: vec![
                        present.hash.clone(),
                        absent.hash.clone(),
                        absent.hash.clone()
                    ],
                })
                .expect("preflight must reply"),
            PreflightResponse {
                missing: vec![absent.hash]
            }
        );
        fs::remove_dir_all(directory).expect("test cache directory must be removable");
    }

    #[test]
    fn mismatched_transfer_bytes_refuse_by_the_hash_mismatch_name() {
        let (address, _, directory) = server();
        let asset = AssetBytes {
            hash: content_hash(b"declared"),
            bytes: b"received".to_vec(),
        };
        let error = publish_assets(address, &[asset]).expect_err("hash mismatch must refuse");
        assert!(matches!(
            error,
            AssetTransferClientError::Refused(Refusal::AssetHashMismatch { .. })
        ));
        fs::remove_dir_all(directory).expect("test cache directory must be removable");
    }
}
