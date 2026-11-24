//! `lyon` implementation of the backend-neutral vector contract.
//!
//! The external crate is isolated here: it converts already-resolved scene
//! paths to triangles during `PreparedPaths::prepare`, then this backend only
//! rasterises those cached triangles. Keeping the implementation boundary here
//! prevents a future tessellator from leaking into scene logic.

use lyon::algorithms::measure::{PathMeasurements, SampleType};
use lyon::math::{point, Point};
use lyon::path::{Event, Path};

use gx_contracts::scene::{
    BezierPath, EllipseObject, FillRule, LineObject, PaintObject, PaintStroke, RectObject,
    ResolvedObject, SceneObject, ShapeObject, Vec2,
};
use gx_contracts::Refusal;

use super::paint::{path_paint, ObjectFrame, PathPaint};
use super::{solid_paint, PreparedPath};

/// An object's masks (3.19), each path placed by `map` from the object's own
/// coordinates into the layer's.
pub(crate) fn prepare_masks(
    object: &str,
    masks: &[gx_contracts::scene::Mask],
    map: &dyn Fn(f64, f64) -> Result<Point, Refusal>,
) -> Result<Vec<super::mask::PreparedMask>, Refusal> {
    use vello_cpu::kurbo::{Join, Stroke, StrokeOpts};
    masks
        .iter()
        .map(|mask| {
            let mut builder = Path::builder();
            append_bezier(&mut builder, &mask.path, object, map)?;
            let fill = outline(&builder.build());
            let variable = super::variable_feather::prepare(object, mask, map)?;
            let band = (mask.expansion != 0.0).then(|| {
                vello_cpu::kurbo::stroke(
                    fill.iter(),
                    &Stroke::new(2.0 * mask.expansion.abs()).with_join(Join::Round),
                    &StrokeOpts::default(),
                    STROKE_TOLERANCE,
                )
            });
            Ok(super::mask::PreparedMask {
                fill,
                band,
                grow: mask.expansion > 0.0,
                // A variable feather replaces the uniform one (11.108).
                weights: if variable.is_some() { Vec::new() } else { super::mask::falloff_weights(mask.feather, mask.falloff.unwrap_or_default()) },
                weights_y: if variable.is_some() { Vec::new() } else { super::mask::falloff_weights(mask.feather_across(), mask.falloff.unwrap_or_default()) },
                inverted: mask.inverted,
                opacity: mask.opacity as f32,
                mode: mask.mode,
                variable: variable.map(std::sync::Arc::new),
            })
        })
        .collect()
}

pub(super) fn prepare_object(
    object: &SceneObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let base = object.base();
    let frame = ObjectFrame {
        anchor: &base.anchor,
        resolved,
        width: base.width,
        height: base.height,
    };
    let frame = &frame;
    match object {
        SceneObject::Rect(rect) => prepare_rect(rect, resolved, frame, output),
        SceneObject::Ellipse(ellipse) => prepare_ellipse(ellipse, resolved, frame, output),
        SceneObject::Line(line) => prepare_line(line, resolved, frame, output),
        SceneObject::Shape(shape) => prepare_shape(shape, resolved, frame, output),
        SceneObject::Paint(paint) => prepare_paint(paint, resolved, output),
        _ => Ok(()),
    }
}

/// A text object's glyph outlines (3.18), placed by its transform, filled
/// with its fill and stroked with its stroke, as any other path.
pub(super) fn prepare_text(
    text: &gx_contracts::scene::TextObject,
    prepared: &crate::text::PreparedTextObject,
    resolved: &ResolvedObject,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    use vello_cpu::kurbo::{PathEl, Point as K};
    let base = &text.base;
    let id = base.id.as_str();
    let place = |p: K| -> Result<K, Refusal> {
        let at = transform(&base.anchor, resolved, p.x, p.y)?;
        Ok(K::new(f64::from(at.x), f64::from(at.y)))
    };
    let mut scene = super::BezPath::new();
    for element in prepared.outline.elements() {
        scene.push(match *element {
            PathEl::MoveTo(p) => PathEl::MoveTo(place(p)?),
            PathEl::LineTo(p) => PathEl::LineTo(place(p)?),
            PathEl::QuadTo(c, p) => PathEl::QuadTo(place(c)?, place(p)?),
            PathEl::CurveTo(c1, c2, p) => PathEl::CurveTo(place(c1)?, place(c2)?, place(p)?),
            PathEl::ClosePath => PathEl::ClosePath,
        });
    }
    let frame = ObjectFrame {
        anchor: &base.anchor,
        resolved,
        width: base.width,
        height: base.height,
    };
    if let Some(paint) = path_paint(id, "text fill", base.fill.as_ref(), &frame)? {
        append_outline(
            id,
            scene.clone(),
            super::OutlineFill::NonZero,
            paint,
            output,
        );
    }
    stroke_outline(
        id,
        &scene,
        &base.stroke,
        base.stroke_width,
        &base.stroke_style(),
        &frame,
        output,
    )
}

