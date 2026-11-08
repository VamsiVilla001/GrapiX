//! Durable `.gpxpkg` archive writing and verified reading (build plan 1.8).
//!
//! Packages are ZIP containers with zstd-compressed payload members.  This
//! module is the sole local package boundary: it writes the completed archive
//! through `gx_fs::write_atomic`, records SHA-256 while each member is streamed
//! into it, then reopens and re-hashes every manifest member.  The second pass
//! closes the fault where a completed rename names bytes changed between the
//! stream and publication; a mismatch removes the output rather than creating
//! a revision from an unverified package (invariants 28 and 30).
//!
//! The `zip` dependency is MIT-licensed and is used because `.gpxpkg` is the
//! established ZIP container format with zstd member compression (ADR-0001
//! C.2).  It is not a general archive extraction API: manifest paths are
//! rejected before any payload is read, so an archive cannot escape a package
//! root (invariant 42).

use std::collections::{BTreeMap, BTreeSet};
#[cfg(test)]
use std::fs;
use std::fs::File;
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

use gx_contracts::package::{
    package_path_components, PackageFileEntry, PackageManifest, MANIFEST_PATH,
    PACKAGE_FORMAT_VERSION, SCENE_PATH,
};
use gx_contracts::scene::{parse_scene_document, SceneDocument};
use gx_contracts::{ContentHash, Refusal};
#[cfg(test)]
use gx_fs::write_atomic_with;
use gx_fs::AtomicWriteError;
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// A file to include in a package. `path` is the package-relative location;
/// `source` is read only while the atomic package write is in progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageSource {
    pub path: String,
    pub source: PathBuf,
}

/// A fully verified package. No scene or member bytes are returned until every
/// manifest member has passed length and SHA-256 verification.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedPackage {
    pub manifest: PackageManifest,
    pub scene: SceneDocument,
    pub files: BTreeMap<String, Vec<u8>>,
}

/// Durable package I/O failures that are not contract refusals.
#[derive(Debug)]
pub enum PackageError {
    Refused(Refusal),
    Atomic(AtomicWriteError),
    Open { path: PathBuf, source: io::Error },
    Archive { path: PathBuf, detail: String },
    ManifestSerialization { detail: String },
    ManifestDeserialization { detail: String },
    Cleanup { path: PathBuf, source: io::Error },
}

impl std::fmt::Display for PackageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refusal) => refusal.fmt(f),
            Self::Atomic(error) => write!(f, "atomic package write failed: {error}"),
            Self::Open { path, source } => {
                write!(f, "could not open package {}: {source}", path.display())
            }
            Self::Archive { path, detail } => {
                write!(f, "invalid package archive {}: {detail}", path.display())
            }
            Self::ManifestSerialization { detail } => {
                write!(f, "could not serialise package manifest: {detail}")
            }
            Self::ManifestDeserialization { detail } => {
                write!(f, "could not parse package manifest: {detail}")
            }
            Self::Cleanup { path, source } => write!(
                f,
                "could not remove failed package {}: {source}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for PackageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(error) => Some(error),
            Self::Atomic(error) => Some(error),
            Self::Open { source, .. } | Self::Cleanup { source, .. } => Some(source),
            Self::Archive { .. }
            | Self::ManifestSerialization { .. }
            | Self::ManifestDeserialization { .. } => None,
        }
    }
}

impl From<Refusal> for PackageError {
    fn from(value: Refusal) -> Self {
        Self::Refused(value)
    }
}

/// Create an immutable package, proving its bytes against its own manifest
/// before it replaces anything. All scene assets must be represented by a
/// source at the path the scene library declares.
///
/// `design_system_version` stamps the system the scene was authored against,
/// so brand-pack drift is listable later (Part G, 7.6). `None` records that
/// the package predates stamping rather than asserting it conforms to
/// nothing.
pub fn write_package(
    output: &Path,
    scene: &SceneDocument,
    sources: &[PackageSource],
    design_system_version: Option<u32>,
) -> Result<PackageManifest, PackageError> {
    write_package_inner(output, scene, sources, design_system_version, |_| {})
}

