//! The fonts installed on this workstation, and their import as WOFF2 or WOFF.
//!
//! **Listing reads a few tables, not whole files.** A Windows font folder holds
//! hundreds of files, some of them tens of megabytes (the CJK collections).
//! Listing opens each file, reads its table directory and only `head`, `hhea`,
//! `maxp`, `name`, `OS/2` and `post`, assembles those into a small sfnt and hands
//! that to the same `inspect_font` every other ingest path uses, so the family,
//! weight and style shown in the list are the ones the import will record.
//!
//! **A collection is listed face by face.** A `.ttc` is one file with several
//! faces; nothing in the font model carries a face index, so a face is taken
//! out of its collection as a standalone sfnt before it is converted and stored.
//!
//! **System fonts stay on this workstation.** They are always imported under
//! the `Restricted` embedding policy: a font that is installed here is licensed
//! to this machine, and a licence string in its naming table is not permission
//! to put its bytes in a package. Packaging a font is a decision about a font
//! file the author has the rights to, made through "Add font files".
//!
//! **Only the installed folders are read.** An import names a file and a face;
//! the file must sit directly in an installed font folder, so the command cannot
//! be asked to read an arbitrary path.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use allsorts::binary::read::ReadScope;
use allsorts::font_data::FontData;
use allsorts::tables::FontTableProvider;
use gx_contracts::font::{EmbeddingPolicy, FontFormat, FontStyle};
use gx_contracts::Refusal;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::convert::{convert_sfnt, FontConversionTarget};
use super::ingest::{
    prepare_font_files, FontFileInput, FontIngestRefusal, PreparedFontBatch, SceneFontLibrary,
};
use super::metadata::{inspect_font, sniff_format};
use crate::store::AssetStore;

/// The family a scene starts with when it has no font of its own.
pub const DEFAULT_FONT_FAMILY: &str = "Arial";

/// The largest font file read to take a face out of it (the CJK collections run to tens of megabytes).
const MAX_SYSTEM_FONT_FILE: u64 = 256 * 1024 * 1024;
/// The largest single table copied into a listing stub (`name` tables with many languages are the big ones).
const MAX_STUB_TABLE: u32 = 4 * 1024 * 1024;
/// A collection lists at most this many faces.
const MAX_COLLECTION_FACES: u32 = 256;
/// The tables the listing reads; `head`, `hhea`, `maxp` and `name` are required for the font to be parsed at all.
const STUB_TABLES: [&[u8; 4]; 6] = [b"head", b"hhea", b"maxp", b"name", b"OS/2", b"post"];

/// One installed face, as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontEntry {
    /// The font file, absolute.
    pub path: String,
    /// The face in a collection; 0 for a file that holds one.
    pub face_index: u32,
    pub file_name: String,
    pub family: String,
    pub display_name: String,
    /// CSS weight scale, 1 to 1000.
    pub weight: u16,
    pub style: FontStyle,
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// The file is a collection (`.ttc`/`.otc`) and this is one of its faces.
    pub collection: bool,
}

/// A font file that was in an installed folder and is not in the list, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSystemFont {
    pub file_name: String,
    pub reason: String,
}

/// What the installed folders hold. Nothing that could not be read is dropped
/// without being named in `skipped`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontScan {
    pub fonts: Vec<SystemFontEntry>,
    pub skipped: Vec<SkippedSystemFont>,
}

/// One face to import: a file in an installed folder, and the face in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontRequest {
    pub path: String,
    #[serde(default)]
    pub face_index: u32,
}

