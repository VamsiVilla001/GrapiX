//! Headless render (11.41): a pinned revision's authored frame, as an image.
//!
//! One function draws. [`render_png`] evaluates a prepared scene at a scene
//! frame through the CPU reference `PreparedScene::frame_at`, with the shared
//! semantic evaluator but without Program's GPU cache or take key, and encodes the sRGB result as a
//! PNG. The control request, the mock engine and the golden-frame gate all
//! reach pixels through it, and so must every later consumer: thumbnails,
//! approval previews, `render.preview` and Phase 13 parity.
//!
//! **One machine and driver: byte-identical.** The software path computes in
//! IEEE-754 f64 and quantises once to 8 bits, with no wall clock, randomness or
//! thread-order dependence, and the encoder runs at a fixed compression level
//! with one filter. The same scene and frame give the same bytes.
//!
//! **Across machines: [`CROSS_MACHINE_TOLERANCE`].** This is the definition
//! 11.41's verification record names, and the golden-frame gate applies it.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use gx_asset_plane::content_hash;
use gx_contracts::color::OutputTransform;
use gx_contracts::{ContentHash, Refusal};
use gx_control_plane::message::EngineReply;
use gx_control_plane::render::{RenderRequest, RenderedFrame};

use crate::prepared::PreparedScene;
use crate::rasterizer::Frame;

/// One rendered image: its PNG bytes and the address they are served under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedImage {
    pub width: u32,
    pub height: u32,
    pub hash: ContentHash,
    pub png: Arc<Vec<u8>>,
}

/// Render one authored frame of a prepared scene to an sRGB PNG.
pub fn render_png(scene: &PreparedScene, frame: u64) -> Result<RenderedImage, Refusal> {
    let pixels = scene.frame_at(frame, OutputTransform::Srgb)?;
    let png = encode_png(&pixels);
    Ok(RenderedImage {
        width: pixels.width,
        height: pixels.height,
        hash: content_hash(&png),
        png: Arc::new(png),
    })
}

/// Render a validated request, keep the image for the asset plane, and
/// answer. `content_hash` is the revision's pin, already checked by
/// `check_render`. The engine runs this after releasing its lock; the mock
/// engine runs it in place. Both answer through this one function.
pub fn answer_render(
    request: RenderRequest,
    content_hash: ContentHash,
    scene: &PreparedScene,
    images: &Mutex<RenderedImages>,
) -> EngineReply {
    match render_png(scene, request.frame) {
        Ok(image) => {
            let reply = RenderedFrame {
                take_id: request.take_id,
                revision: request.revision,
                content_hash,
                frame: request.frame,
                width: image.width,
                height: image.height,
                image: image.hash.clone(),
                image_bytes: image.png.len() as u64,
            };
            images
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(image.hash, image.png);
            EngineReply::Rendered(reply)
        }
        Err(refusal) => EngineReply::Refused(refusal),
    }
}

/// The images headless renders produced, served by content hash on the asset
/// plane. Bounded: an image can always be rendered again from its revision
/// and frame, so evicting the oldest loses nothing that cannot be rebuilt.
#[derive(Debug)]
pub struct RenderedImages {
    capacity: usize,
    order: VecDeque<ContentHash>,
    images: HashMap<ContentHash, Arc<Vec<u8>>>,
}

impl RenderedImages {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            order: VecDeque::new(),
            images: HashMap::new(),
        }
    }

    pub fn insert(&mut self, hash: ContentHash, png: Arc<Vec<u8>>) {
        if self.images.insert(hash.clone(), png).is_some() {
            return;
        }
        self.order.push_back(hash);
        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.images.remove(&oldest);
            }
        }
    }

    pub fn get(&self, hash: &ContentHash) -> Option<Arc<Vec<u8>>> {
        self.images.get(hash).cloned()
    }
}

/// How far two renders of the same revision and frame may differ when they
/// come from different machines or drivers (11.41's verification record).
///
/// Basic IEEE-754 arithmetic is exact on every conforming CPU; what can differ
/// is the platform maths library's transcendental functions (rotation's sine
/// and cosine, the transfer curves' powers), by a unit in the last place. That
/// moves only a value lying on an 8-bit rounding boundary, by one code value.
/// So two renders agree when no channel differs by more than one code value
/// and at most 0.1% of pixels differ at all. Anything larger is a rendering
/// difference, not arithmetic noise, and fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageTolerance {
    pub max_channel_delta: u8,
    pub max_differing_pixels_per_million: u64,
}

pub const CROSS_MACHINE_TOLERANCE: ImageTolerance = ImageTolerance {
    max_channel_delta: 1,
    max_differing_pixels_per_million: 1_000,
};

