//! L0 asset handoff by local path, and the one choice between it and the
//! chunked upload (build plan 5.8, ADR-001).
//!
//! ADR-001 gives the asset plane two transports: a co-located (L0) engine is
//! handed a package by local filesystem path; a LAN (L1) engine receives the
//! content-addressed chunked upload of 5.3/5.9. Which one a publisher uses is
//! decided here, from the locality the engine declared in its capability
//! exchange, and nowhere else (boundary rule R9).
//!
//! Both routes end in the same place. The engine reads and verifies the
//! package once, re-hashes every declared asset against the scene's content
//! hash, and hands the bytes to the same `accept_verified_asset` and
//! `publish_scene` the chunked route uses. It keeps no path: nothing is read
//! from disk again at take time, so a file changed after publication cannot
//! reach Program (5.9's rule, kept).

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf, Prefix};

use gx_contracts::package::package_path_components;
use gx_contracts::scene::SceneDocument;
use gx_contracts::{Locality, Refusal};

use crate::package::{read_package, PackageError, VerifiedPackage};
use crate::preflight::{publish_assets, AssetBytes, AssetTransferClientError};
use crate::publish::{publish_package_path, publish_scene, PublishClientError, PublishReply};
use crate::store::content_hash;

/// How a publisher hands a package's assets to an engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetHandoff {
    /// L0: the engine is told the package's local path and reads it itself.
    LocalPath,
    /// L1: the publisher reads the package and uploads only the bytes the
    /// engine does not hold (5.3, 5.9).
    ChunkedUpload,
}

/// The one negotiation from a declared locality to an asset handoff (5.8).
///
/// The asset plane's counterpart of `gx_media_plane::negotiate`: a publisher
/// passes the locality the engine declared and gets the handoff, so no
/// publisher branches on locality itself (R9).
pub fn handoff_for(locality: Locality) -> AssetHandoff {
    match locality {
        Locality::CoLocated => AssetHandoff::LocalPath,
        Locality::Lan => AssetHandoff::ChunkedUpload,
    }
}

/// A verified package's scene and the bytes of every asset it declares.
#[derive(Debug, Clone, PartialEq)]
pub struct PackagedScene {
    pub scene: SceneDocument,
    /// One entry per declared content hash, each re-hashed against it.
    pub assets: Vec<AssetBytes>,
}

/// Take a verified package's scene and its declared assets' bytes.
///
/// `read_package` has already checked every member against the manifest;
/// this checks every declared asset against the content hash the scene
/// declares for it, so a package whose manifest is self-consistent but whose
/// scene names other bytes is refused `AssetHashMismatch`, never prepared.
/// An asset with no content hash yet (still importing) declares no bytes.
pub fn packaged_scene(package: VerifiedPackage) -> Result<PackagedScene, Refusal> {
    let mut assets: Vec<AssetBytes> = Vec::new();
    for item in &package.scene.assets {
        let Some(hash) = &item.checksum else { continue };
        if assets.iter().any(|asset| &asset.hash == hash) {
            continue;
        }
        let wanted = package_path_components(&item.path)?;
        let bytes = package
            .files
            .iter()
            .find(|(path, _)| package_path_components(path).is_ok_and(|found| found == wanted))
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| Refusal::PackageAssetNotPackaged {
                asset_id: item.asset_id.clone(),
                path: item.path.clone(),
            })?;
        let actual = content_hash(bytes);
        if actual != *hash {
            return Err(Refusal::AssetHashMismatch {
                expected: hash.clone(),
                actual,
            });
        }
        assets.push(AssetBytes {
            hash: hash.clone(),
            bytes: bytes.clone(),
        });
    }
    Ok(PackagedScene {
        scene: package.scene,
        assets,
    })
}

