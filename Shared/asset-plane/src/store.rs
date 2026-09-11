//! Content-addressed asset storage and the library address that points at it.
//!
//! A project path is mutable while a content hash is not (invariant 31). This
//! module retains both addresses: it deduplicates verified bytes under their
//! SHA-256 hash, then lets a library entry move to new bytes without changing
//! its scene-facing identity. Header-only image geometry prevents a malformed
//! or unsupported image from becoming a plausible 0×0 asset.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use gx_contracts::platform::{cache_root, FileName};
use gx_contracts::scene::{AssetAvailability, AssetKind, AssetLibraryItem};
use gx_contracts::{ContentHash, Refusal};
use sha2::{Digest, Sha256};

use crate::is_syntactically_safe;

/// Pixel dimensions obtained from an image header without decoding pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageGeometry {
    pub width: u32,
    pub height: u32,
}

/// A store operation that did not complete, named by the guarantee it lost.
#[derive(Debug)]
pub enum AssetStoreError {
    /// The platform could not supply its per-user cache location.
    Refusal(Refusal),
    /// The content-addressed directory could not be created.
    CreateCacheDirectory { path: PathBuf, source: io::Error },
    /// The verified bytes could not be atomically published.
    WriteCache {
        path: PathBuf,
        source: gx_fs::AtomicWriteError,
    },
    /// A cached file could not be read to verify its claimed hash.
    ReadCache { path: PathBuf, source: io::Error },
    /// A cache entry's bytes do not match the hash in its filename.
    CacheHashMismatch {
        path: PathBuf,
        expected: ContentHash,
        actual: ContentHash,
    },
    /// A library address would not remain under a project root.
    UnsafeLibraryPath { path: String },
    /// Two paths differ only in case and would behave differently by volume.
    CaseVariantLibraryPath { existing: String, requested: String },
    /// An in-place replacement named no library item.
    LibraryPathMissing { path: String },
}

impl fmt::Display for AssetStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refusal(refusal) => write!(f, "asset store refusal: {refusal}"),
            Self::CreateCacheDirectory { path, source } => {
                write!(
                    f,
                    "could not create asset cache directory {}: {source}",
                    path.display()
                )
            }
            Self::WriteCache { path, source } => {
                write!(
                    f,
                    "could not atomically write cached asset {}: {source}",
                    path.display()
                )
            }
            Self::ReadCache { path, source } => {
                write!(
                    f,
                    "could not read cached asset {}: {source}",
                    path.display()
                )
            }
            Self::CacheHashMismatch {
                path,
                expected,
                actual,
            } => write!(
                f,
                "cached asset {} claims {expected} but contains {actual}",
                path.display()
            ),
            Self::UnsafeLibraryPath { path } => {
                write!(
                    f,
                    "library path is not project-relative and traversal-free: {path}"
                )
            }
            Self::CaseVariantLibraryPath {
                existing,
                requested,
            } => write!(
                f,
                "library path {requested} conflicts with case variant {existing}"
            ),
            Self::LibraryPathMissing { path } => write!(f, "library path does not exist: {path}"),
        }
    }
}

impl std::error::Error for AssetStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refusal(refusal) => Some(refusal),
            Self::CreateCacheDirectory { source, .. } | Self::ReadCache { source, .. } => {
                Some(source)
            }
            Self::WriteCache { source, .. } => Some(source),
            Self::CacheHashMismatch { .. }
            | Self::UnsafeLibraryPath { .. }
            | Self::CaseVariantLibraryPath { .. }
            | Self::LibraryPathMissing { .. } => None,
        }
    }
}

impl From<Refusal> for AssetStoreError {
    fn from(value: Refusal) -> Self {
        Self::Refusal(value)
    }
}

/// The content-addressed cache and its case-stable project library.
///
/// The cache is rooted under [`cache_root`] in production. [`AssetStore::at_root`]
/// exists for isolated callers and tests; it has the same layout and write path.
#[derive(Debug)]
pub struct AssetStore {
    cache_directory: PathBuf,
    library: HashMap<FileName, AssetLibraryItem>,
}

impl AssetStore {
    /// Open the per-user content-addressed asset cache.
    pub fn new() -> Result<Self, AssetStoreError> {
        Ok(Self::at_root(cache_root()?.join("assets")))
    }

