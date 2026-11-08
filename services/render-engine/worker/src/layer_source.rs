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

use crate::rasterise::{LyonPathRasteriser, PathRasteriser, PreparedPaths, RasterSurface};
use crate::text::PreparedTexts;

/// An object's layer-space pixels.
#[derive(Debug, Clone)]
pub struct LayerSource {
    pub surface: RasterSurface,
    /// The layer-space position of texel (0, 0)'s corner, the sampling phase
    /// removed: what a layer's affine maps from.
    pub origin: [f64; 2],
}

/// Draw object `index` of `doc` into its own padded layer space. `effective`
/// is the document's resolved state the phase is taken from; `limit` is the
/// largest texture dimension the source may have.
pub fn prepare_layer_source(
    doc: &SceneDocument,
    effective: &[ResolvedObject],
    texts: &PreparedTexts,
    index: usize,
    pad: u32,
    limit: u32,
) -> Result<LayerSource, Refusal> {
    let object = &doc.objects[index];
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
    let paths = PreparedPaths::prepare(&local, &local_effective)?;
    let mut bounds: Option<[f64; 4]> = None;
    let mut point = |x: f64, y: f64| {
        let b = bounds.get_or_insert([x, y, x, y]);
        b[0] = b[0].min(x);
        b[1] = b[1].min(y);
        b[2] = b[2].max(x);
        b[3] = b[3].max(y);
    };
    for path in paths.paths() {
        for v in path.vertices() {
            point(f64::from(v.x), f64::from(v.y));
        }
    }
    if let Some(text) = texts.objects.iter().find(|t| t.object_id == id) {
        for &[x, y] in &text.vertices {
            point(
                f64::from((f64::from(x) + phase[0]) as f32),
                f64::from((f64::from(y) + phase[1]) as f32),
            );
        }
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
    crate::render_work::cpu_source();
    let mut surface = RasterSurface::window(width, height, origin);
    let object_paths: Vec<_> = paths.paths().iter().collect();
    LyonPathRasteriser.rasterise_into(&object_paths, &mut surface);
    if matches!(object, SceneObject::Text(_)) {
        crate::text::rasterise_text(texts, &id, &local, &local_effective, &mut surface)?;
    }
    Ok(LayerSource {
        surface,
        origin: [origin[0] - phase[0], origin[1] - phase[1]],
    })
}
