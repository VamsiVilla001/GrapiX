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
use crate::mesh::AssetBytes;
use crate::text::{prepare_text_object, PreparedTexts};

/// One effect's mask weights (3.28): the coverage of the masks the effect
/// references over the layer's pixels, drawn as the layer's own masks are.
#[derive(Debug, Clone)]
pub enum EffectWeights {
    /// A working-space float texture whose alpha is the weight.
    Gpu(wgpu::Texture),
    /// One weight per pixel, row by row.
    Cpu(Vec<f32>),
}

/// What one effect's mask weights are drawn from: the masks it references
/// (a mask in mode `none` counts, as a reference path), and a white cover of
/// the layer drawn through them.
type WeightInput = Option<(
    Vec<crate::rasterise::mask::PreparedMask>,
    crate::rasterise::PreparedPath,
)>;

fn weight_inputs(
    object: &SceneObject,
    transform: &dyn Fn(f64, f64) -> Result<lyon::math::Point, Refusal>,
    origin: [f64; 2],
    width: u32,
    height: u32,
) -> Result<Vec<WeightInput>, Refusal> {
    use crate::rasterise::{BezPath, OutlineFill, PathPaint, PreparedPath};
    use vello_cpu::kurbo::{Rect, Shape};
    let base = object.base();
    let mut out = Vec::new();
    for instance in base.effects() {
        let ids = instance.mask_ids.as_deref().unwrap_or(&[]);
        if ids.is_empty() {
            out.push(None);
            continue;
        }
        let mut subset: Vec<_> = base
            .masks()
            .iter()
            .filter(|m| m.id.as_ref().is_some_and(|id| ids.contains(id)))
            .cloned()
            .collect();
        for mask in &mut subset {
            if mask.mode == gx_contracts::scene::MaskMode::None {
                mask.mode = gx_contracts::scene::MaskMode::Add;
            }
        }
        let prepared = crate::rasterise::prepare_masks(&base.id, &subset, transform)?;
        let cover: BezPath = Rect::new(
            origin[0],
            origin[1],
            origin[0] + f64::from(width),
            origin[1] + f64::from(height),
        )
        .to_path(0.01);
        let white = PreparedPath::new(
            "effect-mask".into(),
            PathPaint::Solid(crate::colour_pipeline::WorkingRgba::opaque(1.0, 1.0, 1.0)),
            cover,
            OutlineFill::NonZero,
        );
        out.push(Some((prepared, white)));
    }
    Ok(out)
}

/// The weights of every effect of `object` that names masks, by the effect's
/// place; `None` for an effect on the whole layer. The referenced masks are
/// folded on their own, by drawing a white cover of the layer through them.
fn effect_weights(
    object: &SceneObject,
    transform: &dyn Fn(f64, f64) -> Result<lyon::math::Point, Refusal>,
    origin: [f64; 2],
    width: u32,
    height: u32,
    gpu: Option<&crate::gpu::Gpu>,
) -> Result<Vec<Option<EffectWeights>>, Refusal> {
    use crate::rasterise::RasterSurface;
    let base = object.base();
    let mut out = Vec::new();
    for input in weight_inputs(object, transform, origin, width, height)? {
        let Some((prepared, white)) = input else {
            out.push(None);
            continue;
        };
        if let Some(gpu) = gpu {
            if let Some(texture) = gpu.draw_paths(&base.id, &[&white], origin, width, height, &prepared) {
                out.push(Some(EffectWeights::Gpu(texture?)));
                continue;
            }
        }
        let mut surface = RasterSurface::window(width, height, origin);
        VelloCpuRasteriser.rasterise_into(&[&white], &mut surface);
        crate::rasterise::mask::apply_masks(&prepared, &mut surface);
        out.push(Some(EffectWeights::Cpu(surface.pixels().iter().map(|p| p.a).collect())));
    }
    Ok(out)
}

/// How an animated path's source is drawn again each frame (11.112): into the
/// texture it was drawn into at prepare, at the size and place that hold every
/// shape the path takes.
#[derive(Debug, Clone)]
pub struct SourceRedraw {
    pub target: wgpu::Texture,
    /// The texture-local scene point of texel (0, 0)'s corner, as it was drawn.
    pub origin: [f64; 2],
    /// The sampling phase the source was prepared with.
    pub phase: [f64; 2],
    pub width: u32,
    pub height: u32,
    /// The mask weights of each effect, drawn again with the masks they follow.
    pub weights: Vec<Option<wgpu::Texture>>,
}