    /// Use an explicit cache directory while retaining the production layout.
    pub fn at_root(cache_directory: PathBuf) -> Self {
        Self {
            cache_directory,
            library: HashMap::new(),
        }
    }

    /// Import bytes, atomically cache them by SHA-256, and add their library address.
    ///
    /// An image's dimensions are read from its bytes before the item becomes ready.
    /// The extension is deliberately not consulted.
    pub fn import(
        &mut self,
        mut item: AssetLibraryItem,
        bytes: &[u8],
    ) -> Result<ContentHash, AssetStoreError> {
        if !is_syntactically_safe(&item.path) {
            return Err(AssetStoreError::UnsafeLibraryPath { path: item.path });
        }
        if item.kind == AssetKind::Image {
            read_image_geometry(bytes)?;
        }

        let key = FileName::new(item.path.clone());
        if let Some(existing) = self.library.get(&key) {
            if existing.path != item.path {
                return Err(AssetStoreError::CaseVariantLibraryPath {
                    existing: existing.path.clone(),
                    requested: item.path,
                });
            }
        }

        let hash = self.store_bytes(bytes)?;
        item.checksum = Some(hash.clone());
        item.size_bytes = Some(bytes.len() as u64);
        item.status = Some(AssetAvailability::Ready);
        self.library.insert(key, item);
        Ok(hash)
    }

    /// Replace one library address's bytes without changing its asset id or path.
    pub fn replace_in_place(
        &mut self,
        path: &str,
        bytes: &[u8],
    ) -> Result<ContentHash, AssetStoreError> {
        let key = FileName::new(path);
        let kind = self
            .library
            .get(&key)
            .ok_or_else(|| AssetStoreError::LibraryPathMissing {
                path: path.to_owned(),
            })?
            .kind;
        if kind == AssetKind::Image {
            read_image_geometry(bytes)?;
        }

        let hash = self.store_bytes(bytes)?;
        let item = self
            .library
            .get_mut(&key)
            .expect("the library item was present while this store is exclusively borrowed");
        item.replace_bytes_in_place(hash.clone(), Some(bytes.len() as u64));
        item.status = Some(AssetAvailability::Ready);
        Ok(hash)
    }

    /// Look up a project-relative library address under the cross-platform case policy.
    pub fn library_item(&self, path: &str) -> Option<&AssetLibraryItem> {
        self.library.get(&FileName::new(path))
    }

    /// Number of project library addresses, which may exceed the number of stored files.
    pub fn library_len(&self) -> usize {
        self.library.len()
    }

    /// The path of a verified cache entry for a known content hash.
    pub fn cache_path(&self, hash: &ContentHash) -> PathBuf {
        self.cache_directory.join(&hash.0)
    }

    fn store_bytes(&self, bytes: &[u8]) -> Result<ContentHash, AssetStoreError> {
        let expected = content_hash(bytes);
        let path = self.cache_path(&expected);
        fs::create_dir_all(&self.cache_directory).map_err(|source| {
            AssetStoreError::CreateCacheDirectory {
                path: self.cache_directory.clone(),
                source,
            }
        })?;

        if path.exists() && hash_file(&path)? == expected {
            return Ok(expected);
        }

        // The hash is updated from exactly the bytes handed to the atomic writer.
        // `write_all` either writes every byte or returns an error, so a name is
        // never published unless the byte sequence that reached its temporary file
        // was verified as the claimed content address (invariant 28).
        let hash_for_write = expected.clone();
        gx_fs::write_atomic_with(&path, |file| {
            let mut hasher = Sha256::new();
            file.write_all(bytes)?;
            hasher.update(bytes);
            let actual = ContentHash(format!("{:x}", hasher.finalize()));
            if actual == hash_for_write {
                Ok(())
            } else {
                Err(io::Error::other(
                    "bytes written to the cache did not match SHA-256",
                ))
            }
        })
        .map_err(|source| AssetStoreError::WriteCache {
            path: path.clone(),
            source,
        })?;

        let actual = hash_file(&path)?;
        if actual != expected {
            return Err(AssetStoreError::CacheHashMismatch {
                path,
                expected,
                actual,
            });
        }
        Ok(expected)
    }
}

