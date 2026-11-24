//! Layer masks (3.19, user decisions 15 Nov 2026): After Effects' model.
//!
//! Each mask is a closed path in the object's own coordinates. Its coverage
//! is Vello's coverage of the path, grown or shrunk by its expansion (the
//! path's coverage together with, or less, the coverage of a band twice the
//! expansion wide along it), softened by its feather (a separable Gaussian
//! of standard deviation feather / 2), inverted if asked, and scaled by its
//! opacity. The masks then fold in order into the layer's mask alpha: the
//! first mask that shapes anything starts from nothing unless it subtracts
//! (then from the whole layer), and a first intersect or darken acts as an
//! add, so it sets an area instead of hiding the layer (Masking spec v2, 5);
//! add is a union, subtract removes, intersect keeps the overlap, lighten and
//! darken keep the larger and the smaller coverage, difference is the absolute
//! difference of the two; mode none is skipped. The
//! layer's pixels are multiplied by that alpha before its effects.
//!
//! The CPU twin here and the GPU passes in `compositor/mask.wgsl` run the
//! same steps with the same f32 operations and the same Gaussian weights.

use super::{coverage_window, window_transform, BezPath, OutlineFill, PreparedPath, RasterSurface};
use crate::colour_pipeline::WorkingRgba;
use gx_contracts::scene::{MaskFalloff, MaskMode};
use vello_cpu::peniko::color::palette::css::WHITE;

/// One mask, prepared: its path and band in the layer's coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedMask {
    pub fill: BezPath,
    /// The band along the path, `2 * |expansion|` wide; `None` without one.
    pub band: Option<BezPath>,
    /// Whether the band grows the mask (positive expansion) or shrinks it.
    pub grow: bool,
    /// The feather's weights along x, `weights[k]` for offset `k` from
    /// `-radius` to `radius`; empty without a feather there.
    pub weights: Vec<f32>,
    /// The same along y (3.27); empty without a feather there.
    pub weights_y: Vec<f32>,
    pub inverted: bool,
    pub opacity: f32,
    pub mode: MaskMode,
    /// 11.108: a variable feather, which replaces the uniform one (then `weights` and `weights_y` are empty).
    pub variable: Option<std::sync::Arc<super::variable_feather::VariableFeather>>,
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

/// The feather's weights for a falloff (3.27): the Gaussian above, or a box of
/// the feather's width, which ramps an edge in a straight line. Empty without
/// a feather.
pub fn falloff_weights(feather: f64, falloff: MaskFalloff) -> Vec<f32> {
    match falloff {
        MaskFalloff::Smooth => feather_weights(feather),
        MaskFalloff::Linear => {
            if feather <= 0.0 {
                return Vec::new();
            }
            let radius = (feather / 2.0).ceil() as usize;
            vec![1.0 / (2 * radius + 1) as f32; 2 * radius + 1]
        }
    }
}

/// One axis' weights, or the identity pass (one tap of weight 1) when that
/// axis has no feather but the other does, so both passes always run and the
/// result stays in the same buffer on the CPU and the GPU.
pub(crate) fn axis_weights(weights: &[f32]) -> Vec<f32> {
    if weights.is_empty() {
        vec![1.0]
    } else {
        weights.to_vec()
    }
}

/// The fold of one mask's coverage `c` into the alpha `a` above it.
pub(crate) fn fold(mode: MaskMode, a: f32, c: f32) -> f32 {
    match mode {
        MaskMode::None => a,
        MaskMode::Add => a + c - a * c,
        MaskMode::Subtract => a * (1.0 - c),
        MaskMode::Intersect => a * c,
        MaskMode::Difference => (a - c).abs(),
        MaskMode::Lighten => a.max(c),
        MaskMode::Darken => a.min(c),
    }
}

/// The alpha a fold starts from: nothing, unless the first mask that shapes
/// anything subtracts, which starts from the whole layer; with no mask that
/// shapes anything the layer is untouched (a whole layer, not an empty one).
pub(crate) fn initial_alpha(masks: &[PreparedMask]) -> f32 {
    match masks.iter().find(|m| m.mode != MaskMode::None) {
        Some(m) if m.mode != MaskMode::Subtract => 0.0,
        _ => 1.0,
    }
}

