//! Preview generation.
//!
//! Requirement 20's central rule: the engine must never send a full-resolution
//! image of a huge stage. A 50,000 × 50,000 preview is 10 GB, so every source is
//! bounded and anything over the configured pixel budget is **refused** rather
//! than silently downscaled — a caller that asked for something impossible needs
//! to know it did.
//!
//! Preview quality is independent of Program quality: previews render at a reduced
//! scale, and the tiles they use are the same cached tiles Program uses, so a
//! preview costs almost nothing on a static scene.

use std::sync::Arc;

use base64::Engine as _;
use image::ImageEncoder as _;
use serde_json::Value;

use grapix_render_core::renderer::gpu::GpuContext;

use crate::engine::LoadedScene;
use crate::protocol::{ErrorCode, ProtocolError};
use crate::render::{render_tile, CompositeTarget};
use crate::stage::{Rect, StageDocument};
use crate::tile::TileSelectionRequest;

/// A preview request resolved against a stage.
pub struct ResolvedPreview {
    /// Logical rectangle to render.
    pub logical: Rect,
    pub render_scale: f64,
    pub width: u32,
    pub height: u32,
    /// How the source was described, for diagnostics.
    pub description: String,
}

/// Resolve a preview source and enforce the pixel budget.
///
/// The budget check happens here, before any GPU work, so an impossible request
/// costs a round trip rather than an allocation.
pub fn resolve_source(
    stage: &StageDocument,
    source: &Value,
    max_pixels: u64,
) -> Result<ResolvedPreview, ProtocolError> {
    let kind = source
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("scaled-stage");

    let (logical, requested_scale, description) = match kind {
        "scaled-stage" => {
            let max_width = source
                .get("maxWidth")
                .and_then(Value::as_u64)
                .unwrap_or(1920) as u32;
            let max_height = source
                .get("maxHeight")
                .and_then(Value::as_u64)
                .unwrap_or(1080) as u32;
            let bounds = stage.bounds();
            let scale = StageDocument::fit_render_scale(&bounds, max_width, max_height);
            (
                bounds,
                scale,
                format!("scaled stage to {max_width}x{max_height}"),
            )
        }
        "viewport" => {
            let viewport_id = source
                .get("viewportId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCode::InvalidPayload,
                        "viewport source needs viewportId",
                    )
                })?;
            let viewport = stage.viewport(viewport_id).ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!("no viewport {viewport_id} on stage {}", stage.stage_id),
                )
            })?;
            (
                stage.resolve_viewport(viewport),
                viewport.render_scale,
                format!("viewport {viewport_id}"),
            )
        }
        "region" => {
            let region_id = source
                .get("regionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidPayload, "region source needs regionId")
                })?;
            let region = stage.region(region_id).ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!("no region {region_id} on stage {}", stage.stage_id),
                )
            })?;
            (region.bounds, 1.0, format!("region {region_id}"))
        }
        "surface" => {
            let surface_id = source
                .get("surfaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidPayload, "surface source needs surfaceId")
                })?;
            let surface = stage.surface(surface_id).ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!("no surface {surface_id} on stage {}", stage.stage_id),
                )
            })?;
            (surface.bounds(), 1.0, format!("surface {surface_id}"))
        }
        "rect" => {
            let x = source.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = source.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            let width = source.get("width").and_then(Value::as_f64).unwrap_or(0.0);
            let height = source.get("height").and_then(Value::as_f64).unwrap_or(0.0);
            let scale = source
                .get("renderScale")
                .and_then(Value::as_f64)
                .unwrap_or(1.0);
            (
                Rect::new(x, y, width, height),
                scale,
                format!("rect {width}x{height} at {x},{y}"),
            )
        }
        other => {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                format!("unsupported preview source \"{other}\""),
            ))
        }
    };

    let logical = logical.intersect(&stage.bounds());
    if logical.is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            format!("{description} resolves to an empty area of the stage"),
        ));
    }

    let render_scale = if requested_scale.is_finite() && requested_scale > 0.0 {
        requested_scale
    } else {
        1.0
    };

    let width = ((logical.width * render_scale).ceil() as u32).max(1);
    let height = ((logical.height * render_scale).ceil() as u32).max(1);
    let pixels = u64::from(width) * u64::from(height);

    if pixels > max_pixels {
        // Refuse, with the arithmetic, rather than quietly returning something
        // smaller than was asked for.
        let suggested = (max_pixels as f64 / (logical.width * logical.height)).sqrt();
        return Err(ProtocolError::new(
            ErrorCode::PreviewTooLarge,
            format!(
                "{description} at render scale {render_scale} would be {width}x{height} ({pixels} pixels); \
                 this engine's preview budget is {max_pixels} pixels. Use a render scale at or below {suggested:.5}, \
                 or request a smaller region."
            ),
        ));
    }

    Ok(ResolvedPreview {
        logical,
        render_scale,
        width,
        height,
        description,
    })
}

