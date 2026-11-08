//! Prepared vector rasterisation (build-plan 3.5).
//!
//! This module exists so scene code depends on [`PathRasteriser`] rather than
//! on a tessellation library. `lyon` 1.x (MIT) is deliberately confined to
//! [`lyon`]: it tessellates paths once while a scene is prepared, preventing
//! the per-frame geometry rebuild that invariant 35 forbids. A backend that
//! cannot carry a gradient refuses it at preparation instead of selecting a
//! stop or flattening it (invariant 18).

mod lyon;

use gx_contracts::color::{ColorValue, OutputTransform, WorkingColorSpace};
use gx_contracts::scene::{ResolvedObject, SceneDocument};
use gx_contracts::Refusal;

use crate::colour_pipeline::WorkingRgba;
use crate::rasterizer::Frame;

pub use lyon::LyonPathRasteriser;
pub(crate) use lyon::{fill_union, transform};

/// Cached triangle geometry for the vector content of one published scene.
///
/// Construction is intentionally separate from [`PathRasteriser::rasterise`]:
/// it is called by `PreparedScene` exactly once during publication. The
/// rasteriser receives only these resolved draw commands, never raw scene
/// objects or JSON.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PreparedPaths {
    paths: Vec<PreparedPath>,
}

impl PreparedPaths {
    /// Tessellate every vector object after hierarchy resolution.
    ///
    /// `effective` must be the resolution of `document` in source order. A
    /// mismatch is an engine defect rather than an opportunity to associate an
    /// object with a nearby transform, so it is refused by name.
    pub fn prepare(
        document: &SceneDocument,
        effective: &[ResolvedObject],
    ) -> Result<Self, Refusal> {
        if document.objects.len() != effective.len() {
            return Err(Refusal::VectorTessellationFailed {
                object: "scene".into(),
                detail: format!(
                    "{} scene objects have {} resolved transforms",
                    document.objects.len(),
                    effective.len()
                ),
            });
        }

        let mut paths = Vec::new();
        for (object, resolved) in document.objects.iter().zip(effective) {
            if !resolved.visible || resolved.is_container {
                continue;
            }
            let first = paths.len();
            lyon::prepare_object(object, resolved, &mut paths)?;
            // 3.13: the object's effective opacity, already composed through
            // its ancestors, applies to every path it drew. Before this the
            // vector path ignored opacity and drew a 50% rectangle opaque.
            // 3.22: an object with effects is drawn at full opacity; its
            // effects run on those pixels and its opacity applies after them
            // (`prepared::compose`), as on the GPU.
            let opacity = if object.base().effects().is_empty() {
                resolved.opacity as f32
            } else {
                1.0
            };
            for path in &mut paths[first..] {
                path.paint = path.paint.scaled(opacity);
            }
        }
        // Paints are prepared in linear light and expressed in the scene's
        // working space here, once per published scene, never per frame
        // (3.15, invariant 35).
        let space = document.working_color_space;
        for path in &mut paths {
            path.paint = path.paint.linear_to(space);
        }
        Ok(Self { paths })
    }

    /// The prepared, ordered vector draw commands.
    pub fn paths(&self) -> &[PreparedPath] {
        &self.paths
    }
}

/// One filled or stroked, already-tessellated vector draw command.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedPath {
    object_id: String,
    paint: WorkingRgba,
    vertices: Vec<PathVertex>,
    indices: Vec<u32>,
    bounds: RasterBounds,
}

impl PreparedPath {
    pub(crate) fn new(
        object_id: String,
        paint: WorkingRgba,
        vertices: Vec<PathVertex>,
        indices: Vec<u32>,
    ) -> Self {
        let bounds = RasterBounds::from_vertices(&vertices);
        Self {
            object_id,
            paint,
            vertices,
            indices,
            bounds,
        }
    }

    /// The owning scene object's stable id.
    pub fn object_id(&self) -> &str {
        &self.object_id
    }

