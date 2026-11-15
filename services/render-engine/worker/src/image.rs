//! Image quads (3.17, user decisions 15 Nov 2026): PNG only, the source
//! colour space from the asset record (never inferred, B.1), all eight fit
//! modes.
//!
//! At prepare an image is decoded once into premultiplied working-space float
//! texels ([`DecodedImage`]). Each image object then gets a box raster in its
//! own layer space, built from a [`FitPlan`]: for each raster pixel centre, a
//! piecewise-linear map per axis to image texel coordinates (one segment for
//! the scaled modes, three for nine-slice), sampled bilinearly with clamped
//! edges (nearest for pixel-perfect, wrapping for tile), scaled by how much
//! of the pixel the image covers, and by the pixel's coverage of the box when
//! the mode clips to it. The
//! GPU pass (`compositor/image.wgsl`) evaluates the same plan with the same
//! f32 operations; the compositor then warps the raster like any layer.

use crate::colour_pipeline::WorkingRgba;
use gx_contracts::color::{Rgba, SourceColorSpace, WorkingColorSpace};
use gx_contracts::material::FitMode;
use gx_contracts::scene::{ImageObject, ImageSlice};
use gx_contracts::Refusal;

/// The most texels a decoded image may have, checked from its header before
/// any pixel is decoded (invariant 51): 4096 x 4096.
pub const MOST_IMAGE_TEXELS: u64 = 4096 * 4096;

/// Every image object's decoded image, by asset id (3.17).
pub type PreparedImages = std::collections::HashMap<String, std::sync::Arc<DecodedImage>>;

/// Decode, once per asset, the image of every image object in `document`.
/// The validator has already refused an unknown, untagged or unstored asset.
pub fn prepare_images(
    document: &gx_contracts::scene::SceneDocument,
    asset_bytes: &crate::mesh::AssetBytes,
) -> Result<PreparedImages, Refusal> {
    let mut images = PreparedImages::new();
    for object in &document.objects {
        let gx_contracts::scene::SceneObject::Image(image) = object else {
            continue;
        };
        if images.contains_key(&image.asset_id) {
            continue;
        }
        let id = &image.base.id;
        let asset = document
            .assets
            .iter()
            .find(|a| a.asset_id == image.asset_id)
            .ok_or_else(|| {
                refuse(
                    id,
                    &image.asset_id,
                    "the asset is not in the scene's asset library".into(),
                )
            })?;
        let tag = asset
            .color_space
            .ok_or_else(|| refuse(id, &image.asset_id, "the asset has no colour space".into()))?;
        let bytes = asset
            .checksum
            .as_ref()
            .and_then(|hash| asset_bytes.get(hash))
            .ok_or_else(|| {
                refuse(
                    id,
                    &image.asset_id,
                    "the asset's bytes have not reached the engine".into(),
                )
            })?;
        let decoded = decode(
            id,
            &image.asset_id,
            bytes,
            tag,
            document.working_color_space,
        )?;
        images.insert(image.asset_id.clone(), std::sync::Arc::new(decoded));
    }
    Ok(images)
}

/// An image decoded once at prepare: premultiplied, in the working space.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub texels: Vec<WorkingRgba>,
}

fn refuse(object: &str, asset: &str, detail: String) -> Refusal {
    Refusal::ImageNotDrawable {
        object: object.into(),
        asset: asset.into(),
        detail,
    }
}

