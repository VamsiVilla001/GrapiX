//! Path geometry for the Pen family (plan row 11.107; the Advanced Pen Tool
//! spec, sections 4 to 6 and 8): the one authority for what an edit of a
//! [`BezierPath`] does.
//!
//! Everything works on the contract's own path — vertices, and in and out
//! handles that are OFFSETS from their vertex — so there is no second path
//! model. The Editor's `path-geometry.ts` is the same maths for the pointer's
//! sake; a shared fixture (`fixtures/path-geometry.json`) holds this module's
//! answers and the TypeScript tests must give the same ones.
//!
//! - segment `i` runs from vertex `i` to vertex `i + 1` (the last one of a
//!   closed path, back to vertex 0);
//! - its cubic is `P0 = v[i]`, `P1 = P0 + out[i]`, `P2 = P3 + in[i+1]`,
//!   `P3 = v[i+1]`;
//! - a split is De Casteljau's, so the curve before and after is the same;
//! - the nearest point is found from the roots of `(B(t) - Q) . B'(t)`, a
//!   degree 5 polynomial, by halving its Bernstein form until each piece has
//!   at most one sign change, then bisecting: no fixed sampling.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::scene::{BezierPath, VertexKind, Vec2};

/// The four control points of one cubic segment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cubic {
    pub p0: Vec2,
    pub p1: Vec2,
    pub p2: Vec2,
    pub p3: Vec2,
}

/// A handle shorter than this is no handle.
pub const NO_HANDLE: f64 = 1e-6;
/// A split this close to a vertex is that vertex.
pub const SPLIT_MARGIN: f64 = 1e-6;

pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

fn add(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 {
        x: a.x + b.x,
        y: a.y + b.y,
    }
}
fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}
fn scale(a: Vec2, k: f64) -> Vec2 {
    Vec2 {
        x: a.x * k,
        y: a.y * k,
    }
}
fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    Vec2 {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    }
}
fn dot(a: Vec2, b: Vec2) -> f64 {
    a.x * b.x + a.y * b.y
}
fn length(a: Vec2) -> f64 {
    a.x.hypot(a.y)
}

/// Why a path edit could not be done, as a sentence for the author.
pub type Why = &'static str;

// ---------------------------------------------------------------------------
// Vertex ids and kinds (11.112, 11.113)
// ---------------------------------------------------------------------------

/// The tension of `auto` vertices when the path names none.
pub const AUTO_TENSION: f64 = 0.5;

/// The id of every vertex: the stored ids, or the vertex index of a path that
/// has none (an old scene).
pub fn ids_of(path: &BezierPath) -> Vec<u32> {
    match &path.vertex_ids {
        Some(ids) if ids.len() == path.vertices.len() => ids.clone(),
        _ => (0..path.vertices.len() as u32).collect(),
    }
}

/// The kind of every vertex: the stored kinds, or each vertex's kind inferred
/// from its handles (smooth when both are there, in line and opposite).
pub fn kinds_of(path: &BezierPath) -> Vec<VertexKind> {
    match &path.vertex_kinds {
        Some(kinds) if kinds.len() == path.vertices.len() => kinds.clone(),
        _ => (0..path.vertices.len())
            .map(|i| if is_smooth(path, i) { VertexKind::Smooth } else { VertexKind::Corner })
            .collect(),
    }
}

/// The path with an id on every vertex (the vertex index where it had none).
pub fn with_ids(path: &BezierPath) -> BezierPath {
    let mut next = path.clone();
    next.vertex_ids = Some(ids_of(path));
    next
}

/// An id no vertex of `path` has.
pub fn fresh_id(path: &BezierPath) -> u32 {
    ids_of(path).into_iter().max().map_or(0, |m| m + 1)
}

/// Whether two paths have the same topology: open or closed alike and the same
/// vertex ids in the same order. Only such paths interpolate (11.112).
pub fn same_topology(a: &BezierPath, b: &BezierPath) -> bool {
    a.closed == b.closed && a.vertices.len() == b.vertices.len() && ids_of(a) == ids_of(b)
}

/// The handles an `auto` vertex gets from its neighbours (11.113): a centripetal
/// Catmull-Rom tangent, so uneven spacing does not overshoot, with `tension` 0.5
/// the plain spline (twice the tension scales the handles). The two ends of an
/// open path point a third of the way (scaled the same) to their one neighbour.
/// This one function is every consumer's: render preparation, bounds, hit tests
/// and export all read paths through [`effective`].
pub fn derive_auto_handles(path: &BezierPath, index: usize) -> (Vec2, Vec2) {
    let n = path.vertices.len();
    let tension = path.auto_tension.unwrap_or(AUTO_TENSION).clamp(0.0, 1.0);
    let s = tension * 2.0;
    let here = path.vertices[index];
    let prev = if index > 0 {
        Some(path.vertices[index - 1])
    } else if path.closed && n > 2 {
        Some(path.vertices[n - 1])
    } else {
        None
    };
    let next = if index + 1 < n {
        Some(path.vertices[index + 1])
    } else if path.closed && n > 2 {
        Some(path.vertices[0])
    } else {
        None
    };
    let toward = |p: Vec2| scale(sub(p, here), s / 3.0);
    match (prev, next) {
        (Some(p0), Some(p2)) => {
            let d0 = length(sub(here, p0)).sqrt();
            let d1 = length(sub(p2, here)).sqrt();
            if d0 < 1e-9 || d1 < 1e-9 {
                // A neighbour on top of the vertex has no direction: lean on the other one.
                let out = if d1 >= 1e-9 { toward(p2) } else { ZERO };
                let inn = if d0 >= 1e-9 { toward(p0) } else { ZERO };
                return (inn, out);
            }
            let span = d0 + d1;
            let a = scale(sub(here, p0), 1.0 / d0);
            let b = scale(sub(p2, p0), 1.0 / span);
            let c = scale(sub(p2, here), 1.0 / d1);
            // dP/dt at the vertex of the curve through p0, here, p2, in each segment's own unit parameter.
            let m_out = scale(add(sub(a, b), c), d1);
            let m_in = scale(add(sub(a, b), c), d0);
            (scale(m_in, -s / 3.0), scale(m_out, s / 3.0))
        }
        (None, Some(p2)) => (ZERO, toward(p2)),
        (Some(p0), None) => (toward(p0), ZERO),
        (None, None) => (ZERO, ZERO),
    }
}

/// The path as drawn: the handles of every `auto` vertex derived from its
/// neighbours, everything else as stored. A path with no `auto` vertex is
/// returned as it is.
pub fn effective(path: &BezierPath) -> BezierPath {
    let Some(kinds) = &path.vertex_kinds else {
        return path.clone();
    };
    if kinds.len() != path.vertices.len() || !kinds.contains(&VertexKind::Auto) {
        return path.clone();
    }
    let mut next = path.clone();
    for (i, kind) in kinds.iter().enumerate() {
        if *kind == VertexKind::Auto {
            let (inn, out) = derive_auto_handles(path, i);
            next.in_tangents[i] = inn;
            next.out_tangents[i] = out;
        }
    }
    next
}

/// [`effective`] without a copy when no vertex is `auto`.
pub fn effective_cow(path: &BezierPath) -> std::borrow::Cow<'_, BezierPath> {
    if has_auto(path) {
        std::borrow::Cow::Owned(effective(path))
    } else {
        std::borrow::Cow::Borrowed(path)
    }
}

/// Whether any vertex of the path is `auto`.
pub fn has_auto(path: &BezierPath) -> bool {
    path.vertex_kinds
        .as_ref()
        .is_some_and(|kinds| kinds.contains(&VertexKind::Auto))
}

/// The `auto` vertices among `indices` written out as smooth ones with the
/// handles they have now, so an edit that reads or moves those handles starts
/// from the curve the author sees and a hand edit is never lost to
/// re-derivation (11.113). The other `auto` vertices stay `auto`.
pub fn materialise_at(path: &BezierPath, indices: &[usize]) -> BezierPath {
    let Some(kinds) = &path.vertex_kinds else {
        return path.clone();
    };
    let mut next = path.clone();
    let mut kinds = kinds.clone();
    if kinds.len() != path.vertices.len() {
        return next;
    }
    for &i in indices {
        if i < kinds.len() && kinds[i] == VertexKind::Auto {
            let (inn, out) = derive_auto_handles(path, i);
            next.in_tangents[i] = inn;
            next.out_tangents[i] = out;
            kinds[i] = VertexKind::Smooth;
        }
    }
    next.vertex_kinds = Some(kinds);
    next
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/// How many segments a path has.
pub fn segment_count(path: &BezierPath) -> usize {
    let n = path.vertices.len();
    if n < 2 {
        0
    } else if path.closed {
        n
    } else {
        n - 1
    }
}

/// The cubic of segment `index`.
pub fn cubic_of(path: &BezierPath, index: usize) -> Cubic {
    let n = path.vertices.len();
    let a = index % n;
    let b = (index + 1) % n;
    let p0 = path.vertices[a];
    let p3 = path.vertices[b];
    Cubic {
        p0,
        p1: add(p0, path.out_tangents[a]),
        p2: add(p3, path.in_tangents[b]),
        p3,
    }
}

/// Every segment of a path as a cubic.
pub fn cubics_of(path: &BezierPath) -> Vec<Cubic> {
    let path = &*effective_cow(path);
    (0..segment_count(path))
        .map(|i| cubic_of(path, i))
        .collect()
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/// The point of the curve at `t`.
pub fn point_at(c: &Cubic, t: f64) -> Vec2 {
    let u = 1.0 - t;
    let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    Vec2 {
        x: w0 * c.p0.x + w1 * c.p1.x + w2 * c.p2.x + w3 * c.p3.x,
        y: w0 * c.p0.y + w1 * c.p1.y + w2 * c.p2.y + w3 * c.p3.y,
    }
}

/// The first derivative.
pub fn derivative_at(c: &Cubic, t: f64) -> Vec2 {
    let u = 1.0 - t;
    add(
        add(
            scale(sub(c.p1, c.p0), 3.0 * u * u),
            scale(sub(c.p2, c.p1), 6.0 * u * t),
        ),
        scale(sub(c.p3, c.p2), 3.0 * t * t),
    )
}

/// The second derivative.
pub fn second_derivative_at(c: &Cubic, t: f64) -> Vec2 {
    let u = 1.0 - t;
    add(
        scale(add(sub(c.p2, scale(c.p1, 2.0)), c.p0), 6.0 * u),
        scale(add(sub(c.p3, scale(c.p2, 2.0)), c.p1), 6.0 * t),
    )
}

/// The unit tangent at `t`; `None` only for a curve that is a single point.
pub fn tangent_at(c: &Cubic, t: f64) -> Option<Vec2> {
    let unit = |v: Vec2| {
        let l = length(v);
        (l > 1e-12).then(|| scale(v, 1.0 / l))
    };
    if let Some(here) = unit(derivative_at(c, t)) {
        return Some(here);
    }
    for nudge in [1e-4, 1e-3, 1e-2] {
        for s in [t + nudge, t - nudge] {
            if !(0.0..=1.0).contains(&s) {
                continue;
            }
            if let Some(found) = unit(derivative_at(c, s)) {
                return Some(found);
            }
        }
    }
    unit(sub(c.p3, c.p0))
}

/// The signed curvature at `t`; 0 where the speed is nil.
pub fn curvature_at(c: &Cubic, t: f64) -> f64 {
    let d1 = derivative_at(c, t);
    let d2 = second_derivative_at(c, t);
    let speed = length(d1);
    if speed < 1e-12 {
        return 0.0;
    }
    (d1.x * d2.y - d1.y * d2.x) / (speed * speed * speed)
}

/// The curve cut at `t`: both halves.
pub fn split_cubic(c: &Cubic, t: f64) -> (Cubic, Cubic) {
    let a = lerp(c.p0, c.p1, t);
    let b = lerp(c.p1, c.p2, t);
    let cc = lerp(c.p2, c.p3, t);
    let d = lerp(a, b, t);
    let e = lerp(b, cc, t);
    let m = lerp(d, e, t);
    (
        Cubic {
            p0: c.p0,
            p1: a,
            p2: d,
            p3: m,
        },
        Cubic {
            p0: m,
            p1: e,
            p2: cc,
            p3: c.p3,
        },
    )
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

fn derivative_roots(p0: f64, p1: f64, p2: f64, p3: f64, out: &mut Vec<f64>) {
    let (d0, d1, d2) = (p1 - p0, p2 - p1, p3 - p2);
    let a = d0 - 2.0 * d1 + d2;
    let b = 2.0 * (d1 - d0);
    let k = d0;
    let mut keep = |t: f64| {
        if t > 0.0 && t < 1.0 {
            out.push(t);
        }
    };
    if a.abs() < 1e-14 {
        if b.abs() > 1e-14 {
            keep(-k / b);
        }
        return;
    }
    let disc = b * b - 4.0 * a * k;
    if disc < 0.0 {
        return;
    }
    let root = disc.sqrt();
    keep((-b + root) / (2.0 * a));
    keep((-b - root) / (2.0 * a));
}

/// `(min_x, min_y, max_x, max_y)`.
pub type Bounds = (f64, f64, f64, f64);

/// The exact bounds of one cubic.
pub fn cubic_bounds(c: &Cubic) -> Bounds {
    let mut ts = vec![0.0, 1.0];
    derivative_roots(c.p0.x, c.p1.x, c.p2.x, c.p3.x, &mut ts);
    derivative_roots(c.p0.y, c.p1.y, c.p2.y, c.p3.y, &mut ts);
    let mut b = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for t in ts {
        let p = point_at(c, t);
        b = (b.0.min(p.x), b.1.min(p.y), b.2.max(p.x), b.3.max(p.y));
    }
    b
}

/// The exact bounds of the drawn path; `None` for a path with no segment.
pub fn path_bounds(path: &BezierPath) -> Option<Bounds> {
    let path = &*effective_cow(path);
    cubics_of(path)
        .iter()
        .map(cubic_bounds)
        .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)))
}

