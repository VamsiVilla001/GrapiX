//! The CPU drawing backend (3.17, user decision 15 Nov 2026): Vello CPU 0.3,
//! the same sparse-strip family as the GPU backend `vello_gpu`.
//!
//! Vello is asked for coverage only. Each path is filled in opaque white, and
//! the alpha it leaves is that pixel's coverage. The path's paint, already in
//! the scene's working space, is then composited in float, scaled by that
//! coverage. Colour therefore never passes through Vello's 8-bit sRGB
//! pipeline (3.15). The GPU backend does exactly the same with `vello_gpu`,
//! over the same coverage window, so the two agree to one code value.

use super::{PathPaint, PathRasteriser, PreparedPath, RasterSurface};
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

/// The scene point of a coverage window's first pixel corner.
pub(crate) fn window_origin(origin: [f64; 2], window: (u32, u32, u32, u32)) -> [f64; 2] {
    [
        origin[0] + f64::from(window.0),
        origin[1] + f64::from(window.1),
    ]
}

/// The transform from scene coordinates to a coverage window's pixels.
pub(crate) fn window_transform(origin: [f64; 2], window: (u32, u32, u32, u32)) -> Affine {
    Affine::translate((
        -(origin[0] + f64::from(window.0)),
        -(origin[1] + f64::from(window.1)),
    ))
}

/// The transform from scene coordinates to a path's cell on a coverage sheet
/// (11.61): the window's own transform, moved by whole pixels to the cell. At
/// (0, 0), where a path drawn alone is, it is that transform untouched.
pub(crate) fn cell_transform(
    origin: [f64; 2],
    window: (u32, u32, u32, u32),
    at: (u32, u32),
) -> Affine {
    let transform = window_transform(origin, window);
    if at == (0, 0) {
        transform
    } else {
        transform.then_translate((f64::from(at.0), f64::from(at.1)).into())
    }
}

/// 11.61: the side, in pixels, of a coverage sheet that instance paths share.
pub(crate) const SHEET_SIDE: u32 = 2048;

/// One coverage target (11.61).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Sheet {
    pub width: u32,
    pub height: u32,
    /// Holds the cells of several instance paths; otherwise it is one path's
    /// own window, the drawing as it was before 11.61.
    pub shared: bool,
}

/// Where one path's coverage is drawn (11.61).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Placement {
    /// The path's place in the list the plan was made from.
    pub path: usize,
    /// The path's coverage window on the region: x, y, width, height.
    pub window: (u32, u32, u32, u32),
    /// The sheet its coverage is drawn into.
    pub sheet: usize,
    /// The corner of its cell on that sheet.
    pub at: (u32, u32),
}

/// Where every drawn path of a region has its coverage, in drawing order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct CoveragePlan {
    pub sheets: Vec<Sheet>,
    pub placements: Vec<Placement>,
}