impl ImageTolerance {
    /// Whether a measured difference between two same-sized images is within
    /// this tolerance.
    pub fn admits(&self, differing_pixels: u64, total_pixels: u64, max_channel_delta: u8) -> bool {
        max_channel_delta <= self.max_channel_delta
            && differing_pixels.saturating_mul(1_000_000)
                <= self.max_differing_pixels_per_million.saturating_mul(total_pixels)
    }
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
/// Fixed, so the same pixels always deflate to the same bytes.
const DEFLATE_LEVEL: u8 = 6;

/// Encode tightly packed RGBA8 as a non-interlaced PNG, every row unfiltered.
pub fn encode_png(frame: &Frame) -> Vec<u8> {
    let row = frame.width as usize * 4;
    let mut raw = Vec::with_capacity((row + 1) * frame.height as usize);
    for pixels in frame.pixels.chunks_exact(row) {
        raw.push(0);
        raw.extend_from_slice(pixels);
    }
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&frame.width.to_be_bytes());
    header.extend_from_slice(&frame.height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut png = PNG_SIGNATURE.to_vec();
    write_chunk(&mut png, b"IHDR", &header);
    write_chunk(&mut png, b"IDAT", &miniz_oxide::deflate::compress_to_vec_zlib(&raw, DEFLATE_LEVEL));
    write_chunk(&mut png, b"IEND", &[]);
    png
}

/// Decode the PNG form [`encode_png`] writes: non-interlaced RGBA8 with
/// unfiltered rows. Anything else is refused by name rather than guessed at.
pub fn decode_png(png: &[u8]) -> Result<Frame, Refusal> {
    let refuse = |what: &str| Refusal::NotImplemented {
        what: format!("headless image decode: {what}"),
    };
    let body = png.strip_prefix(&PNG_SIGNATURE[..]).ok_or_else(|| refuse("not a PNG"))?;
    let (mut cursor, mut size, mut compressed) = (0usize, None, Vec::new());
    while cursor + 12 <= body.len() {
        let length = u32::from_be_bytes(body[cursor..cursor + 4].try_into().expect("four bytes")) as usize;
        let kind = &body[cursor + 4..cursor + 8];
        let end = cursor + 8 + length;
        let data = body.get(cursor + 8..end).ok_or_else(|| refuse("truncated chunk"))?;
        let stored = body.get(end..end + 4).ok_or_else(|| refuse("truncated CRC"))?;
        if crc32(&body[cursor + 4..end]).to_be_bytes() != stored {
            return Err(refuse("chunk CRC mismatch"));
        }
        match kind {
            b"IHDR" if data.len() == 13 && data[8..] == [8, 6, 0, 0, 0] => {
                let width = u32::from_be_bytes(data[0..4].try_into().expect("four bytes"));
                let height = u32::from_be_bytes(data[4..8].try_into().expect("four bytes"));
                size = Some((width, height));
            }
            b"IHDR" => return Err(refuse("only non-interlaced RGBA8 is read")),
            b"IDAT" => compressed.extend_from_slice(data),
            _ => {}
        }
        cursor = end + 4;
    }
    let (width, height) = size.ok_or_else(|| refuse("no IHDR"))?;
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&compressed).map_err(|_| refuse("IDAT does not inflate"))?;
    let row = width as usize * 4;
    if raw.len() != (row + 1) * height as usize {
        return Err(refuse("IDAT length does not match the image size"));
    }
    let mut pixels = Vec::with_capacity(row * height as usize);
    for line in raw.chunks_exact(row + 1) {
        if line[0] != 0 {
            return Err(refuse("only unfiltered rows are read"));
        }
        pixels.extend_from_slice(&line[1..]);
    }
    Ok(Frame { width, height, pixels })
}

fn write_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = png.len();
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let crc = crc32(&png[start..]);
    png.extend_from_slice(&crc.to_be_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tolerance_admits_boundary_noise_and_refuses_a_rendering_difference() {
        let total = 1920 * 1080;
        assert!(CROSS_MACHINE_TOLERANCE.admits(0, total, 0));
        assert!(CROSS_MACHINE_TOLERANCE.admits(2_073, total, 1), "0.1% of pixels by one code value");
        assert!(!CROSS_MACHINE_TOLERANCE.admits(2_074, total, 1), "more than 0.1% of pixels");
        assert!(!CROSS_MACHINE_TOLERANCE.admits(1, total, 2), "one pixel off by two code values");
    }

    #[test]
    fn a_png_round_trips_and_the_same_pixels_encode_to_the_same_bytes() {
        let frame = Frame {
            width: 3,
            height: 2,
            pixels: (0..24).map(|value| value as u8 * 10).collect(),
        };
        let png = encode_png(&frame);
        assert_eq!(encode_png(&frame), png);
        assert_eq!(decode_png(&png).unwrap(), frame);
    }
}