/// The folders Windows keeps installed fonts in: the machine's, then the user's.
pub fn installed_font_folders() -> Vec<PathBuf> {
    let mut folders = Vec::new();
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("WINDIR").or_else(|| std::env::var_os("SystemRoot")) {
            folders.push(PathBuf::from(root).join("Fonts"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            folders.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }
    folders
}

fn font_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    matches!(extension.as_str(), "ttf" | "otf" | "ttc" | "otc").then_some(extension)
}

/// List every face in `folders` (one level deep, as Windows keeps them).
pub fn scan_font_folders(folders: &[PathBuf]) -> SystemFontScan {
    let mut scan = SystemFontScan::default();
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if font_extension(&path).is_none() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            match scan_file(&path, &file_name) {
                Ok(mut faces) => scan.fonts.append(&mut faces),
                Err(reason) => scan.skipped.push(SkippedSystemFont { file_name, reason }),
            }
        }
    }
    scan.fonts.sort_by(|left, right| {
        (
            left.family.to_lowercase(),
            left.weight,
            left.style as u8,
            &left.path,
            left.face_index,
        )
            .cmp(&(
                right.family.to_lowercase(),
                right.weight,
                right.style as u8,
                &right.path,
                right.face_index,
            ))
    });
    scan.skipped
        .sort_by(|left, right| left.file_name.cmp(&right.file_name));
    scan
}

fn scan_file(path: &Path, file_name: &str) -> Result<Vec<SystemFontEntry>, String> {
    let mut file = File::open(path).map_err(|error| format!("cannot be opened: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("cannot be read: {error}"))?
        .len();
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)
        .map_err(|_| "is too short to be a font".to_string())?;
    let offsets: Vec<u64> = if &magic == b"ttcf" {
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|_| "has a cut-short collection header".to_string())?;
        let faces = u32::from_be_bytes(header[4..8].try_into().expect("four bytes"));
        if faces == 0 || faces > MAX_COLLECTION_FACES {
            return Err(format!("is a collection of {faces} faces"));
        }
        let mut table = vec![0u8; 4 * faces as usize];
        file.read_exact(&mut table)
            .map_err(|_| "has a cut-short collection header".to_string())?;
        table
            .chunks_exact(4)
            .map(|chunk| u64::from(u32::from_be_bytes(chunk.try_into().expect("four bytes"))))
            .collect()
    } else {
        vec![0]
    };
    let collection = &magic == b"ttcf";
    let mut faces = Vec::with_capacity(offsets.len());
    for (index, base) in offsets.iter().enumerate() {
        let stub = read_face_stub(&mut file, *base, length)?;
        let inspected = inspect_font(&stub)
            .map_err(|refusal| format!("is not readable as a font: {refusal}"))?;
        faces.push(SystemFontEntry {
            path: path.display().to_string(),
            face_index: index as u32,
            file_name: file_name.to_string(),
            family: inspected.family,
            display_name: inspected.display_name,
            weight: inspected.weight,
            style: inspected.style,
            size_bytes: length,
            collection,
        });
    }
    Ok(faces)
}

/// A small sfnt holding only the tables a listing reads, taken from the face
/// whose directory starts at `base`. Table offsets in a collection are absolute,
/// so the same reader serves a plain file and a face of a collection.
fn read_face_stub(file: &mut File, base: u64, length: u64) -> Result<Vec<u8>, String> {
    let short = || "is cut short".to_string();
    file.seek(SeekFrom::Start(base)).map_err(|_| short())?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header).map_err(|_| short())?;
    if !matches!(&header[..4], [0, 1, 0, 0] | b"OTTO" | b"true") {
        return Err("is not a TrueType or OpenType font".into());
    }
    let count = usize::from(u16::from_be_bytes([header[4], header[5]]));
    if count == 0 || count > 512 {
        return Err(format!("lists {count} tables"));
    }
    let mut directory = vec![0u8; 16 * count];
    file.read_exact(&mut directory).map_err(|_| short())?;

    let mut picked: Vec<([u8; 4], u32, Vec<u8>)> = Vec::new();
    for record in directory.chunks_exact(16) {
        let tag: [u8; 4] = record[..4].try_into().expect("four bytes");
        if !STUB_TABLES.iter().any(|wanted| **wanted == tag) {
            continue;
        }
        let checksum = u32::from_be_bytes(record[4..8].try_into().expect("four bytes"));
        let offset = u64::from(u32::from_be_bytes(
            record[8..12].try_into().expect("four bytes"),
        ));
        let size = u32::from_be_bytes(record[12..16].try_into().expect("four bytes"));
        if size > MAX_STUB_TABLE || offset + u64::from(size) > length {
            return Err(format!(
                "has a {} table outside the file",
                String::from_utf8_lossy(&tag)
            ));
        }
        let mut data = vec![0u8; size as usize];
        file.seek(SeekFrom::Start(offset)).map_err(|_| short())?;
        file.read_exact(&mut data).map_err(|_| short())?;
        picked.push((tag, checksum, data));
    }
    for required in [b"head", b"hhea", b"maxp", b"name"] {
        if !picked.iter().any(|(tag, ..)| tag == required) {
            return Err(format!(
                "has no {} table",
                String::from_utf8_lossy(required)
            ));
        }
    }
    picked.sort_by_key(|(tag, ..)| *tag);

    let mut out = Vec::new();
    out.extend_from_slice(&header[..4]);
    out.extend_from_slice(&(picked.len() as u16).to_be_bytes());
    out.extend_from_slice(&[0; 6]);
    let mut offset = 12 + 16 * picked.len();
    for (tag, checksum, data) in &picked {
        out.extend_from_slice(tag);
        out.extend_from_slice(&checksum.to_be_bytes());
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += (data.len() + 3) & !3;
    }
    for (_, _, data) in &picked {
        out.extend_from_slice(data);
        out.resize(out.len() + ((4 - data.len() % 4) % 4), 0);
    }
    Ok(out)
}

