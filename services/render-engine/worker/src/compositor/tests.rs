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
        effects: Vec::new(),
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
