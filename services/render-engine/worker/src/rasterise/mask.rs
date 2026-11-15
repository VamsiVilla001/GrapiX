//! Layer masks (3.19, user decisions 15 Nov 2026): After Effects' model.
//!
//! Each mask is a closed path in the object's own coordinates. Its coverage
//! is Vello's coverage of the path, grown or shrunk by its expansion (the
//! path's coverage together with, or less, the coverage of a band twice the
//! expansion wide along it), softened by its feather (a separable Gaussian
//! of standard deviation feather / 2), inverted if asked, and scaled by its
//! opacity. The masks then fold in order into the layer's mask alpha: the
//! first mask starts from nothing when it adds and from the whole layer
//! otherwise; add is a union, subtract removes, intersect keeps the overlap,
//! difference keeps where exactly one covers; mode none is skipped. The
//! layer's pixels are multiplied by that alpha before its effects.
//!
//! The CPU twin here and the GPU passes in `compositor/mask.wgsl` run the
//! same steps with the same f32 operations and the same Gaussian weights.

use super::{coverage_window, window_transform, BezPath, OutlineFill, PreparedPath, RasterSurface};
use crate::colour_pipeline::WorkingRgba;
use gx_contracts::scene::MaskMode;
use vello_cpu::peniko::color::palette::css::WHITE;

/// One mask, prepared: its path and band in the layer's coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedMask {
    pub fill: BezPath,
    /// The band along the path, `2 * |expansion|` wide; `None` without one.
    pub band: Option<BezPath>,
    /// Whether the band grows the mask (positive expansion) or shrinks it.
    pub grow: bool,
    /// The Gaussian weights for the feather, `weights[k]` for offset `k`
    /// from `-radius` to `radius`; empty without a feather.
    pub weights: Vec<f32>,
    pub inverted: bool,
    pub opacity: f32,
    pub mode: MaskMode,
}

/// The feather's normalised Gaussian weights: standard deviation
/// `feather / 2`, radius `ceil(3 * sigma)`.
pub fn feather_weights(feather: f64) -> Vec<f32> {
    if feather <= 0.0 {
        return Vec::new();
    }
    let sigma = feather / 2.0;
    let radius = (3.0 * sigma).ceil() as i64;
    let raw: Vec<f64> = (-radius..=radius)
        .map(|k| (-(k * k) as f64 / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f64 = raw.iter().sum();
    raw.into_iter().map(|w| (w / sum) as f32).collect()
}

/// The fold of one mask's coverage `c` into the alpha `a` above it.
pub(crate) fn fold(mode: MaskMode, a: f32, c: f32) -> f32 {
    match mode {
        MaskMode::None => a,
        MaskMode::Add => a + c - a * c,
        MaskMode::Subtract => a * (1.0 - c),
        MaskMode::Intersect => a * c,
        MaskMode::Difference => a + c - 2.0 * a * c,
    }
}

/// The alpha a fold starts from: nothing when the first mask that shapes
/// anything adds, the whole layer otherwise.
pub(crate) fn initial_alpha(masks: &[PreparedMask]) -> f32 {
    match masks.iter().find(|m| m.mode != MaskMode::None) {
        Some(m) if m.mode == MaskMode::Add => 0.0,
        _ => 1.0,
    }
}

/// Vello CPU coverage of `outline` over the whole surface, in [0, 1].
fn coverage(outline: &BezPath, surface: &RasterSurface) -> Vec<f32> {
    let (w, h) = (surface.width(), surface.height());
    let mut out = vec![0.0; (w * h) as usize];
    let probe = PreparedPath::new(
        "mask".into(),
        super::PathPaint::Solid(WorkingRgba::opaque(1.0, 1.0, 1.0)),
        outline.clone(),
        OutlineFill::NonZero,
    );
    let Some(window) = coverage_window(&probe, surface.origin(), w, h) else {
        return out;
    };
    let (x0, y0, ww, wh) = window;
    let (Ok(w16), Ok(h16)) = (u16::try_from(ww), u16::try_from(wh)) else {
        return out;
    };
    let mut ctx = vello_cpu::RenderContext::new(w16, h16);
    ctx.set_transform(window_transform(surface.origin(), window));
    ctx.set_fill_rule(OutlineFill::NonZero);
    ctx.set_paint(WHITE);
    ctx.fill_path(outline);
    ctx.flush();
    let mut pixmap = vello_cpu::Pixmap::new(w16, h16);
    ctx.render(&mut pixmap, &mut vello_cpu::Resources::new());
    let bytes = pixmap.data_as_u8_slice();
    for j in 0..wh {
        for i in 0..ww {
            out[((y0 + j) * w + x0 + i) as usize] =
                f32::from(bytes[((j * ww + i) * 4 + 3) as usize]) / 255.0;
        }
    }
    out
}

/// One separable pass of the feather, zero outside the surface: along x when
/// `horizontal`, else along y.
pub(crate) fn blur(input: &[f32], w: u32, h: u32, weights: &[f32], horizontal: bool) -> Vec<f32> {
    let radius = (weights.len() / 2) as i64;
    let mut out = vec![0.0; input.len()];
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            let mut sum = 0.0_f32;
            for (k, weight) in weights.iter().enumerate() {
                let d = k as i64 - radius;
                let (sx, sy) = if horizontal { (x + d, y) } else { (x, y + d) };
                if sx >= 0 && sy >= 0 && sx < w as i64 && sy < h as i64 {
                    sum += weight * input[(sy * w as i64 + sx) as usize];
                }
            }
            out[(y * w as i64 + x) as usize] = sum;
        }
    }
    out
}