pub struct PreviewOutcome {
    pub width: u32,
    pub height: u32,
    pub base64: String,
    pub render_micros: u64,
}

/// What representation of a channel a preview shows.
///
/// Broadcast does not carry transparency as an alpha channel — SDI has none, so a graphics
/// engine emits **fill** (the colour) and **key** (a greyscale matte) as two separate
/// signals, and the downstream keyer recombines them. Operators verify a graphic by looking
/// at the key as a greyscale picture: white is opaque, black is transparent, and the greys
/// in between are the feathered shadows and anti-aliased text edges that a badly clipped
/// key destroys.
///
/// So this is a *render mode*, not a codec concern. A key view is a greyscale image, which
/// JPEG carries perfectly well; reaching for an alpha-capable codec would deliver a
/// design-tool checkerboard that no operator uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PreviewView {
    /// Full-colour composite: what the graphic looks like.
    #[default]
    Fill,
    /// Alpha as greyscale luminance: what the downstream keyer cuts.
    Key,
}

impl PreviewView {
    /// Absent means fill. An unknown value is refused rather than defaulted, because
    /// silently showing fill to a client that asked for key would misreport what is keyed.
    pub fn parse(value: Option<&str>) -> Result<Self, ProtocolError> {
        match value {
            None | Some("fill") => Ok(Self::Fill),
            Some("key") => Ok(Self::Key),
            Some(other) => Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                format!("preview view must be \"fill\" or \"key\"; got \"{other}\""),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fill => "fill",
            Self::Key => "key",
        }
    }
}

/// Render a preview.
///
/// Two paths, and choosing between them matters a great deal for latency:
///
/// - **Single pass**, when the scaled output fits in one GPU texture. Tiling exists
///   to work around the texture limit; a 960 x 192 operator preview of a 50,000-wide
///   stage is nowhere near it, so splitting that into 125 separate tile passes would
///   mean 125 pipeline builds and readbacks to produce a thumbnail. One pass over
///   the whole logical region, rendered small, is both faster and simpler.
///
/// - **Tiled**, when the scaled output genuinely exceeds the texture limit. Then the
///   same tiles Program uses are rendered and composited, so a static scene costs
///   nothing beyond the composite.
pub fn render_preview(
    gpu: &Arc<GpuContext>,
    scene: &mut LoadedScene,
    resolved: &ResolvedPreview,
    frame: u64,
    quality: u8,
    // "jpeg" for a human looking at it, "png" for anything measured.
    encoding: &str,
    // Fill or key. A key view is the alpha as greyscale — how broadcast monitors a matte.
    view: PreviewView,
    show_tile_debug: bool,
    // `force_tiled` renders by the tile-composite route even when the region would fit
    // one texture. Diagnostic, and distinct from `show_tile_debug`: that one *draws* the
    // grid, which makes the image unusable for comparison. This produces the same picture
    // by the other route, which is what proves the composite is seam-free.
    force_tiled: bool,
    max_texture_dimension: u32,
    // `cached` is reused across calls. Absent only where no cache is available; then
    // every call pays for pipeline compilation, which is ~500ms.
    cached: Option<&mut crate::scene_renderer::SceneRenderer>,
) -> Result<PreviewOutcome, ProtocolError> {
    // The tile grid is only needed when the output cannot be one texture, or when
    // the caller explicitly wants to see the grid.
    let fits_one_texture =
        resolved.width <= max_texture_dimension && resolved.height <= max_texture_dimension;

    if fits_one_texture && !show_tile_debug && !force_tiled {
        return render_single_pass(gpu, scene, resolved, quality, encoding, view, frame, cached);
    }

    render_tiled(
        gpu,
        scene,
        resolved,
        frame,
        quality,
        encoding,
        view,
        show_tile_debug,
    )
}

