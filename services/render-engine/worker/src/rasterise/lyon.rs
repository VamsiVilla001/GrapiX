//! `lyon` implementation of the backend-neutral vector contract.
//!
//! The external crate is isolated here: it converts already-resolved scene
//! paths to triangles during `PreparedPaths::prepare`, then this backend only
//! rasterises those cached triangles. Keeping the implementation boundary here
//! prevents a future tessellator from leaking into scene logic.

use lyon::algorithms::measure::{PathMeasurements, SampleType};
use lyon::math::{point, Point};
use lyon::path::{Event, Path};
use lyon::tessellation::{
    BuffersBuilder, FillOptions, FillTessellator, FillVertex, StrokeOptions, StrokeTessellator,
    StrokeVertex, VertexBuffers,
};

use gx_contracts::scene::{
    BezierPath, EllipseObject, FillRule, LineObject, PaintObject, PaintStroke, RectObject,
    ResolvedObject, SceneObject, ShapeObject, Vec2,
};
use gx_contracts::Refusal;

use super::{solid_paint, PathRasteriser, PathVertex, PreparedPath, RasterSurface};

/// The production path backend, with `lyon` confined behind [`PathRasteriser`].
#[derive(Debug, Default, Clone, Copy)]
pub struct LyonPathRasteriser;

impl PathRasteriser for LyonPathRasteriser {
    fn rasterise_into(&self, paths: &[&PreparedPath], surface: &mut RasterSurface) {
        for path in paths {
            let triangles: Vec<[PathVertex; 3]> = path
                .indices()
                .chunks_exact(3)
                .filter_map(|triangle| {
                    // Unreachable for geometry made by lyon. The bounds check
                    // keeps a corrupted cache from becoming an out-of-bounds
                    // write in the frame loop.
                    Some([
                        *path.vertices().get(triangle[0] as usize)?,
                        *path.vertices().get(triangle[1] as usize)?,
                        *path.vertices().get(triangle[2] as usize)?,
                    ])
                })
                .collect();
            fill_union(surface, &triangles, path.paint());
        }
    }
}

pub(super) fn prepare_object(
    object: &SceneObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    match object {
        SceneObject::Rect(rect) => prepare_rect(rect, resolved, output),
        SceneObject::Ellipse(ellipse) => prepare_ellipse(ellipse, resolved, output),
        SceneObject::Line(line) => prepare_line(line, resolved, output),
        SceneObject::Shape(shape) => prepare_shape(shape, resolved, output),
        SceneObject::Paint(paint) => prepare_paint(paint, resolved, output),
        _ => Ok(()),
    }
}

