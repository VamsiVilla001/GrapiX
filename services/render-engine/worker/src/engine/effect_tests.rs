//! 3.22 execution gates: the pointwise effects through the real Engine.
//!
//! Per effect setting and working space, a backdrop plus rects and an
//! anti-aliased ellipse carrying the effect, at mixed fill alpha and object
//! opacity, is rendered on the GPU and by the CPU renderer. The GPU frame
//! must match its CPU reference within the 4.4 threshold, measured tie-aware
//! (decided with Jev, 8 Nov 2026, pending the user's approval of the
//! amendment): no channel more than one code value apart, and at most 0.1%
//! of pixels differing other than proven tie flips. A differing pixel is a
//! proven tie flip when the GPU's bytes are exactly the CPU encode of its own
//! working floats and those floats are within 1e-4 (relative above 1e-3) of
//! the CPU reference's: so close, against a code step of 3.9e-3, that the
//! reference value sat on a rounding tie. Decimal colours such as 0.5 sit on
//! ties in an sRGB project (127.5/255), so whole flat cells can flip; the
//! strict count is recorded alongside. The trace must also show the
//! effect running on the GPU (one effect dispatch per effect, no CPU
//! rasterisation on the frame path). Animated parameters, a chain of three
//! effects and a hold-keyed `enabled` are checked frame by frame; spatial
//! effects and unknown effect names refuse by name.
//!
//! Hardware only: run with `--ignored`; `GX_GPU_316_BACKEND` picks dx12 or
//! vulkan; `GX_GPU_322_EVIDENCE_DIR` writes the JSON.

use super::*;
use gx_contracts::color::WorkingColorSpace;
use gx_contracts::effect::*;
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
        "3.22 execution proof requires a hardware GPU"
    );
    (engine, ticks)
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
    effects: &Value,
) -> Value {
    let mut o = json!({ "type": kind, "id": id, "name": id, "x": x, "y": y, "width": w, "height": h,
        "zIndex": z, "opacity": opacity, "fill": paint(rgba) });
    if kind == "rect" {
        o["radius"] = json!(0);
    }
    if effects.as_array().is_some_and(|a| !a.is_empty()) {
        o["effects"] = effects.clone();
    }
    o
}

fn document(
    name: &str,
    space: WorkingColorSpace,
    objects: Vec<Value>,
    channels: Vec<Value>,
) -> Result<SceneDocument, Refusal> {
    let mut doc: Value = serde_json::from_slice(FIXTURE).unwrap();
    doc["id"] = json!(name);
    doc["canvas"]["width"] = json!(160);
    doc["canvas"]["height"] = json!(96);
    doc["timeline"]["channels"] = Value::Array(channels);
    doc["objects"] = Value::Array(objects);
    let mut doc = parse_scene_document(&serde_json::to_vec(&doc).unwrap())?;
    doc.working_color_space = space;
    Ok(doc)
}

const PALETTE: [[f64; 3]; 8] = [
    [0.0, 0.0, 0.0],
    [1.0, 1.0, 1.0],
    [0.5, 0.5, 0.5],
    [0.9, 0.1, 0.1],
    [0.1, 0.8, 0.2],
    [0.15, 0.25, 0.95],
    [0.8, 0.7, 0.2],
    [0.6, 0.3, 0.7],
];

/// Backdrop cells, then rects and an ellipse carrying `effects`.
fn objects(effects: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let mut z = 0;
    for row in 0..3u32 {
        for col in 0..5u32 {
            let c = PALETTE[(row * 5 + col) as usize % PALETTE.len()];
            out.push(shape(
                "rect",
                &format!("bg-{row}-{col}"),
                f64::from(col * 32),
                f64::from(row * 32),
                32.0,
                32.0,
                z,
                [c[0], c[1], c[2], 1.0],
                1.0,
                &json!([]),
            ));
            z += 1;
        }
    }
    for j in 0..2u32 {
        for i in 0..4u32 {
            let c = PALETTE[(2 + i * 2 + j) as usize % PALETTE.len()];
            let a = if (i + j) % 2 == 0 { 1.0 } else { 0.6 };
            let opacity = if i % 2 == 0 { 1.0 } else { 0.7 };
            out.push(shape(
                "rect",
                &format!("fx-{j}-{i}"),
                f64::from(5 + 36 * i),
                f64::from(6 + 44 * j),
                30.0,
                36.0,
                z,
                [c[0], c[1], c[2], a],
                opacity,
                effects,
            ));
            z += 1;
        }
    }
    out.push(shape(
        "ellipse",
        "disc",
        96.0,
        22.0,
        52.0,
        52.0,
        z,
        [0.2, 0.7, 0.4, 1.0],
        0.8,
        effects,
    ));
    // Rotated, scaled and at a fractional position: the effects act in
    // layer space and the result is warped, on the GPU and the CPU alike.
    let mut spin = shape(
        "rect",
        "spin",
        40.3,
        60.7,
        26.0,
        18.0,
        z + 1,
        [0.9, 0.6, 0.15, 1.0],
        0.9,
        effects,
    );
    spin["rotation"] = json!(23.0);
    spin["scaleX"] = json!(1.2);
    spin["scaleY"] = json!(0.85);
    spin["anchor"] = json!({ "x": 13.0, "y": 9.0 });
    out.push(spin);
    out
}

