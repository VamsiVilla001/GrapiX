//! `lyon` implementation of the backend-neutral vector contract.
//!
//! The external crate is isolated here: it converts already-resolved scene
//! paths to triangles during `PreparedPaths::prepare`, then this backend only
//! rasterises those cached triangles. Keeping the implementation boundary here
//! prevents a future tessellator from leaking into scene logic.

use lyon::math::{point, Point};
use lyon::path::builder::PathBuilder;
use lyon::path::Path;
use lyon::tessellation::{
    BuffersBuilder, FillOptions, FillTessellator, FillVertex, StrokeOptions, StrokeTessellator,
    StrokeVertex, VertexBuffers,
};

use gx_contracts::scene::{
    BezierPath, EllipseObject, FillRule, LineObject, PaintObject, PaintStroke, RectObject,
    ResolvedObject, SceneObject, ShapeObject, Vec2,
};
use gx_contracts::Refusal;

use super::{solid_paint, PathRasteriser, PathVertex, PreparedPath, PreparedPaths, RasterSurface};

/// The production path backend, with `lyon` confined behind [`PathRasteriser`].
#[derive(Debug, Default, Clone, Copy)]
pub struct LyonPathRasteriser;

impl PathRasteriser for LyonPathRasteriser {
    fn rasterise(&self, paths: &PreparedPaths, width: u32, height: u32) -> RasterSurface {
        let mut surface = RasterSurface::transparent(width, height);
        for path in paths.paths() {
            for triangle in path.indices().chunks_exact(3) {
                let (Some(a), Some(b), Some(c)) = (
                    path.vertices().get(triangle[0] as usize),
                    path.vertices().get(triangle[1] as usize),
                    path.vertices().get(triangle[2] as usize),
                ) else {
                    // This is unreachable for geometry made by lyon. The
                    // bounds check keeps a corrupted cache from becoming an
                    // out-of-bounds write in the frame loop.
                    continue;
                };
                rasterise_triangle(&mut surface, *a, *b, *c, path.paint());
            }
        }
        surface
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
    let mut builder = Path::builder();
    append_bezier(
        &mut builder,
        &shape.path,
        &shape.base.anchor,
        resolved,
        &shape.base.id,
    )?;
    if let Some(compound_paths) = &shape.compound_paths {
        for path in compound_paths {
            append_bezier(
                &mut builder,
                path,
                &shape.base.anchor,
                resolved,
                &shape.base.id,
            )?;
        }
    }
    let path = builder.build();
    if shape.fill_enabled {
        prepare_fill(
            shape.base.id.as_str(),
            &path,
            &shape.base.fill,
            shape.fill_rule,
            output,
        )?;
    }
    if shape.stroke_enabled {
        prepare_stroke(
            shape.base.id.as_str(),
            path,
            &shape.base.stroke,
            shape.base.stroke_width,
            output,
        )?;
    }
    Ok(())
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
    let Some(paint) = paint else {
        return Ok(());
    };
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

fn append_bezier(
    builder: &mut lyon::path::Builder,
    path: &BezierPath,
    anchor: &Option<Vec2>,
    resolved: &ResolvedObject,
    object: &str,
) -> Result<(), Refusal> {
    if path.vertices.len() != path.in_tangents.len()
        || path.vertices.len() != path.out_tangents.len()
    {
        return Err(Refusal::VectorTessellationFailed {
            object: object.into(),
            detail: "Bezier vertices and tangent arrays differ in length".into(),
        });
    }
    let Some(first) = path.vertices.first() else {
        return Ok(());
    };
    builder.begin(transform(anchor, resolved, first.x, first.y)?);
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
            transform(
                anchor,
                resolved,
                current_vertex.x + out_tangent.x,
                current_vertex.y + out_tangent.y,
            )?,
            transform(
                anchor,
                resolved,
                next_vertex.x + in_tangent.x,
                next_vertex.y + in_tangent.y,
            )?,
            transform(anchor, resolved, next_vertex.x, next_vertex.y)?,
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
    paint: crate::colour_pipeline::LinearRgba,
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

fn transform(
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
    if !scene_x.is_finite() || !scene_y.is_finite() {
        return Err(Refusal::VectorTessellationFailed {
            object: resolved.id.clone(),
            detail: "a resolved path coordinate is not finite".into(),
        });
    }
    Ok(point(scene_x as f32, scene_y as f32))
}

fn rasterise_triangle(
    surface: &mut RasterSurface,
    a: PathVertex,
    b: PathVertex,
    c: PathVertex,
    paint: crate::colour_pipeline::LinearRgba,
) {
    let min_x = a.x.min(b.x).min(c.x).floor().max(0.0) as u32;
    let min_y = a.y.min(b.y).min(c.y).floor().max(0.0) as u32;
    let max_x = a.x.max(b.x).max(c.x).ceil().min(surface.width() as f32) as u32;
    let max_y = a.y.max(b.y).max(c.y).ceil().min(surface.height() as f32) as u32;
    let area = edge(a, b, c.x, c.y);
    if area == 0.0 {
        return;
    }
    for y in min_y..max_y {
        for x in min_x..max_x {
            let sample_x = x as f32 + 0.5;
            let sample_y = y as f32 + 0.5;
            let ab = edge(a, b, sample_x, sample_y);
            let bc = edge(b, c, sample_x, sample_y);
            let ca = edge(c, a, sample_x, sample_y);
            if (area > 0.0 && ab >= 0.0 && bc >= 0.0 && ca >= 0.0)
                || (area < 0.0 && ab <= 0.0 && bc <= 0.0 && ca <= 0.0)
            {
                surface.composite(x, y, paint);
            }
        }
    }
}

fn edge(a: PathVertex, b: PathVertex, x: f32, y: f32) -> f32 {
    (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x)
}
