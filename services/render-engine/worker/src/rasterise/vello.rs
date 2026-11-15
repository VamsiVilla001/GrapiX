//! The CPU drawing backend (3.17, user decision 15 Nov 2026): Vello CPU 0.3,
//! the same sparse-strip family as the GPU backend `vello_gpu`.
//!
//! Vello is asked for coverage only. Each path is filled in opaque white, and
//! the alpha it leaves is that pixel's coverage. The path's paint, already in
//! the scene's working space, is then composited in float, scaled by that
//! coverage. Colour therefore never passes through Vello's 8-bit sRGB
//! pipeline (3.15). The GPU backend does exactly the same with `vello_gpu`,
//! over the same coverage window, so the two agree to one code value.

use super::{PathRasteriser, PreparedPath, RasterSurface};
use vello_cpu::kurbo::Affine;
use vello_cpu::peniko::color::palette::css::WHITE;

/// The CPU drawing backend. Stateless: every call builds its own context.
#[derive(Debug, Default, Clone, Copy)]
pub struct VelloCpuRasteriser;

/// The pixel window of `path` on a surface of `width` x `height` whose first
/// pixel is at scene point `origin`: `(x, y, w, h)` in surface pixels, `None`
/// when the path covers none of it. Both drawing backends use this window,
/// and its integer offset, for the same path.
pub(crate) fn coverage_window(
    path: &PreparedPath,
    origin: [f64; 2],
    width: u32,
    height: u32,
) -> Option<(u32, u32, u32, u32)> {
    let b = path.bounds();
    if !(b.min_x.is_finite() && b.min_y.is_finite() && b.max_x.is_finite() && b.max_y.is_finite()) {
        return None;
    }
    let span = |lo: f32, hi: f32, origin: f64, size: u32| -> Option<(u32, u32)> {
        let size = f64::from(size);
        // One pixel of slack each side: coverage reaches the pixel a boundary
        // touches.
        let first = (f64::from(lo) - origin).floor() - 1.0;
        let end = (f64::from(hi) - origin).ceil() + 1.0;
        let (first, end) = (first.clamp(0.0, size), end.clamp(0.0, size));
        (end > first).then_some((first as u32, (end - first) as u32))
    };
    let (x, w) = span(b.min_x, b.max_x, origin[0], width)?;
    let (y, h) = span(b.min_y, b.max_y, origin[1], height)?;
    Some((x, y, w, h))
}

/// The transform from scene coordinates to a coverage window's pixels.
pub(crate) fn window_transform(origin: [f64; 2], window: (u32, u32, u32, u32)) -> Affine {
    Affine::translate((
        -(origin[0] + f64::from(window.0)),
        -(origin[1] + f64::from(window.1)),
    ))
}

impl PathRasteriser for VelloCpuRasteriser {
    fn rasterise_into(&self, paths: &[&PreparedPath], surface: &mut RasterSurface) {
        let origin = surface.origin();
        for path in paths {
            let paint = path.paint();
            if paint.a <= 0.0 {
                continue;
            }
            let Some(window) = coverage_window(path, origin, surface.width(), surface.height())
            else {
                continue;
            };
            let (x0, y0, w, h) = window;
            // Surfaces are bounded by the device texture limit (at most 16384)
            // and canvases by u16; a window never exceeds either.
            let (Ok(w16), Ok(h16)) = (u16::try_from(w), u16::try_from(h)) else {
                continue;
            };
            let mut ctx = vello_cpu::RenderContext::new(w16, h16);
            ctx.set_transform(window_transform(origin, window));
            ctx.set_fill_rule(path.fill_rule());
            ctx.set_paint(WHITE);
            ctx.fill_path(path.outline());
            ctx.flush();
            let mut pixmap = vello_cpu::Pixmap::new(w16, h16);
            ctx.render(&mut pixmap, &mut vello_cpu::Resources::new());
            let bytes = pixmap.data_as_u8_slice();
            for j in 0..h {
                for i in 0..w {
                    let coverage = bytes[((j * w + i) * 4 + 3) as usize];
                    if coverage != 0 {
                        surface.composite(
                            x0 + i,
                            y0 + j,
                            paint.scaled(f32::from(coverage) / 255.0),
                        );
                    }
                }
            }
        }
    }
}