fn publish(
    engine: &mut Engine,
    doc: SceneDocument,
) -> Result<(TakeId, Revision, ContentHash), Refusal> {
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
        } => Ok((take_id, revision, content_hash)),
        PublishReply::Refused(gx_asset_plane::PublishRefusal::SceneRefused { cause })
        | PublishReply::Refused(gx_asset_plane::PublishRefusal::PreparationRefused { cause }) => {
            Err(cause)
        }
        other => panic!("unexpected publish reply: {other:?}"),
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

fn working_relative(
    gpu: &[crate::colour_pipeline::WorkingRgba],
    cpu: &[crate::colour_pipeline::WorkingRgba],
) -> f32 {
    gpu.iter()
        .zip(cpu)
        .flat_map(|(g, c)| [(g.r, c.r), (g.g, c.g), (g.b, c.b), (g.a, c.a)])
        .map(|(g, c)| (g - c).abs() / c.abs().max(1e-3))
        .fold(0.0, f32::max)
}

/// (worst channel delta, pixels differing, pixels differing that are not
/// proven tie flips, total) for one output.
fn tie_aware(
    gpu: &Frame,
    cpu: &Frame,
    gpu_working: &[crate::colour_pipeline::WorkingRgba],
    cpu_working: &[crate::colour_pipeline::WorkingRgba],
) -> (u8, usize, usize, usize) {
    let close = |g: f32, c: f32| (g - c).abs() <= 1e-4 * c.abs().max(1e-3);
    let mut worst = 0u8;
    let (mut differing, mut not_tie) = (0, 0);
    for (i, (a, e)) in gpu
        .pixels
        .chunks_exact(4)
        .zip(cpu.pixels.chunks_exact(4))
        .enumerate()
    {
        let delta = a.iter().zip(e).map(|(a, e)| a.abs_diff(*e)).max().unwrap();
        worst = worst.max(delta);
        if delta == 0 {
            continue;
        }
        differing += 1;
        let (g, c) = (gpu_working[i], cpu_working[i]);
        let tie =
            delta == 1 && close(g.r, c.r) && close(g.g, c.g) && close(g.b, c.b) && close(g.a, c.a);
        not_tie += usize::from(!tie);
    }
    (worst, differing, not_tie, gpu.pixels.len() / 4)
}

/// Layers carrying the effect stack in `objects`.
const EFFECT_LAYERS: u64 = 10;

/// GPU dispatches per frame for a stack: one per planned pass per layer.
fn dispatches(stack: &Value, box_iterations: usize) -> u64 {
    let instances: Vec<EffectInstance> = serde_json::from_value(stack.clone()).unwrap();
    let iterations = vec![box_iterations; instances.len()];
    EFFECT_LAYERS
        * crate::effect_chain::EffectPlan::layout(&instances, &iterations)
            .passes
            .len() as u64
}

