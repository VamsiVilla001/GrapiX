//! A layer's effect stack as a fixed list of passes (3.22), for both
//! renderers.
//!
//! Each effect expands into passes, decided at prepare: one per-pixel pass
//! for the colour effects, ramp and wipes; box passes along rows or columns
//! for the blurs (three per axis approximate a Gaussian); a gather pass for
//! the directional blur; a save, a make or bright pass, the blur, and a
//! combine for drop shadow and glow. Per frame only the parameters change
//! (a box pass of radius 0 copies), so the GPU's bind groups and targets are
//! built once (invariant 35). The CPU reference runs the same list here; the
//! GPU runs it in `compositor/effects.wgsl`.
//!
//! Effects act in layer space: the object's own pixels before its transform,
//! padded by the stack's largest reach over every frame, as After Effects
//! applies a layer's effects before its transform.
//!
//! Kernels ported from EffectCraft at 9a7d3e76991d5372448033b473dc12c2480a6a04
//! (`crates/raster/src/blur.rs` box passes and box radii; `crates/gpu/src/
//! shaders/kernels.wgsl` directional, glow and shadow; `crates/effects/src/
//! misc.rs` glow, drop shadow, linear and radial wipe), Copyright (c) 2026
//! ArtCraft Team and the EffectCraft contributors, MIT OR Apache-2.0, see
//! EFFECTCRAFT-LICENSE. GrapiX's own: the fixed pass plan, one running sum
//! per line in both directions, reach sized from every frame, feather in
//! pixels for the radial wipe, the iris star, and layer-space coordinates.

use gx_contracts::animation::evaluate_channel;
use gx_contracts::color::{Rgba, WorkingColorSpace};
use gx_contracts::effect::{BlurDimensions, Effect, EffectInstance, RampShape, WipeDirection};
use gx_contracts::scene::SceneDocument;
use gx_contracts::Refusal;

use crate::blend::{bound, covers};
use crate::colour_pipeline::WorkingRgba;
use crate::effects::{apply_pixel, PackedEffect, IDENTITY};

pub const RAMP: u32 = 8;
pub const LINEAR_WIPE: u32 = 9;
pub const RADIAL_WIPE: u32 = 10;
pub const IRIS_WIPE: u32 = 11;
pub const BOX: u32 = 12;
pub const DIRECTIONAL: u32 = 13;
pub const SAVE: u32 = 14;
pub const GLOW_BRIGHT: u32 = 15;
pub const GLOW_COMBINE: u32 = 16;
pub const SHADOW_MAKE: u32 = 17;
pub const SHADOW_COMBINE: u32 = 18;

/// Parameter slots the per-pixel coordinate kernels read the layer origin
/// from: the layer-space position of texel (0, 0)'s corner.
pub const ORIGIN_SLOT: usize = 28;

/// Which GPU entry point runs a pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// One invocation per pixel.
    Pixel,
    /// One invocation per row or column (box passes).
    Line,
}

/// Where a layer sits: the layer-space position of texel (0, 0)'s corner,
/// and the object's box size, for the coordinate effects and wipes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffectContext {
    pub origin: [f64; 2],
    pub size: [f64; 2],
    pub space: WorkingColorSpace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Pixel,
    Box { horizontal: bool, index: usize },
    Directional,
    Save,
    GlowBright,
    GlowCombine,
    ShadowMake,
    ShadowCombine,
}

/// One pass: which effect it belongs to, what it does, and its packed
/// parameters for the current frame.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedPass {
    pub effect: usize,
    role: Role,
    pub packed: PackedEffect,
}

impl PlannedPass {
    pub fn entry(&self) -> Entry {
        if matches!(self.role, Role::Box { .. }) {
            Entry::Line
        } else {
            Entry::Pixel
        }
    }

    /// A save pass writes the auxiliary target and leaves the current one.
    pub fn writes_aux(&self) -> bool {
        self.role == Role::Save
    }
}

/// A layer's effect stack, expanded.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectPlan {
    pub passes: Vec<PlannedPass>,
}

fn blur_dims(d: BlurDimensions) -> (f64, f64) {
    match d {
        BlurDimensions::HorizontalAndVertical => (1.0, 1.0),
        BlurDimensions::Horizontal => (1.0, 0.0),
        BlurDimensions::Vertical => (0.0, 1.0),
    }
}

