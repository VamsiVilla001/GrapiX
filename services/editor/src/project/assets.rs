//! The files a project holds (build plan 11.43, user decisions 22 Nov 2026): plain files in the
//! project's own folders, beside its `.gpx`, the way an XPression, Viz or After Effects project
//! keeps its media.
//!
//! ```text
//! <Project>/<Project>.gpx
//!   Assets/Images/<folder>/   png, webp, jpg, jpeg, svg
//!   Assets/Videos/<folder>/   mp4, mov, avi, webm
//!   Assets/Audio/<folder>/    wav, mp3
//!   Assets/Models/<folder>/   gltf, glb, obj, fbx, stl, ply, dae, usd, usdz
//!   Fonts/<folder>/           otf, ttf, woff, woff2
//! ```
//!
//! What this module holds to:
//! - **The bytes decide the format**, not the name. A `.png` that is a WebP, a `.ttf` that is a
//!   picture, or anything that is none of the listed formats is refused by name. A text format
//!   (OBJ, glTF, SVG, DAE) must at least look like one.
//! - **An import never overwrites.** The same bytes filed again are a no-op; different bytes under
//!   the same name refuse, because the scenes that use the file would change under their feet.
//! - **A name is one canonical component** (a folder, then a file), so no import can leave the
//!   project's media folders.
//! - **The folder is the truth.** A file swapped on disk is the new file; nothing here keeps a
//!   second copy that could go stale. A file is found by content through a hash cache keyed on its
//!   length and modified time, so publish and the viewport read it with `read_asset` without
//!   knowing which folder it lives in, and a large video is hashed once, as a stream.
//! - A file is **detected, not validated**: this is a header check, not a decoder. Whether the
//!   engine can draw a given codec or mesh is the engine's answer, given at publish.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use gx_contracts::font::FontFormat;
use gx_contracts::project::{
    ASSETS_FOLDER, AUDIO_EXTENSIONS, AUDIO_FOLDER, FONTS_FOLDER, FONT_EXTENSIONS, IMAGES_FOLDER,
    IMAGE_EXTENSIONS, MODELS_FOLDER, MODEL_EXTENSIONS, VIDEOS_FOLDER, VIDEO_EXTENSIONS,
};
use gx_contracts::provenance::{AssetOrigin, AssetProvenance, ProvenanceTool};
use gx_contracts::scene::{AssetKind, AssetLibraryItem};
use gx_contracts::{ContentHash, Refusal};
use sha2::{Digest, Sha256};

use super::{EditorError, Projects};

/// The largest side of a picture taken, in pixels (the engine's own bound is lower).
pub const MAX_IMAGE_SIDE: u32 = 16_384;
const MIB: u64 = 1024 * 1024;

/// How much of a file is read to decide what it is.
const HEAD_BYTES: usize = 1024 * 1024;

/// The five kinds of file a project holds, each with its own folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetClass {
    Image,
    Video,
    Audio,
    Model,
    Font,
}

impl AssetClass {
    pub const ALL: [AssetClass; 5] = [
        Self::Image,
        Self::Video,
        Self::Audio,
        Self::Model,
        Self::Font,
    ];

    /// The folder, relative to the project: `Assets/Images`, ..., `Fonts`.
    pub fn folder(self) -> String {
        match self {
            Self::Image => format!("{ASSETS_FOLDER}/{IMAGES_FOLDER}"),
            Self::Video => format!("{ASSETS_FOLDER}/{VIDEOS_FOLDER}"),
            Self::Audio => format!("{ASSETS_FOLDER}/{AUDIO_FOLDER}"),
            Self::Model => format!("{ASSETS_FOLDER}/{MODELS_FOLDER}"),
            Self::Font => FONTS_FOLDER.to_owned(),
        }
    }