/// The mask alpha of `masks` over `surface`, the CPU twin of the GPU passes.
pub fn mask_alpha(masks: &[PreparedMask], surface: &RasterSurface) -> Vec<f32> {
    let (w, h) = (surface.width(), surface.height());
    let mut alpha = vec![initial_alpha(masks); (w * h) as usize];
    for mask in masks.iter().filter(|m| m.mode != MaskMode::None) {
        let fill = coverage(&mask.fill, surface);
        let mut c = match &mask.band {
            None => fill,
            Some(band) => {
                let band = coverage(band, surface);
                fill.iter()
                    .zip(&band)
                    .map(|(&f, &b)| {
                        if mask.grow {
                            f + b - f * b
                        } else {
                            f * (1.0 - b)
                        }
                    })
                    .collect()
            }
        };
        if !mask.weights.is_empty() {
            c = blur(
                &blur(&c, w, h, &mask.weights, true),
                w,
                h,
                &mask.weights,
                false,
            );
        }
        for (a, c) in alpha.iter_mut().zip(c) {
            let c = if mask.inverted { 1.0 - c } else { c };
            *a = fold(mask.mode, *a, c * mask.opacity);
        }
    }
    alpha
}

/// Multiply `surface` by the mask alpha of `masks` (no masks: unchanged).
pub fn apply_masks(masks: &[PreparedMask], surface: &mut RasterSurface) {
    if masks.is_empty() {
        return;
    }
    let alpha = mask_alpha(masks, surface);
    for (p, a) in surface.pixels_mut().iter_mut().zip(alpha) {
        *p = p.scaled(a);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use vello_cpu::kurbo::{Rect, Shape};

    /// A mask over the `[x0, x1] x [y0, y1]` rectangle of a 40 x 20 surface.
    pub(crate) fn rect_mask(x0: f64, y0: f64, x1: f64, y1: f64, mode: MaskMode) -> PreparedMask {
        PreparedMask {
            fill: Rect::new(x0, y0, x1, y1).to_path(0.01),
            band: None,
            grow: false,
            weights: Vec::new(),
            inverted: false,
            opacity: 1.0,
            mode,
        }
    }

    fn surface() -> RasterSurface {
        RasterSurface::from_pixels(
            40,
            20,
            [0.0, 0.0],
            vec![WorkingRgba::opaque(1.0, 1.0, 1.0); 800],
        )
    }

    fn alpha_at(masks: &[PreparedMask], x: usize, y: usize) -> f32 {
        mask_alpha(masks, &surface())[y * 40 + x]
    }

    #[test]
    fn each_mode_folds_as_after_effects_does() {
        let left = || rect_mask(0.0, 0.0, 20.0, 20.0, MaskMode::Add);
        let right = |mode| rect_mask(10.0, 0.0, 30.0, 20.0, mode);
        // Pixels: 5 only the first mask, 15 both, 25 only the second, 35 neither.
        let row = |masks: &[PreparedMask]| [5, 15, 25, 35].map(|x| alpha_at(masks, x, 10));
        assert_eq!(row(&[left()]), [1.0, 1.0, 0.0, 0.0]);
        assert_eq!(row(&[left(), right(MaskMode::Add)]), [1.0, 1.0, 1.0, 0.0]);
        assert_eq!(
            row(&[left(), right(MaskMode::Subtract)]),
            [1.0, 0.0, 0.0, 0.0]
        );
        assert_eq!(
            row(&[left(), right(MaskMode::Intersect)]),
            [0.0, 1.0, 0.0, 0.0]
        );
        assert_eq!(
            row(&[left(), right(MaskMode::Difference)]),
            [1.0, 0.0, 1.0, 0.0]
        );
        assert_eq!(row(&[left(), right(MaskMode::None)]), [1.0, 1.0, 0.0, 0.0]);
        // A first mask that subtracts starts from the whole layer.
        assert_eq!(row(&[right(MaskMode::Subtract)]), [1.0, 0.0, 0.0, 1.0]);
        // Only mode-none masks: the layer is untouched.
        assert_eq!(row(&[right(MaskMode::None)]), [1.0; 4]);
    }

    #[test]
    fn inversion_and_opacity_shape_the_coverage_before_it_folds() {
        let mut m = rect_mask(0.0, 0.0, 20.0, 20.0, MaskMode::Add);
        m.inverted = true;
        assert_eq!([5, 25].map(|x| alpha_at(&[m.clone()], x, 10)), [0.0, 1.0]);
        m.inverted = false;
        m.opacity = 0.25;
        assert_eq!(alpha_at(&[m], 5, 10), 0.25);
    }

    #[test]
    fn expansion_grows_and_shrinks_the_mask_by_its_band() {
        let band = |e: f64| {
            let mut m = rect_mask(10.0, 4.0, 30.0, 16.0, MaskMode::Add);
            m.band = Some(vello_cpu::kurbo::stroke(
                m.fill.iter(),
                &vello_cpu::kurbo::Stroke::new(2.0 * e.abs()),
                &Default::default(),
                0.01,
            ));
            m.grow = e > 0.0;
            m
        };
        // Pixel 8 is 1.5 outside the left edge; pixel 11 is 1.5 inside it.
        assert_eq!(
            alpha_at(&[rect_mask(10.0, 4.0, 30.0, 16.0, MaskMode::Add)], 8, 10),
            0.0
        );
        assert_eq!(alpha_at(&[band(3.0)], 8, 10), 1.0, "grown by 3");
        assert_eq!(alpha_at(&[band(-3.0)], 11, 10), 0.0, "shrunk by 3");
        assert_eq!(alpha_at(&[band(-3.0)], 20, 10), 1.0, "the middle stays");
    }

    #[test]
    fn feather_is_a_normalised_gaussian_that_softens_the_edge() {
        let w = feather_weights(4.0);
        assert_eq!(w.len(), 2 * 6 + 1, "sigma 2, radius ceil(3 sigma)");
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        assert!(feather_weights(0.0).is_empty());
        let mut m = rect_mask(10.0, 0.0, 30.0, 20.0, MaskMode::Add);
        let hard = alpha_at(&[m.clone()], 9, 10);
        m.weights = w;
        let soft = |x| alpha_at(&[m.clone()], x, 10);
        assert_eq!(hard, 0.0);
        assert!(
            soft(9) > 0.0 && soft(9) < 0.5,
            "outside the edge, softened: {}",
            soft(9)
        );
        assert!(
            soft(10) > 0.5 && soft(10) < 1.0,
            "inside the edge, softened: {}",
            soft(10)
        );
        assert!(soft(20) > 0.99, "the middle stays: {}", soft(20));
    }

    #[test]
    fn masks_multiply_the_layer() {
        let mut s = surface();
        apply_masks(&[rect_mask(0.0, 0.0, 20.0, 20.0, MaskMode::Add)], &mut s);
        assert_eq!(s.pixels()[10 * 40 + 5].a, 1.0);
        assert_eq!(s.pixels()[10 * 40 + 25], WorkingRgba::transparent());
    }
}
