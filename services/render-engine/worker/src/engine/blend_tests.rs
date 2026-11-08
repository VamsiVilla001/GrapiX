//! 3.20 execution gates: every contract blend mode composites on the GPU in
//! both working spaces and matches its CPU reference, and no NaN or infinity
//! reaches output.
//!
//! Scene gate: per mode and space, a backdrop of opaque, half-transparent and
//! empty cells, an Add layer at 50% (over-range values below the layer under
//! test), then rects and an anti-aliased ellipse in the mode, at mixed fill
//! alpha and object opacity. "Matches its CPU reference" is checked where the
//! blend happens and again at the output:
//! - the GPU's working-space floats equal the CPU renderer's within 1e-4
//!   relative (absolute below 1e-3), i.e. float rounding: the GPU fuses
//!   multiply-adds and divides to 2.5 ULP, the CPU does neither;
//! - Program and Preview are exactly the CPU encode of the GPU's own working
//!   pixels (3.21's one quantisation), and no channel is more than one code
//!   value from the CPU renderer's frame.
//!
//! Together these say every differing code is a rounding-boundary flip. The
//! count is recorded per mode; a flat test cell whose exact colour sits on a
//! code boundary flips as a whole, so it can exceed 4.4's 0.1% of pixels.
//! 3.20's done-when asks for agreement with the CPU reference, not the 4.4
//! pixel fraction.
//!
//! NaN regression: EffectCraft's DX12 32-bit runs emitted NaN for Darken on
//! 11 October 2026 and Classic Difference on 12 October 2026, not on every
//! run. Its failing scene (background, an Add layer at 50%, a rotated, scaled
//! layer at 70% at a fractional position) is rebuilt here for both modes and
//! rendered repeatedly; every working-space value must be finite on every
//! run, and every run must be bit-identical to the first.
//!
//! Hardware only: run with `--ignored`; `GX_GPU_316_BACKEND` picks dx12 or
//! vulkan; `GX_GPU_320_EVIDENCE_DIR` writes the JSON.

use super::*;
use gx_contracts::color::WorkingColorSpace;
use gx_contracts::material::BlendMode;
use gx_contracts::scene::parse_scene_document;
use gx_control_plane::intent::TakeRequest;
use serde_json::{json, Value};

const FIXTURE: &[u8] = include_bytes!("../../tests/fixtures/gpu-lower-third-50.json");
const INTER: &[u8] = include_bytes!("../../tests/fixtures/Inter-Regular.ttf");

fn hardware_engine() -> (Engine, Arc<AtomicU64>) {
    let ticks = Arc::new(AtomicU64::new(0));
    let engine = match std::env::var("GX_GPU_316_BACKEND").as_deref() {
        Ok("dx12") => Engine::with_gpu(
            ticks.clone(),
            Locality::CoLocated,
            gpu::negotiate_for_test(wgpu::Backends::DX12),
        ),
        Ok("vulkan") => Engine::with_gpu(
            ticks.clone(),
            Locality::CoLocated,
            gpu::negotiate_for_test(wgpu::Backends::VULKAN),
        ),
        Err(_) => Engine::new(ticks.clone(), Locality::CoLocated),
        other => panic!("unsupported explicit proof backend: {other:?}"),
    };
    assert!(
        engine.gpu.has_hardware(),
        "3.20 execution proof requires a hardware GPU"
    );
    (engine, ticks)
}