/// The writer, with a seam for corrupting the candidate before verification.
///
/// Exists so a test can prove the destination survives a build that fails its
/// own verification — the one path that cannot be reached by supplying bad
/// inputs, because bad inputs are rejected before any bytes are written. The
/// seam is private and the public [`write_package`] passes a no-op, so no
/// production caller can corrupt a package on purpose.
fn write_package_inner(
    output: &Path,
    scene: &SceneDocument,
    sources: &[PackageSource],
    design_system_version: Option<u32>,
    tamper_with_candidate: impl FnOnce(&Path),
) -> Result<PackageManifest, PackageError> {
    let revision = scene
        .revision
        .ok_or_else(|| Refusal::PackageScenePinMismatch {
            detail: format!("scene {} has no revision to pin", scene.id),
        })?;
    validate_sources_and_scene_closure(scene, sources)?;
    let scene_bytes =
        serde_json::to_vec(scene).map_err(|error| PackageError::ManifestSerialization {
            detail: error.to_string(),
        })?;

    // Build, verify, *then* replace. Verifying after the rename would mean a
    // failed build had already destroyed the last good package, leaving
    // deletion as the only cleanup — which is the opposite of all-or-nothing
    // (7.6's done-when). `write_atomic_verified` runs the check against the
    // candidate while the destination still holds its previous contents.
    let mut written_manifest = None;
    let mut verified_manifest = None;
    gx_fs::write_atomic_verified(
        output,
        |file| {
            let mut archive = ZipWriter::new(file);
            let mut entries = Vec::with_capacity(sources.len() + 1);
            entries.push(write_bytes(&mut archive, SCENE_PATH, &scene_bytes)?);
            for source in sources {
                let source_file = File::open(&source.source)?;
                entries.push(write_reader(&mut archive, &source.path, source_file)?);
            }
            let manifest = PackageManifest {
                format_version: PACKAGE_FORMAT_VERSION,
                scene_id: scene.id.clone(),
                scene_revision: revision,
                files: entries,
                design_system_version,
            };
            let manifest_bytes = serde_json::to_vec(&manifest).map_err(io::Error::other)?;
            archive
                .start_file(MANIFEST_PATH, file_options())
                .map_err(io::Error::other)?;
            archive.write_all(&manifest_bytes)?;
            archive.finish().map_err(io::Error::other)?;
            written_manifest = Some(manifest);
            Ok(())
        },
        |candidate| {
            tamper_with_candidate(candidate);
            // The candidate is read back from its own bytes, so what is
            // verified is what will be published, not what was intended.
            read_package(candidate).map(|verified| {
                verified_manifest = Some(verified.manifest);
            })
        },
    )
    .map_err(|error| match error {
        gx_fs::VerifiedWriteError::Write(source) => PackageError::Atomic(source),
        gx_fs::VerifiedWriteError::Rejected(source) => source,
    })?;

    verified_manifest
        .or(written_manifest)
        .ok_or_else(|| PackageError::ManifestSerialization {
            detail: "the package was written but produced no manifest".to_string(),
        })
}