/// Box radii for `n` passes approximating a Gaussian of `sigma` (Kovesi).
pub fn box_radii(sigma: f64, n: usize) -> Vec<usize> {
    if sigma <= 0.05 {
        return vec![0; n];
    }
    let w_ideal = (12.0 * sigma * sigma / n as f64 + 1.0).sqrt();
    let mut wl = w_ideal.floor() as i64;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wu = wl + 2;
    let m_ideal = (12.0 * sigma * sigma
        - (n as i64 * wl * wl) as f64
        - 4.0 * n as f64 * wl as f64
        - 3.0 * n as f64)
        / (-4.0 * wl as f64 - 4.0);
    let m = m_ideal.round() as i64;
    (0..n as i64)
        .map(|i| (((if i < m { wl } else { wu }) - 1) / 2).max(0) as usize)
        .collect()
}

fn gaussian_reach(sigma_x: f64, sigma_y: f64) -> u32 {
    let sx: usize = box_radii(sigma_x, 3).iter().sum();
    let sy: usize = box_radii(sigma_y, 3).iter().sum();
    sx.max(sy) as u32
}

/// How far an effect can spread a layer's pixels, in layer pixels.
pub fn reach(effect: &Effect) -> u32 {
    match effect {
        Effect::GaussianBlur(e) if !e.repeat_edge_pixels => {
            let (kx, ky) = blur_dims(e.dimensions);
            let s = e.blurriness * 0.5;
            gaussian_reach(s * kx, s * ky) + 1
        }
        Effect::BoxBlur(e) if !e.repeat_edge_pixels => {
            (e.radius.round().max(0.0) as u32) * (e.iterations.round().clamp(1.0, 50.0) as u32) + 1
        }
        Effect::DirectionalBlur(e) => (e.length * 0.5).ceil() as u32 + 2,
        Effect::Glow(e) => {
            let (kx, ky) = blur_dims(e.dimensions);
            let s = (e.radius * 0.5).max(0.5);
            gaussian_reach(s * kx, s * ky) + 1
        }
        Effect::DropShadow(e) => {
            e.distance.ceil() as u32 + 2 + gaussian_reach(e.softness * 0.5, e.softness * 0.5)
        }
        _ => 0,
    }
}

/// The padding and Box Blur iteration counts a layer needs over every frame
/// it can be drawn at: the largest reach and iterations its effect channels
/// reach. Exact, because scene frames are integers.
pub fn layer_extent(doc: &SceneDocument, index: usize) -> Result<(u32, Vec<usize>), Refusal> {
    let object = &doc.objects[index];
    let id = object.base().id.as_str();
    let base: Vec<EffectInstance> = object.base().effects().to_vec();
    let channels: Vec<_> = doc
        .timeline
        .channels
        .iter()
        .filter(|c| {
            c.object_id == id
                && c.property
                    .starts_with(gx_contracts::effect::EFFECT_PROPERTY_PREFIX)
                && !c.keys.is_empty()
        })
        .collect();
    let frames = if channels.is_empty() {
        0
    } else {
        doc.timeline.duration_frames
    };
    let mut pad = 0u32;
    let mut iterations = vec![1usize; base.len()];
    for frame in 0..=frames {
        let mut effects = base.clone();
        for channel in &channels {
            if let (Some(value), Some((effect_id, path))) = (
                evaluate_channel(channel, frame)?,
                gx_contracts::effect::split_effect_property(&channel.property),
            ) {
                if let Some(instance) = effects.iter_mut().find(|e| e.effect_id == effect_id) {
                    instance.set(path, value);
                }
            }
        }
        pad = pad.max(effects.iter().map(|e| reach(&e.effect)).sum());
        for (slot, e) in iterations.iter_mut().zip(&effects) {
            if let Effect::BoxBlur(b) = &e.effect {
                *slot = (*slot).max(b.iterations.round().clamp(1.0, 50.0) as usize);
            }
        }
    }
    Ok((pad, iterations))
}