/// The mode each mask folds with: its own, except that the first mask that
/// shapes anything acts as an add when it intersects or darkens (from nothing
/// those would hide the whole layer). The CPU twin and the GPU both read this.
pub(crate) fn fold_modes(masks: &[PreparedMask]) -> Vec<MaskMode> {
    let first = masks.iter().position(|m| m.mode != MaskMode::None);
    masks
        .iter()
        .enumerate()
        .map(|(i, m)| match m.mode {
            MaskMode::Intersect | MaskMode::Darken if Some(i) == first => MaskMode::Add,
            mode => mode,
        })
        .collect()
}

/// How many pixels beyond the layer a feather reaches along x and along y: the widest radius of any mask that is drawn. The mask is worked
/// out over the layer grown by this much and cropped, so a mask that goes past the layer's box feathers as it does in the plane, not as
/// if everything past the box were uncovered (3.27, "a feather that reaches outside the layer's box is not clipped").
pub fn mask_pad(masks: &[PreparedMask]) -> (u32, u32) {
    masks.iter().filter(|m| m.mode != MaskMode::None).fold((0, 0), |(px, py), m| {
        (px.max((m.weights.len() / 2) as u32), py.max((m.weights_y.len() / 2) as u32))
    })
}

/// Vello CPU coverage of `outline` over a `w` x `h` window whose texel (0, 0) corner is `origin`, in [0, 1].
fn coverage(outline: &BezPath, origin: [f64; 2], w: u32, h: u32) -> Vec<f32> {
    let mut out = vec![0.0; (w * h) as usize];
    let probe = PreparedPath::new(
        "mask".into(),
        super::PathPaint::Solid(WorkingRgba::opaque(1.0, 1.0, 1.0)),
        outline.clone(),
        OutlineFill::NonZero,
    );
    let Some(window) = coverage_window(&probe, origin, w, h) else {
        return out;
    };
    let (x0, y0, ww, wh) = window;
    let (Ok(w16), Ok(h16)) = (u16::try_from(ww), u16::try_from(wh)) else {
        return out;
    };
    let mut ctx = vello_cpu::RenderContext::new(w16, h16);
    ctx.set_transform(window_transform(origin, window));
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
    let (layer_w, layer_h) = (surface.width(), surface.height());
    // Worked out over the layer grown by the feather's reach, then cropped to the layer.
    let (pad_x, pad_y) = mask_pad(masks);
    let (w, h) = (layer_w + 2 * pad_x, layer_h + 2 * pad_y);
    let origin = [surface.origin()[0] - f64::from(pad_x), surface.origin()[1] - f64::from(pad_y)];
    let mut alpha = vec![initial_alpha(masks); (w * h) as usize];
    let modes = fold_modes(masks);
    for (mask, &mode) in masks
        .iter()
        .zip(&modes)
        .filter(|(m, _)| m.mode != MaskMode::None)
    {
        let fill = coverage(&mask.fill, origin, w, h);
        let mut c = if let Some(variable) = &mask.variable {
            // 11.108: the edge is drawn from the distance to the path, pixel by pixel, over the padded window.
            (0..h)
                .flat_map(|j| (0..w).map(move |i| (i, j)))
                .map(|(i, j)| variable.coverage_at((origin[0] + f64::from(i) + 0.5) as f32, (origin[1] + f64::from(j) + 0.5) as f32))
                .collect()
        } else {
            match &mask.band {
            None => fill,
            Some(band) => {
                let band = coverage(band, origin, w, h);
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
        }
        };
        if !mask.weights.is_empty() || !mask.weights_y.is_empty() {
            c = blur(
                &blur(&c, w, h, &axis_weights(&mask.weights), true),
                w,
                h,
                &axis_weights(&mask.weights_y),
                false,
            );
        }
        for (a, c) in alpha.iter_mut().zip(c) {
            let c = if mask.inverted { 1.0 - c } else { c };
            *a = fold(mode, *a, c * mask.opacity);
        }
    }
    let mut cropped = Vec::with_capacity((layer_w * layer_h) as usize);
    for y in 0..layer_h {
        let row = ((y + pad_y) * w + pad_x) as usize;
        cropped.extend_from_slice(&alpha[row..row + layer_w as usize]);
    }
    cropped
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
            weights_y: Vec::new(),
            inverted: false,
            opacity: 1.0,
            mode,
            variable: None,
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
    fn the_spec_worked_values_fold_exactly() {
        // Masking spec v2, 5: area .75 under a mask of .5.
        let f = |mode| fold(mode, 0.75, 0.5);
        assert_eq!(f(MaskMode::Add), 0.875);
        assert_eq!(f(MaskMode::Subtract), 0.375);
        assert_eq!(f(MaskMode::Intersect), 0.375);
        assert_eq!(f(MaskMode::Lighten), 0.75);
        assert_eq!(f(MaskMode::Darken), 0.5);
        assert_eq!(f(MaskMode::Difference), 0.25);
        assert_eq!(f(MaskMode::None), 0.75);
        // M-10: an inverted coverage of .25 at opacity .8 is .60 (the fold of a first add).
        let mut m = rect_mask(0.0, 0.0, 20.0, 20.0, MaskMode::Add);
        m.inverted = true;
        m.opacity = 0.8;
        assert!(
            (alpha_at(&[m], 25, 10) - 0.8).abs() < 1e-6,
            "outside the rect, inverted: 1 * .8"
        );
        assert!((0.8_f32 * (1.0 - 0.25) - 0.6).abs() < 1e-6);
    }

    #[test]
    fn the_first_mask_sets_an_area_and_lighten_and_darken_fold() {
        let left = |mode| rect_mask(0.0, 0.0, 20.0, 20.0, mode);
        let right = |mode| rect_mask(10.0, 0.0, 30.0, 20.0, mode);
        let row = |masks: &[PreparedMask]| [5, 15, 25, 35].map(|x| alpha_at(masks, x, 10));
        // A first intersect, darken, lighten or difference sets its own area
        // (from nothing they would otherwise hide the whole layer).
        for mode in [
            MaskMode::Intersect,
            MaskMode::Darken,
            MaskMode::Lighten,
            MaskMode::Difference,
        ] {
            assert_eq!(row(&[left(mode)]), [1.0, 1.0, 0.0, 0.0], "{mode:?} first");
        }
        // Behind the first mask the modes fold on the whole: lighten is a union
        // of hard coverage, darken their overlap.
        assert_eq!(
            row(&[left(MaskMode::Add), right(MaskMode::Lighten)]),
            [1.0, 1.0, 1.0, 0.0]
        );
        assert_eq!(
            row(&[left(MaskMode::Add), right(MaskMode::Darken)]),
            [0.0, 1.0, 0.0, 0.0]
        );
        // Mode none above does not count as the first mask.
        assert_eq!(
            row(&[left(MaskMode::None), right(MaskMode::Intersect)]),
            [0.0, 1.0, 1.0, 0.0]
        );
        // A first mask at 50% opacity: lighten with a 25% second leaves the larger.
        let mut half = left(MaskMode::Add);
        half.opacity = 0.5;
        let mut quarter = left(MaskMode::Lighten);
        quarter.opacity = 0.25;
        assert_eq!(alpha_at(&[half.clone(), quarter.clone()], 5, 10), 0.5);
        quarter.mode = MaskMode::Darken;
        assert_eq!(alpha_at(&[half, quarter], 5, 10), 0.25);
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

    /// 3.27: a mask that goes past the layer feathers as it does in the plane: the layer's own edge is not a mask edge.
    #[test]
    fn a_feather_reaches_past_the_layer_and_does_not_dim_its_edge() {
        let mut big = rect_mask(-100.0, -100.0, 140.0, 120.0, MaskMode::Add);
        big.weights = feather_weights(20.0);
        big.weights_y = feather_weights(20.0);
        let alpha = |x: usize, y: usize| mask_alpha(&[big.clone()], &surface())[y * 40 + x];
        for (x, y) in [(0, 0), (39, 0), (0, 19), (39, 19), (20, 10)] {
            assert!(alpha(x, y) > 0.9999, "({x}, {y}) is well inside the mask: {}", alpha(x, y));
        }
        assert_eq!(mask_pad(&[big.clone()]), (30, 30));
        // A mask whose edge is the layer's edge still fades there: half of its Gaussian is past the box.
        let mut flush = rect_mask(0.0, 0.0, 40.0, 20.0, MaskMode::Add);
        flush.weights = feather_weights(8.0);
        let edge = mask_alpha(&[flush], &surface())[10 * 40];
        assert!((edge - 0.5).abs() < 0.1, "{edge}");
        // No feather, no padding; a mask in mode none is not drawn and adds none.
        assert_eq!(mask_pad(&[rect_mask(0.0, 0.0, 5.0, 5.0, MaskMode::Add)]), (0, 0));
        let mut none = rect_mask(0.0, 0.0, 5.0, 5.0, MaskMode::None);
        none.weights = feather_weights(8.0);
        assert_eq!(mask_pad(&[none]), (0, 0));
    }

    #[test]
    fn feather_has_its_own_amount_along_each_axis_and_a_falloff() {
        // x feather only: the left edge softens, the top edge stays hard.
        let mut m = rect_mask(10.0, 6.0, 30.0, 14.0, MaskMode::Add);
        m.weights = feather_weights(6.0);
        let soft_left = alpha_at(&[m.clone()], 9, 10);
        assert!(
            soft_left > 0.0 && soft_left < 0.5,
            "x edge softened: {soft_left}"
        );
        assert_eq!(
            alpha_at(&[m.clone()], 20, 5),
            0.0,
            "y edge stays hard above the box"
        );
        assert!(
            (alpha_at(&[m.clone()], 20, 6) - 1.0).abs() < 1e-5,
            "and inside the top row"
        );
        // y feather only.
        let mut n = rect_mask(10.0, 6.0, 30.0, 14.0, MaskMode::Add);
        n.weights_y = feather_weights(6.0);
        assert_eq!(alpha_at(&[n.clone()], 9, 10), 0.0, "x edge stays hard");
        assert!(alpha_at(&[n], 20, 5) > 0.0, "y edge softened");
        // A linear falloff is a box: an edge ramps in a straight line, so the
        // coverage steps by an equal amount per pixel across it.
        let w = falloff_weights(6.0, MaskFalloff::Linear);
        assert_eq!(w.len(), 7, "a box of radius ceil(6 / 2)");
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        let mut lin = rect_mask(10.0, 0.0, 30.0, 20.0, MaskMode::Add);
        lin.weights = w;
        let step = |x| alpha_at(&[lin.clone()], x + 1, 10) - alpha_at(&[lin.clone()], x, 10);
        assert!(
            (step(8) - step(10)).abs() < 1e-5,
            "{} vs {}",
            step(8),
            step(10)
        );
        assert!((step(8) - 1.0 / 7.0).abs() < 1e-5);
        assert!(falloff_weights(0.0, MaskFalloff::Linear).is_empty());
        // An odd feather rounds the box out, not in; a smooth falloff is the Gaussian and not the box.
        assert_eq!(falloff_weights(5.0, MaskFalloff::Linear).len(), 7, "radius ceil(2.5)");
        assert_eq!(falloff_weights(4.0, MaskFalloff::Smooth), feather_weights(4.0));
        assert_ne!(falloff_weights(4.0, MaskFalloff::Smooth), falloff_weights(4.0, MaskFalloff::Linear));
    }

    #[test]
    fn masks_multiply_the_layer() {
        let mut s = surface();
        apply_masks(&[rect_mask(0.0, 0.0, 20.0, 20.0, MaskMode::Add)], &mut s);
        assert_eq!(s.pixels()[10 * 40 + 5].a, 1.0);
        assert_eq!(s.pixels()[10 * 40 + 25], WorkingRgba::transparent());
    }
}