/// The box of the control polygon (vertices and the ends of their handles) of
/// the drawn path. A curve lies inside it, and so does every blend of two
/// paths of one topology, which is what makes it a safe size for a layer
/// source that must hold a path in motion (11.112).
pub fn control_bounds(path: &BezierPath) -> Option<Bounds> {
    let path = &*effective_cow(path);
    let mut b: Option<Bounds> = None;
    for (i, p) in path.vertices.iter().enumerate() {
        for q in [*p, add(*p, path.in_tangents[i]), add(*p, path.out_tangents[i])] {
            let c = b.get_or_insert((q.x, q.y, q.x, q.y));
            *c = (c.0.min(q.x), c.1.min(q.y), c.2.max(q.x), c.3.max(q.y));
        }
    }
    b
}

// ---------------------------------------------------------------------------
// Arc length
// ---------------------------------------------------------------------------

const GL_X: [f64; 4] = [
    0.183_434_642_495_649_8,
    0.525_532_409_916_329,
    0.796_666_477_413_626_7,
    0.960_289_856_497_536_3,
];
const GL_W: [f64; 4] = [
    0.362_683_783_378_362,
    0.313_706_645_877_887_3,
    0.222_381_034_453_374_5,
    0.101_228_536_290_376_3,
];

fn gauss_length(c: &Cubic, a: f64, b: f64) -> f64 {
    let half = (b - a) / 2.0;
    let mid = (b + a) / 2.0;
    let mut sum = 0.0;
    for i in 0..4 {
        sum += GL_W[i]
            * (length(derivative_at(c, mid + half * GL_X[i]))
                + length(derivative_at(c, mid - half * GL_X[i])));
    }
    sum * half
}

/// The length of the curve from `t0` to `t1`, by adaptive Gauss-Legendre.
pub fn arc_length(c: &Cubic, t0: f64, t1: f64, tolerance: f64) -> f64 {
    fn walk(c: &Cubic, a: f64, b: f64, whole: f64, depth: u32, tolerance: f64) -> f64 {
        let mid = (a + b) / 2.0;
        let left = gauss_length(c, a, mid);
        let right = gauss_length(c, mid, b);
        if depth >= 24 || (left + right - whole).abs() <= tolerance {
            return left + right;
        }
        walk(c, a, mid, left, depth + 1, tolerance) + walk(c, mid, b, right, depth + 1, tolerance)
    }
    if t1 <= t0 {
        return 0.0;
    }
    walk(c, t0, t1, gauss_length(c, t0, t1), 0, tolerance)
}

/// The length of the whole path.
pub fn path_length(path: &BezierPath, tolerance: f64) -> f64 {
    let path = &*effective_cow(path);
    cubics_of(path)
        .iter()
        .map(|c| arc_length(c, 0.0, 1.0, tolerance))
        .sum()
}

// ---------------------------------------------------------------------------
// Nearest point
// ---------------------------------------------------------------------------

/// The nearest point of a curve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Nearest {
    pub t: f64,
    pub point: Vec2,
    pub distance: f64,
}

fn stationary_coefficients(c: &Cubic, q: Vec2) -> [f64; 6] {
    let a = [sub(c.p0, q), sub(c.p1, q), sub(c.p2, q), sub(c.p3, q)];
    let d = [
        scale(sub(c.p1, c.p0), 3.0),
        scale(sub(c.p2, c.p1), 3.0),
        scale(sub(c.p3, c.p2), 3.0),
    ];
    let choose3 = [1.0, 3.0, 3.0, 1.0];
    let choose2 = [1.0, 2.0, 1.0];
    let choose5 = [1.0, 5.0, 10.0, 10.0, 5.0, 1.0];
    let mut out = [0.0; 6];
    for i in 0..4 {
        for j in 0..3 {
            out[i + j] += choose3[i] * choose2[j] * dot(a[i], d[j]) / choose5[i + j];
        }
    }
    out
}

fn sign_changes(values: &[f64]) -> usize {
    let mut count = 0;
    let mut last = 0i8;
    for &v in values {
        let s = if v > 0.0 {
            1
        } else if v < 0.0 {
            -1
        } else {
            0
        };
        if s == 0 {
            continue;
        }
        if last != 0 && s != last {
            count += 1;
        }
        last = s;
    }
    count
}

fn halve(values: &[f64; 6]) -> ([f64; 6], [f64; 6]) {
    let mut left = [0.0; 6];
    let mut right = [0.0; 6];
    let mut row = values.to_vec();
    let mut k = 0;
    while !row.is_empty() {
        left[k] = row[0];
        right[5 - k] = row[row.len() - 1];
        row = row.windows(2).map(|w| (w[0] + w[1]) / 2.0).collect();
        k += 1;
    }
    (left, right)
}

fn stationary_parameters(c: &Cubic, q: Vec2) -> Vec<f64> {
    /// The one sign change inside `[lo, hi]`, by bisection. The signs just
    /// inside the ends come from the end coefficients (the first and last
    /// that are not zero), so an end that is itself a root (a cusp, or a
    /// symmetric curve, at a halving point) does not hide the root inside.
    fn refine(c: &Cubic, q: Vec2, coeffs: &[f64; 6], lo: f64, hi: f64, roots: &mut Vec<f64>) {
        let f = |t: f64| dot(sub(point_at(c, t), q), derivative_at(c, t));
        let Some(start) = coeffs.iter().copied().find(|v| *v != 0.0) else {
            return;
        };
        let start = start.signum();
        let (mut a, mut b) = (lo, hi);
        for _ in 0..60 {
            let mid = (a + b) / 2.0;
            let fm = f(mid);
            if fm == 0.0 {
                return roots.push(mid);
            }
            if fm.signum() == start {
                a = mid;
            } else {
                b = mid;
            }
        }
        roots.push((a + b) / 2.0);
    }
    fn walk(
        c: &Cubic,
        q: Vec2,
        coeffs: [f64; 6],
        lo: f64,
        hi: f64,
        depth: u32,
        roots: &mut Vec<f64>,
    ) {
        // The ends are always candidates (a root exactly on a halving point).
        roots.push(lo);
        roots.push(hi);
        let changes = sign_changes(&coeffs);
        if changes == 0 {
            return;
        }
        if changes == 1 {
            refine(c, q, &coeffs, lo, hi, roots);
            return;
        }
        if depth >= 40 || hi - lo < 1e-12 {
            roots.push((lo + hi) / 2.0);
            return;
        }
        let (left, right) = halve(&coeffs);
        let mid = (lo + hi) / 2.0;
        walk(c, q, left, lo, mid, depth + 1, roots);
        walk(c, q, right, mid, hi, depth + 1, roots);
    }
    let mut roots = Vec::new();
    walk(c, q, stationary_coefficients(c, q), 0.0, 1.0, 0, &mut roots);
    roots
}

/// The point of the curve nearest `q`: the global minimum, also for a loop.
pub fn nearest_on_cubic(c: &Cubic, q: Vec2) -> Nearest {
    let mut best: Option<Nearest> = None;
    for t in [0.0, 1.0].into_iter().chain(stationary_parameters(c, q)) {
        let point = point_at(c, t);
        let distance = length(sub(point, q));
        if best.is_none_or(|b| distance < b.distance) {
            best = Some(Nearest { t, point, distance });
        }
    }
    best.expect("two end points are always compared")
}

