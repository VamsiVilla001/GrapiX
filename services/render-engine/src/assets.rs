//! Asset synchronisation.
//!
//! An engine on another machine cannot read the Editor's disk, so the bytes have to
//! travel. This is the store that receives them, verifies them, and decides when they can
//! be thrown away.
//!
//! The design decisions, and why each one is the way it is:
//!
//! - **Content addressed.** The cache is keyed by SHA-256, not by asset id or filename.
//!   Two scenes referencing the same logo transfer it once, and a scene republished with
//!   an unchanged image transfers nothing. It also means the cache cannot be poisoned by
//!   a name collision.
//!
//! - **Verified before use.** An upload is hashed as it arrives and the digest is compared
//!   with the declared one before the bytes are published into the cache. A mismatch
//!   discards the whole transfer. Rendering a corrupt asset would put visible garbage on
//!   air, and half a JPEG decodes to something rather than failing.
//!
//! - **Resumable.** Chunks carry their index, so a transfer interrupted at 90% resumes
//!   rather than restarting. A 2 GB video over a link that drops is otherwise unusable.
//!
//! - **Reference counted, not garbage collected on a timer.** A scene declares which
//!   assets it needs; releasing one that is still referenced is refused unless forced.
//!   Evicting an asset a scene on air is using would put a hole on screen.
//!
//! - **Never an arbitrary path.** A client names a *relative* path resolved inside a
//!   configured root, or uploads bytes, or names an allowlisted URL. There is no fourth
//!   option, because the third would otherwise become "the engine reads any file".

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How the engine is expected to obtain the bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetTransport {
    /// Already on the engine's disk, inside a configured root.
    EngineLocal,
    /// Fetched over HTTP(S) from an allowlisted host.
    Http,
    /// Pushed to the engine in chunks.
    Upload,
    /// Present in a cache shared between engines.
    SharedCache,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetFetchState {
    Absent,
    Fetching,
    Cached,
    Failed,
}

/// One asset the engine knows about.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecord {
    pub asset_id: String,
    pub sha256: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub transport: AssetTransport,
    pub fetch_state: AssetFetchState,
    /// Where the bytes are, once they are somewhere.
    pub cache_path: Option<String>,
    /// Scenes that declared they need this asset.
    pub referenced_by: Vec<String>,
    pub last_error: Option<String>,
    pub last_used_ms: u64,
}

impl AssetRecord {
    pub fn is_ready(&self) -> bool {
        self.fetch_state == AssetFetchState::Cached
    }

    pub fn reference_count(&self) -> usize {
        self.referenced_by.len()
    }
}

/// An in-progress chunked upload.
#[derive(Debug)]
pub struct UploadSession {
    pub asset_id: String,
    pub sha256: String,
    pub chunk_count: u32,
    pub total_bytes: u64,
    /// Chunks in index order. `None` for one not yet received, so an out-of-order
    /// arrival is stored rather than rejected.
    chunks: Vec<Option<Vec<u8>>>,
    pub received_bytes: u64,
    pub started_ms: u64,
}

impl UploadSession {
    fn new(asset_id: String, sha256: String, chunk_count: u32, total_bytes: u64, now_ms: u64) -> Self {
        Self {
            asset_id,
            sha256,
            chunk_count,
            total_bytes,
            chunks: vec![None; chunk_count as usize],
            received_bytes: 0,
            started_ms: now_ms,
        }
    }

    pub fn received_chunks(&self) -> u32 {
        self.chunks.iter().filter(|chunk| chunk.is_some()).count() as u32
    }

    pub fn is_complete(&self) -> bool {
        self.chunks.iter().all(Option::is_some)
    }

    /// Indices still missing, so a resuming client knows exactly what to resend.
    pub fn missing_chunks(&self) -> Vec<u32> {
        self.chunks
            .iter()
            .enumerate()
            .filter(|(_, chunk)| chunk.is_none())
            .map(|(index, _)| index as u32)
            .collect()
    }