fn refuse(detail: impl Into<String>) -> Refusal {
    Refusal::InvalidFontData {
        detail: detail.into(),
    }
}

/// The font file a request names, if it sits directly in one of `folders`.
fn resolve_in_folders(path: &str, folders: &[PathBuf]) -> Result<PathBuf, Refusal> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| refuse(format!("{path}: cannot be read: {error}")))?;
    let inside = canonical.parent().is_some_and(|parent| {
        folders
            .iter()
            .any(|folder| std::fs::canonicalize(folder).is_ok_and(|folder| folder == parent))
    });
    if !inside || font_extension(&canonical).is_none() {
        return Err(refuse(format!(
            "{path}: is not a font file in an installed font folder"
        )));
    }
    Ok(canonical)
}

/// The face as a standalone sfnt: a plain file as it is, a face of a collection
/// rebuilt on its own.
pub fn read_system_face(path: &Path, face_index: u32) -> Result<Vec<u8>, Refusal> {
    let name = path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let length = std::fs::metadata(path)
        .map_err(|error| refuse(format!("{name}: cannot be read: {error}")))?
        .len();
    if length > MAX_SYSTEM_FONT_FILE {
        return Err(refuse(format!(
            "{name}: is {length} bytes, more than the {MAX_SYSTEM_FONT_FILE} a font import reads"
        )));
    }
    let bytes =
        std::fs::read(path).map_err(|error| refuse(format!("{name}: cannot be read: {error}")))?;
    if bytes.get(..4) == Some(b"ttcf") {
        let data = ReadScope::new(&bytes)
            .read::<FontData<'_>>()
            .map_err(|error| refuse(format!("{name}: collection could not be read: {error}")))?;
        let provider = data.table_provider(face_index as usize).map_err(|error| {
            refuse(format!(
                "{name}: face {face_index} could not be read: {error}"
            ))
        })?;
        let tags = provider
            .table_tags()
            .ok_or_else(|| refuse(format!("{name}: face {face_index} lists no tables")))?;
        return allsorts::subset::whole_font(&provider, &tags).map_err(|error| {
            refuse(format!(
                "{name}: face {face_index} could not be rebuilt: {error}"
            ))
        });
    }
    if face_index != 0 {
        return Err(refuse(format!(
            "{name}: is not a collection, so it has no face {face_index}"
        )));
    }
    match sniff_format(&bytes) {
        Some(FontFormat::Otf | FontFormat::Ttf) => Ok(bytes),
        _ => Err(refuse(format!(
            "{name}: is not a TrueType or OpenType font"
        ))),
    }
}

