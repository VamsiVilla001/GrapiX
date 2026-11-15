//! A path's paint (3.17): a solid colour or a linear or radial gradient,
//! prepared once in the scene's working space and evaluated in float.
//!
//! A gradient is reduced at prepare to two affine rows from scene
//! coordinates: `u`, and for a radial gradient `v`. A linear gradient's
//! parameter is `u`; a radial one's is `|(u, v)|`. For each coverage window
//! the rows are re-expressed in f32 relative to that window's pixels
//! ([`PathGradient::window_rows`]), and both drawing backends evaluate them,
//! the spread and the stops with the same f32 operations
//! ([`PathGradient::colour`] and its WGSL twin in `compositor/draw.wgsl`).
//! Stops interpolate premultiplied in the working space (`WorkingRgba::mix`),
//! the operation every working-space gradient uses (3.15).

use crate::colour_pipeline::WorkingRgba;
use gx_contracts::color::{ColorValue, GradientSpread, WorkingColorSpace};
use gx_contracts::scene::{ResolvedObject, Vec2};
use gx_contracts::Refusal;

/// A path's paint, premultiplied in the scene's working space once prepared.
#[derive(Debug, Clone, PartialEq)]
pub enum PathPaint {
    Solid(WorkingRgba),
    Gradient(Box<PathGradient>),
}

/// A prepared linear or radial gradient.
#[derive(Debug, Clone, PartialEq)]
pub struct PathGradient {
    pub radial: bool,
    /// Scene point (x, y) to `u = rows[0] x + rows[1] y + rows[2]` and
    /// `v = rows[3] x + rows[4] y + rows[5]`.
    pub rows: [f64; 6],
    pub spread: GradientSpread,
    /// Positions in 0 to 1, non-decreasing, each with its colour.
    pub stops: Vec<(f32, WorkingRgba)>,
}

impl PathPaint {
    /// Whether the paint can put any pixel on screen.
    pub fn visible(&self) -> bool {
        match self {
            Self::Solid(colour) => colour.a > 0.0,
            Self::Gradient(g) => g.stops.iter().any(|(_, c)| c.a > 0.0),
        }
    }

    pub(crate) fn scaled(self, k: f32) -> Self {
        match self {
            Self::Solid(colour) => Self::Solid(colour.scaled(k)),
            Self::Gradient(mut g) => {
                for (_, colour) in &mut g.stops {
                    *colour = colour.scaled(k);
                }
                Self::Gradient(g)
            }
        }
    }

    pub(crate) fn linear_to(self, space: WorkingColorSpace) -> Self {
        match self {
            Self::Solid(colour) => Self::Solid(colour.linear_to(space)),
            Self::Gradient(mut g) => {
                for (_, colour) in &mut g.stops {
                    *colour = colour.linear_to(space);
                }
                Self::Gradient(g)
            }
        }
    }
}

/// Where an object's own coordinates sit in the scene: what an object-space
/// gradient is placed by.
pub(crate) struct ObjectFrame<'a> {
    pub anchor: &'a Option<Vec2>,
    pub resolved: &'a ResolvedObject,
    pub width: f64,
    pub height: f64,
}

impl ObjectFrame<'_> {
    /// Scene point to object-space fraction of the box: the inverse of
    /// `lyon::transform`, then divided by the box. Rows `[a, b, c, d, e, f]`
    /// with `gx = a x + b y + c`, `gy = d x + e y + f`.
    fn scene_to_box(&self) -> [f64; 6] {
        let anchor = self.anchor.unwrap_or(Vec2 { x: 0.0, y: 0.0 });
        let r = self.resolved;
        let (sin, cos) = r.rotation_z.to_radians().sin_cos();
        // scene = R S (p - anchor) + t, so p = S^-1 R^-1 (scene - t) + anchor.
        let (ix, iy) = (1.0 / r.scale_x, 1.0 / r.scale_y);
        let (a, b) = (cos * ix, sin * ix);
        let (d, e) = (-sin * iy, cos * iy);
        let c = anchor.x - a * r.x - b * r.y;
        let f = anchor.y - d * r.x - e * r.y;
        [
            a / self.width,
            b / self.width,
            c / self.width,
            d / self.height,
            e / self.height,
            f / self.height,
        ]
    }
}

