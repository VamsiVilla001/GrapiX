//! Batch font ingest: bytes in, one scene batch out (11.13).
//!
//! Ingest is *preparation*. It verifies every input, writes the verified
//! bytes to the content-addressed `AssetStore` (SHA-256 dedupe,
//! temp-then-rename, invariant 28), and returns the font definitions and
//! asset library entries a caller submits as **one** `EditScene` command. It
//! never touches a scene: a cache write is not an authoring mutation
//! (invariant 60), and it cannot remove anything, so nothing leaves a scene
//! implicitly.
//!
//! **All or nothing.** Every input is verified before the first byte is
//! cached; one refusal returns the refusal — naming the file or URL — and no
//! fonts. A batch that half-succeeded would be an undo entry nobody asked for.
//!
//! **Identity is content-derived** (`manager`), so the same bytes ingested
//! twice in one batch, or again in a later call, keep the same font, face
//! and asset ids. What the scene already carries is reported, not re-added.

use std::collections::HashMap;
use std::fmt;

use gx_contracts::font::{EmbeddingPolicy, FontDefinition, FontFormat};
use gx_contracts::provenance::{AssetOrigin, AssetProvenance, ProvenanceTool};
use gx_contracts::scene::{AssetAvailability, AssetKind, AssetLibraryItem};
use gx_contracts::{ContentHash, Refusal};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::container::verify_font_file;
use super::manager::{create_file_font_definition, FileFontOptions};
use super::validate::validate_font_definition;
use crate::store::{content_hash, AssetStore};

/// The tool a font file import records in each asset's provenance (11.39).
pub const FONT_FILE_IMPORT_TOOL: &str = "GrapiX font file import";

/// One font file to ingest, with the licensing decision made for it.
#[derive(Debug, Clone)]
pub struct FontFileInput<'a> {
    /// Shown to the author and named in any refusal. Never consulted for the
    /// container: the bytes' magic decides that.
    pub file_name: String,
    pub bytes: &'a [u8],
    /// `Package` needs a licence: this one, or else the one the font records
    /// in its naming table. `Restricted` keeps bytes on this workstation.
    /// `Reference` is refused — a local file has nothing to resolve remotely.
    pub embedding_policy: EmbeddingPolicy,
    /// A licence the author declares. Wins over the naming table's.
    pub license: Option<String>,
}

/// What the target scene already carries, so the batch adds only the new.
#[derive(Debug, Clone, Copy)]
pub struct SceneFontLibrary<'a> {
    pub fonts: &'a [FontDefinition],
    pub assets: &'a [AssetLibraryItem],
}

/// Fonts and assets to add in one scene edit, plus what happened to each input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFontBatch {
    /// New to the scene, in input order. Empty when every input was a duplicate.
    pub fonts: Vec<FontDefinition>,
    /// Library entries the new fonts' faces need that the scene lacks.
    pub assets: Vec<AssetLibraryItem>,
    /// One entry per font the inputs produced, in input order.
    pub sources: Vec<PreparedFontSource>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFontSource {
    /// The file name, or the link a downloaded family came from.
    pub source: String,
    pub font_id: String,
    pub display_name: String,
    /// Content addresses of the bytes behind the font's faces.
    pub content_hashes: Vec<ContentHash>,
    pub disposition: FontDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FontDisposition {
    /// Part of this batch's `fonts`.
    Added,
    /// Same identity as an earlier input in this batch; added once.
    DuplicateInBatch { first_source: String },
    /// The scene already carries this font id; nothing is added for it.
    AlreadyInScene,
}

/// A refused ingest: the input it concerns and the named condition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FontIngestRefusal {
    pub source: String,
    pub refusal: Refusal,
}

impl fmt::Display for FontIngestRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.source, self.refusal)
    }
}

impl std::error::Error for FontIngestRefusal {}