fn wire(mode: BlendMode) -> String {
    serde_json::to_value(mode)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

fn paint(rgba: [f64; 4]) -> Value {
    json!({ "type": "solid", "color": { "r": rgba[0], "g": rgba[1], "b": rgba[2], "a": rgba[3], "space": "srgb" } })
}

#[allow(clippy::too_many_arguments)]
fn shape(
    kind: &str,
    id: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    z: i64,
    rgba: [f64; 4],
    opacity: f64,
    mode: BlendMode,
) -> Value {
    let mut o = json!({ "type": kind, "id": id, "name": id, "x": x, "y": y, "width": w, "height": h,
        "zIndex": z, "opacity": opacity, "fill": paint(rgba) });
    if kind == "rect" {
        o["radius"] = json!(0);
    }
    if mode != BlendMode::Normal {
        o["blendMode"] = json!(wire(mode));
    }
    o
}

fn scene(
    name: &str,
    width: u32,
    height: u32,
    space: WorkingColorSpace,
    objects: Vec<Value>,
) -> SceneDocument {
    let mut doc: Value = serde_json::from_slice(FIXTURE).unwrap();
    doc["id"] = json!(name);
    doc["canvas"]["width"] = json!(width);
    doc["canvas"]["height"] = json!(height);
    doc["timeline"]["channels"] = json!([]);
    doc["objects"] = Value::Array(objects);
    let mut doc = parse_scene_document(&serde_json::to_vec(&doc).unwrap()).unwrap();
    doc.working_color_space = space;
    doc
}

const PALETTE: [[f64; 3]; 10] = [
    [0.0, 0.0, 0.0],
    [1.0, 1.0, 1.0],
    [0.5, 0.5, 0.5],
    [0.9, 0.1, 0.1],
    [0.1, 0.8, 0.2],
    [0.15, 0.25, 0.95],
    [0.25, 0.25, 0.25],
    [0.8, 0.7, 0.2],
    [0.6, 0.3, 0.7],
    [0.05, 0.6, 0.6],
];

/// The per-mode gate scene: 160x96.
fn mode_scene(mode: BlendMode, space: WorkingColorSpace) -> SceneDocument {
    let mut objects = Vec::new();
    let mut z = 0;
    for row in 0..3u32 {
        for col in 0..5u32 {
            if row == 1 && col == 4 {
                continue; // an empty backdrop cell
            }
            let c = PALETTE[(row * 5 + col) as usize % PALETTE.len()];
            let a = if row == 2 { 0.5 } else { 1.0 };
            objects.push(shape(
                "rect",
                &format!("bg-{row}-{col}"),
                f64::from(col * 32),
                f64::from(row * 32),
                32.0,
                32.0,
                z,
                [c[0], c[1], c[2], a],
                1.0,
                BlendMode::Normal,
            ));
            z += 1;
        }
    }
    objects.push(shape(
        "rect",
        "add",
        0.0,
        0.0,
        80.0,
        96.0,
        z,
        [0.9, 0.8, 0.7, 1.0],
        0.5,
        BlendMode::Add,
    ));
    z += 1;
    for j in 0..2u32 {
        for i in 0..4u32 {
            let c = PALETTE[(3 + i * 2 + j) as usize % PALETTE.len()];
            let a = if (i + j) % 2 == 0 { 1.0 } else { 0.6 };
            let opacity = if i % 2 == 0 { 1.0 } else { 0.7 };
            objects.push(shape(
                "rect",
                &format!("top-{j}-{i}"),
                f64::from(5 + 36 * i),
                f64::from(6 + 44 * j),
                30.0,
                36.0,
                z,
                [c[0], c[1], c[2], a],
                opacity,
                mode,
            ));
            z += 1;
        }
    }
    objects.push(shape(
        "ellipse",
        "disc",
        96.0,
        22.0,
        52.0,
        52.0,
        z,
        [0.2, 0.7, 0.4, 1.0],
        0.8,
        mode,
    ));
    scene(
        &format!("gpu-320-{}-{}", wire(mode), space.as_str()),
        160,
        96,
        space,
        objects,
    )
}

/// EffectCraft's failing scene shape, at its sizes, for one mode.
fn nan_scene(mode: BlendMode) -> SceneDocument {
    let mut objects = Vec::new();
    let mut z = 0;
    for row in 0..4u32 {
        for col in 0..6u32 {
            let c = PALETTE[(row * 6 + col) as usize % PALETTE.len()];
            objects.push(shape(
                "rect",
                &format!("bg-{row}-{col}"),
                f64::from(col * 17),
                f64::from(row * 16),
                17.0,
                16.0,
                z,
                [c[0], c[1], c[2], 1.0],
                1.0,
                BlendMode::Normal,
            ));
            z += 1;
        }
    }
    objects.push(shape(
        "rect",
        "add",
        6.0,
        4.0,
        80.0,
        50.0,
        z,
        [0.95, 0.9, 0.85, 1.0],
        0.5,
        BlendMode::Add,
    ));
    z += 1;
    let mut top = shape(
        "ellipse",
        "top",
        52.3,
        29.6,
        64.0,
        48.0,
        z,
        [0.85, 0.35, 0.6, 1.0],
        0.7,
        mode,
    );
    top["rotation"] = json!(17.0);
    top["scaleX"] = json!(1.15);
    top["scaleY"] = json!(0.9);
    top["anchor"] = json!({ "x": 32.0, "y": 24.0 });
    objects.push(top);
    scene(
        &format!("gpu-320-nan-{}", wire(mode)),
        97,
        61,
        WorkingColorSpace::LinearSrgb,
        objects,
    )
}

fn publish(engine: &mut Engine, doc: SceneDocument) -> (TakeId, Revision, ContentHash) {
    for asset in &doc.assets {
        if let Some(hash) = &asset.checksum {
            engine.record_verified_asset_bytes(hash.clone(), INTER.to_vec());
        }
    }
    match engine.publish(doc) {
        PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } => (take_id, revision, content_hash),
        other => panic!("scene must publish: {other:?}"),
    }
}

