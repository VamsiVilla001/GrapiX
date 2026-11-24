//! SVG path data in and out of the contract's one path model (11.114, Pen spec v2 section 14).
//!
//! `parse` reads the `d` attribute (`M L H V C S Q T A Z`, absolute and relative, the compact number forms and
//! the packed arc flags) into cubic [`BezierPath`]s, one per subpath, with the closure each had. Quadratics are
//! raised to cubics exactly; arcs become cubics by the standard endpoint-to-centre conversion, one cubic for each
//! quarter turn at most, within about 1e-3 of a circle's radius, and the report says so. `write` gives back `M`, `L`,
//! `C` and `Z`: a segment with no handles is a `L`, any other a `C`, so a round trip keeps the outline.
//!
//! A closed subpath never keeps a duplicate last vertex: `... L x0 y0 Z` and `... C ... x0 y0 Z` both close on the
//! first vertex (the curve's handles go to the first vertex's incoming and the last vertex's outgoing).
//!
//! The fill rule is the owner's, not the path's (the Pen spec's section 4): SVG's `fill-rule` belongs to the shape that
//! takes these subpaths, as `FillRule` on `ShapeObject` does.

use crate::scene::{BezierPath, Vec2};

/// A path that cannot be read: where, and what is wrong.
#[derive(Debug, Clone, PartialEq)]
pub struct SvgPathError {
    /// The byte offset in the data the problem is at.
    pub offset: usize,
    pub message: String,
}

impl std::fmt::Display for SvgPathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "at {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for SvgPathError {}

/// What `parse` found: the subpaths and what could not be kept exactly.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedPath {
    pub subpaths: Vec<BezierPath>,
    /// One line for each kind of change made (arcs turned into cubics), empty when the path is exact.
    pub notes: Vec<String>,
}

/// Most segments one path may have: a path past it is refused rather than read.
pub const MOST_SEGMENTS: usize = 100_000;

const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

fn err<T>(offset: usize, message: impl Into<String>) -> Result<T, SvgPathError> {
    Err(SvgPathError {
        offset,
        message: message.into(),
    })
}

struct Scanner<'a> {
    text: &'a [u8],
    at: usize,
}

