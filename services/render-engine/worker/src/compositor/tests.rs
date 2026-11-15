use super::*;
use crate::tiling::StageOrigin;
use gx_contracts::color::Rgba;

fn stage(width: u32, height: u32) -> Stage {
    Stage::new(width, height, StageOrigin { x: 0.0, y: 0.0 }).unwrap()
}

fn layer(id: &str, colour: Rgba, space: WorkingColorSpace, width: u32, height: u32) -> LayerInput {
    LayerInput {
        object_id: id.into(),
        document_path: format!("objects[{id}]"),
        width,
        height,
        pixels: vec![WorkingRgba::from_source(colour, space); (width * height) as usize],
        working_space: space,
        blend_mode: BlendMode::Normal,
        effects: None,
        state: LayerState::default(),
    }
}

fn near(actual: WorkingRgba, expected: WorkingRgba) {
    for (a, e) in [
        (actual.r, expected.r),
        (actual.g, expected.g),
        (actual.b, expected.b),
        (actual.a, expected.a),
    ] {
        assert!((a - e).abs() <= 2e-6, "{actual:?} != {expected:?}");
    }
}

#[test]
fn unsupported_mappings_name_object_and_document_field() {
    let space = WorkingColorSpace::Srgb;
    let mut input = layer("plate", Rgba::srgb(0.2, 0.3, 0.4, 1.0), space, 2, 2);
    // 3.20: every contract blend mode composites; none refuses.
    for mode in BlendMode::ALL {
        input.blend_mode = mode;
        assert!(validate_input(&input, space, 8192).is_ok(), "{mode:?}");
    }
    input.blend_mode = BlendMode::Normal;
    assert!(
        matches!(validate_input(&input, WorkingColorSpace::LinearSrgb, 8192),
        Err(CompositorError::Mapping { document_path, .. }) if document_path.ends_with(".workingColorSpace"))
    );
    input.pixels[0].r = f32::NAN;
    assert!(matches!(validate_input(&input, space, 8192),
        Err(CompositorError::Mapping { document_path, .. }) if document_path.ends_with(".pixels")));
    input.pixels[0].r = 0.0;
    assert!(
        validate_input(&input, space, 1).is_err(),
        "oversized source cannot become one texture"
    );
    input.pixels.pop();
    assert!(validate_input(&input, space, 8192).is_err());
}

#[test]
fn inverse_uniforms_subtract_distant_stage_origin_before_narrowing() {
    let mut stage = stage(30, 5);
    stage.origin = StageOrigin { x: 1e12, y: -1e12 };
    let plan = TilePlan::new(stage, 11).unwrap();
    let state = LayerState {
        affine: [2.0, 0.0, 0.0, 2.0, 1e12 + 0.25, -1e12 + 0.5],
        opacity: 0.5,
        seed: 0,
    };
    let p = uniforms(stage, plan.tiles()[1], state).unwrap();
    assert_eq!(p[0], 0.5);
    assert_eq!(
        p[2],
        (f64::from(plan.tiles()[1].render_bounds.x) * 0.5 - 0.125) as f32
    );
    assert_eq!(p[6], -0.25);
    assert!(
        p.iter().all(|c| c.abs() < 100.0),
        "absolute stage coordinates must not reach WGSL"
    );
    for affine in [
        [0.0; 6],
        [1.0, 0.0, 0.0, f64::NAN, 0.0, 0.0],
        [1e-320, 0.0, 0.0, 1.0, 0.0, 0.0],
    ] {
        assert!(uniforms(
            stage,
            plan.tiles()[0],
            LayerState {
                affine,
                opacity: 1.0,
                seed: 0,
            }
        )
        .is_err());
    }
    assert!(uniforms(
        stage,
        plan.tiles()[0],
        LayerState {
            opacity: f32::INFINITY,
            ..state
        }
    )
    .is_err());
}