/// The layer-space phase an object's source is prepared at.
fn source_phase(resolved: &ResolvedObject, anchor: Vec2) -> [f64; 2] {
    let phase = [resolved.x - anchor.x, resolved.y - anchor.y];
    // Preserve the reference's exact coverage rounding at initial integer
    // translations. Only the CPU source rasteriser sees this sampling phase;
    // GPU coordinates remain texture/tile-local.
    if resolved.scale_x == 1.0
        && resolved.scale_y == 1.0
        && resolved.rotation_z.rem_euclid(360.0) == 0.0
        && phase.iter().all(|v| v.fract() == 0.0 && v.abs() < 1e6)
    {
        phase
    } else {
        [0.0, 0.0]
    }
}

/// The object as it is drawn alone: untransformed at full opacity at `phase`.
fn standing_alone(object: &gx_contracts::scene::SceneObject, phase: [f64; 2]) -> gx_contracts::scene::SceneObject {
    let mut single = object.clone();
    let base = single.base_mut();
    base.x = phase[0];
    base.y = phase[1];
    base.rotation = 0.0;
    base.scale_x = 1.0;
    base.scale_y = 1.0;
    base.anchor = None;
    base.opacity = 1.0;
    base.visible = true;
    single
}

/// The object alone in a copy of the document, drawn untransformed at full
/// opacity at `phase`. Copies the whole document: used where a source is
/// prepared, once. Every frame uses [`with_local_document`].
pub(crate) fn local_document(doc: &SceneDocument, index: usize, phase: [f64; 2]) -> SceneDocument {
    let mut local = doc.clone();
    local.objects = vec![standing_alone(&doc.objects[index], phase)];
    local
}

/// Puts the document's objects back when it goes out of scope, even if the work in between panics.
struct ObjectsBack<'a> {
    doc: &'a mut SceneDocument,
    all: Vec<gx_contracts::scene::SceneObject>,
}

impl Drop for ObjectsBack<'_> {
    fn drop(&mut self) {
        std::mem::swap(&mut self.doc.objects, &mut self.all);
    }
}

/// Run `f` on `doc` made to hold only object `index`, drawn alone as [`local_document`] has it, then put the document back as it was. The
/// work of a frame (11.112) copies one object, not the scene's whole document with its timeline and every path channel, once for every
/// animated layer.
pub(crate) fn with_local_document<R>(doc: &mut SceneDocument, index: usize, phase: [f64; 2], f: impl FnOnce(&SceneDocument) -> R) -> R {
    let single = standing_alone(&doc.objects[index], phase);
    let all = std::mem::replace(&mut doc.objects, vec![single]);
    let guard = ObjectsBack { doc, all };
    f(guard.doc)
}

/// Whether the document animates a path of this object.
pub fn animates_a_path(doc: &SceneDocument, object_id: &str) -> bool {
    doc.timeline
        .path_channels
        .iter()
        .any(|c| c.object_id == object_id && !c.keys.is_empty())
}

fn scalar_source_property(property: &str) -> bool {
    gx_contracts::animation::dash::index(property).is_some()
        || gx_contracts::text_animator::ANIMATOR_PROPERTIES.contains(&property)
        || matches!(
        property,
        "size" | "lineHeight" | "letterSpacing" | "baselineShift"
            | "radius" | "strokeWidth" | "strokeStyle.dashOffset" | "trimStart" | "trimEnd" | "trimOffset"
    )
}

fn animates_colour(doc: &SceneDocument, id: &str) -> bool {
    doc.timeline.colour_channels.iter().flatten().any(|channel| {
        channel.object_id == id && !channel.keys.is_empty()
    })
}

pub(crate) fn animates_source(doc: &SceneDocument, id: &str) -> bool {
    animates_a_path(doc, id) || animates_colour(doc, id) || doc.timeline.channels.iter().any(|channel| {
        channel.object_id == id && !channel.keys.is_empty() && scalar_source_property(&channel.property)
    })
}