fn prepare_rect(
    rect: &RectObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let mut builder = Path::builder();
    let width = rect.base.width;
    let height = rect.base.height;
    let radius = rect
        .radius
        .abs()
        .min(width.abs() / 2.0)
        .min(height.abs() / 2.0);
    let x0 = 0.0;
    let y0 = 0.0;
    let x1 = width;
    let y1 = height;

    if radius == 0.0 {
        builder.begin(transform(&rect.base.anchor, resolved, x0, y0)?);
        builder.line_to(transform(&rect.base.anchor, resolved, x1, y0)?);
        builder.line_to(transform(&rect.base.anchor, resolved, x1, y1)?);
        builder.line_to(transform(&rect.base.anchor, resolved, x0, y1)?);
        builder.end(true);
    } else {
        // Cubic circles use kappa exactly enough for a tessellator; radius is
        // clamped before construction so a rounded rectangle cannot fold over.
        let kappa = 0.552_284_749_830_793_6 * radius;
        builder.begin(transform(&rect.base.anchor, resolved, x0 + radius, y0)?);
        builder.line_to(transform(&rect.base.anchor, resolved, x1 - radius, y0)?);
        builder.cubic_bezier_to(
            transform(&rect.base.anchor, resolved, x1 - radius + kappa, y0)?,
            transform(&rect.base.anchor, resolved, x1, y0 + radius - kappa)?,
            transform(&rect.base.anchor, resolved, x1, y0 + radius)?,
        );
        builder.line_to(transform(&rect.base.anchor, resolved, x1, y1 - radius)?);
        builder.cubic_bezier_to(
            transform(&rect.base.anchor, resolved, x1, y1 - radius + kappa)?,
            transform(&rect.base.anchor, resolved, x1 - radius + kappa, y1)?,
            transform(&rect.base.anchor, resolved, x1 - radius, y1)?,
        );
        builder.line_to(transform(&rect.base.anchor, resolved, x0 + radius, y1)?);
        builder.cubic_bezier_to(
            transform(&rect.base.anchor, resolved, x0 + radius - kappa, y1)?,
            transform(&rect.base.anchor, resolved, x0, y1 - radius + kappa)?,
            transform(&rect.base.anchor, resolved, x0, y1 - radius)?,
        );
        builder.line_to(transform(&rect.base.anchor, resolved, x0, y0 + radius)?);
        builder.cubic_bezier_to(
            transform(&rect.base.anchor, resolved, x0, y0 + radius - kappa)?,
            transform(&rect.base.anchor, resolved, x0 + radius - kappa, y0)?,
            transform(&rect.base.anchor, resolved, x0 + radius, y0)?,
        );
        builder.end(true);
    }
    prepare_fill_and_stroke(
        rect.base.id.as_str(),
        builder.build(),
        &rect.base.fill,
        &rect.base.stroke,
        rect.base.stroke_width,
        FillRule::Nonzero,
        output,
    )
}

fn prepare_ellipse(
    ellipse: &EllipseObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let mut builder = Path::builder();
    let rx = ellipse.base.width / 2.0;
    let ry = ellipse.base.height / 2.0;
    let cx = rx;
    let cy = ry;
    let kappa = 0.552_284_749_830_793_6;
    builder.begin(transform(&ellipse.base.anchor, resolved, cx + rx, cy)?);
    builder.cubic_bezier_to(
        transform(&ellipse.base.anchor, resolved, cx + rx, cy + kappa * ry)?,
        transform(&ellipse.base.anchor, resolved, cx + kappa * rx, cy + ry)?,
        transform(&ellipse.base.anchor, resolved, cx, cy + ry)?,
    );
    builder.cubic_bezier_to(
        transform(&ellipse.base.anchor, resolved, cx - kappa * rx, cy + ry)?,
        transform(&ellipse.base.anchor, resolved, cx - rx, cy + kappa * ry)?,
        transform(&ellipse.base.anchor, resolved, cx - rx, cy)?,
    );
    builder.cubic_bezier_to(
        transform(&ellipse.base.anchor, resolved, cx - rx, cy - kappa * ry)?,
        transform(&ellipse.base.anchor, resolved, cx - kappa * rx, cy - ry)?,
        transform(&ellipse.base.anchor, resolved, cx, cy - ry)?,
    );
    builder.cubic_bezier_to(
        transform(&ellipse.base.anchor, resolved, cx + kappa * rx, cy - ry)?,
        transform(&ellipse.base.anchor, resolved, cx + rx, cy - kappa * ry)?,
        transform(&ellipse.base.anchor, resolved, cx + rx, cy)?,
    );
    builder.end(true);
    prepare_fill_and_stroke(
        ellipse.base.id.as_str(),
        builder.build(),
        &ellipse.base.fill,
        &ellipse.base.stroke,
        ellipse.base.stroke_width,
        FillRule::Nonzero,
        output,
    )
}

fn prepare_line(
    line: &LineObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    if line.points.len() < 2 {
        return Ok(());
    }
    let mut builder = Path::builder();
    builder.begin(transform(
        &line.base.anchor,
        resolved,
        line.points[0].x,
        line.points[0].y,
    )?);
    for point in &line.points[1..] {
        builder.line_to(transform(&line.base.anchor, resolved, point.x, point.y)?);
    }
    builder.end(false);
    prepare_stroke(
        line.base.id.as_str(),
        builder.build(),
        &line.base.stroke,
        line.base.stroke_width,
        output,
    )
}