    fn assemble(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.received_bytes as usize);
        for chunk in self.chunks.iter().flatten() {
            bytes.extend_from_slice(chunk);
        }
        bytes
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetRejection {
    /// The digest is not 64 lower-case hex characters.
    MalformedDigest,
    UnknownAsset,
    /// The declared size is beyond `assets.max-upload-bytes`.
    TooLarge,
    /// One chunk is beyond `assets.max-chunk-bytes`.
    ChunkTooLarge,
    ChunkIndexOutOfRange,
    /// The chunk count or total changed mid-transfer.
    SessionMismatch,
    /// The assembled bytes did not hash to the declared digest.
    ChecksumMismatch,
    /// The path escaped every configured root, or none is configured.
    PathRefused(String),
    /// HTTP fetching is off, or the host is not allowlisted.
    FetchRefused(String),
    /// Still referenced by a scene.
    StillReferenced(Vec<String>),
    Io(String),
}

impl AssetRejection {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MalformedDigest => "MALFORMED_DIGEST",
            Self::UnknownAsset => "UNKNOWN_ASSET",
            Self::TooLarge => "ASSET_TOO_LARGE",
            Self::ChunkTooLarge => "CHUNK_TOO_LARGE",
            Self::ChunkIndexOutOfRange => "CHUNK_INDEX_OUT_OF_RANGE",
            Self::SessionMismatch => "UPLOAD_SESSION_MISMATCH",
            Self::ChecksumMismatch => "CHECKSUM_MISMATCH",
            Self::PathRefused(_) => "ASSET_PATH_REFUSED",
            Self::FetchRefused(_) => "ASSET_FETCH_REFUSED",
            Self::StillReferenced(_) => "ASSET_STILL_REFERENCED",
            Self::Io(_) => "ASSET_IO_ERROR",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::MalformedDigest => {
                "sha256 must be 64 lower-case hex characters; content addressing depends on it"
                    .to_string()
            }
            Self::UnknownAsset => "this asset has not been registered".to_string(),
            Self::TooLarge => "the asset is larger than this engine accepts".to_string(),
            Self::ChunkTooLarge => "the chunk is larger than this engine accepts".to_string(),
            Self::ChunkIndexOutOfRange => {
                "the chunk index is outside the declared chunk count".to_string()
            }
            Self::SessionMismatch => {
                "the chunk count or total size does not match the transfer in progress; \
                 restart the upload"
                    .to_string()
            }
            Self::ChecksumMismatch => {
                "the received bytes did not match the declared sha256, so the transfer was \
                 discarded; half an image decodes to something rather than failing, which is \
                 why this is never accepted"
                    .to_string()
            }
            Self::PathRefused(detail) => detail.clone(),
            Self::FetchRefused(detail) => detail.clone(),
            Self::StillReferenced(scenes) => format!(
                "still referenced by {}; releasing it would leave a hole in a loaded scene. \
                 Set force to release anyway.",
                scenes.join(", ")
            ),
            Self::Io(detail) => detail.clone(),
        }
    }
}

/// Whether a digest is a usable content address.
pub fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}

/// Cache path for a digest: two-character shard, then the digest.
///
/// The shard keeps directories to a workable size; a flat directory with a hundred
/// thousand entries is slow to list on every platform that matters.
pub fn content_path(cache_directory: &Path, sha256: &str) -> PathBuf {
    cache_directory
        .join("assets")
        .join(&sha256[..2])
        .join(sha256)
}

/// The engine's asset store.
pub struct AssetStore {
    cache_directory: PathBuf,
    roots: Vec<PathBuf>,
    max_upload_bytes: u64,
    max_chunk_bytes: u64,
    disk_budget_bytes: u64,
    allow_http_fetch: bool,
    http_allowlist: Vec<String>,

    records: BTreeMap<String, AssetRecord>,
    uploads: BTreeMap<String, UploadSession>,
    /// Bytes currently held in the content cache.
    cached_bytes: u64,
    pub uploads_completed: u64,
    pub checksum_failures: u64,
    pub deduplicated_uploads: u64,
}

impl AssetStore {
    pub fn new(config: &crate::config::AssetConfig) -> Self {
        Self {
            cache_directory: PathBuf::from(&config.cache_directory),
            roots: config.roots.iter().map(PathBuf::from).collect(),
            max_upload_bytes: config.max_upload_bytes,
            max_chunk_bytes: config.max_chunk_bytes,
            disk_budget_bytes: config.disk_cache_budget_bytes,
            allow_http_fetch: config.allow_http_fetch,
            http_allowlist: config.http_allowlist.clone(),
            records: BTreeMap::new(),
            uploads: BTreeMap::new(),
            cached_bytes: 0,
            uploads_completed: 0,
            checksum_failures: 0,
            deduplicated_uploads: 0,
        }
    }

    pub fn record(&self, asset_id: &str) -> Option<&AssetRecord> {
        self.records.get(asset_id)
    }