/// Verify, cache and define a batch of font files. See the module docs for
/// the all-or-nothing and identity guarantees.
// A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
#[allow(clippy::result_large_err)]
pub fn prepare_font_files(
    store: &mut AssetStore,
    scene: SceneFontLibrary<'_>,
    files: &[FontFileInput<'_>],
) -> Result<PreparedFontBatch, FontIngestRefusal> {
    if files.is_empty() {
        return Err(FontIngestRefusal {
            source: String::new(),
            refusal: Refusal::InvalidFontData {
                detail: "no font files were supplied".into(),
            },
        });
    }

    let mut builder = BatchBuilder::new(scene);
    let mut to_store: Vec<(AssetLibraryItem, &[u8], &str)> = Vec::new();
    for file in files {
        let refuse = |refusal: Refusal| FontIngestRefusal {
            source: file.file_name.clone(),
            refusal,
        };
        let verified = verify_font_file(file.bytes).map_err(refuse)?;
        let hash = content_hash(file.bytes);
        let asset = font_asset_item(
            &hash,
            verified.format,
            &file.file_name,
            file.bytes.len(),
            AssetProvenance {
                origin: Some(AssetOrigin::Human),
                tool: Some(ProvenanceTool {
                    name: FONT_FILE_IMPORT_TOOL.into(),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                }),
                sources: vec![file.file_name.clone()],
                ..AssetProvenance::default()
            },
        );
        let declared = file
            .license
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let font = create_file_font_definition(
            &asset.asset_id,
            &hash.0,
            verified.format,
            &FileFontOptions {
                family: verified.inspected.family,
                display_name: Some(verified.inspected.display_name),
                weight: verified.inspected.weight,
                style: verified.inspected.style,
                fallback_families: Vec::new(),
                embedding_policy: file.embedding_policy,
                license: declared.or(verified.inspected.license),
            },
        )
        .map_err(refuse)?;
        builder.add(&file.file_name, font, vec![asset.clone()])?;
        if !to_store
            .iter()
            .any(|(stored, ..)| stored.asset_id == asset.asset_id)
        {
            to_store.push((asset, file.bytes, &file.file_name));
        }
    }

    // Only now, with every input verified, does anything reach the cache.
    for (asset, bytes, source) in to_store {
        store_font_asset(store, &asset, bytes, source)?;
    }
    Ok(builder.finish())
}

/// The library entry for verified font bytes. Id and path derive from the
/// content hash, so the same bytes always land at the same address and two
/// different files that share a name cannot collide.
pub(crate) fn font_asset_item(
    hash: &ContentHash,
    format: FontFormat,
    name: &str,
    size_bytes: usize,
    provenance: AssetProvenance,
) -> AssetLibraryItem {
    let identity: String = hash.0.chars().take(16).collect();
    let (extension, mime) = match format {
        FontFormat::Otf => ("otf", "font/otf"),
        FontFormat::Ttf => ("ttf", "font/ttf"),
        FontFormat::Woff => ("woff", "font/woff"),
        FontFormat::Woff2 => ("woff2", "font/woff2"),
    };
    AssetLibraryItem {
        asset_id: format!("asset_font_{identity}"),
        name: name.to_string(),
        kind: AssetKind::Font,
        path: format!("assets/fonts/{identity}.{extension}"),
        checksum: Some(hash.clone()),
        mime_type: Some(mime.to_string()),
        size_bytes: Some(size_bytes as u64),
        status: Some(AssetAvailability::Ready),
        provenance,
    }
}

/// Cache verified bytes through the store's one write path.
// A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
#[allow(clippy::result_large_err)]
pub(crate) fn store_font_asset(
    store: &mut AssetStore,
    asset: &AssetLibraryItem,
    bytes: &[u8],
    source: &str,
) -> Result<(), FontIngestRefusal> {
    let hash = store
        .import(asset.clone(), bytes)
        .map_err(|error| FontIngestRefusal {
            source: source.to_string(),
            refusal: Refusal::FontCacheWriteFailed {
                path: asset.path.clone(),
                detail: error.to_string(),
            },
        })?;
    debug_assert_eq!(Some(&hash), asset.checksum.as_ref());
    Ok(())
}

/// Collects one batch, deduplicating against the scene and itself.
pub(crate) struct BatchBuilder<'s> {
    scene: SceneFontLibrary<'s>,
    batch: PreparedFontBatch,
    first_source: HashMap<String, String>,
}

impl<'s> BatchBuilder<'s> {
    pub(crate) fn new(scene: SceneFontLibrary<'s>) -> Self {
        Self {
            scene,
            batch: PreparedFontBatch {
                fonts: Vec::new(),
                assets: Vec::new(),
                sources: Vec::new(),
            },
            first_source: HashMap::new(),
        }
    }

