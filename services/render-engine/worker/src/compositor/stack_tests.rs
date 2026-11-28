//! The layer stack on a real device (task 112, rows 12.10 and 12.13).
//!
//! Hardware only: run with `--ignored`; `GX_GPU_316_BACKEND` picks `dx12` or `vulkan` (unset takes whichever adapter wgpu ranks first,
//! so an unset run proves one backend). A requested hardware proof FAILS without hardware; it is never skipped or substituted.
//!
//! What they prove: scenes composited by the stack equal the same layers composited by one compositor, low to high, in the working
//! space and before the output encode (so the colour is made once and quantised once); the order is the order they are added in; a
//! stack of one scene is that scene; and the stack's output ring delivers the bytes the CPU colour authority encodes.

use super::output::{Delivered, Submitted};
use super::stack::LayerStack;
use super::*;
use crate::colour_pipeline::WorkingRgba;
use crate::gpu::Gpu;
use crate::tiling::StageOrigin;
use gx_contracts::color::{OutputTransform, Rgba};

fn hardware() -> Gpu {
    let gpu = match std::env::var("GX_GPU_316_BACKEND").as_deref() {
        Ok("dx12") => crate::gpu::negotiate_for_test(wgpu::Backends::DX12),
        Ok("vulkan") => crate::gpu::negotiate_for_test(wgpu::Backends::VULKAN),
        Err(_) => crate::gpu::negotiate(),
        other => panic!("unsupported explicit proof backend: {other:?}"),
    };
    assert!(gpu.has_hardware(), "the layer stack proof requires a hardware GPU, got {:?}", gpu.tier());
    gpu
}

fn stage(width: u32, height: u32) -> Stage {
    Stage::new(width, height, StageOrigin { x: 0.0, y: 0.0 }).unwrap()
}

fn solid(id: &str, colour: Rgba, space: WorkingColorSpace, size: u32) -> LayerInput {
    LayerInput {
        object_id: id.into(),
        document_path: format!("objects[{id}]"),
        width: size,
        height: size,
        pixels: vec![WorkingRgba::from_source(colour, space); (size * size) as usize],
        working_space: space,
        drawn: None,
        blend_mode: BlendMode::Normal,
        effects: None,
        matte: false,
        clip: None,
        track: None,
        preserve: false,
        effect_weights: Vec::new(),
        state: LayerState::default(),
    }
}

/// One scene: a compositor over one solid layer, composited once.
fn scene(gpu: &Gpu, colour: Rgba, space: WorkingColorSpace, size: u32) -> (PreparedCompositor, WorkingRgba) {
    let input = solid("fill", colour, space, size);
    let expected = input.pixels[0];
    let mut compositor = PreparedCompositor::prepare(gpu, stage(size, size), space, &[input.clone()]).unwrap();
    compositor.composite(&[input.state]).unwrap();
    (compositor, expected)
}

fn stack_of(compositor: &PreparedCompositor) -> LayerStack {
    compositor.new_stack().unwrap()
}

/// Stack the scenes lowest first and deliver the encoded frame.
fn stacked(stack: &mut LayerStack, scenes: &[&PreparedCompositor], tag: u64) -> Delivered {
    stack.begin();
    for scene in scenes {
        stack.add(scene.output_tiles().unwrap()).unwrap();
    }
    assert_eq!(stack.submit(tag).unwrap(), Submitted::Queued);
    stack.wait_for(tag, std::time::Duration::from_secs(5)).unwrap()
}