impl EffectPlan {
    /// The fixed pass list for a stack; `iterations` gives each Box Blur's
    /// largest iteration count over the animation.
    pub fn layout(effects: &[EffectInstance], iterations: &[usize]) -> Self {
        let mut passes = Vec::new();
        let mut push = |effect: usize, role: Role| {
            passes.push(PlannedPass {
                effect,
                role,
                packed: PackedEffect::identity(),
            })
        };
        for (i, instance) in effects.iter().enumerate() {
            let blur = |push: &mut dyn FnMut(usize, Role), n: usize| {
                for horizontal in [true, false] {
                    for index in 0..n {
                        push(i, Role::Box { horizontal, index });
                    }
                }
            };
            match &instance.effect {
                Effect::GaussianBlur(_) => blur(&mut push, 3),
                Effect::BoxBlur(_) => {
                    blur(&mut push, iterations.get(i).copied().unwrap_or(1).max(1))
                }
                Effect::DirectionalBlur(_) => push(i, Role::Directional),
                Effect::Glow(_) => {
                    push(i, Role::Save);
                    push(i, Role::GlowBright);
                    blur(&mut push, 3);
                    push(i, Role::GlowCombine);
                }
                Effect::DropShadow(_) => {
                    push(i, Role::Save);
                    push(i, Role::ShadowMake);
                    blur(&mut push, 3);
                    push(i, Role::ShadowCombine);
                }
                _ => push(i, Role::Pixel),
            }
        }
        Self { passes }
    }

    /// Pack every pass for this frame's effect values, in place.
    pub fn pack(&mut self, effects: &[EffectInstance], ctx: &EffectContext) {
        for pass in &mut self.passes {
            let instance = &effects[pass.effect];
            pack_pass(&mut pass.packed, pass.role, instance, ctx);
        }
    }

    /// Run the plan on a layer-space buffer (the CPU reference).
    pub fn run(
        &self,
        pixels: &[WorkingRgba],
        width: usize,
        height: usize,
        ctx: &EffectContext,
    ) -> Vec<WorkingRgba> {
        let mut cur = pixels.to_vec();
        let mut aux = vec![WorkingRgba::transparent(); pixels.len()];
        for pass in &self.passes {
            let out = run_pass(&pass.packed, &cur, &aux, width, height, ctx);
            if pass.writes_aux() {
                aux = out;
            } else {
                cur = out;
            }
        }
        cur
    }
}

fn colour(c: Rgba, space: WorkingColorSpace) -> [f32; 4] {
    let w = WorkingRgba::from_source(Rgba { a: 1.0, ..c }, space);
    [w.r, w.g, w.b, c.a as f32]
}