/// Open a package offered by local path, engine side (5.8).
///
/// `directory` is the package directory the engine was started with, as an
/// absolute path; `None` means the engine reads no path at all. `path` is the
/// publisher's path, absolute or relative to `directory`. It must resolve,
/// after links are followed, inside `directory`; then the package is read and
/// every member and declared asset re-hashed before anything is returned.
///
/// The answer never depends on what exists outside the directory: a path on
/// another drive, share or device is refused before the filesystem is
/// touched, and a path that does not resolve is placed by the deepest folder
/// on it that does, links followed, so a link inside the directory cannot be
/// used to probe beyond it (5.8 review).
pub fn open_package_in(directory: Option<&Path>, path: &str) -> Result<PackagedScene, Refusal> {
    open_package_with(directory, path, &|path: &Path| path.canonicalize())
}

/// [`open_package_in`] with the one call that resolves a path on disk passed
/// in, so a test can show which paths were resolved before a refusal.
fn open_package_with(
    directory: Option<&Path>,
    path: &str,
    resolve: &dyn Fn(&Path) -> std::io::Result<PathBuf>,
) -> Result<PackagedScene, Refusal> {
    let Some(directory) = directory else {
        return Err(Refusal::PackageDirectoryNotConfigured { path: path.into() });
    };
    let outside = || Refusal::PackagePathOutsideDirectory {
        path: path.into(),
        directory: directory.display().to_string(),
    };
    let unreadable = |detail: String| Refusal::PackageUnreadable {
        path: path.into(),
        detail,
    };
    let root = resolve(directory)
        .map_err(|error| unreadable(format!("the package directory: {error}")))?;
    // `..` and `.` resolved by name, as Windows resolves them before any link.
    let requested =
        std::path::absolute(directory.join(path)).map_err(|error| unreadable(error.to_string()))?;
    let volume = volume_of(&requested);
    if volume.is_none() || (volume != volume_of(directory) && volume != volume_of(&root)) {
        return Err(outside());
    }
    let resolved = match resolve(&requested) {
        Ok(resolved) => resolved,
        Err(error) if resolves_inside(&requested, &root, resolve) => {
            return Err(unreadable(error.to_string()))
        }
        Err(_) => return Err(outside()),
    };
    if !resolved.starts_with(&root) {
        return Err(outside());
    }
    // Known window (user decision, 8 Nov 2026: 5.8 done with it noted): a
    // file swapped for a link between this check and the open below is not
    // re-checked on the open handle. Whatever is opened is still verified
    // against its own manifest and the scene's declared hashes before use,
    // and nothing read is sent back to the publisher.
    let package = read_package(&resolved).map_err(|error| package_refusal(path, error))?;
    packaged_scene(package)
}

/// A package read failure as the refusal a publisher is told. The refusal
/// names the publisher's own path; the engine's resolved form of it, which
/// may name a link's target, is not repeated in the detail (5.8 review).
fn package_refusal(path: &str, error: PackageError) -> Refusal {
    let detail = match error {
        PackageError::Refused(refusal) => return refusal,
        PackageError::Open { source, .. } => format!("could not open it: {source}"),
        PackageError::Archive { detail, .. } => format!("not a package archive: {detail}"),
        other => other.to_string(),
    };
    Refusal::PackageUnreadable {
        path: path.into(),
        detail,
    }
}

/// The local drive or network share a path is on, compared without case, or
/// `None` for a device or other verbatim path that names no ordinary volume.
fn volume_of(path: &Path) -> Option<String> {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return None;
    };
    match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
            Some(format!("{}:", char::from(letter).to_ascii_uppercase()))
        }
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => Some(format!(
            "unc:{}/{}",
            server.to_string_lossy().to_lowercase(),
            share.to_string_lossy().to_lowercase()
        )),
        Prefix::Verbatim(_) | Prefix::DeviceNS(_) => None,
    }
}