fn prepare_shape(
    shape: &ShapeObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let object = shape.base.id.as_str();
    let to_scene = |x: f64, y: f64| transform(&shape.base.anchor, resolved, x, y);
    let subpaths: Vec<&BezierPath> = std::iter::once(&shape.path)
        .chain(shape.compound_paths.iter().flatten())
        .collect();
    let mut builder = Path::builder();
    for subpath in &subpaths {
        append_bezier(&mut builder, subpath, object, &to_scene)?;
    }
    let path = builder.build();
    if shape.fill_enabled {
        prepare_fill(object, &path, &shape.base.fill, shape.fill_rule, output)?;
    }
    if shape.stroke_enabled {
        // The fill always covers the whole region; trim is stroke-only.
        let stroke = match trim_window(shape) {
            None => path,
            Some(window) => trimmed_stroke(&subpaths, window, object, &to_scene)?,
        };
        prepare_stroke(
            object,
            stroke,
            &shape.base.stroke,
            shape.base.stroke_width,
            output,
        )?;
    }
    Ok(())
}

/// Flattening tolerance for measuring a path's length, in the shape's own
/// units (authored pixels).
const TRIM_TOLERANCE: f32 = 0.01;

/// AE Trim Paths as a window on each subpath's normalised length (3.13).
#[derive(Debug, Clone, Copy, PartialEq)]
struct TrimWindow {
    /// Where the window starts, in 0..1, after the offset has turned it.
    start: f32,
    /// How much of the path it covers, in 0..1.
    length: f32,
}

/// The window a shape's trim values describe, or `None` for the whole
/// stroke. Static values outside their domain were refused by the validator
/// at publish (`ShapeTrimInvalid`); an animated value evaluated past its
/// range is held to it, as After Effects does.
fn trim_window(shape: &ShapeObject) -> Option<TrimWindow> {
    let start = shape.trim_start.unwrap_or(0.0).clamp(0.0, 100.0);
    let end = shape.trim_end.unwrap_or(100.0).clamp(0.0, 100.0);
    let offset = shape.trim_offset.unwrap_or(0.0);
    let (low, high) = (start.min(end), start.max(end));
    let length = (high - low) / 100.0;
    if length >= 1.0 || !offset.is_finite() {
        return None;
    }
    Some(TrimWindow {
        start: ((low + offset) / 100.0).rem_euclid(1.0) as f32,
        length: length as f32,
    })
}

/// Cut each subpath to the window, measured in the shape's own coordinates
/// so a non-uniform scale does not move it, then carry the pieces into the
/// scene through the same transform the whole path uses. A window that runs
/// past the end of a subpath wraps to its beginning.
fn trimmed_stroke(
    subpaths: &[&BezierPath],
    window: TrimWindow,
    object: &str,
    to_scene: &dyn Fn(f64, f64) -> Result<Point, Refusal>,
) -> Result<Path, Refusal> {
    let local_point = |x: f64, y: f64| Ok(point(x as f32, y as f32));
    let map = |at: Point| to_scene(f64::from(at.x), f64::from(at.y));
    let mut scene = Path::builder();
    for subpath in subpaths {
        let mut local = Path::builder();
        append_bezier(&mut local, subpath, object, &local_point)?;
        let local = local.build();
        let measurements = PathMeasurements::from_path(&local, TRIM_TOLERANCE);
        let mut sampler = measurements.create_sampler(&local, SampleType::Normalized);
        let mut pieces = Path::builder_with_attributes(0);
        let end = window.start + window.length;
        if end <= 1.0 {
            sampler.split_range(window.start..end, &mut pieces);
        } else {
            sampler.split_range(window.start..1.0, &mut pieces);
            sampler.split_range(0.0..end - 1.0, &mut pieces);
        }
        for event in pieces.build().iter() {
            match event {
                Event::Begin { at } => {
                    scene.begin(map(at)?);
                }
                Event::Line { to, .. } => {
                    scene.line_to(map(to)?);
                }
                Event::Quadratic { ctrl, to, .. } => {
                    scene.quadratic_bezier_to(map(ctrl)?, map(to)?);
                }
                Event::Cubic {
                    ctrl1, ctrl2, to, ..
                } => {
                    scene.cubic_bezier_to(map(ctrl1)?, map(ctrl2)?, map(to)?);
                }
                Event::End { close, .. } => {
                    scene.end(close);
                }
            }
        }
    }
    Ok(scene.build())
}