fn scalar_extent(
    local: &SceneDocument,
    id: &str,
    texts: &PreparedTexts,
    font_bytes: &AssetBytes,
    point: &mut dyn FnMut(f64, f64),
) -> Result<bool, Refusal> {
    use gx_contracts::animation::{evaluate_channel, set_base_property};

    let channels: Vec<_> = local.timeline.channels.iter().filter(|channel| {
        channel.object_id == id && !channel.keys.is_empty() && scalar_source_property(&channel.property)
    }).collect();
    let colour = animates_colour(local, id);
    if channels.is_empty() && !colour {
        return Ok(false);
    }
    let mut sampled = local.clone();
    sampled.timeline.path_channels.retain(|channel| channel.object_id == id);
    if let Some(channels) = &mut sampled.timeline.colour_channels {
        channels.retain(|channel| channel.object_id == id);
    }
    // Paint changes can introduce a fill or stroke absent from the base object,
    // but later RGBA values cannot change the paint geometry.
    if colour {
        gx_contracts::animation::colour::apply(&mut sampled, 0)?;
    }
    let key_frames = channels.iter().flat_map(|channel| channel.keys.iter().map(|key| key.frame))
        .chain(sampled.timeline.path_channels.iter().flat_map(|channel| channel.keys.iter().map(|key| key.frame)));
    let (first, last) = key_frames.fold((u64::MAX, 0), |(first, last), frame| {
        (first.min(frame), last.max(frame))
    });
    let first = first.min(last);
    let mut previous = local.objects[0].clone();
    let mut shaped = None;
    for frame in first..=last {
        for channel in &channels {
            if let Some(value) = evaluate_channel(channel, frame)? {
                set_base_property(&mut sampled, id, &channel.property, value)?;
            }
        }
        gx_contracts::path_anim::apply_path_channels(&mut sampled, frame)?;
        if sampled.objects[0] == previous {
            continue; // The base or last evaluated bounds already cover this source.
        }
        if let (SceneObject::Text(text), SceneObject::Text(old)) = (&sampled.objects[0], &previous) {
            if crate::prepared::text_layout_changed(text, old) {
                shaped = Some(PreparedTexts { objects: vec![prepare_text_object(&sampled, text, font_bytes)?] });
            }
        }
        let effective = resolve_hierarchy(&sampled.objects).effective;
        let paths = PreparedPaths::prepare(&sampled, &effective, Some(shaped.as_ref().unwrap_or(texts)))?;
        for path in paths.paths() {
            let bounds = path.bounds();
            point(f64::from(bounds.min_x), f64::from(bounds.min_y));
            point(f64::from(bounds.max_x), f64::from(bounds.max_y));
        }
        previous.clone_from(&sampled.objects[0]);
    }
    Ok(true)
}

/// Grow the bounds by each path key and its control polygon (11.112).
fn animated_extent(
    local: &SceneDocument,
    doc: &SceneDocument,
    id: &str,
    texts: &PreparedTexts,
    point: &mut dyn FnMut(f64, f64),
) -> Result<(), Refusal> {
    use gx_contracts::path_anim::put_target_path;
    use gx_contracts::path_geometry::{control_bounds, effective, path_bounds, PathTarget};
    for channel in doc
        .timeline
        .path_channels
        .iter()
        .filter(|c| c.object_id == id && matches!(c.target, PathTarget::Shape { .. }))
    {
        for key in &channel.keys {
            let drawn = effective(&key.path);
            let mut keyed = local.clone();
            put_target_path(&mut keyed, id, channel.target, drawn.clone());
            let keyed_effective = resolve_hierarchy(&keyed.objects).effective;
            let prepared = PreparedPaths::prepare(&keyed, &keyed_effective, Some(texts))?;
            let mut rendered: Option<[f64; 4]> = None;
            for path in prepared.paths() {
                let b = path.bounds();
                let r = rendered.get_or_insert([
                    f64::from(b.min_x),
                    f64::from(b.min_y),
                    f64::from(b.max_x),
                    f64::from(b.max_y),
                ]);
                r[0] = r[0].min(f64::from(b.min_x));
                r[1] = r[1].min(f64::from(b.min_y));
                r[2] = r[2].max(f64::from(b.max_x));
                r[3] = r[3].max(f64::from(b.max_y));
            }
            let Some(r) = rendered else { continue };
            let grow = match (path_bounds(&drawn), control_bounds(&drawn)) {
                (Some(c), Some(h)) => [
                    (c.0 - h.0).max(0.0),
                    (c.1 - h.1).max(0.0),
                    (h.2 - c.2).max(0.0),
                    (h.3 - c.3).max(0.0),
                ],
                _ => [0.0; 4],
            };
            point(r[0] - grow[0], r[1] - grow[1]);
            point(r[2] + grow[2], r[3] + grow[3]);
        }
    }
    Ok(())
}