    /// The extensions a file of this class may carry.
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Image => &IMAGE_EXTENSIONS,
            Self::Video => &VIDEO_EXTENSIONS,
            Self::Audio => &AUDIO_EXTENSIONS,
            Self::Model => &MODEL_EXTENSIONS,
            Self::Font => &FONT_EXTENSIONS,
        }
    }

    /// The largest file of this class taken, in bytes. A bound, not a target.
    pub fn max_bytes(self) -> u64 {
        match self {
            Self::Image => 64 * MIB,
            Self::Font => 32 * MIB,
            Self::Audio | Self::Model => 1024 * MIB,
            Self::Video => 8 * 1024 * MIB,
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Image => "img",
            Self::Video => "vid",
            Self::Audio => "aud",
            Self::Model => "mdl",
            Self::Font => "font",
        }
    }
}

/// What a file's own bytes say about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub class: AssetClass,
    /// The extensions this format may be filed under (`jpg` and `jpeg`; `mp4` and `mov`).
    pub extensions: &'static [&'static str],
    pub mime: &'static str,
    pub kind: AssetKind,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub font: Option<FontFormat>,
}

fn found(
    class: AssetClass,
    extensions: &'static [&'static str],
    mime: &'static str,
    kind: AssetKind,
) -> Detected {
    Detected {
        class,
        extensions,
        mime,
        kind,
        width: None,
        height: None,
        font: None,
    }
}

fn image(
    extensions: &'static [&'static str],
    mime: &'static str,
    kind: AssetKind,
    size: Option<(u32, u32)>,
) -> Option<Detected> {
    let mut d = found(AssetClass::Image, extensions, mime, kind);
    if let Some((w, h)) = size {
        if !((1..=MAX_IMAGE_SIDE).contains(&w) && (1..=MAX_IMAGE_SIDE).contains(&h)) {
            return None;
        }
        d.width = Some(w);
        d.height = Some(h);
    }
    Some(d)
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 3)?;
    Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
}

/// `\x89PNG\r\n\x1a\n`, then the IHDR chunk first, carrying width and height.
fn png(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..8)? != b"\x89PNG\r\n\x1a\n" || bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    Some((be32(bytes, 16)?, be32(bytes, 20)?))
}

/// `RIFF`, a size, `WEBP`, then one of the three codings: extended (`VP8X`), lossless (`VP8L`)
/// or lossy (`VP8 `).
fn webp(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    match bytes.get(12..16)? {
        b"VP8X" => Some((le24(bytes, 24)? + 1, le24(bytes, 27)? + 1)),
        b"VP8L" => {
            if *bytes.get(20)? != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8 " => {
            if bytes.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let w = u16::from_le_bytes(bytes.get(26..28)?.try_into().ok()?) & 0x3fff;
            let h = u16::from_le_bytes(bytes.get(28..30)?.try_into().ok()?) & 0x3fff;
            Some((u32::from(w), u32::from(h)))
        }
        _ => None,
    }
}

/// The text at the start of a file, with a byte-order mark and leading white space skipped.
fn text_head(bytes: &[u8]) -> String {
    let head = &bytes[..bytes.len().min(8192)];
    String::from_utf8_lossy(head.strip_prefix(b"\xef\xbb\xbf").unwrap_or(head))
        .trim_start()
        .to_owned()
}

/// A number out of an SVG length such as `104`, `104px` or `104.5`.
fn svg_length(value: &str) -> Option<u32> {
    let digits: String = value
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let number: f64 = digits.parse().ok()?;
    (number >= 1.0).then(|| number.round() as u32)
}