/// Decode a PNG into working-space float texels, its values read in `tag`.
pub fn decode(
    object: &str,
    asset: &str,
    bytes: &[u8],
    tag: SourceColorSpace,
    space: WorkingColorSpace,
) -> Result<DecodedImage, Refusal> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(refuse(object, asset, "only PNG images are drawn".into()));
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder
        .read_info()
        .map_err(|e| refuse(object, asset, format!("the PNG cannot be read: {e}")))?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MOST_IMAGE_TEXELS {
        return Err(refuse(
            object,
            asset,
            format!("{width} x {height} texels; at most {MOST_IMAGE_TEXELS} are drawn"),
        ));
    }
    let mut buffer = vec![0; reader.output_buffer_size()];
    let frame = reader
        .next_frame(&mut buffer)
        .map_err(|e| refuse(object, asset, format!("the PNG cannot be decoded: {e}")))?;
    let (channels, depth) = (frame.color_type.samples(), frame.bit_depth);
    let wide = match depth {
        png::BitDepth::Eight => false,
        png::BitDepth::Sixteen => true,
        other => {
            return Err(refuse(
                object,
                asset,
                format!("bit depth {other:?} after expansion"),
            ))
        }
    };
    let sample = |row: &[u8], k: usize| -> f64 {
        if wide {
            f64::from(u16::from_be_bytes([row[2 * k], row[2 * k + 1]])) / 65535.0
        } else {
            f64::from(row[k]) / 255.0
        }
    };
    let mut texels = Vec::with_capacity((width * height) as usize);
    for y in 0..height as usize {
        let row = &buffer[y * frame.line_size..(y + 1) * frame.line_size];
        for x in 0..width as usize {
            let k = x * channels;
            let (r, g, b, a) = match channels {
                1 => {
                    let v = sample(row, k);
                    (v, v, v, 1.0)
                }
                2 => {
                    let v = sample(row, k);
                    (v, v, v, sample(row, k + 1))
                }
                3 => (sample(row, k), sample(row, k + 1), sample(row, k + 2), 1.0),
                _ => (
                    sample(row, k),
                    sample(row, k + 1),
                    sample(row, k + 2),
                    sample(row, k + 3),
                ),
            };
            texels.push(WorkingRgba::from_source(Rgba::new(r, g, b, a, tag), space));
        }
    }
    Ok(DecodedImage {
        width,
        height,
        texels,
    })
}

/// One axis of a fit: box coordinate `b` (object units) to texel coordinate
/// `t = a[s] * b + c[s]`, segment `s` 0 below `k[0]`, 2 above `k[1]`, else 1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FitAxis {
    pub k: [f32; 2],
    pub a: [f32; 3],
    pub c: [f32; 3],
}

impl FitAxis {
    fn linear(scale: f64, offset: f64) -> Self {
        // t = (b - offset) / scale
        let a = (1.0 / scale) as f32;
        let c = (-offset / scale) as f32;
        Self {
            k: [f32::NEG_INFINITY, f32::INFINITY],
            a: [a; 3],
            c: [c; 3],
        }
    }

    /// Nine-slice along one axis: insets `lo` and `hi` texels of an image
    /// `size` texels long, over a box `length` long. Corners keep their size,
    /// scaled down together only when the box is shorter than both.
    fn nine(lo: f64, hi: f64, size: f64, length: f64) -> Self {
        let k = if lo + hi > length && lo + hi > 0.0 {
            length / (lo + hi)
        } else {
            1.0
        };
        let (b0, b1) = (lo * k, length - hi * k);
        let middle_texels = (size - lo - hi).max(0.0);
        let middle_box = b1 - b0;
        let a1 = if middle_box > 0.0 {
            middle_texels / middle_box
        } else {
            0.0
        };
        Self {
            k: [b0 as f32, b1 as f32],
            a: [(1.0 / k) as f32, a1 as f32, (1.0 / k) as f32],
            c: [0.0, (lo - a1 * b0) as f32, (size - length / k) as f32],
        }
    }

    pub(crate) fn map(&self, b: f32) -> f32 {
        let s = if b < self.k[0] {
            0
        } else if b > self.k[1] {
            2
        } else {
            1
        };
        self.a[s] * b + self.c[s]
    }
}

/// How an image object's box raster is built from its image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FitPlan {
    /// The raster: `width` x `height` pixels, pixel (0, 0)'s corner at
    /// `origin` in the object's box coordinates.
    pub width: u32,
    pub height: u32,
    pub origin: [f64; 2],
    pub x: FitAxis,
    pub y: FitAxis,
    /// The box, `[0, w] x [0, h]`, when the mode clips to it.
    pub clip: Option<[f32; 2]>,
    pub tile: bool,
    pub nearest: bool,
}