/// The path paint for an authored paint, or `None` for no paint. A gradient
/// that cannot be drawn as authored is refused by the contract's own rule
/// (invariant 27), as the validator refuses it.
pub(crate) fn path_paint(
    object: &str,
    paint_name: &str,
    color: Option<&ColorValue>,
    frame: &ObjectFrame,
) -> Result<Option<PathPaint>, Refusal> {
    let solid = |c| WorkingRgba::from_source(c, WorkingColorSpace::LinearSrgb);
    let value = match color {
        None | Some(ColorValue::None) => return Ok(None),
        // Linear here; `PreparedPaths::prepare` expresses every paint in the
        // scene's working space once its paths are built.
        Some(ColorValue::Solid { color }) => return Ok(Some(PathPaint::Solid(solid(*color)))),
        Some(value) => value,
    };
    if let Some(detail) = value.gradient_problem((frame.width, frame.height)) {
        return Err(Refusal::GradientNotDrawable {
            object: object.into(),
            paint: paint_name.into(),
            detail,
        });
    }
    if !value.paints() {
        return Ok(None);
    }
    let m = frame.scene_to_box();
    let (radial, rows, spread) = match value {
        ColorValue::LinearGradient {
            start_x,
            start_y,
            end_x,
            end_y,
            spread,
            ..
        } => {
            // u = ((g - p0) . d) / |d|^2, affine in g and so in the scene.
            let (dx, dy) = (end_x - start_x, end_y - start_y);
            let k = 1.0 / (dx * dx + dy * dy);
            let (gx, gy) = (dx * k, dy * k);
            let u = [
                gx * m[0] + gy * m[3],
                gx * m[1] + gy * m[4],
                gx * m[2] + gy * m[5] - (start_x * gx + start_y * gy),
            ];
            (false, [u[0], u[1], u[2], 0.0, 0.0, 0.0], *spread)
        }
        ColorValue::RadialGradient {
            center_x,
            center_y,
            radius_x,
            radius_y,
            spread,
            ..
        } => {
            // (u, v) = (g - c) / r, so t = |(u, v)|.
            let rows = [
                m[0] / radius_x,
                m[1] / radius_x,
                (m[2] - center_x) / radius_x,
                m[3] / radius_y,
                m[4] / radius_y,
                (m[5] - center_y) / radius_y,
            ];
            (true, rows, *spread)
        }
        ColorValue::None | ColorValue::Solid { .. } => unreachable!("handled above"),
    };
    let stops = value
        .stops()
        .iter()
        .map(|stop| (stop.position as f32, solid(stop.color)))
        .collect();
    Ok(Some(PathPaint::Gradient(Box::new(PathGradient {
        radial,
        rows,
        spread,
        stops,
    }))))
}

impl PathGradient {
    /// The rows re-expressed for pixel `(i, j)` of a coverage window whose
    /// first pixel is at scene point `window_origin`, sampled at the pixel
    /// centre `(i + 0.5, j + 0.5)`; f32, as both backends evaluate them.
    pub(crate) fn window_rows(&self, window_origin: [f64; 2]) -> [f32; 6] {
        let r = &self.rows;
        let shift = |a: f64, b: f64, c: f64| c + a * window_origin[0] + b * window_origin[1];
        [
            r[0] as f32,
            r[1] as f32,
            shift(r[0], r[1], r[2]) as f32,
            r[3] as f32,
            r[4] as f32,
            shift(r[3], r[4], r[5]) as f32,
        ]
    }

    /// The colour at window pixel `(i, j)` for `rows` from
    /// [`Self::window_rows`]. The WGSL twin performs the same operations in
    /// the same order.
    pub(crate) fn colour(&self, rows: &[f32; 6], i: u32, j: u32) -> WorkingRgba {
        let (x, y) = (i as f32 + 0.5, j as f32 + 0.5);
        let u = rows[0] * x + rows[1] * y + rows[2];
        let t = if self.radial {
            let v = rows[3] * x + rows[4] * y + rows[5];
            (u * u + v * v).sqrt()
        } else {
            u
        };
        let t = spread(self.spread, t);
        let stops = &self.stops;
        let last = stops.len() - 1;
        // A NaN parameter takes the first stop, as in WGSL.
        if t.partial_cmp(&stops[0].0) != Some(std::cmp::Ordering::Greater) {
            return stops[0].1;
        }
        if t >= stops[last].0 {
            return stops[last].1;
        }
        for k in 0..last {
            let (p0, c0) = stops[k];
            let (p1, c1) = stops[k + 1];
            if t < p1 {
                let span = p1 - p0;
                let w = if span > 0.0 { (t - p0) / span } else { 0.0 };
                return c0.mix(c1, w);
            }
        }
        stops[last].1
    }
}

/// The spread rule: what a gradient does outside 0 to 1.
pub(crate) fn spread(mode: GradientSpread, t: f32) -> f32 {
    match mode {
        GradientSpread::Pad => t,
        GradientSpread::Repeat => t - t.floor(),
        GradientSpread::Reflect => {
            let m = t - 2.0 * (t * 0.5).floor();
            if m > 1.0 {
                2.0 - m
            } else {
                m
            }
        }
    }
}
