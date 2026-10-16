#![forbid(unsafe_code)]

use std::{collections::{HashMap, HashSet}, fmt, fs, path::{Path, PathBuf}};
use gx_contracts::{ContentHash, Refusal};
use gx_contracts::{material::MaterialSupport, scene::{parse_scene_document, SceneDocument}};
use gx_render_worker::{headless::{decode_png as decode_headless_png, render_png}, mesh::AssetBytes, prepared::PreparedScene, rasterizer::Frame};
use sha2::{Digest, Sha256};

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

#[derive(Debug)]
pub enum PixelGateError { Io(std::io::Error), Refusal(Refusal), InvalidPng(String), DimensionMismatch { scene: String, expected: (u32, u32), actual: (u32, u32) }, Differences(Vec<FrameDifference>) }
impl fmt::Display for PixelGateError { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { match self { Self::Io(e) => write!(f, "I/O failure: {e}"), Self::Refusal(e) => write!(f, "{e}"), Self::InvalidPng(e) => write!(f, "invalid pixel-gate PNG: {e}"), Self::DimensionMismatch { scene, expected, actual } => write!(f, "{scene}: baseline dimensions {}x{} differ from rendered {}x{}", expected.0, expected.1, actual.0, actual.1), Self::Differences(ds) => { for d in ds { writeln!(f, "{}: {} differing pixels; worst channel delta {}", d.scene, d.differing_pixels, d.worst_channel_delta)?; } Ok(()) } } } }
impl std::error::Error for PixelGateError {}
impl From<std::io::Error> for PixelGateError { fn from(e: std::io::Error) -> Self { Self::Io(e) } }
impl From<Refusal> for PixelGateError { fn from(e: Refusal) -> Self { Self::Refusal(e) } }
#[derive(Debug, Clone, PartialEq, Eq)] pub struct FrameDifference { pub scene: String, pub differing_pixels: usize, pub worst_channel_delta: u8 }

pub fn workspace_root() -> &'static Path { Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).expect("tools/pixel-gate is two directories below the workspace root") }
pub fn reference_scenes_dir() -> PathBuf { workspace_root().join("tests/reference-scenes") }
pub fn baselines_dir() -> PathBuf { workspace_root().join("tests/baselines") }
pub fn reference_scene_paths(directory: &Path) -> Result<Vec<PathBuf>, PixelGateError> { let mut paths = fs::read_dir(directory)?.map(|e| e.map(|v| v.path())).collect::<Result<Vec<_>, _>>()?; paths.retain(|p| p.extension().is_some_and(|e| e == "json")); paths.sort(); if paths.is_empty() { return Err(PixelGateError::InvalidPng(format!("no reference scenes in {}", directory.display()))); } Ok(paths) }
pub fn load_reference_scene(path: &Path) -> Result<SceneDocument, PixelGateError> { Ok(parse_scene_document(&fs::read(path)?)?) }
/// A golden frame is frame 0 of the scene's own timeline, drawn through the
/// engine's one headless entry point (11.41) and read back from the PNG it
/// produces, so the gate measures exactly what thumbnails, previews and
/// `render.preview` are given.
pub fn render_reference_scene(path: &Path) -> Result<Frame, PixelGateError> { let document = load_reference_scene(path)?; let (available, bytes) = reference_assets(&document)?; let prepared = PreparedScene::prepare(document, &available, &bytes, &MaterialSupport::fixed_function())?; Ok(decode_headless_png(&render_png(&prepared, 0)?.png)?) }
fn reference_assets(document: &SceneDocument) -> Result<(HashSet<ContentHash>, AssetBytes), PixelGateError> { let mut available = HashSet::new(); let mut bytes = HashMap::new(); for asset in &document.assets { let expected = asset.checksum.clone().ok_or_else(|| Refusal::AssetMissing { hash: ContentHash(format!("{} (no content hash yet)", asset.asset_id)) })?; let payload = fs::read(workspace_root().join(&asset.path))?; let actual = ContentHash(format!("{:x}", Sha256::digest(&payload))); if actual != expected { return Err(Refusal::AssetHashMismatch { expected, actual }.into()); } available.insert(expected.clone()); bytes.insert(expected, payload); } Ok((available, bytes)) }
pub fn capture() -> Result<(), PixelGateError> { capture_to(&reference_scenes_dir(), &baselines_dir()) }
pub fn check() -> Result<(), PixelGateError> { check_at(&reference_scenes_dir(), &baselines_dir()) }
pub fn capture_to(scenes: &Path, baselines: &Path) -> Result<(), PixelGateError> { fs::create_dir_all(baselines)?; for scene in reference_scene_paths(scenes)? { write_png_file(&baseline_path(baselines, &scene), &render_reference_scene(&scene)?)?; } Ok(()) }
pub fn check_at(scenes: &Path, baselines: &Path) -> Result<(), PixelGateError> { let mut differences = Vec::new(); for scene in reference_scene_paths(scenes)? { let name = scene_name(&scene); let actual = render_reference_scene(&scene)?; let expected = read_png_file(&baseline_path(baselines, &scene))?; if (expected.width, expected.height) != (actual.width, actual.height) { return Err(PixelGateError::DimensionMismatch { scene: name, expected: (expected.width, expected.height), actual: (actual.width, actual.height) }); } let d = compare_frames(&name, &expected, &actual); if d.differing_pixels != 0 { differences.push(d); } } if differences.is_empty() { Ok(()) } else { Err(PixelGateError::Differences(differences)) } }
fn baseline_path(baselines: &Path, scene: &Path) -> PathBuf { baselines.join(format!("{}.png", scene_name(scene))) }
fn scene_name(scene: &Path) -> String { scene.file_stem().and_then(|n| n.to_str()).expect("reference scene names are UTF-8").into() }
pub fn compare_frames(scene: &str, expected: &Frame, actual: &Frame) -> FrameDifference { let mut differing_pixels = 0; let mut worst_channel_delta = 0; for (expected_pixel, actual_pixel) in expected.pixels.chunks_exact(4).zip(actual.pixels.chunks_exact(4)) { let mut differs = false; for (&e, &a) in expected_pixel.iter().zip(actual_pixel) { let delta = e.abs_diff(a); differs |= delta != 0; worst_channel_delta = worst_channel_delta.max(delta); } differing_pixels += usize::from(differs); } FrameDifference { scene: scene.into(), differing_pixels, worst_channel_delta } }