/// The plan for `image` drawn into a `box_w` x `box_h` box, with `pad` pixels
/// of effect reach around what it draws.
pub fn fit_plan(
    object: &ImageObject,
    image_size: (u32, u32),
    pad: u32,
    limit: u32,
) -> Result<FitPlan, Refusal> {
    let (bw, bh) = (object.base.width, object.base.height);
    let (iw, ih) = (f64::from(image_size.0), f64::from(image_size.1));
    let fail = |detail: String| refuse(&object.base.id, &object.asset_id, detail);
    if !(bw.is_finite() && bh.is_finite() && bw > 0.0 && bh > 0.0) {
        return Err(fail(format!("the box is {bw} x {bh}; an image needs one")));
    }
    let centred = |s: f64| ((bw - iw * s) / 2.0, (bh - ih * s) / 2.0);
    let mut tile = false;
    let mut nearest = false;
    let (x, y, clip, extent) = match object.fit {
        FitMode::Stretch => (
            FitAxis::linear(bw / iw, 0.0),
            FitAxis::linear(bh / ih, 0.0),
            None,
            [0.0, 0.0, bw, bh],
        ),
        FitMode::Contain | FitMode::Cover => {
            let s = if object.fit == FitMode::Contain {
                (bw / iw).min(bh / ih)
            } else {
                (bw / iw).max(bh / ih)
            };
            let (ox, oy) = centred(s);
            let clip = (object.fit == FitMode::Cover).then_some([bw as f32, bh as f32]);
            (
                FitAxis::linear(s, ox),
                FitAxis::linear(s, oy),
                clip,
                [
                    ox.max(0.0),
                    oy.max(0.0),
                    (ox + iw * s).min(bw),
                    (oy + ih * s).min(bh),
                ],
            )
        }
        FitMode::Crop | FitMode::Original | FitMode::PixelPerfect => {
            let (mut ox, mut oy) = centred(1.0);
            if object.fit == FitMode::PixelPerfect {
                // One texel to one pixel: whole-pixel placement (the centred
                // offset rounded half away from zero), unfiltered.
                (ox, oy) = (ox.round(), oy.round());
                nearest = true;
            }
            let clip = (object.fit != FitMode::Original).then_some([bw as f32, bh as f32]);
            let extent = if clip.is_some() {
                [0.0, 0.0, bw, bh]
            } else {
                [
                    ox.min(0.0),
                    oy.min(0.0),
                    (ox + iw).max(bw),
                    (oy + ih).max(bh),
                ]
            };
            (
                FitAxis::linear(1.0, ox),
                FitAxis::linear(1.0, oy),
                clip,
                extent,
            )
        }
        FitMode::Tile => {
            tile = true;
            (
                FitAxis::linear(1.0, 0.0),
                FitAxis::linear(1.0, 0.0),
                Some([bw as f32, bh as f32]),
                [0.0, 0.0, bw, bh],
            )
        }
        FitMode::NineSlice => {
            let Some(ImageSlice {
                left,
                top,
                right,
                bottom,
            }) = object.slice
            else {
                return Err(fail("fit nine-slice needs slice insets".into()));
            };
            if left + right > iw || top + bottom > ih {
                return Err(fail(format!(
                    "nine-slice insets {left}, {top}, {right}, {bottom} exceed the {iw} x {ih} image"
                )));
            }
            (
                FitAxis::nine(left, right, iw, bw),
                FitAxis::nine(top, bottom, ih, bh),
                Some([bw as f32, bh as f32]),
                [0.0, 0.0, bw, bh],
            )
        }
    };
    let pad = f64::from(pad);
    let origin = [extent[0].floor() - pad, extent[1].floor() - pad];
    let width = extent[2].ceil() + pad - origin[0];
    let height = extent[3].ceil() + pad - origin[1];
    if width > f64::from(limit) || height > f64::from(limit) {
        return Err(fail(format!(
            "the image's raster {width} x {height} exceeds the device limit {limit}"
        )));
    }
    Ok(FitPlan {
        width: width.max(1.0) as u32,
        height: height.max(1.0) as u32,
        origin,
        x,
        y,
        clip,
        tile,
        nearest,
    })
}

fn texel(image: &DecodedImage, x: i32, y: i32, tile: bool) -> WorkingRgba {
    let (w, h) = (image.width as i32, image.height as i32);
    let (x, y) = if tile {
        (x.rem_euclid(w), y.rem_euclid(h))
    } else {
        // Clamped: the image's own edge is not faded; its coverage of the
        // pixel says how much of the pixel it covers.
        (x.clamp(0, w - 1), y.clamp(0, h - 1))
    };
    image.texels[(y * w + x) as usize]
}