/// One rebased pass over the whole requested region.
///
/// Uses the same `f64` rebase as a tile — the region origin is subtracted before
/// anything narrows to `f32` — so a preview of the far edge of a 50,000-wide stage
/// is as accurate as a preview of the near edge.
fn render_single_pass(
    gpu: &Arc<GpuContext>,
    scene: &mut LoadedScene,
    resolved: &ResolvedPreview,
    quality: u8,
    encoding: &str,
    view: PreviewView,
    frame: u64,
    cached: Option<&mut crate::scene_renderer::SceneRenderer>,
) -> Result<PreviewOutcome, ProtocolError> {
    let started = std::time::Instant::now();

    let origin = crate::stage::Point::new(resolved.logical.x, resolved.logical.y);
    let document = scene.source_document().clone();
    let revision = scene.revision;
    let scene_id = scene.scene_id.clone();

    // With a cached renderer the pipelines, target and prepared scene survive between
    // frames. Without one this falls back to building everything per call, which costs
    // roughly half a second and is why preview streaming was unusable before.
    let frame_image = match cached {
        Some(renderer) => {
            renderer.resize(gpu, resolved.width, resolved.height);
            renderer.render(
                gpu,
                &scene_id,
                revision,
                (
                    resolved.logical.x,
                    resolved.logical.y,
                    resolved.logical.width,
                    resolved.logical.height,
                ),
                frame,
                || {
                    // Preview must animate for the same reason Program does: an operator
                    // checking a graphic before air is checking the motion, not a still.
                    let animation = crate::animation::SceneAnimation::from_document(&document);
                    let rebased = crate::render::rebase_scene_json(
                        &document,
                        origin,
                        resolved.logical.width,
                        resolved.logical.height,
                    );
                    let prepared = grapix_render_core::scene::prepare_scene(&rebased)
                        .map_err(|error| format!("preview scene preparation failed: {error}"))?;
                    Ok((prepared, animation))
                },
            )
        }
        None => {
            let rebased = crate::render::rebase_scene_json(
                &document,
                origin,
                resolved.logical.width,
                resolved.logical.height,
            );
            grapix_render_core::scene::prepare_scene(&rebased)
                .map_err(|error| format!("preview scene preparation failed: {error}"))
                .and_then(|prepared| {
                    grapix_render_core::renderer::render_single_frame(
                        gpu,
                        &prepared,
                        resolved.width,
                        resolved.height,
                    )
                    .map_err(|error| format!("preview render failed: {error}"))
                })
        }
    }
    .map_err(|error| ProtocolError::new(ErrorCode::InternalError, error))?;

    let target = CompositeTarget {
        width: frame_image.width,
        height: frame_image.height,
        pixels: frame_image.data.as_slice().to_vec(),
        logical_bounds: resolved.logical,
        render_scale: resolved.render_scale,
    };

    let base64 = encode_preview(&target, quality, encoding, view)?;

    Ok(PreviewOutcome {
        width: target.width,
        height: target.height,
        base64,
        render_micros: started.elapsed().as_micros() as u64,
    })
}