    /// Record one font and the assets behind its faces.
    // A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
    #[allow(clippy::result_large_err)]
    pub(crate) fn add(
        &mut self,
        source: &str,
        font: FontDefinition,
        face_assets: Vec<AssetLibraryItem>,
    ) -> Result<(), FontIngestRefusal> {
        let refuse = |refusal: Refusal| FontIngestRefusal {
            source: source.to_string(),
            refusal,
        };
        // An id the scene already uses for other bytes cannot be reused
        // silently: either copy would be a substitution for the other.
        for asset in &face_assets {
            if let Some(existing) = self
                .scene
                .assets
                .iter()
                .find(|existing| existing.asset_id == asset.asset_id)
            {
                if existing.checksum != asset.checksum {
                    return Err(refuse(Refusal::InvalidFontData {
                        detail: format!(
                            "asset {} already exists in the scene with different bytes",
                            asset.asset_id
                        ),
                    }));
                }
            }
        }

        let disposition = if self
            .scene
            .fonts
            .iter()
            .any(|existing| existing.font_id == font.font_id)
        {
            FontDisposition::AlreadyInScene
        } else if let Some(first) = self.first_source.get(&font.font_id) {
            FontDisposition::DuplicateInBatch {
                first_source: first.clone(),
            }
        } else {
            FontDisposition::Added
        };

        self.batch.sources.push(PreparedFontSource {
            source: source.to_string(),
            font_id: font.font_id.clone(),
            display_name: font.display_name.clone(),
            content_hashes: face_assets
                .iter()
                .filter_map(|asset| asset.checksum.clone())
                .collect(),
            disposition: disposition.clone(),
        });
        self.first_source
            .entry(font.font_id.clone())
            .or_insert_with(|| source.to_string());
        if disposition != FontDisposition::Added {
            return Ok(());
        }

        for asset in face_assets {
            let known = self
                .scene
                .assets
                .iter()
                .chain(&self.batch.assets)
                .any(|existing| existing.asset_id == asset.asset_id);
            if !known {
                self.batch.assets.push(asset);
            }
        }
        // The definition must pass the same validator preflight runs, against
        // the library it will live in.
        let (scene_assets, batch_assets) = (self.scene.assets, &self.batch.assets);
        validate_font_definition(&font, |asset_id| {
            scene_assets
                .iter()
                .chain(batch_assets)
                .any(|asset| asset.asset_id == asset_id && asset.kind == AssetKind::Font)
        })
        .map_err(refuse)?;
        self.batch.fonts.push(font);
        Ok(())
    }