/// Take the named faces from the installed folders, convert each to `target`,
/// cache the bytes and prepare one `addFonts` batch (invariant 60: the scene is
/// not touched here). All or nothing, like every other ingest. The fonts are
/// `Restricted`: see the module notes.
// A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
#[allow(clippy::result_large_err)]
pub fn prepare_system_fonts(
    store: &mut AssetStore,
    scene: SceneFontLibrary<'_>,
    folders: &[PathBuf],
    requests: &[SystemFontRequest],
    target: FontConversionTarget,
) -> Result<PreparedFontBatch, FontIngestRefusal> {
    let mut converted: Vec<(String, Vec<u8>)> = Vec::with_capacity(requests.len());
    for request in requests {
        let refused = |refusal: Refusal| FontIngestRefusal {
            source: request.path.clone(),
            refusal,
        };
        let path = resolve_in_folders(&request.path, folders).map_err(refused)?;
        let sfnt = read_system_face(&path, request.face_index).map_err(refused)?;
        let font = convert_sfnt(&sfnt, target).map_err(refused)?;
        let stem = path.file_stem().map_or_else(
            || "font".to_string(),
            |stem| stem.to_string_lossy().into_owned(),
        );
        let extension = match font.format {
            FontFormat::Woff2 => "woff2",
            FontFormat::Woff => "woff",
            FontFormat::Otf => "otf",
            FontFormat::Ttf => "ttf",
        };
        let face = if request.face_index == 0 {
            String::new()
        } else {
            format!("-{}", request.face_index)
        };
        converted.push((format!("{stem}{face}.{extension}"), font.bytes));
    }
    let inputs: Vec<FontFileInput<'_>> = converted
        .iter()
        .map(|(file_name, bytes)| FontFileInput {
            file_name: file_name.clone(),
            bytes,
            embedding_policy: EmbeddingPolicy::Restricted,
            license: None,
        })
        .collect();
    prepare_font_files(store, scene, &inputs)
}

/// The faces a scene starts with when it has no font: regular, bold, italic and
/// bold italic of `family`, regular first (a new text object takes the scene's
/// first font). Faces the family lacks are left out; a family without a regular
/// face is refused by name.
pub fn default_font_requests_for(
    scan: &SystemFontScan,
    family: &str,
) -> Result<Vec<SystemFontRequest>, Refusal> {
    let wanted = [
        (400, FontStyle::Normal),
        (700, FontStyle::Normal),
        (400, FontStyle::Italic),
        (700, FontStyle::Italic),
    ];
    let mut requests = Vec::new();
    for (weight, style) in wanted {
        let found = scan.fonts.iter().find(|entry| {
            entry.family.eq_ignore_ascii_case(family)
                && entry.weight == weight
                && entry.style == style
                && !entry.collection
        });
        match found {
            Some(entry) => requests.push(SystemFontRequest {
                path: entry.path.clone(),
                face_index: entry.face_index,
            }),
            None if weight == 400 && style == FontStyle::Normal => {
                return Err(refuse(format!("{family} Regular is not installed on this PC, so it cannot be the default font")));
            }
            None => {}
        }
    }
    Ok(requests)
}

/// [`default_font_requests_for`] the default family.
pub fn default_font_requests(scan: &SystemFontScan) -> Result<Vec<SystemFontRequest>, Refusal> {
    default_font_requests_for(scan, DEFAULT_FONT_FAMILY)
}