fn pack_pass(out: &mut PackedEffect, role: Role, instance: &EffectInstance, ctx: &EffectContext) {
    out.params = [0.0; crate::effects::PARAMS];
    out.kind = IDENTITY;
    if !instance.enabled {
        return;
    }
    let p = &mut out.params;
    p[ORIGIN_SLOT] = ctx.origin[0] as f32;
    p[ORIGIN_SLOT + 1] = ctx.origin[1] as f32;
    let box_pass = |p: &mut [f32], radius: usize, repeat: bool, horizontal: bool| -> u32 {
        p[0] = radius as f32;
        p[1] = f32::from(u8::from(repeat));
        p[2] = f32::from(u8::from(horizontal));
        if radius == 0 {
            IDENTITY
        } else {
            BOX
        }
    };
    out.kind = match (role, &instance.effect) {
        (Role::Pixel, Effect::GradientRamp(e)) => {
            p[..4].copy_from_slice(&colour(e.start_color, ctx.space));
            p[4..8].copy_from_slice(&colour(e.end_color, ctx.space));
            p[8..12].copy_from_slice(&[
                e.start.x as f32,
                e.start.y as f32,
                e.end.x as f32,
                e.end.y as f32,
            ]);
            p[12] = f32::from(u8::from(e.shape == RampShape::Radial));
            p[13] = e.blend_with_original as f32;
            RAMP
        }
        (Role::Pixel, Effect::LinearWipe(e)) => {
            let a = e.angle.to_radians();
            let (dx, dy) = (a.sin(), -a.cos());
            let feather = e.feather.max(0.001);
            let [w, h] = ctx.size;
            let proj = [0.0, w * dx, h * dy, w * dx + h * dy];
            let lo = proj.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = proj.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let edge = lo - feather + (hi - lo + 2.0 * feather) * e.completion;
            p[..4].copy_from_slice(&[dx as f32, dy as f32, edge as f32, feather as f32]);
            LINEAR_WIPE
        }
        (Role::Pixel, Effect::RadialWipe(e)) => {
            let edge = if e.direction == WipeDirection::Both {
                e.completion * 180.0
            } else {
                e.completion * 360.0
            };
            let dir = match e.direction {
                WipeDirection::Clockwise => 0.0,
                WipeDirection::Counterclockwise => 1.0,
                WipeDirection::Both => 2.0,
            };
            p[..6].copy_from_slice(&[
                e.center.x as f32,
                e.center.y as f32,
                e.start_angle as f32,
                edge as f32,
                e.feather.max(0.01) as f32,
                dir,
            ]);
            RADIAL_WIPE
        }
        (Role::Pixel, Effect::IrisWipe(e)) => {
            let n = e.points.round().clamp(6.0, 32.0);
            let inner = if e.use_inner_radius {
                e.inner_radius
            } else {
                e.outer_radius * (std::f64::consts::PI / n).cos()
            };
            p[..7].copy_from_slice(&[
                e.center.x as f32,
                e.center.y as f32,
                n as f32,
                e.outer_radius as f32,
                inner as f32,
                e.rotation.to_radians() as f32,
                e.feather.max(0.01) as f32,
            ]);
            IRIS_WIPE
        }
        (Role::Pixel, _) => {
            // The colour effects pack themselves; keep the origin slots.
            let origin = [p[ORIGIN_SLOT], p[ORIGIN_SLOT + 1]];
            out.pack(instance, ctx.space);
            out.params[ORIGIN_SLOT] = origin[0];
            out.params[ORIGIN_SLOT + 1] = origin[1];
            return;
        }
        (Role::Box { horizontal, index }, Effect::GaussianBlur(e)) => {
            let (kx, ky) = blur_dims(e.dimensions);
            let s = e.blurriness * 0.5 * if horizontal { kx } else { ky };
            box_pass(p, box_radii(s, 3)[index], e.repeat_edge_pixels, horizontal)
        }
        (Role::Box { horizontal, index }, Effect::BoxBlur(e)) => {
            let (kx, ky) = blur_dims(e.dimensions);
            let it = e.iterations.round().clamp(1.0, 50.0) as usize;
            let r = (e.radius.round().max(0.0) * if horizontal { kx } else { ky }) as usize;
            box_pass(
                p,
                if index < it { r } else { 0 },
                e.repeat_edge_pixels,
                horizontal,
            )
        }
        (Role::Box { horizontal, index }, Effect::Glow(e)) => {
            let (kx, ky) = blur_dims(e.dimensions);
            let s = (e.radius * 0.5).max(0.5) * if horizontal { kx } else { ky };
            box_pass(p, box_radii(s, 3)[index], false, horizontal)
        }
        (Role::Box { horizontal, index }, Effect::DropShadow(e)) => {
            box_pass(p, box_radii(e.softness * 0.5, 3)[index], false, horizontal)
        }
        (Role::Directional, Effect::DirectionalBlur(e)) => {
            if e.length < 0.5 {
                IDENTITY
            } else {
                let a = e.direction.to_radians();
                let n = (e.length.ceil() as usize * 2 + 1).clamp(3, 257);
                p[..4].copy_from_slice(&[
                    a.sin() as f32,
                    -a.cos() as f32,
                    e.length as f32,
                    n as f32,
                ]);
                DIRECTIONAL
            }
        }
        (Role::Save, _) => SAVE,
        (Role::GlowBright, Effect::Glow(e)) => {
            p[0] = e.threshold as f32;
            GLOW_BRIGHT
        }
        (Role::GlowCombine, Effect::Glow(e)) => {
            p[0] = e.intensity as f32;
            GLOW_COMBINE
        }
        (Role::ShadowMake, Effect::DropShadow(e)) => {
            let a = e.direction.to_radians();
            p[..4].copy_from_slice(&colour(e.color, ctx.space));
            p[4..7].copy_from_slice(&[
                e.opacity as f32,
                (a.sin() * e.distance) as f32,
                (-a.cos() * e.distance) as f32,
            ]);
            SHADOW_MAKE
        }
        (Role::ShadowCombine, Effect::DropShadow(e)) => {
            p[0] = f32::from(u8::from(e.shadow_only));
            SHADOW_COMBINE
        }
        _ => IDENTITY,
    };
}

// The wipes' trigonometry, written once with basic operations in both
// twins: a GPU's built-in atan2, sin and cos are approximations of its own,
// and a feathered edge would magnify the difference.
const PI: f32 = std::f32::consts::PI;

fn fx_atan(z: f32) -> f32 {
    let z2 = z * z;
    z * (0.999_977_26
        + z2 * (-0.332_623_47
            + z2 * (0.193_543_46 + z2 * (-0.116_432_87 + z2 * (0.052_653_32 + z2 * -0.011_721_2)))))
}

