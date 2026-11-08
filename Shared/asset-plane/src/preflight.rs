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
}

impl AssetTransferServer {
    pub fn bind(addr: SocketAddr, store: Arc<Mutex<AssetStore>>) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(addr)?,
            store,
            metrics: AssetTransferMetrics(Arc::new(AtomicU64::new(0))),
        })
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
                        let store = Arc::clone(&self.store);
                        let metrics = self.metrics.clone();
                        thread::spawn(move || {
                            let _ = handle_connection(stream, store, metrics);
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
}

impl AssetTransferClient {
    pub fn connect(engine: SocketAddr) -> Result<Self, AssetTransferClientError> {
        Ok(Self {
            stream: TcpStream::connect(engine).map_err(AssetTransferClientError::Connect)?,
            transferred_bytes: 0,
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
        write_frame(&mut self.stream, &request).map_err(AssetTransferClientError::Transport)?;
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

fn handle_connection(
    mut stream: TcpStream,
    store: Arc<Mutex<AssetStore>>,
    metrics: AssetTransferMetrics,
) -> io::Result<()> {
    let mut active = None;
    while let Some(request) = read_frame::<_, AssetTransferRequest>(&mut stream)? {
        let reply = handle_request(request, &store, &metrics, &mut active)?;
        write_frame(&mut stream, &reply)?;
    }
    Ok(())
}

fn handle_request(
    request: AssetTransferRequest,
    store: &Arc<Mutex<AssetStore>>,
    metrics: &AssetTransferMetrics,
    active: &mut Option<ActiveTransfer>,
) -> io::Result<AssetTransferReply> {
    match request {
        AssetTransferRequest::Preflight { hashes } => {
            let store = store
                .lock()
                .map_err(|_| io::Error::other("asset store mutex poisoned"))?;
            let mut seen = HashSet::new();
            let mut missing = Vec::new();
            for hash in hashes {
                if seen.insert(hash.clone()) && !store.contains(&hash).map_err(io::Error::other)? {
                    missing.push(hash);
                }
            }
            Ok(AssetTransferReply::Preflight { missing })
        }
        AssetTransferRequest::Begin { hash, total_chunks } => {
            let store = store
                .lock()
                .map_err(|_| io::Error::other("asset store mutex poisoned"))?;
            if store.contains(&hash).map_err(io::Error::other)? {
                return Ok(AssetTransferReply::Refused {
                    cause: Refusal::AssetTransferAlreadyComplete { hash },
                });
            }
            drop(store);
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
            store
                .lock()
                .map_err(|_| io::Error::other("asset store mutex poisoned"))?
                .promote_verified(&hash, &completed.bytes)
                .map_err(io::Error::other)?;
            Ok(AssetTransferReply::Stored { hash })
        }
    }
}

fn write_frame<W: Write, T: Serialize>(stream: &mut W, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
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