fn prepare_paint(
    paint: &PaintObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    for stroke in &paint.strokes {
        prepare_paint_stroke(&paint.base.id, &paint.base.anchor, stroke, resolved, output)?;
    }
    Ok(())
}

fn prepare_paint_stroke(
    object: &str,
    anchor: &Option<Vec2>,
    stroke: &PaintStroke,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let paint = solid_paint(
        object,
        &format!("paint stroke {}", stroke.id),
        Some(&stroke.color),
    )?;
    if paint.is_none() {
        return Ok(());
    }
    if stroke.points.is_empty() || stroke.size <= 0.0 {
        return Ok(());
    }

    // A brush path is a union of discs. It is constructed as one path so lyon
    // applies the fill rule before compositing and overlapping dabs do not
    // repeatedly darken a semitransparent stroke.
    let mut builder = Path::builder();
    let radius = stroke.size / 2.0;
    for brush in &stroke.points {
        append_disc(&mut builder, anchor, resolved, brush.x, brush.y, radius)?;
    }
    prepare_fill_and_stroke(
        object,
        builder.build(),
        &Some(stroke.color.clone()),
        &None,
        0.0,
        FillRule::Nonzero,
        output,
    )
}

/// Append one authored bezier path, every point placed by `map`: the scene
/// transform for drawing, or the identity for measuring trim locally.
fn append_bezier(
    builder: &mut lyon::path::Builder,
    path: &BezierPath,
    object: &str,
    map: &dyn Fn(f64, f64) -> Result<Point, Refusal>,
) -> Result<(), Refusal> {
    gx_contracts::drawability::bezier_arrays_match(object, path)?;
    let Some(first) = path.vertices.first() else {
        return Ok(());
    };
    builder.begin(map(first.x, first.y)?);
    let last = if path.closed {
        path.vertices.len()
    } else {
        path.vertices.len() - 1
    };
    for index in 0..last {
        let next = (index + 1) % path.vertices.len();
        let current_vertex = path.vertices[index];
        let next_vertex = path.vertices[next];
        let out_tangent = path.out_tangents[index];
        let in_tangent = path.in_tangents[next];
        builder.cubic_bezier_to(
            map(
                current_vertex.x + out_tangent.x,
                current_vertex.y + out_tangent.y,
            )?,
            map(next_vertex.x + in_tangent.x, next_vertex.y + in_tangent.y)?,
            map(next_vertex.x, next_vertex.y)?,
        );
    }
    builder.end(path.closed);
    Ok(())
}