    pub(crate) fn finish(self) -> PreparedFontBatch {
        self.batch
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use gx_contracts::font::{FontSource, FontStyle};

    use super::*;

    const TTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.ttf");
    const OTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.otf");
    const WOFF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.woff");
    const WOFF2: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.woff2");
    const UNLICENSED: &[u8] =
        include_bytes!("../../tests/fixtures/fonts/inter-latin-unlicensed.ttf");

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn store() -> (AssetStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "gx-asset-plane-font-ingest-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        (AssetStore::at_root(root.clone()), root)
    }

    fn input<'a>(name: &str, bytes: &'a [u8], policy: EmbeddingPolicy) -> FontFileInput<'a> {
        FontFileInput {
            file_name: name.into(),
            bytes,
            embedding_policy: policy,
            license: None,
        }
    }

    const EMPTY: SceneFontLibrary<'static> = SceneFontLibrary {
        fonts: &[],
        assets: &[],
    };

    #[test]
    fn four_containers_in_one_batch_are_cached_deduplicated_and_defined() {
        let (mut store, root) = store();
        let files = [
            input("Inter.ttf", TTF, EmbeddingPolicy::Package),
            input("Inter.otf", OTF, EmbeddingPolicy::Package),
            input("Inter.woff", WOFF, EmbeddingPolicy::Package),
            input("Inter.woff2", WOFF2, EmbeddingPolicy::Package),
            input("copy of Inter.ttf", TTF, EmbeddingPolicy::Package),
        ];
        let batch = prepare_font_files(&mut store, EMPTY, &files).expect("batch ingests");

        assert_eq!(batch.fonts.len(), 4);
        assert_eq!(batch.assets.len(), 4);
        assert_eq!(batch.sources.len(), 5);
        assert_eq!(
            batch.sources[4].disposition,
            FontDisposition::DuplicateInBatch {
                first_source: "Inter.ttf".into()
            }
        );
        assert_eq!(batch.sources[4].font_id, batch.sources[0].font_id);

        for ((font, asset), (bytes, format)) in batch.fonts.iter().zip(&batch.assets).zip([
            (TTF, FontFormat::Ttf),
            (OTF, FontFormat::Otf),
            (WOFF, FontFormat::Woff),
            (WOFF2, FontFormat::Woff2),
        ]) {
            let hash = content_hash(bytes);
            assert_eq!(asset.checksum.as_ref(), Some(&hash));
            assert_eq!(font.font_id, format!("font_{}", &hash.0[..16]));
            assert!(store.contains(&hash).unwrap(), "verified bytes are cached");
            // Metadata comes from the file, never from its name.
            assert_eq!(font.family, "Inter");
            assert_eq!(font.display_name, "Inter Regular");
            assert_eq!(font.faces[0].weight, 400);
            assert_eq!(font.faces[0].style, FontStyle::Normal);
            assert_eq!(
                font.faces[0].source,
                FontSource::File {
                    asset_id: asset.asset_id.clone(),
                    format,
                    original_url: None,
                    stylesheet_url: None,
                }
            );
            // Package policy took the licence the font itself records.
            assert_eq!(font.embedding_policy, EmbeddingPolicy::Package);
            assert!(font
                .license
                .as_deref()
                .is_some_and(|l| l.contains("SIL Open Font License")));
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_repeated_ingest_keeps_identity_and_adds_nothing() {
        let (mut store, root) = store();
        let files = [
            input("Inter.ttf", TTF, EmbeddingPolicy::Package),
            input("Inter.woff2", WOFF2, EmbeddingPolicy::Package),
        ];
        let first = prepare_font_files(&mut store, EMPTY, &files).unwrap();
        let scene = SceneFontLibrary {
            fonts: &first.fonts,
            assets: &first.assets,
        };
        let again = prepare_font_files(&mut store, scene, &files).unwrap();

        assert!(again.fonts.is_empty());
        assert!(again.assets.is_empty());
        let ids = |batch: &PreparedFontBatch| -> Vec<String> {
            batch.sources.iter().map(|s| s.font_id.clone()).collect()
        };
        assert_eq!(ids(&again), ids(&first));
        assert!(again
            .sources
            .iter()
            .all(|s| s.disposition == FontDisposition::AlreadyInScene));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn one_invalid_file_refuses_the_batch_by_name_before_anything_is_cached() {
        let (mut store, root) = store();
        let files = [
            input("Inter.ttf", TTF, EmbeddingPolicy::Package),
            input("broken.woff2", &WOFF2[..64], EmbeddingPolicy::Package),
        ];
        let refusal = prepare_font_files(&mut store, EMPTY, &files).unwrap_err();
        assert_eq!(refusal.source, "broken.woff2");
        assert!(matches!(refusal.refusal, Refusal::InvalidFontData { .. }));
        assert!(
            !store.contains(&content_hash(TTF)).unwrap(),
            "the valid file must not be cached when its batch is refused"
        );

        let not_a_font = [input("notes.ttf", b"plain text", EmbeddingPolicy::Package)];
        let refusal = prepare_font_files(&mut store, EMPTY, &not_a_font).unwrap_err();
        assert_eq!(refusal.source, "notes.ttf");
        assert!(matches!(refusal.refusal, Refusal::InvalidFontData { .. }));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn licensing_is_preserved_never_assumed() {
        let (mut store, root) = store();
        // No licence anywhere and package requested: refused, naming the font.
        let refusal = prepare_font_files(
            &mut store,
            EMPTY,
            &[input("Unlicensed.ttf", UNLICENSED, EmbeddingPolicy::Package)],
        )
        .unwrap_err();
        assert_eq!(refusal.source, "Unlicensed.ttf");
        assert_eq!(
            refusal.refusal,
            Refusal::FontEmbeddingRefused {
                font_id: format!("font_{}", &content_hash(UNLICENSED).0[..16])
            }
        );

        // Restricted keeps the bytes local and needs no licence.
        let restricted = prepare_font_files(
            &mut store,
            EMPTY,
            &[input("Unlicensed.ttf", UNLICENSED, EmbeddingPolicy::Restricted)],
        )
        .unwrap();
        assert_eq!(restricted.fonts[0].embedding_policy, EmbeddingPolicy::Restricted);
        assert_eq!(restricted.fonts[0].license, None);

        // A declared licence wins over the naming table's.
        let declared = FontFileInput {
            license: Some("Commercial desktop + broadcast, PO 4411".into()),
            ..input("Unlicensed.ttf", UNLICENSED, EmbeddingPolicy::Package)
        };
        let packaged = prepare_font_files(&mut store, EMPTY, &[declared]).unwrap();
        assert_eq!(
            packaged.fonts[0].license.as_deref(),
            Some("Commercial desktop + broadcast, PO 4411")
        );

        // Reference has no meaning for local bytes.
        let reference = prepare_font_files(
            &mut store,
            EMPTY,
            &[input("Inter.ttf", TTF, EmbeddingPolicy::Reference)],
        )
        .unwrap_err();
        assert!(matches!(reference.refusal, Refusal::InvalidFontData { .. }));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn an_asset_id_bound_to_other_bytes_is_refused() {
        let (mut store, root) = store();
        let mut impostor = font_asset_item(
            &content_hash(TTF),
            FontFormat::Ttf,
            "Inter.ttf",
            TTF.len(),
            AssetProvenance::default(),
        );
        impostor.checksum = Some(content_hash(b"other bytes"));
        let scene = SceneFontLibrary {
            fonts: &[],
            assets: std::slice::from_ref(&impostor),
        };
        let refusal = prepare_font_files(
            &mut store,
            scene,
            &[input("Inter.ttf", TTF, EmbeddingPolicy::Package)],
        )
        .unwrap_err();
        assert!(matches!(
            refusal.refusal,
            Refusal::InvalidFontData { detail } if detail.contains(&impostor.asset_id)
        ));
        std::fs::remove_dir_all(root).ok();
    }
}
