//! Publishing an authored document to an engine (build plan 5.10).
//!
//! The Editor publishes a document as one verified package, through the route
//! the engine's own declaration negotiates: by local path with no asset bytes
//! to a co-located engine, chunked with only the missing bytes to one that is
//! not. Nothing here names a locality, holds a control-plane client or touches
//! a socket or a package directly: the engine is asked on the address it is
//! about to be published to, and `gx_asset_plane::publish_as_package` does the
//! reading, the writing and the removal (boundary rules R2, R6, R9).
//!
//! This is the one function the Editor shell's `cmd_publish` and the
//! conformance suite both call, so what the harness proves is what the shell
//! does (invariants 27, 60).

use std::net::SocketAddr;
use std::path::Path;

use gx_asset_plane::package::{PackageError, PackageSource};
use gx_asset_plane::{
    publish_as_package, AssetHandoff, AssetStore, AssetStoreError, AssetTransferClientError,
    DocumentPublishError, PackagePublishError, PublishClientError, PublishRefusal, PublishReply,
};
use gx_contracts::package::package_path_components;
use gx_contracts::scene::SceneDocument;
use gx_contracts::{ContentHash, Refusal, Revision, TakeId};

/// The largest asset the Editor reads back to find out why a cache entry no
/// longer verifies: the same limit the engine's package route enforces.
const MOST_CACHED_BYTES: u64 = gx_asset_plane::package::MAX_PACKAGE_BYTES;

/// A published revision, and how it reached the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub take_id: TakeId,
    pub revision: Revision,
    /// The content hash every cue and take of this revision must pin.
    pub content_hash: ContentHash,
    /// The route the engine's declaration negotiated.
    pub handoff: AssetHandoff,
    /// Asset bytes this publisher sent: none by path, the missing difference
    /// over a LAN.
    pub transferred_bytes: u64,
}

/// Why a publication did not produce a revision. Each is distinct from the
/// others all the way to the web layer (invariants 17, 59): an engine that
/// cannot be reached is not one that refused, and a refusal is not a crash.
#[derive(Debug, Clone, PartialEq)]
pub enum PublishFailure {
    /// The endpoint text is not a socket address. Nothing was opened.
    InvalidEndpoint { endpoint: String },
    /// The engine could not be reached at all.
    Unreachable { endpoint: String, detail: String },
    /// The document could not be packaged, so nothing was sent: an asset
    /// with no content hash yet, a cache entry that is missing or no longer
    /// matches its name, a package that failed its own verification.
    NotSent(Refusal),
    /// The Editor's own per-user asset cache could not be read. That is the
    /// cache's fault, not the engine's.
    AssetCache { detail: String },
    /// The engine understood the request and declined it, by name.
    EngineRefused(PublishRefusal),
    /// The engine's transfer dialect refused a chunk or a hash, by name.
    TransferRefused(Refusal),
    /// The package could not be written into the package folder.
    WritePackage { path: String, detail: String },
    /// A reply arrived that is not a reply, or the engine issued a revision
    /// for different content than was sent.
    Protocol { detail: String },
}

impl std::fmt::Display for PublishFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEndpoint { endpoint } => {
                write!(f, "{endpoint} is not a host:port address")
            }
            Self::Unreachable { endpoint, detail } => {
                write!(f, "cannot reach the asset plane at {endpoint}: {detail}")
            }
            Self::NotSent(refusal) => write!(f, "nothing was sent: {refusal}"),
            Self::AssetCache { detail } => write!(f, "asset cache unavailable: {detail}"),
            Self::EngineRefused(refusal) => write!(f, "publication refused: {refusal:?}"),
            Self::TransferRefused(refusal) => write!(f, "asset transfer refused: {refusal}"),
            Self::WritePackage { path, detail } => {
                write!(f, "cannot write the package {path}: {detail}")
            }
            Self::Protocol { detail } => write!(f, "asset plane protocol failed: {detail}"),
        }
    }
}