/// Plan the coverage of `paths` over a region (11.61). Both drawing backends
/// draw from this one plan, so their coverage is of the same numbers.
///
/// A path that is not an instance path is drawn alone, in a sheet the size of
/// its window: the drawing as it was. The instance paths of the region (the
/// glyph clusters of an animated text) share sheets, one cell each, so one
/// render fills them all.
///
/// Moving a path by whole pixels changes how its coordinates round in f32, so
/// where a cell is decides the last coverage step of a few edge pixels. A cell
/// is therefore placed by nothing a frame or a region can change by accident:
/// it is slot `k` of a grid, `k` being the path's place among the instance
/// paths whether or not they are visible or inside the region, and the grid's
/// pitch is the next power of two above the largest of their windows before
/// the region clamps it. So a glyph that does not move keeps its cell when a
/// neighbour's paint changes, and the CPU reference drawing onto the canvas
/// and the GPU drawing into a layer of its own place the same glyph in the
/// same cell. A path the region cuts keeps its slot but is drawn alone (the
/// edge of its own sheet is what cuts it). With `share` off every path is
/// drawn alone.
pub(crate) fn plan_coverage(
    paths: &[&PreparedPath],
    origin: [f64; 2],
    width: u32,
    height: u32,
    side: u32,
    share: bool,
) -> CoveragePlan {
    // A path's size before the region clamps it, with the pixel of slack each
    // side that `coverage_window` gives it; `None` for a path without bounds.
    let unclamped = |path: &PreparedPath| -> Option<(u32, u32)> {
        let b = path.bounds();
        if !(b.min_x.is_finite() && b.min_y.is_finite() && b.max_x.is_finite() && b.max_y.is_finite()) {
            return None;
        }
        let size = |lo: f32, hi: f32, origin: f64| {
            (f64::from(hi) - origin).ceil() + 1.0 - ((f64::from(lo) - origin).floor() - 1.0)
        };
        let (w, h) = (size(b.min_x, b.max_x, origin[0]), size(b.min_y, b.max_y, origin[1]));
        (w >= 1.0 && h >= 1.0 && w <= f64::from(side) && h <= f64::from(side)).then_some((w as u32, h as u32))
    };
    // The instance paths that fit a cell, and the grid they share.
    let shares = |path: &PreparedPath| if share && path.instance() { unclamped(path) } else { None };
    let largest = paths.iter().filter_map(|path| shares(path)).map(|(w, h)| w.max(h)).max();
    let pitch = largest.map_or(side, |size| size.next_power_of_two().min(side)).max(1);
    let columns = (side / pitch).max(1);
    let cells_on_a_sheet = columns * columns;

    let mut plan = CoveragePlan::default();
    // The plan's sheet for each shared sheet that has a drawn cell.
    let mut shared_sheets: Vec<Option<usize>> = Vec::new();
    let mut slot = 0_u32;
    for (index, path) in paths.iter().enumerate() {
        let cell = shares(path).map(|size| {
            let k = slot;
            slot += 1;
            let on_sheet = k % cells_on_a_sheet;
            (size, (k / cells_on_a_sheet) as usize, ((on_sheet % columns) * pitch, (on_sheet / columns) * pitch))
        });
        if !path.paint().visible() {
            continue;
        }
        let Some(window) = coverage_window(path, origin, width, height) else {
            continue;
        };
        let (_, _, w, h) = window;
        match cell {
            // Whole inside the region: drawn in its cell.
            Some((size, shared, at)) if size == (w, h) => {
                if shared_sheets.len() <= shared {
                    shared_sheets.resize(shared + 1, None);
                }
                let sheet = *shared_sheets[shared].get_or_insert_with(|| {
                    plan.sheets.push(Sheet { width: 0, height: 0, shared: true });
                    plan.sheets.len() - 1
                });
                plan.sheets[sheet].width = plan.sheets[sheet].width.max(at.0 + w);
                plan.sheets[sheet].height = plan.sheets[sheet].height.max(at.1 + h);
                plan.placements.push(Placement { path: index, window, sheet, at });
            }
            _ => {
                plan.sheets.push(Sheet { width: w, height: h, shared: false });
                plan.placements.push(Placement { path: index, window, sheet: plan.sheets.len() - 1, at: (0, 0) });
            }
        }
    }
    plan
}

impl PathRasteriser for VelloCpuRasteriser {
    fn rasterise_into(&self, paths: &[&PreparedPath], surface: &mut RasterSurface) {
        rasterise_with(paths, surface, SHEET_SIDE, true);
    }
}