// Deliberately ignored in the ordinary no-GPU/CI suite. Run explicitly with
// `cargo test -p gx-render-worker compositor::tests::gpu_ -- --ignored`.
// A requested hardware proof FAILS if no hardware is available; never SKIP or
// silently substitute a software adapter (ADR-0003).
fn hardware() -> Gpu {
    let gpu = crate::gpu::negotiate();
    assert!(
        gpu.has_hardware(),
        "3.16 proof requires a hardware GPU, got {:?}",
        gpu.tier()
    );
    gpu
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 execution gate"]
fn gpu_working_space_order_and_reference_output_codes() {
    let gpu = hardware();
    for (space, preview, program) in [
        (WorkingColorSpace::Srgb, 128_u8, 115_u8),
        (WorkingColorSpace::LinearSrgb, 188, 180),
    ] {
        let inputs = [
            layer("back", Rgba::srgb(1.0, 1.0, 1.0, 1.0), space, 4, 4),
            layer("front", Rgba::srgb(0.0, 0.0, 0.0, 0.5), space, 4, 4),
        ];
        let mut compositor =
            PreparedCompositor::prepare(&gpu, stage(4, 4), space, &inputs).unwrap();
        let states: Vec<_> = inputs.iter().map(|l| l.state).collect();
        let submission = compositor.composite(&states).unwrap();
        assert_eq!(submission.layer_dispatches, 2);
        let reference = compositor.readback_reference().unwrap();
        for p in &reference.pixels {
            near(*p, inputs[1].pixels[0].over(inputs[0].pixels[0]));
        }
        for (transform, code) in [
            (OutputTransform::Srgb, preview),
            (OutputTransform::Rec709, program),
        ] {
            for p in reference.encode(transform).pixels.chunks_exact(4) {
                assert!(
                    p[0].abs_diff(code) <= 1
                        && p[1].abs_diff(code) <= 1
                        && p[2].abs_diff(code) <= 1
                        && p[3] == 255,
                    "{space:?} {transform:?}: {p:?}"
                );
            }
        }
        let reversed = [inputs[1].state, inputs[0].state];
        let mut other = PreparedCompositor::prepare(
            &gpu,
            stage(4, 4),
            space,
            &[inputs[1].clone(), inputs[0].clone()],
        )
        .unwrap();
        other.composite(&reversed).unwrap();
        for p in &other.readback_reference().unwrap().pixels {
            near(*p, WorkingRgba::opaque(1.0, 1.0, 1.0));
        }
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 execution gate"]
fn gpu_affine_opacity_and_repeat_frames_reuse_resources() {
    let gpu = hardware();
    let input = layer(
        "moving",
        Rgba::srgb(1.0, 0.0, 0.0, 1.0),
        WorkingColorSpace::Srgb,
        2,
        2,
    );
    let mut compositor =
        PreparedCompositor::prepare(&gpu, stage(6, 6), WorkingColorSpace::Srgb, &[input]).unwrap();
    // Retain actual GPU handles, not counters that could overlook an allocation.
    let textures = compositor.tiles[0].targets.clone();
    let buffers = compositor.tiles[0].uniforms.clone();
    let groups = compositor.tiles[0].groups.clone();
    let pipeline = compositor.composite_pipeline.clone();
    let state = LayerState {
        affine: [0.0, 1.0, -1.0, 0.0, 4.0, 1.0],
        opacity: 0.5,
        seed: 0,
    };
    compositor.composite(&[state]).unwrap();
    let first = compositor.readback_reference().unwrap();
    for y in 0..6 {
        for x in 0..6 {
            let expected = if (2..4).contains(&x) && (1..3).contains(&y) {
                WorkingRgba {
                    r: 0.5,
                    g: 0.0,
                    b: 0.0,
                    a: 0.5,
                }
            } else {
                WorkingRgba::transparent()
            };
            near(first.pixels[y * 6 + x], expected);
        }
    }
    // A refused mapping must leave the last rendered frame intact.
    assert!(compositor
        .composite(&[LayerState {
            affine: [0.0; 6],
            opacity: 1.0,
            seed: 0,
        }])
        .is_err());
    assert_eq!(
        compositor.readback_reference().unwrap().pixels,
        first.pixels
    );
    // Half-pixel translation gives quarter coverage at the corner, including
    // correct premultiplied alpha; subsequent frames clear the previous result.
    compositor
        .composite(&[LayerState {
            affine: [1.0, 0.0, 0.0, 1.0, 0.5, 0.5],
            opacity: 1.0,
            seed: 0,
        }])
        .unwrap();
    let second = compositor.readback_reference().unwrap();
    near(
        second.pixels[0],
        WorkingRgba {
            r: 0.25,
            g: 0.0,
            b: 0.0,
            a: 0.25,
        },
    );
    near(second.pixels[7], WorkingRgba::opaque(1.0, 0.0, 0.0));
    near(second.pixels[2 * 6 + 3], WorkingRgba::transparent());
    assert_eq!(compositor.tiles[0].targets, textures);
    assert_eq!(compositor.tiles[0].uniforms, buffers);
    assert_eq!(compositor.tiles[0].groups, groups);
    assert_eq!(compositor.composite_pipeline, pipeline);
    compositor
        .composite(&[LayerState {
            opacity: 0.0,
            ..state
        }])
        .unwrap();
    assert!(compositor
        .readback_reference()
        .unwrap()
        .pixels
        .iter()
        .all(|p| *p == WorkingRgba::transparent()));
    let mut empty =
        PreparedCompositor::prepare(&gpu, stage(3, 2), WorkingColorSpace::Srgb, &[]).unwrap();
    empty.composite(&[]).unwrap();
    assert!(empty
        .readback_reference()
        .unwrap()
        .pixels
        .iter()
        .all(|p| *p == WorkingRgba::transparent()));
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 execution gate"]
fn gpu_tiles_match_single_target_at_fractional_distant_origin() {
    let gpu = hardware();
    let space = WorkingColorSpace::LinearSrgb;
    let mut stage = stage(37, 19);
    stage.origin = StageOrigin { x: 1e12, y: -1e12 };
    let mut input = layer("image", Rgba::srgb(0.0, 0.0, 0.0, 1.0), space, 8, 6);
    input.pixels = (0..48)
        .map(|i| {
            WorkingRgba::from_source(
                Rgba::srgb(f64::from(i % 8) / 7.0, f64::from(i / 8) / 5.0, 0.3, 0.7),
                space,
            )
        })
        .collect();
    input.state = LayerState {
        affine: [2.0, 0.25, -0.5, 1.75, 1e12 + 7.25, -1e12 + 2.5],
        opacity: 0.8,
        seed: 0,
    };
    let states = [input.state];
    let mut whole = PreparedCompositor::prepare(&gpu, stage, space, &[input.clone()]).unwrap();
    let mut tiled =
        PreparedCompositor::prepare_with_limit(&gpu, stage, space, &[input], 11).unwrap();
    assert!(tiled.tiles.len() > 1);
    whole.composite(&states).unwrap();
    tiled.composite(&states).unwrap();
    for (a, b) in whole
        .readback_reference()
        .unwrap()
        .pixels
        .into_iter()
        .zip(tiled.readback_reference().unwrap().pixels)
    {
        near(a, b);
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 execution gate"]
fn gpu_stage_above_actual_texture_limit_has_no_seam() {
    let gpu = hardware();
    let limit = gpu.max_texture_dimension_2d().unwrap();
    let space = WorkingColorSpace::Srgb;
    let width = limit + 7;
    let mut input = layer("wide-plate", Rgba::srgb(0.2, 0.6, 0.9, 1.0), space, 2, 2);
    input.state = LayerState {
        affine: [
            f64::from(width),
            0.0,
            0.0,
            10.0,
            -f64::from(width) / 2.0,
            -5.0,
        ],
        opacity: 0.5,
        seed: 0,
    };
    let state = input.state;
    let expected = input.pixels[0].scaled(0.5);
    let mut compositor =
        PreparedCompositor::prepare(&gpu, stage(width, 3), space, &[input]).unwrap();
    assert!(compositor.tiles.len() > 1);
    for tile in &compositor.tiles {
        for texture in &tile.targets {
            assert!(texture.width() <= limit && texture.height() <= limit);
        }
    }
    assert!(compositor.output_tiles().is_none());
    compositor.composite(&[state]).unwrap();
    assert_eq!(
        compositor.output_tiles().unwrap().len(),
        compositor.tiles.len()
    );
    for p in compositor.readback_reference().unwrap().pixels {
        near(p, expected);
    }
}

// 3.21: each layer is dispatched over its footprint on the tile, not the
// whole tile. These tests hold the footprint conservative (every pixel the
// layer can touch is inside it) and the result bit-identical to the whole-tile
// dispatch.

/// A small deterministic generator, so the cases are the same on every run.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
}

fn random_state(rng: &mut Lcg, stage_w: f64, stage_h: f64) -> LayerState {
    let angle = rng.range(-3.2, 3.2);
    // A quarter of the cases magnify strongly: there half a source pixel of
    // bilinear reach is many tile pixels, beyond any tile-space margin.
    let most = if rng.next() < 0.25 { 60.0 } else { 4.0 };
    let (sx, sy) = (rng.range(0.05, most), rng.range(0.05, most));
    let shear = if rng.next() < 0.3 {
        rng.range(-1.0, 1.0)
    } else {
        0.0
    };
    let (sin, cos) = angle.sin_cos();
    LayerState {
        affine: [
            cos * sx,
            sin * sx,
            -sin * sy + shear * cos * sx,
            cos * sy + shear * sin * sx,
            rng.range(-0.3 * stage_w, 1.3 * stage_w),
            rng.range(-0.3 * stage_h, 1.3 * stage_h),
        ],
        opacity: if rng.next() < 0.1 {
            0.0
        } else {
            rng.range(0.05, 1.0) as f32
        },
        seed: (rng.next() * 1e9) as u32,
    }
}

#[test]
fn a_layer_region_holds_every_pixel_its_source_can_reach() {
    // Brute force: on every tile of a multi-tile plan, each pixel whose centre
    // maps into the bilinear footprint of the source lies inside the region.
    let mut s = stage(97, 61);
    s.origin = StageOrigin {
        x: 1e9 + 0.37,
        y: -5e8,
    };
    let plan = TilePlan::new(s, 40).unwrap();
    assert!(plan.tiles().len() > 1);
    let mut rng = Lcg(321);
    let mut checked = 0_u64;
    for case in 0..400 {
        let source = (
            1 + (rng.next() * 30.0) as u32,
            1 + (rng.next() * 30.0) as u32,
        );
        let mut state = random_state(&mut rng, 97.0, 61.0);
        state.affine[4] += s.origin.x;
        state.affine[5] += s.origin.y;
        let [a, b, c, d, tx, ty] = state.affine;
        let det = a * d - b * c;
        for tile in plan.tiles() {
            let region = layer_region(s, *tile, state, source, false);
            let r = tile.render_bounds;
            assert!(region.x + region.width <= r.width && region.y + region.height <= r.height);
            if state.opacity.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
                assert!(
                    region.is_empty(),
                    "case {case}: a layer that does nothing has no region"
                );
                continue;
            }
            for y in 0..r.height {
                for x in 0..r.width {
                    // The stage point at this pixel centre, back into source
                    // space, in f64 (the shader's f32 is inside the margin).
                    let px = s.origin.x + f64::from(r.x + x) + 0.5 - tx;
                    let py = s.origin.y + f64::from(r.y + y) + 0.5 - ty;
                    let u = (d * px - c * py) / det;
                    let v = (-b * px + a * py) / det;
                    let reaches = u > -0.5
                        && u < f64::from(source.0) + 0.5
                        && v > -0.5
                        && v < f64::from(source.1) + 0.5;
                    let inside = x >= region.x
                        && x < region.x + region.width
                        && y >= region.y
                        && y < region.y + region.height;
                    assert!(
                        !reaches || inside,
                        "case {case} tile {r:?}: pixel ({x}, {y}) reaches the source but is outside {region:?}"
                    );
                    checked += u64::from(reaches);
                }
            }
        }
    }
    assert!(
        checked > 10_000,
        "the cases must exercise the footprint: {checked}"
    );
}

#[test]
fn a_layer_region_is_tight_empty_or_whole_as_the_layer_requires() {
    let s = stage(400, 300);
    let plan = TilePlan::new(s, 4096).unwrap();
    let tile = plan.tiles()[0];
    let at = |x: f64, y: f64| LayerState {
        affine: [1.0, 0.0, 0.0, 1.0, x, y],
        opacity: 1.0,
        seed: 0,
    };
    // A 10 x 10 layer at (100, 50): its pixels plus a few of margin.
    let r = layer_region(s, tile, at(100.0, 50.0), (10, 10), false);
    assert!(
        r.x <= 100 && r.y <= 50 && r.x + r.width >= 110 && r.y + r.height >= 60,
        "{r:?}"
    );
    assert!(
        r.width <= 10 + 12 && r.height <= 10 + 12,
        "the region stays tight: {r:?}"
    );
    // Off the tile, at zero opacity, or a NaN opacity: nothing to dispatch.
    assert!(layer_region(s, tile, at(1000.0, 50.0), (10, 10), false).is_empty());
    assert!(layer_region(s, tile, at(-50.0, -50.0), (10, 10), false).is_empty());
    for opacity in [0.0, -0.0, f32::NAN] {
        let state = LayerState {
            opacity,
            ..at(100.0, 50.0)
        };
        assert!(layer_region(s, tile, state, (10, 10), false).is_empty());
        assert!(
            layer_region(s, tile, state, (10, 10), true).is_empty(),
            "a hidden stencil must not clear the backdrop"
        );
    }
    // A whole-backdrop mode changes pixels where its source is transparent.
    assert_eq!(
        layer_region(s, tile, at(1000.0, 50.0), (10, 10), true),
        Region::full(tile)
    );
    // A huge scale clamps to the tile; it never wraps or overflows.
    let huge = LayerState {
        affine: [1e12, 0.0, 0.0, 1e12, -5e11, -5e11],
        opacity: 1.0,
        seed: 0,
    };
    assert_eq!(
        layer_region(s, tile, huge, (1, 1), false),
        Region::full(tile)
    );
}

/// One layer per mode in `modes`, with soft, uneven coverage so edges and
/// interiors both blend.
fn equivalence_layers(
    space: WorkingColorSpace,
    modes: &[BlendMode],
    rng: &mut Lcg,
) -> Vec<LayerInput> {
    let mut out = Vec::new();
    for (n, mode) in modes.iter().enumerate() {
        let (w, h) = (
            3 + (rng.next() * 60.0) as u32,
            3 + (rng.next() * 40.0) as u32,
        );
        let mut input = layer(
            &format!("l{n}"),
            Rgba::srgb(rng.next(), rng.next(), rng.next(), rng.range(0.2, 1.0)),
            space,
            w,
            h,
        );
        for (i, p) in input.pixels.iter_mut().enumerate() {
            let k = ((i * 37 % 11) as f32 + 1.0) / 11.0;
            *p = p.scaled(k);
        }
        input.blend_mode = *mode;
        out.push(input);
    }
    out
}

fn assert_bit_identical(a: &CompositeReference, b: &CompositeReference, what: &str) {
    assert_eq!(a.pixels.len(), b.pixels.len());
    let bits = |p: &WorkingRgba| [p.r.to_bits(), p.g.to_bits(), p.b.to_bits(), p.a.to_bits()];
    for (i, (x, y)) in a.pixels.iter().zip(&b.pixels).enumerate() {
        assert_eq!(
            bits(x),
            bits(y),
            "{what}: pixel {i} differs: {x:?} vs {y:?}"
        );
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.21 execution gate"]
fn gpu_footprint_dispatch_is_bit_identical_to_the_whole_tile() {
    let gpu = hardware();
    let mut rng = Lcg(2160);
    let limit = gpu
        .device_queue()
        .unwrap()
        .0
        .limits()
        .max_texture_dimension_2d;
    // Every mode in turn; and, twice over, only the modes that keep the
    // backdrop where the source is zero. A whole-backdrop layer is dispatched
    // over the whole tile and so repairs both targets; without one, a pixel
    // left stale in either target survives to the output.
    let local: Vec<BlendMode> = BlendMode::ALL
        .iter()
        .copied()
        .filter(|mode| !mode.acts_on_whole_backdrop())
        .collect();
    let local_twice: Vec<BlendMode> = local.iter().chain(local.iter().rev()).copied().collect();
    // One tile, and a stage past the texture limit (two tiles, a seam).
    for (w, h) in [(320_u32, 180_u32), (limit + 37, 24)] {
        for (space, modes) in [
            (WorkingColorSpace::Srgb, &BlendMode::ALL[..]),
            (WorkingColorSpace::LinearSrgb, &BlendMode::ALL[..]),
            (WorkingColorSpace::Srgb, &local_twice[..]),
            (WorkingColorSpace::LinearSrgb, &local_twice[..]),
        ] {
            let inputs = equivalence_layers(space, modes, &mut rng);
            let mut footprint =
                PreparedCompositor::prepare(&gpu, stage(w, h), space, &inputs).unwrap();
            let mut whole = PreparedCompositor::prepare(&gpu, stage(w, h), space, &inputs).unwrap();
            whole.full_tile_dispatch = true;
            for frame in 0..6 {
                let mut states: Vec<_> = inputs
                    .iter()
                    .map(|_| random_state(&mut rng, f64::from(w.min(400)), f64::from(h)))
                    .collect();
                if w > 400 {
                    // Some layers across the seam between the two tiles.
                    for state in states.iter_mut().step_by(3) {
                        state.affine[4] = f64::from(limit) + rng.range(-40.0, 10.0);
                    }
                }
                let before = crate::render_work::RenderWork::snapshot();
                footprint.composite(&states).unwrap();
                let a = footprint.readback_reference().unwrap();
                let footprint_work = crate::render_work::RenderWork::snapshot().since(before);
                let before = crate::render_work::RenderWork::snapshot();
                whole.composite(&states).unwrap();
                let b = whole.readback_reference().unwrap();
                let whole_work = crate::render_work::RenderWork::snapshot().since(before);
                assert_bit_identical(&a, &b, &format!("{w}x{h} {space:?} frame {frame}"));
                assert_eq!(
                    footprint_work.gpu_layer_dispatches,
                    whole_work.gpu_layer_dispatches
                );
                assert!(
                    footprint_work.gpu_layer_pixels < whole_work.gpu_layer_pixels,
                    "the footprint dispatch covers fewer pixels: {} vs {}",
                    footprint_work.gpu_layer_pixels,
                    whole_work.gpu_layer_pixels
                );
                assert_eq!(footprint_work.gpu_resource_builds, 0);
            }
        }
    }
}
