//! Variable mask feather (plan row 11.108; Masking spec v2, 4.4 and 4.6): the edge of a mask softens by a different amount along its length.
//!
//! The mask's path is flattened in the layer's own pixels. For a pixel, the nearest point of that polyline gives the signed distance `d`
//! (positive inside, by the non-zero winding rule, as the fill is drawn) and the arc length `s` along the path where it lies. The feather
//! points sit at arc lengths on the closed contour, each with a signed radius (outside positive, inside negative) and a tension, and the
//! radius at `s` is blended from its two neighbours around the contour, by distance ALONG the contour and not in a straight line:
//!
//! ```text
//! d' = d + expansion
//! R_out = max(r, 0)   R_in = max(-r, 0)
//! u = clamp((d' + R_out) / (R_in + R_out), 0, 1)          C = u (linear) or u^2 (3 - 2u) (smooth)
//! ```
//!
//! With no width (`R_in + R_out` under 1/10000 pixel) the edge is a hard antialiased one, `clamp(d' + 0.5, 0, 1)`. This is a GrapiX
//! baseline built from the spec's formula, not After Effects' own profile (the spec says to match reference renders before claiming
//! parity). The GPU kernel (`compositor/mask.wgsl`, `variable`) runs the same steps in the same order on the same packed data.

use gx_contracts::scene::{Mask, MaskFalloff};
use gx_contracts::Refusal;

/// The most flattened segments a mask path may have; a path with more refuses by name, so the per-pixel work is bounded.
pub const MOST_FLAT_SEGMENTS: usize = 4096;

/// A width under this is a hard edge.
const NO_WIDTH: f32 = 1e-4;

/// A mask's variable feather, prepared in layer pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct VariableFeather {
    /// Flattened path: `x0, y0, x1, y1` and the arc length at `x0, y0`.
    pub segments: Vec<[f32; 5]>,
    /// The closed contour's length.
    pub total: f32,
    /// The feather points by arc length: `arc, radius, tension`.
    pub points: Vec<[f32; 3]>,
    pub expansion: f32,
    /// Smoothstep falloff when true (the default), linear when false.
    pub smooth: bool,
}

fn smoothstep(w: f32) -> f32 {
    w * w * (3.0 - 2.0 * w)
}

impl VariableFeather {
    /// The radius at arc length `s`: blended from the neighbouring points around the closed contour.
    pub fn radius_at(&self, s: f32) -> f32 {
        let n = self.points.len();
        if n == 1 {
            return self.points[0][1];
        }
        // The last point at or before `s`; before the first, the last one, a turn earlier.
        let j = self.points.iter().rposition(|p| p[0] <= s).unwrap_or(n - 1);
        let next = (j + 1) % n;
        let a0 = if self.points[j][0] <= s { self.points[j][0] } else { self.points[j][0] - self.total };
        let a1 = if next > j { self.points[next][0] } else { self.points[next][0] + self.total };
        let span = a1 - a0;
        let w = if span > 1e-9 { ((s - a0) / span).clamp(0.0, 1.0) } else { 0.0 };
        let tension = self.points[j][2];
        let blended = w + (smoothstep(w) - w) * tension;
        self.points[j][1] + (self.points[next][1] - self.points[j][1]) * blended
    }

