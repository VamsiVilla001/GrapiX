//! The linear colour pipeline (build plan 3.3).
//!
//! A texture without an explicit source space is indistinguishable from one
//! decoded with the wrong transfer curve. That fault is especially expensive:
//! blending encoded texels produces dark edges which only appear when a scene
//! reaches another output. This module makes the boundary explicit. It decodes
//! tagged RGBA8 texture data exactly once into premultiplied linear-sRGB, keeps
//! composition there, and encodes only at the output adapter boundary through
//! the contract's [`OutputTransform`]. No renderer owns a second transfer
//! curve implementation (invariant 27).

use std::error::Error;
use std::fmt;

use gx_contracts::color::{OutputTransform, Rgba, SourceColorSpace, WorkingColorSpace};

use crate::rasterizer::Frame;

/// A texture's encoded bytes as they cross into the render engine.
///
/// `source` is required at construction. There is deliberately no untagged
/// constructor, so an importer must refuse an unknown source space before it
/// can reach a shader or software rasteriser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextureUpload {
    width: u32,
    height: u32,
    source: SourceColorSpace,
    rgba8: Vec<u8>,
}

impl TextureUpload {
    /// Build one tagged RGBA8 texture upload.
    pub fn new(
        width: u32,
        height: u32,
        source: SourceColorSpace,
        rgba8: Vec<u8>,
    ) -> Result<Self, TextureUploadError> {
        let pixels = usize::try_from(width)
            .ok()
            .and_then(|width| {
                usize::try_from(height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .ok_or(TextureUploadError::DimensionsOverflow { width, height })?;
        let expected = pixels
            .checked_mul(4)
            .ok_or(TextureUploadError::DimensionsOverflow { width, height })?;
        if rgba8.len() != expected {
            return Err(TextureUploadError::InvalidByteLength {
                width,
                height,
                expected,
                actual: rgba8.len(),
            });
        }
        Ok(Self {
            width,
            height,
            source,
            rgba8,
        })
    }

    /// The tagged colour space the importer declared for every texel.
    pub const fn source(&self) -> SourceColorSpace {
        self.source
    }
}

/// A named refusal for malformed texture uploads.
///
/// Upload data is external input; accepting a short or ambiguous buffer would
/// invent pixels rather than render the supplied asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextureUploadError {
    /// Width × height cannot be represented as a byte count on this machine.
    DimensionsOverflow { width: u32, height: u32 },
    /// The upload did not contain exactly one RGBA8 texel per declared pixel.
    InvalidByteLength {
        width: u32,
        height: u32,
        expected: usize,
        actual: usize,
    },
}

impl fmt::Display for TextureUploadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DimensionsOverflow { width, height } => {
                write!(
                    formatter,
                    "texture dimensions {width}×{height} overflow the byte count"
                )
            }
            Self::InvalidByteLength {
                width,
                height,
                expected,
                actual,
            } => write!(
                formatter,
                "texture {width}×{height} requires {expected} RGBA8 bytes, received {actual}"
            ),
        }
    }
}

impl Error for TextureUploadError {}