impl Scanner<'_> {
    fn skip_separators(&mut self) {
        while self.at < self.text.len() && (self.text[self.at].is_ascii_whitespace() || self.text[self.at] == b',') {
            self.at += 1;
        }
    }

    fn done(&mut self) -> bool {
        self.skip_separators();
        self.at >= self.text.len()
    }

    fn peek_command(&mut self) -> Option<u8> {
        self.skip_separators();
        let c = *self.text.get(self.at)?;
        c.is_ascii_alphabetic().then_some(c)
    }

    /// A number: sign, digits, a point, digits, an exponent. `1.5.5` is two numbers and `-3-4` is two.
    fn number(&mut self) -> Result<f64, SvgPathError> {
        self.skip_separators();
        let start = self.at;
        let t = self.text;
        let mut i = self.at;
        if i < t.len() && (t[i] == b'+' || t[i] == b'-') {
            i += 1;
        }
        let mut digits = 0;
        while i < t.len() && t[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
        if i < t.len() && t[i] == b'.' {
            i += 1;
            while i < t.len() && t[i].is_ascii_digit() {
                i += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return err(start, "a number was expected");
        }
        if i < t.len() && (t[i] == b'e' || t[i] == b'E') {
            let mut j = i + 1;
            if j < t.len() && (t[j] == b'+' || t[j] == b'-') {
                j += 1;
            }
            let exponent_start = j;
            while j < t.len() && t[j].is_ascii_digit() {
                j += 1;
            }
            if j > exponent_start {
                i = j;
            }
        }
        let value: f64 = std::str::from_utf8(&t[start..i])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or(SvgPathError {
                offset: start,
                message: "not a number".into(),
            })?;
        if !value.is_finite() {
            return err(start, "a number must be finite");
        }
        self.at = i;
        Ok(value)
    }

    /// An arc flag: one `0` or `1`, which may touch the next number.
    fn flag(&mut self) -> Result<bool, SvgPathError> {
        self.skip_separators();
        match self.text.get(self.at) {
            Some(b'0') => {
                self.at += 1;
                Ok(false)
            }
            Some(b'1') => {
                self.at += 1;
                Ok(true)
            }
            _ => err(self.at, "an arc flag (0 or 1) was expected"),
        }
    }

    fn point(&mut self) -> Result<(f64, f64), SvgPathError> {
        Ok((self.number()?, self.number()?))
    }
}

/// One subpath being built: its vertices with their handles as offsets.
struct Builder {
    vertices: Vec<Vec2>,
    ins: Vec<Vec2>,
    outs: Vec<Vec2>,
}

impl Builder {
    fn new(at: Vec2) -> Self {
        Self {
            vertices: vec![at],
            ins: vec![ZERO],
            outs: vec![ZERO],
        }
    }

    fn last(&self) -> Vec2 {
        *self.vertices.last().expect("a subpath has a vertex")
    }

    /// A cubic from the last vertex to `to`, with absolute control points.
    fn cubic(&mut self, c1: Vec2, c2: Vec2, to: Vec2) {
        let last = self.last();
        let n = self.vertices.len();
        self.outs[n - 1] = v(c1.x - last.x, c1.y - last.y);
        self.vertices.push(to);
        self.ins.push(v(c2.x - to.x, c2.y - to.y));
        self.outs.push(ZERO);
    }

    fn line(&mut self, to: Vec2) {
        self.vertices.push(to);
        self.ins.push(ZERO);
        self.outs.push(ZERO);
    }

    fn finish(mut self, close: bool) -> BezierPath {
        if close && self.vertices.len() > 1 {
            // A closing segment that ends on the first vertex is the closing segment itself, not another vertex.
            let n = self.vertices.len();
            let first = self.vertices[0];
            let last = self.vertices[n - 1];
            if (first.x - last.x).abs() < 1e-9 && (first.y - last.y).abs() < 1e-9 {
                self.ins[0] = self.ins[n - 1];
                self.vertices.pop();
                self.ins.pop();
                self.outs.pop();
            }
        }
        BezierPath {
            closed: close,
            vertices: self.vertices,
            in_tangents: self.ins,
            out_tangents: self.outs,
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        }
    }
}

/// The cubics of an elliptical arc from `from` to `to` (SVG's endpoint form), each at most a quarter turn.
fn arc_cubics(from: Vec2, rx: f64, ry: f64, rotation_degrees: f64, large: bool, sweep: bool, to: Vec2) -> Vec<[Vec2; 3]> {
    if (from.x - to.x).abs() < 1e-12 && (from.y - to.y).abs() < 1e-12 {
        return Vec::new();
    }
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx < 1e-12 || ry < 1e-12 {
        // A zero radius is a straight line (the SVG rule).
        return vec![[from, to, to]];
    }
    let phi = rotation_degrees.to_radians();
    let (sin_phi, cos_phi) = phi.sin_cos();
    let dx = (from.x - to.x) / 2.0;
    let dy = (from.y - to.y) / 2.0;
    let x1 = cos_phi * dx + sin_phi * dy;
    let y1 = -sin_phi * dx + cos_phi * dy;
    // Radii too small to reach are scaled up until they just do.
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut coefficient = if denominator == 0.0 { 0.0 } else { (numerator / denominator).max(0.0).sqrt() };
    if large == sweep {
        coefficient = -coefficient;
    }
    let cx1 = coefficient * (rx * y1 / ry);
    let cy1 = coefficient * -(ry * x1 / rx);
    let cx = cos_phi * cx1 - sin_phi * cy1 + (from.x + to.x) / 2.0;
    let cy = sin_phi * cx1 + cos_phi * cy1 + (from.y + to.y) / 2.0;
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| {
        let dot = ux * vx + uy * vy;
        let len = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
        let mut a = (dot / len).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 {
            a = -a;
        }
        a
    };
    let theta1 = angle(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    }
    let pieces = (delta.abs() / (std::f64::consts::FRAC_PI_2)).ceil().max(1.0) as usize;
    let step = delta / pieces as f64;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let point = |t: f64| {
        let (s, c) = t.sin_cos();
        v(cx + rx * c * cos_phi - ry * s * sin_phi, cy + rx * c * sin_phi + ry * s * cos_phi)
    };
    let derivative = |t: f64| {
        let (s, c) = t.sin_cos();
        v(-rx * s * cos_phi - ry * c * sin_phi, -rx * s * sin_phi + ry * c * cos_phi)
    };
    (0..pieces)
        .map(|i| {
            let (t0, t1) = (theta1 + step * i as f64, theta1 + step * (i + 1) as f64);
            let (p0, p3) = (if i == 0 { from } else { point(t0) }, if i + 1 == pieces { to } else { point(t1) });
            let (d0, d1) = (derivative(t0), derivative(t1));
            [v(p0.x + k * d0.x, p0.y + k * d0.y), v(p3.x - k * d1.x, p3.y - k * d1.y), p3]
        })
        .collect()
}

/// Read an SVG path's `d` data.
pub fn parse(data: &str) -> Result<ParsedPath, SvgPathError> {
    let mut s = Scanner { text: data.as_bytes(), at: 0 };
    let mut out = ParsedPath::default();
    let mut current: Option<Builder> = None;
    let mut cursor = ZERO;
    let mut start = ZERO;
    // The control point of the last cubic or quadratic, for the smooth commands that reflect it.
    let mut last_cubic: Option<Vec2> = None;
    let mut last_quad: Option<Vec2> = None;
    let mut command = 0u8;
    let mut segments = 0usize;
    let mut arcs = false;
    if s.done() {
        return Ok(out);
    }
    while !s.done() {
        let at = s.at;
        if let Some(letter) = s.peek_command() {
            command = letter;
            s.at += 1;
        } else if command == 0 {
            return err(at, "a path starts with M");
        } else if matches!(command, b'Z' | b'z') {
            return err(at, "numbers cannot follow Z without a new command");
        }
        let relative = command.is_ascii_lowercase();
        let upper = command.to_ascii_uppercase();
        if current.is_none() && upper != b'M' {
            return err(at, "a path starts with M");
        }
        segments += 1;
        if segments > MOST_SEGMENTS {
            return err(at, format!("more than {MOST_SEGMENTS} segments"));
        }
        let abs = |p: (f64, f64), from: Vec2| if relative { v(from.x + p.0, from.y + p.1) } else { v(p.0, p.1) };
        match upper {
            b'M' => {
                if let Some(b) = current.take() {
                    out.subpaths.push(b.finish(false));
                }
                let p = abs(s.point()?, cursor);
                cursor = p;
                start = p;
                current = Some(Builder::new(p));
                // The numbers that follow a moveto are linetos.
                command = if relative { b'l' } else { b'L' };
                last_cubic = None;
                last_quad = None;
            }
            b'L' | b'H' | b'V' => {
                let to = match upper {
                    b'L' => abs(s.point()?, cursor),
                    b'H' => {
                        let x = s.number()?;
                        v(if relative { cursor.x + x } else { x }, cursor.y)
                    }
                    _ => {
                        let y = s.number()?;
                        v(cursor.x, if relative { cursor.y + y } else { y })
                    }
                };
                current.as_mut().expect("started").line(to);
                cursor = to;
                last_cubic = None;
                last_quad = None;
            }
            b'C' | b'S' => {
                let c1 = if upper == b'C' {
                    abs(s.point()?, cursor)
                } else {
                    // The first control point of S is the last cubic's second one, reflected through the current point.
                    last_cubic.map_or(cursor, |c| v(2.0 * cursor.x - c.x, 2.0 * cursor.y - c.y))
                };
                let c2 = abs(s.point()?, cursor);
                let to = abs(s.point()?, cursor);
                current.as_mut().expect("started").cubic(c1, c2, to);
                cursor = to;
                last_cubic = Some(c2);
                last_quad = None;
            }
            b'Q' | b'T' => {
                let q = if upper == b'Q' {
                    abs(s.point()?, cursor)
                } else {
                    last_quad.map_or(cursor, |c| v(2.0 * cursor.x - c.x, 2.0 * cursor.y - c.y))
                };
                let to = abs(s.point()?, cursor);
                // A quadratic is a cubic exactly: controls two thirds of the way to the quadratic's.
                let c1 = v(cursor.x + 2.0 / 3.0 * (q.x - cursor.x), cursor.y + 2.0 / 3.0 * (q.y - cursor.y));
                let c2 = v(to.x + 2.0 / 3.0 * (q.x - to.x), to.y + 2.0 / 3.0 * (q.y - to.y));
                current.as_mut().expect("started").cubic(c1, c2, to);
                cursor = to;
                last_quad = Some(q);
                last_cubic = None;
            }
            b'A' => {
                let (rx, ry) = s.point()?;
                let rotation = s.number()?;
                let large = s.flag()?;
                let sweep = s.flag()?;
                let to = abs(s.point()?, cursor);
                let builder = current.as_mut().expect("started");
                if (cursor.x - to.x).abs() > 1e-12 || (cursor.y - to.y).abs() > 1e-12 {
                    arcs = true;
                    for [c1, c2, p3] in arc_cubics(cursor, rx, ry, rotation, large, sweep, to) {
                        if c1 == cursor && c2 == p3 && p3 == to && (rx.abs() < 1e-12 || ry.abs() < 1e-12) {
                            builder.line(p3);
                        } else {
                            builder.cubic(c1, c2, p3);
                        }
                    }
                }
                cursor = to;
                last_cubic = None;
                last_quad = None;
            }
            b'Z' => {
                if let Some(b) = current.take() {
                    out.subpaths.push(b.finish(true));
                }
                cursor = start;
                // After a closepath the next subpath starts where the last began, as SVG says.
                current = None;
                last_cubic = None;
                last_quad = None;
                // A command letter other than M after Z starts from `start`.
                if let Some(next) = s.peek_command() {
                    if !matches!(next, b'M' | b'm') {
                        current = Some(Builder::new(start));
                    }
                }
            }
            other => return err(at, format!("{} is not a path command", other as char)),
        }
    }
    if let Some(b) = current.take() {
        out.subpaths.push(b.finish(false));
    }
    if arcs {
        out.notes.push("arcs were turned into cubic curves, within 0.001 of the arc's radius".into());
    }
    Ok(out)
}

fn number(x: f64) -> String {
    // Six decimals is below a thousandth of a pixel; trailing zeros and a bare point are dropped.
    let mut text = format!("{x:.6}");
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    if text == "-0" {
        text = "0".into();
    }
    text
}

/// The path data for subpaths: `M`, then `L` for a segment with no handles and `C` for any other, `Z` for a closed one.
pub fn write(paths: &[BezierPath]) -> String {
    let mut out = String::new();
    for path in paths {
        let n = path.vertices.len();
        if n == 0 {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&format!("M{} {}", number(path.vertices[0].x), number(path.vertices[0].y)));
        let segments = if path.closed { n } else { n.saturating_sub(1) };
        for i in 0..segments {
            let j = (i + 1) % n;
            let (a, b) = (path.vertices[i], path.vertices[j]);
            let (out_t, in_t) = (path.out_tangents[i], path.in_tangents[j]);
            let straight = out_t.x == 0.0 && out_t.y == 0.0 && in_t.x == 0.0 && in_t.y == 0.0;
            // A closed path's last segment, when straight, is the Z itself.
            if path.closed && i + 1 == n && straight {
                continue;
            }
            if straight {
                out.push_str(&format!(" L{} {}", number(b.x), number(b.y)));
            } else {
                out.push_str(&format!(
                    " C{} {} {} {} {} {}",
                    number(a.x + out_t.x),
                    number(a.y + out_t.y),
                    number(b.x + in_t.x),
                    number(b.y + in_t.y),
                    number(b.x),
                    number(b.y)
                ));
            }
        }
        if path.closed {
            out.push('Z');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    fn same(a: &BezierPath, b: &BezierPath) -> bool {
        a.closed == b.closed
            && a.vertices.len() == b.vertices.len()
            && (0..a.vertices.len()).all(|i| {
                close(a.vertices[i].x, b.vertices[i].x)
                    && close(a.vertices[i].y, b.vertices[i].y)
                    && close(a.in_tangents[i].x, b.in_tangents[i].x)
                    && close(a.in_tangents[i].y, b.in_tangents[i].y)
                    && close(a.out_tangents[i].x, b.out_tangents[i].x)
                    && close(a.out_tangents[i].y, b.out_tangents[i].y)
            })
    }

    fn one(d: &str) -> BezierPath {
        let parsed = parse(d).unwrap_or_else(|e| panic!("{d}: {e}"));
        assert_eq!(parsed.subpaths.len(), 1, "{d}");
        parsed.subpaths.into_iter().next().unwrap()
    }

    #[test]
    fn lines_close_without_a_duplicate_vertex() {
        let square = one("M0 0 L10 0 L10 10 L0 10 Z");
        assert!(square.closed);
        assert_eq!(square.vertices.len(), 4);
        // A closing lineto onto the first point is the same square.
        assert!(same(&square, &one("M0 0 L10 0 L10 10 L0 10 L0 0 Z")));
        // Relative commands, H and V, and the lineto that follows a moveto.
        assert!(same(&square, &one("m0 0 10 0 v10 h-10 z")));
        assert!(same(&square, &one("M 0,0 H10 V10 H0 Z")));
    }

    #[test]
    fn numbers_may_touch_and_flags_may_pack() {
        assert!(same(&one("M0 0L1.5.5-3-4"), &one("M0 0 L1.5 .5 L-3 -4")));
        assert!(same(&one("M1e1 2E+1 L-1e-1 0"), &one("M10 20 L-0.1 0")));
        // Flags written without separators: "a1 1 0 00 1 1".
        let packed = parse("M0 0 a1 1 0 001 1").unwrap();
        let spaced = parse("M0 0 a1 1 0 0 0 1 1").unwrap();
        assert_eq!(packed, spaced);
    }

    #[test]
    fn cubics_keep_their_handles_as_offsets_and_smooth_ones_reflect() {
        let path = one("M0 0 C10 0 20 10 30 10 S50 20 60 10");
        assert_eq!(path.vertices.len(), 3);
        assert_eq!(path.out_tangents[0], v(10.0, 0.0));
        assert_eq!(path.in_tangents[1], v(-10.0, 0.0));
        // S reflects the last control point (20,10) through (30,10): (40,10), an offset of (10,0).
        assert_eq!(path.out_tangents[1], v(10.0, 0.0));
        assert_eq!(path.in_tangents[2], v(-10.0, 10.0));
    }

    #[test]
    fn quadratics_become_the_same_curve_as_cubics() {
        let q = one("M0 0 Q30 60 60 0");
        // Control points two thirds of the way to (30,60) from each end.
        assert!(close(q.out_tangents[0].x, 20.0) && close(q.out_tangents[0].y, 40.0));
        assert!(close(q.in_tangents[1].x, -20.0) && close(q.in_tangents[1].y, 40.0));
        // T reflects the quadratic's control point: M0 0 Q30 60 60 0 T120 0 has its second control at (90,-60).
        let t = one("M0 0 Q30 60 60 0 T120 0");
        assert_eq!(t.vertices.len(), 3);
        assert!(close(t.out_tangents[1].y, -40.0));
    }

    #[test]
    fn an_arc_is_a_circle_within_a_thousandth() {
        // Half a circle of radius 50 centred on (50,0): the cubics' points stay 50 from the centre.
        let path = one("M0 0 A50 50 0 0 1 100 0");
        assert!(path.vertices.len() >= 3, "a half turn is two quarter turns at least");
        let mut worst = 0.0_f64;
        for i in 0..path.vertices.len() - 1 {
            let (p0, p3) = (path.vertices[i], path.vertices[i + 1]);
            let (c1, c2) = (v(p0.x + path.out_tangents[i].x, p0.y + path.out_tangents[i].y), v(p3.x + path.in_tangents[i + 1].x, p3.y + path.in_tangents[i + 1].y));
            for k in 0..=20 {
                let t = f64::from(k) / 20.0;
                let u = 1.0 - t;
                let x = u * u * u * p0.x + 3.0 * u * u * t * c1.x + 3.0 * u * t * t * c2.x + t * t * t * p3.x;
                let y = u * u * u * p0.y + 3.0 * u * u * t * c1.y + 3.0 * u * t * t * c2.y + t * t * t * p3.y;
                worst = worst.max((((x - 50.0).powi(2) + y * y).sqrt() - 50.0).abs());
            }
        }
        assert!(worst < 0.001 * 50.0, "worst {worst}");
        let end = path.vertices.last().unwrap();
        assert!(close(end.x, 100.0) && close(end.y, 0.0));
        assert!(parse("M0 0 A50 50 0 0 1 100 0").unwrap().notes[0].contains("arcs"));
        // The sweep flag picks the side: sweep 0 bulges the other way.
        let other = one("M0 0 A50 50 0 0 0 100 0");
        assert!(path.vertices[1].y * other.vertices[1].y < 0.0);
        // A radius too small is scaled up; a zero radius is a line.
        assert_eq!(one("M0 0 A1 1 0 0 1 100 0").vertices.last().unwrap(), &v(100.0, 0.0));
        assert_eq!(one("M0 0 A0 5 0 0 1 10 10").vertices.len(), 2);
    }

    #[test]
    fn several_subpaths_and_a_hole_come_out_in_order() {
        let parsed = parse("M0 0 L100 0 L100 100 L0 100 Z M25 25 L25 75 L75 75 L75 25 Z M200 0 L300 0").unwrap();
        assert_eq!(parsed.subpaths.len(), 3);
        assert!(parsed.subpaths[0].closed && parsed.subpaths[1].closed && !parsed.subpaths[2].closed);
        // After a Z a command that is not M starts from where the subpath began.
        let again = parse("M10 10 L20 10 L20 20 Z L50 50").unwrap();
        assert_eq!(again.subpaths.len(), 2);
        assert_eq!(again.subpaths[1].vertices[0], v(10.0, 10.0));
    }

    #[test]
    fn what_is_not_a_path_is_refused_with_where() {
        assert_eq!(parse("").unwrap(), ParsedPath::default());
        for (data, why) in [
            ("L10 10", "starts with M"),
            ("M0", "number was expected"),
            ("M0 0 X5", "not a path command"),
            ("M0 0 L1e999 0", "finite"),
            ("M0 0 A5 5 0 2 0 1 1", "flag"),
            ("M0 0 Z 5 5", "cannot follow Z"),
            ("M0 0 L 3", "number was expected"),
        ] {
            let e = parse(data).unwrap_err();
            assert!(e.message.contains(why), "{data}: {e}");
            assert!(e.offset <= data.len());
        }
    }

    #[test]
    fn writing_gives_l_for_straight_and_c_for_curved_and_reads_back_the_same() {
        let wave = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(100.0, 40.0), v(200.0, 0.0)],
            in_tangents: vec![ZERO, v(-30.0, -10.0), ZERO],
            out_tangents: vec![v(20.0, 5.0), v(30.0, 10.0), ZERO],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        let text = write(std::slice::from_ref(&wave));
        assert!(text.starts_with("M0 0 C20 5 70 30 100 40 C130 50 200 0 200 0"), "{text}");
        assert!(same(&wave, &one(&text)));
        let tri = BezierPath { closed: true, vertices: vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0)], in_tangents: vec![ZERO; 3], out_tangents: vec![ZERO; 3], vertex_ids: None, vertex_kinds: None, auto_tension: None };
        assert_eq!(write(std::slice::from_ref(&tri)), "M0 0 L10 0 L10 10Z");
        // A closed path whose closing segment is curved keeps it: C back to the first vertex, then Z.
        let loop_ = BezierPath { closed: true, vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(100.0, 100.0)], in_tangents: vec![v(0.0, -30.0), ZERO, ZERO], out_tangents: vec![ZERO, ZERO, v(0.0, 30.0)], vertex_ids: None, vertex_kinds: None, auto_tension: None };
        let text = write(std::slice::from_ref(&loop_));
        assert!(text.contains("C100 130 0 -30 0 0Z"), "{text}");
        assert!(same(&loop_, &one(&text)));
        assert_eq!(write(&[]), "");
    }

    /// The fixture the Editor's TypeScript `writeSvgPath` is held to. Rewritten with `GX_WRITE_FIXTURES=1`.
    #[test]
    fn the_shared_fixture_holds_the_writers_answers() {
        let wave = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0), v(100.0, 40.0), v(200.0, 0.0)],
            in_tangents: vec![ZERO, v(-30.0, -10.0), ZERO],
            out_tangents: vec![v(20.0, 5.0), v(30.0, 10.0), ZERO],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        let tri = BezierPath { closed: true, vertices: vec![v(0.0, 0.0), v(10.5, 0.0), v(10.5, -10.25)], in_tangents: vec![ZERO; 3], out_tangents: vec![ZERO; 3], vertex_ids: None, vertex_kinds: None, auto_tension: None };
        let loop_ = BezierPath { closed: true, vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(100.0, 100.0)], in_tangents: vec![v(0.0, -30.0), ZERO, ZERO], out_tangents: vec![ZERO, ZERO, v(0.0, 30.0)], vertex_ids: None, vertex_kinds: None, auto_tension: None };
        let fine = BezierPath { closed: false, vertices: vec![v(0.1234567891, -0.0000004), v(1e-7, 2.5)], in_tangents: vec![ZERO; 2], out_tangents: vec![ZERO; 2], vertex_ids: None, vertex_kinds: None, auto_tension: None };
        let cases = [vec![wave.clone()], vec![tri.clone()], vec![loop_.clone()], vec![tri, wave.clone()], vec![fine], vec![]];
        let entries: Vec<serde_json::Value> = cases
            .iter()
            .map(|paths| serde_json::json!({ "paths": paths, "d": write(paths) }))
            .collect();
        let text = serde_json::to_string_pretty(&serde_json::json!({ "cases": entries })).unwrap() + "