    /// Premultiplied paint in the scene's working space, converted by the
    /// colour pipeline at preparation. Tagged authored colour never reaches a
    /// raster backend.
    pub fn paint(&self) -> WorkingRgba {
        self.paint
    }

    /// The cached vertices in scene coordinates.
    pub fn vertices(&self) -> &[PathVertex] {
        &self.vertices
    }

    /// Triangle indices into [`Self::vertices`].
    pub fn indices(&self) -> &[u32] {
        &self.indices
    }

    /// Smallest scene-space rectangle that contains this draw command.
    pub fn bounds(&self) -> RasterBounds {
        self.bounds
    }
}

/// One tessellated vertex in scene coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathVertex {
    /// Horizontal scene coordinate.
    pub x: f32,
    /// Vertical scene coordinate.
    pub y: f32,
}

/// An axis-aligned rectangle in scene coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RasterBounds {
    /// Inclusive lower horizontal edge.
    pub min_x: f32,
    /// Inclusive lower vertical edge.
    pub min_y: f32,
    /// Exclusive upper horizontal edge.
    pub max_x: f32,
    /// Exclusive upper vertical edge.
    pub max_y: f32,
}

impl RasterBounds {
    fn from_vertices(vertices: &[PathVertex]) -> Self {
        let mut bounds = Self {
            min_x: f32::INFINITY,
            min_y: f32::INFINITY,
            max_x: f32::NEG_INFINITY,
            max_y: f32::NEG_INFINITY,
        };
        for vertex in vertices {
            bounds.min_x = bounds.min_x.min(vertex.x);
            bounds.min_y = bounds.min_y.min(vertex.y);
            bounds.max_x = bounds.max_x.max(vertex.x);
            bounds.max_y = bounds.max_y.max(vertex.y);
        }
        bounds
    }
}

/// A premultiplied pixel surface in one working space, produced by a
/// [`PathRasteriser`]. The space is the scene's; it is named again at
/// [`RasterSurface::encode`].
#[derive(Debug, Clone, PartialEq)]
pub struct RasterSurface {
    origin: [f64; 2],
    width: u32,
    height: u32,
    pixels: Vec<WorkingRgba>,
}

impl RasterSurface {
    /// Create a transparent surface. Transparent is the same in every space.
    pub fn transparent(width: u32, height: u32) -> Self {
        Self::window(width, height, [0.0, 0.0])
    }

    /// CPU preparation can crop a source without changing its sampling grid
    /// or the f32 geometry that the CPU reference tests for coverage.
    pub(crate) fn window(width: u32, height: u32, origin: [f64; 2]) -> Self {
        Self {
            origin,
            width,
            height,
            pixels: vec![WorkingRgba::transparent(); (width as usize) * (height as usize)],
        }
    }

    pub(crate) fn origin(&self) -> [f64; 2] {
        self.origin
    }

    /// Width in scene pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Height in scene pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Pixels in row-major order, composited in the working space.
    pub fn pixels(&self) -> &[WorkingRgba] {
        &self.pixels
    }

    /// Encode this surface once at an output boundary, from the working
    /// space it was composited in.
    pub fn encode(&self, output: OutputTransform, space: WorkingColorSpace) -> Frame {
        let mut pixels = Vec::with_capacity(self.pixels.len() * 4);
        for pixel in &self.pixels {
            pixels.extend_from_slice(&pixel.encode(output, space));
        }
        Frame {
            width: self.width,
            height: self.height,
            pixels,
        }
    }

    pub(crate) fn composite(&mut self, x: u32, y: u32, source: WorkingRgba) {
        let index = (y as usize) * (self.width as usize) + (x as usize);
        self.pixels[index] = source.over(self.pixels[index]);
    }

    /// Pixels for an effect pass to rewrite in place (3.22).
    pub(crate) fn pixels_mut(&mut self) -> &mut [WorkingRgba] {
        &mut self.pixels
    }

    /// Scale every component by `k`: a layer's opacity, applied after its
    /// effects (3.22).
    pub(crate) fn scale(&mut self, k: f32) {
        if k != 1.0 {
            for px in &mut self.pixels {
                *px = px.scaled(k);
            }
        }
    }