/// [`VelloCpuRasteriser`]'s drawing, with the sheet side and the sharing of
/// sheets stated: tests draw path by path (`share` off) to compare.
pub(crate) fn rasterise_with(
    paths: &[&PreparedPath],
    surface: &mut RasterSurface,
    side: u32,
    share: bool,
) {
    let origin = surface.origin();
    let plan = plan_coverage(paths, origin, surface.width(), surface.height(), side, share);
    // A shared sheet is rendered when its first path is reached, and kept; a
    // path's own sheet is rendered and dropped with it.
    let mut kept: std::collections::HashMap<usize, vello_cpu::Pixmap> = std::collections::HashMap::new();
    for (k, placement) in plan.placements.iter().enumerate() {
        let sheet = plan.sheets[placement.sheet];
        // Surfaces are bounded by the device texture limit (at most 16384)
        // and canvases by u16; a window never exceeds either, and a shared
        // sheet is at most `side`.
        let (Ok(w16), Ok(h16)) = (u16::try_from(sheet.width), u16::try_from(sheet.height)) else {
            continue;
        };
        let pixmap = match kept.remove(&placement.sheet) {
            Some(pixmap) => pixmap,
            None => {
                let mut ctx = vello_cpu::RenderContext::new(w16, h16);
                // Every path of this sheet: its placements are this one and later ones.
                for cell in plan.placements[k..].iter().filter(|cell| cell.sheet == placement.sheet) {
                    let path = paths[cell.path];
                    ctx.set_transform(cell_transform(origin, cell.window, cell.at));
                    ctx.set_fill_rule(path.fill_rule());
                    ctx.set_paint(WHITE);
                    if let Some(clip) = path.clip() {
                        ctx.push_clip_layer(clip);
                    }
                    ctx.fill_path(path.outline());
                    if path.clip().is_some() {
                        ctx.pop_layer();
                    }
                }
                ctx.flush();
                let mut pixmap = vello_cpu::Pixmap::new(w16, h16);
                ctx.render(&mut pixmap, &mut vello_cpu::Resources::new());
                pixmap
            }
        };
        let path = paths[placement.path];
        let paint = path.paint();
        let window = placement.window;
        let (x0, y0, w, h) = window;
        let (cell_x, cell_y) = placement.at;
        let bytes = pixmap.data_as_u8_slice();
        let rows = match paint {
            PathPaint::Gradient(g) => Some(g.window_rows(window_origin(origin, window))),
            PathPaint::Solid(_) => None,
        };
        for j in 0..h {
            for i in 0..w {
                let coverage = bytes[(((cell_y + j) * sheet.width + cell_x + i) * 4 + 3) as usize];
                if coverage != 0 {
                    let colour = match (paint, &rows) {
                        (PathPaint::Solid(colour), _) => *colour,
                        (PathPaint::Gradient(g), Some(rows)) => g.colour(rows, i, j),
                        (PathPaint::Gradient(_), None) => unreachable!("rows built above"),
                    };
                    surface.composite(
                        x0 + i,
                        y0 + j,
                        colour.scaled(f32::from(coverage) / 255.0),
                    );
                }
            }
        }
        if sheet.shared {
            kept.insert(placement.sheet, pixmap);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::colour_pipeline::WorkingRgba;
    use crate::rasterise::OutlineFill;
    use vello_cpu::kurbo::{Circle, Shape};

    fn glyph(x: f64, y: f64, radius: f64, alpha: f32) -> PreparedPath {
        PreparedPath::new(
            "text".into(),
            PathPaint::Solid(WorkingRgba { r: alpha, g: alpha, b: alpha, a: alpha }),
            Circle::new((x, y), radius).to_path(0.01),
            OutlineFill::NonZero,
        )
        .instanced()
    }

    /// 11.61: a cell is a grid slot by the path's place among the instance paths, so it does not move when another path turns
    /// invisible, leaves the region or is cut by it, nor with where the region is; paths that are not instances are drawn alone.
    #[test]
    fn a_cell_depends_on_nothing_a_frame_or_a_region_changes_by_accident() {
        let plate = PreparedPath::new(
            "text".into(),
            PathPaint::Solid(WorkingRgba { r: 0.2, g: 0.2, b: 0.2, a: 0.5 }),
            Circle::new((60.0, 40.0), 30.0).to_path(0.01),
            OutlineFill::NonZero,
        );
        let glyphs = |alpha_of_first: f32, x_of_first: f64| {
            vec![
                glyph(x_of_first, 20.3, 6.0, alpha_of_first),
                plate.clone(),
                glyph(40.7, 20.3, 6.0, 0.8),
                glyph(60.2, 21.9, 9.0, 0.8),
                glyph(80.5, 20.3, 6.0, 0.8),
            ]
        };
        let cells = |paths: &[PreparedPath], origin: [f64; 2], width: u32, height: u32| {
            let refs: Vec<&PreparedPath> = paths.iter().collect();
            let plan = plan_coverage(&refs, origin, width, height, SHEET_SIDE, true);
            let placed: Vec<(usize, bool, (u32, u32))> = plan
                .placements
                .iter()
                .map(|p| (p.path, plan.sheets[p.sheet].shared, p.at))
                .collect();
            (plan, placed)
        };
        let (plan, base) = cells(&glyphs(0.8, 20.4), [0.0, 0.0], 120, 60);
        // The largest glyph window is 21 pixels (radius 9, a pixel of slack each side): a pitch of 32.
        assert_eq!(
            base,
            vec![(0, true, (0, 0)), (1, false, (0, 0)), (2, true, (32, 0)), (3, true, (64, 0)), (4, true, (96, 0))]
        );
        assert_eq!(plan.sheets.iter().filter(|sheet| sheet.shared).count(), 1, "the four glyphs share one sheet");
        let shared = plan.sheets.iter().find(|sheet| sheet.shared).unwrap();
        // The last cell is at 96 and its glyph (radius 6) is 15 wide; the tallest glyph (radius 9) is 21.
        assert_eq!((shared.width, shared.height), (96 + 15, 21), "the sheet is as large as its drawn cells");

        // The first glyph invisible, off the region, or cut by it: the others keep their cells.
        let later = |placed: &[(usize, bool, (u32, u32))]| placed.iter().filter(|p| p.0 >= 2).copied().collect::<Vec<_>>();
        let (_, invisible) = cells(&glyphs(0.0, 20.4), [0.0, 0.0], 120, 60);
        assert!(invisible.iter().all(|p| p.0 != 0), "an invisible path is not drawn");
        assert_eq!(later(&invisible), later(&base));
        let (_, away) = cells(&glyphs(0.8, -500.0), [0.0, 0.0], 120, 60);
        assert!(away.iter().all(|p| p.0 != 0), "a path off the region is not drawn");
        assert_eq!(later(&away), later(&base));
        let (_, cut) = cells(&glyphs(0.8, 2.0), [0.0, 0.0], 120, 60);
        assert_eq!(cut[0], (0, false, (0, 0)), "a path the region cuts is drawn alone");
        assert_eq!(later(&cut), later(&base));
        // Another region over the same paths (a layer of its own, a whole number of pixels away): the same cells.
        let (_, moved) = cells(&glyphs(0.8, 20.4), [-7.0, -3.0], 300, 200);
        assert_eq!(moved, base);

        // Sharing off: every path alone, as before 11.61.
        let paths = glyphs(0.8, 20.4);
        let refs: Vec<&PreparedPath> = paths.iter().collect();
        let alone = plan_coverage(&refs, [0.0, 0.0], 120, 60, SHEET_SIDE, false);
        assert!(alone.placements.iter().all(|p| p.at == (0, 0) && !alone.sheets[p.sheet].shared));
        assert_eq!(alone.sheets.len(), 5);
        // A small sheet: more cells than one sheet holds go to the next.
        let small = plan_coverage(&refs, [0.0, 0.0], 120, 60, 64, true);
        let sheets: Vec<usize> = small.placements.iter().filter(|p| small.sheets[p.sheet].shared).map(|p| p.sheet).collect();
        assert_eq!(small.sheets.iter().filter(|sheet| sheet.shared).count(), 1, "four cells of 32 fill one sheet of 64");
        assert_eq!(sheets.len(), 4);
        let ats: Vec<(u32, u32)> = small.placements.iter().filter(|p| small.sheets[p.sheet].shared).map(|p| p.at).collect();
        assert_eq!(ats, vec![(0, 0), (32, 0), (0, 32), (32, 32)]);
    }

    /// 11.61: the CPU drawing through shared sheets is within one coverage step of the path-by-path drawing in a few edge pixels,
    /// and exactly it for a list with no instance paths.
    #[test]
    fn sharing_sheets_moves_no_pixel_by_more_than_one_coverage_step() {
        let mut paths = Vec::new();
        for k in 0..40 {
            let (column, row) = (f64::from(k % 10), f64::from(k / 10));
            paths.push(glyph(14.37 + column * 9.61, 13.21 + row * 11.43, 5.3 + f64::from(k % 3), 0.2 + 0.2 * (k % 4) as f32));
        }
        let draw = |paths: &[PreparedPath], share: bool| {
            let refs: Vec<&PreparedPath> = paths.iter().collect();
            let mut surface = RasterSurface::window(120, 64, [0.0, 0.0]);
            rasterise_with(&refs, &mut surface, SHEET_SIDE, share);
            surface
        };
        let (shared, alone) = (draw(&paths, true), draw(&paths, false));
        let mut worst = 0.0_f32;
        let mut differing = 0;
        for (a, b) in shared.pixels().iter().zip(alone.pixels()) {
            let d = (a.r - b.r).abs().max((a.g - b.g).abs()).max((a.b - b.b).abs()).max((a.a - b.a).abs());
            worst = worst.max(d);
            differing += usize::from(d > 0.0);
        }
        assert!(alone.pixels().iter().filter(|p| p.a > 0.0).count() > 2000, "the layer is drawn");
        assert!(worst <= 1.0 / 255.0 + 1e-6, "worst difference {worst}");
        assert!(differing * 50 < 120 * 64, "{differing} pixels differ");

        let plain: Vec<PreparedPath> = paths
            .iter()
            .map(|path| PreparedPath::new("shape".into(), path.paint().clone(), path.outline().clone(), path.fill_rule()))
            .collect();
        assert_eq!(draw(&plain, true), draw(&plain, false), "paths that are not instances are drawn as they were");
    }
}
