//! The colour pipeline (build plan 3.3; working spaces 3.15).
//!
//! A texture without an explicit source space is indistinguishable from one
//! decoded with the wrong transfer curve, and a scene composited in a space
//! nobody chose looks right until it meets the design it came from. This
//! module makes both boundaries explicit. It converts tagged colour and
//! RGBA8 texture data exactly once into the scene's premultiplied working
//! space ([`WorkingColorSpace`]: display-referred sRGB or linear sRGB),
//! keeps composition there, and encodes only at the output adapter boundary
//! through the contract's [`OutputTransform`]. No renderer owns a second
//! transfer curve implementation (invariant 27).

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

/// One premultiplied pixel in a scene's working space (3.15).
///
/// The components are working-space values: sRGB-encoded in an sRGB scene,
/// linear light in a linear one. A pixel does not carry its space; the scene
/// does, and every conversion in or out names it. Use [`WorkingRgba::over`]
/// and [`WorkingRgba::mix`] to composite and [`WorkingRgba::encode`] only
/// when delivering a frame to an output adapter.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorkingRgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl WorkingRgba {
    /// Convert a tagged contract colour once into the premultiplied working
    /// space: decode its transfer curve to linear light, move P3 primaries to
    /// sRGB primaries, then express the result in `space`.
    pub fn from_source(source: Rgba, space: WorkingColorSpace) -> Self {
        let [r, g, b] = source.to_linear();
        let [r, g, b] = match source.space {
            SourceColorSpace::DisplayP3 => display_p3_to_linear_srgb(r, g, b),
            _ => [r, g, b],
        };
        let [r, g, b] = [space.from_linear(r), space.from_linear(g), space.from_linear(b)];
        let a = source.a as f32;
        Self {
            r: r as f32 * a,
            g: g as f32 * a,
            b: b as f32 * a,
            a,
        }
    }

    /// A fully opaque pixel already expressed in the working space.
    pub const fn opaque(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b, a: 1.0 }
    }

    /// A transparent black pixel; the same in every working space.
    pub const fn transparent() -> Self {
        Self {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.0,
        }
    }

    /// Re-express a premultiplied linear-light pixel in `space`. Path paints
    /// are prepared in linear light and pass through here once per published
    /// scene (3.15), never per frame.
    pub fn linear_to(self, space: WorkingColorSpace) -> Self {
        let [r, g, b] = self.straight_rgb();
        let convert = |c: f32| space.from_linear(f64::from(c)) as f32;
        Self {
            r: convert(r) * self.a,
            g: convert(g) * self.a,
            b: convert(b) * self.a,
            a: self.a,
        }
    }

    /// Composite this source pixel over a destination in the same working
    /// space. Coverage is folded into the source's alpha, so this is also
    /// the anti-aliased edge's operation (3.15).
    pub fn over(self, destination: Self) -> Self {
        let remaining = 1.0 - self.a;
        Self {
            r: self.r + destination.r * remaining,
            g: self.g + destination.g * remaining,
            b: self.b + destination.b * remaining,
            a: self.a + destination.a * remaining,
        }
    }

    /// Apply an opacity to a premultiplied pixel: every component scales, the
    /// same in every working space.
    pub fn scaled(self, opacity: f32) -> Self {
        Self {
            r: self.r * opacity,
            g: self.g * opacity,
            b: self.b * opacity,
            a: self.a * opacity,
        }
    }

    /// Interpolate two premultiplied pixels in the working space: the one
    /// operation behind a gradient's stops and a blur's average (3.15). The
    /// space it runs in is the point: black and white mix to 50% grey in an
    /// sRGB scene and to 50% light in a linear one.
    pub fn mix(self, other: Self, t: f32) -> Self {
        let keep = 1.0 - t;
        Self {
            r: self.r * keep + other.r * t,
            g: self.g * keep + other.g * t,
            b: self.b * keep + other.b * t,
            a: self.a * keep + other.a * t,
        }
    }

    /// Encode the premultiplied working-space pixel for precisely one output
    /// surface: back to linear light, then through the output's curve, once.
    pub fn encode(self, output: OutputTransform, space: WorkingColorSpace) -> [u8; 4] {
        let [r, g, b] = self.straight_rgb();
        let channel = |c: f32| quantize(output.encode(space.to_linear(f64::from(c))));
        [channel(r), channel(g), channel(b), quantize(f64::from(self.a))]
    }

    fn straight_rgb(self) -> [f32; 3] {
        if self.a == 0.0 {
            [0.0, 0.0, 0.0]
        } else {
            [self.r / self.a, self.g / self.a, self.b / self.a]
        }
    }
}