impl std::error::Error for PublishFailure {}

/// The package sources of `scene`: one verified file in the Editor's asset
/// cache for each asset it declares, at the path the scene's library gives it.
///
/// Every file is re-hashed against its name before it is offered, so a cache
/// entry that no longer matches its address refuses the publication by name
/// before anything is written or sent (invariants 28, 29). An asset with no
/// content hash yet, still importing, cannot be verified by the engine and is
/// refused before any file or socket exists. Only verified cache files are
/// sources: the project folder is never read.
pub fn package_sources(
    scene: &SceneDocument,
    store: &AssetStore,
) -> Result<Vec<PackageSource>, PublishFailure> {
    let mut sources: Vec<PackageSource> = Vec::new();
    let mut seen = Vec::new();
    for item in &scene.assets {
        let Some(hash) = &item.checksum else {
            return Err(PublishFailure::NotSent(Refusal::PackageAssetNotPackaged {
                asset_id: item.asset_id.clone(),
                path: item.path.clone(),
            }));
        };
        // One source for each package path: the writer refuses a repeat.
        let key = package_path_components(&item.path).map_err(PublishFailure::NotSent)?;
        if seen.contains(&key) {
            continue;
        }
        match store.contains(hash) {
            Ok(true) => {}
            // Not verified: read it back to say whether it is missing or
            // altered. A read that fails some other way is the cache's.
            Ok(false) => {
                return Err(match store.read_verified(hash, MOST_CACHED_BYTES) {
                    Err(error) => cache_failure(error, hash),
                    // It verified on this read: the entry was repaired in the
                    // meantime. Offer it.
                    Ok(_) => {
                        seen.push(key);
                        sources.push(PackageSource {
                            path: item.path.clone(),
                            source: store.cache_path(hash),
                        });
                        continue;
                    }
                });
            }
            Err(error) => return Err(cache_failure(error, hash)),
        }
        seen.push(key);
        sources.push(PackageSource {
            path: item.path.clone(),
            source: store.cache_path(hash),
        });
    }
    Ok(sources)
}

/// A cache read that failed: a missing or altered entry keeps its name, any
/// other failure is the cache's own (never the engine's store).
fn cache_failure(error: AssetStoreError, hash: &ContentHash) -> PublishFailure {
    match error.into_refusal(hash) {
        Refusal::AssetStoreFailed { detail, .. } => PublishFailure::AssetCache {
            detail: format!("{hash}: {detail}"),
        },
        other => PublishFailure::NotSent(other),
    }
}