fn agrees(frame: &Frame, expected: WorkingRgba, output: OutputTransform, space: WorkingColorSpace, what: &str) {
    let code = expected.encode(output, space);
    for pixel in frame.pixels.chunks_exact(4) {
        for channel in 0..4 {
            assert!(pixel[channel].abs_diff(code[channel]) <= 1, "{what}: {pixel:?} against {code:?}");
        }
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit task 112 execution gate"]
fn gpu_stack_puts_the_upper_scene_over_the_lower_in_the_working_space_and_encodes_once() {
    let gpu = hardware();
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (lower, below) = scene(&gpu, Rgba::srgb(0.8, 0.2, 0.1, 1.0), space, 8);
        let (upper, above) = scene(&gpu, Rgba::srgb(0.0, 0.0, 1.0, 0.5), space, 8);
        let mut stack = stack_of(&lower);
        let frame = stacked(&mut stack, &[&lower, &upper], 1);
        let expected = above.over(below);
        agrees(&frame.program, expected, OutputTransform::Rec709, space, "program");
        agrees(&frame.preview, expected, OutputTransform::Srgb, space, "preview");
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit task 112 execution gate"]
fn gpu_stack_order_is_the_order_scenes_are_added() {
    let gpu = hardware();
    let space = WorkingColorSpace::LinearSrgb;
    let (opaque, below) = scene(&gpu, Rgba::srgb(0.8, 0.2, 0.1, 1.0), space, 8);
    let (glass, above) = scene(&gpu, Rgba::srgb(0.0, 0.0, 1.0, 0.5), space, 8);
    let mut stack = stack_of(&opaque);
    let right = stacked(&mut stack, &[&opaque, &glass], 1);
    let wrong = stacked(&mut stack, &[&glass, &opaque], 2);
    agrees(&right.program, above.over(below), OutputTransform::Rec709, space, "glass over opaque");
    // An opaque scene on top hides everything under it: the reverse order is just the opaque colour.
    agrees(&wrong.program, below, OutputTransform::Rec709, space, "opaque over glass");
    assert_ne!(right.program.pixels, wrong.program.pixels);
}

#[test]
#[ignore = "requires hardware GPU; explicit task 112 execution gate"]
fn gpu_stack_of_one_scene_is_that_scene() {
    let gpu = hardware();
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (only, expected) = scene(&gpu, Rgba::srgb(0.3, 0.6, 0.9, 0.7), space, 8);
        let mut stack = stack_of(&only);
        let frame = stacked(&mut stack, &[&only], 1);
        agrees(&frame.program, expected, OutputTransform::Rec709, space, "program");
        // And a second frame on the same stack is not left over from the first.
        let (other, other_expected) = scene(&gpu, Rgba::srgb(0.9, 0.1, 0.1, 1.0), space, 8);
        let second = stacked(&mut stack, &[&other], 2);
        agrees(&second.program, other_expected, OutputTransform::Rec709, space, "second frame");
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit task 112 execution gate"]
fn gpu_stack_of_three_scenes_is_the_three_layers_composited_in_order() {
    let gpu = hardware();
    let space = WorkingColorSpace::Srgb;
    let (a, ca) = scene(&gpu, Rgba::srgb(0.9, 0.9, 0.9, 1.0), space, 8);
    let (b, cb) = scene(&gpu, Rgba::srgb(0.1, 0.4, 0.8, 0.6), space, 8);
    let (c, cc) = scene(&gpu, Rgba::srgb(0.9, 0.2, 0.2, 0.4), space, 8);
    let mut stack = stack_of(&a);
    let frame = stacked(&mut stack, &[&a, &b, &c], 1);
    agrees(&frame.program, cc.over(cb.over(ca)), OutputTransform::Rec709, space, "three layers");
}

#[test]
#[ignore = "requires hardware GPU; explicit task 112 execution gate"]
fn gpu_stack_holds_every_step_to_the_project_depth() {
    let gpu = hardware();
    let space = WorkingColorSpace::Srgb;
    let make = |colour: Rgba| {
        let input = solid("fill", colour, space, 8);
        let mut compositor = PreparedCompositor::prepare(&gpu, stage(8, 8), space, &[input.clone()]).unwrap();
        compositor.set_depth(gx_contracts::color::ColorDepth::Bits8);
        compositor.composite(&[input.state]).unwrap();
        compositor
    };
    let below = make(Rgba::srgb(0.3, 0.3, 0.3, 1.0));
    let above = make(Rgba::srgb(0.7, 0.2, 0.9, 0.37));
    let mut stack = stack_of(&below);
    assert!(stack.fits(stage(8, 8), space, gx_contracts::color::ColorDepth::Bits8));
    assert!(!stack.fits(stage(8, 8), space, gx_contracts::color::ColorDepth::Bits32));
    let frame = stacked(&mut stack, &[&below, &above], 1);
    // The step's result is a whole 8-bit level: no pixel is left between two.
    let reference = {
        let l = WorkingRgba::from_source(Rgba::srgb(0.3, 0.3, 0.3, 1.0), space);
        let u = WorkingRgba::from_source(Rgba::srgb(0.7, 0.2, 0.9, 0.37), space);
        let q = |x: f32| (x.clamp(0.0, 1.0) * 255.0 + 0.5).floor() / 255.0;
        let o = u.over(l);
        WorkingRgba { r: q(o.r), g: q(o.g), b: q(o.b), a: q(o.a) }
    };
    agrees(&frame.program, reference, OutputTransform::Rec709, space, "8-bit step");
}

/// The depth is held at EVERY step, not once at the end: three scenes whose alphas are whole 8-bit levels (34, 41 and 20 of 255) make
/// 85 when each step is rounded to a level and 84.08, so 84, when only the last is. The alpha channel is encoded as itself, so the
/// delivered byte shows which was done, and it is compared exactly, not within one level.
#[test]
#[ignore = "requires hardware GPU; explicit task 112 execution gate"]
fn gpu_stack_rounds_to_the_project_depth_at_every_step_not_once_at_the_end() {
    let gpu = hardware();
    let space = WorkingColorSpace::Srgb;
    let make = |code: u32| {
        let input = solid("fill", Rgba::srgb(0.5, 0.5, 0.5, f64::from(code) / 255.0), space, 8);
        let mut compositor = PreparedCompositor::prepare(&gpu, stage(8, 8), space, &[input.clone()]).unwrap();
        compositor.set_depth(gx_contracts::color::ColorDepth::Bits8);
        compositor.composite(&[input.state]).unwrap();
        compositor
    };
    let (a, b, c) = (make(34), make(41), make(20));
    let mut stack = stack_of(&a);
    let frame = stacked(&mut stack, &[&a, &b, &c], 1);
    for pixel in frame.program.pixels.chunks_exact(4) {
        assert_eq!(pixel[3], 85, "each step is a whole level, so the alpha is 85 and not the 84 of one rounding at the end: {pixel:?}");
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit task 112 execution gate"]
fn gpu_stack_refuses_a_scene_whose_tiles_are_not_its_own() {
    let gpu = hardware();
    let space = WorkingColorSpace::Srgb;
    let (small, _) = scene(&gpu, Rgba::srgb(0.5, 0.5, 0.5, 1.0), space, 8);
    let (large, _) = scene(&gpu, Rgba::srgb(0.5, 0.5, 0.5, 1.0), space, 16);
    let mut stack = stack_of(&small);
    stack.begin();
    assert!(stack.add(large.output_tiles().unwrap()).is_err());
    assert!(stack.submit(1).is_err(), "nothing was composited");
}