pub fn write_png_file(path: &Path, frame: &Frame) -> Result<(), PixelGateError> { fs::write(path, encode_png(frame)?)?; Ok(()) }
pub fn read_png_file(path: &Path) -> Result<Frame, PixelGateError> { decode_png(&fs::read(path)?) }
/// Stored DEFLATE keeps PNG baseline encoding dependency-free and deterministic.
pub fn encode_png(frame: &Frame) -> Result<Vec<u8>, PixelGateError> { let row_bytes = (frame.width as usize).checked_mul(4).ok_or_else(|| bad("row length overflows"))?; let size = row_bytes.checked_mul(frame.height as usize).ok_or_else(|| bad("frame length overflows"))?; if frame.width == 0 || frame.height == 0 || frame.pixels.len() != size { return Err(bad("frame is not tightly packed non-zero RGBA8")); } let mut raw = Vec::with_capacity(size + frame.height as usize); for row in frame.pixels.chunks_exact(row_bytes) { raw.push(0); raw.extend_from_slice(row); } let mut zlib = vec![0x78, 0x01]; for (i, block) in raw.chunks(65_535).enumerate() { let final_block = (i + 1) * 65_535 >= raw.len(); zlib.push(u8::from(final_block)); let length = block.len() as u16; zlib.extend_from_slice(&length.to_le_bytes()); zlib.extend_from_slice(&(!length).to_le_bytes()); zlib.extend_from_slice(block); } zlib.extend_from_slice(&adler32(&raw).to_be_bytes()); let mut png = PNG_SIGNATURE.to_vec(); let mut ihdr = Vec::with_capacity(13); ihdr.extend_from_slice(&frame.width.to_be_bytes()); ihdr.extend_from_slice(&frame.height.to_be_bytes()); ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); append_chunk(&mut png, *b"IHDR", &ihdr); append_chunk(&mut png, *b"IDAT", &zlib); append_chunk(&mut png, *b"IEND", &[]); Ok(png) }
/// Decode only the exact non-interlaced RGBA8/stored-DEFLATE form this gate emits.
pub fn decode_png(png: &[u8]) -> Result<Frame, PixelGateError> { if !png.starts_with(&PNG_SIGNATURE) { return Err(bad("signature is absent")); } let (mut cursor, mut width, mut height, mut idat, mut iend) = (8, None, None, Vec::new(), false); while cursor < png.len() { let length = read_u32(png, &mut cursor)? as usize; let kind = read_array::<4>(png, &mut cursor)?; let payload = read_slice(png, &mut cursor, length)?; let crc = read_u32(png, &mut cursor)?; let mut input = kind.to_vec(); input.extend_from_slice(payload); if crc32(&input) != crc { return Err(bad("chunk CRC mismatch")); } match &kind { b"IHDR" => { if payload.len() != 13 || width.is_some() || payload[8..] != [8, 6, 0, 0, 0] { return Err(bad("only one non-interlaced RGBA8 IHDR is supported")); } width = Some(u32::from_be_bytes(payload[0..4].try_into().unwrap())); height = Some(u32::from_be_bytes(payload[4..8].try_into().unwrap())); }, b"IDAT" => idat.extend_from_slice(payload), b"IEND" => { if !payload.is_empty() || cursor != png.len() { return Err(bad("IEND is malformed or not final")); } iend = true; break; }, _ => {} } } let (width, height) = (width.ok_or_else(|| bad("IHDR is absent"))?, height.ok_or_else(|| bad("IHDR is absent"))?); if !iend || width == 0 || height == 0 { return Err(bad("IEND is absent or dimensions are zero")); } let raw = decode_stored_zlib(&idat)?; let row_bytes = (width as usize).checked_mul(4).ok_or_else(|| bad("row length overflows"))?; let scanline = row_bytes + 1; if raw.len() != scanline.checked_mul(height as usize).ok_or_else(|| bad("scanline length overflows"))? { return Err(bad("decompressed length mismatches IHDR")); } let mut pixels = Vec::with_capacity(row_bytes * height as usize); for row in raw.chunks_exact(scanline) { if row[0] != 0 { return Err(bad("PNG filter is not None")); } pixels.extend_from_slice(&row[1..]); } Ok(Frame { width, height, pixels }) }
fn decode_stored_zlib(stream: &[u8]) -> Result<Vec<u8>, PixelGateError> { if stream.len() < 6 || stream[0] & 15 != 8 || (u16::from(stream[0]) << 8 | u16::from(stream[1])) % 31 != 0 || stream[1] & 0x20 != 0 { return Err(bad("zlib header is invalid")); } let mut cursor = 2; let mut raw = Vec::new(); loop { if cursor + 5 > stream.len() { return Err(bad("stored DEFLATE block is truncated")); } let header = stream[cursor]; cursor += 1; if header != 0 && header != 1 { return Err(bad("compressed DEFLATE blocks are unsupported")); } let length = u16::from_le_bytes([stream[cursor], stream[cursor + 1]]); let nlength = u16::from_le_bytes([stream[cursor + 2], stream[cursor + 3]]); cursor += 4; if nlength != !length { return Err(bad("stored DEFLATE complement is invalid")); } raw.extend_from_slice(read_slice(stream, &mut cursor, length as usize)?); if header == 1 { break; } } if cursor + 4 != stream.len() { return Err(bad("zlib trailer is missing")); } let expected = u32::from_be_bytes(stream[cursor..cursor + 4].try_into().unwrap()); if adler32(&raw) != expected { return Err(bad("zlib Adler-32 mismatch")); } Ok(raw) }
fn append_chunk(png: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) { png.extend_from_slice(&(data.len() as u32).to_be_bytes()); png.extend_from_slice(&kind); png.extend_from_slice(data); let mut input = kind.to_vec(); input.extend_from_slice(data); png.extend_from_slice(&crc32(&input).to_be_bytes()); }
fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, PixelGateError> { Ok(u32::from_be_bytes(read_array::<4>(bytes, cursor)?)) }
fn read_array<const N: usize>(bytes: &[u8], cursor: &mut usize) -> Result<[u8; N], PixelGateError> { read_slice(bytes, cursor, N)?.try_into().map_err(|_| bad("fixed-width field is truncated")) }
fn read_slice<'a>(bytes: &'a [u8], cursor: &mut usize, length: usize) -> Result<&'a [u8], PixelGateError> { let end = cursor.checked_add(length).ok_or_else(|| bad("field length overflows"))?; let out = bytes.get(*cursor..end).ok_or_else(|| bad("file is truncated"))?; *cursor = end; Ok(out) }
fn bad(message: impl Into<String>) -> PixelGateError { PixelGateError::InvalidPng(message.into()) }
fn adler32(bytes: &[u8]) -> u32 { let (mut a, mut b) = (1u32, 0u32); for &byte in bytes { a = (a + byte as u32) % 65_521; b = (b + a) % 65_521; } (b << 16) | a }
fn crc32(bytes: &[u8]) -> u32 { let mut crc = !0u32; for &byte in bytes { crc ^= byte as u32; for _ in 0..8 { crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 }; } } !crc }

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::scene::SceneObject;

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("gx-pixel-gate-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("temporary directory is writable");
        path
    }

    #[test]
    fn encoder_round_trips_its_own_rgba8_output() {
        let frame = Frame { width: 3, height: 2, pixels: (0..24).collect() };
        assert_eq!(decode_png(&encode_png(&frame).expect("frame encodes")).expect("our PNG decodes"), frame);
    }

    #[test]
    fn reference_set_parses_and_covers_fixed_function_modes_and_subjects() {
        let (mut blends, mut fits, mut rates) = (HashSet::new(), HashSet::new(), HashSet::new());
        let (mut safe_areas, mut text, mut vector, mut mesh) = (false, false, false, false);
        let mut corpus = reference_scene_paths(&reference_scenes_dir()).expect("reference scenes enumerate");
        corpus.extend(reference_scene_paths(&workspace_root().join("tests/refusal-scenes")).expect("refusal scenes enumerate"));
        for path in corpus {
            let document = load_reference_scene(&path).expect("each reference scene parses through the production parser");
            rates.insert((document.canvas.frame_rate.num, document.canvas.frame_rate.den));
            blends.extend(document.materials.iter().map(|material| material.blend_mode));
            for object in &document.objects {
                match object {
                    SceneObject::Text(_) => text = true,
                    SceneObject::Shape(_) => vector = true,
                    SceneObject::Mesh(_) => mesh = true,
                    SceneObject::Rect(rect) if rect.base.name.contains("safe area") => safe_areas = true,
                    SceneObject::Image(image) => { fits.insert(image.fit); }
                    _ => {}
                }
            }
        }
        let support = MaterialSupport::fixed_function();
        for mode in support.blend_modes { assert!(blends.contains(&mode), "fixed-function blend mode {mode:?} lacks a reference scene"); }
        for mode in support.fit_modes { assert!(fits.contains(&mode), "fixed-function fit mode {mode:?} lacks a reference scene"); }
        assert_eq!(rates, HashSet::from([(50, 1), (30_000, 1001), (60_000, 1001), (25, 1), (30, 1), (60, 1)]));
        assert!(safe_areas && text && vector && mesh, "the reference set must retain every required subject");
    }

    #[test]
    fn unsupported_reference_mappings_refuse_instead_of_becoming_baselines() {
        for scene in reference_scene_paths(&workspace_root().join("tests/refusal-scenes")).expect("refusal scenes enumerate") {
            let error = render_reference_scene(&scene).expect_err("unsupported authored mappings must not capture placeholder pixels");
            assert!(matches!(error, PixelGateError::Refusal(Refusal::ObjectKindNotDrawable { ref object, ref kind, .. })
                if !object.is_empty() && (kind == "image" || kind == "mesh")), "{error}");
        }
    }

    #[test]
    fn capture_is_byte_deterministic() {
        let output = temporary_directory("deterministic");
        capture_to(&reference_scenes_dir(), &output).expect("first capture succeeds");
        let mut first: Vec<_> = fs::read_dir(&output).expect("baseline directory reads").map(|entry| {
            let path = entry.expect("directory entry").path();
            (path.file_name().unwrap().to_string_lossy().into_owned(), fs::read(path).expect("baseline reads"))
        }).collect();
        first.sort_by(|a, b| a.0.cmp(&b.0));
        capture_to(&reference_scenes_dir(), &output).expect("second capture succeeds");
        let mut second: Vec<_> = fs::read_dir(&output).expect("baseline directory reads").map(|entry| {
            let path = entry.expect("directory entry").path();
            (path.file_name().unwrap().to_string_lossy().into_owned(), fs::read(path).expect("baseline reads"))
        }).collect();
        second.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(first, second, "two captures must be byte-identical");
        fs::remove_dir_all(output).expect("temporary directory cleans up");
    }

    #[test]
    fn check_names_scene_when_one_baseline_pixel_changes() {
        let output = temporary_directory("one-pixel");
        capture_to(&reference_scenes_dir(), &output).expect("capture succeeds");
        let scene = reference_scene_paths(&reference_scenes_dir()).expect("reference scenes enumerate").remove(0);
        let baseline = baseline_path(&output, &scene);
        let mut frame = read_png_file(&baseline).expect("baseline decodes");
        frame.pixels[0] ^= 1;
        write_png_file(&baseline, &frame).expect("mutated baseline writes");
        let error = check_at(&reference_scenes_dir(), &output).expect_err("one changed pixel must fail the gate");
        assert!(error.to_string().contains(&scene_name(&scene)), "failure must name the scene: {error}");
        fs::remove_dir_all(output).expect("temporary directory cleans up");
    }
}