    /// Warp a layer-space buffer onto this canvas-sized surface and blend it,
    /// as the GPU composite pass does (3.22): `rows` are the layer's inverse
    /// affine rows (`compositor::layer_rows`), the sampler is the
    /// compositor's, opacity applies to the sample, and a layer at zero
    /// opacity changes nothing.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn warp_blend(
        &mut self,
        layer: &[WorkingRgba],
        layer_width: usize,
        layer_height: usize,
        rows: &[f32; 12],
        opacity: f32,
        mode: gx_contracts::material::BlendMode,
        seed: u32,
    ) {
        // NaN as well as zero and below: a layer that cannot be shown.
        if opacity.is_nan() || opacity <= 0.0 {
            return;
        }
        let dissolve = matches!(
            mode,
            gx_contracts::material::BlendMode::Dissolve
                | gx_contracts::material::BlendMode::DancingDissolve
        );
        let (lw, lh) = (layer_width as f32, layer_height as f32);
        let width = self.width as usize;
        for (index, dst) in self.pixels.iter_mut().enumerate() {
            let (x, y) = ((index % width) as f32 + 0.5, (index / width) as f32 + 0.5);
            let sx = rows[0] * x + rows[1] * y + rows[2];
            let sy = rows[4] * x + rows[5] * y + rows[6];
            let s = if sx > -1.0 && sy > -1.0 && sx < lw + 1.0 && sy < lh + 1.0 {
                let p =
                    crate::effect_chain::sample_bilinear(layer, layer_width, layer_height, sx, sy);
                WorkingRgba {
                    r: p.r * opacity,
                    g: p.g * opacity,
                    b: p.b * opacity,
                    a: p.a * opacity,
                }
            } else {
                WorkingRgba::transparent()
            };
            let noise = if dissolve {
                crate::blend::hash_noise((index % width) as u32, (index / width) as u32, seed)
            } else {
                0.5
            };
            *dst = crate::blend::blend(mode, *dst, s, noise);
        }
    }

    /// Blend a same-sized layer onto this surface in `mode` (3.20), every
    /// pixel, through the CPU reference `crate::blend`. `seed` is the layer's
    /// Dissolve seed; the noise key is the stage pixel's integer index.
    pub(crate) fn blend_layer(
        &mut self,
        layer: &RasterSurface,
        mode: gx_contracts::material::BlendMode,
        seed: u32,
    ) {
        assert_eq!((layer.width, layer.height), (self.width, self.height));
        let dissolve = matches!(
            mode,
            gx_contracts::material::BlendMode::Dissolve
                | gx_contracts::material::BlendMode::DancingDissolve
        );
        let width = self.width as usize;
        for (index, (dst, src)) in self.pixels.iter_mut().zip(&layer.pixels).enumerate() {
            let noise = if dissolve {
                crate::blend::hash_noise((index % width) as u32, (index / width) as u32, seed)
            } else {
                0.5
            };
            *dst = crate::blend::blend(mode, *dst, *src, noise);
        }
    }
}

/// The scene-logic-facing vector backend contract.
///
/// Implementations receive the same prepared geometry and paint. They can be
/// exchanged without reparsing a scene or changing its object dispatch; only
/// the backend's coverage algorithm changes.
pub trait PathRasteriser {
    /// Draw prepared paths onto an existing surface, in the order given, each
    /// path's triangles as one union so overlapping triangles composite once
    /// (3.13). Tessellation is deliberately absent from this operation: it
    /// already happened in `PreparedPaths`.
    fn rasterise_into(&self, paths: &[&PreparedPath], surface: &mut RasterSurface);

    /// Render every cached path to a new transparent surface.
    fn rasterise(&self, paths: &PreparedPaths, width: u32, height: u32) -> RasterSurface {
        let mut surface = RasterSurface::transparent(width, height);
        let all: Vec<&PreparedPath> = paths.paths().iter().collect();
        self.rasterise_into(&all, &mut surface);
        surface
    }
}