/// Tiled preview, for an output too large to be one texture.
fn render_tiled(
    gpu: &Arc<GpuContext>,
    scene: &mut LoadedScene,
    resolved: &ResolvedPreview,
    frame: u64,
    quality: u8,
    encoding: &str,
    view: PreviewView,
    show_tile_debug: bool,
) -> Result<PreviewOutcome, ProtocolError> {
    let started = std::time::Instant::now();

    let selection = scene.tiles.select_tiles(&TileSelectionRequest {
        frame,
        previews: vec![resolved.logical],
        ..Default::default()
    });

    // Render whatever is dirty or has never been drawn.
    let mut rendered = Vec::new();
    for tile_id in &selection.to_render {
        let descriptor = match scene.tiles.get(tile_id) {
            Some(descriptor) => descriptor.clone(),
            None => continue,
        };

        scene.tiles.begin_render(std::slice::from_ref(tile_id));

        match render_tile(gpu, &mut scene.builder, &descriptor, resolved.render_scale) {
            Ok(tile) => {
                scene.tiles.complete_render(tile_id, frame);
                rendered.push(tile);
            }
            Err(error) => {
                // A failed tile stays dirty so the next frame retries, rather than
                // a stale tile being composited.
                scene.tiles.fail_render(tile_id, error.to_string());
                tracing::warn!(%tile_id, %error, "tile render failed");
            }
        }
    }

    // Re-render any already-clean tile the preview needs, because tile pixels are
    // not retained on the CPU between requests.
    for tile_id in &selection.required {
        if rendered.iter().any(|tile| &tile.tile_id == tile_id) {
            continue;
        }
        let descriptor = match scene.tiles.get(tile_id) {
            Some(descriptor) => descriptor.clone(),
            None => continue,
        };
        match render_tile(gpu, &mut scene.builder, &descriptor, resolved.render_scale) {
            Ok(tile) => rendered.push(tile),
            Err(error) => {
                tracing::warn!(%tile_id, %error, "tile re-render for preview failed");
            }
        }
    }

    if rendered.is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::InternalError,
            format!(
                "no tiles could be rendered for {} ({} required, {} needed work)",
                resolved.description,
                selection.required.len(),
                selection.to_render.len()
            ),
        ));
    }

    let mut target = CompositeTarget::new(resolved.logical, resolved.render_scale)
        .map_err(|error| ProtocolError::new(ErrorCode::PreviewTooLarge, error.to_string()))?;

    for tile in &rendered {
        target.blit(tile);
    }

    if show_tile_debug {
        draw_tile_boundaries(&mut target, &rendered);
    }

    let base64 = encode_preview(&target, quality, encoding, view)?;

    Ok(PreviewOutcome {
        width: target.width,
        height: target.height,
        base64,
        render_micros: started.elapsed().as_micros() as u64,
    })
}

/// Outline each tile's composited area.
///
/// A diagnostic only, requested explicitly, and drawn into the preview image
/// rather than into any output. Program never sees this.
fn draw_tile_boundaries(target: &mut CompositeTarget, tiles: &[crate::render::RenderedTile]) {
    // Cyan in BGRA, so it reads clearly over most graphics.
    const B: u8 = 255;
    const G: u8 = 255;
    const R: u8 = 0;
    const A: u8 = 255;

    for tile in tiles {
        let overlap = tile.composite_bounds.intersect(&target.logical_bounds);
        if overlap.is_empty() {
            continue;
        }

        let x0 = ((overlap.x - target.logical_bounds.x) * target.render_scale).round() as i64;
        let y0 = ((overlap.y - target.logical_bounds.y) * target.render_scale).round() as i64;
        let x1 = x0 + (overlap.width * target.render_scale).round() as i64 - 1;
        let y1 = y0 + (overlap.height * target.render_scale).round() as i64 - 1;

        let width = i64::from(target.width);
        let height = i64::from(target.height);

        let mut put = |x: i64, y: i64| {
            if x < 0 || y < 0 || x >= width || y >= height {
                return;
            }
            let index = ((y * width + x) * 4) as usize;
            if index + 3 < target.pixels.len() {
                target.pixels[index] = B;
                target.pixels[index + 1] = G;
                target.pixels[index + 2] = R;
                target.pixels[index + 3] = A;
            }
        };

        for x in x0..=x1 {
            put(x, y0);
            put(x, y1);
        }
        for y in y0..=y1 {
            put(x0, y);
            put(x1, y);
        }
    }
}