/// Publish `scene` to the engine's asset plane at `endpoint` as one package
/// written into `directory`, and report the revision it became.
///
/// `scene` is the caller's own clone of the document: only that clone is
/// pinned to the revision a package needs (the engine issues its own revision
/// and the content hash leaves the pin out), so the workspace document is
/// untouched and nothing here is an Editor command. The hash the engine issues
/// is compared with the hash of what was packaged: a mismatch means another
/// document reached the engine, named in a Protocol failure that says not to
/// take that revision.
pub fn publish_document(
    endpoint: &str,
    mut scene: SceneDocument,
    sources: &[PackageSource],
    directory: &Path,
) -> Result<Published, PublishFailure> {
    let address: SocketAddr = endpoint
        .parse()
        .map_err(|_| PublishFailure::InvalidEndpoint {
            endpoint: endpoint.to_owned(),
        })?;
    scene.revision.get_or_insert(Revision(1));
    let expected = scene.content_hash();
    let unreachable = |source: &std::io::Error| PublishFailure::Unreachable {
        endpoint: endpoint.to_owned(),
        detail: source.to_string(),
    };
    let done =
        publish_as_package(address, directory, &scene, sources).map_err(|error| match error {
            DocumentPublishError::Locality(PublishClientError::Connect(source)) => {
                unreachable(&source)
            }
            DocumentPublishError::Locality(other) => PublishFailure::Protocol {
                detail: other.to_string(),
            },
            DocumentPublishError::LocalityRefused(refusal) => {
                PublishFailure::EngineRefused(refusal)
            }
            DocumentPublishError::Write(PackageError::Refused(refusal)) => {
                PublishFailure::NotSent(refusal)
            }
            DocumentPublishError::Write(PackageError::Open { path, source }) => {
                PublishFailure::WritePackage {
                    path: path.display().to_string(),
                    detail: source.to_string(),
                }
            }
            DocumentPublishError::Write(other) => PublishFailure::WritePackage {
                path: directory.display().to_string(),
                detail: other.to_string(),
            },
            DocumentPublishError::Publish(PackagePublishError::Package(refusal)) => {
                PublishFailure::NotSent(refusal)
            }
            DocumentPublishError::Publish(PackagePublishError::Transfer(
                AssetTransferClientError::Connect(source),
            )) => unreachable(&source),
            DocumentPublishError::Publish(PackagePublishError::Transfer(
                AssetTransferClientError::Refused(cause),
            )) => PublishFailure::TransferRefused(cause),
            DocumentPublishError::Publish(PackagePublishError::Transfer(other)) => {
                PublishFailure::Protocol {
                    detail: other.to_string(),
                }
            }
            DocumentPublishError::Publish(PackagePublishError::Publish(
                PublishClientError::Connect(source),
            )) => unreachable(&source),
            DocumentPublishError::Publish(PackagePublishError::Publish(other)) => {
                PublishFailure::Protocol {
                    detail: other.to_string(),
                }
            }
        })?;
    match done.publication.reply {
        PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } => {
            if content_hash != expected {
                return Err(PublishFailure::Protocol {
                    detail: format!(
                        "the engine issued revision {} of {take_id} for content {content_hash}, but the package held {expected}; do not take that revision",
                        revision.0
                    ),
                });
            }
            Ok(Published {
                take_id,
                revision,
                content_hash,
                handoff: done.publication.handoff,
                transferred_bytes: done.publication.transferred_bytes,
            })
        }
        PublishReply::Refused(refusal) => Err(PublishFailure::EngineRefused(refusal)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::scene::{new_scene, AssetKind, AssetLibraryItem};
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    fn scratch() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gx-editor-publish-{}-{}",
            std::process::id(),
            UNIQUE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn item(id: &str, path: &str, hash: Option<ContentHash>) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: id.into(),
            name: id.into(),
            kind: AssetKind::Image,
            path: path.into(),
            checksum: hash,
            mime_type: None,
            size_bytes: None,
            status: None,
            provenance: Default::default(),
        }
    }

    fn scene_with(items: Vec<AssetLibraryItem>) -> SceneDocument {
        let mut scene = new_scene(
            "editor/publish",
            "Publish",
            gx_contracts::color::WorkingColorSpace::LinearSrgb,
        );
        scene.assets = items;
        scene
    }

    #[test]
    fn an_asset_with_no_content_hash_is_refused_before_anything_exists() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let scene = scene_with(vec![item("pending", "images/pending.png", None)]);
        let refused = package_sources(&scene, &store).unwrap_err();
        assert!(
            matches!(
                &refused,
                PublishFailure::NotSent(Refusal::PackageAssetNotPackaged { asset_id, path })
                    if asset_id == "pending" && path == "images/pending.png"
            ),
            "{refused:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_cache_entry_that_is_missing_or_altered_refuses_by_name() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let bytes = b"cached image bytes".to_vec();
        let hash = gx_asset_plane::content_hash(&bytes);
        let scene = scene_with(vec![item("img", "images/img.png", Some(hash.clone()))]);

        let missing = package_sources(&scene, &store).unwrap_err();
        assert!(
            matches!(&missing, PublishFailure::NotSent(Refusal::AssetMissing { hash: named }) if *named == hash),
            "{missing:?}"
        );

        store.promote_verified(&hash, &bytes).unwrap();
        let sources = package_sources(&scene, &store).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "images/img.png");
        assert_eq!(sources[0].source, store.cache_path(&hash));

        let mut altered = bytes.clone();
        altered[0] ^= 0x01;
        std::fs::write(store.cache_path(&hash), &altered).unwrap();
        let changed = package_sources(&scene, &store).unwrap_err();
        assert!(
            matches!(&changed, PublishFailure::NotSent(Refusal::AssetHashMismatch { expected, .. }) if *expected == hash),
            "{changed:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn two_assets_at_one_package_path_are_one_source() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let bytes = b"shared bytes".to_vec();
        let hash = gx_asset_plane::content_hash(&bytes);
        store.promote_verified(&hash, &bytes).unwrap();
        let scene = scene_with(vec![
            item("a", "images/shared.png", Some(hash.clone())),
            item("b", "images/shared.png", Some(hash)),
        ]);
        assert_eq!(package_sources(&scene, &store).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_endpoint_that_is_not_an_address_opens_nothing() {
        let root = scratch();
        let failed = publish_document(
            "not-an-address",
            scene_with(vec![]),
            &[],
            &root.join("outbox"),
        )
        .unwrap_err();
        assert!(
            matches!(failed, PublishFailure::InvalidEndpoint { .. }),
            "{failed:?}"
        );
        assert!(!root.join("outbox").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_engine_nothing_listens_for_is_unreachable_not_refused() {
        let root = scratch();
        let port = {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.local_addr().unwrap().port()
        };
        let failed = publish_document(
            &format!("127.0.0.1:{port}"),
            scene_with(vec![]),
            &[],
            &root.join("outbox"),
        )
        .unwrap_err();
        assert!(
            matches!(failed, PublishFailure::Unreachable { .. }),
            "{failed:?}"
        );
        assert!(
            !root.join("outbox").exists(),
            "nothing written before the read"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    struct IssuingPeer {
        issue: ContentHash,
    }

    impl gx_asset_plane::AssetPublishPeer for IssuingPeer {
        fn locality(&self) -> gx_contracts::Locality {
            gx_contracts::Locality::Lan
        }
        fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
            PublishReply::Published {
                take_id: TakeId(scene.id),
                revision: Revision(7),
                content_hash: self.issue.clone(),
            }
        }
    }

    fn serve(peer: IssuingPeer) -> std::net::SocketAddr {
        let server = gx_asset_plane::AssetPublishServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            std::sync::Arc::new(std::sync::Mutex::new(peer)),
        )
        .unwrap();
        let address = server.local_addr().unwrap();
        server.serve_in_background();
        address
    }

    #[test]
    fn a_revision_for_other_content_is_a_protocol_failure_that_says_not_to_take_it() {
        let root = scratch();
        let scene = scene_with(vec![]);
        let packaged = {
            let mut pinned = scene.clone();
            pinned.revision.get_or_insert(Revision(1));
            pinned.content_hash()
        };
        let other = gx_asset_plane::content_hash(b"another document");
        let address = serve(IssuingPeer {
            issue: other.clone(),
        });
        let failed = publish_document(
            &address.to_string(),
            scene.clone(),
            &[],
            &root.join("outbox"),
        )
        .unwrap_err();
        match &failed {
            PublishFailure::Protocol { detail } => {
                assert!(detail.contains(&other.0), "{detail}");
                assert!(detail.contains(&packaged.0), "{detail}");
                assert!(detail.contains("do not take"), "{detail}");
            }
            other => panic!("{other:?}"),
        }
        // The same engine issuing the hash of what was packaged is accepted,
        // by the route its declaration negotiated.
        let honest = serve(IssuingPeer { issue: packaged });
        let published =
            publish_document(&honest.to_string(), scene, &[], &root.join("outbox")).unwrap();
        assert_eq!(published.handoff, AssetHandoff::ChunkedUpload);
        assert_eq!(published.transferred_bytes, 0);
        assert_eq!(published.revision, Revision(7));
        std::fs::remove_dir_all(root).unwrap();
    }
}