fn prepare_rect(
    rect: &RectObject,
    resolved: &ResolvedObject,
    frame: &ObjectFrame,
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
        &rect.base.stroke_style(),
        FillRule::Nonzero,
        frame,
        output,
    )
}

fn prepare_ellipse(
    ellipse: &EllipseObject,
    resolved: &ResolvedObject,
    frame: &ObjectFrame,
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
        &ellipse.base.stroke_style(),
        FillRule::Nonzero,
        frame,
        output,
    )
}

fn prepare_line(
    line: &LineObject,
    resolved: &ResolvedObject,
    frame: &ObjectFrame,
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
        &line.base.stroke_style(),
        frame,
        output,
    )
}

fn prepare_shape(
    shape: &ShapeObject,
    resolved: &ResolvedObject,
    frame: &ObjectFrame,
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
        prepare_fill(
            object,
            &path,
            &shape.base.fill,
            shape.fill_rule,
            frame,
            output,
        )?;
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
            &shape.base.stroke_style(),
            frame,
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
    if paint.is_none_or(|paint| paint.a <= 0.0) {
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
    let Some(paint) = paint else {
        return Ok(());
    };
    append_outline(
        object,
        outline(&builder.build()),
        super::OutlineFill::NonZero,
        PathPaint::Solid(paint),
        output,
    );
    Ok(())
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

#[allow(clippy::too_many_arguments)]
fn prepare_fill_and_stroke(
    object: &str,
    path: Path,
    fill: &Option<gx_contracts::color::ColorValue>,
    stroke: &Option<gx_contracts::color::ColorValue>,
    stroke_width: f64,
    stroke_style: &gx_contracts::scene::StrokeStyle,
    fill_rule: FillRule,
    frame: &ObjectFrame,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    prepare_fill(object, &path, fill, fill_rule, frame, output)?;
    prepare_stroke(
        object,
        path,
        stroke,
        stroke_width,
        stroke_style,
        frame,
        output,
    )
}

/// A lyon path as a kurbo outline, point for point (3.17).
fn outline(path: &Path) -> super::BezPath {
    use lyon::path::Event;
    use vello_cpu::kurbo::Point as K;
    let p = |q: lyon::math::Point| K::new(f64::from(q.x), f64::from(q.y));
    let mut out = super::BezPath::new();
    for event in path.iter() {
        match event {
            Event::Begin { at } => out.move_to(p(at)),
            Event::Line { to, .. } => out.line_to(p(to)),
            Event::Quadratic { ctrl, to, .. } => out.quad_to(p(ctrl), p(to)),
            Event::Cubic {
                ctrl1, ctrl2, to, ..
            } => out.curve_to(p(ctrl1), p(ctrl2), p(to)),
            Event::End { close, .. } => {
                if close {
                    out.close_path();
                }
            }
        }
    }
    out
}

/// Flattening tolerance for stroke expansion, in scene pixels.
const STROKE_TOLERANCE: f64 = 0.01;
/// Most dash periods one stroke may expand into: a bound checked before the
/// dashes are generated (invariant 51).
const MOST_DASH_PERIODS: f64 = 100_000.0;

/// The authored stroke style as kurbo's, refused by name when it cannot be
/// drawn as written.
fn kurbo_stroke(
    object: &str,
    path: &super::BezPath,
    width: f64,
    style: &gx_contracts::scene::StrokeStyle,
) -> Result<vello_cpu::kurbo::Stroke, Refusal> {
    use gx_contracts::scene::{StrokeCap, StrokeJoin};
    use vello_cpu::kurbo::{Cap, Join, ParamCurveArclen, Stroke};
    let refuse = |detail: String| Refusal::VectorTessellationFailed {
        object: object.into(),
        detail,
    };
    if let Some(detail) = style.problem() {
        return Err(refuse(detail));
    }
    let join = match style.join {
        StrokeJoin::Miter => Join::Miter,
        StrokeJoin::Round => Join::Round,
        StrokeJoin::Bevel => Join::Bevel,
    };
    let cap = match style.cap {
        StrokeCap::Butt => Cap::Butt,
        StrokeCap::Round => Cap::Round,
        StrokeCap::Square => Cap::Square,
    };
    let stroke = Stroke::new(width)
        .with_join(join)
        .with_caps(cap)
        .with_miter_limit(style.miter_limit);
    if style.dash.is_empty() {
        return Ok(stroke);
    }
    // The values were checked above (`StrokeStyle::problem`); what is left is
    // what only the path can say. An odd pattern repeats twice to alternate
    // dash and gap, as in SVG.
    let period: f64 =
        style.dash.iter().sum::<f64>() * if style.dash.len() % 2 == 1 { 2.0 } else { 1.0 };
    let length: f64 = path.segments().map(|s| s.arclen(STROKE_TOLERANCE)).sum();
    if length / period > MOST_DASH_PERIODS {
        return Err(refuse(format!(
            "strokeStyle.dash repeats {:.0} times along the stroke; at most {MOST_DASH_PERIODS}",
            length / period
        )));
    }
    Ok(stroke.with_dashes(style.dash_offset, style.dash.iter().copied()))
}

fn prepare_fill(
    object: &str,
    path: &Path,
    fill: &Option<gx_contracts::color::ColorValue>,
    fill_rule: FillRule,
    frame: &ObjectFrame,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let Some(paint) = path_paint(object, "fill", fill.as_ref(), frame)? else {
        return Ok(());
    };
    let rule = match fill_rule {
        FillRule::Nonzero => super::OutlineFill::NonZero,
        FillRule::Evenodd => super::OutlineFill::EvenOdd,
    };
    append_outline(object, outline(path), rule, paint, output);
    Ok(())
}

fn append_outline(
    object: &str,
    outline: super::BezPath,
    rule: super::OutlineFill,
    paint: PathPaint,
    output: &mut Vec<PreparedPath>,
) {
    if !outline.elements().is_empty() {
        output.push(PreparedPath::new(object.into(), paint, outline, rule));
    }
}

fn prepare_stroke(
    object: &str,
    path: Path,
    stroke: &Option<gx_contracts::color::ColorValue>,
    stroke_width: f64,
    stroke_style: &gx_contracts::scene::StrokeStyle,
    frame: &ObjectFrame,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    stroke_outline(
        object,
        &outline(&path),
        stroke,
        stroke_width,
        stroke_style,
        frame,
        output,
    )
}

/// Stroke an outline already in scene coordinates.
fn stroke_outline(
    object: &str,
    centre: &super::BezPath,
    stroke: &Option<gx_contracts::color::ColorValue>,
    stroke_width: f64,
    stroke_style: &gx_contracts::scene::StrokeStyle,
    frame: &ObjectFrame,
    output: &mut Vec<PreparedPath>,
) -> Result<(), Refusal> {
    let Some(paint) = path_paint(object, "stroke", stroke.as_ref(), frame)? else {
        return Ok(());
    };
    if stroke_width <= 0.0 {
        return Ok(());
    }
    // The stroke is expanded once here into the outline it covers, joins,
    // caps and dashes included, and that outline is filled non-zero: every
    // backend then draws the same geometry (3.17).
    let style = kurbo_stroke(object, centre, stroke_width, stroke_style)?;
    let expanded = vello_cpu::kurbo::stroke(
        centre.iter(),
        &style,
        &vello_cpu::kurbo::StrokeOpts::default(),
        STROKE_TOLERANCE,
    );
    append_outline(object, expanded, super::OutlineFill::NonZero, paint, output);
    Ok(())
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