/// Encode the composite as a base64 JPEG.
///
/// JPEG because a preview is a lossy operator convenience, and a 1920×1080 PNG of
/// a busy graphic is several megabytes per frame over a venue network.
/// Encode losslessly as PNG, keeping alpha.
///
/// JPEG is right for a preview a human looks at and wrong for anything measured: its own
/// error is larger than the rendering differences a parity harness is trying to detect, and
/// it discards alpha entirely. This path exists so two renders can be compared exactly.
///
/// The alpha is *unpremultiplied* on the way out, because PNG is defined as straight alpha.
/// Writing premultiplied bytes into a PNG would make every semi-transparent pixel darker
/// than it is, in a file format that says otherwise.
fn encode_png(target: &CompositeTarget, view: PreviewView) -> Result<String, ProtocolError> {
    let mut rgba = Vec::with_capacity((target.width as usize) * (target.height as usize) * 4);

    for chunk in target.pixels.chunks_exact(4) {
        let (b, g, r, a) = (chunk[0], chunk[1], chunk[2], chunk[3]);
        // A key view is the matte itself, so it is written as an opaque greyscale image
        // rather than as transparency. Keeping it opaque is the point: this is what the
        // downstream keyer receives on its own wire.
        if view == PreviewView::Key {
            rgba.extend_from_slice(&[a, a, a, 255]);
            continue;
        }
        if a == 0 || a == 255 {
            rgba.extend_from_slice(&[r, g, b, a]);
            continue;
        }
        let scale = 255.0 / f32::from(a);
        rgba.push((f32::from(r) * scale).min(255.0) as u8);
        rgba.push((f32::from(g) * scale).min(255.0) as u8);
        rgba.push((f32::from(b) * scale).min(255.0) as u8);
        rgba.push(a);
    }

    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(
            &rgba,
            target.width,
            target.height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| {
            ProtocolError::new(
                ErrorCode::InternalError,
                format!("preview png encoding failed: {error}"),
            )
        })?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&encoded))
}

fn encode_jpeg(
    target: &CompositeTarget,
    quality: u8,
    view: PreviewView,
) -> Result<String, ProtocolError> {
    // The composite is BGRA premultiplied; JPEG has no alpha, so flatten onto a
    // mid-grey checkerboard-free background and swap to RGB.
    let mut rgb = Vec::with_capacity((target.width as usize) * (target.height as usize) * 3);

    for chunk in target.pixels.chunks_exact(4) {
        let (b, g, r, a) = (chunk[0], chunk[1], chunk[2], chunk[3]);

        // The key is the alpha itself, written to all three channels as luminance. Correct
        // for shaped and straight fill alike: premultiplication scales the colour, never
        // the alpha.
        if view == PreviewView::Key {
            rgb.extend_from_slice(&[a, a, a]);
            continue;
        }

        if a == 255 {
            rgb.extend_from_slice(&[r, g, b]);
            continue;
        }

        // Premultiplied over a neutral grey, so transparent regions read as
        // background rather than as black.
        let alpha = f32::from(a) / 255.0;
        let background = 32.0 * (1.0 - alpha);
        rgb.push((f32::from(r) + background).min(255.0) as u8);
        rgb.push((f32::from(g) + background).min(255.0) as u8);
        rgb.push((f32::from(b) + background).min(255.0) as u8);
    }

    let mut encoded = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality.clamp(1, 100));

    encoder
        .encode(
            &rgb,
            target.width,
            target.height,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|error| {
            ProtocolError::new(
                ErrorCode::InternalError,
                format!("preview encoding failed: {error}"),
            )
        })?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&encoded))
}

