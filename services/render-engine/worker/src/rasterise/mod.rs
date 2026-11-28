//! Prepared vector rasterisation (build-plan 3.5).
//!
//! This module exists so scene code depends on [`PathRasteriser`] rather than
//! on a tessellation library. `lyon` 1.x (MIT) is deliberately confined to
//! [`lyon`]: it tessellates paths once while a scene is prepared, preventing
//! the per-frame geometry rebuild that invariant 35 forbids. A backend that
//! cannot carry a gradient refuses it at preparation instead of selecting a
//! stop or flattening it (invariant 18).

mod lyon;
pub mod mask;
pub mod paint;
pub mod variable_feather;
mod vello;

use gx_contracts::color::{ColorValue, OutputTransform, WorkingColorSpace};
use gx_contracts::scene::{ResolvedObject, SceneDocument};
use gx_contracts::Refusal;

use crate::colour_pipeline::WorkingRgba;
use crate::rasterizer::Frame;

pub(crate) use lyon::{prepare_masks, transform};
pub use paint::{PathGradient, PathPaint};
pub use vello::VelloCpuRasteriser;
pub(crate) use vello::{cell_transform, coverage_window, plan_coverage, window_origin, window_transform, SHEET_SIDE};
#[cfg(test)]
pub(crate) use vello::rasterise_with;

/// The outline geometry types the drawing backends share (3.17).
pub use vello_cpu::kurbo::BezPath;
pub use vello_cpu::peniko::Fill as OutlineFill;

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
        texts: Option<&crate::text::PreparedTexts>,
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
            // 3.18: a text object's glyph outlines are a path like any other.
            if let (gx_contracts::scene::SceneObject::Text(text), Some(texts)) = (object, texts) {
                if let Some(prepared) = texts.objects.iter().find(|t| t.object_id == text.base.id) {
                    lyon::prepare_text(text, prepared, resolved, &mut paths)?;
                }
            }
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
                path.paint = path.paint.clone().scaled(opacity);
            }
        }
        // Paints are prepared in linear light and expressed in the scene's
        // working space here, once per published scene, never per frame
        // (3.15, invariant 35).
        let space = document.working_color_space;
        for path in &mut paths {
            path.paint = path.paint.clone().linear_to(space);
        }
        Ok(Self { paths })
    }

    /// The prepared, ordered vector draw commands.
    pub fn paths(&self) -> &[PreparedPath] {
        &self.paths
    }
}

/// One vector draw command: an outline in scene coordinates, filled with one
/// paint under one fill rule (3.17). A stroke arrives already expanded into
/// its outline, joins, caps and dashes included, so every backend draws the
/// same geometry and none re-strokes it.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedPath {
    object_id: String,
    paint: PathPaint,
    outline: BezPath,
    clip: Option<BezPath>,
    fill_rule: OutlineFill,
    bounds: RasterBounds,
    /// 11.61: one of the many paths of one object that each carry a paint of
    /// their own: a glyph cluster under a text animator. Both backends draw
    /// the coverage of such paths into shared sheets, one cell each (see
    /// `vello::plan_coverage`); every other path is drawn alone.
    instance: bool,
}

impl PreparedPath {
    pub(crate) fn new(
        object_id: String,
        paint: PathPaint,
        outline: BezPath,
        fill_rule: OutlineFill,
    ) -> Self {
        use vello_cpu::kurbo::Shape;
        let b = outline.bounding_box();
        let bounds = RasterBounds {
            min_x: b.x0 as f32,
            min_y: b.y0 as f32,
            max_x: b.x1 as f32,
            max_y: b.y1 as f32,
        };
        Self {
            object_id,
            paint,
            outline,
            clip: None,
            fill_rule,
            bounds,
            instance: false,
        }
    }

    /// This path as one of an object's per-instance paths (11.61).
    #[cfg(test)]
    pub(crate) fn instanced(mut self) -> Self {
        self.instance = true;
        self
    }