/// The coverage of pixel `[b - 0.5, b + 0.5]` by `[0, length]`.
fn box_coverage(b: f32, length: f32) -> f32 {
    ((b + 0.5).min(length) - (b - 0.5).max(0.0)).clamp(0.0, 1.0)
}

/// How much of the pixel centred on box coordinate `b` the image covers along
/// one axis: the pixel's extent mapped into texels, against `[0, size]`.
fn image_coverage(axis: &FitAxis, b: f32, size: f32) -> f32 {
    let t0 = axis.map(b - 0.5);
    let t1 = axis.map(b + 0.5);
    let span = t1 - t0;
    if span > 0.0 {
        (t1.min(size) - t0.max(0.0)).clamp(0.0, span) / span
    } else if t0 >= 0.0 && t0 <= size {
        1.0
    } else {
        0.0
    }
}

impl FitPlan {
    /// Raster pixel `(i, j)`. The WGSL twin performs the same operations in
    /// the same order.
    pub fn sample(&self, image: &DecodedImage, i: u32, j: u32) -> WorkingRgba {
        let bx = self.origin[0] as f32 + i as f32 + 0.5;
        let by = self.origin[1] as f32 + j as f32 + 0.5;
        let size = (image.width as f32, image.height as f32);
        let covered = if self.tile {
            1.0
        } else {
            image_coverage(&self.x, bx, size.0) * image_coverage(&self.y, by, size.1)
        };
        if covered == 0.0 {
            return WorkingRgba::transparent();
        }
        let tx = self.x.map(bx);
        let ty = self.y.map(by);
        let mut p = if self.nearest {
            texel(image, tx.floor() as i32, ty.floor() as i32, self.tile)
        } else {
            let (fx, fy) = (tx - 0.5, ty - 0.5);
            let (lx, ly) = (fx.floor(), fy.floor());
            let (wx, wy) = (fx - lx, fy - ly);
            let (x0, y0) = (lx as i32, ly as i32);
            let a = texel(image, x0, y0, self.tile);
            let b = texel(image, x0 + 1, y0, self.tile);
            let c = texel(image, x0, y0 + 1, self.tile);
            let d = texel(image, x0 + 1, y0 + 1, self.tile);
            let lerp = |p: WorkingRgba, q: WorkingRgba, t: f32| WorkingRgba {
                r: p.r + (q.r - p.r) * t,
                g: p.g + (q.g - p.g) * t,
                b: p.b + (q.b - p.b) * t,
                a: p.a + (q.a - p.a) * t,
            };
            lerp(lerp(a, b, wx), lerp(c, d, wx), wy)
        };
        p = p.scaled(covered);
        if let Some([w, h]) = self.clip {
            p = p.scaled(box_coverage(bx, w) * box_coverage(by, h));
        }
        p
    }