/// Draw an animated object's source again for the frame `doc` is evaluated at
/// (11.112): the paths and masks as they are now, into the texture and the
/// size and place the source was prepared with.
pub(crate) fn redraw_layer_source(
    doc: &mut SceneDocument,
    texts: &PreparedTexts,
    index: usize,
    handle: &crate::gpu::DrawHandle,
    plan: &SourceRedraw,
) -> Result<(), Refusal> {
    with_local_document(doc, index, plan.phase, |local| redraw_local(local, texts, handle, plan))
}

/// [`redraw_layer_source`] on the document that holds the one object.
fn redraw_local(
    local: &SceneDocument,
    texts: &PreparedTexts,
    handle: &crate::gpu::DrawHandle,
    plan: &SourceRedraw,
) -> Result<(), Refusal> {
    let local_effective = resolve_hierarchy(&local.objects).effective;
    let paths = PreparedPaths::prepare(local, &local_effective, Some(texts))?;
    let object_paths: Vec<_> = paths.paths().iter().collect();
    let local_base = local.objects[0].base();
    let id = local_base.id.clone();
    let masks = crate::rasterise::prepare_masks(&id, local_base.masks(), &|x, y| {
        crate::rasterise::transform(&local_base.anchor, &local_effective[0], x, y)
    })?;
    handle.redraw_paths(&plan.target, &id, &object_paths, plan.origin, plan.width, plan.height, &masks)?;
    let transform = |x: f64, y: f64| {
        crate::rasterise::transform(&local_base.anchor, &local_effective[0], x, y)
    };
    let inputs = weight_inputs(&local.objects[0], &transform, plan.origin, plan.width, plan.height)?;
    for (input, target) in inputs.into_iter().zip(&plan.weights) {
        if let (Some((prepared, white)), Some(target)) = (input, target) {
            handle.redraw_paths(target, &id, &[&white], plan.origin, plan.width, plan.height, &prepared)?;
        }
    }
    Ok(())
}