/// The nearest point of a path over all its segments, with its segment.
pub fn nearest_on_path(path: &BezierPath, q: Vec2) -> Option<(usize, Nearest)> {
    let path = &*effective_cow(path);
    let mut best: Option<(usize, Nearest)> = None;
    for (segment, c) in cubics_of(path).iter().enumerate() {
        let found = nearest_on_cubic(c, q);
        if best.is_none_or(|(_, b)| found.distance < b.distance) {
            best = Some((segment, found));
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/// How the far handle follows the one being set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coupling {
    None,
    Smooth,
    Mirror,
}

fn finite(p: Vec2) -> bool {
    p.x.is_finite() && p.y.is_finite()
}

/// A vertex put on segment `segment` at `t` without changing the drawn curve.
pub fn insert_vertex(path: &BezierPath, segment: usize, t: f64) -> Result<BezierPath, Why> {
    insert_vertex_with_id(path, segment, t, None)
}

/// [`insert_vertex`], the new vertex carrying `id` (when the path has ids) so every key of an animated path can give it the same one.
/// The ends of the segment, if `auto`, are written out first: the curve is split as drawn and the shape stays exactly.
pub fn insert_vertex_with_id(
    path: &BezierPath,
    segment: usize,
    t: f64,
    id: Option<u32>,
) -> Result<BezierPath, Why> {
    if segment >= segment_count(path) {
        return Err("there is no such segment");
    }
    if !t.is_finite() || t <= SPLIT_MARGIN || t >= 1.0 - SPLIT_MARGIN {
        return Err("that is a vertex already");
    }
    let n = path.vertices.len();
    let a = segment;
    let b = (segment + 1) % n;
    let path = &materialise_at(path, &[a, b]);
    if let (Some(given), Some(ids)) = (id, &path.vertex_ids) {
        if ids.contains(&given) {
            return Err("that vertex id is taken");
        }
    }
    let (left, right) = split_cubic(&cubic_of(path, segment), t);
    let middle = left.p3;
    let mut next = path.clone();
    next.out_tangents[a] = sub(left.p1, left.p0);
    next.in_tangents[b] = sub(right.p2, right.p3);
    let at = a + 1;
    let (into, outof) = (sub(left.p2, middle), sub(right.p1, middle));
    next.vertices.insert(at, middle);
    next.in_tangents.insert(at, into);
    next.out_tangents.insert(at, outof);
    if let Some(ids) = &mut next.vertex_ids {
        let new = id.unwrap_or_else(|| ids.iter().copied().max().map_or(0, |m| m + 1));
        ids.insert(at, new);
    }
    if let Some(kinds) = &mut next.vertex_kinds {
        kinds.insert(at, if length(into) > NO_HANDLE || length(outof) > NO_HANDLE { VertexKind::Smooth } else { VertexKind::Corner });
    }
    Ok(next)
}

/// Vertices taken out; the curves beside each join with the handles they had.
/// A path keeps at least two vertices (three when closed).
pub fn delete_vertices(path: &BezierPath, indices: &[usize]) -> Result<BezierPath, Why> {
    let n = path.vertices.len();
    if indices.is_empty() || indices.iter().any(|&i| i >= n) {
        return Err("there is no such vertex");
    }
    let mut drop = vec![false; n];
    for &i in indices {
        drop[i] = true;
    }
    let left = drop.iter().filter(|d| !**d).count();
    if path.closed && left < 3 {
        return Err("a closed path keeps three vertices");
    }
    if left < 2 {
        return Err("a path keeps two vertices");
    }
    fn keep<T: Copy>(list: &[T], drop: &[bool]) -> Vec<T> {
        list.iter()
            .zip(drop)
            .filter(|(_, d)| !**d)
            .map(|(p, _)| *p)
            .collect()
    }
    Ok(BezierPath {
        closed: path.closed,
        vertices: keep(&path.vertices, &drop),
        in_tangents: keep(&path.in_tangents, &drop),
        out_tangents: keep(&path.out_tangents, &drop),
        vertex_ids: path.vertex_ids.as_ref().map(|ids| keep(ids, &drop)),
        vertex_kinds: path.vertex_kinds.as_ref().map(|kinds| keep(kinds, &drop)),
        auto_tension: path.auto_tension,
    })
}

/// What fitting one cubic over the two curves beside a vertex gives (11.113): the path without that vertex, and how far the new curve
/// is from the old two (the larger of the two directed distances, in path units).
#[derive(Debug, Clone, PartialEq)]
pub struct KeepShapeFit {
    pub path: BezierPath,
    pub deviation: f64,
}

/// A direction of unit length, or `fallback`'s when `v` is too short to have one.
fn direction(v: Vec2, fallback: Vec2) -> Vec2 {
    let l = length(v);
    if l > NO_HANDLE {
        scale(v, 1.0 / l)
    } else {
        let f = length(fallback);
        if f > NO_HANDLE {
            scale(fallback, 1.0 / f)
        } else {
            ZERO
        }
    }
}

/// The vertex `index` taken out, and one cubic fitted over the two curves it joined: it keeps the end points and the directions the
/// outer handles pointed in, and chooses their lengths by least squares over points of the old curves (Schneider's fit, with the
/// chord-length parameter). `deviation` is measured, never assumed. Exact when the two curves were one curve split, within the
/// fit otherwise. The ends of an open path have only one curve, so taking one out changes nothing else.
pub fn fit_delete_vertex(path: &BezierPath, index: usize) -> Result<KeepShapeFit, Why> {
    let n = path.vertices.len();
    if index >= n {
        return Err("there is no such vertex");
    }
    let (prev, next) = ((index + n - 1) % n, (index + 1) % n);
    let path = &materialise_at(path, &[index, prev, next]);
    let without = delete_vertices(path, &[index])?;
    if !path.closed && (index == 0 || index == n - 1) {
        return Ok(KeepShapeFit { path: without, deviation: 0.0 });
    }
    let (first, second) = (cubic_of(path, prev), cubic_of(path, index));
    const PER_CURVE: usize = 24;
    let mut samples: Vec<Vec2> = Vec::with_capacity(2 * PER_CURVE + 1);
    for (c, last) in [(&first, false), (&second, true)] {
        let upto = if last { PER_CURVE } else { PER_CURVE - 1 };
        for k in 0..=upto {
            samples.push(point_at(c, k as f64 / PER_CURVE as f64));
        }
    }
    // Chord-length parameter over the samples.
    let mut t = vec![0.0; samples.len()];
    for i in 1..samples.len() {
        t[i] = t[i - 1] + length(sub(samples[i], samples[i - 1]));
    }
    let whole = t[t.len() - 1];
    if whole <= NO_HANDLE {
        return Ok(KeepShapeFit { path: without, deviation: 0.0 });
    }
    for value in &mut t {
        *value /= whole;
    }
    let (p0, p3) = (first.p0, second.p3);
    let d1 = direction(sub(first.p1, first.p0), sub(first.p3, first.p0));
    let d2 = direction(sub(second.p2, second.p3), sub(second.p0, second.p3));
    let chord = length(sub(p3, p0));
    // The two handle lengths that fit `samples` at the parameters `t` best (a 2 x 2 least squares).
    let solve = |t: &[f64]| -> Cubic {
        let (mut c11, mut c12, mut c22, mut x1, mut x2) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for (point, &t) in samples.iter().zip(t) {
            let u = 1.0 - t;
            let (b0, b1, b2, b3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            let r = sub(*point, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
            c11 += b1 * b1 * dot(d1, d1);
            c12 += b1 * b2 * dot(d1, d2);
            c22 += b2 * b2 * dot(d2, d2);
            x1 += b1 * dot(d1, r);
            x2 += b2 * dot(d2, r);
        }
        let det = c11 * c22 - c12 * c12;
        let (mut a1, mut a2) = if det.abs() > 1e-12 {
            ((x1 * c22 - x2 * c12) / det, (c11 * x2 - c12 * x1) / det)
        } else {
            (chord / 3.0, chord / 3.0)
        };
        // A handle pointing backwards, or none, is not a fit: fall back to a third of the chord.
        if !(a1 > 1e-9) || !a1.is_finite() {
            a1 = chord / 3.0;
        }
        if !(a2 > 1e-9) || !a2.is_finite() {
            a2 = chord / 3.0;
        }
        Cubic { p0, p1: add(p0, scale(d1, a1)), p2: add(p3, scale(d2, a2)), p3 }
    };
    let worst = |c: &Cubic| samples.iter().map(|p| nearest_on_cubic(c, *p).distance).fold(0.0_f64, f64::max);
    // Chord length is only a first guess at where each sample sits on the new curve: move each to its nearest point on the curve
    // just fitted and fit again, keeping the best fit seen (Schneider's reparameterisation).
    let mut fitted = solve(&t);
    let mut best = (worst(&fitted), fitted);
    for _ in 0..60 {
        let t_next: Vec<f64> = samples.iter().map(|p| nearest_on_cubic(&fitted, *p).t).collect();
        fitted = solve(&t_next);
        let w = worst(&fitted);
        let improved = best.0 - w;
        if w < best.0 {
            best = (w, fitted);
        }
        if improved.abs() < 1e-12 {
            break;
        }
    }
    let fitted = best.1;
    // How far apart the old curves and the new one are, both ways.
    let mut deviation: f64 = 0.0;
    for point in &samples {
        deviation = deviation.max(nearest_on_cubic(&fitted, *point).distance);
    }
    for k in 0..=2 * PER_CURVE {
        let point = point_at(&fitted, k as f64 / (2 * PER_CURVE) as f64);
        let near = nearest_on_cubic(&first, point).distance.min(nearest_on_cubic(&second, point).distance);
        deviation = deviation.max(near);
    }
    let mut result = without;
    let (new_prev, new_next) = (if prev > index { prev - 1 } else { prev }, if next > index { next - 1 } else { next });
    result.out_tangents[new_prev] = sub(fitted.p1, fitted.p0);
    result.in_tangents[new_next] = sub(fitted.p2, fitted.p3);
    // The fitted ends keep their directions but not necessarily equal lengths.
    if let Some(kinds) = &mut result.vertex_kinds {
        for i in [new_prev, new_next] {
            if kinds[i] == VertexKind::Symmetric {
                kinds[i] = VertexKind::Smooth;
            }
        }
    }
    Ok(KeepShapeFit { path: result, deviation })
}

/// `fit_delete_vertex`, accepted only when the new curve stays within `tolerance` of the old ones.
pub fn delete_keep_shape(path: &BezierPath, index: usize, tolerance: f64) -> Result<BezierPath, Why> {
    if !tolerance.is_finite() || tolerance < 0.0 {
        return Err("the tolerance must be a distance of zero or more");
    }
    let fit = fit_delete_vertex(path, index)?;
    if fit.deviation > tolerance {
        return Err("taking that vertex out would change the shape by more than the tolerance");
    }
    Ok(fit.path)
}

/// Whether a vertex has a handle on either side.
pub fn has_handles(path: &BezierPath, index: usize) -> bool {
    length(path.in_tangents[index]) > NO_HANDLE || length(path.out_tangents[index]) > NO_HANDLE
}

/// Whether a vertex is smooth: both handles there, in line, opposite.
pub fn is_smooth(path: &BezierPath, index: usize) -> bool {
    let a = path.in_tangents[index];
    let b = path.out_tangents[index];
    let (la, lb) = (length(a), length(b));
    if la <= NO_HANDLE || lb <= NO_HANDLE {
        return false;
    }
    let cross = (a.x * b.y - a.y * b.x) / (la * lb);
    cross.abs() < 1e-6 && dot(a, b) < 0.0
}

/// A corner made smooth, or a vertex with handles made a corner.
pub fn convert_vertex(path: &BezierPath, index: usize) -> Result<BezierPath, Why> {
    let n = path.vertices.len();
    if index >= n {
        return Err("there is no such vertex");
    }
    let path = &materialise_at(path, &[index]);
    let mut next = path.clone();
    if has_handles(path, index) {
        next.in_tangents[index] = ZERO;
        next.out_tangents[index] = ZERO;
        if let Some(kinds) = &mut next.vertex_kinds {
            kinds[index] = VertexKind::Corner;
        }
        return Ok(next);
    }
    let here = path.vertices[index];
    let prev = if index > 0 {
        Some(path.vertices[index - 1])
    } else if path.closed {
        Some(path.vertices[n - 1])
    } else {
        None
    };
    let following = if index < n - 1 {
        Some(path.vertices[index + 1])
    } else if path.closed {
        Some(path.vertices[0])
    } else {
        None
    };
    let through = match (prev, following) {
        (Some(p), Some(f)) => sub(f, p),
        (Some(p), None) => sub(here, p),
        (None, Some(f)) => sub(f, here),
        (None, None) => return Err("a vertex with no neighbour has no direction"),
    };
    let l = length(through);
    if l < 1e-9 {
        return Err("its neighbours are on top of it");
    }
    let dir = scale(through, 1.0 / l);
    next.out_tangents[index] = following.map_or(ZERO, |f| scale(dir, length(sub(f, here)) / 3.0));
    next.in_tangents[index] = prev.map_or(ZERO, |p| scale(dir, -length(sub(here, p)) / 3.0));
    if let Some(kinds) = &mut next.vertex_kinds {
        kinds[index] = VertexKind::Smooth;
    }
    Ok(next)
}

/// A vertex given the kind `kind` (11.113). `corner` keeps the handles it has; `smooth` and `symmetric` bring them in line (smooth
/// keeps their lengths, symmetric makes them equal); `auto` clears the stored handles, which are derived from now on, and a vertex
/// that stops being `auto` is first written out with the handles it was drawn with, so the shape never moves.
pub fn set_vertex_kind(path: &BezierPath, index: usize, kind: VertexKind) -> Result<BezierPath, Why> {
    let n = path.vertices.len();
    if index >= n {
        return Err("there is no such vertex");
    }
    let mut next = path.clone();
    let mut kinds = kinds_of(path);
    let before = kinds[index];
    if before == kind {
        return Err("it is that kind already");
    }
    // What the author sees now is what the new kind starts from.
    next = materialise_at(&next, &[index]);
    if before == VertexKind::Auto {
        kinds[index] = VertexKind::Corner;
    }
    match kind {
        VertexKind::Corner => {}
        // An auto vertex's handles are derived and never stored beside manual ones (11.113): its stored handles are cleared.
        VertexKind::Auto => {
            next.in_tangents[index] = ZERO;
            next.out_tangents[index] = ZERO;
        }
        VertexKind::Smooth | VertexKind::Symmetric => {
            let (inn, out) = (next.in_tangents[index], next.out_tangents[index]);
            let (li, lo) = (length(inn), length(out));
            if li <= NO_HANDLE && lo <= NO_HANDLE {
                // No handles to bring in line: derive them as a corner made smooth would get them.
                let mut probe = next.clone();
                probe.vertex_kinds = None;
                let made = convert_vertex(&probe, index)?;
                next.in_tangents[index] = made.in_tangents[index];
                next.out_tangents[index] = made.out_tangents[index];
            } else {
                // Keep the longer handle's direction, the author's main gesture.
                let (dir, len_out, len_in) = if lo >= li {
                    (direction(out, ZERO), lo, if li > NO_HANDLE { li } else { lo })
                } else {
                    (scale(direction(inn, ZERO), -1.0), if lo > NO_HANDLE { lo } else { li }, li)
                };
                let (len_out, len_in) = if kind == VertexKind::Symmetric {
                    let m = (len_out + len_in) / 2.0;
                    (m, m)
                } else {
                    (len_out, len_in)
                };
                next.out_tangents[index] = scale(dir, len_out);
                next.in_tangents[index] = scale(dir, -len_in);
            }
        }
    }
    kinds[index] = kind;
    next.vertex_kinds = Some(kinds);
    Ok(next)
}

/// The tension of the `auto` vertices, 0 to 1.
pub fn set_auto_tension(path: &BezierPath, tension: f64) -> Result<BezierPath, Why> {
    if !tension.is_finite() || !(0.0..=1.0).contains(&tension) {
        return Err("the tension is a number from 0 to 1");
    }
    let mut next = path.clone();
    next.auto_tension = Some(tension);
    Ok(next)
}

/// One handle set to `vector` (an offset from its vertex); the other follows
/// by `coupling`. `out` picks the outgoing handle.
pub fn set_handle(
    path: &BezierPath,
    index: usize,
    out: bool,
    vector: Vec2,
    coupling: Coupling,
) -> Result<BezierPath, Why> {
    if index >= path.vertices.len() {
        return Err("there is no such vertex");
    }
    if !finite(vector) {
        return Err("a handle must be a finite point");
    }
    let path = &materialise_at(path, &[index]);
    let mut next = path.clone();
    let far_now = if out {
        path.in_tangents[index]
    } else {
        path.out_tangents[index]
    };
    let l = length(vector);
    let far = match coupling {
        Coupling::Mirror => scale(vector, -1.0),
        Coupling::Smooth if l > NO_HANDLE => scale(vector, -length(far_now) / l),
        _ => far_now,
    };
    if out {
        next.out_tangents[index] = vector;
        next.in_tangents[index] = far;
    } else {
        next.in_tangents[index] = vector;
        next.out_tangents[index] = far;
    }
    if let Some(kinds) = &mut next.vertex_kinds {
        kinds[index] = match coupling {
            Coupling::None => VertexKind::Corner,
            Coupling::Smooth => VertexKind::Smooth,
            Coupling::Mirror => VertexKind::Symmetric,
        };
    }
    Ok(next)
}

/// Some vertices moved by the same offset; their handles go with them.
pub fn move_vertices(path: &BezierPath, indices: &[usize], delta: Vec2) -> Result<BezierPath, Why> {
    if !finite(delta) {
        return Err("a move must be a finite distance");
    }
    if indices.is_empty() || indices.iter().any(|&i| i >= path.vertices.len()) {
        return Err("there is no such vertex");
    }
    let mut next = path.clone();
    let mut done = vec![false; path.vertices.len()];
    for &i in indices {
        if !done[i] {
            next.vertices[i] = add(path.vertices[i], delta);
            done[i] = true;
        }
    }
    Ok(next)
}

/// The curve dragged at `t` of `segment` by `delta`, its end vertices staying.
pub fn reshape_segment(
    path: &BezierPath,
    segment: usize,
    t: f64,
    delta: Vec2,
) -> Result<BezierPath, Why> {
    if segment >= segment_count(path) {
        return Err("there is no such segment");
    }
    if !finite(delta) || !t.is_finite() {
        return Err("a move must be a finite distance");
    }
    let u = 1.0 - t;
    let a = 3.0 * u * u * t;
    let b = 3.0 * u * t * t;
    let weight = a * a + b * b;
    if weight < 1e-12 {
        return Err("grab the curve between its vertices");
    }
    let n = path.vertices.len();
    let from = segment % n;
    let to = (segment + 1) % n;
    let couple = |p: &BezierPath, i: usize| match kinds_of(p)[i] {
        VertexKind::Symmetric => Coupling::Mirror,
        VertexKind::Smooth | VertexKind::Auto => Coupling::Smooth,
        VertexKind::Corner => Coupling::None,
    };
    let path = &materialise_at(path, &[from, to]);
    let first = set_handle(
        path,
        from,
        true,
        add(path.out_tangents[from], scale(delta, a / weight)),
        couple(path, from),
    )?;
    set_handle(
        &first,
        to,
        false,
        add(first.in_tangents[to], scale(delta, b / weight)),
        couple(&first, to),
    )
}

/// The path in the other direction: the same outline. A closed path keeps its
/// first vertex first.
pub fn reverse_path(path: &BezierPath) -> BezierPath {
    let n = path.vertices.len();
    let mut order: Vec<usize> = (0..n).rev().collect();
    if path.closed && n > 0 {
        order.retain(|&i| i != 0);
        order.insert(0, 0);
    }
    BezierPath {
        closed: path.closed,
        vertices: order.iter().map(|&i| path.vertices[i]).collect(),
        in_tangents: order.iter().map(|&i| path.out_tangents[i]).collect(),
        out_tangents: order.iter().map(|&i| path.in_tangents[i]).collect(),
        vertex_ids: path.vertex_ids.as_ref().map(|ids| order.iter().map(|&i| ids[i]).collect()),
        vertex_kinds: path.vertex_kinds.as_ref().map(|k| order.iter().map(|&i| k[i]).collect()),
        auto_tension: path.auto_tension,
    }
}

/// A closed path started from another vertex.
pub fn set_first_vertex(path: &BezierPath, index: usize) -> Result<BezierPath, Why> {
    if !path.closed {
        return Err("only a closed path has a first vertex to change");
    }
    if index >= path.vertices.len() {
        return Err("there is no such vertex");
    }
    fn turn<T: Copy>(list: &[T], index: usize) -> Vec<T> {
        list[index..]
            .iter()
            .chain(&list[..index])
            .copied()
            .collect()
    }
    Ok(BezierPath {
        closed: true,
        vertices: turn(&path.vertices, index),
        in_tangents: turn(&path.in_tangents, index),
        out_tangents: turn(&path.out_tangents, index),
        vertex_ids: path.vertex_ids.as_ref().map(|ids| turn(ids, index)),
        vertex_kinds: path.vertex_kinds.as_ref().map(|kinds| turn(kinds, index)),
        auto_tension: path.auto_tension,
    })
}

/// A path closed or opened again. Closing needs three vertices.
pub fn set_closed(path: &BezierPath, closed: bool) -> Result<BezierPath, Why> {
    if closed && path.vertices.len() < 3 {
        return Err("a closed path needs three vertices");
    }
    let mut next = path.clone();
    next.closed = closed;
    Ok(next)
}

// ---------------------------------------------------------------------------
// The command form (spec section 15): one typed operation on one path
// ---------------------------------------------------------------------------

/// Which path of an object an `editPath` edit changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PathTarget {
    /// A shape's path: `subpath` 0 is its main path, 1 and on its compound
    /// subpaths in order.
    Shape {
        #[serde(default)]
        subpath: usize,
    },
    /// One of the object's masks, by its place in the list.
    Mask { index: usize },
}

/// Which handle of a vertex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HandleSide {
    In,
    Out,
}

/// How the far handle follows (see [`Coupling`]), on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HandleCoupling {
    #[default]
    None,
    Smooth,
    Mirror,
}

/// One semantic change to one path. Each is exact and refuses by name what
/// it cannot do; a whole gesture is one of these, so one undo step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PathOp {
    /// A vertex on `segment` at `t`, the curve unchanged (De Casteljau).
    InsertVertex { segment: usize, t: f64 },
    /// Vertices taken out; the curves beside them join with their handles.
    DeleteVertices { indices: Vec<usize> },
    /// A corner made smooth, or a vertex with handles made a corner.
    ConvertVertex { index: usize },
    /// A vertex taken out with one curve fitted over the two beside it, kept only when the shape stays within `tolerance` (11.113).
    DeleteKeepShape { index: usize, tolerance: f64 },
    /// One handle set to `vector` (an offset from its vertex).
    SetHandle {
        index: usize,
        side: HandleSide,
        vector: Vec2,
        #[serde(default)]
        coupling: HandleCoupling,
    },
    /// Vertices moved by `delta`, their handles with them.
    MoveVertices { indices: Vec<usize>, delta: Vec2 },
    /// The curve dragged at `t` of `segment` by `delta`; its ends stay.
    ReshapeSegment { segment: usize, t: f64, delta: Vec2 },
    /// The same outline drawn the other way.
    Reverse,
    /// A closed path started from vertex `index`.
    SetFirstVertex { index: usize },
    /// The path closed or opened.
    SetClosed { closed: bool },
    /// A vertex given a kind: corner, smooth, symmetric or auto (11.113).
    SetVertexKind { index: usize, kind: VertexKind },
    /// The tension of the path's `auto` vertices, 0 to 1 (11.113).
    SetAutoTension { tension: f64 },
}