    /// The whole raster on the CPU: the GPU pass's reference.
    pub fn raster(&self, image: &DecodedImage) -> Vec<WorkingRgba> {
        let mut out = Vec::with_capacity((self.width * self.height) as usize);
        for j in 0..self.height {
            for i in 0..self.width {
                out.push(self.sample(image, i, j));
            }
        }
        out
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use gx_contracts::scene::ObjectBase;

    /// A PNG of `width` x `height` RGBA8 texels, tagged sRGB when asked.
    pub(crate) fn png_bytes(width: u32, height: u32, rgba: &[u8], srgb: bool) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            if srgb {
                encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
            }
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(rgba).unwrap();
        }
        out
    }

    /// A 4 x 2 image of distinct opaque texels.
    pub(crate) fn checker() -> DecodedImage {
        let mut texels = Vec::new();
        for y in 0..2 {
            for x in 0..4 {
                texels.push(WorkingRgba::opaque(x as f32 / 3.0, y as f32, 0.25));
            }
        }
        DecodedImage {
            width: 4,
            height: 2,
            texels,
        }
    }

    pub(crate) fn object(fit: FitMode, w: f64, h: f64, slice: Option<ImageSlice>) -> ImageObject {
        let mut base = ObjectBase::new("logo", "logo");
        base.width = w;
        base.height = h;
        ImageObject {
            base,
            asset_id: "a".into(),
            fit,
            slice,
        }
    }

    fn near(a: WorkingRgba, b: WorkingRgba) {
        for (x, y) in [(a.r, b.r), (a.g, b.g), (a.b, b.b), (a.a, b.a)] {
            assert!((x - y).abs() < 1e-5, "{a:?} != {b:?}");
        }
    }

    fn mix(p: WorkingRgba, q: WorkingRgba, t: f32) -> WorkingRgba {
        WorkingRgba {
            r: p.r + (q.r - p.r) * t,
            g: p.g + (q.g - p.g) * t,
            b: p.b + (q.b - p.b) * t,
            a: p.a + (q.a - p.a) * t,
        }
    }

    #[test]
    fn a_png_decodes_into_premultiplied_working_space_texels_in_its_tagged_space() {
        let space = WorkingColorSpace::LinearSrgb;
        let bytes = png_bytes(2, 1, &[255, 0, 0, 255, 0, 0, 255, 128], true);
        let image = decode("logo", "a", &bytes, SourceColorSpace::Srgb, space).unwrap();
        assert_eq!((image.width, image.height), (2, 1));
        near(image.texels[0], WorkingRgba::opaque(1.0, 0.0, 0.0));
        let a = 128.0 / 255.0;
        near(
            image.texels[1],
            WorkingRgba {
                r: 0.0,
                g: 0.0,
                b: a,
                a,
            },
        );
        // The tag decides: sRGB 128 is 0.216 in linear light, linear 128 is 0.502.
        let grey = png_bytes(1, 1, &[128, 128, 128, 255], true);
        let srgb = decode("logo", "a", &grey, SourceColorSpace::Srgb, space).unwrap();
        let linear = decode("logo", "a", &grey, SourceColorSpace::Linear, space).unwrap();
        assert!(
            (srgb.texels[0].r - 0.2158).abs() < 1e-3,
            "{:?}",
            srgb.texels[0]
        );
        assert!((linear.texels[0].r - 128.0 / 255.0).abs() < 1e-5);
    }

    #[test]
    fn what_cannot_be_decoded_is_refused_by_name_before_any_texel_is() {
        let refused = |bytes: &[u8], expect: &str| match decode(
            "logo",
            "a",
            bytes,
            SourceColorSpace::Srgb,
            WorkingColorSpace::Srgb,
        ) {
            Err(Refusal::ImageNotDrawable {
                object,
                asset,
                detail,
            }) => {
                assert_eq!((object.as_str(), asset.as_str()), ("logo", "a"));
                assert!(detail.contains(expect), "{detail}");
            }
            other => panic!("expected a refusal naming {expect}: {other:?}"),
        };
        refused(&[0xff, 0xd8, 0xff, 0xe0], "only PNG");
        refused(b"\x89PNG\r\n\x1a\nnot really", "cannot be read");
        // Bounded from the header (invariant 51).
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 4097, 4097);
            encoder.set_color(png::ColorType::Grayscale);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&vec![0; 4097 * 4097]).unwrap();
        }
        refused(&out, "at most");
    }

    #[test]
    fn each_fit_mode_maps_the_box_onto_the_image_as_named() {
        let img = checker();
        let t = |x: usize, y: usize| img.texels[y * 4 + x];
        let plan = |fit, w, h| fit_plan(&object(fit, w, h, None), (4, 2), 0, 8192).unwrap();
        // Stretch: an 8 x 4 box over 4 x 2 texels. Pixel 1's centre is 0.75
        // texels in: a quarter of the way from texel 0's centre to texel 1's.
        let p = plan(FitMode::Stretch, 8.0, 4.0);
        assert_eq!((p.width, p.height, p.origin), (8, 4, [0.0, 0.0]));
        let quarter = |y: usize| mix(t(0, y), t(1, y), 0.25);
        near(p.sample(&img, 1, 1), mix(quarter(0), quarter(1), 0.25));
        // The image covers its edge pixels fully: clamped, not faded.
        assert_eq!(p.sample(&img, 0, 0).a, 1.0);
        // Contain: 8 x 8 holds the image at 8 x 4, centred: the raster is the
        // image's band, rows 2 to 6 of the box; above and below draw nothing.
        let p = plan(FitMode::Contain, 8.0, 8.0);
        assert_eq!((p.width, p.height, p.origin), (8, 4, [0.0, 2.0]));
        near(p.sample(&img, 1, 0), mix(t(0, 0), t(1, 0), 0.25));
        assert_eq!(p.sample(&img, 1, 0).a, 1.0);
        // Cover: a 2 x 2 box shows the image's middle at native size, clipped.
        let p = plan(FitMode::Cover, 2.0, 2.0);
        assert_eq!((p.width, p.height), (2, 2));
        near(p.sample(&img, 0, 0), t(1, 0));
        near(p.sample(&img, 1, 1), t(2, 1));
        // Crop is native and centred, clipped: the same here.
        near(plan(FitMode::Crop, 2.0, 2.0).sample(&img, 0, 0), t(1, 0));
        // Original is native and centred, not clipped: the raster grows.
        let p = plan(FitMode::Original, 2.0, 2.0);
        assert_eq!((p.width, p.origin), (4, [-1.0, 0.0]));
        near(p.sample(&img, 0, 0), t(0, 0));
        // An image edge between pixel centres covers its pixel partly: a
        // 3 x 2 box holds the 4-texel image at x -0.5 to 3.5.
        let p = plan(FitMode::Original, 3.0, 2.0);
        assert!(
            (p.sample(&img, 0, 0).a - 0.5).abs() < 1e-6,
            "{:?}",
            p.sample(&img, 0, 0)
        );
        // Pixel-perfect: whole-pixel placement, nearest texel, exactly. The
        // centred offset -0.5 rounds half away from zero, to -1.
        let p = plan(FitMode::PixelPerfect, 3.0, 2.0);
        assert_eq!(p.sample(&img, 1, 0), t(2, 0));
        assert_eq!(p.sample(&img, 0, 1), t(1, 1));
        // Tile repeats from the box's top-left corner.
        let p = plan(FitMode::Tile, 8.0, 2.0);
        near(p.sample(&img, 4, 0), t(0, 0));
        near(p.sample(&img, 7, 1), t(3, 1));
        // A clipping mode covers a fractional last column partially.
        let p = plan(FitMode::Crop, 2.5, 2.0);
        assert_eq!(p.width, 3);
        assert!((p.sample(&img, 2, 0).a - 0.5).abs() < 1e-6);
    }

    #[test]
    fn nine_slice_keeps_corners_and_stretches_edges_and_centre() {
        let img = DecodedImage {
            width: 4,
            height: 4,
            texels: (0..16)
                .map(|k| WorkingRgba::opaque(k as f32 / 15.0, 0.0, 0.0))
                .collect(),
        };
        let inset = |l, r| {
            Some(ImageSlice {
                left: l,
                top: 1.0,
                right: r,
                bottom: 1.0,
            })
        };
        let p = fit_plan(
            &object(FitMode::NineSlice, 8.0, 8.0, inset(1.0, 1.0)),
            (4, 4),
            0,
            8192,
        )
        .unwrap();
        // A corner pixel is its corner texel, unscaled.
        near(p.sample(&img, 0, 0), img.texels[0]);
        near(p.sample(&img, 7, 7), img.texels[15]);
        // The middle maps 6 box pixels onto 2 texels.
        assert!((p.x.map(4.5) - (1.0 + 3.5 / 3.0)).abs() < 1e-6);
        // Insets wider than the image are refused by name.
        assert!(matches!(
            fit_plan(&object(FitMode::NineSlice, 8.0, 8.0, inset(3.0, 3.0)), (4, 4), 0, 8192),
            Err(Refusal::ImageNotDrawable { detail, .. }) if detail.contains("exceed")
        ));
        // A box shorter than both insets scales the corners down together.
        let small = fit_plan(
            &object(FitMode::NineSlice, 1.0, 8.0, inset(1.0, 1.0)),
            (4, 4),
            0,
            8192,
        )
        .unwrap();
        assert!(
            (small.x.map(1.0) - 4.0).abs() < 1e-6,
            "the box's far edge is the image's"
        );
    }
}