fn append_disc(
    builder: &mut lyon::path::Builder,
    anchor: &Option<Vec2>,
    resolved: &ResolvedObject,
    cx: f64,
    cy: f64,
    radius: f64,
) -> Result<(), Refusal> {
    let kappa = 0.552_284_749_830_793_6;
    builder.begin(transform(anchor, resolved, cx + radius, cy)?);
    builder.cubic_bezier_to(
        transform(anchor, resolved, cx + radius, cy + kappa * radius)?,
        transform(anchor, resolved, cx + kappa * radius, cy + radius)?,
        transform(anchor, resolved, cx, cy + radius)?,
    );
    builder.cubic_bezier_to(
        transform(anchor, resolved, cx - kappa * radius, cy + radius)?,
        transform(anchor, resolved, cx - radius, cy + kappa * radius)?,
        transform(anchor, resolved, cx - radius, cy)?,
    );
    builder.cubic_bezier_to(
        transform(anchor, resolved, cx - radius, cy - kappa * radius)?,
        transform(anchor, resolved, cx - kappa * radius, cy - radius)?,
        transform(anchor, resolved, cx, cy - radius)?,
    );
    builder.cubic_bezier_to(
        transform(anchor, resolved, cx + kappa * radius, cy - radius)?,
        transform(anchor, resolved, cx + radius, cy - kappa * radius)?,
        transform(anchor, resolved, cx + radius, cy)?,
    );
    builder.end(true);
    Ok(())
}

fn prepare_fill_and_stroke(
    object: &str,
    path: Path,
    fill: &Option<gx_contracts::color::ColorValue>,
    stroke: &Option<gx_contracts::color::ColorValue>,
    stroke_width: f64,
    fill_rule: FillRule,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    prepare_fill(object, &path, fill, fill_rule, output)?;
    prepare_stroke(object, path, stroke, stroke_width, output)
}

fn prepare_fill(
    object: &str,
    path: &Path,
    fill: &Option<gx_contracts::color::ColorValue>,
    fill_rule: FillRule,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let Some(paint) = solid_paint(object, "fill", fill.as_ref())? else {
        return Ok(());
    };
    let mut geometry: VertexBuffers<PathVertex, u32> = VertexBuffers::new();
    let mut tessellator = FillTessellator::new();
    let options = match fill_rule {
        FillRule::Nonzero => FillOptions::default(),
        FillRule::Evenodd => FillOptions::even_odd(),
    };
    tessellator
        .tessellate_path(
            path,
            &options,
            &mut BuffersBuilder::new(&mut geometry, |vertex: FillVertex| PathVertex {
                x: vertex.position().x,
                y: vertex.position().y,
            }),
        )
        .map_err(|error| Refusal::VectorTessellationFailed {
            object: object.into(),
            detail: error.to_string(),
        })?;
    append_fill(object, geometry, paint, output)
}

fn append_fill(
    object: &str,
    geometry: VertexBuffers<PathVertex, u32>,
    paint: crate::colour_pipeline::WorkingRgba,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    if !geometry.indices.is_empty() {
        output.push(PreparedPath::new(
            object.into(),
            paint,
            geometry.vertices,
            geometry.indices,
        ));
    }
    Ok(())
}

fn prepare_stroke(
    object: &str,
    path: Path,
    stroke: &Option<gx_contracts::color::ColorValue>,
    stroke_width: f64,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let Some(paint) = solid_paint(object, "stroke", stroke.as_ref())? else {
        return Ok(());
    };
    if stroke_width <= 0.0 {
        return Ok(());
    }
    let mut geometry: VertexBuffers<PathVertex, u32> = VertexBuffers::new();
    let mut tessellator = StrokeTessellator::new();
    tessellator
        .tessellate_path(
            &path,
            &StrokeOptions::default().with_line_width(stroke_width as f32),
            &mut BuffersBuilder::new(&mut geometry, |vertex: StrokeVertex| PathVertex {
                x: vertex.position().x,
                y: vertex.position().y,
            }),
        )
        .map_err(|error| Refusal::VectorTessellationFailed {
            object: object.into(),
            detail: error.to_string(),
        })?;
    append_fill(object, geometry, paint, output)
}