/// One premultiplied pixel in the sole linear working space.
///
/// These values are linear-sRGB, never encoded values. Use
/// [`LinearRgba::over`] for alpha composition and [`LinearRgba::encode`] only
/// when delivering a frame to an output adapter.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinearRgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl LinearRgba {
    /// Decode a tagged contract colour once into premultiplied linear-sRGB.
    pub fn from_source(source: Rgba) -> Self {
        let [r, g, b] = source.to_linear();
        let [r, g, b] = match source.space {
            SourceColorSpace::DisplayP3 => display_p3_to_linear_srgb(r, g, b),
            _ => [r, g, b],
        };
        let a = source.a as f32;
        Self {
            r: r as f32 * a,
            g: g as f32 * a,
            b: b as f32 * a,
            a,
        }
    }

    /// A fully opaque pixel already expressed in the linear working space.
    pub const fn opaque(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b, a: 1.0 }
    }

    /// A transparent black pixel in the linear working space.
    pub const fn transparent() -> Self {
        Self {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.0,
        }
    }

    /// The one working space compositing is permitted to use.
    pub const fn working_space() -> WorkingColorSpace {
        WorkingColorSpace::LinearSrgb
    }

    /// Composite this source pixel over an already-linear destination pixel.
    pub fn over(self, destination: Self) -> Self {
        let remaining = 1.0 - self.a;
        Self {
            r: self.r + destination.r * remaining,
            g: self.g + destination.g * remaining,
            b: self.b + destination.b * remaining,
            a: self.a + destination.a * remaining,
        }
    }

    /// Encode the premultiplied linear pixel for precisely one output surface.
    pub fn encode(self, output: OutputTransform) -> [u8; 4] {
        let [r, g, b] = self.straight_rgb();
        [
            quantize(output.encode(f64::from(r))),
            quantize(output.encode(f64::from(g))),
            quantize(output.encode(f64::from(b))),
            quantize(f64::from(self.a)),
        ]
    }

    fn straight_rgb(self) -> [f32; 3] {
        if self.a == 0.0 {
            [0.0, 0.0, 0.0]
        } else {
            [self.r / self.a, self.g / self.a, self.b / self.a]
        }
    }
}

/// A decoded texture which contains no encoded values and no source tag.
///
/// Decoding in [`LinearTexture::upload`] is the sole texture conversion point;
/// callers can sample or composite these pixels without per-pixel transfer
/// work in a renderer.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearTexture {
    width: u32,
    height: u32,
    pixels: Vec<LinearRgba>,
}

impl LinearTexture {
    /// Decode the supplied tagged texture once at the engine boundary.
    pub fn upload(upload: TextureUpload) -> Self {
        let pixels = upload
            .rgba8
            .chunks_exact(4)
            .map(|texel| {
                LinearRgba::from_source(Rgba::new(
                    f64::from(texel[0]) / 255.0,
                    f64::from(texel[1]) / 255.0,
                    f64::from(texel[2]) / 255.0,
                    f64::from(texel[3]) / 255.0,
                    upload.source,
                ))
            })
            .collect();
        Self {
            width: upload.width,
            height: upload.height,
            pixels,
        }
    }

    /// The decoded texture dimensions.
    pub const fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// The linear premultiplied texels, in row-major order.
    pub fn pixels(&self) -> &[LinearRgba] {
        &self.pixels
    }
}

/// A linear render target. Rasterisers accumulate here; adapters choose the
/// one output transform at emission time.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearFrame {
    width: u32,
    height: u32,
    pixels: Vec<LinearRgba>,
}

impl LinearFrame {
    /// Create a transparent target in the linear working space.
    pub fn new(width: u32, height: u32) -> Self {
        let pixel_count = usize::try_from(width)
            .expect("u32 width fits usize on supported render hosts")
            .checked_mul(
                usize::try_from(height).expect("u32 height fits usize on supported render hosts"),
            )
            .expect("render target dimensions must fit address space");
        Self {
            width,
            height,
            pixels: vec![LinearRgba::transparent(); pixel_count],
        }
    }

    /// Fill a deterministic swept linear gradient in the working space.
    ///
    /// This is intentionally an engine-path primitive rather than an encoded
    /// test image: the ramp passes through the exact render target and output
    /// boundary used by real rasterisers.
    pub fn swept_linear_ramp(width: u32, height: u32) -> Self {
        let mut frame = Self::new(width, height);
        if width == 0 {
            return frame;
        }
        let denominator = width.saturating_sub(1).max(1) as f32;
        for row in frame.pixels.chunks_exact_mut(width as usize) {
            for (x, pixel) in row.iter_mut().enumerate() {
                let value = x as f32 / denominator;
                *pixel = LinearRgba::opaque(value, value, value);
            }
        }
        frame
    }

    /// Composite a source pixel over one target pixel.
    pub fn composite_over(&mut self, x: u32, y: u32, source: LinearRgba) {
        let index = y as usize * self.width as usize + x as usize;
        self.pixels[index] = source.over(self.pixels[index]);
    }

