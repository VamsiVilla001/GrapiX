//! The `.gpxpkg` manifest contract (build plan 1.8).
//!
//! A package carries one immutable scene revision and the exact bytes needed to
//! prepare it.  The manifest names every payload file by package-relative path,
//! length and SHA-256, so a reader can reject damaged or substituted bytes
//! before treating them as a revision (invariants 28 and 30).  Paths are
//! canonical platform-safe components and are compared as [`FileName`] values;
//! this prevents traversal and case-only collisions from becoming
//! platform-dependent package contents.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::platform::{is_canonical_filename, FileName};
use crate::{ContentHash, Refusal, Revision};

/// The only package format this reader understands.  A package is immutable,
/// so a later format needs a new explicit reader rather than best-effort
/// interpretation of fields this version does not know.
pub const PACKAGE_FORMAT_VERSION: u32 = 1;

/// The archive members owned by the package format rather than by a scene.
pub const MANIFEST_PATH: &str = "manifest.json";
pub const SCENE_PATH: &str = "scene.json";

/// A `.gpxpkg`'s signed-by-content inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    pub format_version: u32,
    /// The immutable scene identity this archive contains.
    pub scene_id: String,
    /// The exact scene revision this archive contains.
    pub scene_revision: Revision,
    /// Every payload member, including [`SCENE_PATH`] but excluding this
    /// manifest itself: a manifest cannot hash itself without a circular
    /// definition.
    pub files: Vec<PackageFileEntry>,
}

impl PackageManifest {
    /// Refuse an unsupported version, an unsafe path, a case-only collision or
    /// a malformed digest before a reader opens any payload member.
    pub fn validate(&self) -> Result<(), Refusal> {
        if self.format_version != PACKAGE_FORMAT_VERSION {
            return Err(Refusal::UnknownPackageFormatVersion {
                received: self.format_version,
            });
        }

        let mut paths = BTreeSet::new();
        for entry in &self.files {
            if !is_sha256(&entry.sha256.0) {
                return Err(Refusal::InvalidPackageHash {
                    path: entry.path.clone(),
                });
            }
            let components = package_path_components(&entry.path)?;
            if !paths.insert(components) {
                return Err(Refusal::DuplicatePackagePath {
                    path: entry.path.clone(),
                });
            }
        }
        Ok(())
    }
}

/// One verified payload file in a [`PackageManifest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackageFileEntry {
    /// Archive-relative path, expressed with `/` separators.
    pub path: String,
    pub size_bytes: u64,
    pub sha256: ContentHash,
}

/// Turn an archive path into its platform-safe, case-folded comparison key.
///
/// This accepts no absolute roots, parent components, empty components or
/// names that would need sanitising.  Constructing `FileName` for every
/// component is deliberate: equality of paths obeys the 2.3 case policy even
/// on a case-sensitive filesystem.
pub fn package_path_components(path: &str) -> Result<Vec<FileName>, Refusal> {
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
        return Err(Refusal::UnsafePackagePath {
            path: path.to_string(),
        });
    }

    let mut components = Vec::new();
    for component in path.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || !is_canonical_filename(component)
        {
            return Err(Refusal::UnsafePackagePath {
                path: path.to_string(),
            });
        }
        components.push(FileName::new(component));
    }

    Ok(components)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|byte| {
            byte.is_ascii_digit() || (byte.is_ascii_lowercase() && byte.is_ascii_hexdigit())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash() -> ContentHash {
        ContentHash("a".repeat(64))
    }

    fn manifest(path: &str) -> PackageManifest {
        PackageManifest {
            format_version: PACKAGE_FORMAT_VERSION,
            scene_id: "scene-1".into(),
            scene_revision: Revision(7),
            files: vec![PackageFileEntry {
                path: path.into(),
                size_bytes: 1,
                sha256: hash(),
            }],
        }
    }

    #[test]
    fn manifest_refuses_unsafe_and_case_colliding_paths() {
        for path in [
            "../secret",
            "/rooted",
            "assets//logo.png",
            "assets/CON",
            "assets/logo?.png",
        ] {
            assert!(matches!(
                manifest(path).validate(),
                Err(Refusal::UnsafePackagePath { .. })
            ));
        }

        let mut duplicate = manifest("assets/Logo.png");
        duplicate.files.push(PackageFileEntry {
            path: "assets/logo.png".into(),
            size_bytes: 1,
            sha256: hash(),
        });
        assert!(matches!(
            duplicate.validate(),
            Err(Refusal::DuplicatePackagePath { .. })
        ));
    }

    #[test]
    fn manifest_refuses_unknown_format_by_name() {
        let mut value = manifest("scene.json");
        value.format_version = PACKAGE_FORMAT_VERSION + 1;
        assert!(matches!(
            value.validate(),
            Err(Refusal::UnknownPackageFormatVersion { received: 2 })
        ));
    }
}