/// Encode a composite for the wire.
///
/// Unknown encodings are refused rather than silently given JPEG: a client that asked for
/// PNG and received JPEG bytes would decode them as a corrupt PNG, and one measuring
/// parity would measure the codec instead of the renderer.
fn encode_preview(
    target: &CompositeTarget,
    quality: u8,
    encoding: &str,
    view: PreviewView,
) -> Result<String, ProtocolError> {
    match encoding {
        "jpeg" => encode_jpeg(target, quality, view),
        "png" => encode_png(target, view),
        other => Err(ProtocolError::new(
            ErrorCode::CapabilityUnsupported,
            format!(
                "this engine encodes previews as jpeg or png; \"{other}\" is declared in the \
                 protocol but not implemented"
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two pixels: one fully opaque red, one half-transparent, one fully transparent.
    /// BGRA, premultiplied — the composite's own layout.
    fn target() -> CompositeTarget {
        CompositeTarget {
            width: 3,
            height: 1,
            pixels: vec![
                0, 0, 200, 255, // opaque red
                0, 0, 100, 128, // half-transparent red, premultiplied
                0, 0, 0, 0, // fully transparent
            ],
            logical_bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 3.0,
                height: 1.0,
            },
            render_scale: 1.0,
        }
    }

    fn decode(base64_png: &str) -> image::RgbaImage {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_png)
            .expect("valid base64");
        image::load_from_memory(&bytes)
            .expect("valid png")
            .to_rgba8()
    }

    #[test]
    fn a_key_view_is_the_alpha_as_greyscale() {
        // What a downstream keyer cuts: white opaque, black transparent, grey in between.
        // Broadcast carries this as its own signal because SDI has no alpha channel, and an
        // operator verifies a graphic by looking at exactly this picture.
        let image = decode(&encode_png(&target(), PreviewView::Key).unwrap());

        assert_eq!(
            image.get_pixel(0, 0).0,
            [255, 255, 255, 255],
            "opaque reads as white"
        );
        assert_eq!(
            image.get_pixel(1, 0).0,
            [128, 128, 128, 255],
            "half alpha reads as mid grey"
        );
        assert_eq!(
            image.get_pixel(2, 0).0,
            [0, 0, 0, 255],
            "transparent reads as black"
        );
    }

    #[test]
    fn a_key_view_is_opaque_everywhere() {
        // The matte is a picture, not transparency. A key that was itself transparent would
        // be invisible on the very monitor meant to show it.
        let image = decode(&encode_png(&target(), PreviewView::Key).unwrap());
        for pixel in image.pixels() {
            assert_eq!(pixel.0[3], 255);
        }
    }

    #[test]
    fn a_fill_view_still_carries_straight_alpha() {
        // Regression guard: adding the key view must not disturb the fill path, which
        // unpremultiplies because PNG is defined as straight alpha.
        let image = decode(&encode_png(&target(), PreviewView::Fill).unwrap());

        assert_eq!(image.get_pixel(0, 0).0, [200, 0, 0, 255]);
        let half = image.get_pixel(1, 0).0;
        assert_eq!(half[3], 128);
        // 100 premultiplied at alpha 128 unpremultiplies to ~199, not 100.
        assert!(
            half[0] >= 198 && half[0] <= 201,
            "unpremultiplied red was {}",
            half[0]
        );
        assert_eq!(image.get_pixel(2, 0).0[3], 0);
    }

    #[test]
    fn a_key_jpeg_carries_the_matte_as_luminance() {
        // The monitor path is JPEG, so the key has to survive it. Lossy, so this asserts the
        // bands are distinguishable rather than exact.
        let base64 = encode_jpeg(&target(), 90, PreviewView::Key).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64)
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_luma8();

        let opaque = image.get_pixel(0, 0).0[0];
        let transparent = image.get_pixel(2, 0).0[0];
        assert!(opaque > 200, "opaque should be near white, was {opaque}");
        assert!(
            transparent < 55,
            "transparent should be near black, was {transparent}"
        );
    }

    #[test]
    fn an_unknown_view_is_refused_rather_than_defaulted() {
        // Silently showing fill to a client that asked for key would misreport what is
        // actually being keyed on air.
        assert_eq!(PreviewView::parse(None).unwrap(), PreviewView::Fill);
        assert_eq!(PreviewView::parse(Some("fill")).unwrap(), PreviewView::Fill);
        assert_eq!(PreviewView::parse(Some("key")).unwrap(), PreviewView::Key);

        let error = PreviewView::parse(Some("matte")).expect_err("must refuse");
        assert_eq!(error.code, ErrorCode::InvalidPayload);
        assert!(
            error.message.contains("matte"),
            "message should name the value: {}",
            error.message
        );
    }
}