/// atan2, polynomial, max error about 1e-5 rad.
pub fn fx_atan2(y: f32, x: f32) -> f32 {
    let (ax, ay) = (x.abs(), y.abs());
    if ax == 0.0 && ay == 0.0 {
        return 0.0;
    }
    let a = if ax >= ay {
        fx_atan(ay / ax)
    } else {
        PI * 0.5 - fx_atan(ax / ay)
    };
    let a = if x < 0.0 { PI - a } else { a };
    if y < 0.0 {
        -a
    } else {
        a
    }
}

/// sin, reduced to |r| <= pi/2, then a Taylor series to x^11.
pub fn fx_sin(x: f32) -> f32 {
    let k = (x / PI + 0.5).floor();
    let r = x - k * PI;
    let r2 = r * r;
    let s = r
        * (1.0
            + r2 * (-1.0 / 6.0
                + r2 * (1.0 / 120.0
                    + r2 * (-1.0 / 5040.0 + r2 * (1.0 / 362_880.0 + r2 * (-1.0 / 39_916_800.0))))));
    if (k as i32) % 2 != 0 {
        -s
    } else {
        s
    }
}

pub fn fx_cos(x: f32) -> f32 {
    fx_sin(x + PI * 0.5)
}

fn luminance(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// WGSL's `mix`: x * (1 - t) + y * t.
fn mix(x: f32, y: f32, t: f32) -> f32 {
    x * (1.0 - t) + y * t
}

fn mix4(a: WorkingRgba, b: WorkingRgba, t: f32) -> WorkingRgba {
    WorkingRgba {
        r: mix(a.r, b.r, t),
        g: mix(a.g, b.g, t),
        b: mix(a.b, b.b, t),
        a: mix(a.a, b.a, t),
    }
}

/// The compositor's sampler (`composite.wgsl`): pixel centres at +0.5,
/// transparent outside, never clamped.
pub fn sample_bilinear(
    buf: &[WorkingRgba],
    width: usize,
    height: usize,
    x: f32,
    y: f32,
) -> WorkingRgba {
    let get = |i: i64, j: i64| {
        if i < 0 || j < 0 || i >= width as i64 || j >= height as i64 {
            WorkingRgba::transparent()
        } else {
            buf[j as usize * width + i as usize]
        }
    };
    let (fx, fy) = (x - 0.5, y - 0.5);
    let (lx, ly) = (fx.floor(), fy.floor());
    let (tx, ty) = (fx - lx, fy - ly);
    let (qx, qy) = (lx as i64, ly as i64);
    let top = mix4(get(qx, qy), get(qx + 1, qy), tx);
    let bottom = mix4(get(qx, qy + 1), get(qx + 1, qy + 1), tx);
    mix4(top, bottom, ty)
}

fn scaled(px: WorkingRgba, k: f32) -> WorkingRgba {
    WorkingRgba {
        r: px.r * k,
        g: px.g * k,
        b: px.b * k,
        a: px.a * k,
    }
}

fn finite(px: WorkingRgba) -> WorkingRgba {
    WorkingRgba {
        r: bound(px.r),
        g: bound(px.g),
        b: bound(px.b),
        a: bound(px.a).clamp(0.0, 1.0),
    }
}

/// One per-pixel pass at a layer-space position.
pub fn point(e: &PackedEffect, px: WorkingRgba, l: [f32; 2]) -> WorkingRgba {
    let p = &e.params;
    match e.kind {
        RAMP => {
            if !covers(px.a) {
                return px;
            }
            let (dx, dy) = (p[10] - p[8], p[11] - p[9]);
            let (vx, vy) = (l[0] - p[8], l[1] - p[9]);
            let t = if p[12] > 0.5 {
                (vx * vx + vy * vy).sqrt() / (dx * dx + dy * dy).sqrt().max(1e-6)
            } else {
                (vx * dx + vy * dy) / (dx * dx + dy * dy).max(1e-12)
            }
            .clamp(0.0, 1.0);
            let a = px.a;
            let c = [px.r / a, px.g / a, px.b / a];
            let ramp = [mix(p[0], p[4], t), mix(p[1], p[5], t), mix(p[2], p[6], t)];
            let k = (1.0 - p[13]) * mix(p[3], p[7], t);
            let o = [0, 1, 2].map(|i| c[i] + (ramp[i] - c[i]) * k);
            finite(WorkingRgba {
                r: o[0] * a,
                g: o[1] * a,
                b: o[2] * a,
                a,
            })
        }
        LINEAR_WIPE => {
            let d = l[0] * p[0] + l[1] * p[1];
            finite(scaled(px, ((d - p[2]) / p[3] + 0.5).clamp(0.0, 1.0)))
        }
        RADIAL_WIPE => {
            let (vx, vy) = (l[0] - p[0], l[1] - p[1]);
            let r = (vx * vx + vy * vy).sqrt();
            let deg = fx_atan2(vx, -vy) * (180.0 / PI) - p[2];
            let a = deg - (deg / 360.0).floor() * 360.0;
            let a = if p[5] > 1.5 {
                a.min(360.0 - a)
            } else if p[5] > 0.5 {
                360.0 - a
            } else {
                a
            };
            let arc = (a - p[3]) * (PI / 180.0) * r;
            finite(scaled(px, (arc / p[4] + 0.5).clamp(0.0, 1.0)))
        }
        IRIS_WIPE => {
            let (vx, vy) = (l[0] - p[0], l[1] - p[1]);
            let d = (vx * vx + vy * vy).sqrt();
            let n = p[2];
            let step = PI / n;
            let theta = fx_atan2(vx, -vy) - p[5];
            let tau = 2.0 * PI;
            let th = theta - (theta / tau).floor() * tau;
            let k = (th / step).floor().min(2.0 * n - 1.0);
            let (a0, a1) = (k * step, (k + 1.0) * step);
            let even = (k as i32) % 2 == 0;
            let (r0, r1) = if even { (p[3], p[4]) } else { (p[4], p[3]) };
            let (p0x, p0y) = (r0 * fx_sin(a0), -r0 * fx_cos(a0));
            let (p1x, p1y) = (r1 * fx_sin(a1), -r1 * fx_cos(a1));
            let (ux, uy) = (fx_sin(th), -fx_cos(th));
            let (ex, ey) = (p1x - p0x, p1y - p0y);
            let denom = ux * ey - uy * ex;
            let radius = if denom.abs() < 1e-12 {
                r0
            } else {
                (p0x * p1y - p0y * p1x) / denom
            };
            finite(scaled(px, ((d - radius) / p[6] + 0.5).clamp(0.0, 1.0)))
        }
        GLOW_BRIGHT => {
            if !covers(px.a) {
                return WorkingRgba::transparent();
            }
            let l = luminance([px.r / px.a, px.g / px.a, px.b / px.a]);
            let k = ((l - p[0]) / (1.0 - p[0]).max(1e-3)).clamp(0.0, 1.0);
            finite(scaled(px, k))
        }
        _ => apply_pixel(e, px),
    }
}

/// One pass over a layer-space buffer; `aux` is the saved input for the
/// combine passes.
fn run_pass(
    e: &PackedEffect,
    cur: &[WorkingRgba],
    aux: &[WorkingRgba],
    w: usize,
    h: usize,
    ctx: &EffectContext,
) -> Vec<WorkingRgba> {
    let p = &e.params;
    let origin = [p[ORIGIN_SLOT], p[ORIGIN_SLOT + 1]];
    let _ = ctx;
    match e.kind {
        IDENTITY | SAVE => cur.to_vec(),
        BOX => {
            let (r, repeat, horizontal) = (p[0] as i64, p[1] > 0.5, p[2] > 0.5);
            let (lines, n) = if horizontal { (h, w) } else { (w, h) };
            let at = |line: usize, i: usize| {
                if horizontal {
                    line * w + i
                } else {
                    i * w + line
                }
            };
            let norm = 1.0 / (2 * r + 1) as f32;
            let mut out = vec![WorkingRgba::transparent(); cur.len()];
            for line in 0..lines {
                let get = |i: i64| {
                    if i < 0 || i >= n as i64 {
                        if !repeat {
                            return WorkingRgba::transparent();
                        }
                        return cur[at(line, i.clamp(0, n as i64 - 1) as usize)];
                    }
                    cur[at(line, i as usize)]
                };
                let mut acc = [0f32; 4];
                for i in -r..=r {
                    let q = get(i);
                    acc = [acc[0] + q.r, acc[1] + q.g, acc[2] + q.b, acc[3] + q.a];
                }
                for i in 0..n {
                    out[at(line, i)] = WorkingRgba {
                        r: acc[0] * norm,
                        g: acc[1] * norm,
                        b: acc[2] * norm,
                        a: acc[3] * norm,
                    };
                    let add = get(i as i64 + r + 1);
                    let sub = get(i as i64 - r);
                    acc = [
                        acc[0] + (add.r - sub.r),
                        acc[1] + (add.g - sub.g),
                        acc[2] + (add.b - sub.b),
                        acc[3] + (add.a - sub.a),
                    ];
                }
            }
            out
        }
        DIRECTIONAL => {
            let (dx, dy, len, n) = (p[0], p[1], p[2], p[3] as i32);
            let mut out = vec![WorkingRgba::transparent(); cur.len()];
            for y in 0..h {
                for x in 0..w {
                    let mut acc = [0f32; 4];
                    for i in 0..n {
                        let t = (i as f32 / (n - 1) as f32 - 0.5) * len;
                        let s = sample_bilinear(
                            cur,
                            w,
                            h,
                            x as f32 + 0.5 + dx * t,
                            y as f32 + 0.5 + dy * t,
                        );
                        acc = [acc[0] + s.r, acc[1] + s.g, acc[2] + s.b, acc[3] + s.a];
                    }
                    let k = 1.0 / n as f32;
                    out[y * w + x] = finite(WorkingRgba {
                        r: acc[0] * k,
                        g: acc[1] * k,
                        b: acc[2] * k,
                        a: acc[3] * k,
                    });
                }
            }
            out
        }
        GLOW_COMBINE => cur
            .iter()
            .zip(aux)
            .map(|(g, o)| {
                let g = scaled(*g, p[0]);
                finite(WorkingRgba {
                    r: o.r + g.r,
                    g: o.g + g.g,
                    b: o.b + g.b,
                    a: (o.a + g.a * (1.0 - o.a)).min(1.0),
                })
            })
            .collect(),
        SHADOW_MAKE => {
            let mut out = vec![WorkingRgba::transparent(); cur.len()];
            for y in 0..h {
                for x in 0..w {
                    let a =
                        sample_bilinear(cur, w, h, x as f32 + 0.5 - p[5], y as f32 + 0.5 - p[6]).a
                            * p[4]
                            * p[3];
                    out[y * w + x] = finite(WorkingRgba {
                        r: p[0] * a,
                        g: p[1] * a,
                        b: p[2] * a,
                        a,
                    });
                }
            }
            out
        }
        SHADOW_COMBINE => cur
            .iter()
            .zip(aux)
            .map(|(s, o)| {
                if p[0] > 0.5 {
                    *s
                } else {
                    let k = 1.0 - o.a;
                    finite(WorkingRgba {
                        r: o.r + s.r * k,
                        g: o.g + s.g * k,
                        b: o.b + s.b * k,
                        a: o.a + s.a * k,
                    })
                }
            })
            .collect(),
        _ => cur
            .iter()
            .enumerate()
            .map(|(i, px)| {
                point(
                    e,
                    *px,
                    [
                        origin[0] + (i % w) as f32 + 0.5,
                        origin[1] + (i / w) as f32 + 0.5,
                    ],
                )
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::effect::*;

    // A 10x10 opaque square (layer-space box 0..10) in a 24x24 buffer whose
    // texel (0, 0) corner sits at layer-space (-7, -7).
    const N: usize = 24;
    const OFF: usize = 7;

    fn ctx() -> EffectContext {
        EffectContext {
            origin: [-(OFF as f64), -(OFF as f64)],
            size: [10.0, 10.0],
            space: WorkingColorSpace::LinearSrgb,
        }
    }

    /// The buffer index of layer-space pixel (x, y) of the box.
    fn at(x: usize, y: usize) -> usize {
        (y + OFF) * N + x + OFF
    }

    fn square() -> Vec<WorkingRgba> {
        let mut px = vec![WorkingRgba::transparent(); N * N];
        for y in 0..10 {
            for x in 0..10 {
                px[at(x, y)] = WorkingRgba::opaque(0.8, 0.4, 0.2);
            }
        }
        px
    }

    fn run(effect: Effect) -> Vec<WorkingRgba> {
        let effects = vec![EffectInstance::new("e", effect)];
        let mut plan = EffectPlan::layout(&effects, &[1]);
        plan.pack(&effects, &ctx());
        plan.run(&square(), N, N, &ctx())
    }

    fn total(px: &[WorkingRgba]) -> f32 {
        px.iter().map(|p| p.a).sum()
    }

    #[test]
    fn blurs_preserve_coverage_and_spread_it() {
        for effect in [
            Effect::GaussianBlur(GaussianBlur {
                blurriness: 4.0,
                ..Default::default()
            }),
            Effect::BoxBlur(BoxBlur {
                radius: 1.0,
                iterations: 2.0,
                ..Default::default()
            }),
        ] {
            let out = run(effect);
            assert!(
                (total(&out) - total(&square())).abs() < 1e-3,
                "a transparent-edged blur keeps total coverage"
            );
            assert!(
                out[(OFF - 1) * N + OFF + 5].a > 0.0,
                "and spreads past the edge"
            );
        }
    }

    #[test]
    fn a_drop_shadow_appears_offset_and_the_layer_stays_on_top() {
        let out = run(Effect::DropShadow(DropShadow {
            distance: 2.0,
            direction: 180.0,
            opacity: 1.0,
            ..Default::default()
        }));
        // Direction 180 is down: just below the square the shadow shows.
        let below = out[(OFF + 11) * N + OFF + 5];
        assert!(below.a > 0.9 && below.r < 0.05, "{below:?}");
        assert!((out[at(5, 5)].r - 0.8).abs() < 1e-5);
    }

    #[test]
    fn wipes_hide_by_completion_and_never_add_pixels() {
        let half = run(Effect::LinearWipe(LinearWipe {
            completion: 0.5,
            angle: 90.0,
            feather: 0.0,
        }));
        // Angle 90 wipes left to right: the left half of the box is hidden.
        assert!(half[at(1, 5)].a < 0.01 && half[at(8, 5)].a > 0.99);
        let none = run(Effect::LinearWipe(LinearWipe {
            completion: 0.0,
            ..Default::default()
        }));
        assert_eq!(total(&none), total(&square()));
        let iris = run(Effect::IrisWipe(IrisWipe {
            center: EffectPoint { x: 5.0, y: 5.0 },
            outer_radius: 3.0,
            ..Default::default()
        }));
        assert!(iris[at(5, 5)].a < 0.01, "inside the iris is wiped");
        assert!(iris[at(0, 0)].a > 0.99, "outside it the layer shows");
        let all = run(Effect::RadialWipe(RadialWipe {
            completion: 1.0,
            center: EffectPoint { x: 5.0, y: 5.0 },
            ..Default::default()
        }));
        assert!(total(&all) < total(&square()) * 0.1);
    }

    #[test]
    fn a_ramp_repaints_keeping_coverage() {
        let out = run(Effect::GradientRamp(GradientRamp {
            start: EffectPoint { x: 0.0, y: 0.0 },
            end: EffectPoint { x: 10.0, y: 0.0 },
            ..Default::default()
        }));
        assert!(out[at(0, 5)].r < out[at(9, 5)].r, "dark to light along x");
        assert_eq!(total(&out), total(&square()));
    }

    #[test]
    fn a_glow_brightens_and_spreads() {
        let out = run(Effect::Glow(Glow {
            threshold: 0.2,
            radius: 4.0,
            intensity: 1.0,
            ..Default::default()
        }));
        assert!(out[at(5, 5)].r > 0.8, "the layer brightens");
        assert!(
            out[(OFF - 1) * N + OFF + 5].a > 0.0,
            "and glows past its edge"
        );
    }

    #[test]
    fn reach_is_sized_from_every_frame() {
        let mut doc = gx_contracts::scene::new_scene("e", "e", WorkingColorSpace::Srgb);
        let mut rect = gx_contracts::scene::SceneObject::Rect(gx_contracts::scene::RectObject {
            base: gx_contracts::scene::ObjectBase::new("r", "r"),
            radius: 0.0,
        });
        rect.base_mut().effects = Some(vec![EffectInstance::new(
            "b",
            Effect::BoxBlur(BoxBlur {
                radius: 2.0,
                ..Default::default()
            }),
        )]);
        doc.objects.push(rect);
        doc.timeline.duration_frames = 20;
        let (pad, it) = layer_extent(&doc, 0).unwrap();
        assert_eq!((pad, it.clone()), (3, vec![1]));
        doc.timeline
            .channels
            .push(gx_contracts::animation::KeyframeChannel {
                object_id: "r".into(),
                property: "effects.b.iterations".into(),
                keys: vec![
                    gx_contracts::animation::SceneKeyframe {
                        frame: 0,
                        value: 1.0,
                        easing: Default::default(),
                        bezier: None,
                    },
                    gx_contracts::animation::SceneKeyframe {
                        frame: 20,
                        value: 4.0,
                        easing: Default::default(),
                        bezier: None,
                    },
                ],
            });
        let (pad, it) = layer_extent(&doc, 0).unwrap();
        assert_eq!((pad, it), (9, vec![4]));
    }
}