/// An object's layer-space pixels.
#[derive(Debug, Clone)]
pub struct LayerSource {
    /// 3.28: each effect's mask weights, by the effect's place.
    pub effect_weights: Vec<Option<EffectWeights>>,
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
    /// 11.112: how this source is drawn again each frame; `Some` only for an
    /// object that animates a path and was drawn on the GPU.
    pub redraw: Option<SourceRedraw>,
    /// The sampling phase the source was prepared at (see `source_phase`).
    pub phase: [f64; 2],
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
    animated_font_bytes: Option<&AssetBytes>,
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
        // 3.19: the raster is in box coordinates, as the mask paths are.
        let masks =
            crate::rasterise::prepare_masks(&image.base.id, image.base.masks(), &|x, y| {
                Ok(lyon::math::point(x as f32, y as f32))
            })?;
        let box_point = |x: f64, y: f64| Ok(lyon::math::point(x as f32, y as f32));
        let weights = effect_weights(object, &box_point, plan.origin, plan.width, plan.height, gpu)?;
        if let Some(gpu) = gpu {
            if let Some(drawn) =
                gpu.draw_image(&image.base.id, &image.asset_id, decoded, &plan, &masks)
            {
                return Ok(LayerSource {
                    effect_weights: weights,
                    width: plan.width,
                    height: plan.height,
                    surface: None,
                    drawn: Some(drawn?),
                    origin: plan.origin,
                    redraw: None,
                    phase: [0.0, 0.0],
                });
            }
        }
        crate::render_work::cpu_source();
        let mut surface =
            RasterSurface::from_pixels(plan.width, plan.height, plan.origin, plan.raster(decoded));
        crate::rasterise::mask::apply_masks(&masks, &mut surface);
        return Ok(LayerSource {
            effect_weights: weights,
            width: plan.width,
            height: plan.height,
            surface: Some(surface),
            drawn: None,
            origin: plan.origin,
            redraw: None,
            phase: [0.0, 0.0],
        });
    }
    let id = object.base().id.clone();
    let path = format!("objects[{index}]");
    let resolved = &effective[index];
    let anchor = object.base().anchor.unwrap_or(Vec2 { x: 0.0, y: 0.0 });
    let phase = source_phase(resolved, anchor);
    let local = local_document(doc, index, phase);
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
    let scalar = match animated_font_bytes {
        Some(bytes) => scalar_extent(&local, &id, texts, bytes, &mut point)?,
        None => false,
    };
    let path_animated = animates_a_path(doc, &id);
    if path_animated {
        animated_extent(&local, doc, &id, texts, &mut point)?;
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
    // 3.19: the masks, placed as the object's paths are in this local scene.
    let local_base = local.objects[0].base();
    let masks = crate::rasterise::prepare_masks(&id, local_base.masks(), &|x, y| {
        crate::rasterise::transform(&local_base.anchor, &local_effective[0], x, y)
    })?;
    let layer_origin = [origin[0] - phase[0], origin[1] - phase[1]];
    let mask_point = |x: f64, y: f64| {
        crate::rasterise::transform(&local_base.anchor, &local_effective[0], x, y)
    };
    let weights = effect_weights(&local.objects[0], &mask_point, origin, width, height, gpu)?;
    // 3.17: vector objects draw on the GPU when there is one; 3.18: text too,
    // its glyph outlines being paths.
    if let Some(gpu) = gpu {
        if let Some(drawn) = gpu.draw_paths(&id, &object_paths, origin, width, height, &masks) {
            let drawn = drawn?;
            let redraw = (path_animated || scalar).then(|| SourceRedraw {
                target: drawn.clone(),
                origin,
                phase,
                width,
                height,
                weights: weights
                    .iter()
                    .map(|w| match w {
                        Some(EffectWeights::Gpu(texture)) => Some(texture.clone()),
                        _ => None,
                    })
                    .collect(),
            });
            return Ok(LayerSource {
                effect_weights: weights,
                width,
                height,
                surface: None,
                drawn: Some(drawn),
                origin: layer_origin,
                redraw,
                phase,
            });
        }
    }
    crate::render_work::cpu_source();
    let mut surface = RasterSurface::window(width, height, origin);
    VelloCpuRasteriser.rasterise_into(&object_paths, &mut surface);
    crate::rasterise::mask::apply_masks(&masks, &mut surface);
    Ok(LayerSource {
        effect_weights: weights,
        width,
        height,
        surface: Some(surface),
        drawn: None,
        origin: layer_origin,
        redraw: None,
        phase,
    })
}

/// The CPU reference's twin of [`redraw_layer_source`] (11.112): the source of
/// an object that animates a path, drawn for the frame `doc` is evaluated at,
/// in the size and place `previous` was prepared with.
pub fn redraw_layer_source_cpu(
    doc: &mut SceneDocument,
    texts: &PreparedTexts,
    index: usize,
    previous: &LayerSource,
) -> Result<LayerSource, Refusal> {
    let phase = previous.phase;
    with_local_document(doc, index, phase, |local| redraw_local_cpu(local, texts, previous))
}

/// [`redraw_layer_source_cpu`] on the document that holds the one object.
fn redraw_local_cpu(local: &SceneDocument, texts: &PreparedTexts, previous: &LayerSource) -> Result<LayerSource, Refusal> {
    let phase = previous.phase;
    let origin = [previous.origin[0] + phase[0], previous.origin[1] + phase[1]];
    let local_effective = resolve_hierarchy(&local.objects).effective;
    let paths = PreparedPaths::prepare(local, &local_effective, Some(texts))?;
    let object_paths: Vec<_> = paths.paths().iter().collect();
    let local_base = local.objects[0].base();
    let id = local_base.id.clone();
    let transform = |x: f64, y: f64| {
        crate::rasterise::transform(&local_base.anchor, &local_effective[0], x, y)
    };
    let masks = crate::rasterise::prepare_masks(&id, local_base.masks(), &transform)?;
    let weights = effect_weights(&local.objects[0], &transform, origin, previous.width, previous.height, None)?;
    crate::render_work::cpu_source();
    let mut surface = RasterSurface::window(previous.width, previous.height, origin);
    VelloCpuRasteriser.rasterise_into(&object_paths, &mut surface);
    crate::rasterise::mask::apply_masks(&masks, &mut surface);
    Ok(LayerSource {
        effect_weights: weights,
        surface: Some(surface),
        ..previous.clone()
    })
}