/// SHA-256 content address in its canonical lower-case hexadecimal form.
pub fn content_hash(bytes: &[u8]) -> ContentHash {
    ContentHash(format!("{:x}", Sha256::digest(bytes)))
}

/// Read PNG or JPEG dimensions from headers without decoding image pixels.
///
/// A format or header this parser cannot prove is refused by name; callers never
/// receive a fabricated 0×0 size or a size inferred from the filename.
pub fn read_image_geometry(bytes: &[u8]) -> Result<ImageGeometry, Refusal> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        read_png_geometry(bytes)
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        read_jpeg_geometry(bytes)
    } else {
        Err(image_refusal(
            "unsupported image signature; only PNG and JPEG headers are readable",
        ))
    }
}

fn read_png_geometry(bytes: &[u8]) -> Result<ImageGeometry, Refusal> {
    if bytes.len() < 24 {
        return Err(image_refusal("PNG IHDR is truncated before its dimensions"));
    }
    if bytes[8..12] != [0, 0, 0, 13] || &bytes[12..16] != b"IHDR" {
        return Err(image_refusal("PNG has no valid IHDR header"));
    }
    checked_geometry(
        u32::from_be_bytes(bytes[16..20].try_into().expect("four PNG width bytes")),
        u32::from_be_bytes(bytes[20..24].try_into().expect("four PNG height bytes")),
        "PNG",
    )
}

fn read_jpeg_geometry(bytes: &[u8]) -> Result<ImageGeometry, Refusal> {
    let mut cursor = 2;
    while cursor < bytes.len() {
        if bytes[cursor] != 0xff {
            return Err(image_refusal("JPEG marker prefix is missing"));
        }
        while cursor < bytes.len() && bytes[cursor] == 0xff {
            cursor += 1;
        }
        if cursor == bytes.len() {
            return Err(image_refusal("JPEG is truncated after a marker prefix"));
        }
        let marker = bytes[cursor];
        cursor += 1;

        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            continue;
        }
        if matches!(marker, 0xd9 | 0xda) {
            return Err(image_refusal(
                "JPEG reached image data before a start-of-frame header",
            ));
        }
        if cursor + 2 > bytes.len() {
            return Err(image_refusal("JPEG segment length is truncated"));
        }
        let length = usize::from(u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]));
        if length < 2 || cursor + length > bytes.len() {
            return Err(image_refusal("JPEG segment is truncated"));
        }
        if is_jpeg_start_of_frame(marker) {
            if length < 8 {
                return Err(image_refusal("JPEG start-of-frame header is truncated"));
            }
            return checked_geometry(
                u32::from(u16::from_be_bytes([bytes[cursor + 5], bytes[cursor + 6]])),
                u32::from(u16::from_be_bytes([bytes[cursor + 3], bytes[cursor + 4]])),
                "JPEG",
            );
        }
        cursor += length;
    }
    Err(image_refusal("JPEG has no start-of-frame header"))
}

fn is_jpeg_start_of_frame(marker: u8) -> bool {
    matches!(
        marker,
        0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf
    )
}

fn checked_geometry(width: u32, height: u32, format: &str) -> Result<ImageGeometry, Refusal> {
    if width == 0 || height == 0 {
        return Err(image_refusal(&format!(
            "{format} header declares a zero dimension"
        )));
    }
    Ok(ImageGeometry { width, height })
}

fn image_refusal(what: &str) -> Refusal {
    Refusal::NotImplemented {
        what: format!("image geometry refused: {what}"),
    }
}