fn take(engine: &mut Engine, pin: &(TakeId, Revision, ContentHash)) {
    let reply = engine.handle(ClientRequest::Take(TakeRequest {
        take_id: pin.0.clone(),
        revision: pin.1,
        content_hash: Some(pin.2.clone()),
        at: TakeAt::NextOpportunity,
    }));
    assert!(matches!(reply, EngineReply::Taken(_)), "{reply:?}");
}

/// (worst channel delta, differing pixels, total pixels)
fn difference(actual: &Frame, expected: &Frame) -> (u8, usize, usize) {
    assert_eq!(
        (actual.width, actual.height),
        (expected.width, expected.height)
    );
    let mut worst = 0u8;
    let mut differing = 0;
    for (a, e) in actual
        .pixels
        .chunks_exact(4)
        .zip(expected.pixels.chunks_exact(4))
    {
        let delta = a.iter().zip(e).map(|(a, e)| a.abs_diff(*e)).max().unwrap();
        worst = worst.max(delta);
        differing += usize::from(delta > 0);
    }
    (worst, differing, actual.pixels.len() / 4)
}

/// (worst ULP distance, worst relative difference, differing values) over
/// every component of the working-space pixels.
fn working_difference(
    gpu: &[crate::colour_pipeline::WorkingRgba],
    cpu: &[crate::colour_pipeline::WorkingRgba],
) -> (u32, f32, usize) {
    assert_eq!(gpu.len(), cpu.len());
    let mut ulps = 0u32;
    let mut relative = 0f32;
    let mut differing = 0usize;
    for (g, c) in gpu.iter().zip(cpu) {
        for (g, c) in [(g.r, c.r), (g.g, c.g), (g.b, c.b), (g.a, c.a)] {
            if g.to_bits() == c.to_bits() || (g == 0.0 && c == 0.0) {
                continue;
            }
            differing += 1;
            let ordered = |v: f32| {
                let b = v.to_bits() as i32;
                if b < 0 {
                    i32::MIN - b
                } else {
                    b
                }
            };
            ulps = ulps.max(ordered(g).abs_diff(ordered(c)));
            relative = relative.max((g - c).abs() / c.abs().max(1e-3));
        }
    }
    (ulps, relative, differing)
}