/// The size an SVG root declares: `width` and `height`, else the `viewBox`.
fn svg_size(text: &str) -> Option<(u32, u32)> {
    let start = text.find("<svg")?;
    let end = text[start..].find('>')? + start;
    let tag = &text[start..end];
    let attribute = |name: &str| -> Option<&str> {
        let at = tag.find(&format!(" {name}="))? + name.len() + 2;
        let quote = tag[at..]
            .chars()
            .next()
            .filter(|c| matches!(c, '"' | '\''))?;
        let close = tag[at + 1..].find(quote)?;
        Some(&tag[at + 1..at + 1 + close])
    };
    if let (Some(w), Some(h)) = (
        attribute("width").and_then(svg_length),
        attribute("height").and_then(svg_length),
    ) {
        return Some((w, h));
    }
    let numbers: Vec<f64> = attribute("viewBox")?
        .split([' ', ','])
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse().ok())
        .collect();
    match numbers.as_slice() {
        [_, _, w, h] if *w >= 1.0 && *h >= 1.0 => Some((w.round() as u32, h.round() as u32)),
        _ => None,
    }
}

/// An OBJ is lines of `v x y z`, `f ...` and comments: it must have a vertex line.
fn looks_like_obj(text: &str) -> bool {
    text.lines().take(400).any(|line| {
        let line = line.trim_start();
        line.starts_with("v ") || line.starts_with("vn ") || line.starts_with("vt ")
    })
}

/// A binary STL is an 80-byte header, a triangle count and 50 bytes per triangle; an ASCII STL
/// starts with `solid`.
fn looks_like_stl(head: &[u8], total: u64) -> bool {
    if head.starts_with(b"solid") {
        return true;
    }
    match head.get(80..84) {
        Some(count) => {
            let triangles = u64::from(u32::from_le_bytes(count.try_into().expect("four bytes")));
            triangles > 0 && total == 84 + 50 * triangles
        }
        None => false,
    }
}