    /// The mask coverage at the point `(px, py)` of the layer, 0 to 1.
    pub fn coverage_at(&self, px: f32, py: f32) -> f32 {
        let mut best = f32::INFINITY;
        let mut arc = 0.0_f32;
        let mut winding = 0_i32;
        for seg in &self.segments {
            let (x0, y0, x1, y1) = (seg[0], seg[1], seg[2], seg[3]);
            let (ex, ey) = (x1 - x0, y1 - y0);
            let len2 = ex * ex + ey * ey;
            let u = if len2 > 0.0 { (((px - x0) * ex + (py - y0) * ey) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let (dx, dy) = (px - (x0 + ex * u), py - (y0 + ey * u));
            let d2 = dx * dx + dy * dy;
            if d2 < best {
                best = d2;
                arc = seg[4] + u * len2.sqrt();
            }
            let cross = ex * (py - y0) - ey * (px - x0);
            if y0 <= py {
                if y1 > py && cross > 0.0 {
                    winding += 1;
                }
            } else if y1 <= py && cross < 0.0 {
                winding -= 1;
            }
        }
        let distance = best.sqrt();
        let signed = if winding != 0 { distance } else { -distance } + self.expansion;
        let r = self.radius_at(arc);
        let (r_out, r_in) = (r.max(0.0), (-r).max(0.0));
        let width = r_in + r_out;
        if width < NO_WIDTH {
            return (signed + 0.5).clamp(0.0, 1.0);
        }
        let u = ((signed + r_out) / width).clamp(0.0, 1.0);
        if self.smooth {
            smoothstep(u)
        } else {
            u
        }
    }

    /// Pack for the GPU: a header, the segments, then the points (see `mask.wgsl`).
    /// `[segment count, point count, total, expansion, smooth, window origin x, y, 0]`, then `segments * 5`, then `points * 3`.
    pub fn pack(&self, origin: [f64; 2]) -> Vec<f32> {
        let mut out = vec![
            self.segments.len() as f32,
            self.points.len() as f32,
            self.total,
            self.expansion,
            if self.smooth { 1.0 } else { 0.0 },
            origin[0] as f32,
            origin[1] as f32,
            0.0,
        ];
        out.extend(self.segments.iter().flatten());
        out.extend(self.points.iter().flatten());
        out
    }
}

/// The variable feather of `mask`, its path placed by `map` into the layer's pixels; `None` when the mask has no feather points.
pub(crate) fn prepare(
    object: &str,
    mask: &Mask,
    map: &dyn Fn(f64, f64) -> Result<lyon::math::Point, Refusal>,
) -> Result<Option<VariableFeather>, Refusal> {
    let Some(points) = mask.feather_points.as_ref().filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let path = &mask.path;
    let n = path.vertices.len();
    let place = |x: f64, y: f64| -> Result<(f64, f64), Refusal> {
        let p = map(x, y)?;
        Ok((f64::from(p.x), f64::from(p.y)))
    };
    // The cubic of each segment, in layer pixels.
    let mut cubics: Vec<[(f64, f64); 4]> = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = (path.vertices[i], path.vertices[(i + 1) % n]);
        let (o, ii) = (path.out_tangents[i], path.in_tangents[(i + 1) % n]);
        cubics.push([place(a.x, a.y)?, place(a.x + o.x, a.y + o.y)?, place(b.x + ii.x, b.y + ii.y)?, place(b.x, b.y)?]);
    }
    let at = |c: &[(f64, f64); 4], t: f64| -> (f64, f64) {
        let u = 1.0 - t;
        let (b0, b1, b2, b3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
        (
            b0 * c[0].0 + b1 * c[1].0 + b2 * c[2].0 + b3 * c[3].0,
            b0 * c[0].1 + b1 * c[1].1 + b2 * c[2].1 + b3 * c[3].1,
        )
    };
    let hull = |c: &[(f64, f64); 4]| -> f64 { (0..3).map(|k| ((c[k + 1].0 - c[k].0).powi(2) + (c[k + 1].1 - c[k].1).powi(2)).sqrt()).sum() };
    let pieces = |c: &[(f64, f64); 4]| -> usize { ((hull(c) / 2.0).ceil() as usize).clamp(4, 96) };
    // The polyline length of one segment from 0 to `t`, split the same way the segment is flattened.
    let length_to = |c: &[(f64, f64); 4], t: f64| -> f64 {
        let k = pieces(c);
        let mut length = 0.0;
        let mut previous = at(c, 0.0);
        let whole = (k as f64 * t).floor() as usize;
        for step in 1..=whole {
            let p = at(c, step as f64 / k as f64);
            length += ((p.0 - previous.0).powi(2) + (p.1 - previous.1).powi(2)).sqrt();
            previous = p;
        }
        let end = at(c, t);
        length + ((end.0 - previous.0).powi(2) + (end.1 - previous.1).powi(2)).sqrt()
    };
    let mut segments: Vec<[f32; 5]> = Vec::new();
    let mut starts: Vec<f64> = Vec::with_capacity(n);
    let mut arc = 0.0_f64;
    for c in &cubics {
        starts.push(arc);
        let k = pieces(c);
        let mut previous = at(c, 0.0);
        for step in 1..=k {
            let p = at(c, step as f64 / k as f64);
            let length = ((p.0 - previous.0).powi(2) + (p.1 - previous.1).powi(2)).sqrt();
            segments.push([previous.0 as f32, previous.1 as f32, p.0 as f32, p.1 as f32, arc as f32]);
            arc += length;
            previous = p;
        }
        if segments.len() > MOST_FLAT_SEGMENTS {
            return Err(Refusal::VectorTessellationFailed {
                object: object.into(),
                detail: format!("a mask path with a variable feather flattens to more than {MOST_FLAT_SEGMENTS} segments"),
            });
        }
    }
    if arc < 1e-6 {
        return Ok(None);
    }
    let mut placed: Vec<[f32; 3]> = points
        .iter()
        .map(|p| {
            let i = (p.segment as usize).min(n - 1);
            [(starts[i] + length_to(&cubics[i], p.t)) as f32, p.radius as f32, p.tension as f32]
        })
        .collect();
    placed.sort_by(|a, b| a[0].total_cmp(&b[0]));
    Ok(Some(VariableFeather {
        segments,
        total: arc as f32,
        points: placed,
        expansion: mask.expansion as f32,
        smooth: mask.falloff.unwrap_or_default() == MaskFalloff::Smooth,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A square 100 wide from (0,0) to (100,100), as a flattened contour, with `points` on it.
    fn square(points: Vec<[f32; 3]>, expansion: f32, smooth: bool) -> VariableFeather {
        let corners = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)];
        let mut segments = Vec::new();
        for i in 0..4 {
            let (a, b) = (corners[i], corners[(i + 1) % 4]);
            segments.push([a.0, a.1, b.0, b.1, 100.0 * i as f32]);
        }
        VariableFeather { segments, total: 400.0, points, expansion, smooth }
    }

    #[test]
    fn a_uniform_radius_is_a_transition_the_spec_describes_on_each_side() {
        // Radius +10 (outward): the edge is the 100% line and it fades over the 10 pixels outside.
        let outward = square(vec![[0.0, 10.0, 0.0]], 0.0, false);
        let near = |x: f32| outward.coverage_at(x, 50.0);
        assert!((near(0.0) - 1.0).abs() < 1e-6, "at the edge: {}", near(0.0));
        assert!((near(-5.0) - 0.5).abs() < 1e-6, "halfway out: {}", near(-5.0));
        assert!(near(-10.0).abs() < 1e-6 && near(-20.0) == 0.0);
        assert_eq!(near(50.0), 1.0);
        // Radius -10 (inward): the fade is inside, 0 at the edge and 1 ten pixels in.
        let inward = square(vec![[0.0, -10.0, 0.0]], 0.0, false);
        assert!(inward.coverage_at(0.0, 50.0).abs() < 1e-6 && (inward.coverage_at(5.0, 50.0) - 0.5).abs() < 1e-6);
        assert_eq!(inward.coverage_at(-3.0, 50.0), 0.0);
        // A smooth falloff is the smoothstep of the linear one.
        let smooth = square(vec![[0.0, 10.0, 0.0]], 0.0, true);
        assert!((smooth.coverage_at(-7.5, 50.0) - 0.15625).abs() < 1e-6);
        // Expansion moves the edge: +4 puts the 100% line 4 pixels out.
        let grown = square(vec![[0.0, 10.0, 0.0]], 4.0, false);
        assert!((grown.coverage_at(-4.0, 50.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn no_width_is_a_hard_antialiased_edge() {
        let hard = square(vec![[0.0, 0.0, 0.0]], 0.0, true);
        assert_eq!(hard.coverage_at(50.0, 50.0), 1.0);
        assert_eq!(hard.coverage_at(-2.0, 50.0), 0.0);
        assert!((hard.coverage_at(0.0, 50.0) - 0.5).abs() < 1e-6, "half a pixel either way: the edge is one pixel wide");
    }

    #[test]
    fn the_radius_follows_the_contour_by_arc_length_and_wraps_round() {
        // Two points on a 400 contour: radius 0 at arc 0 and 20 at arc 200, linear between.
        let v = square(vec![[0.0, 0.0, 0.0], [200.0, 20.0, 0.0]], 0.0, false);
        assert_eq!(v.radius_at(0.0), 0.0);
        assert!((v.radius_at(100.0) - 10.0).abs() < 1e-5);
        assert!((v.radius_at(200.0) - 20.0).abs() < 1e-5);
        // Back down round the end of the contour: halfway from 200 to the first point again (arc 400) is 10.
        assert!((v.radius_at(300.0) - 10.0).abs() < 1e-5);
        assert!((v.radius_at(399.0) - 0.1).abs() < 1e-3);
        // Tension 1 on the first point eases the blend toward the next (smoothstep at a quarter is 0.15625 of the way).
        let eased = square(vec![[0.0, 0.0, 1.0], [200.0, 20.0, 0.0]], 0.0, false);
        assert!((eased.radius_at(50.0) - 20.0 * 0.15625).abs() < 1e-4);
        // Points given out of order are the caller's to sort; one point is constant everywhere.
        assert_eq!(square(vec![[123.0, 7.0, 1.0]], 0.0, false).radius_at(300.0), 7.0);
    }

    #[test]
    fn the_feather_differs_along_the_edge() {
        // Wide on the right side (arc 150, radius 30), none on the left (arc 350, radius 0).
        let v = square(vec![[150.0, 30.0, 0.0], [350.0, 0.0, 0.0]], 0.0, false);
        let right = v.coverage_at(115.0, 50.0);
        let left = v.coverage_at(-15.0, 50.0);
        assert!(right > 0.4 && right < 0.6, "15 pixels out where the radius is 30: {right}");
        assert_eq!(left, 0.0, "15 pixels out where the radius is 0");
    }
}
