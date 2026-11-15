//! One object's pixels in its own layer space, prepared once (3.16, 3.22).
//!
//! The GPU compositor uploads these as the layer's source texture; the CPU
//! reference runs an object's effect stack on the same pixels before warping
//! them onto the canvas, so both renderers start from identical layer-space
//! pixels. The object is drawn untransformed at full opacity, at its initial
//! sampling phase when that is an integer translation (so the CPU reference's
//! coverage rounding is preserved), and padded on every side by `pad`
//! transparent pixels for the effects that spread it.
//!
//! Moved here from `compositor/scene.rs` (3.16, Codex) so the GPU scene and
//! the CPU reference share it; behaviour with `pad == 0` is unchanged.

use gx_contracts::scene::{resolve_hierarchy, ResolvedObject, SceneDocument, SceneObject, Vec2};
use gx_contracts::Refusal;

use crate::rasterise::{PathRasteriser, PreparedPaths, RasterSurface, VelloCpuRasteriser};
use crate::text::PreparedTexts;

/// An object's layer-space pixels.
#[derive(Debug, Clone)]
pub struct LayerSource {
    pub width: u32,
    pub height: u32,
    /// The source drawn on the CPU; `None` when it was drawn on the GPU.
    pub surface: Option<RasterSurface>,
    /// 3.17: the source drawn on the GPU at prepare, a working-space float
    /// texture; `None` when it was drawn on the CPU.
    pub drawn: Option<wgpu::Texture>,
    /// The layer-space position of texel (0, 0)'s corner, the sampling phase
    /// removed: what a layer's affine maps from.
    pub origin: [f64; 2],
}

/// Draw object `index` of `doc` into its own padded layer space. `effective`
/// is the document's resolved state the phase is taken from; `limit` is the
/// largest texture dimension the source may have.
#[allow(clippy::too_many_arguments)]
pub fn prepare_layer_source(
    doc: &SceneDocument,
    effective: &[ResolvedObject],
    texts: &PreparedTexts,
    index: usize,
    pad: u32,
    limit: u32,
    gpu: Option<&crate::gpu::Gpu>,
    images: &crate::image::PreparedImages,
) -> Result<LayerSource, Refusal> {
    let object = &doc.objects[index];
    // 3.17: an image is its box raster, built from its fit plan in the
    // object's box coordinates, on the GPU when there is one.
    if let SceneObject::Image(image) = object {
        let decoded = images
            .get(&image.asset_id)
            .ok_or_else(|| Refusal::ImageNotDrawable {
                object: image.base.id.clone(),
                asset: image.asset_id.clone(),
                detail: "the image was not decoded at prepare".into(),
            })?;
        let plan = crate::image::fit_plan(image, (decoded.width, decoded.height), pad, limit)?;
        if let Some(gpu) = gpu {
            if let Some(drawn) = gpu.draw_image(&image.base.id, &image.asset_id, decoded, &plan) {
                return Ok(LayerSource {
                    width: plan.width,
                    height: plan.height,
                    surface: None,
                    drawn: Some(drawn?),
                    origin: plan.origin,
                });
            }
        }
        crate::render_work::cpu_source();
        return Ok(LayerSource {
            width: plan.width,
            height: plan.height,
            surface: Some(RasterSurface::from_pixels(
                plan.width,
                plan.height,
                plan.origin,
                plan.raster(decoded),
            )),
            drawn: None,
            origin: plan.origin,
        });
    }
    let id = object.base().id.clone();
    let path = format!("objects[{index}]");
    let mut local = doc.clone();
    local.objects = vec![object.clone()];
    let resolved = &effective[index];
    let anchor = object.base().anchor.unwrap_or(Vec2 { x: 0.0, y: 0.0 });
    let phase = [resolved.x - anchor.x, resolved.y - anchor.y];
    // Preserve the reference's exact coverage rounding at initial integer
    // translations. Only the CPU source rasteriser sees this sampling phase;
    // GPU coordinates remain texture/tile-local.
    let phase = if resolved.scale_x == 1.0
        && resolved.scale_y == 1.0
        && resolved.rotation_z.rem_euclid(360.0) == 0.0
        && phase.iter().all(|v| v.fract() == 0.0 && v.abs() < 1e6)
    {
        phase
    } else {
        [0.0, 0.0]
    };
    let base = local.objects[0].base_mut();
    base.x = phase[0];
    base.y = phase[1];
    base.rotation = 0.0;
    base.scale_x = 1.0;
    base.scale_y = 1.0;
    base.anchor = None;
    base.opacity = 1.0;
    base.visible = true;
    let local_effective = resolve_hierarchy(&local.objects).effective;
    let paths = PreparedPaths::prepare(&local, &local_effective, Some(texts))?;
    let mut bounds: Option<[f64; 4]> = None;
    let mut point = |x: f64, y: f64| {
        let b = bounds.get_or_insert([x, y, x, y]);
        b[0] = b[0].min(x);
        b[1] = b[1].min(y);
        b[2] = b[2].max(x);
        b[3] = b[3].max(y);
    };
    for path in paths.paths() {
        let b = path.bounds();
        point(f64::from(b.min_x), f64::from(b.min_y));
        point(f64::from(b.max_x), f64::from(b.max_y));
    }
    let b = bounds.unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let pad = f64::from(pad);
    let origin = [b[0].floor() - 1.0 - pad, b[1].floor() - 1.0 - pad];
    let width = b[2].ceil() - origin[0] + 1.0 + pad;
    let height = b[3].ceil() - origin[1] + 1.0 + pad;
    if !width.is_finite()
        || !height.is_finite()
        || width > f64::from(limit)
        || height > f64::from(limit)
    {
        return Err(crate::compositor::scene::mapping_refusal(
            &id,
            &path,
            &format!("CPU-prepared source {width}x{height} exceeds device limit {limit}; source tiling requires 3.17/3.18"),
        ));
    }
    let (width, height) = (width.max(1.0) as u32, height.max(1.0) as u32);
    let object_paths: Vec<_> = paths.paths().iter().collect();
    let layer_origin = [origin[0] - phase[0], origin[1] - phase[1]];
    // 3.17: vector objects draw on the GPU when there is one; 3.18: text too,
    // its glyph outlines being paths.
    if let Some(gpu) = gpu {
        if let Some(drawn) = gpu.draw_paths(&id, &object_paths, origin, width, height) {
            return Ok(LayerSource {
                width,
                height,
                surface: None,
                drawn: Some(drawn?),
                origin: layer_origin,
            });
        }
    }
    crate::render_work::cpu_source();
    let mut surface = RasterSurface::window(width, height, origin);
    VelloCpuRasteriser.rasterise_into(&object_paths, &mut surface);
    Ok(LayerSource {
        width,
        height,
        surface: Some(surface),
        drawn: None,
        origin: layer_origin,
    })
}