    pub fn records(&self) -> impl Iterator<Item = &AssetRecord> {
        self.records.values()
    }

    pub fn cached_bytes(&self) -> u64 {
        self.cached_bytes
    }

    pub fn ready_count(&self) -> usize {
        self.records.values().filter(|record| record.is_ready()).count()
    }

    pub fn failed_count(&self) -> usize {
        self.records
            .values()
            .filter(|record| record.fetch_state == AssetFetchState::Failed)
            .count()
    }

    pub fn upload_in_progress(&self, asset_id: &str) -> Option<&UploadSession> {
        self.uploads.get(asset_id)
    }

    /// Register an asset and say whether its bytes are already here.
    ///
    /// A registration is idempotent by digest: re-registering the same content is a no-op
    /// that reports `cached`, which is what makes republishing a scene cheap.
    pub fn register(
        &mut self,
        asset_id: &str,
        sha256: &str,
        mime_type: &str,
        size_bytes: u64,
        transport: AssetTransport,
        uri: &str,
        now_ms: u64,
    ) -> Result<AssetRecord, AssetRejection> {
        if !is_valid_sha256(sha256) {
            return Err(AssetRejection::MalformedDigest);
        }
        if size_bytes > self.max_upload_bytes {
            return Err(AssetRejection::TooLarge);
        }

        // Resolve the source *before* recording anything, so a refused path never appears
        // in the store as a pending asset.
        let mut cache_path: Option<String> = None;
        let mut state = AssetFetchState::Absent;

        match transport {
            AssetTransport::EngineLocal => {
                let resolved = crate::security::resolve_asset_path(uri, &self.roots)
                    .map_err(|rejection| AssetRejection::PathRefused(rejection.message().to_string()))?;
                cache_path = Some(resolved.to_string_lossy().to_string());
                state = AssetFetchState::Cached;
            }
            AssetTransport::Http => {
                if !self.allow_http_fetch {
                    return Err(AssetRejection::FetchRefused(
                        "this engine does not fetch assets over HTTP; set assets.allow-http-fetch \
                         and an allowlist, or upload the bytes"
                            .to_string(),
                    ));
                }
                let host = host_of(uri).ok_or_else(|| {
                    AssetRejection::FetchRefused(format!("\"{uri}\" is not a usable http(s) URL"))
                })?;
                if !self.http_allowlist.iter().any(|allowed| allowed == &host) {
                    return Err(AssetRejection::FetchRefused(format!(
                        "host \"{host}\" is not in assets.http-allowlist; an engine that fetches \
                         arbitrary URLs is a proxy"
                    )));
                }
                // Declared, not fetched: the fetch itself is not implemented, and saying
                // so beats reporting an asset as ready that never arrives.
                return Err(AssetRejection::FetchRefused(format!(
                    "host \"{host}\" is allowlisted but HTTP fetching is not implemented in this \
                     engine build; upload the bytes instead"
                )));
            }
            AssetTransport::Upload => {
                // Content addressing pays off here: if these exact bytes are already in
                // the cache, nothing needs to be transferred.
                let path = content_path(&self.cache_directory, sha256);
                if path.exists() {
                    self.deduplicated_uploads += 1;
                    cache_path = Some(path.to_string_lossy().to_string());
                    state = AssetFetchState::Cached;
                }
            }
            AssetTransport::SharedCache => {
                let path = content_path(&self.cache_directory, sha256);
                if path.exists() {
                    cache_path = Some(path.to_string_lossy().to_string());
                    state = AssetFetchState::Cached;
                } else {
                    return Err(AssetRejection::FetchRefused(
                        "the shared cache does not hold this content; upload the bytes".to_string(),
                    ));
                }
            }
        }

        let record = AssetRecord {
            asset_id: asset_id.to_string(),
            sha256: sha256.to_string(),
            mime_type: mime_type.to_string(),
            size_bytes,
            transport,
            fetch_state: state,
            cache_path,
            // Preserved across re-registration: a scene's references must not be lost
            // because its asset was republished.
            referenced_by: self
                .records
                .get(asset_id)
                .map(|existing| existing.referenced_by.clone())
                .unwrap_or_default(),
            last_error: None,
            last_used_ms: now_ms,
        };

        self.records.insert(asset_id.to_string(), record.clone());
        Ok(record)
    }

