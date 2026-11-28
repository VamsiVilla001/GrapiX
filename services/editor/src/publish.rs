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
use gx_contracts::font::{FontDefinition, FontLoadStatus, FontSource};
use gx_contracts::package::package_path_components;
use gx_contracts::scene::{AssetKind, SceneDocument, SceneObject};
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
        verify_cached_asset(store, hash).map_err(|refusal| cache_failure(refusal, hash))?;
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
fn cache_failure(refusal: Refusal, hash: &ContentHash) -> PublishFailure {
    match refusal {
        Refusal::AssetStoreFailed { detail, .. } => PublishFailure::AssetCache {
            detail: format!("{hash}: {detail}"),
        },
        other => PublishFailure::NotSent(other),
    }
}

fn verify_cached_asset(store: &AssetStore, hash: &ContentHash) -> Result<(), Refusal> {
    let check = || -> Result<(), AssetStoreError> {
        if !hash.is_sha256() || !store.contains(hash)? {
            // Report the named reason, and accept an entry repaired since contains.
            store.read_verified(hash, MOST_CACHED_BYTES)?;
        }
        Ok(())
    };
    check().map_err(|error| error.into_refusal(hash))
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GraphicBlocker {
    pub code: String,
    pub subject: String,
    pub message: String,
}

impl GraphicBlocker {
    fn refusal(subject: &str, refusal: Refusal) -> Self {
        Self {
            code: refusal.code_name().to_owned(),
            subject: subject.to_owned(),
            message: refusal.to_string(),
        }
    }
}

/// Counts for the Start and Publish surfaces, from the same preflight as Check graphic.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicReadiness {
    pub fonts_missing: usize,
    pub binding_issues: usize,
    /// Asset preflight failures, including missing, unpackageable and altered bytes.
    pub assets_missing: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicPreflight {
    pub blockers: Vec<GraphicBlocker>,
    pub readiness: GraphicReadiness,
}

pub fn graphic_blockers(scene: &SceneDocument, store: &AssetStore) -> Vec<GraphicBlocker> {
    graphic_preflight(scene, store).blockers
}

/// Check what is decidable from the Editor draft and its local asset cache.
pub fn graphic_preflight(scene: &SceneDocument, store: &AssetStore) -> GraphicPreflight {
    let mut blockers = Vec::new();
    let mut checked = std::collections::HashSet::new();
    let mut verified = std::collections::HashMap::new();
    for asset in &scene.assets {
        let check = || {
            let hash = asset
                .checksum
                .as_ref()
                .ok_or_else(|| Refusal::PackageAssetNotPackaged {
                    asset_id: asset.asset_id.clone(),
                    path: asset.path.clone(),
                })?;
            package_path_components(&asset.path)?;
            verified
                .entry(hash)
                .or_insert_with(|| verify_cached_asset(store, hash))
                .clone()
        };
        let mut check = check;
        if let Err(refusal) = check() {
            blockers.push(GraphicBlocker::refusal(&asset.asset_id, refusal));
        }
    }
    let assets_missing = blockers.len();
    let mut check_font = |font_id: &str, definition: Option<&FontDefinition>| {
        if !checked.insert(font_id.to_owned()) {
            return;
        }
        let ready = definition.is_some_and(|font| {
            font.enabled && font.status == FontLoadStatus::Ready && !font.faces.is_empty()
                && font.faces.iter().all(|face| {
                    face.status.is_none_or(|status| status == FontLoadStatus::Ready)
                        && matches!(&face.source, FontSource::File { asset_id, .. }
                            if scene.asset(asset_id).is_some_and(|asset| asset.kind == AssetKind::Font && asset.checksum.is_some()))
                })
        });
        if !ready {
            blockers.push(GraphicBlocker::refusal(
                font_id,
                Refusal::FontMissing {
                    font_id: font_id.to_owned(),
                },
            ));
        }
    };
    for object in &scene.objects {
        let SceneObject::Text(text) = object else {
            continue;
        };
        let font = scene.font(&text.font_id);
        check_font(&text.font_id, font);
        if let Some(font) = font {
            for family in &font.fallback_families {
                let fallback = scene
                    .fonts
                    .iter()
                    .find(|font| font.enabled && font.family == *family);
                check_font(
                    fallback.map_or(family.as_str(), |font| font.font_id.as_str()),
                    fallback,
                );
            }
        }
    }
    let fonts_missing = blockers.len() - assets_missing;
    let issues = gx_contracts::bindings::binding_issues(scene);
    let binding_issues = issues.len();
    blockers.extend(
        issues.into_iter()
            .map(|issue| GraphicBlocker {
                code: "bindingInvalid".into(),
                subject: format!("{}.{}", issue.object_id, issue.property),
                message: format!("{} ({})", issue.detail, issue.path),
            }),
    );
    if let Some(label) = &scene.scene_label {
        if let Err(refusal) = gx_contracts::ids::parse_scene_label(label) {
            blockers.push(GraphicBlocker::refusal(label, refusal));
        }
    }
    GraphicPreflight {
        blockers,
        readiness: GraphicReadiness { fonts_missing, binding_issues, assets_missing },
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
    // 2.24: an engine started with a token verifies a credential on the asset plane. A process that
    // holds one for it (`GX_ASSET_CREDENTIAL`, made with the engine's secret, Author scope) sends it.
    let _credential = gx_asset_plane::auth::enter_from_environment();
    let expected = scene.content_hash();
    let unreachable = |source: &std::io::Error| PublishFailure::Unreachable {
        endpoint: endpoint.to_owned(),
        detail: source.to_string(),
    };
    let done =
        publish_as_package(address, directory, &scene, sources).map_err(|error| match error {
            // 2.24: a reset or an end of stream is the connection failing, not the engine
            // answering wrongly: it reads as unreachable, never as a protocol failure.
            DocumentPublishError::Locality(
                PublishClientError::Connect(source) | PublishClientError::Transport(source),
            ) => unreachable(&source),
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
                AssetTransferClientError::Connect(source)
                | AssetTransferClientError::Transport(source),
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
                PublishClientError::Connect(source) | PublishClientError::Transport(source),
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
            color_space: None,
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

    // --- Check graphic: the named blockers of the Editor's draft (topic 16) ----------------------------------------------------------

    use gx_contracts::font::{
        EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource, FontStyle,
    };

    fn font_asset(id: &str, hash: Option<ContentHash>) -> AssetLibraryItem {
        AssetLibraryItem { kind: AssetKind::Font, ..item(id, &format!("fonts/{id}.woff2"), hash) }
    }

    fn font(id: &str, status: FontLoadStatus, face_asset: Option<&str>) -> FontDefinition {
        FontDefinition {
            font_id: id.into(),
            family: id.into(),
            display_name: id.into(),
            faces: face_asset
                .map(|asset| {
                    vec![FontFaceDefinition {
                        face_id: format!("{id}-regular"),
                        family: id.into(),
                        weight: 400,
                        style: FontStyle::Normal,
                        stretch: None,
                        unicode_range: None,
                        source: FontSource::File { asset_id: asset.into(), format: FontFormat::Woff2, original_url: None, stylesheet_url: None },
                        status: None,
                        error_message: None,
                    }]
                })
                .unwrap_or_default(),
            fallback_families: Vec::new(),
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL".into()),
            enabled: true,
            source_label: None,
            status,
            error_message: None,
        }
    }

    fn with_text(font: FontDefinition, assets: Vec<AssetLibraryItem>) -> (SceneDocument, String) {
        let mut scene = scene_with(assets);
        scene.fonts.push(font);
        let id = gx_contracts::authoring::create_object(&mut scene, "text", "Name").unwrap();
        (scene, id)
    }

    fn codes(blockers: &[GraphicBlocker]) -> Vec<(&str, &str)> {
        blockers.iter().map(|b| (b.code.as_str(), b.subject.as_str())).collect()
    }

    #[test]
    fn readiness_counts_come_from_the_same_preflight_as_named_blockers() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let (mut scene, _) = with_text(
            font("anybody", FontLoadStatus::Missing, None),
            vec![item("pending", "images/pending.png", None)],
        );
        scene.scene_label = Some("bad label!".into());

        let report = graphic_preflight(&scene, &store);
        assert_eq!(report.blockers, graphic_blockers(&scene, &store));
        assert_eq!(report.blockers.len(), 3);
        assert_eq!(report.readiness, GraphicReadiness {
            fonts_missing: 1,
            binding_issues: 0,
            assets_missing: 1,
        });
        assert_eq!(
            graphic_preflight(&scene_with(Vec::new()), &store).readiness,
            GraphicReadiness::default(),
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_graphic_with_nothing_wrong_has_no_blockers() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let bytes = b"font bytes".to_vec();
        let hash = gx_asset_plane::content_hash(&bytes);
        store.promote_verified(&hash, &bytes).unwrap();
        let (scene, _) = with_text(font("inter", FontLoadStatus::Ready, Some("inter-file")), vec![font_asset("inter-file", Some(hash))]);
        assert_eq!(graphic_blockers(&scene, &store), Vec::new());
        assert_eq!(graphic_blockers(&scene_with(Vec::new()), &store), Vec::new());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_asset_that_is_unpackaged_missing_or_altered_is_named() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let bytes = b"cached image bytes".to_vec();
        let hash = gx_asset_plane::content_hash(&bytes);
        let other = gx_asset_plane::content_hash(b"never cached");
        let scene = scene_with(vec![
            item("pending", "images/pending.png", None),
            item("lost", "images/lost.png", Some(other)),
            item("img", "images/img.png", Some(hash.clone())),
        ]);
        store.promote_verified(&hash, &bytes).unwrap();
        assert_eq!(
            codes(&graphic_blockers(&scene, &store)),
            vec![("packageAssetNotPackaged", "pending"), ("assetMissing", "lost")]
        );
        let mut altered = bytes.clone();
        altered[0] ^= 0x01;
        std::fs::write(store.cache_path(&hash), &altered).unwrap();
        assert!(codes(&graphic_blockers(&scene, &store)).contains(&("assetHashMismatch", "img")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_font_that_cannot_be_used_is_a_blocker_by_name_and_is_never_replaced() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        // Declared but not ready, with no face: the graphic would draw in another typeface.
        let (scene, _) = with_text(font("anybody", FontLoadStatus::Missing, None), Vec::new());
        assert_eq!(codes(&graphic_blockers(&scene, &store)), vec![("fontMissing", "anybody")]);
        // Ready, but its face points at an asset the scene does not hold.
        let (unpackaged, _) = with_text(font("inter", FontLoadStatus::Ready, Some("not-there")), Vec::new());
        assert_eq!(codes(&graphic_blockers(&unpackaged, &store)), vec![("fontMissing", "inter")]);
        // Ready, packaged by a file asset that has no content hash.
        let (nohash, _) = with_text(font("inter", FontLoadStatus::Ready, Some("inter-file")), vec![font_asset("inter-file", None)]);
        assert!(codes(&graphic_blockers(&nohash, &store)).contains(&("fontMissing", "inter")));
        // A font nothing uses is not a blocker.
        let mut unused = scene_with(Vec::new());
        unused.fonts.push(font("unused", FontLoadStatus::Missing, None));
        assert_eq!(graphic_blockers(&unused, &store), Vec::new());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_font_used_twice_is_named_once() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let (mut scene, _) = with_text(font("anybody", FontLoadStatus::Missing, None), Vec::new());
        gx_contracts::authoring::create_object(&mut scene, "text", "Role").unwrap();
        assert_eq!(codes(&graphic_blockers(&scene, &store)), vec![("fontMissing", "anybody")]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_binding_to_data_the_graphic_does_not_hold_is_named_with_its_path() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let bytes = b"font bytes".to_vec();
        let hash = gx_asset_plane::content_hash(&bytes);
        store.promote_verified(&hash, &bytes).unwrap();
        let (mut scene, id) = with_text(font("inter", FontLoadStatus::Ready, Some("inter-file")), vec![font_asset("inter-file", Some(hash))]);
        scene.data_context.insert("title".into(), serde_json::json!("Hello"));
        gx_contracts::bindings::set_binding(&mut scene, &id, "text", Some("title")).unwrap();
        assert_eq!(graphic_blockers(&scene, &store), Vec::new());
        scene.data_context.clear();
        let report = graphic_preflight(&scene, &store);
        assert_eq!(report.readiness.binding_issues, 1);
        let blockers = report.blockers;
        assert_eq!(blockers.len(), 1, "{blockers:?}");
        assert_eq!(blockers[0].code, "bindingInvalid");
        assert_eq!(blockers[0].subject, format!("{id}.text"));
        assert!(blockers[0].message.contains("title"), "{}", blockers[0].message);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_scene_id_that_is_not_valid_is_a_blocker_and_no_cue_id_is_asked_for() {
        let root = scratch();
        let store = AssetStore::at_root(root.join("cache"));
        let mut scene = scene_with(Vec::new());
        scene.scene_label = Some("bad label!".into());
        let blockers = graphic_blockers(&scene, &store);
        assert_eq!(blockers.len(), 1, "{blockers:?}");
        assert_eq!((blockers[0].code.as_str(), blockers[0].subject.as_str()), ("sceneLabelInvalid", "bad label!"));
        scene.scene_label = Some("12".into());
        assert_eq!(graphic_blockers(&scene, &store), Vec::new());
        scene.scene_label = None;
        assert_eq!(graphic_blockers(&scene, &store), Vec::new());
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

    /// 2.24: an engine that takes the connection and drops it (a reset, an end of stream) is a
    /// connection that failed, not one that answered wrongly.
    #[test]
    fn a_connection_that_is_cut_is_unreachable_not_a_protocol_failure() {
        let root = scratch();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                drop(stream);
            }
        });
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