impl PathOp {
    /// The path after this operation, or why it cannot be done.
    pub fn apply(&self, path: &BezierPath) -> Result<BezierPath, Why> {
        self.apply_with(path, None)
    }

    /// Whether the operation changes which vertices a path has, in which
    /// order, or whether it is open: every key of an animated path takes it
    /// (11.112). The others set the geometry at one frame.
    pub fn changes_topology(&self) -> bool {
        matches!(
            self,
            PathOp::InsertVertex { .. }
                | PathOp::DeleteVertices { .. }
                | PathOp::DeleteKeepShape { .. }
                | PathOp::Reverse
                | PathOp::SetFirstVertex { .. }
                | PathOp::SetClosed { .. }
        )
    }

    /// [`PathOp::apply`], an inserted vertex taking the id `fresh` (the one
    /// every key of an animated path gives it).
    pub fn apply_with(&self, path: &BezierPath, fresh: Option<u32>) -> Result<BezierPath, Why> {
        match self {
            PathOp::SetVertexKind { index, kind } => set_vertex_kind(path, *index, *kind),
            PathOp::SetAutoTension { tension } => set_auto_tension(path, *tension),
            PathOp::InsertVertex { segment, t } => insert_vertex_with_id(path, *segment, *t, fresh),
            PathOp::DeleteVertices { indices } => delete_vertices(path, indices),
            PathOp::ConvertVertex { index } => convert_vertex(path, *index),
            PathOp::DeleteKeepShape { index, tolerance } => delete_keep_shape(path, *index, *tolerance),
            PathOp::SetHandle {
                index,
                side,
                vector,
                coupling,
            } => set_handle(
                path,
                *index,
                *side == HandleSide::Out,
                *vector,
                match coupling {
                    HandleCoupling::None => Coupling::None,
                    HandleCoupling::Smooth => Coupling::Smooth,
                    HandleCoupling::Mirror => Coupling::Mirror,
                },
            ),
            PathOp::MoveVertices { indices, delta } => move_vertices(path, indices, *delta),
            PathOp::ReshapeSegment { segment, t, delta } => {
                reshape_segment(path, *segment, *t, *delta)
            }
            PathOp::Reverse => Ok(reverse_path(path)),
            PathOp::SetFirstVertex { index } => set_first_vertex(path, *index),
            PathOp::SetClosed { closed } => set_closed(path, *closed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small deterministic generator, so the property tests need no crate.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
        fn point(&mut self, span: f64) -> Vec2 {
            Vec2 {
                x: (self.next() - 0.5) * span,
                y: (self.next() - 0.5) * span,
            }
        }
        fn cubic(&mut self) -> Cubic {
            Cubic {
                p0: self.point(400.0),
                p1: self.point(400.0),
                p2: self.point(400.0),
                p3: self.point(400.0),
            }
        }
    }

    fn close(a: Vec2, b: Vec2, eps: f64) -> bool {
        (a.x - b.x).abs() <= eps && (a.y - b.y).abs() <= eps
    }

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn wave() -> BezierPath {
        BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(200.0, 50.0)],
            in_tangents: vec![v(0.0, 0.0), v(-30.0, -40.0), v(-20.0, 30.0)],
            out_tangents: vec![v(30.0, 40.0), v(30.0, 40.0), v(0.0, 0.0)],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        }
    }