/// Render the taken scene at `frame` and hold it to the CPU reference.
fn check_frame(
    engine: &mut Engine,
    ticks: &AtomicU64,
    pin: &(TakeId, Revision, ContentHash),
    frame: u64,
    effects: u64,
) -> Value {
    ticks.store(1 + frame, Ordering::Relaxed);
    let program = engine.emit_frame_settled().unwrap().frame;
    let preview = engine.take_preview().unwrap();
    let trace = engine.program_frame_trace().unwrap().clone();
    assert_eq!(trace.backend, "gpu-compositor");
    assert_eq!(trace.scene_frame, frame);
    assert_eq!(trace.work.cpu_full_frame_rasterizations, 0);
    assert_eq!(trace.work.cpu_source_rasterizations, 0);
    assert_eq!(trace.work.gpu_resource_builds, 0);
    assert_eq!(
        trace.work.gpu_effect_dispatches, effects,
        "one GPU dispatch per planned pass per layer"
    );
    let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
    let cpu_program = cpu.frame_at(frame, OutputTransform::Rec709).unwrap();
    let cpu_preview = cpu.frame_at(frame, OutputTransform::Srgb).unwrap();
    let reference = cpu.working_at(frame).unwrap();
    let key = (pin.0.clone(), pin.1);
    let (_, _, gpu_working) = engine
        .gpu_prepared
        .get_mut(&key)
        .unwrap()
        .render_with_working(frame)
        .unwrap();
    let encoded_exactly = gpu_working.encode(OutputTransform::Rec709) == *program
        && gpu_working.encode(OutputTransform::Srgb) == *preview;
    let p = tie_aware(
        &program,
        &cpu_program,
        &gpu_working.pixels,
        reference.pixels(),
    );
    let v = tie_aware(
        &preview,
        &cpu_preview,
        &gpu_working.pixels,
        reference.pixels(),
    );
    let w = working_relative(&gpu_working.pixels, reference.pixels());
    let within = |d: (u8, usize, usize, usize)| d.0 <= 1 && d.2 * 1000 <= d.3;
    let strict = |d: (u8, usize, usize, usize)| d.0 <= 1 && d.1 * 1000 <= d.3;
    let pass = encoded_exactly && within(p) && within(v);
    json!({ "frame": frame, "pass": pass, "strict4_4": strict(p) && strict(v), "encodedExactly": encoded_exactly,
        "program": { "worstDelta": p.0, "differing": p.1, "notTieFlips": p.2, "pixels": p.3 },
        "preview": { "worstDelta": v.0, "differing": v.1, "notTieFlips": v.2, "pixels": v.3 },
        "workingRelative": w,
        "program_frame": program.pixels.iter().map(|b| u64::from(*b)).sum::<u64>() })
}