/// Whether `requested`, which does not resolve, would lie inside `root`: the
/// deepest folder on it that does resolve, links followed, is inside `root`,
/// only plain names follow it, and the first of them is not a link. A link
/// that does not resolve cannot be shown to stay inside, so it is outside
/// whether or not its target exists.
fn resolves_inside(
    requested: &Path,
    root: &Path,
    resolve: &dyn Fn(&Path) -> std::io::Result<PathBuf>,
) -> bool {
    for ancestor in requested.ancestors().skip(1) {
        let Ok(resolved) = resolve(ancestor) else {
            continue;
        };
        let Ok(rest) = requested.strip_prefix(ancestor) else {
            return false;
        };
        let Some(first) = rest.components().next() else {
            return false;
        };
        let first_is_link = std::fs::symlink_metadata(ancestor.join(first))
            .is_ok_and(|metadata| metadata.file_type().is_symlink());
        return !first_is_link
            && rest
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
            && resolved.join(rest).starts_with(root);
    }
    false
}

/// What one package publication did.
#[derive(Debug, Clone, PartialEq)]
pub struct PackagePublication {
    /// The handoff `handoff_for` chose from the declared locality.
    pub handoff: AssetHandoff,
    /// Asset bytes this publisher sent over the asset plane: none by path
    /// (it sends one path frame), the missing difference by chunked upload.
    /// The engine side's own count is `AssetPublishServer::metrics`.
    pub transferred_bytes: u64,
    pub reply: PublishReply,
}

/// Why a package publication obtained no reply.
#[derive(Debug)]
pub enum PackagePublishError {
    /// The publisher could not read its own package (chunked route), so
    /// nothing was sent.
    Package(Refusal),
    Transfer(AssetTransferClientError),
    Publish(PublishClientError),
}