";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/svg-path.json");
        if std::env::var_os("GX_WRITE_FIXTURES").is_some() {
            std::fs::write(&path, &text).unwrap();
        }
        let on_disk = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
        assert_eq!(on_disk, text, "run with GX_WRITE_FIXTURES=1 to rewrite fixtures/svg-path.json");
    }

    #[test]
    fn random_paths_survive_a_round_trip() {
        // A small deterministic generator; no crate for it.
        let mut state = 0x2545_F491_4F6C_DD1D_u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        for case in 0..200 {
            let n = 2 + (next() * 8.0) as usize;
            let closed = n >= 3 && next() < 0.5;
            let pt = |r: f64| (r * 2000.0 - 1000.0 * 1.0).round() / 8.0;
            let vertices: Vec<Vec2> = (0..n).map(|_| v(pt(next()), pt(next()))).collect();
            let handle = |next: &mut dyn FnMut() -> f64| if next() < 0.4 { ZERO } else { v(pt(next()) / 4.0, pt(next()) / 4.0) };
            let mut in_tangents: Vec<Vec2> = (0..n).map(|_| handle(&mut next)).collect();
            let mut out_tangents: Vec<Vec2> = (0..n).map(|_| handle(&mut next)).collect();
            if !closed {
                // The outer handle of each end of an open path has no segment to shape: it is not kept.
                in_tangents[0] = ZERO;
                out_tangents[n - 1] = ZERO;
            }
            let path = BezierPath { closed, vertices, in_tangents, out_tangents, vertex_ids: None, vertex_kinds: None, auto_tension: None };
            let back = parse(&write(std::slice::from_ref(&path))).unwrap();
            assert_eq!(back.subpaths.len(), 1, "case {case}");
            assert!(same(&path, &back.subpaths[0]), "case {case}: {path:?} vs {:?}", back.subpaths[0]);
        }
    }
}