/// Decide what a file is from its first bytes, its length, and the extension it is filed under
/// (which only breaks ties for the text formats, which have no magic number). `None` means it is
/// none of the formats a project holds.
pub fn detect(head: &[u8], total: u64, extension: &str) -> Option<Detected> {
    let extension = extension.to_ascii_lowercase();
    // Pictures.
    if let Some(size) = png(head) {
        return image(&["png"], "image/png", AssetKind::Image, Some(size));
    }
    if let Some(size) = webp(head) {
        return image(&["webp"], "image/webp", AssetKind::Image, Some(size));
    }
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        let size = gx_asset_plane::read_image_geometry(head).ok()?;
        return image(
            &["jpg", "jpeg"],
            "image/jpeg",
            AssetKind::Image,
            Some((size.width, size.height)),
        );
    }
    // Video.
    if head.get(4..8) == Some(b"ftyp")
        || matches!(
            head.get(4..8),
            Some(b"moov" | b"mdat" | b"wide" | b"free" | b"skip" | b"pnot")
        )
    {
        let quicktime = head.get(8..12) == Some(b"qt  ")
            || !matches!(head.get(4..8), Some(b"ftyp"))
            || extension == "mov";
        let mime = if quicktime && extension != "mp4" {
            "video/quicktime"
        } else {
            "video/mp4"
        };
        return Some(found(
            AssetClass::Video,
            &["mp4", "mov"],
            mime,
            AssetKind::Video,
        ));
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"AVI ") {
        return Some(found(
            AssetClass::Video,
            &["avi"],
            "video/x-msvideo",
            AssetKind::Video,
        ));
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        && head[..head.len().min(64)].windows(4).any(|w| w == b"webm")
    {
        return Some(found(
            AssetClass::Video,
            &["webm"],
            "video/webm",
            AssetKind::Video,
        ));
    }
    // Audio.
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE") {
        return Some(found(
            AssetClass::Audio,
            &["wav"],
            "audio/wav",
            AssetKind::Audio,
        ));
    }
    if head.starts_with(b"ID3") || (head.len() > 1 && head[0] == 0xff && head[1] & 0xe0 == 0xe0) {
        return Some(found(
            AssetClass::Audio,
            &["mp3"],
            "audio/mpeg",
            AssetKind::Audio,
        ));
    }
    // Fonts.
    let font = |format: FontFormat, extension: &'static [&'static str], mime: &'static str| {
        let mut d = found(AssetClass::Font, extension, mime, AssetKind::Font);
        d.font = Some(format);
        Some(d)
    };
    if head.starts_with(&[0x00, 0x01, 0x00, 0x00]) || head.starts_with(b"true") {
        return font(FontFormat::Ttf, &["ttf"], "font/ttf");
    }
    if head.starts_with(b"OTTO") {
        return font(FontFormat::Otf, &["otf"], "font/otf");
    }
    if head.starts_with(b"wOFF") {
        return font(FontFormat::Woff, &["woff"], "font/woff");
    }
    if head.starts_with(b"wOF2") {
        return font(FontFormat::Woff2, &["woff2"], "font/woff2");
    }
    // 3D models: binary glTF has a magic number; the rest are decided by what they look like
    // under the extension they are filed with.
    if head.starts_with(b"glTF") {
        return Some(found(
            AssetClass::Model,
            &["glb"],
            "model/gltf-binary",
            AssetKind::Model,
        ));
    }
    let text = text_head(head);
    let model = |extensions: &'static [&'static str], mime: &'static str| {
        Some(found(AssetClass::Model, extensions, mime, AssetKind::Model))
    };
    match extension.as_str() {
        "svg" if text.contains("<svg") => {
            return image(&["svg"], "image/svg+xml", AssetKind::Svg, svg_size(&text));
        }
        "gltf" if text.starts_with('{') && text.contains("\"asset\"") => {
            return model(&["gltf"], "model/gltf+json");
        }
        "obj" if looks_like_obj(&text) => return model(&["obj"], "model/obj"),
        "fbx" if head.starts_with(b"Kaydara FBX Binary") || text.starts_with("; FBX") => {
            return model(&["fbx"], "application/octet-stream");
        }
        "stl" if looks_like_stl(head, total) => return model(&["stl"], "model/stl"),
        "ply" if head.starts_with(b"ply") => return model(&["ply"], "application/octet-stream"),
        "dae" if text.contains("<COLLADA") => return model(&["dae"], "model/vnd.collada+xml"),
        "usdz" if head.starts_with(b"PK\x03\x04") => {
            return model(&["usdz"], "model/vnd.usdz+zip");
        }
        "usd" if head.starts_with(b"PXR-USDC") || text.starts_with("#usda") => {
            return model(&["usd"], "model/vnd.usd");
        }
        _ => {}
    }
    None
}

/// The result of filing a file.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedAsset {
    /// The library record: path relative to the project, content hash, size in bytes, kind.
    pub item: AssetLibraryItem,
    pub class: AssetClass,
    /// For a picture whose size the header gives.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// False when the same bytes were already filed under that name.
    pub created: bool,
}

type HashCache = Mutex<HashMap<PathBuf, (u64, Option<SystemTime>, ContentHash)>>;

fn cache() -> &'static HashCache {
    static CACHE: OnceLock<HashCache> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> EditorError + '_ {
    move |source| EditorError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// The SHA-256 of a file, read as a stream so a large video is never held in memory.
fn stream_hash(path: &Path) -> Result<ContentHash, EditorError> {
    let mut file = std::fs::File::open(path).map_err(io(path))?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut chunk).map_err(io(path))?;
        if n == 0 {
            break;
        }
        hasher.update(&chunk[..n]);
    }
    Ok(ContentHash(format!("{:x}", hasher.finalize())))
}

/// File hashes by path, valid while the file's length and modified time are unchanged.
fn hash_of(path: &Path) -> Result<ContentHash, EditorError> {
    let meta = std::fs::metadata(path).map_err(io(path))?;
    let key = (meta.len(), meta.modified().ok());
    if let Some((len, modified, hash)) = cache().lock().expect("hash cache").get(path) {
        if (*len, *modified) == key {
            return Ok(hash.clone());
        }
    }
    let hash = stream_hash(path)?;
    cache()
        .lock()
        .expect("hash cache")
        .insert(path.to_path_buf(), (key.0, key.1, hash.clone()));
    Ok(hash)
}

