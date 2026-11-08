//! Asset manager file import (11.39): files in, one `addAssets` batch out.
//!
//! Like font ingest (`fonts::ingest`) this is preparation, never a scene
//! edit. Each file is classified by its bytes, never its extension; every
//! file is verified before the first byte is cached, so one refusal leaves
//! nothing behind; and every asset carries the provenance record the import
//! fills in: a person brought the file in, through this tool, from that file.
//! The batch reaches a scene only as one `addAssets` edit, which is one undo
//! entry (invariant 60).
//!
//! **Identity is content-derived.** The asset id and library path come from
//! the SHA-256, so importing the same file twice gives one asset: the second
//! time it is reported as already in the scene, not added again.

use std::collections::HashMap;
use std::fmt;

use gx_contracts::provenance::{AssetOrigin, AssetProvenance, ProvenanceTool};
use gx_contracts::scene::{AssetAvailability, AssetKind, AssetLibraryItem};
use gx_contracts::{ContentHash, Refusal};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::store::{content_hash, read_image_geometry, AssetStore, AssetStoreError};

/// The tool an asset manager import records in each asset's provenance.
pub const ASSET_FILE_IMPORT_TOOL: &str = "GrapiX asset import";

/// One file the author picked.
#[derive(Debug, Clone)]
pub struct AssetFileInput<'a> {
    /// Shown to the author, named in any refusal and recorded as the asset's
    /// source. Never consulted for the format: the bytes decide that.
    pub file_name: String,
    pub bytes: &'a [u8],
}

/// Assets to add in one scene edit, plus what happened to each input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAssetBatch {
    /// New to the scene, in input order. Empty when every input was already
    /// there.
    pub assets: Vec<AssetLibraryItem>,
    /// One entry per input file, in input order.
    pub sources: Vec<PreparedAssetSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAssetSource {
    pub source: String,
    /// The asset this file is, whether added now or already present.
    pub asset_id: String,
    pub disposition: AssetDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AssetDisposition {
    /// Part of this batch's `assets`.
    Added,
    /// The same bytes as an earlier input in this batch; added once.
    DuplicateInBatch { first_source: String },
    /// The scene already holds these bytes; nothing is added for them.
    AlreadyInScene,
}

/// A refused import: the file it concerns and the named condition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportRefusal {
    pub source: String,
    pub refusal: Refusal,
}

impl fmt::Display for AssetImportRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.source, self.refusal)
    }
}

impl std::error::Error for AssetImportRefusal {}

/// What a file's bytes say it is.
struct Classified {
    kind: AssetKind,
    /// The library directory under `assets/`.
    directory: &'static str,
    extension: &'static str,
    mime: &'static str,
}