fn evidence(name: &str, value: &Value) {
    if let Some(dir) = std::env::var_os("GX_GPU_320_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::PathBuf::from(&dir).join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "requires hardware GPU; 3.20 every blend mode matches its CPU reference"]
fn every_blend_mode_composites_on_the_gpu_and_matches_its_cpu_reference() {
    let (mut engine, ticks) = hardware_engine();
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        for mode in BlendMode::ALL {
            let doc = mode_scene(mode, space);
            let layers = doc.objects.len();
            let pin = publish(&mut engine, doc);
            take(&mut engine, &pin);
            ticks.store(ticks.load(Ordering::Relaxed) + 1, Ordering::Relaxed);
            let program = engine.emit_frame_settled().unwrap().frame;
            let preview = engine.take_preview().unwrap();
            let trace = engine.program_frame_trace().unwrap().clone();
            assert_eq!(
                trace.backend, "gpu-compositor",
                "{mode:?} {space:?} must composite on the GPU"
            );
            assert_eq!(trace.work.cpu_full_frame_rasterizations, 0);
            assert_eq!(trace.work.cpu_source_rasterizations, 0);
            assert_eq!(trace.work.gpu_layer_dispatches, layers as u64);
            let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
            let p = difference(
                &program,
                &cpu.frame_at(trace.scene_frame, OutputTransform::Rec709)
                    .unwrap(),
            );
            let v = difference(
                &preview,
                &cpu.frame_at(trace.scene_frame, OutputTransform::Srgb)
                    .unwrap(),
            );
            // The working-space floats, before either encode.
            let reference = cpu.working_at(trace.scene_frame).unwrap();
            let key = (pin.0.clone(), pin.1);
            let (_, _, gpu_working) = engine
                .gpu_prepared
                .get_mut(&key)
                .unwrap()
                .render_with_working(trace.scene_frame)
                .unwrap();
            let w = working_difference(&gpu_working.pixels, reference.pixels());
            let encoded_exactly = gpu_working.encode(OutputTransform::Rec709) == *program
                && gpu_working.encode(OutputTransform::Srgb) == *preview;
            if !(w.1 <= 1e-4 && encoded_exactly && p.0 <= 1 && v.0 <= 1) {
                failures.push(format!("{mode:?} {space:?}: program {p:?} preview {v:?} working {w:?} encodedExactly {encoded_exactly}"));
            }
            rows.push(json!({ "mode": wire(mode), "workingSpace": space.as_str(),
                "program": { "worstDelta": p.0, "differingPixels": p.1, "pixels": p.2 },
                "preview": { "worstDelta": v.0, "differingPixels": v.1, "pixels": v.2 },
                "working": { "worstUlps": w.0, "worstRelative": w.1, "differingValues": w.2 } }));
        }
    }
    evidence(
        "modes.json",
        &json!({ "adapter": engine.gpu_description(),
        "criterion": "working-space floats within 1e-4 relative (absolute below 1e-3) of the CPU renderer; output bytes exactly the CPU encode of the GPU working pixels; at most one code value from the CPU frame",
        "rows": rows }),
    );
    assert!(
        failures.is_empty(),
        "modes that do not match their CPU reference: {failures:#?}"
    );
}

#[test]
#[ignore = "requires hardware GPU; 3.20 Dancing Dissolve moves per frame on GPU and CPU alike"]
fn dancing_dissolve_changes_each_frame_and_matches_the_cpu_reference() {
    let (mut engine, ticks) = hardware_engine();
    let pin = publish(
        &mut engine,
        mode_scene(BlendMode::DancingDissolve, WorkingColorSpace::Srgb),
    );
    take(&mut engine, &pin);
    let mut frames = Vec::new();
    for _ in 0..3 {
        ticks.store(ticks.load(Ordering::Relaxed) + 1, Ordering::Relaxed);
        let program = engine.emit_frame_settled().unwrap().frame;
        let scene_frame = engine.program_frame_trace().unwrap().scene_frame;
        let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
        assert!(
            cpu.has_animation(),
            "a Dancing Dissolve scene re-evaluates every frame"
        );
        let d = difference(
            &program,
            &cpu.frame_at(scene_frame, OutputTransform::Rec709).unwrap(),
        );
        assert!(d.0 <= 1, "frame {scene_frame}: {d:?}");
        frames.push(program);
    }
    assert_ne!(
        frames[0].pixels, frames[1].pixels,
        "the pattern moves between frames"
    );
}

#[test]
#[ignore = "requires hardware GPU; 3.20 regression: EffectCraft DX12 32-bit Darken NaN, 11 October 2026"]
fn regression_dx12_32_bit_darken_nan_of_11_october() {
    no_nan_and_deterministic(BlendMode::Darken);
}

#[test]
#[ignore = "requires hardware GPU; 3.20 regression: EffectCraft DX12 32-bit Classic Difference NaN, 12 October 2026"]
fn regression_dx12_32_bit_classic_difference_nan_of_12_october() {
    no_nan_and_deterministic(BlendMode::ClassicDifference);
}

fn no_nan_and_deterministic(mode: BlendMode) {
    const RUNS: usize = 200;
    let (mut engine, _ticks) = hardware_engine();
    let pin = publish(&mut engine, nan_scene(mode));
    let key = (pin.0.clone(), pin.1);
    let scene = engine
        .gpu_prepared
        .get_mut(&key)
        .expect("the GPU scene is prepared at publish");
    let mut first: Option<Vec<u32>> = None;
    let mut over_range = 0usize;
    let mut partial = 0usize;
    for run in 0..RUNS {
        let (_, _, working) = scene.render_with_working(0).unwrap();
        let bits: Vec<u32> = working
            .pixels
            .iter()
            .flat_map(|p| [p.r, p.g, p.b, p.a])
            .map(f32::to_bits)
            .collect();
        for (i, p) in working.pixels.iter().enumerate() {
            assert!(
                [p.r, p.g, p.b, p.a].iter().all(|v| v.is_finite()),
                "{mode:?} run {run}: non-finite working value {p:?} at pixel {i}"
            );
        }
        if run == 0 {
            over_range = working
                .pixels
                .iter()
                .filter(|p| p.r > p.a || p.g > p.a || p.b > p.a)
                .count();
            partial = working
                .pixels
                .iter()
                .filter(|p| p.a > 0.0 && p.a < 1.0)
                .count();
        }
        match &first {
            None => first = Some(bits),
            Some(expected) => assert!(
                *expected == bits,
                "{mode:?} run {run} differs from run 0: GPU output is not deterministic"
            ),
        }
    }
    assert!(
        over_range > 0,
        "the scene must carry over-range values into the blend, as EffectCraft's did"
    );
    evidence(
        &format!("nan-regression-{}.json", wire(mode)),
        &json!({
            "mode": wire(mode), "adapter": engine.gpu_description(), "runs": RUNS,
            "nonFiniteValues": 0, "bitIdenticalRuns": RUNS,
            "overRangePixels": over_range, "partialAlphaPixels": partial,
        }),
    );
}