    fn blob() -> BezierPath {
        BezierPath {
            closed: true,
            vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(100.0, 100.0), v(0.0, 100.0)],
            in_tangents: vec![v(0.0, 20.0), v(-20.0, 0.0), v(0.0, 0.0), v(25.0, 10.0)],
            out_tangents: vec![v(0.0, -20.0), v(20.0, 0.0), v(0.0, 0.0), v(-50.0, -20.0)],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        }
    }

    #[test]
    fn a_curve_starts_and_ends_on_its_vertices() {
        let mut rng = Rng(1);
        for _ in 0..50 {
            let c = rng.cubic();
            assert_eq!(point_at(&c, 0.0), c.p0);
            assert_eq!(point_at(&c, 1.0), c.p3);
        }
    }

    #[test]
    fn derivatives_match_finite_differences() {
        let mut rng = Rng(2);
        for _ in 0..50 {
            let c = rng.cubic();
            let t = 0.1 + 0.8 * rng.next();
            let h = 1e-5;
            let d = scale(
                sub(point_at(&c, t + h), point_at(&c, t - h)),
                1.0 / (2.0 * h),
            );
            assert!(close(derivative_at(&c, t), d, 1e-4), "first");
            let d2 = scale(
                sub(derivative_at(&c, t + h), derivative_at(&c, t - h)),
                1.0 / (2.0 * h),
            );
            assert!(close(second_derivative_at(&c, t), d2, 1e-4), "second");
        }
    }

    #[test]
    fn a_split_is_the_same_curve() {
        let mut rng = Rng(3);
        for _ in 0..50 {
            let c = rng.cubic();
            let t = 0.05 + 0.9 * rng.next();
            let (left, right) = split_cubic(&c, t);
            for k in 0..=20 {
                let u = f64::from(k) / 20.0;
                let whole = point_at(&c, u);
                let part = if u <= t {
                    point_at(&left, u / t)
                } else {
                    point_at(&right, (u - t) / (1.0 - t))
                };
                assert!(close(whole, part, 1e-9));
            }
        }
    }

    #[test]
    fn the_nearest_point_is_the_global_minimum() {
        let mut rng = Rng(4);
        for _ in 0..200 {
            let c = rng.cubic();
            let q = rng.point(600.0);
            let found = nearest_on_cubic(&c, q);
            let dense = (0..=20_000)
                .map(|k| length(sub(point_at(&c, f64::from(k) / 20_000.0), q)))
                .fold(f64::INFINITY, f64::min);
            assert!(
                found.distance <= dense + 1e-9,
                "{} > {}",
                found.distance,
                dense
            );
            assert!(close(point_at(&c, found.t), found.point, 1e-12));
        }
    }

    #[test]
    fn the_nearest_point_survives_loops_cusps_and_points() {
        let looped = Cubic {
            p0: v(0.0, 0.0),
            p1: v(300.0, 200.0),
            p2: v(-200.0, 200.0),
            p3: v(100.0, 0.0),
        };
        let cusp = Cubic {
            p0: v(0.0, 0.0),
            p1: v(100.0, 100.0),
            p2: v(0.0, 100.0),
            p3: v(100.0, 0.0),
        };
        let dot_curve = Cubic {
            p0: v(5.0, 5.0),
            p1: v(5.0, 5.0),
            p2: v(5.0, 5.0),
            p3: v(5.0, 5.0),
        };
        for c in [looped, cusp, dot_curve] {
            for q in [v(50.0, 60.0), v(50.0, 300.0), v(-80.0, 20.0), v(5.0, 5.0)] {
                let found = nearest_on_cubic(&c, q);
                let dense = (0..=50_000)
                    .map(|k| length(sub(point_at(&c, f64::from(k) / 50_000.0), q)))
                    .fold(f64::INFINITY, f64::min);
                assert!(found.distance.is_finite());
                assert!(found.distance <= dense + 1e-9);
            }
        }
    }

    #[test]
    fn bounds_hold_every_point_and_are_tight() {
        let mut rng = Rng(5);
        for _ in 0..50 {
            let c = rng.cubic();
            let b = cubic_bounds(&c);
            let mut seen = (
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            );
            for k in 0..=5000 {
                let p = point_at(&c, f64::from(k) / 5000.0);
                assert!(
                    p.x >= b.0 - 1e-9
                        && p.x <= b.2 + 1e-9
                        && p.y >= b.1 - 1e-9
                        && p.y <= b.3 + 1e-9
                );
                seen = (
                    seen.0.min(p.x),
                    seen.1.min(p.y),
                    seen.2.max(p.x),
                    seen.3.max(p.y),
                );
            }
            assert!((seen.0 - b.0).abs() < 1e-3 && (seen.2 - b.2).abs() < 1e-3);
            assert!((seen.1 - b.1).abs() < 1e-3 && (seen.3 - b.3).abs() < 1e-3);
        }
    }

    #[test]
    fn length_converges_and_a_reversed_path_is_as_long() {
        let mut rng = Rng(6);
        for _ in 0..20 {
            let c = rng.cubic();
            let fine = arc_length(&c, 0.0, 1.0, 1e-9);
            let chords: f64 = (0..20_000)
                .map(|k| {
                    length(sub(
                        point_at(&c, f64::from(k + 1) / 20_000.0),
                        point_at(&c, f64::from(k) / 20_000.0),
                    ))
                })
                .sum();
            assert!((fine - chords).abs() < 1e-3, "{fine} {chords}");
        }
        let path = wave();
        assert!((path_length(&path, 1e-9) - path_length(&reverse_path(&path), 1e-9)).abs() < 1e-6);
        let ring = blob();
        assert!((path_length(&ring, 1e-9) - path_length(&reverse_path(&ring), 1e-9)).abs() < 1e-6);
    }

    #[test]
    fn curvature_and_tangent_never_give_nan() {
        let dot_curve = Cubic {
            p0: v(5.0, 5.0),
            p1: v(5.0, 5.0),
            p2: v(5.0, 5.0),
            p3: v(5.0, 5.0),
        };
        assert_eq!(curvature_at(&dot_curve, 0.5), 0.0);
        assert_eq!(tangent_at(&dot_curve, 0.5), None);
        let corner = Cubic {
            p0: v(0.0, 0.0),
            p1: v(0.0, 0.0),
            p2: v(10.0, 0.0),
            p3: v(10.0, 0.0),
        };
        assert!(curvature_at(&corner, 0.0).is_finite());
        let along = tangent_at(&corner, 0.0).unwrap();
        assert!(close(along, v(1.0, 0.0), 1e-12));
    }

    fn same_outline(a: &BezierPath, b: &BezierPath) {
        // Every point of `a` lies on `b` and the lengths agree.
        for c in cubics_of(a) {
            for k in 0..=20 {
                let p = point_at(&c, f64::from(k) / 20.0);
                let (_, near) = nearest_on_path(b, p).unwrap();
                assert!(near.distance < 1e-6, "{}", near.distance);
            }
        }
        assert!((path_length(a, 1e-9) - path_length(b, 1e-9)).abs() < 1e-6);
    }

    #[test]
    fn inserting_a_vertex_keeps_the_curve() {
        for path in [wave(), blob()] {
            for segment in 0..segment_count(&path) {
                for t in [0.2, 0.5, 0.83] {
                    let next = insert_vertex(&path, segment, t).unwrap();
                    assert_eq!(next.vertices.len(), path.vertices.len() + 1);
                    same_outline(&path, &next);
                    same_outline(&next, &path);
                    assert!(close(
                        next.vertices[segment + 1],
                        point_at(&cubic_of(&path, segment), t),
                        1e-12
                    ));
                }
            }
        }
        assert_eq!(
            insert_vertex(&wave(), 0, 0.0),
            Err("that is a vertex already")
        );
        assert_eq!(
            insert_vertex(&wave(), 0, 1.0),
            Err("that is a vertex already")
        );
        assert_eq!(
            insert_vertex(&wave(), 2, 0.5),
            Err("there is no such segment")
        );
        assert_eq!(
            insert_vertex(&wave(), 0, f64::NAN),
            Err("that is a vertex already")
        );
    }

    #[test]
    fn deleting_keeps_the_least_a_path_needs() {
        let next = delete_vertices(&wave(), &[1]).unwrap();
        assert_eq!(next.vertices, vec![v(0.0, 0.0), v(200.0, 50.0)]);
        assert_eq!(next.out_tangents[0], v(30.0, 40.0));
        assert_eq!(next.in_tangents[1], v(-20.0, 30.0));
        assert_eq!(
            delete_vertices(&next, &[0]),
            Err("a path keeps two vertices")
        );
        assert_eq!(
            delete_vertices(&blob(), &[0, 1]),
            Err("a closed path keeps three vertices")
        );
        assert_eq!(
            delete_vertices(&blob(), &[9]),
            Err("there is no such vertex")
        );
        assert_eq!(
            delete_vertices(&blob(), &[]),
            Err("there is no such vertex")
        );
        assert_eq!(delete_vertices(&blob(), &[2, 2]).unwrap().vertices.len(), 3);
    }

    #[test]
    fn converting_makes_a_corner_smooth_and_back() {
        let path = blob();
        assert!(!has_handles(&path, 2));
        let smooth = convert_vertex(&path, 2).unwrap();
        assert!(is_smooth(&smooth, 2));
        // In line with the way through it, a third of the way to each neighbour.
        let dir = scale(v(-100.0, 100.0), 1.0 / length(v(-100.0, 100.0)));
        assert!(close(smooth.out_tangents[2], scale(dir, 100.0 / 3.0), 1e-9));
        assert!(close(smooth.in_tangents[2], scale(dir, -100.0 / 3.0), 1e-9));
        let back = convert_vertex(&smooth, 2).unwrap();
        assert_eq!(back.in_tangents[2], ZERO);
        assert_eq!(back.out_tangents[2], ZERO);
        // The end of an open path gets one handle only.
        let open = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(30.0, 0.0)],
            in_tangents: vec![ZERO; 2],
            out_tangents: vec![ZERO; 2],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        let end = convert_vertex(&open, 0).unwrap();
        assert_eq!(end.in_tangents[0], ZERO);
        assert!(close(end.out_tangents[0], v(10.0, 0.0), 1e-12));
        let stacked = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(0.0, 0.0)],
            in_tangents: vec![ZERO; 2],
            out_tangents: vec![ZERO; 2],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        assert_eq!(
            convert_vertex(&stacked, 0),
            Err("its neighbours are on top of it")
        );
        assert_eq!(convert_vertex(&open, 2), Err("there is no such vertex"));
    }

    #[test]
    fn a_vertex_is_smooth_only_with_two_opposite_handles() {
        let make = |a: Vec2, b: Vec2| BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(50.0, 0.0)],
            in_tangents: vec![a, ZERO],
            out_tangents: vec![b, ZERO],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        assert!(is_smooth(&make(v(-10.0, 0.0), v(20.0, 0.0)), 0));
        // In line but on the same side: a point that doubles back is not smooth.
        assert!(!is_smooth(&make(v(10.0, 0.0), v(20.0, 0.0)), 0));
        // A hair of a handle is no handle.
        assert!(!is_smooth(&make(v(-1e-7, 0.0), v(20.0, 0.0)), 0));
        assert!(!is_smooth(&make(ZERO, v(20.0, 0.0)), 0));
    }

    #[test]
    fn a_handle_moves_alone_in_line_or_mirrored() {
        let path = wave();
        let alone = set_handle(&path, 1, true, v(0.0, 50.0), Coupling::None).unwrap();
        assert_eq!(alone.out_tangents[1], v(0.0, 50.0));
        assert_eq!(alone.in_tangents[1], v(-30.0, -40.0));
        let smooth = set_handle(&path, 1, true, v(0.0, 10.0), Coupling::Smooth).unwrap();
        assert!(
            close(smooth.in_tangents[1], v(0.0, -50.0), 1e-9),
            "keeps its own length, opposite"
        );
        let mirror = set_handle(&path, 1, false, v(7.0, 9.0), Coupling::Mirror).unwrap();
        assert_eq!(mirror.in_tangents[1], v(7.0, 9.0));
        assert_eq!(mirror.out_tangents[1], v(-7.0, -9.0));
        // A handle pulled to nothing leaves the other where it is, rather than dividing by zero.
        let zero = set_handle(&path, 1, true, ZERO, Coupling::Smooth).unwrap();
        assert_eq!(zero.in_tangents[1], v(-30.0, -40.0));
        assert_eq!(
            set_handle(&path, 1, true, v(f64::NAN, 0.0), Coupling::None),
            Err("a handle must be a finite point")
        );
        assert_eq!(
            set_handle(&path, 3, true, ZERO, Coupling::None),
            Err("there is no such vertex")
        );
    }

    #[test]
    fn moving_vertices_takes_their_handles_along() {
        let path = wave();
        let next = move_vertices(&path, &[1, 1, 2], v(5.0, -5.0)).unwrap();
        assert_eq!(
            next.vertices,
            vec![v(0.0, 0.0), v(105.0, -5.0), v(205.0, 45.0)]
        );
        assert_eq!(next.in_tangents, path.in_tangents);
        assert_eq!(next.out_tangents, path.out_tangents);
        assert_eq!(
            move_vertices(&path, &[], v(1.0, 1.0)),
            Err("there is no such vertex")
        );
        assert_eq!(
            move_vertices(&path, &[0], v(f64::INFINITY, 1.0)),
            Err("a move must be a finite distance")
        );
    }

    #[test]
    fn reshaping_moves_the_grabbed_point_exactly() {
        for (path, segment) in [(wave(), 0), (wave(), 1), (blob(), 3)] {
            for t in [0.25, 0.5, 0.7] {
                let before = point_at(&cubic_of(&path, segment), t);
                let delta = v(12.0, -7.0);
                let next = reshape_segment(&path, segment, t, delta).unwrap();
                let after = point_at(&cubic_of(&next, segment), t);
                assert!(close(after, add(before, delta), 1e-9));
                assert_eq!(next.vertices, path.vertices);
            }
        }
        // A smooth end keeps its other handle in line.
        let next = reshape_segment(&wave(), 1, 0.5, v(0.0, 30.0)).unwrap();
        assert!(is_smooth(&next, 1));
        assert_eq!(
            reshape_segment(&wave(), 0, 0.0, v(1.0, 1.0)),
            Err("grab the curve between its vertices")
        );
        assert_eq!(
            reshape_segment(&wave(), 5, 0.5, v(1.0, 1.0)),
            Err("there is no such segment")
        );
    }

    #[test]
    fn reversing_and_restarting_keep_the_outline() {
        for path in [wave(), blob()] {
            let back = reverse_path(&path);
            same_outline(&path, &back);
            assert_eq!(reverse_path(&back), path);
        }
        assert_eq!(reverse_path(&blob()).vertices[0], blob().vertices[0]);
        let turned = set_first_vertex(&blob(), 2).unwrap();
        assert_eq!(turned.vertices[0], v(100.0, 100.0));
        same_outline(&blob(), &turned);
        assert_eq!(
            set_first_vertex(&wave(), 1),
            Err("only a closed path has a first vertex to change")
        );
        assert_eq!(set_first_vertex(&blob(), 4), Err("there is no such vertex"));
    }

    #[test]
    fn closing_needs_three_vertices() {
        assert!(set_closed(&wave(), true).unwrap().closed);
        assert!(!set_closed(&blob(), false).unwrap().closed);
        let two = delete_vertices(&wave(), &[1]).unwrap();
        assert_eq!(
            set_closed(&two, true),
            Err("a closed path needs three vertices")
        );
    }

    #[test]
    fn a_split_curve_is_fitted_back_exactly_and_a_corner_is_refused_by_the_tolerance() {
        // One curve split in two: taking the split out gives the curve back, with no deviation to speak of.
        let whole = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(200.0, 0.0)],
            in_tangents: vec![ZERO, v(-60.0, 80.0)],
            out_tangents: vec![v(60.0, 80.0), ZERO],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        let split = insert_vertex(&whole, 0, 0.4).unwrap();
        let fit = fit_delete_vertex(&split, 1).unwrap();
        assert_eq!(fit.path.vertices.len(), 2);
        // A curve of size 200 comes back to within a twentieth of a pixel: a fit, not an identity.
        assert!(fit.deviation < 0.1, "deviation {}", fit.deviation);
        for (a, b) in [(fit.path.out_tangents[0], whole.out_tangents[0]), (fit.path.in_tangents[1], whole.in_tangents[1])] {
            assert!(length(sub(a, b)) < 3.0, "{a:?} vs {b:?}");
        }
        assert!(delete_keep_shape(&split, 1, 0.1).is_ok());
        // A sharp corner cannot be one curve: the fit stays far from the old shape and the tolerance refuses it.
        let corner = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(100.0, 100.0)],
            in_tangents: vec![ZERO; 3],
            out_tangents: vec![ZERO; 3],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        let far = fit_delete_vertex(&corner, 1).unwrap();
        // The best one curve keeps both legs and rounds the corner: about 3 off a 100 long leg, which a tolerance of 1 refuses.
        assert!(far.deviation > 1.5, "deviation {}", far.deviation);
        assert_eq!(
            delete_keep_shape(&corner, 1, 1.0),
            Err("taking that vertex out would change the shape by more than the tolerance")
        );
        assert!(delete_keep_shape(&corner, 1, 100.0).is_ok(), "a generous tolerance accepts it");
        assert_eq!(delete_keep_shape(&corner, 1, -1.0), Err("the tolerance must be a distance of zero or more"));
        assert_eq!(delete_keep_shape(&corner, 1, f64::NAN), Err("the tolerance must be a distance of zero or more"));
        // The ends of an open path have one curve: taking one out is the ordinary delete, exactly.
        assert_eq!(fit_delete_vertex(&corner, 0).unwrap(), KeepShapeFit { path: delete_vertices(&corner, &[0]).unwrap(), deviation: 0.0 });
        assert!(fit_delete_vertex(&corner, 9).is_err());
        // Straight segments in line are one straight segment: no deviation at all.
        let line = BezierPath { closed: false, vertices: vec![v(0.0, 0.0), v(40.0, 0.0), v(100.0, 0.0)], in_tangents: vec![ZERO; 3], out_tangents: vec![ZERO; 3], vertex_ids: None, vertex_kinds: None, auto_tension: None };
        assert!(fit_delete_vertex(&line, 1).unwrap().deviation < 1e-9);
    }

    #[test]
    fn a_closed_path_loses_a_vertex_at_any_place_in_its_order() {
        // A smooth ring of eight vertices on a circle: any one can go with a small deviation, whichever index (the wrap included).
        let k = 0.552_284_75 * 0.0 + 4.0 / 3.0 * (std::f64::consts::PI / 16.0).tan();
        let n = 8;
        let radius = 100.0;
        let mut ring = BezierPath { closed: true, vertices: vec![], in_tangents: vec![], out_tangents: vec![], vertex_ids: None, vertex_kinds: None, auto_tension: None };
        for i in 0..n {
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            let (s, c) = a.sin_cos();
            ring.vertices.push(v(radius * c, radius * s));
            ring.out_tangents.push(v(-radius * s * k, radius * c * k));
            ring.in_tangents.push(v(radius * s * k, -radius * c * k));
        }
        for index in 0..n {
            let fit = fit_delete_vertex(&ring, index).unwrap();
            assert_eq!(fit.path.vertices.len(), n - 1, "vertex {index}");
            assert!(fit.path.closed);
            assert!(fit.deviation < 1.0, "vertex {index}: {}", fit.deviation);
        }
    }

    /// The fixture the Editor's TypeScript maths is held to. Rewritten with
    /// `GX_WRITE_FIXTURES=1`; otherwise this test fails when it has drifted.
    #[test]
    fn the_shared_fixture_holds_this_modules_answers() {
        let json_point = |p: Vec2| serde_json::json!({ "x": p.x, "y": p.y });
        let mut rng = Rng(77);
        let mut nearest = Vec::new();
        for _ in 0..40 {
            let c = rng.cubic();
            let q = rng.point(600.0);
            let found = nearest_on_cubic(&c, q);
            let b = cubic_bounds(&c);
            nearest.push(serde_json::json!({
                "cubic": [json_point(c.p0), json_point(c.p1), json_point(c.p2), json_point(c.p3)],
                "q": json_point(q),
                "distance": found.distance,
                "bounds": [b.0, b.1, b.2, b.3],
                "length": arc_length(&c, 0.0, 1.0, 1e-9),
                "curvature": curvature_at(&c, 0.3),
            }));
        }
        let edits = serde_json::json!({
            "wave": wave(),
            "blob": blob(),
            "insertWave": insert_vertex(&wave(), 1, 0.4).unwrap(),
            "insertBlobClosing": insert_vertex(&blob(), 3, 0.6).unwrap(),
            "deleteBlob": delete_vertices(&blob(), &[1]).unwrap(),
            "convertBlob": convert_vertex(&blob(), 2).unwrap(),
            "convertWave": convert_vertex(&wave(), 1).unwrap(),
            "handleSmooth": set_handle(&wave(), 1, true, v(10.0, 25.0), Coupling::Smooth).unwrap(),
            "handleMirror": set_handle(&wave(), 1, false, v(7.0, 9.0), Coupling::Mirror).unwrap(),
            "moveWave": move_vertices(&wave(), &[0, 2], v(3.5, -2.0)).unwrap(),
            "reshapeWave": reshape_segment(&wave(), 1, 0.35, v(12.0, -7.0)).unwrap(),
            "reverseWave": reverse_path(&wave()),
            "reverseBlob": reverse_path(&blob()),
            "firstBlob": set_first_vertex(&blob(), 3).unwrap(),
            "keepWave": { "path": fit_delete_vertex(&wave(), 1).unwrap().path, "deviation": fit_delete_vertex(&wave(), 1).unwrap().deviation },
            "keepBlob": { "path": fit_delete_vertex(&blob(), 2).unwrap().path, "deviation": fit_delete_vertex(&blob(), 2).unwrap().deviation },
            "keepSplit": {
                "path": fit_delete_vertex(&insert_vertex(&blob(), 1, 0.4).unwrap(), 2).unwrap().path,
                "deviation": fit_delete_vertex(&insert_vertex(&blob(), 1, 0.4).unwrap(), 2).unwrap().deviation,
            },
        });
        // 11.112 and 11.113: ids and kinds through every operation, the auto handles, and the blend of two keys.
        let kinded = || {
            use VertexKind::*;
            BezierPath {
                closed: true,
                vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(120.0, 90.0), v(10.0, 100.0)],
                in_tangents: vec![v(0.0, 20.0), v(-25.0, 0.0), v(0.0, 0.0), v(15.0, 5.0)],
                out_tangents: vec![v(0.0, -20.0), v(25.0, 0.0), v(0.0, 0.0), v(-15.0, -5.0)],
                vertex_ids: Some(vec![10, 20, 30, 40]),
                vertex_kinds: Some(vec![Corner, Smooth, Auto, Symmetric]),
                auto_tension: Some(0.7),
            }
        };
        let auto_handles: Vec<serde_json::Value> = (0..4)
            .map(|i| {
                let (a, b) = derive_auto_handles(&kinded(), i);
                serde_json::json!({ "in": a, "out": b })
            })
            .collect();
        let keep = {
            let f = fit_delete_vertex(&kinded(), 1).unwrap();
            serde_json::json!({ "path": f.path, "deviation": f.deviation })
        };
        let kinds = serde_json::json!({
            "kinded": kinded(),
            "effective": effective(&kinded()),
            "autoHandles": auto_handles,
            "reverse": reverse_path(&kinded()),
            "first": set_first_vertex(&kinded(), 2).unwrap(),
            "insertFresh": insert_vertex(&kinded(), 1, 0.3).unwrap(),
            "insertGiven": insert_vertex_with_id(&kinded(), 2, 0.5, Some(77)).unwrap(),
            "delete": delete_vertices(&kinded(), &[1]).unwrap(),
            "kindSmooth": set_vertex_kind(&kinded(), 0, VertexKind::Smooth).unwrap(),
            "kindSymmetric": set_vertex_kind(&kinded(), 1, VertexKind::Symmetric).unwrap(),
            "kindAuto": set_vertex_kind(&kinded(), 0, VertexKind::Auto).unwrap(),
            "kindCorner": set_vertex_kind(&kinded(), 2, VertexKind::Corner).unwrap(),
            "handleSmooth": set_handle(&kinded(), 2, true, v(10.0, 25.0), Coupling::Smooth).unwrap(),
            "handleBreak": set_handle(&kinded(), 1, false, v(-7.0, 9.0), Coupling::None).unwrap(),
            "reshape": reshape_segment(&kinded(), 2, 0.4, v(6.0, -9.0)).unwrap(),
            "convert": convert_vertex(&kinded(), 3).unwrap(),
            "keep": keep,
            "tension": set_auto_tension(&kinded(), 0.25).unwrap(),
            "controlBounds": control_bounds(&kinded()),
            "pathBounds": path_bounds(&kinded()),
        });
        let animated = {
            use crate::animation::SceneEasing;
            use crate::path_anim::{evaluate_path_channel, PathChannel, PathKey};
            let a = kinded();
            let mut b = kinded();
            b.vertices = b.vertices.iter().map(|p| v(p.x + 40.0, p.y - 10.0)).collect();
            let mut odd = kinded();
            odd.vertex_ids = Some(vec![10, 30, 20, 40]);
            let key = |frame: u64, path: BezierPath, easing: SceneEasing| PathKey { frame, path, easing, bezier: None };
            let channel = PathChannel {
                object_id: "s".into(),
                target: PathTarget::Shape { subpath: 0 },
                keys: vec![
                    key(0, a, SceneEasing::Linear),
                    key(10, b.clone(), SceneEasing::EaseInOut),
                    key(20, odd, SceneEasing::Hold),
                    key(30, b, SceneEasing::Linear),
                ],
            };
            let at = |frame: u64| {
                let value = evaluate_path_channel(&channel, frame).unwrap().unwrap();
                serde_json::json!({ "frame": frame, "path": value.path, "held": value.held })
            };
            let frames: Vec<serde_json::Value> = [0u64, 3, 5, 10, 14, 19, 20, 25, 30, 99].iter().map(|f| at(*f)).collect();
            serde_json::json!({ "channel": channel, "frames": frames })
        };
        let text = serde_json::to_string_pretty(
            &serde_json::json!({ "cubics": nearest, "edits": edits, "kinds": kinds, "animated": animated }),
        )
        .unwrap()
            + "\n";
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/path-geometry.json");
        if std::env::var_os("GX_WRITE_FIXTURES").is_some() {
            std::fs::write(&path, &text).unwrap();
        }
        let on_disk = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            on_disk, text,
            "run with GX_WRITE_FIXTURES=1 to rewrite fixtures/path-geometry.json"
        );
    }

    // ---- 11.113: vertex kinds and auto handles ----

    fn row(kinds: Vec<VertexKind>, points: &[(f64, f64)]) -> BezierPath {
        let n = points.len();
        BezierPath {
            closed: false,
            vertices: points.iter().map(|&(x, y)| v(x, y)).collect(),
            in_tangents: vec![ZERO; n],
            out_tangents: vec![ZERO; n],
            vertex_ids: Some((0..n as u32).collect()),
            vertex_kinds: Some(kinds),
            auto_tension: None,
        }
    }

    #[test]
    fn auto_handles_come_from_the_neighbours_and_nowhere_else() {
        use VertexKind::*;
        // Evenly spaced on a line: the handles are a third of the spacing, which draws the line itself.
        let line = row(vec![Corner, Auto, Corner], &[(0.0, 0.0), (30.0, 0.0), (60.0, 0.0)]);
        let (inn, out) = derive_auto_handles(&line, 1);
        assert!(close(inn, v(-10.0, 0.0), 1e-9) && close(out, v(10.0, 0.0), 1e-9), "{inn:?} {out:?}");
        // The stored handles of an auto vertex are ignored; the drawn path has the derived ones.
        let mut stored = line.clone();
        stored.in_tangents[1] = v(-99.0, 40.0);
        stored.out_tangents[1] = v(99.0, 40.0);
        let drawn = effective(&stored);
        assert!(close(drawn.out_tangents[1], v(10.0, 0.0), 1e-9));
        // Other vertices are as stored, and a path with no auto vertex is returned as it was.
        assert_eq!(drawn.vertices, stored.vertices);
        let plain = row(vec![Corner, Smooth, Corner], &[(0.0, 0.0), (30.0, 0.0), (60.0, 0.0)]);
        assert_eq!(effective(&plain), plain);
        assert!(!has_auto(&plain) && has_auto(&line));
        // Moving a neighbour re-derives: auto follows the geometry.
        let mut moved = line.clone();
        moved.vertices[2] = v(60.0, 30.0);
        let (_, out_moved) = derive_auto_handles(&moved, 1);
        assert!(out_moved.y > 1.0, "{out_moved:?}");
        // The ends of an open path point a third of the way to their one neighbour; tension scales the handles.
        let (inn_end, out_end) = derive_auto_handles(&line, 0);
        assert!(close(out_end, v(10.0, 0.0), 1e-9) && close(inn_end, ZERO, 1e-12));
        let mut tight = line.clone();
        tight.auto_tension = Some(0.0);
        assert!(close(derive_auto_handles(&tight, 1).1, ZERO, 1e-12));
        let mut loose = line.clone();
        loose.auto_tension = Some(1.0);
        assert!(close(derive_auto_handles(&loose, 1).1, v(20.0, 0.0), 1e-9));
        // Uneven spacing does not overshoot (centripetal): the curve stays between its neighbours.
        let uneven = row(vec![Corner, Auto, Corner], &[(0.0, 0.0), (10.0, 0.0), (200.0, 0.0)]);
        let drawn = effective(&uneven);
        let (b0, b1) = (cubic_bounds(&cubic_of(&drawn, 0)), cubic_bounds(&cubic_of(&drawn, 1)));
        assert!(b0.0 >= -1e-9 && b0.2 <= 10.0 + 1e-9, "{b0:?}");
        assert!(b1.0 >= 10.0 - 1e-9 && b1.2 <= 200.0 + 1e-9, "{b1:?}");
        // Bounds, length and hit tests read the drawn path, so an auto vertex's stored handles never leak into them.
        assert_eq!(path_bounds(&stored), path_bounds(&line));
        assert_eq!(path_length(&stored, 1e-6), path_length(&line, 1e-6));
    }

    #[test]
    fn editing_an_auto_vertex_writes_out_what_the_author_sees_first() {
        use VertexKind::*;
        let path = row(vec![Corner, Auto, Auto, Corner], &[(0.0, 0.0), (40.0, 30.0), (80.0, -20.0), (120.0, 0.0)]);
        let seen = effective(&path);
        // Drag a handle of vertex 1: it becomes a smooth vertex holding the derived handle, then takes the drag.
        let dragged = set_handle(&path, 1, true, v(5.0, 40.0), Coupling::Smooth).unwrap();
        let kinds = dragged.vertex_kinds.as_ref().unwrap();
        assert_eq!(kinds[1], Smooth);
        assert_eq!(kinds[2], Auto, "an untouched auto vertex stays auto");
        assert!(close(dragged.out_tangents[1], v(5.0, 40.0), 1e-12));
        let far = dragged.in_tangents[1];
        assert!(length(far) > 1.0 && is_smooth(&dragged, 1), "the far handle follows, collinear: {far:?}");
        // The far handle kept the length the derived one had.
        assert!((length(far) - length(seen.in_tangents[1])).abs() < 1e-9);
        // Insert on a segment between auto vertices splits the curve AS DRAWN: both ends are written out.
        let split = insert_vertex(&path, 1, 0.3).unwrap();
        assert_eq!(split.vertex_kinds.as_ref().unwrap()[1], Smooth);
        assert_eq!(split.vertex_kinds.as_ref().unwrap()[3], Smooth);
        assert_eq!(split.vertex_ids, Some(vec![0, 1, 4, 2, 3]));
        let (whole, left, right) = (cubic_of(&seen, 1), cubic_of(&split, 1), cubic_of(&split, 2));
        for k in 0..=10 {
            let u = k as f64 / 10.0;
            assert!(close(point_at(&left, u), point_at(&whole, 0.3 * u), 1e-9));
            assert!(close(point_at(&right, u), point_at(&whole, 0.3 + 0.7 * u), 1e-9));
        }
        // Reshaping a segment writes its ends out too.
        let reshaped = reshape_segment(&path, 1, 0.5, v(0.0, 10.0)).unwrap();
        assert_eq!(reshaped.vertex_kinds.as_ref().unwrap()[1], Smooth);
        assert_eq!(reshaped.vertex_kinds.as_ref().unwrap()[2], Smooth);
        // Deleting a vertex re-derives its auto neighbours (that is what auto means); keep-shape writes them out first.
        let plain_delete = delete_vertices(&path, &[2]).unwrap();
        assert_eq!(plain_delete.vertex_kinds, Some(vec![Corner, Auto, Corner]));
        let kept = fit_delete_vertex(&path, 2).unwrap().path;
        assert_eq!(kept.vertex_kinds.as_ref().unwrap()[1], Smooth);
    }

    #[test]
    fn a_kind_is_set_by_name_and_the_handles_follow_it() {
        use VertexKind::*;
        let path = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(50.0, 0.0), v(100.0, 0.0)],
            in_tangents: vec![ZERO, v(-10.0, 4.0), ZERO],
            out_tangents: vec![ZERO, v(30.0, 12.0), ZERO],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        // With no kinds stored the kind is inferred from the handles, as before.
        assert_eq!(kinds_of(&path), vec![Corner, Corner, Corner]);
        assert!(set_vertex_kind(&path, 1, Corner).is_err(), "already that kind");
        assert!(set_vertex_kind(&path, 7, Smooth).is_err());
        // Smooth: collinear and opposite, each handle keeping its length (the longer one's direction wins).
        let smooth = set_vertex_kind(&path, 1, Smooth).unwrap();
        assert!(is_smooth(&smooth, 1));
        assert!((length(smooth.out_tangents[1]) - length(path.out_tangents[1])).abs() < 1e-9);
        assert!((length(smooth.in_tangents[1]) - length(path.in_tangents[1])).abs() < 1e-9);
        assert_eq!(smooth.vertex_kinds.as_ref().unwrap()[1], Smooth);
        // Symmetric: equal lengths too.
        let sym = set_vertex_kind(&smooth, 1, Symmetric).unwrap();
        assert!((length(sym.out_tangents[1]) - length(sym.in_tangents[1])).abs() < 1e-9);
        assert!(close(sym.in_tangents[1], scale(sym.out_tangents[1], -1.0), 1e-9));
        // A vertex with no handles made smooth gets the ones a converted corner gets.
        let bare = set_vertex_kind(&path, 0, Smooth);
        assert!(bare.is_ok());
        // Auto keeps the stored handles but they are ignored; going back to corner keeps what was seen.
        let auto = set_vertex_kind(&sym, 1, Auto).unwrap();
        assert_eq!(auto.vertex_kinds.as_ref().unwrap()[1], Auto);
        let back = set_vertex_kind(&auto, 1, Corner).unwrap();
        assert_eq!(back.vertex_kinds.as_ref().unwrap()[1], Corner);
        assert!(close(back.out_tangents[1], effective(&auto).out_tangents[1], 1e-9));
        // set_handle updates the kind by coupling: Alt breaks it, Shift mirrors it.
        assert_eq!(set_handle(&sym, 1, true, v(9.0, 9.0), Coupling::None).unwrap().vertex_kinds.unwrap()[1], Corner);
        assert_eq!(set_handle(&sym, 1, true, v(9.0, 9.0), Coupling::Mirror).unwrap().vertex_kinds.unwrap()[1], Symmetric);
        // The tension is a number from 0 to 1.
        assert!(set_auto_tension(&path, 1.5).is_err() && set_auto_tension(&path, f64::NAN).is_err());
        assert_eq!(set_auto_tension(&path, 0.25).unwrap().auto_tension, Some(0.25));
        // Convert toggles between corner and smooth and writes the kind when kinds are kept.
        assert_eq!(convert_vertex(&sym, 1).unwrap().vertex_kinds.unwrap()[1], Corner);
        assert_eq!(convert_vertex(&row(vec![Corner, Corner, Corner], &[(0.0, 0.0), (10.0, 0.0), (20.0, 5.0)]), 1).unwrap().vertex_kinds.unwrap()[1], Smooth);
    }

    #[test]
    fn ids_and_kinds_travel_through_every_operation() {
        use VertexKind::*;
        let mut ring = row(vec![Corner, Smooth, Auto, Symmetric], &[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]);
        ring.closed = true;
        ring.vertex_ids = Some(vec![10, 20, 30, 40]);
        ring.auto_tension = Some(0.7);
        let rev = reverse_path(&ring);
        assert_eq!(rev.vertex_ids, Some(vec![10, 40, 30, 20]));
        assert_eq!(rev.vertex_kinds, Some(vec![Corner, Symmetric, Auto, Smooth]));
        assert_eq!(rev.auto_tension, Some(0.7));
        let turned = set_first_vertex(&ring, 2).unwrap();
        assert_eq!(turned.vertex_ids, Some(vec![30, 40, 10, 20]));
        assert_eq!(turned.vertex_kinds, Some(vec![Auto, Symmetric, Corner, Smooth]));
        let fewer = delete_vertices(&ring, &[1]).unwrap();
        assert_eq!(fewer.vertex_ids, Some(vec![10, 30, 40]));
        assert_eq!(fewer.vertex_kinds, Some(vec![Corner, Auto, Symmetric]));
        // A taken id is refused; a fresh one is used when given.
        assert!(insert_vertex_with_id(&ring, 0, 0.5, Some(20)).is_err());
        let one = insert_vertex_with_id(&ring, 0, 0.5, Some(77)).unwrap();
        assert_eq!(one.vertex_ids, Some(vec![10, 77, 20, 30, 40]));
        assert_eq!(fresh_id(&ring), 41);
        // Paths with no ids correspond by index and say so.
        let old = BezierPath { vertex_ids: None, vertex_kinds: None, auto_tension: None, ..ring.clone() };
        assert_eq!(ids_of(&old), vec![0, 1, 2, 3]);
        assert!(same_topology(&old, &BezierPath { vertex_ids: Some(vec![0, 1, 2, 3]), ..old.clone() }));
        assert!(!same_topology(&ring, &old));
        assert!(PathOp::Reverse.changes_topology() && !PathOp::SetVertexKind { index: 0, kind: Smooth }.changes_topology());
    }
}