/// Prepare the default font (Arial) from the installed folders, converted to `target`.
// A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
#[allow(clippy::result_large_err)]
pub fn prepare_default_font(
    store: &mut AssetStore,
    scene: SceneFontLibrary<'_>,
    folders: &[PathBuf],
    target: FontConversionTarget,
) -> Result<PreparedFontBatch, FontIngestRefusal> {
    let scan = scan_font_folders(folders);
    let requests = default_font_requests(&scan).map_err(|refusal| FontIngestRefusal {
        source: DEFAULT_FONT_FAMILY.to_string(),
        refusal,
    })?;
    prepare_system_fonts(store, scene, folders, &requests, target)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::fonts::container::verify_font_file;
    use crate::fonts::ingest::FontDisposition;

    const TTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.ttf");
    const OTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.otf");

    fn scratch(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "gx-system-fonts-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// The fixture as a one-face collection: a `ttcf` header and the sfnt, its table offsets moved to match.
    fn collection_of(sfnt: &[u8]) -> Vec<u8> {
        let shift = 16u32;
        let mut face = sfnt.to_vec();
        let count = usize::from(u16::from_be_bytes([face[4], face[5]]));
        for index in 0..count {
            let at = 12 + 16 * index + 8;
            let offset = u32::from_be_bytes(face[at..at + 4].try_into().unwrap()) + shift;
            face[at..at + 4].copy_from_slice(&offset.to_be_bytes());
        }
        let mut out = b"ttcf".to_vec();
        out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(&shift.to_be_bytes());
        out.extend_from_slice(&face);
        out
    }

    fn folder_with(files: &[(&str, &[u8])]) -> PathBuf {
        let folder = scratch("folder");
        for (name, bytes) in files {
            std::fs::write(folder.join(name), bytes).unwrap();
        }
        folder
    }

    #[test]
    fn the_listing_reads_family_weight_and_style_from_the_files() {
        let folder = folder_with(&[
            ("inter.ttf", TTF),
            ("inter-cff.OTF", OTF),
            ("notes.txt", b"not a font"),
            ("broken.ttf", b"this is not a font at all"),
        ]);
        let scan = scan_font_folders(&[folder.clone(), folder.join("missing")]);
        assert_eq!(scan.fonts.len(), 2, "{scan:?}");
        for font in &scan.fonts {
            assert_eq!(font.family, "Inter");
            assert_eq!(font.weight, 400);
            assert_eq!(font.style, FontStyle::Normal);
            assert_eq!(font.face_index, 0);
            assert!(!font.collection);
        }
        // The file that is no font is named, with a reason, not dropped silently; a text file is not a candidate.
        assert_eq!(scan.skipped.len(), 1);
        assert_eq!(scan.skipped[0].file_name, "broken.ttf");
        assert!(
            scan.skipped[0].reason.contains("too short")
                || scan.skipped[0].reason.contains("not a TrueType"),
            "{}",
            scan.skipped[0].reason
        );
        // The stub the listing builds answers as the whole font does.
        let whole = inspect_font(TTF).unwrap();
        assert_eq!(
            scan.fonts
                .iter()
                .find(|f| f.file_name == "inter.ttf")
                .unwrap()
                .display_name,
            whole.display_name
        );
    }

    #[test]
    fn a_collection_is_listed_face_by_face_and_a_face_comes_out_whole() {
        let folder = folder_with(&[("pair.ttc", &collection_of(TTF))]);
        let scan = scan_font_folders(std::slice::from_ref(&folder));
        assert_eq!(scan.fonts.len(), 1, "{scan:?}");
        assert!(scan.fonts[0].collection);
        assert_eq!(scan.fonts[0].family, "Inter");
        let sfnt = read_system_face(&folder.join("pair.ttc"), 0).unwrap();
        assert!(ttf_parser::Face::parse(&sfnt, 0).is_ok());
        assert!(matches!(
            read_system_face(&folder.join("pair.ttc"), 5),
            Err(Refusal::InvalidFontData { .. })
        ));
        // A plain file has no second face.
        let plain = folder_with(&[("one.ttf", TTF)]);
        assert!(matches!(
            read_system_face(&plain.join("one.ttf"), 1),
            Err(Refusal::InvalidFontData { detail }) if detail.contains("not a collection")
        ));
    }

    #[test]
    fn an_import_converts_caches_and_keeps_the_font_on_this_workstation() {
        let folder = folder_with(&[("inter.ttf", TTF)]);
        let cache = scratch("cache");
        let mut store = AssetStore::at_root(cache.clone());
        let request = SystemFontRequest {
            path: folder.join("inter.ttf").display().to_string(),
            face_index: 0,
        };
        let library = SceneFontLibrary {
            fonts: &[],
            assets: &[],
        };

        let batch = prepare_system_fonts(
            &mut store,
            library,
            std::slice::from_ref(&folder),
            std::slice::from_ref(&request),
            FontConversionTarget::Woff2,
        )
        .unwrap();
        assert_eq!(batch.fonts.len(), 1);
        let font = &batch.fonts[0];
        assert_eq!(font.family, "Inter");
        assert_eq!(font.embedding_policy, EmbeddingPolicy::Restricted);
        assert_eq!(batch.assets.len(), 1);
        assert_eq!(batch.assets[0].name, "inter.woff2");
        assert_eq!(batch.assets[0].mime_type.as_deref(), Some("font/woff2"));
        assert!(batch.assets[0].size_bytes.unwrap() < TTF.len() as u64);
        // What was cached is the converted font, and it verifies.
        let hash = batch.assets[0].checksum.clone().unwrap();
        let cached = std::fs::read(store.cache_path(&hash)).unwrap();
        assert_eq!(verify_font_file(&cached).unwrap().format, FontFormat::Woff2);

        // The same font a second time is the same font: already in the scene.
        let again = prepare_system_fonts(
            &mut store,
            SceneFontLibrary {
                fonts: &batch.fonts,
                assets: &batch.assets,
            },
            std::slice::from_ref(&folder),
            std::slice::from_ref(&request),
            FontConversionTarget::Woff2,
        )
        .unwrap();
        assert!(again.fonts.is_empty());
        assert_eq!(
            again.sources[0].disposition,
            FontDisposition::AlreadyInScene
        );

        // WOFF and "keep" give their own containers.
        for (target, mime) in [
            (FontConversionTarget::Woff, "font/woff"),
            (FontConversionTarget::Keep, "font/ttf"),
        ] {
            let batch = prepare_system_fonts(
                &mut store,
                library,
                std::slice::from_ref(&folder),
                std::slice::from_ref(&request),
                target,
            )
            .unwrap();
            assert_eq!(batch.assets[0].mime_type.as_deref(), Some(mime));
        }
    }

    #[test]
    fn only_a_font_file_in_an_installed_folder_can_be_imported() {
        let folder = folder_with(&[("inter.ttf", TTF)]);
        let elsewhere = folder_with(&[("outside.ttf", TTF), ("inter.txt", TTF)]);
        let cache = scratch("cache");
        let mut store = AssetStore::at_root(cache.clone());
        let library = SceneFontLibrary {
            fonts: &[],
            assets: &[],
        };
        for path in [elsewhere.join("outside.ttf"), folder.join("missing.ttf")] {
            let request = SystemFontRequest {
                path: path.display().to_string(),
                face_index: 0,
            };
            let refused = prepare_system_fonts(
                &mut store,
                library,
                std::slice::from_ref(&folder),
                &[request],
                FontConversionTarget::Woff2,
            );
            assert!(
                matches!(
                    refused,
                    Err(FontIngestRefusal {
                        refusal: Refusal::InvalidFontData { .. },
                        ..
                    })
                ),
                "{path:?}"
            );
        }
        // A file in the folder with another extension, and a path that climbs out of it, are not font files of the folder either.
        std::fs::write(folder.join("notes.txt"), TTF).unwrap();
        let climbs = format!(
            "{}/../{}/outside.ttf",
            folder.display(),
            elsewhere.file_name().unwrap().to_string_lossy()
        );
        for path in [folder.join("notes.txt").display().to_string(), climbs] {
            let request = SystemFontRequest {
                path,
                face_index: 0,
            };
            assert!(prepare_system_fonts(
                &mut store,
                library,
                std::slice::from_ref(&folder),
                &[request],
                FontConversionTarget::Woff2
            )
            .is_err());
        }
        // Nothing reached the cache from a refused batch.
        assert!(prepare_system_fonts(
            &mut store,
            library,
            std::slice::from_ref(&folder),
            &[],
            FontConversionTarget::Woff2
        )
        .is_err());
    }

    fn entry(family: &str, weight: u16, style: FontStyle, collection: bool) -> SystemFontEntry {
        SystemFontEntry {
            path: format!("C:/Fonts/{family}-{weight}-{style:?}.ttf"),
            face_index: 0,
            file_name: "x.ttf".into(),
            family: family.into(),
            display_name: family.into(),
            weight,
            style,
            size_bytes: 1,
            collection,
        }
    }

    #[test]
    fn the_default_font_is_regular_first_then_the_rest_of_the_family() {
        let scan = SystemFontScan {
            fonts: vec![
                entry("Arial", 700, FontStyle::Italic, false),
                entry("Arial Black", 400, FontStyle::Normal, false),
                entry("Arial", 700, FontStyle::Normal, false),
                entry("Arial", 400, FontStyle::Normal, false),
                entry("Arial Narrow", 400, FontStyle::Normal, false),
                entry("arial", 400, FontStyle::Italic, false),
            ],
            skipped: Vec::new(),
        };
        let requests = default_font_requests(&scan).unwrap();
        let order: Vec<&str> = requests.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            order,
            [
                "C:/Fonts/Arial-400-Normal.ttf",
                "C:/Fonts/Arial-700-Normal.ttf",
                "C:/Fonts/arial-400-Italic.ttf",
                "C:/Fonts/Arial-700-Italic.ttf",
            ]
        );
        // A family with no regular face is refused by name; one missing a bold is not.
        let no_regular = SystemFontScan {
            fonts: vec![entry("Arial", 700, FontStyle::Normal, false)],
            skipped: Vec::new(),
        };
        assert!(matches!(
            default_font_requests(&no_regular),
            Err(Refusal::InvalidFontData { detail }) if detail.contains("Arial Regular is not installed")
        ));
        let only_regular = SystemFontScan {
            fonts: vec![entry("Arial", 400, FontStyle::Normal, false)],
            skipped: Vec::new(),
        };
        assert_eq!(default_font_requests(&only_regular).unwrap().len(), 1);
        // A face of a collection is not taken for a standalone one.
        let in_collection = SystemFontScan {
            fonts: vec![entry("Arial", 400, FontStyle::Normal, true)],
            skipped: Vec::new(),
        };
        assert!(default_font_requests(&in_collection).is_err());
    }

    #[test]
    fn the_default_family_can_be_prepared_end_to_end_from_a_folder() {
        let folder = folder_with(&[("inter.ttf", TTF)]);
        let scan = scan_font_folders(std::slice::from_ref(&folder));
        let requests = default_font_requests_for(&scan, "inter").unwrap();
        assert_eq!(requests.len(), 1);
        let cache = scratch("cache");
        let mut store = AssetStore::at_root(cache.clone());
        let batch = prepare_system_fonts(
            &mut store,
            SceneFontLibrary {
                fonts: &[],
                assets: &[],
            },
            &[folder],
            &requests,
            FontConversionTarget::Woff2,
        )
        .unwrap();
        assert_eq!(batch.fonts[0].family, "Inter");
        // With no Arial in the folder the real default is refused by name, not substituted.
        let refused = prepare_default_font(
            &mut store,
            SceneFontLibrary {
                fonts: &[],
                assets: &[],
            },
            &[scratch("empty")],
            FontConversionTarget::Woff2,
        );
        assert!(matches!(refused, Err(FontIngestRefusal { source, .. }) if source == "Arial"));
    }

    /// The real thing, on a PC that has it: Windows' own Arial listed, converted to both containers, decoded again and compared.
    /// Skipped (and says so) where Arial is not installed.
    #[cfg(windows)]
    #[test]
    fn the_installed_arial_converts_to_woff2_and_woff_and_reads_back() {
        let folders = installed_font_folders();
        let scan = scan_font_folders(&folders);
        let Ok(requests) = default_font_requests(&scan) else {
            eprintln!("Arial is not installed here; the installed-font check is skipped");
            return;
        };
        assert!(!requests.is_empty());
        for request in &requests {
            let path = resolve_in_folders(&request.path, &folders).unwrap();
            let sfnt = read_system_face(&path, request.face_index).unwrap();
            for target in [FontConversionTarget::Woff2, FontConversionTarget::Woff] {
                let converted = convert_sfnt(&sfnt, target).unwrap();
                let verified = verify_font_file(&converted.bytes).unwrap();
                assert_eq!(verified.inspected.family, "Arial");
                eprintln!(
                    "{} -> {:?}: {} -> {} bytes",
                    path.file_name().unwrap().to_string_lossy(),
                    target,
                    sfnt.len(),
                    converted.bytes.len()
                );
                assert!(converted.bytes.len() < sfnt.len());
            }
        }
    }
}