pub(crate) fn solid_paint(
    object: &str,
    paint_name: &str,
    color: Option<&ColorValue>,
) -> Result<Option<WorkingRgba>, Refusal> {
    match color {
        None | Some(ColorValue::None) => Ok(None),
        // Linear here; `PreparedPaths::prepare` expresses every paint in the
        // scene's working space once its paths are built.
        Some(ColorValue::Solid { color }) => Ok(Some(WorkingRgba::from_source(
            *color,
            WorkingColorSpace::LinearSrgb,
        ))),
        Some(ColorValue::LinearGradient { .. } | ColorValue::RadialGradient { .. }) => {
            Err(Refusal::UnsupportedPathGradient {
                object: object.into(),
                paint: paint_name.into(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::color::ColorValue;
    use gx_contracts::scene::SceneObject;
    use gx_contracts::scene::{ObjectBase, RectObject, SceneCanvas, SceneDocument};
    use gx_contracts::RationalRate;

    struct BoundingBoxRasteriser;

    impl PathRasteriser for BoundingBoxRasteriser {
        fn rasterise_into(&self, paths: &[&PreparedPath], surface: &mut RasterSurface) {
            let (width, height) = (surface.width(), surface.height());
            for path in paths {
                let bounds = path.bounds();
                let min_x = bounds.min_x.floor().max(0.0) as u32;
                let min_y = bounds.min_y.floor().max(0.0) as u32;
                let max_x = bounds.max_x.ceil().min(width as f32) as u32;
                let max_y = bounds.max_y.ceil().min(height as f32) as u32;
                for y in min_y..max_y {
                    for x in min_x..max_x {
                        surface.composite(x, y, path.paint());
                    }
                }
            }
        }
    }

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            id: "rasterise-test".into(),
            name: "Rasterise test".into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: None,
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 12,
                height: 10,
                frame_rate: RationalRate::P50,
            },
            timeline: Default::default(),
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects,
        }
    }

    #[test]
    fn two_rasterisers_render_the_same_prepared_rectangle_without_scene_logic_changes() {
        let mut base = ObjectBase::new("lower-third", "Lower third");
        base.x = 2.0;
        base.y = 3.0;
        base.width = 5.0;
        base.height = 3.0;
        base.fill = Some(ColorValue::hex("#2050a0").expect("valid colour"));
        let document = document(vec![SceneObject::Rect(RectObject { base, radius: 0.0 })]);
        let resolved = gx_contracts::scene::resolve_hierarchy(&document.objects);
        let prepared = PreparedPaths::prepare(&document, &resolved.effective)
            .expect("the rectangle prepares once");

        let lyon = LyonPathRasteriser;
        let bounding_boxes = BoundingBoxRasteriser;
        assert_eq!(
            lyon.rasterise(&prepared, 12, 10),
            bounding_boxes.rasterise(&prepared, 12, 10),
            "both implementations consume the same prepared scene through PathRasteriser"
        );
    }

    #[test]
    fn a_gradient_path_is_refused_instead_of_reduced_to_a_flat_colour() {
        let mut base = ObjectBase::new("gradient", "Gradient");
        base.width = 2.0;
        base.height = 2.0;
        base.fill = Some(ColorValue::LinearGradient {
            angle: 0.0,
            start_x: 0.0,
            start_y: 0.0,
            end_x: 2.0,
            end_y: 0.0,
            stops: vec![],
            spread: Default::default(),
            coordinate_mode: Default::default(),
        });
        let document = document(vec![SceneObject::Rect(RectObject { base, radius: 0.0 })]);
        let resolved = gx_contracts::scene::resolve_hierarchy(&document.objects);

        assert_eq!(
            PreparedPaths::prepare(&document, &resolved.effective),
            Err(Refusal::UnsupportedPathGradient {
                object: "gradient".into(),
                paint: "fill".into(),
            })
        );
    }
}