fn read_head(path: &Path) -> Result<Vec<u8>, EditorError> {
    let mut file = std::fs::File::open(path).map_err(io(path))?;
    let mut head = Vec::with_capacity(HEAD_BYTES.min(64 * 1024));
    Read::take(&mut file, HEAD_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(io(path))?;
    Ok(head)
}

fn refuse(detail: impl Into<String>) -> EditorError {
    Refusal::AssetStoreFailed {
        hash: ContentHash(String::new()),
        detail: detail.into(),
    }
    .into()
}

fn unrecognised(file: &str) -> EditorError {
    Refusal::AssetFormatUnrecognised {
        file: file.to_owned(),
    }
    .into()
}

fn item_for(
    relative: &str,
    hash: ContentHash,
    size: u64,
    detected: &Detected,
    sources: Vec<String>,
) -> AssetLibraryItem {
    AssetLibraryItem {
        asset_id: format!("{}_{}", detected.class.prefix(), &hash.0[..16]),
        name: relative.rsplit('/').next().unwrap_or(relative).to_owned(),
        kind: detected.kind,
        path: relative.to_owned(),
        checksum: Some(hash),
        mime_type: Some(detected.mime.to_owned()),
        size_bytes: Some(size),
        status: None,
        provenance: AssetProvenance {
            origin: Some(AssetOrigin::Human),
            tool: Some(ProvenanceTool {
                name: crate::import::IMPORT_TOOL.into(),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            }),
            sources,
            ..AssetProvenance::default()
        },
        color_space: None,
    }
}

fn extension_of(name: &str) -> Option<&str> {
    name.rsplit_once('.').map(|(_, e)| e)
}

fn component_ok(component: &str) -> bool {
    component.is_empty() || gx_contracts::platform::is_canonical_filename(component)
}

impl Projects {
    /// File one file into the project, from a file on disk: into `Assets/Images`, `Assets/Videos`,
    /// `Assets/Audio`, `Assets/Models` or `Fonts`, as the file's own bytes say, under `folder` (one
    /// canonical name such as a Figma frame's, or empty for the class folder itself).
    ///
    /// `name` defaults to the source file's name; its extension must be one the bytes may carry.
    /// `source` is what the file came from (a Figma node, a URL), kept in its record.
    pub fn import_asset(
        &self,
        project: &str,
        folder: &str,
        from: &Path,
        name: Option<&str>,
        source: Option<&str>,
    ) -> Result<ImportedAsset, EditorError> {
        self.require_project(project)?;
        self.upgrade_project(project)?;
        let label = from.display().to_string();
        let meta = std::fs::metadata(from).map_err(io(from))?;
        if !meta.is_file() {
            return Err(unrecognised(&label));
        }
        let name = match name {
            Some(name) => name.to_owned(),
            None => from
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::to_owned)
                .ok_or_else(|| unrecognised(&label))?,
        };
        let (stem, extension) = name
            .rsplit_once('.')
            .filter(|(stem, _)| !stem.is_empty())
            .ok_or_else(|| unrecognised(&name))?;
        let head = read_head(from)?;
        let detected = detect(&head, meta.len(), extension).ok_or_else(|| unrecognised(&label))?;
        let lower = extension.to_ascii_lowercase();
        if !detected.extensions.contains(&lower.as_str()) {
            return Err(refuse(format!(
                "{name} says {extension} but its bytes are {}",
                detected.extensions.join(" or ")
            )));
        }
        let class = detected.class;
        if meta.len() > class.max_bytes() {
            return Err(refuse(format!(
                "{label} is {} bytes; a file of this kind is at most {}",
                meta.len(),
                class.max_bytes()
            )));
        }
        let file_name = format!("{stem}.{lower}");
        for component in [folder, file_name.as_str()] {
            if !component_ok(component) {
                return Err(refuse(format!(
                    "{component:?} is not one file or folder name"
                )));
            }
        }
        let directory = if folder.is_empty() {
            self.project_directory(project).join(class.folder())
        } else {
            self.project_directory(project)
                .join(class.folder())
                .join(folder)
        };
        let destination = directory.join(&file_name);
        let relative = if folder.is_empty() {
            format!("{}/{file_name}", class.folder())
        } else {
            format!("{}/{folder}/{file_name}", class.folder())
        };
        let hash = stream_hash(from)?;
        let item = item_for(
            &relative,
            hash.clone(),
            meta.len(),
            &detected,
            source.map(str::to_owned).into_iter().collect(),
        );
        let imported = |created| ImportedAsset {
            item: item.clone(),
            class,
            width: detected.width,
            height: detected.height,
            created,
        };

        match std::fs::metadata(&destination) {
            Ok(_) if hash_of(&destination)? == hash => return Ok(imported(false)),
            Ok(_) => {
                return Err(refuse(format!(
                    "a different file is already filed at {relative}; rename one of them"
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(io(&destination)(source)),
        }
        std::fs::create_dir_all(&directory).map_err(io(&directory))?;
        // Copy as a stream beside the destination, check what arrived, then rename into place:
        // a crash leaves a `.partial`, never half a file under its real name.
        let partial = directory.join(format!("{file_name}.partial"));
        let copied = copy_checked(from, &partial, &hash);
        if copied.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        copied?;
        std::fs::rename(&partial, &destination).map_err(io(&destination))?;
        Ok(imported(true))
    }

    /// Every file in the project's media folders (one folder deep, as an XPression project keeps
    /// them), as library records, sorted by path. A file that is not one of the formats its folder
    /// holds is the user's file, not the project's, and is skipped.
    pub fn project_files(
        &self,
        project: &str,
    ) -> Result<Vec<(AssetLibraryItem, Detected)>, EditorError> {
        self.require_project(project)?;
        let mut files: Vec<(AssetClass, String, PathBuf)> = Vec::new();
        for class in AssetClass::ALL {
            let base = self.project_directory(project).join(class.folder());
            let mut visit = |relative: String, dir: &Path| {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.filter_map(Result::ok) {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        let allowed = extension_of(&name).is_some_and(|e| {
                            class
                                .extensions()
                                .contains(&e.to_ascii_lowercase().as_str())
                        });
                        if entry.path().is_file() && allowed {
                            files.push((class, format!("{relative}{name}"), entry.path()));
                        }
                    }
                }
            };
            visit(format!("{}/", class.folder()), &base);
            if let Ok(entries) = std::fs::read_dir(&base) {
                for entry in entries.filter_map(Result::ok) {
                    if entry.path().is_dir() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        visit(format!("{}/{name}/", class.folder()), &entry.path());
                    }
                }
            }
        }
        files.sort_by(|a, b| a.1.cmp(&b.1));
        let mut found_files = Vec::new();
        for (class, relative, path) in files {
            let meta = std::fs::metadata(&path).map_err(io(&path))?;
            if meta.len() > class.max_bytes() {
                continue;
            }
            let extension = extension_of(&relative).unwrap_or("");
            let Some(detected) = detect(&read_head(&path)?, meta.len(), extension) else {
                continue;
            };
            if detected.class != class
                || !detected
                    .extensions
                    .contains(&extension.to_ascii_lowercase().as_str())
            {
                continue;
            }
            let item = item_for(
                &relative,
                hash_of(&path)?,
                meta.len(),
                &detected,
                Vec::new(),
            );
            found_files.push((item, detected));
        }
        Ok(found_files)
    }

    /// Find a picture by name in a folder, trying `<stem>.png`, `.webp`, `.jpg`, `.jpeg`, `.svg`
    /// in that order. This is how a Figma image reference ("helmet") finds the file the agent
    /// saved for it.
    pub fn find_image(
        &self,
        project: &str,
        folder: &str,
        stem: &str,
    ) -> Result<Option<AssetLibraryItem>, EditorError> {
        self.require_project(project)?;
        if !component_ok(folder) || stem.is_empty() || !component_ok(stem) {
            return Ok(None);
        }
        let base = self
            .project_directory(project)
            .join(AssetClass::Image.folder());
        let directory = if folder.is_empty() {
            base
        } else {
            base.join(folder)
        };
        for extension in IMAGE_EXTENSIONS {
            let file_name = format!("{stem}.{extension}");
            let path = directory.join(&file_name);
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let Ok(head) = read_head(&path) else { continue };
            let Some(detected) = detect(&head, meta.len(), extension) else {
                continue;
            };
            if detected.class != AssetClass::Image || !detected.extensions.contains(&extension) {
                continue;
            }
            let relative = if folder.is_empty() {
                format!("{}/{file_name}", AssetClass::Image.folder())
            } else {
                format!("{}/{folder}/{file_name}", AssetClass::Image.folder())
            };
            return Ok(Some(item_for(
                &relative,
                hash_of(&path)?,
                meta.len(),
                &detected,
                Vec::new(),
            )));
        }
        Ok(None)
    }

    /// The font file for a family and a style, if the project has one, whichever of OTF, TTF,
    /// WOFF or WOFF2 it is. `Regular` is also found as the family name alone (`Inter.ttf`).
    pub fn find_font(
        &self,
        project: &str,
        family: &str,
        style: &str,
    ) -> Result<Option<(AssetLibraryItem, FontFormat)>, EditorError> {
        let key = |text: &str| -> String {
            text.chars()
                .filter(char::is_ascii_alphanumeric)
                .map(|c| c.to_ascii_lowercase())
                .collect()
        };
        let wanted = format!("{}{}", key(family), key(style));
        let regular = matches!(key(style).as_str(), "" | "regular" | "normal" | "book");
        let alone = key(family);
        Ok(self
            .project_files(project)?
            .into_iter()
            .filter(|(_, d)| d.class == AssetClass::Font)
            .find_map(|(item, detected)| {
                let stem = item
                    .name
                    .rsplit_once('.')
                    .map_or(item.name.as_str(), |(stem, _)| stem);
                let stem = key(stem);
                let hit = stem == wanted
                    || (regular && (stem == alone || stem == format!("{alone}regular")));
                hit.then(|| (item, detected.font.expect("a font has a format")))
            }))
    }

    /// The path of the project file holding a content address, if there is one.
    pub(super) fn media_file_by_hash(
        &self,
        project: &str,
        hash: &ContentHash,
    ) -> Result<Option<PathBuf>, EditorError> {
        for (item, _) in self.project_files(project)? {
            if item.checksum.as_ref() == Some(hash) {
                return Ok(Some(self.project_directory(project).join(&item.path)));
            }
        }
        Ok(None)
    }
}

/// Copy `from` to `to` as a stream and check the copy hashes to `expected`.
fn copy_checked(from: &Path, to: &Path, expected: &ContentHash) -> Result<(), EditorError> {
    let mut input = std::fs::File::open(from).map_err(io(from))?;
    let mut output = std::fs::File::create(to).map_err(io(to))?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; 1 << 20];
    loop {
        let n = input.read(&mut chunk).map_err(io(from))?;
        if n == 0 {
            break;
        }
        hasher.update(&chunk[..n]);
        output.write_all(&chunk[..n]).map_err(io(to))?;
    }
    output.sync_all().map_err(io(to))?;
    let actual = ContentHash(format!("{:x}", hasher.finalize()));
    if &actual != expected {
        return Err(refuse(format!(
            "{} changed while it was being filed",
            from.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