    /// Accept one chunk of an upload.
    ///
    /// Returns the session progress. The bytes are only published into the cache when
    /// every chunk has arrived *and* the assembled digest matches.
    pub fn accept_chunk(
        &mut self,
        asset_id: &str,
        sha256: &str,
        chunk_index: u32,
        chunk_count: u32,
        total_bytes: u64,
        data: &[u8],
        now_ms: u64,
    ) -> Result<UploadProgress, AssetRejection> {
        if !is_valid_sha256(sha256) {
            return Err(AssetRejection::MalformedDigest);
        }
        if !self.records.contains_key(asset_id) {
            return Err(AssetRejection::UnknownAsset);
        }
        if total_bytes > self.max_upload_bytes {
            return Err(AssetRejection::TooLarge);
        }
        if data.len() as u64 > self.max_chunk_bytes {
            return Err(AssetRejection::ChunkTooLarge);
        }
        if chunk_count == 0 || chunk_index >= chunk_count {
            return Err(AssetRejection::ChunkIndexOutOfRange);
        }

        let session = self
            .uploads
            .entry(asset_id.to_string())
            .or_insert_with(|| {
                UploadSession::new(
                    asset_id.to_string(),
                    sha256.to_string(),
                    chunk_count,
                    total_bytes,
                    now_ms,
                )
            });

        // A transfer whose shape changed mid-flight cannot be reassembled coherently.
        if session.chunk_count != chunk_count
            || session.total_bytes != total_bytes
            || session.sha256 != sha256
        {
            self.uploads.remove(asset_id);
            return Err(AssetRejection::SessionMismatch);
        }

        let slot = &mut session.chunks[chunk_index as usize];
        if let Some(existing) = slot {
            // A retransmitted chunk is acknowledged, not counted twice: the transport
            // deduplicates by messageId, but a client resuming may resend deliberately.
            if existing.len() == data.len() {
                let received_chunks = session.received_chunks();
                return Ok(UploadProgress {
                    asset_id: asset_id.to_string(),
                    received_chunks,
                    chunk_count,
                    received_bytes: session.received_bytes,
                    total_bytes,
                    complete: session.is_complete(),
                    checksum_mismatch: false,
                    missing_chunks: session.missing_chunks(),
                });
            }
            session.received_bytes = session.received_bytes.saturating_sub(existing.len() as u64);
        }
        *slot = Some(data.to_vec());
        session.received_bytes += data.len() as u64;

        if let Some(record) = self.records.get_mut(asset_id) {
            record.fetch_state = AssetFetchState::Fetching;
            record.last_used_ms = now_ms;
        }

        let session = self.uploads.get(asset_id).expect("inserted above");
        if !session.is_complete() {
            return Ok(UploadProgress {
                asset_id: asset_id.to_string(),
                received_chunks: session.received_chunks(),
                chunk_count,
                received_bytes: session.received_bytes,
                total_bytes,
                complete: false,
                checksum_mismatch: false,
                missing_chunks: session.missing_chunks(),
            });
        }

        // Complete. Verify before publishing: this is the last point at which corrupt
        // bytes can be stopped from reaching a render.
        let bytes = session.assemble();
        let digest = hex_digest(&bytes);
        if digest != sha256 {
            self.uploads.remove(asset_id);
            self.checksum_failures += 1;
            if let Some(record) = self.records.get_mut(asset_id) {
                record.fetch_state = AssetFetchState::Failed;
                record.last_error = Some(format!(
                    "checksum mismatch: declared {sha256}, received {digest}"
                ));
            }
            return Ok(UploadProgress {
                asset_id: asset_id.to_string(),
                received_chunks: chunk_count,
                chunk_count,
                received_bytes: bytes.len() as u64,
                total_bytes,
                complete: false,
                checksum_mismatch: true,
                missing_chunks: Vec::new(),
            });
        }

        let path = content_path(&self.cache_directory, sha256);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| AssetRejection::Io(format!("could not create the asset cache: {error}")))?;
        }
        // Written to a temporary file and renamed, so a crash mid-write cannot leave a
        // truncated file in a content-addressed cache — where its name would claim it was
        // verified.
        let temporary = path.with_extension("partial");
        std::fs::write(&temporary, &bytes)
            .map_err(|error| AssetRejection::Io(format!("could not write the asset: {error}")))?;
        std::fs::rename(&temporary, &path)
            .map_err(|error| AssetRejection::Io(format!("could not publish the asset: {error}")))?;

        self.uploads.remove(asset_id);
        self.uploads_completed += 1;
        self.cached_bytes += bytes.len() as u64;

        if let Some(record) = self.records.get_mut(asset_id) {
            record.fetch_state = AssetFetchState::Cached;
            record.cache_path = Some(path.to_string_lossy().to_string());
            record.size_bytes = bytes.len() as u64;
            record.last_error = None;
            record.last_used_ms = now_ms;
        }

        Ok(UploadProgress {
            asset_id: asset_id.to_string(),
            received_chunks: chunk_count,
            chunk_count,
            received_bytes: bytes.len() as u64,
            total_bytes,
            complete: true,
            checksum_mismatch: false,
            missing_chunks: Vec::new(),
        })
    }

    /// Re-verify an asset that is supposedly cached.
    ///
    /// Reads the file back and hashes it. Worth doing on demand rather than on every use:
    /// a file can be replaced or truncated after it was cached, and a content-addressed
    /// cache's whole promise is that the name matches the bytes.
    pub fn validate(&mut self, asset_id: &str) -> Result<AssetValidation, AssetRejection> {
        let record = self
            .records
            .get(asset_id)
            .ok_or(AssetRejection::UnknownAsset)?
            .clone();

        let Some(path) = record.cache_path.clone() else {
            return Ok(AssetValidation {
                asset_id: asset_id.to_string(),
                present: false,
                digest_matches: false,
                size_bytes: 0,
                message: "the asset has no bytes on this engine yet".to_string(),
            });
        };

        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                if let Some(record) = self.records.get_mut(asset_id) {
                    record.fetch_state = AssetFetchState::Failed;
                    record.last_error = Some(format!("could not read {path}: {error}"));
                }
                return Ok(AssetValidation {
                    asset_id: asset_id.to_string(),
                    present: false,
                    digest_matches: false,
                    size_bytes: 0,
                    message: format!("could not read {path}: {error}"),
                });
            }
        };

        let digest = hex_digest(&bytes);
        let matches = digest == record.sha256;

        if let Some(record) = self.records.get_mut(asset_id) {
            record.size_bytes = bytes.len() as u64;
            if matches {
                record.fetch_state = AssetFetchState::Cached;
                record.last_error = None;
            } else {
                // Deliberately marked failed: a scene must not render with content that
                // is not what it declared.
                record.fetch_state = AssetFetchState::Failed;
                record.last_error = Some(format!(
                    "on-disk content hashes to {digest}, not the declared {}",
                    record.sha256
                ));
            }
        }

        Ok(AssetValidation {
            asset_id: asset_id.to_string(),
            present: true,
            digest_matches: matches,
            size_bytes: bytes.len() as u64,
            message: if matches {
                "verified".to_string()
            } else {
                format!("content hashes to {digest}, not the declared {}", record.sha256)
            },
        })
    }

    /// Record that a scene needs these assets.
    ///
    /// Returns the ids that are not ready, which is what gates preparation: a scene that
    /// goes on air with a missing asset shows a hole.
    pub fn reference(&mut self, scene_id: &str, asset_ids: &[String], now_ms: u64) -> Vec<String> {
        let mut missing = Vec::new();
        for asset_id in asset_ids {
            match self.records.get_mut(asset_id) {
                Some(record) => {
                    if !record.referenced_by.iter().any(|id| id == scene_id) {
                        record.referenced_by.push(scene_id.to_string());
                    }
                    record.last_used_ms = now_ms;
                    if !record.is_ready() {
                        missing.push(asset_id.clone());
                    }
                }
                None => missing.push(asset_id.clone()),
            }
        }
        missing
    }

    /// Drop a scene's references. Called when a scene is unloaded.
    pub fn dereference_scene(&mut self, scene_id: &str) {
        for record in self.records.values_mut() {
            record.referenced_by.retain(|id| id != scene_id);
        }
    }

    /// Release assets. Refuses one still referenced unless forced.
    pub fn release(
        &mut self,
        asset_ids: &[String],
        force: bool,
    ) -> (Vec<String>, Vec<(String, AssetRejection)>) {
        let mut released = Vec::new();
        let mut refused = Vec::new();

        for asset_id in asset_ids {
            let Some(record) = self.records.get(asset_id) else {
                refused.push((asset_id.clone(), AssetRejection::UnknownAsset));
                continue;
            };

            if !record.referenced_by.is_empty() && !force {
                refused.push((
                    asset_id.clone(),
                    AssetRejection::StillReferenced(record.referenced_by.clone()),
                ));
                continue;
            }

            let sha256 = record.sha256.clone();
            let size = record.size_bytes;
            self.records.remove(asset_id);
            self.uploads.remove(asset_id);

            // The cached bytes are only removed when nothing else shares the digest. That
            // is the point of content addressing: two assets can be the same content.
            let still_needed = self
                .records
                .values()
                .any(|other| other.sha256 == sha256);
            if !still_needed {
                let path = content_path(&self.cache_directory, &sha256);
                if std::fs::remove_file(&path).is_ok() {
                    self.cached_bytes = self.cached_bytes.saturating_sub(size);
                }
            }

            released.push(asset_id.clone());
        }

        (released, refused)
    }

    /// Assets that could be evicted to get under the disk budget, coldest first.
    ///
    /// Reported rather than acted on: evicting an asset a scene on air is using would put
    /// a hole on screen, so the decision needs the reference counts, which are here.
    pub fn eviction_candidates(&self) -> Vec<String> {
        if self.disk_budget_bytes == 0 || self.cached_bytes <= self.disk_budget_bytes {
            return Vec::new();
        }

        let mut unreferenced: Vec<&AssetRecord> = self
            .records
            .values()
            .filter(|record| record.referenced_by.is_empty() && record.is_ready())
            .collect();
        unreferenced.sort_by_key(|record| record.last_used_ms);

        let mut over = self.cached_bytes.saturating_sub(self.disk_budget_bytes);
        let mut candidates = Vec::new();
        for record in unreferenced {
            if over == 0 {
                break;
            }
            over = over.saturating_sub(record.size_bytes);
            candidates.push(record.asset_id.clone());
        }
        candidates
    }

    /// Everything an operator needs to see about assets, for status.
    pub fn summary(&self) -> serde_json::Value {
        let in_progress: Vec<serde_json::Value> = self
            .uploads
            .values()
            .map(|session| {
                serde_json::json!({
                    "assetId": session.asset_id,
                    "receivedChunks": session.received_chunks(),
                    "chunkCount": session.chunk_count,
                    "receivedBytes": session.received_bytes,
                    "totalBytes": session.total_bytes,
                })
            })
            .collect();

        serde_json::json!({
            "registeredAssets": self.records.len(),
            "readyAssets": self.ready_count(),
            "failedAssets": self.failed_count(),
            "diskBytes": self.cached_bytes,
            "diskBudgetBytes": self.disk_budget_bytes,
            "uploadsInProgress": in_progress,
            "uploadsCompleted": self.uploads_completed,
            "checksumFailures": self.checksum_failures,
            "deduplicatedUploads": self.deduplicated_uploads,
            "evictionCandidates": self.eviction_candidates(),
        })
    }

    /// Asset ids a scene document declares.
    pub fn declared_asset_ids(scene: &serde_json::Value) -> Vec<String> {
        scene
            .get("assets")
            .and_then(serde_json::Value::as_array)
            .map(|assets| {
                assets
                    .iter()
                    .filter_map(|asset| {
                        asset
                            .get("assetId")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                    })
                    .collect::<BTreeSet<String>>()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone)]
pub struct UploadProgress {
    pub asset_id: String,
    pub received_chunks: u32,
    pub chunk_count: u32,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub complete: bool,
    pub checksum_mismatch: bool,
    pub missing_chunks: Vec<u32>,
}

impl UploadProgress {
    pub fn to_payload(&self) -> serde_json::Value {
        serde_json::json!({
            "assetId": self.asset_id,
            "receivedChunks": self.received_chunks,
            "chunkCount": self.chunk_count,
            "receivedBytes": self.received_bytes,
            "totalBytes": self.total_bytes,
            "complete": self.complete,
            "checksumMismatch": self.checksum_mismatch,
            // Named explicitly so a resuming client sends exactly what is missing rather
            // than starting again.
            "missingChunks": self.missing_chunks,
        })
    }
}

#[derive(Debug, Clone)]
pub struct AssetValidation {
    pub asset_id: String,
    pub present: bool,
    pub digest_matches: bool,
    pub size_bytes: u64,
    pub message: String,
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Host of an http(s) URL, without pulling in a URL parser.
fn host_of(uri: &str) -> Option<String> {
    let rest = uri
        .strip_prefix("https://")
        .or_else(|| uri.strip_prefix("http://"))?;
    let host = rest.split('/').next()?;
    if host.is_empty() {
        return None;
    }
    // Strip any credentials and port: the allowlist is about hosts.
    let host = host.rsplit('@').next().unwrap_or(host);
    Some(host.split(':').next().unwrap_or(host).to_ascii_lowercase())
}