pub(crate) fn transform(
    anchor: &Option<Vec2>,
    resolved: &ResolvedObject,
    x: f64,
    y: f64,
) -> Result<Point, Refusal> {
    let anchor = anchor.unwrap_or(Vec2 { x: 0.0, y: 0.0 });
    let local_x = (x - anchor.x) * resolved.scale_x;
    let local_y = (y - anchor.y) * resolved.scale_y;
    let radians = resolved.rotation_z.to_radians();
    let cos = radians.cos();
    let sin = radians.sin();
    let scene_x = local_x * cos - local_y * sin + resolved.x;
    let scene_y = local_x * sin + local_y * cos + resolved.y;
    if !(scene_x as f32).is_finite() || !(scene_y as f32).is_finite() {
        return Err(Refusal::VectorTessellationFailed {
            object: resolved.id.clone(),
            detail: "a resolved path coordinate cannot be represented as a finite f32".into(),
        });
    }
    Ok(point(scene_x as f32, scene_y as f32))
}

/// Fill a shape given as triangles with one paint, compositing every covered
/// pixel exactly once (3.13). A shape is the union of its triangles:
/// overlapping ones — a stroke's joins, kerned glyphs — must not darken a
/// semi-transparent paint where they overlap. Coverage is point-sampled at
/// pixel centres.
pub(crate) fn fill_union(
    surface: &mut RasterSurface,
    triangles: &[[PathVertex; 3]],
    paint: crate::colour_pipeline::WorkingRgba,
) {
    if triangles.is_empty() || paint.a <= 0.0 {
        return;
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for corner in triangles.iter().flatten() {
        min_x = min_x.min(corner.x);
        min_y = min_y.min(corner.y);
        max_x = max_x.max(corner.x);
        max_y = max_y.max(corner.y);
    }
    let origin = surface.origin();
    let min_x = (f64::from(min_x.floor()) - origin[0]).max(0.0) as u32;
    let min_y = (f64::from(min_y.floor()) - origin[1]).max(0.0) as u32;
    let max_x = (f64::from(max_x.ceil()) - origin[0])
        .min(f64::from(surface.width()))
        .max(0.0) as u32;
    let max_y = (f64::from(max_y.ceil()) - origin[1])
        .min(f64::from(surface.height()))
        .max(0.0) as u32;
    if min_x >= max_x || min_y >= max_y {
        return;
    }
    let width = (max_x - min_x) as usize;
    let mut covered = vec![false; width * (max_y - min_y) as usize];
    for &[a, b, c] in triangles {
        let area = edge(a, b, c.x, c.y);
        if area == 0.0 {
            continue;
        }
        let x0 =
            (f64::from(a.x.min(b.x).min(c.x).floor()) - origin[0]).max(f64::from(min_x)) as u32;
        let y0 =
            (f64::from(a.y.min(b.y).min(c.y).floor()) - origin[1]).max(f64::from(min_y)) as u32;
        let x1 = (f64::from(a.x.max(b.x).max(c.x).ceil()) - origin[0])
            .min(f64::from(max_x))
            .max(0.0) as u32;
        let y1 = (f64::from(a.y.max(b.y).max(c.y).ceil()) - origin[1])
            .min(f64::from(max_y))
            .max(0.0) as u32;
        for y in y0..y1 {
            for x in x0..x1 {
                let sample_x = (origin[0] + f64::from(x) + 0.5) as f32;
                let sample_y = (origin[1] + f64::from(y) + 0.5) as f32;
                let ab = edge(a, b, sample_x, sample_y);
                let bc = edge(b, c, sample_x, sample_y);
                let ca = edge(c, a, sample_x, sample_y);
                if (area > 0.0 && ab >= 0.0 && bc >= 0.0 && ca >= 0.0)
                    || (area < 0.0 && ab <= 0.0 && bc <= 0.0 && ca <= 0.0)
                {
                    covered[(y - min_y) as usize * width + (x - min_x) as usize] = true;
                }
            }
        }
    }
    for (index, _) in covered.iter().enumerate().filter(|(_, covered)| **covered) {
        let x = min_x + (index % width) as u32;
        let y = min_y + (index / width) as u32;
        surface.composite(x, y, paint);
    }
}

fn edge(a: PathVertex, b: PathVertex, x: f32, y: f32) -> f32 {
    (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x)
}