/// Read a package only after validating its manifest, archive inventory,
/// lengths, digests and pinned scene identity.
pub fn read_package(path: &Path) -> Result<VerifiedPackage, PackageError> {
    let file = File::open(path).map_err(|source| PackageError::Open {
        path: path.to_path_buf(),
        source,
    })?;
    let mut archive = ZipArchive::new(file).map_err(|error| PackageError::Archive {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;

    let manifest_bytes = read_archive_member(&mut archive, MANIFEST_PATH)?;
    let manifest: PackageManifest = serde_json::from_slice(&manifest_bytes).map_err(|error| {
        PackageError::ManifestDeserialization {
            detail: error.to_string(),
        }
    })?;
    manifest.validate()?;
    validate_archive_inventory(&mut archive, &manifest)?;

    let mut files = BTreeMap::new();
    for entry in &manifest.files {
        let bytes = read_archive_member(&mut archive, &entry.path)?;
        verify_entry(entry, &bytes)?;
        files.insert(entry.path.clone(), bytes);
    }

    let scene_bytes = files
        .get(SCENE_PATH)
        .ok_or_else(|| Refusal::PackageEntryMissing {
            path: SCENE_PATH.into(),
        })?;
    // The one scene reader (invariant 45): it refuses unknown fields by name
    // and upgrades an older schema, so a package scene hashes the same here,
    // in Playout's library and in the engine (11.38, 11.39).
    let scene = parse_scene_document(scene_bytes)?;
    verify_scene_pin(&manifest, &scene)?;

    Ok(VerifiedPackage {
        manifest,
        scene,
        files,
    })
}

fn validate_sources_and_scene_closure(
    scene: &SceneDocument,
    sources: &[PackageSource],
) -> Result<(), PackageError> {
    let mut paths = BTreeSet::new();
    for source in sources {
        if source.path == MANIFEST_PATH || source.path == SCENE_PATH {
            return Err(Refusal::UnsafePackagePath {
                path: source.path.clone(),
            }
            .into());
        }
        let key = package_path_components(&source.path)?;
        if !paths.insert(key) {
            return Err(Refusal::DuplicatePackagePath {
                path: source.path.clone(),
            }
            .into());
        }
    }

    for asset in &scene.assets {
        let key = package_path_components(&asset.path)?;
        if !paths.contains(&key) {
            return Err(Refusal::PackageAssetNotPackaged {
                asset_id: asset.asset_id.clone(),
                path: asset.path.clone(),
            }
            .into());
        }
    }
    Ok(())
}

fn file_options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Zstd)
}

fn write_bytes<W: Write + Seek>(
    archive: &mut ZipWriter<W>,
    path: &str,
    bytes: &[u8],
) -> io::Result<PackageFileEntry> {
    write_reader(archive, path, io::Cursor::new(bytes))
}

fn write_reader<W: Write + Seek, R: Read>(
    archive: &mut ZipWriter<W>,
    path: &str,
    mut reader: R,
) -> io::Result<PackageFileEntry> {
    archive
        .start_file(path, file_options())
        .map_err(io::Error::other)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        archive.write_all(&buffer[..count])?;
        hasher.update(&buffer[..count]);
        size = size
            .checked_add(u64::try_from(count).expect("buffer length fits u64"))
            .ok_or_else(|| io::Error::other("package entry exceeds u64 length"))?;
    }
    Ok(PackageFileEntry {
        path: path.into(),
        size_bytes: size,
        sha256: ContentHash(format!("{:x}", hasher.finalize())),
    })
}

fn read_archive_member(
    archive: &mut ZipArchive<File>,
    path: &str,
) -> Result<Vec<u8>, PackageError> {
    let mut member = archive
        .by_name(path)
        .map_err(|_| Refusal::PackageEntryMissing { path: path.into() })?;
    let mut bytes = Vec::with_capacity(usize::try_from(member.size()).unwrap_or(0));
    member
        .read_to_end(&mut bytes)
        .map_err(|error| Refusal::PackageEntryUnreadable {
            path: path.into(),
            detail: error.to_string(),
        })?;
    Ok(bytes)
}

fn validate_archive_inventory(
    archive: &mut ZipArchive<File>,
    manifest: &PackageManifest,
) -> Result<(), PackageError> {
    let mut expected = BTreeSet::new();
    expected.insert(MANIFEST_PATH.to_string());
    expected.extend(manifest.files.iter().map(|entry| entry.path.clone()));

    let mut actual = BTreeSet::new();
    for index in 0..archive.len() {
        let member = archive
            .by_index(index)
            .map_err(|error| PackageError::Archive {
                path: PathBuf::from("<open package>"),
                detail: error.to_string(),
            })?;
        let name = member.name().to_string();
        if !actual.insert(name.clone()) || !expected.contains(&name) {
            return Err(Refusal::PackageEntryMissing { path: name }.into());
        }
    }
    if actual != expected {
        let missing = expected
            .difference(&actual)
            .next()
            .expect("sets differ")
            .clone();
        return Err(Refusal::PackageEntryMissing { path: missing }.into());
    }
    Ok(())
}