    /// Encode this linear frame once at the output-adapter boundary.
    pub fn encode(&self, output: OutputTransform) -> Frame {
        let mut pixels = Vec::with_capacity(self.pixels.len() * 4);
        for pixel in &self.pixels {
            pixels.extend_from_slice(&pixel.encode(output));
        }
        Frame {
            width: self.width,
            height: self.height,
            pixels,
        }
    }

    /// The render target dimensions.
    pub const fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

fn quantize(component: f64) -> u8 {
    (component.clamp(0.0, 1.0) * 255.0).round() as u8
}

// Display P3 and sRGB both use D65. The transfer decode is owned by
// `Rgba::to_linear`; this matrix only converts the P3 primaries into the
// linear-sRGB working primaries (CSS Color 4's D65 conversion).
fn display_p3_to_linear_srgb(r: f64, g: f64, b: f64) -> [f64; 3] {
    [
        1.224_745_49 * r - 0.224_904_44 * g,
        -0.042_058_08 * r + 1.042_080_99 * g,
        -0.019_642_26 * r - 0.078_654_88 * g + 1.098_537_16 * b,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_ramp(width: u32, height: u32, output: OutputTransform) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(width as usize * height as usize * 4);
        let denominator = width.saturating_sub(1).max(1) as f64;
        for _ in 0..height {
            for x in 0..width {
                let linear = f64::from(x) / denominator;
                let encoded = quantize(output.encode(linear));
                bytes.extend_from_slice(&[encoded, encoded, encoded, 255]);
            }
        }
        bytes
    }

    #[test]
    fn tagged_srgb_texture_decodes_once_at_upload() {
        let texture = LinearTexture::upload(
            TextureUpload::new(1, 1, SourceColorSpace::Srgb, vec![128, 128, 128, 255]).unwrap(),
        );

        assert_eq!(texture.dimensions(), (1, 1));
        assert_eq!(
            texture.pixels()[0].encode(OutputTransform::Srgb),
            [128, 128, 128, 255]
        );
    }

    #[test]
    fn texture_upload_refuses_wrong_byte_count_by_name() {
        assert_eq!(
            TextureUpload::new(2, 1, SourceColorSpace::Linear, vec![0; 7]).unwrap_err(),
            TextureUploadError::InvalidByteLength {
                width: 2,
                height: 1,
                expected: 8,
                actual: 7,
            }
        );
    }

    #[test]
    fn source_over_composites_in_linear_not_encoded_space() {
        let source = LinearRgba::from_source(Rgba::srgb(0.5, 0.5, 0.5, 0.5));
        let destination = LinearRgba::from_source(Rgba::srgb(0.5, 0.5, 0.5, 1.0));
        let encoded = source.over(destination).encode(OutputTransform::Srgb);

        assert_eq!(encoded, [128, 128, 128, 255]);
    }

    #[test]
    fn swept_linear_ramp_matches_contract_reference_byte_for_byte() {
        let width = 257;
        let height = 3;
        let rendered = LinearFrame::swept_linear_ramp(width, height).encode(OutputTransform::Srgb);

        assert_eq!(
            rendered.pixels,
            reference_ramp(width, height, OutputTransform::Srgb)
        );
    }

    #[test]
    fn one_linear_frame_encodes_for_srgb_preview_and_rec709_broadcast() {
        let frame = LinearFrame::swept_linear_ramp(257, 1);

        assert_eq!(
            frame.encode(OutputTransform::Srgb).pixels,
            reference_ramp(257, 1, OutputTransform::Srgb)
        );
        assert_eq!(
            frame.encode(OutputTransform::Rec709).pixels,
            reference_ramp(257, 1, OutputTransform::Rec709)
        );
        assert_ne!(
            frame.encode(OutputTransform::Srgb).pixels,
            frame.encode(OutputTransform::Rec709).pixels,
            "the adapter transform, not the platform, selects the output curve"
        );
    }
}