/// A decoded texture in a scene's working space, with no source tag left.
///
/// Conversion in [`WorkingTexture::upload`] is the sole texture conversion
/// point; callers can sample or composite these pixels without per-pixel
/// transfer work in a renderer.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkingTexture {
    width: u32,
    height: u32,
    pixels: Vec<WorkingRgba>,
}

impl WorkingTexture {
    /// Convert the supplied tagged texture once, at the engine boundary,
    /// into the scene's working space.
    pub fn upload(upload: TextureUpload, space: WorkingColorSpace) -> Self {
        let pixels = upload
            .rgba8
            .chunks_exact(4)
            .map(|texel| {
                WorkingRgba::from_source(Rgba::new(
                    f64::from(texel[0]) / 255.0,
                    f64::from(texel[1]) / 255.0,
                    f64::from(texel[2]) / 255.0,
                    f64::from(texel[3]) / 255.0,
                    upload.source,
                ), space)
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

    /// The premultiplied working-space texels, in row-major order.
    pub fn pixels(&self) -> &[WorkingRgba] {
        &self.pixels
    }
}

/// A render target in one working space. Rasterisers accumulate here;
/// adapters choose the one output transform at emission time.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkingFrame {
    width: u32,
    height: u32,
    space: WorkingColorSpace,
    pixels: Vec<WorkingRgba>,
}

impl WorkingFrame {
    /// Create a transparent target in `space`.
    pub fn new(width: u32, height: u32, space: WorkingColorSpace) -> Self {
        let pixel_count = usize::try_from(width)
            .expect("u32 width fits usize on supported render hosts")
            .checked_mul(
                usize::try_from(height).expect("u32 height fits usize on supported render hosts"),
            )
            .expect("render target dimensions must fit address space");
        Self {
            width,
            height,
            space,
            pixels: vec![WorkingRgba::transparent(); pixel_count],
        }
    }

    /// Fill a deterministic ramp of linear light, expressed in `space`.
    ///
    /// This is intentionally an engine-path primitive rather than an encoded
    /// test image: the ramp passes through the exact render target and output
    /// boundary used by real rasterisers. It is light-referred, so it encodes
    /// to the same bytes whichever working space carries it.
    pub fn swept_linear_ramp(width: u32, height: u32, space: WorkingColorSpace) -> Self {
        let mut frame = Self::new(width, height, space);
        if width == 0 {
            return frame;
        }
        let denominator = width.saturating_sub(1).max(1) as f32;
        for row in frame.pixels.chunks_exact_mut(width as usize) {
            for (x, pixel) in row.iter_mut().enumerate() {
                let light = f64::from(x as f32 / denominator);
                let value = space.from_linear(light) as f32;
                *pixel = WorkingRgba::opaque(value, value, value);
            }
        }
        frame
    }

    /// Composite a source pixel over one target pixel.
    pub fn composite_over(&mut self, x: u32, y: u32, source: WorkingRgba) {
        let index = y as usize * self.width as usize + x as usize;
        self.pixels[index] = source.over(self.pixels[index]);
    }

    /// Encode this frame once at the output-adapter boundary.
    pub fn encode(&self, output: OutputTransform) -> Frame {
        let mut pixels = Vec::with_capacity(self.pixels.len() * 4);
        for pixel in &self.pixels {
            pixels.extend_from_slice(&pixel.encode(output, self.space));
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

    const SPACES: [WorkingColorSpace; 2] = [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb];

    /// Within ±1 code value: the 3.15 done-when's tolerance. An exact .5
    /// boundary (127.5 for a 50% value) may round either way in f32.
    fn near(actual: [u8; 4], expected: [u8; 4]) -> bool {
        actual.iter().zip(expected).all(|(a, e)| a.abs_diff(e) <= 1)
    }

    #[test]
    fn tagged_srgb_texture_decodes_once_at_upload() {
        for space in SPACES {
            let texture = WorkingTexture::upload(
                TextureUpload::new(1, 1, SourceColorSpace::Srgb, vec![128, 128, 128, 255]).unwrap(),
                space,
            );

            assert_eq!(texture.dimensions(), (1, 1));
            assert_eq!(
                texture.pixels()[0].encode(OutputTransform::Srgb, space),
                [128, 128, 128, 255],
                "{space:?}"
            );
        }
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
    fn source_over_an_identical_colour_is_unchanged_in_either_space() {
        for space in SPACES {
            let source = WorkingRgba::from_source(Rgba::srgb(0.5, 0.5, 0.5, 0.5), space);
            let destination = WorkingRgba::from_source(Rgba::srgb(0.5, 0.5, 0.5, 1.0), space);
            let encoded = source.over(destination).encode(OutputTransform::Srgb, space);

            assert_eq!(encoded, [128, 128, 128, 255], "{space:?}");
        }
    }

    /// 3.15's rendered reference value: 50% black over white. In an sRGB
    /// scene the overlap is 50% *grey* — Preview 128, Program 115 — which is
    /// what Figma and Photoshop show; in a linear scene it is 50% *light* —
    /// Preview 188, Program 180. Expected codes were computed independently
    /// from the IEC 61966-2-1 and BT.709 formulas (memory.md, 13 October).
    #[test]
    fn half_black_over_white_composites_in_the_working_space() {
        for (space, preview, program) in [
            (WorkingColorSpace::Srgb, 128, 115),
            (WorkingColorSpace::LinearSrgb, 188, 180),
        ] {
            let black = WorkingRgba::from_source(Rgba::srgb(0.0, 0.0, 0.0, 0.5), space);
            let white = WorkingRgba::from_source(Rgba::srgb(1.0, 1.0, 1.0, 1.0), space);
            let overlap = black.over(white);
            let srgb = overlap.encode(OutputTransform::Srgb, space);
            let rec709 = overlap.encode(OutputTransform::Rec709, space);
            assert!(near(srgb, [preview, preview, preview, 255]), "{space:?} Preview {srgb:?}");
            assert!(near(rec709, [program, program, program, 255]), "{space:?} Program {rec709:?}");
        }
    }

    /// 3.15's reference operations, which 3.16, 3.17 and 3.22 must match:
    /// a 25%-coverage anti-aliased edge (white over black at a quarter of
    /// its alpha), a two-stop gradient's midpoint and a two-tap blur's
    /// average, in both working spaces and at both outputs.
    #[test]
    fn coverage_gradient_and_blur_follow_the_working_space() {
        for (space, edge, edge_program, mid, mid_program) in [
            (WorkingColorSpace::Srgb, 64, 48, 128, 115),
            (WorkingColorSpace::LinearSrgb, 137, 125, 188, 180),
        ] {
            let black = WorkingRgba::from_source(Rgba::srgb(0.0, 0.0, 0.0, 1.0), space);
            let white = WorkingRgba::from_source(Rgba::srgb(1.0, 1.0, 1.0, 1.0), space);
            let quarter = WorkingRgba::from_source(Rgba::srgb(1.0, 1.0, 1.0, 0.25), space);

            let antialiased = quarter.over(black);
            assert!(near(antialiased.encode(OutputTransform::Srgb, space), [edge, edge, edge, 255]), "{space:?} edge");
            assert!(near(antialiased.encode(OutputTransform::Rec709, space), [edge_program, edge_program, edge_program, 255]), "{space:?} edge Program");

            let gradient_midpoint = black.mix(white, 0.5);
            let blur_average = white.mix(black, 0.5);
            for value in [gradient_midpoint, blur_average] {
                assert!(near(value.encode(OutputTransform::Srgb, space), [mid, mid, mid, 255]), "{space:?} mix");
                assert!(near(value.encode(OutputTransform::Rec709, space), [mid_program, mid_program, mid_program, 255]), "{space:?} mix Program");
            }

            let red = WorkingRgba::from_source(Rgba::srgb(1.0, 0.0, 0.0, 1.0), space);
            let blue = WorkingRgba::from_source(Rgba::srgb(0.0, 0.0, 1.0, 1.0), space);
            assert!(near(red.mix(blue, 0.5).encode(OutputTransform::Srgb, space), [mid, 0, mid, 255]), "{space:?} red-blue stop");
        }
    }

    /// Path paints are prepared in linear light and re-expressed once; the
    /// result is the colour `from_source` gives directly.
    #[test]
    fn a_linear_paint_re_expressed_matches_a_direct_conversion() {
        let colour = Rgba::srgb(0.2, 0.6, 0.9, 0.5);
        for space in SPACES {
            let via_linear = WorkingRgba::from_source(colour, WorkingColorSpace::LinearSrgb).linear_to(space);
            let direct = WorkingRgba::from_source(colour, space);
            for (a, b) in [(via_linear.r, direct.r), (via_linear.g, direct.g), (via_linear.b, direct.b), (via_linear.a, direct.a)] {
                assert!((a - b).abs() < 1e-6, "{space:?}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn swept_linear_ramp_matches_contract_reference_byte_for_byte() {
        let width = 257;
        let height = 3;
        for space in SPACES {
            let rendered = WorkingFrame::swept_linear_ramp(width, height, space).encode(OutputTransform::Srgb);

            assert_eq!(
                rendered.pixels,
                reference_ramp(width, height, OutputTransform::Srgb),
                "a light-referred ramp encodes identically from {space:?}"
            );
        }
    }

    #[test]
    fn one_linear_frame_encodes_for_srgb_preview_and_rec709_broadcast() {
        let frame = WorkingFrame::swept_linear_ramp(257, 1, WorkingColorSpace::LinearSrgb);

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