fn verify_entry(entry: &PackageFileEntry, bytes: &[u8]) -> Result<(), PackageError> {
    let actual_size = u64::try_from(bytes.len()).expect("usize fits u64");
    if actual_size != entry.size_bytes {
        return Err(Refusal::PackageFileLengthMismatch {
            path: entry.path.clone(),
            expected: entry.size_bytes,
            actual: actual_size,
        }
        .into());
    }
    let actual = ContentHash(format!("{:x}", Sha256::digest(bytes)));
    if actual != entry.sha256 {
        return Err(Refusal::PackageFileHashMismatch {
            path: entry.path.clone(),
            expected: entry.sha256.clone(),
            actual,
        }
        .into());
    }
    Ok(())
}

fn verify_scene_pin(manifest: &PackageManifest, scene: &SceneDocument) -> Result<(), PackageError> {
    if scene.id != manifest.scene_id || scene.revision != Some(manifest.scene_revision) {
        return Err(Refusal::PackageScenePinMismatch {
            detail: format!(
                "manifest pins {} at {}, archive contains {} at {:?}",
                manifest.scene_id, manifest.scene_revision.0, scene.id, scene.revision
            ),
        }
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::scene::{
        AssetAvailability, AssetKind, AssetLibraryItem, SceneCanvas, SceneTimeline,
    };
    use gx_contracts::{RationalRate, Revision};
    use gx_fs::write_atomic;
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gx-package-test-{}-{}",
            std::process::id(),
            UNIQUE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn scene() -> SceneDocument {
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            id: "scene-1".into(),
            name: "Package test".into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(4)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::new(25, 1).unwrap(),
            },
            timeline: SceneTimeline::default(),
            data_context: Default::default(),
            assets: vec![AssetLibraryItem {
                asset_id: "logo".into(),
                name: "Logo".into(),
                kind: AssetKind::Image,
                path: "assets/logo.bin".into(),
                checksum: None,
                mime_type: Some("application/octet-stream".into()),
                size_bytes: Some(4),
                status: Some(AssetAvailability::Ready),
                provenance: Default::default(),
            }],
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects: Vec::new(),
        }
    }

    fn write_test_package(root: &Path) -> (PathBuf, PackageManifest) {
        let source = root.join("logo.bin");
        write_atomic(&source, b"logo").unwrap();
        let output = root.join("scene.gpxpkg");
        let manifest = write_package(
            &output,
            &scene(),
            &[PackageSource {
                path: "assets/logo.bin".into(),
                source,
            }],
            Some(3),
        )
        .unwrap();
        (output, manifest)
    }

    fn rewrite_archive(path: &Path, manifest: &PackageManifest, asset: &[u8]) {
        let scene_bytes = serde_json::to_vec(&scene()).unwrap();
        let manifest_bytes = serde_json::to_vec(manifest).unwrap();
        write_atomic_with(path, |file| {
            let mut archive = ZipWriter::new(file);
            archive
                .start_file(SCENE_PATH, file_options())
                .map_err(io::Error::other)?;
            archive.write_all(&scene_bytes)?;
            archive
                .start_file("assets/logo.bin", file_options())
                .map_err(io::Error::other)?;
            archive.write_all(asset)?;
            archive
                .start_file(MANIFEST_PATH, file_options())
                .map_err(io::Error::other)?;
            archive.write_all(&manifest_bytes)?;
            archive.finish().map_err(io::Error::other)?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn writer_round_trips_a_scene_and_its_asset_after_reverification() {
        let root = temporary_directory();
        let (path, manifest) = write_test_package(&root);
        let package = read_package(&path).unwrap();
        assert_eq!(package.manifest, manifest);
        assert_eq!(package.scene, scene());
        assert_eq!(package.files["assets/logo.bin"], b"logo");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reader_names_a_corrupted_member_hash() {
        let root = temporary_directory();
        let (path, manifest) = write_test_package(&root);
        rewrite_archive(&path, &manifest, b"l0go");
        assert!(matches!(
            read_package(&path),
            Err(PackageError::Refused(Refusal::PackageFileHashMismatch { path, .. })) if path == "assets/logo.bin"
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reader_names_a_truncated_member() {
        let root = temporary_directory();
        let (path, manifest) = write_test_package(&root);
        rewrite_archive(&path, &manifest, b"lo");
        assert!(matches!(
            read_package(&path),
            Err(PackageError::Refused(Refusal::PackageFileLengthMismatch { path, .. })) if path == "assets/logo.bin"
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reader_refuses_an_unknown_format_version() {
        let root = temporary_directory();
        let (path, mut manifest) = write_test_package(&root);
        manifest.format_version += 1;
        rewrite_archive(&path, &manifest, b"logo");
        assert!(matches!(
            read_package(&path),
            Err(PackageError::Refused(
                Refusal::UnknownPackageFormatVersion { .. }
            ))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reader_refuses_a_manifest_traversal_path_before_reading_payloads() {
        let root = temporary_directory();
        let (path, mut manifest) = write_test_package(&root);
        manifest.files[1].path = "../assets/logo.bin".into();
        rewrite_archive(&path, &manifest, b"logo");
        assert!(matches!(
            read_package(&path),
            Err(PackageError::Refused(Refusal::UnsafePackagePath { .. }))
        ));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_failed_build_leaves_the_previous_package_byte_identical() {
        // 7.6's done-when: publishing is all-or-nothing. The failure this
        // guards is a re-package that fails verification and takes the last
        // good artefact with it — which is what verifying after the rename
        // does, because by then there is nothing left to keep.
        let root = temporary_directory();
        let source = root.join("logo.bin");
        write_atomic(&source, b"logo").unwrap();
        let output = root.join("scene.gpxpkg");
        let spec = || PackageSource {
            path: "assets/logo.bin".into(),
            source: source.clone(),
        };

        write_package(&output, &scene(), &[spec()], Some(3)).expect("the first build succeeds");
        let good = fs::read(&output).expect("a good package exists");

        let failed = write_package_inner(&output, &scene(), &[spec()], Some(4), |candidate| {
            let verified = read_package(candidate).unwrap();
            rewrite_archive(candidate, &verified.manifest, b"l0go");
        });

        assert!(matches!(
            failed,
            Err(PackageError::Refused(Refusal::PackageFileHashMismatch { path, .. }))
                if path == "assets/logo.bin"
        ));
        assert_eq!(
            fs::read(&output).expect("the previous package must still be there"),
            good,
            "a rejected build must leave the destination byte-identical"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_first_build_leaves_no_package_at_all() {
        let root = temporary_directory();
        let source = root.join("logo.bin");
        write_atomic(&source, b"logo").unwrap();
        let output = root.join("scene.gpxpkg");

        let failed = write_package_inner(
            &output,
            &scene(),
            &[PackageSource {
                path: "assets/logo.bin".into(),
                source,
            }],
            None,
            |candidate| {
                let verified = read_package(candidate).unwrap();
                rewrite_archive(candidate, &verified.manifest, b"l0go");
            },
        );

        assert!(failed.is_err());
        assert!(
            !output.exists(),
            "a build that never verified must not leave a half-good artefact"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_design_system_stamp_survives_a_round_trip_and_is_covered_by_verification() {
        // The stamp exists so brand-pack drift is listable (Part G). A stamp
        // outside the manifest's own integrity could be edited afterwards,
        // which would make it a decoration rather than a record.
        let root = temporary_directory();
        let (output, manifest) = write_test_package(&root);
        assert_eq!(manifest.design_system_version, Some(3));

        let read_back = read_package(&output).expect("the package verifies");
        assert_eq!(read_back.manifest.design_system_version, Some(3));

        // An unstamped package is a different statement from one stamped
        // zero, and must round-trip as absent rather than as a default.
        let source = root.join("other.bin");
        write_atomic(&source, b"logo").unwrap();
        let unstamped_path = root.join("unstamped.gpxpkg");
        let unstamped = write_package(
            &unstamped_path,
            &scene(),
            &[PackageSource {
                path: "assets/logo.bin".into(),
                source,
            }],
            None,
        )
        .expect("an unstamped package is legal");
        assert_eq!(unstamped.design_system_version, None);
        assert_eq!(
            read_package(&unstamped_path)
                .unwrap()
                .manifest
                .design_system_version,
            None
        );
        fs::remove_dir_all(root).unwrap();
    }
}