impl std::fmt::Display for PackagePublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Package(cause) => write!(f, "package refused before publication: {cause}"),
            Self::Transfer(error) => write!(f, "{error}"),
            Self::Publish(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for PackagePublishError {}

/// Publish a package to an engine through the handoff its declared locality
/// negotiates (5.8): the one publisher function for packages.
///
/// By local path the engine is sent the package's absolute path and reads it
/// itself; no asset byte crosses the asset plane. By chunked upload this side
/// reads and verifies the package, sends only the bytes the engine lacks
/// (5.9), then publishes the scene.
pub fn publish_package(
    engine: SocketAddr,
    locality: Locality,
    package: &Path,
) -> Result<PackagePublication, PackagePublishError> {
    let handoff = handoff_for(locality);
    let shown = package.display().to_string();
    match handoff {
        AssetHandoff::LocalPath => {
            let absolute = std::path::absolute(package).map_err(|error| {
                PackagePublishError::Package(Refusal::PackageUnreadable {
                    path: shown.clone(),
                    detail: error.to_string(),
                })
            })?;
            let path = absolute.to_str().ok_or_else(|| {
                PackagePublishError::Package(Refusal::UnsafePackagePath {
                    path: shown.clone(),
                })
            })?;
            let reply = publish_package_path(engine, path).map_err(PackagePublishError::Publish)?;
            Ok(PackagePublication {
                handoff,
                transferred_bytes: 0,
                reply,
            })
        }
        AssetHandoff::ChunkedUpload => {
            let packaged = read_package(package)
                .map_err(|error| package_refusal(&shown, error))
                .and_then(packaged_scene)
                .map_err(PackagePublishError::Package)?;
            let summary =
                publish_assets(engine, &packaged.assets).map_err(PackagePublishError::Transfer)?;
            let reply =
                publish_scene(engine, packaged.scene).map_err(PackagePublishError::Publish)?;
            Ok(PackagePublication {
                handoff,
                transferred_bytes: summary.transferred_bytes,
                reply,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::{write_package, PackageSource};
    use crate::publish::{AssetPublishPeer, AssetPublishServer, PublishRefusal};
    use gx_contracts::scene::{AssetKind, AssetLibraryItem};
    use gx_contracts::{ContentHash, Revision, TakeId};
    use std::collections::HashMap;
    use std::fs;
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gx-handoff-test-{}-{}",
            std::process::id(),
            UNIQUE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    const FONT: &[u8] = b"not really a font, but bytes with a hash";

    fn scene(checksum: ContentHash) -> SceneDocument {
        let mut scene = gx_contracts::scene::new_scene(
            "handoff/scene",
            "Handoff",
            gx_contracts::color::WorkingColorSpace::LinearSrgb,
        );
        scene.revision = Some(Revision(1));
        scene.assets.push(AssetLibraryItem {
            asset_id: "font".into(),
            name: "Font".into(),
            kind: AssetKind::Font,
            path: "fonts/face.ttf".into(),
            checksum: Some(checksum),
            mime_type: None,
            size_bytes: Some(FONT.len() as u64),
            status: None,
            provenance: Default::default(),
        });
        scene
    }

    /// A package of `scene` in `root`, its font read from a source file.
    fn package(root: &Path, name: &str, scene: &SceneDocument) -> PathBuf {
        let source = root.join(format!("{name}.font"));
        fs::write(&source, FONT).unwrap();
        let output = root.join(format!("{name}.gpxpkg"));
        write_package(
            &output,
            scene,
            &[PackageSource {
                path: "fonts/face.ttf".into(),
                source,
            }],
            None,
        )
        .unwrap();
        output
    }

    /// A peer that keeps what it is handed, with an optional package directory.
    #[derive(Default)]
    struct Peer {
        directory: Option<PathBuf>,
        assets: HashMap<ContentHash, Vec<u8>>,
        published: Vec<SceneDocument>,
    }

    impl AssetPublishPeer for Peer {
        fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
            let content_hash = content_hash(&serde_json::to_vec(&scene).unwrap());
            self.published.push(scene);
            PublishReply::Published {
                take_id: TakeId("handoff/scene".into()),
                revision: Revision(self.published.len() as u64),
                content_hash,
            }
        }
        fn has_verified_asset(&self, hash: &ContentHash) -> bool {
            self.assets.contains_key(hash)
        }
        fn accept_verified_asset(
            &mut self,
            hash: ContentHash,
            bytes: Vec<u8>,
        ) -> Result<(), Refusal> {
            self.assets.insert(hash, bytes);
            Ok(())
        }
        fn package_directory(&self) -> Option<PathBuf> {
            self.directory.clone()
        }
    }

    fn serve(peer: Peer) -> (SocketAddr, Arc<Mutex<Peer>>) {
        let (addr, peer, _) = serve_counted(peer);
        (addr, peer)
    }

    /// A served peer and the listener's own count of transfer bytes received.
    fn serve_counted(
        peer: Peer,
    ) -> (
        SocketAddr,
        Arc<Mutex<Peer>>,
        crate::preflight::AssetTransferMetrics,
    ) {
        let peer = Arc::new(Mutex::new(peer));
        let server = AssetPublishServer::bind(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            Arc::clone(&peer),
        )
        .unwrap();
        let addr = server.local_addr().unwrap();
        let metrics = server.metrics();
        server.serve_in_background();
        (addr, peer, metrics)
    }

    /// A directory junction, which Windows lets any user create.
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "mklink /J {} {}",
            link.display(),
            target.display()
        );
    }

    #[test]
    fn the_declared_locality_alone_chooses_the_handoff() {
        assert_eq!(handoff_for(Locality::CoLocated), AssetHandoff::LocalPath);
        assert_eq!(handoff_for(Locality::Lan), AssetHandoff::ChunkedUpload);
    }

    #[test]
    fn both_handoffs_deliver_the_same_scene_and_bytes() {
        let root = directory();
        let path = package(&root, "both", &scene(content_hash(FONT)));
        let (local, local_peer, local_received) = serve_counted(Peer {
            directory: Some(root.clone()),
            ..Peer::default()
        });
        let (lan, lan_peer, lan_received) = serve_counted(Peer::default());

        let by_path = publish_package(local, Locality::CoLocated, &path).unwrap();
        let chunked = publish_package(lan, Locality::Lan, &path).unwrap();
        assert_eq!(by_path.handoff, AssetHandoff::LocalPath);
        assert_eq!(by_path.transferred_bytes, 0);
        // Counted where the bytes would arrive, not where they are sent.
        assert_eq!(
            local_received.received_asset_bytes(),
            0,
            "no asset byte crosses the plane by path"
        );
        assert_eq!(chunked.handoff, AssetHandoff::ChunkedUpload);
        assert_eq!(chunked.transferred_bytes, FONT.len() as u64);
        assert_eq!(lan_received.received_asset_bytes(), FONT.len() as u64);
        assert!(matches!(by_path.reply, PublishReply::Published { .. }));
        assert_eq!(by_path.reply, chunked.reply);

        let (local_peer, lan_peer) = (local_peer.lock().unwrap(), lan_peer.lock().unwrap());
        assert_eq!(local_peer.published, lan_peer.published);
        assert_eq!(local_peer.assets, lan_peer.assets);
        assert_eq!(local_peer.assets[&content_hash(FONT)], FONT);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_engine_without_a_package_directory_refuses_a_path_by_name() {
        let root = directory();
        let path = package(&root, "unconfigured", &scene(content_hash(FONT)));
        let (addr, peer) = serve(Peer::default());
        let published = publish_package(addr, Locality::CoLocated, &path).unwrap();
        assert!(matches!(
            published.reply,
            PublishReply::Refused(PublishRefusal::PackageRefused {
                cause: Refusal::PackageDirectoryNotConfigured { .. }
            })
        ));
        assert!(peer.lock().unwrap().published.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_path_outside_the_package_directory_is_refused_by_name() {
        let inside = directory();
        let elsewhere = directory();
        let path = package(&elsewhere, "outside", &scene(content_hash(FONT)));
        let escaping = format!(
            "../{}/outside.gpxpkg",
            elsewhere.file_name().unwrap().to_str().unwrap()
        );
        for offered in [path.to_str().unwrap().to_owned(), escaping] {
            assert!(
                matches!(
                    open_package_in(Some(&inside), &offered),
                    Err(Refusal::PackagePathOutsideDirectory { .. })
                ),
                "{offered} was not refused as outside"
            );
        }
        // Named outside whether or not the outside file exists.
        assert!(matches!(
            open_package_in(Some(&inside), "../no-such-dir/missing.gpxpkg"),
            Err(Refusal::PackagePathOutsideDirectory { .. })
        ));
        assert!(matches!(
            open_package_in(Some(&inside), "missing.gpxpkg"),
            Err(Refusal::PackageUnreadable { .. })
        ));
        fs::remove_dir_all(inside).unwrap();
        fs::remove_dir_all(elsewhere).unwrap();
    }

    #[test]
    fn a_package_whose_bytes_changed_is_refused_by_hash() {
        let root = directory();
        let path = package(&root, "tampered", &scene(content_hash(FONT)));
        // The same archive, every member copied, but the font replaced by
        // other bytes of the same length after the manifest was written.
        let mut original = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
        let tampered_path = root.join("tampered-copy.gpxpkg");
        let mut copy = zip::ZipWriter::new(fs::File::create(&tampered_path).unwrap());
        for index in 0..original.len() {
            let mut member = original.by_index(index).unwrap();
            let name = member.name().to_owned();
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut member, &mut bytes).unwrap();
            if name == "fonts/face.ttf" {
                bytes = vec![b'x'; bytes.len()];
            }
            copy.start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
            std::io::Write::write_all(&mut copy, &bytes).unwrap();
        }
        copy.finish().unwrap();
        let refused = open_package_in(Some(&root), tampered_path.to_str().unwrap());
        assert!(
            matches!(&refused, Err(Refusal::PackageFileHashMismatch { path, .. }) if path == "fonts/face.ttf"),
            "{refused:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_scene_naming_other_bytes_than_its_package_holds_is_refused_asset_hash_mismatch() {
        let root = directory();
        let other = content_hash(b"other bytes");
        let path = package(&root, "mismatch", &scene(other.clone()));
        let refused = open_package_in(Some(&root), path.to_str().unwrap());
        assert!(
            matches!(&refused, Err(Refusal::AssetHashMismatch { expected, .. }) if *expected == other),
            "{refused:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_link_inside_the_directory_that_leads_outside_is_refused_by_name() {
        let inside = directory();
        let elsewhere = directory();
        package(&elsewhere, "linked", &scene(content_hash(FONT)));
        junction(&inside.join("link"), &elsewhere);
        junction(&inside.join("dangling"), &elsewhere.join("no-such-dir"));
        // The same answer whether what lies behind the link exists or not, so
        // the link cannot be used to probe outside the directory.
        for offered in [
            r"link\linked.gpxpkg",
            r"link\missing.gpxpkg",
            r"link\no-such-dir\missing.gpxpkg",
            "link",
            r"dangling\missing.gpxpkg",
            "dangling",
        ] {
            let refused = open_package_in(Some(&inside), offered);
            assert!(
                matches!(refused, Err(Refusal::PackagePathOutsideDirectory { .. })),
                "{offered}: {refused:?}"
            );
        }
        fs::remove_dir(inside.join("link")).unwrap();
        fs::remove_dir(inside.join("dangling")).unwrap();
        fs::remove_dir_all(inside).unwrap();
        fs::remove_dir_all(elsewhere).unwrap();
    }

    #[test]
    fn a_missing_package_spelled_differently_from_the_directory_is_still_inside() {
        let inside = directory();
        let shown = inside.to_str().unwrap();
        for offered in [
            format!(r"{}\missing.gpxpkg", shown.to_uppercase()),
            format!(r"{}\missing.gpxpkg", shown.to_lowercase()),
        ] {
            let refused = open_package_in(Some(&inside), &offered);
            assert!(
                matches!(refused, Err(Refusal::PackageUnreadable { .. })),
                "{offered}: {refused:?}"
            );
        }
        fs::remove_dir_all(inside).unwrap();
    }

    #[test]
    fn a_file_that_is_not_a_package_is_refused_unreadable_without_the_resolved_path() {
        let root = directory();
        let real = root.join("real-target");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("not-a-package.gpxpkg"), b"plain text, not a zip").unwrap();
        // The engine's directory is a link; what it resolves to is not told.
        let linked = root.join("packages");
        junction(&linked, &real);
        let refused = open_package_in(Some(&linked), "not-a-package.gpxpkg");
        match &refused {
            Err(Refusal::PackageUnreadable { path, detail }) => {
                assert_eq!(path, "not-a-package.gpxpkg");
                assert!(detail.starts_with("not a package archive"), "{detail}");
                assert!(!detail.contains("real-target"), "{detail}");
            }
            other => panic!("{other:?}"),
        }
        fs::remove_dir(&linked).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_share_or_device_path_is_refused_before_anything_is_resolved() {
        let inside = directory();
        let asked = std::cell::RefCell::new(Vec::new());
        let resolve = |path: &Path| {
            asked.borrow_mut().push(path.to_path_buf());
            path.canonicalize()
        };
        // Resolving a share path opens a network session to its server, as
        // the engine's own account, before any answer could be given.
        for offered in [
            r"\\gx-no-such-host.invalid\share\outside.gpxpkg",
            r"\\127.0.0.1\gx-no-such-share\outside.gpxpkg",
            r"\\?\UNC\gx-no-such-host.invalid\share\outside.gpxpkg",
            r"\\.\NUL",
            r"\\?\GLOBALROOT\Device\Null",
        ] {
            let refused = open_package_with(Some(&inside), offered, &resolve);
            assert!(
                matches!(refused, Err(Refusal::PackagePathOutsideDirectory { .. })),
                "{offered}: {refused:?}"
            );
        }
        let asked = asked.into_inner();
        assert!(
            asked.iter().all(|path| path == &inside),
            "resolved before refusing: {asked:?}"
        );
        fs::remove_dir_all(inside).unwrap();
    }
}