/// Verify, cache and describe a batch of files. See the module docs for the
/// all-or-nothing and identity guarantees.
// A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
#[allow(clippy::result_large_err)]
pub fn prepare_asset_files(
    store: &mut AssetStore,
    scene_assets: &[AssetLibraryItem],
    files: &[AssetFileInput<'_>],
) -> Result<PreparedAssetBatch, AssetImportRefusal> {
    if files.is_empty() {
        return Err(AssetImportRefusal {
            source: String::new(),
            refusal: Refusal::AssetBatchEmpty,
        });
    }

    let mut batch = PreparedAssetBatch {
        assets: Vec::new(),
        sources: Vec::new(),
    };
    let mut first_source: HashMap<ContentHash, String> = HashMap::new();
    let mut to_store: Vec<(&AssetFileInput<'_>, usize)> = Vec::new();
    for file in files {
        let refuse = |refusal: Refusal| AssetImportRefusal {
            source: file.file_name.clone(),
            refusal,
        };
        let hash = content_hash(file.bytes);
        let identity: String = hash.0.chars().take(16).collect();
        let classified = classify(file, &identity).map_err(refuse)?;

        if let Some(present) = scene_assets
            .iter()
            .find(|asset| asset.checksum.as_ref() == Some(&hash))
        {
            batch.sources.push(PreparedAssetSource {
                source: file.file_name.clone(),
                asset_id: present.asset_id.clone(),
                disposition: AssetDisposition::AlreadyInScene,
            });
            continue;
        }
        let asset_id = format!("asset_{}_{identity}", classified.directory);
        if let Some(first) = first_source.get(&hash) {
            batch.sources.push(PreparedAssetSource {
                source: file.file_name.clone(),
                asset_id,
                disposition: AssetDisposition::DuplicateInBatch {
                    first_source: first.clone(),
                },
            });
            continue;
        }
        first_source.insert(hash.clone(), file.file_name.clone());
        to_store.push((file, batch.assets.len()));
        batch.assets.push(AssetLibraryItem {
            asset_id: asset_id.clone(),
            name: file.file_name.clone(),
            kind: classified.kind,
            path: format!(
                "assets/{}/{identity}.{}",
                classified.directory, classified.extension
            ),
            checksum: Some(hash),
            mime_type: Some(classified.mime.into()),
            size_bytes: Some(file.bytes.len() as u64),
            status: Some(AssetAvailability::Ready),
            provenance: AssetProvenance {
                origin: Some(AssetOrigin::Human),
                tool: Some(ProvenanceTool {
                    name: ASSET_FILE_IMPORT_TOOL.into(),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                }),
                sources: vec![file.file_name.clone()],
                ..AssetProvenance::default()
            },
        });
        batch.sources.push(PreparedAssetSource {
            source: file.file_name.clone(),
            asset_id,
            disposition: AssetDisposition::Added,
        });
    }

    // Only now, with every input verified, does anything reach the cache.
    for (file, index) in to_store {
        let stored = store
            .import(batch.assets[index].clone(), file.bytes)
            .map_err(|error| AssetImportRefusal {
                source: file.file_name.clone(),
                refusal: match error {
                    AssetStoreError::Refusal(refusal) => refusal,
                    // The cache could not be written: nothing was decided
                    // about the file, the machine failed (invariant 17).
                    other => Refusal::TransportFailed {
                        detail: other.to_string(),
                    },
                },
            })?;
        debug_assert_eq!(Some(&stored), batch.assets[index].checksum.as_ref());
    }
    Ok(batch)
}

/// Name a file's format from its bytes: PNG and JPEG images (the formats
/// whose geometry the store can read), SVG, binary glTF, MP4/QuickTime and
/// Matroska/WebM video. A font is recognised so it can be refused toward the
/// font manager by name; anything else is unrecognised.
fn classify(file: &AssetFileInput<'_>, identity: &str) -> Result<Classified, Refusal> {
    let bytes = file.bytes;
    let found = |kind, directory, extension, mime| Classified {
        kind,
        directory,
        extension,
        mime,
    };
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        read_image_geometry(bytes)?;
        return Ok(if bytes[0] == 0x89 {
            found(AssetKind::Image, "images", "png", "image/png")
        } else {
            found(AssetKind::Image, "images", "jpg", "image/jpeg")
        });
    }
    if bytes.starts_with(b"glTF") {
        return Ok(found(
            AssetKind::Model,
            "models",
            "glb",
            "model/gltf-binary",
        ));
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        return Ok(if bytes.get(8..12) == Some(b"qt  ") {
            found(AssetKind::Video, "video", "mov", "video/quicktime")
        } else {
            found(AssetKind::Video, "video", "mp4", "video/mp4")
        });
    }
    if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        let head = &bytes[..bytes.len().min(64)];
        return Ok(if head.windows(4).any(|window| window == b"webm") {
            found(AssetKind::Video, "video", "webm", "video/webm")
        } else {
            found(AssetKind::Video, "video", "mkv", "video/x-matroska")
        });
    }
    let font_magic: [&[u8]; 6] = [
        b"\x00\x01\x00\x00",
        b"OTTO",
        b"true",
        b"ttcf",
        b"wOFF",
        b"wOF2",
    ];
    if font_magic.iter().any(|magic| bytes.starts_with(magic)) {
        return Err(Refusal::AssetKindNotAddable {
            asset_id: format!("asset_font_{identity}"),
            kind: AssetKind::Font,
        });
    }
    // SVG is text: skip a byte-order mark and leading whitespace, then look
    // for the root element near the start (after any XML prolog or comment).
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head.strip_prefix(b"\xef\xbb\xbf").unwrap_or(head));
    let text = text.trim_start();
    if (text.starts_with("<svg") || text.starts_with("<?xml") || text.starts_with("<!--"))
        && text.contains("<svg")
    {
        return Ok(found(AssetKind::Svg, "svg", "svg", "image/svg+xml"));
    }
    Err(Refusal::AssetFormatUnrecognised {
        file: file.file_name.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    fn store() -> (AssetStore, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gx-asset-import-{}-{nanos}", std::process::id()));
        (AssetStore::at_root(root.clone()), root)
    }

    #[test]
    fn an_import_fills_origin_and_tool_and_the_same_file_twice_is_one_asset() {
        let (mut store, root) = store();
        let logo = png(320, 180);
        let svg =
            b"\xef\xbb\xbf  <?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        let files = [
            AssetFileInput {
                file_name: "logo.png".into(),
                bytes: &logo,
            },
            AssetFileInput {
                file_name: "copy-of-logo.png".into(),
                bytes: &logo,
            },
            AssetFileInput {
                file_name: "mark.svg".into(),
                bytes: svg,
            },
        ];
        let batch = prepare_asset_files(&mut store, &[], &files).unwrap();

        assert_eq!(batch.assets.len(), 2);
        let image = &batch.assets[0];
        assert_eq!(
            (image.kind, image.mime_type.as_deref()),
            (AssetKind::Image, Some("image/png"))
        );
        assert_eq!(image.provenance.origin, Some(AssetOrigin::Human));
        assert_eq!(
            image
                .provenance
                .tool
                .as_ref()
                .map(|tool| tool.name.as_str()),
            Some(ASSET_FILE_IMPORT_TOOL)
        );
        assert_eq!(image.provenance.sources, vec!["logo.png".to_string()]);
        assert_eq!(batch.assets[1].kind, AssetKind::Svg);
        assert_eq!(
            batch.sources[1].disposition,
            AssetDisposition::DuplicateInBatch {
                first_source: "logo.png".into()
            }
        );
        assert!(store.contains(image.checksum.as_ref().unwrap()).unwrap());

        // Importing the same bytes again, under any name, adds nothing.
        let again = prepare_asset_files(
            &mut store,
            &batch.assets,
            &[AssetFileInput {
                file_name: "renamed.png".into(),
                bytes: &logo,
            }],
        )
        .unwrap();
        assert!(again.assets.is_empty());
        assert_eq!(again.sources[0].asset_id, image.asset_id);
        assert_eq!(
            again.sources[0].disposition,
            AssetDisposition::AlreadyInScene
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn one_unreadable_file_refuses_the_batch_by_name_before_anything_is_cached() {
        let (mut store, root) = store();
        let logo = png(64, 64);
        let files = [
            AssetFileInput {
                file_name: "logo.png".into(),
                bytes: &logo,
            },
            AssetFileInput {
                file_name: "notes.png".into(),
                bytes: b"not an image at all",
            },
        ];
        let refused = prepare_asset_files(&mut store, &[], &files).unwrap_err();
        assert_eq!(refused.source, "notes.png");
        assert_eq!(
            refused.refusal,
            Refusal::AssetFormatUnrecognised {
                file: "notes.png".into()
            }
        );
        assert!(!store.contains(&content_hash(&logo)).unwrap());

        let font = [AssetFileInput {
            file_name: "Inter.otf".into(),
            bytes: b"OTTO\x00\x01",
        }];
        assert!(matches!(
            prepare_asset_files(&mut store, &[], &font)
                .unwrap_err()
                .refusal,
            Refusal::AssetKindNotAddable {
                kind: AssetKind::Font,
                ..
            }
        ));
        std::fs::remove_dir_all(root).ok();
    }
}