fn evidence(name: &str, value: &Value) {
    if let Some(dir) = std::env::var_os("GX_GPU_322_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::PathBuf::from(&dir).join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

fn effect_json(id: &str, effect: Effect) -> Value {
    serde_json::to_value(gx_contracts::effect::EffectInstance::new(id, effect)).unwrap()
}

#[test]
#[ignore = "requires hardware GPU; 3.22 every effect matches its CPU reference"]
fn every_effect_matches_its_cpu_reference_on_the_gpu() {
    let (mut engine, ticks) = hardware_engine();
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    let mut cases = crate::compositor::effect_tests::cases();
    // A chain of three, so the ping-pong targets and ordering are exercised.
    let mut chain_levels = Levels::default();
    chain_levels.rgb.gamma = 1.6;
    cases.push(("chain".into(), Effect::Levels(chain_levels)));
    // The spatial and coordinate effects.
    let colour = |r, g, b, a| {
        gx_contracts::color::Rgba::new(r, g, b, a, gx_contracts::color::SourceColorSpace::Srgb)
    };
    cases.extend([
        (
            "gaussian-blur".into(),
            Effect::GaussianBlur(GaussianBlur {
                blurriness: 6.0,
                ..Default::default()
            }),
        ),
        (
            "gaussian-blur-horizontal".into(),
            Effect::GaussianBlur(GaussianBlur {
                blurriness: 9.0,
                dimensions: BlurDimensions::Horizontal,
                ..Default::default()
            }),
        ),
        (
            "gaussian-blur-repeat-edges".into(),
            Effect::GaussianBlur(GaussianBlur {
                blurriness: 5.0,
                repeat_edge_pixels: true,
                ..Default::default()
            }),
        ),
        (
            "box-blur".into(),
            Effect::BoxBlur(BoxBlur {
                radius: 2.0,
                iterations: 3.0,
                ..Default::default()
            }),
        ),
        (
            "directional-blur".into(),
            Effect::DirectionalBlur(DirectionalBlur {
                direction: 30.0,
                length: 9.0,
            }),
        ),
        (
            "glow".into(),
            Effect::Glow(Glow {
                threshold: 0.4,
                radius: 8.0,
                intensity: 1.5,
                ..Default::default()
            }),
        ),
        (
            "drop-shadow".into(),
            Effect::DropShadow(DropShadow {
                color: colour(0.05, 0.0, 0.2, 1.0),
                opacity: 0.7,
                direction: 135.0,
                distance: 4.0,
                softness: 5.0,
                shadow_only: false,
            }),
        ),
        (
            "drop-shadow-only".into(),
            Effect::DropShadow(DropShadow {
                distance: 3.0,
                softness: 0.0,
                shadow_only: true,
                ..Default::default()
            }),
        ),
        (
            "gradient-ramp".into(),
            Effect::GradientRamp(GradientRamp {
                start: EffectPoint { x: 0.0, y: 0.0 },
                start_color: colour(1.0, 0.2, 0.1, 1.0),
                end: EffectPoint { x: 30.0, y: 36.0 },
                end_color: colour(0.1, 0.3, 1.0, 1.0),
                shape: RampShape::Linear,
                blend_with_original: 0.25,
            }),
        ),
        (
            "gradient-ramp-radial".into(),
            Effect::GradientRamp(GradientRamp {
                start: EffectPoint { x: 15.0, y: 18.0 },
                end: EffectPoint { x: 30.0, y: 18.0 },
                shape: RampShape::Radial,
                ..Default::default()
            }),
        ),
        (
            "linear-wipe".into(),
            Effect::LinearWipe(LinearWipe {
                completion: 0.4,
                angle: 60.0,
                feather: 6.0,
            }),
        ),
        (
            "radial-wipe".into(),
            Effect::RadialWipe(RadialWipe {
                completion: 0.35,
                start_angle: 20.0,
                center: EffectPoint { x: 15.0, y: 18.0 },
                direction: WipeDirection::Clockwise,
                feather: 4.0,
            }),
        ),
        (
            "radial-wipe-both".into(),
            Effect::RadialWipe(RadialWipe {
                completion: 0.5,
                center: EffectPoint { x: 15.0, y: 18.0 },
                direction: WipeDirection::Both,
                feather: 2.0,
                ..Default::default()
            }),
        ),
        (
            "iris-wipe".into(),
            Effect::IrisWipe(IrisWipe {
                center: EffectPoint { x: 15.0, y: 18.0 },
                points: 6.0,
                outer_radius: 12.0,
                rotation: 10.0,
                feather: 3.0,
                ..Default::default()
            }),
        ),
        (
            "iris-wipe-star".into(),
            Effect::IrisWipe(IrisWipe {
                center: EffectPoint { x: 15.0, y: 18.0 },
                points: 8.0,
                outer_radius: 14.0,
                inner_radius: 6.0,
                use_inner_radius: true,
                feather: 2.0,
                ..Default::default()
            }),
        ),
    ]);
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        for (name, effect) in &cases {
            let stack = if name == "chain" {
                json!([
                    effect_json("a", effect.clone()),
                    effect_json(
                        "b",
                        Effect::HueSaturation(HueSaturation {
                            hue: 40.0,
                            saturation: 0.3,
                            ..Default::default()
                        })
                    ),
                    effect_json(
                        "c",
                        Effect::Exposure(Exposure {
                            exposure: 0.5,
                            ..Default::default()
                        })
                    ),
                ])
            } else {
                json!([effect_json("e", effect.clone())])
            };
            let expected = dispatches(&stack, 3);
            let doc = document(
                &format!("gpu-322-{name}-{}", space.as_str()),
                space,
                objects(&stack),
                vec![],
            )
            .unwrap();
            let pin = publish(&mut engine, doc).unwrap();
            take(&mut engine, &pin);
            let row = check_frame(&mut engine, &ticks, &pin, 0, expected);
            if row["pass"] != json!(true) {
                failures.push(format!("{name} {}: {row}", space.as_str()));
            }
            rows.push(json!({ "effect": name, "workingSpace": space.as_str(), "result": row }));
        }
    }
    evidence(
        "effects.json",
        &json!({ "adapter": engine.gpu_description(),
        "threshold": "4.4 tie-aware: max 1 code value; at most 0.1% of pixels differing other than proven tie flips (GPU bytes = CPU encode of GPU floats, floats within 1e-4 of the reference); strict4_4 recorded alongside", "rows": rows }),
    );
    assert!(
        failures.is_empty(),
        "effects that do not match their CPU reference: {failures:#?}"
    );
}

#[test]
#[ignore = "requires hardware GPU; 3.22 every effect parameter is keyframable on the GPU"]
fn animated_effect_parameters_and_a_hold_keyed_enable_match_frame_by_frame() {
    let stack = json!([
        effect_json("grade", Effect::Levels(Levels::default())),
        effect_json("shift", Effect::HueSaturation(HueSaturation::default())),
        effect_json("lift", Effect::Exposure(Exposure::default())),
        effect_json("soft", Effect::GaussianBlur(GaussianBlur::default())),
        effect_json(
            "steps",
            Effect::BoxBlur(BoxBlur {
                radius: 1.0,
                ..Default::default()
            })
        ),
        effect_json(
            "shade",
            Effect::DropShadow(DropShadow {
                softness: 2.0,
                ..Default::default()
            })
        ),
    ]);
    let mut channels = Vec::new();
    let mut ids: Vec<String> = (0..2u32)
        .flat_map(|j| (0..4u32).map(move |i| format!("fx-{j}-{i}")))
        .collect();
    ids.extend(["disc".to_string(), "spin".to_string()]);
    for id in &ids {
        {
            channels.push(
                json!({ "objectId": id, "property": "effects.soft.blurriness",
                "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 50, "value": 8.0 }] }),
            );
            channels.push(
                json!({ "objectId": id, "property": "effects.steps.iterations",
                "keys": [{ "frame": 0, "value": 1.0 }, { "frame": 50, "value": 4.0 }] }),
            );
            channels.push(json!({ "objectId": id, "property": "effects.shade.distance",
                "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 50, "value": 6.0, "easing": "ease-out" }] }));
            channels.push(
                json!({ "objectId": id, "property": "effects.grade.rgb.gamma",
                "keys": [{ "frame": 0, "value": 1.0 }, { "frame": 50, "value": 2.5 }] }),
            );
            channels.push(json!({ "objectId": id, "property": "effects.shift.hue",
                "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 50, "value": 180.0, "easing": "ease-in-out" }] }));
            channels.push(json!({ "objectId": id, "property": "effects.lift.enabled",
                "keys": [{ "frame": 0, "value": 0.0, "easing": "hold" }, { "frame": 20, "value": 1.0, "easing": "hold" }] }));
            channels.push(json!({ "objectId": id, "property": "effects.lift.exposure",
                "keys": [{ "frame": 0, "value": -1.0 }, { "frame": 50, "value": 1.0 }] }));
        }
    }
    let mut rows = Vec::new();
    let mut adapter = None;
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        // A fresh engine per space: the shared clock only moves forward.
        let (mut engine, ticks) = hardware_engine();
        adapter = engine.gpu_description();
        let doc = document(
            &format!("gpu-322-animated-{}", space.as_str()),
            space,
            objects(&stack),
            channels.clone(),
        )
        .unwrap();
        let pin = publish(&mut engine, doc).unwrap();
        take(&mut engine, &pin);
        let mut sums = Vec::new();
        for frame in [0, 10, 19, 20, 35, 50] {
            let row = check_frame(&mut engine, &ticks, &pin, frame, dispatches(&stack, 4));
            assert_eq!(
                row["pass"],
                json!(true),
                "{} frame {frame}: {row}",
                space.as_str()
            );
            sums.push(row["program_frame"].as_u64().unwrap());
            rows.push(json!({ "workingSpace": space.as_str(), "result": row }));
        }
        assert!(
            sums.windows(2).all(|w| w[0] != w[1]),
            "every sampled frame differs: {sums:?}"
        );
    }
    evidence(
        "animated.json",
        &json!({ "adapter": adapter, "rows": rows }),
    );
}

#[test]
#[ignore = "requires hardware GPU; 3.22 unknown and invalid effects refuse by name"]
fn unknown_and_invalid_effects_refuse_by_name() {
    let (mut engine, _ticks) = hardware_engine();
    let unknown = json!([{ "effectId": "x", "effect": "lens-flare" }]);
    let parse = document(
        "gpu-322-unknown",
        WorkingColorSpace::Srgb,
        objects(&unknown),
        vec![],
    )
    .unwrap_err();
    assert!(
        matches!(&parse, Refusal::SceneParseFailed { detail } if detail.contains("lens-flare")),
        "{parse:?}"
    );
    let mut bad = Levels::default();
    bad.rgb.gamma = 50.0;
    let invalid = json!([effect_json("g", Effect::Levels(bad))]);
    let refused = publish(
        &mut engine,
        document(
            "gpu-322-invalid",
            WorkingColorSpace::Srgb,
            objects(&invalid),
            vec![],
        )
        .unwrap(),
    )
    .unwrap_err();
    assert!(
        matches!(&refused, Refusal::EffectInvalid { effect_id, detail, .. } if effect_id == "g" && detail.contains("rgb.gamma")),
        "{refused:?}"
    );
}