fn hash_file(path: &Path) -> Result<ContentHash, AssetStoreError> {
    let mut file = fs::File::open(path).map_err(|source| AssetStoreError::ReadCache {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|source| AssetStoreError::ReadCache {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ContentHash(format!("{:x}", hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_TEMPORARY_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn temporary_directory() -> PathBuf {
        let sequence = NEXT_TEMPORARY_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gx-asset-plane-store-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temporary asset cache directory must be creatable");
        path
    }

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes
    }

    fn jpeg_with_app1_before_sof0(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, b'E', b'x', b'i', b'f'];
        bytes.extend([0xff, 0xc0, 0x00, 0x08, 0x08]);
        bytes.extend(height.to_be_bytes());
        bytes.extend(width.to_be_bytes());
        bytes.extend([0x03, 0xff, 0xd9]);
        bytes
    }

    fn image_item(asset_id: &str, path: &str) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: asset_id.into(),
            name: path.into(),
            kind: AssetKind::Image,
            path: path.into(),
            checksum: None,
            mime_type: Some("image/png".into()),
            size_bytes: None,
            status: Some(AssetAvailability::Importing),
        }
    }

    #[test]
    fn same_asset_imported_twice_stores_once_with_two_library_addresses() {
        let directory = temporary_directory();
        let mut store = AssetStore::at_root(directory.clone());
        let bytes = png_header(320, 180);

        let first = store
            .import(image_item("logo-a", "textures/Logo.png"), &bytes)
            .expect("the first import must store valid image bytes");
        let second = store
            .import(image_item("logo-b", "textures/alternate.png"), &bytes)
            .expect("the second import must deduplicate identical bytes");

        assert_eq!(
            first, second,
            "identical bytes must have one content address"
        );
        assert_eq!(
            fs::read_dir(&directory)
                .expect("cache directory must exist")
                .count(),
            1,
            "identical bytes must occupy one cache file"
        );
        assert_eq!(
            store.library_len(),
            2,
            "two paths remain two library addresses"
        );
        assert_eq!(
            store
                .library_item("textures/logo.PNG")
                .expect("case-insensitive lookup must find the authored path")
                .asset_id,
            "logo-a"
        );

        let replacement = png_header(640, 360);
        let replacement_hash = store
            .replace_in_place("textures/Logo.png", &replacement)
            .expect("an existing library address must replace in place");
        let updated = store
            .library_item("textures/Logo.png")
            .expect("the replaced address must remain in the library");
        assert_ne!(
            replacement_hash, first,
            "new bytes must receive a new content address"
        );
        assert_eq!(
            updated.asset_id, "logo-a",
            "replacing bytes must preserve binding identity"
        );
        assert_eq!(
            updated.path, "textures/Logo.png",
            "replacing bytes must preserve the path"
        );
        assert_eq!(updated.checksum.as_ref(), Some(&replacement_hash));

        fs::remove_dir_all(directory).expect("test cache directory must be removable");
    }

    #[test]
    fn png_dimensions_are_read_from_ihdr_without_decoding_pixels() {
        assert_eq!(
            read_image_geometry(&png_header(1920, 1080)).expect("PNG IHDR must be sufficient"),
            ImageGeometry {
                width: 1920,
                height: 1080
            }
        );
    }

    #[test]
    fn jpeg_dimensions_follow_app1_to_sof0_without_decoding_pixels() {
        assert_eq!(
            read_image_geometry(&jpeg_with_app1_before_sof0(4032, 3024))
                .expect("JPEG SOF0 after APP1 must be found"),
            ImageGeometry {
                width: 4032,
                height: 3024
            }
        );
    }

    #[test]
    fn truncated_and_unknown_image_headers_refuse_by_name() {
        for bytes in [
            b"\x89PNG\r\n\x1a\n\x00".as_slice(),
            b"not an image".as_slice(),
        ] {
            let refusal = read_image_geometry(bytes).expect_err("unreadable geometry must refuse");
            assert!(
                matches!(refusal, Refusal::NotImplemented { .. }),
                "the failure must be a named contract refusal"
            );
        }
    }

    #[test]
    fn image_extensions_do_not_choose_the_geometry_parser() {
        let directory = temporary_directory();
        let mut store = AssetStore::at_root(directory.clone());
        let bytes = png_header(800, 600);
        let hash = store
            .import(image_item("mislabelled", "textures/photo.jpeg"), &bytes)
            .expect("PNG bytes must import regardless of a JPEG extension");
        assert!(store.cache_path(&hash).is_file());
        assert_eq!(
            read_image_geometry(&bytes).expect("the header signature, not extension, decides"),
            ImageGeometry {
                width: 800,
                height: 600
            }
        );
        fs::remove_dir_all(directory).expect("test cache directory must be removable");
    }
}