    /// Whether the path's coverage shares a sheet with its object's other
    /// instance paths (11.61).
    pub(crate) fn instance(&self) -> bool {
        self.instance
    }

    /// The owning scene object's stable id.
    pub fn object_id(&self) -> &str {
        &self.object_id
    }

    /// Premultiplied paint in the scene's working space, converted by the
    /// colour pipeline at preparation. Tagged authored colour never reaches a
    /// raster backend.
    pub fn paint(&self) -> &PathPaint {
        &self.paint
    }

    /// The outline in scene coordinates, filled under [`Self::fill_rule`].
    pub fn outline(&self) -> &BezPath {
        &self.outline
    }

    pub(crate) fn clip(&self) -> Option<&BezPath> {
        self.clip.as_ref()
    }

    /// The fill rule the outline is filled with.
    pub fn fill_rule(&self) -> OutlineFill {
        self.fill_rule
    }

    /// Smallest scene-space rectangle that contains this draw command.
    pub fn bounds(&self) -> RasterBounds {
        self.bounds
    }
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

/// A premultiplied pixel surface in one working space, produced by a
/// [`PathRasteriser`]. The space is the scene's; it is named again at
/// [`RasterSurface::encode`].
#[derive(Debug, Clone, PartialEq)]
pub struct RasterSurface {
    origin: [f64; 2],
    width: u32,
    height: u32,
    pixels: Vec<WorkingRgba>,
    /// The project's colour depth: each blended result is stored at it.
    depth: gx_contracts::color::ColorDepth,
}

impl RasterSurface {
    /// This surface stores every blended result at `depth`.
    pub(crate) fn with_depth(mut self, depth: gx_contracts::color::ColorDepth) -> Self {
        self.depth = depth;
        self
    }

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
            depth: gx_contracts::color::ColorDepth::Bits32,
        }
    }

    pub(crate) fn origin(&self) -> [f64; 2] {
        self.origin
    }

    /// Width in scene pixels.
    /// A surface holding `pixels` as they are (3.17: an image's raster).
    pub(crate) fn from_pixels(
        width: u32,
        height: u32,
        origin: [f64; 2],
        pixels: Vec<WorkingRgba>,
    ) -> Self {
        assert_eq!(pixels.len(), (width * height) as usize);
        Self {
            origin,
            width,
            height,
            pixels,
            depth: gx_contracts::color::ColorDepth::Bits32,
        }
    }

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
        let depth = self.depth;
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
            *dst = crate::blend::store_pixel(depth, crate::blend::blend(mode, *dst, s, noise));
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
        let depth = self.depth;
        for (index, (dst, src)) in self.pixels.iter_mut().zip(&layer.pixels).enumerate() {
            let noise = if dissolve {
                crate::blend::hash_noise((index % width) as u32, (index / width) as u32, seed)
            } else {
                0.5
            };
            *dst = crate::blend::store_pixel(depth, crate::blend::blend(mode, *dst, *src, noise));
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
    /// path's outline once under its fill rule, so overlapping parts of one
    /// path composite once (3.13). Stroking is deliberately absent from this
    /// operation: it already happened in `PreparedPaths`.
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
                let PathPaint::Solid(paint) = path.paint() else {
                    continue;
                };
                for y in min_y..max_y {
                    for x in min_x..max_x {
                        surface.composite(x, y, *paint);
                    }
                }
            }
        }
    }

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            color_depth: gx_contracts::color::ColorDepth::BEFORE_DEPTH,
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
            path_links: Vec::new(),
            guides: Vec::new(),
            scene_label: None,
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
        let prepared = PreparedPaths::prepare(&document, &resolved.effective, None)
            .expect("the rectangle prepares once");

        let vello = VelloCpuRasteriser;
        let bounding_boxes = BoundingBoxRasteriser;
        assert_eq!(
            vello.rasterise(&prepared, 12, 10),
            bounding_boxes.rasterise(&prepared, 12, 10),
            "both implementations consume the same prepared scene through PathRasteriser"
        );
    }

    fn line(style: gx_contracts::scene::StrokeStyle, length: f64) -> SceneDocument {
        use gx_contracts::scene::{LineObject, Vec2};
        let mut base = ObjectBase::new("rule", "Rule");
        base.stroke = Some(ColorValue::hex("#ffffff").expect("valid colour"));
        base.stroke_width = 4.0;
        base.stroke_style = Some(style);
        document(vec![SceneObject::Line(LineObject {
            base,
            points: vec![Vec2 { x: 0.0, y: 5.0 }, Vec2 { x: length, y: 5.0 }],
        })])
    }

    fn prepare(document: &SceneDocument) -> Result<PreparedPaths, Refusal> {
        let resolved = gx_contracts::scene::resolve_hierarchy(&document.objects);
        PreparedPaths::prepare(document, &resolved.effective, None)
    }

    #[test]
    fn a_dashed_stroke_leaves_its_gaps_empty_and_its_dashes_drawn() {
        use gx_contracts::scene::StrokeStyle;
        // Dash 3, gap 3, starting at the line's start: x 0-3 drawn, 3-6 empty.
        let style = StrokeStyle {
            dash: vec![3.0, 3.0],
            ..StrokeStyle::default()
        };
        let surface = VelloCpuRasteriser.rasterise(&prepare(&line(style, 12.0)).unwrap(), 12, 10);
        let alpha = |x: usize| surface.pixels()[5 * 12 + x].a;
        assert!(alpha(1) > 0.99, "inside the first dash: {}", alpha(1));
        assert!(alpha(4) < 0.01, "inside the first gap: {}", alpha(4));
        assert!(alpha(7) > 0.99, "inside the second dash: {}", alpha(7));
        // The solid default draws the gap.
        let solid = VelloCpuRasteriser.rasterise(
            &prepare(&line(StrokeStyle::default(), 12.0)).unwrap(),
            12,
            10,
        );
        assert!(solid.pixels()[5 * 12 + 4].a > 0.99);
    }

    #[test]
    fn joins_and_caps_cover_the_areas_their_names_say() {
        use gx_contracts::scene::{LineObject, StrokeCap, StrokeJoin, StrokeStyle, Vec2};
        // A sharp V (joins) and an open segment (caps), each drawn alone; the
        // painted coverage orders as the geometry does.
        let area = |points: Vec<Vec2>, style: StrokeStyle| -> f32 {
            let mut base = ObjectBase::new("rule", "Rule");
            base.stroke = Some(ColorValue::hex("#ffffff").expect("valid colour"));
            base.stroke_width = 4.0;
            base.stroke_style = Some(style);
            let mut doc = document(vec![SceneObject::Line(LineObject { base, points })]);
            doc.canvas.width = 64;
            doc.canvas.height = 64;
            let surface = VelloCpuRasteriser.rasterise(&prepare(&doc).unwrap(), 64, 64);
            surface.pixels().iter().map(|p| p.a).sum()
        };
        let v = |x, y| Vec2 { x, y };
        let vee = || vec![v(10.0, 10.0), v(32.0, 40.0), v(54.0, 10.0)];
        let join = |join| {
            area(
                vee(),
                StrokeStyle {
                    join,
                    miter_limit: 10.0,
                    ..StrokeStyle::default()
                },
            )
        };
        let (miter, round, bevel) = (
            join(StrokeJoin::Miter),
            join(StrokeJoin::Round),
            join(StrokeJoin::Bevel),
        );
        assert!(
            bevel < round && round < miter,
            "bevel {bevel} < round {round} < miter {miter}"
        );
        let segment = || vec![v(20.0, 32.0), v(44.0, 32.0)];
        let cap = |cap| {
            area(
                segment(),
                StrokeStyle {
                    cap,
                    ..StrokeStyle::default()
                },
            )
        };
        let (butt, round, square) = (
            cap(StrokeCap::Butt),
            cap(StrokeCap::Round),
            cap(StrokeCap::Square),
        );
        assert!((butt - 96.0).abs() < 0.5, "butt: 24 x 4 = {butt}");
        assert!(
            (square - 112.0).abs() < 0.5,
            "square adds 2 x 2 x 4: {square}"
        );
        assert!(
            butt < round && round < square,
            "butt {butt} < round {round} < square {square}"
        );
    }

    #[test]
    fn a_stroke_style_that_cannot_be_drawn_as_written_is_refused_by_name() {
        use gx_contracts::scene::StrokeStyle;
        let refused =
            |style: StrokeStyle, length: f64, expect: &str| match prepare(&line(style, length)) {
                Err(Refusal::VectorTessellationFailed { object, detail }) => {
                    assert_eq!(object, "rule");
                    assert!(detail.contains(expect), "{detail}");
                }
                other => panic!("expected a refusal naming {expect}: {other:?}"),
            };
        let dashed = |dash: Vec<f64>| StrokeStyle {
            dash,
            ..StrokeStyle::default()
        };
        refused(dashed(vec![0.0, 0.0]), 10.0, "no length");
        refused(dashed(vec![2.0, -1.0]), 10.0, "not negative");
        refused(dashed(vec![f64::NAN]), 10.0, "finite");
        refused(dashed(vec![1.0; 65]), 10.0, "at most 64");
        // A bound checked before any dash is generated (invariant 51).
        refused(dashed(vec![0.001, 0.001]), 1000.0, "repeats");
        refused(
            StrokeStyle {
                miter_limit: 0.5,
                ..StrokeStyle::default()
            },
            10.0,
            "miterLimit",
        );
    }

    #[test]
    fn a_linear_gradient_fill_runs_from_its_first_stop_to_its_last_across_the_box() {
        use gx_contracts::color::{GradientStop, Rgba};
        // 3.17: a gradient is drawn, not refused or flattened. Object space:
        // from the box's left edge (red) to its right (blue), in linear light.
        let mut base = ObjectBase::new("gradient", "Gradient");
        base.width = 10.0;
        base.height = 4.0;
        base.y = 3.0;
        base.fill = Some(ColorValue::LinearGradient {
            angle: 0.0,
            start_x: 0.0,
            start_y: 0.0,
            end_x: 1.0,
            end_y: 0.0,
            stops: vec![
                GradientStop {
                    position: 0.0,
                    color: Rgba::linear(1.0, 0.0, 0.0, 1.0),
                },
                GradientStop {
                    position: 1.0,
                    color: Rgba::linear(0.0, 0.0, 1.0, 1.0),
                },
            ],
            spread: Default::default(),
            coordinate_mode: Default::default(),
        });
        let document = document(vec![SceneObject::Rect(RectObject { base, radius: 0.0 })]);
        let prepared = prepare(&document).expect("a drawable gradient prepares");
        let surface = VelloCpuRasteriser.rasterise(&prepared, 12, 10);
        let at = |x: usize| surface.pixels()[4 * 12 + x];
        // Pixel centres 0.5 and 9.5 of 10: u = 0.05 and 0.95.
        assert!(
            (at(0).r - 0.95).abs() < 1e-4 && (at(0).b - 0.05).abs() < 1e-4,
            "{:?}",
            at(0)
        );
        assert!(
            (at(9).r - 0.05).abs() < 1e-4 && (at(9).b - 0.95).abs() < 1e-4,
            "{:?}",
            at(9)
        );
        assert!((at(5).r - at(5).b + 0.1).abs() < 1e-4, "{:?}", at(5));
        assert_eq!(at(11).a, 0.0, "outside the box");
    }
}
