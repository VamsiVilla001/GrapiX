use super::*;
use gx_contracts::color::{ColorValue, Rgba, WorkingColorSpace};
use gx_contracts::scene::{parse_scene_document, ObjectBase, RectObject, SceneObject};
use gx_control_plane::intent::{ClearRequest, TakeRequest};
use serde_json::json;

const INTER: &[u8] = include_bytes!("../../tests/fixtures/Inter-Regular.ttf");

fn lower_third() -> SceneDocument {
    parse_scene_document(include_bytes!(
        "../../tests/fixtures/gpu-lower-third-50.json"
    ))
    .unwrap()
}

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
        "3.16 execution proof requires a hardware GPU"
    );
    (engine, ticks)
}

fn publish(engine: &mut Engine, scene: SceneDocument) -> (TakeId, Revision, ContentHash) {
    for asset in &scene.assets {
        if let Some(hash) = &asset.checksum {
            assert_eq!(*hash, gx_asset_plane::content_hash(INTER));
            engine.record_verified_asset_bytes(hash.clone(), INTER.to_vec());
        }
    }
    match engine.publish(scene) {
        PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } => (take_id, revision, content_hash),
        other => panic!("scene must publish: {other:?}"),
    }
}

fn take(engine: &mut Engine, pin: &(TakeId, Revision, ContentHash)) -> EngineReply {
    engine.handle(ClientRequest::Take(TakeRequest {
        take_id: pin.0.clone(),
        revision: pin.1,
        content_hash: Some(pin.2.clone()),
        at: TakeAt::NextOpportunity,
    }))
}

/// 3.17's drawing rule (user decision 15 Nov 2026): vector content drawn by
/// Vello GPU matches the Vello CPU reference to at most one code value per
/// channel, on any share of pixels, the colour of a pixel transparent on both
/// sides excepted. Text and every other route are unchanged
/// and must match exactly, which this rule also admits; the share is recorded.
fn assert_within_one_code(actual: &Frame, expected: &Frame, what: &str) {
    assert_eq!(
        (actual.width, actual.height),
        (expected.width, expected.height),
        "{what}: size"
    );
    let mut worst = (0_u8, 0_usize);
    let mut over = 0_usize;
    for (i, (a, b)) in actual.pixels.iter().zip(&expected.pixels).enumerate() {
        // A pixel whose alpha is code 0 on both sides is invisible; its
        // straight colour is a quotient by an alpha too small to show, and is
        // not compared.
        let alpha = i - i % 4 + 3;
        if i % 4 != 3 && actual.pixels[alpha] == 0 && expected.pixels[alpha] == 0 {
            continue;
        }
        let delta = a.abs_diff(*b);
        over += usize::from(delta > 1);
        if delta > worst.0 {
            worst = (delta, i);
        }
    }
    let pixel = worst.1 / 4;
    let (x, y) = (pixel as u32 % actual.width, pixel as u32 / actual.width);
    let at = |f: &Frame| f.pixels[pixel * 4..pixel * 4 + 4].to_vec();
    assert!(
        worst.0 <= 1,
        "{what}: worst channel delta {} exceeds one code value at ({x}, {y}): {:?} vs {:?}; {over} channels over one",
        worst.0,
        at(actual),
        at(expected)
    );
}

fn difference(actual: &Frame, expected: &Frame) -> serde_json::Value {
    assert_eq!(
        (actual.width, actual.height),
        (expected.width, expected.height)
    );
    let mut worst = 0_u8;
    let mut differing = 0;
    for (a, e) in actual
        .pixels
        .chunks_exact(4)
        .zip(expected.pixels.chunks_exact(4))
    {
        let mut differs = false;
        for (&a, &e) in a.iter().zip(e) {
            worst = worst.max(a.abs_diff(e));
            differs |= a != e;
        }
        differing += usize::from(differs);
    }
    json!({"differingPixels": differing, "worstChannelDelta": worst})
}

fn evidence(name: &str, data: &serde_json::Value) {
    println!("{}", serde_json::to_string(data).unwrap());
    if let Some(dir) = std::env::var_os("GX_GPU_316_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::PathBuf::from(dir).join(name),
            serde_json::to_vec_pretty(data).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn authored_program_refuses_cpu_tiers_before_committing_and_headless_remains_available() {
    for tier in [DeviceTier::T2, DeviceTier::T3] {
        let ticks = Arc::new(AtomicU64::new(0));
        let mut engine = Engine::with_gpu(ticks, Locality::CoLocated, Gpu::without_hardware(tier));
        let scene = super::tests::animated_scene();
        let pin = publish(&mut engine, scene);
        assert!(
            matches!(take(&mut engine, &pin), EngineReply::Refused(Refusal::TierTooLow { actual }) if actual == tier)
        );
        assert!(engine.program.is_none());
        let image = engine.handle(ClientRequest::Render(
            gx_control_plane::render::RenderRequest {
                take_id: pin.0,
                revision: pin.1,
                content_hash: Some(pin.2),
                frame: 50,
            },
        ));
        assert!(
            matches!(image, EngineReply::Rendered(_)),
            "explicit CPU headless reference still works"
        );
    }
}

#[test]
fn source_changing_animation_refuses_by_object_and_document_path() {
    let ticks = Arc::new(AtomicU64::new(0));
    let mut engine = Engine::with_gpu(
        ticks,
        Locality::CoLocated,
        Gpu::without_hardware(DeviceTier::T2),
    );
    let mut scene = super::tests::animated_scene();
    scene.timeline.channels[0].property = "width".into();
    let expected = gx_contracts::drawability::gpu_compositor_animation_refusal(&scene).unwrap();
    assert!(
        matches!(engine.publish(scene), PublishReply::Refused(PublishRefusal::PreparationRefused { cause }) if cause == expected)
    );
    assert!(
        matches!(expected, Refusal::ScenePropertyNotDrawable { object, property, .. }
        if object == "card" && property.starts_with("timeline.channels[0].property:"))
    );
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 Engine Program execution gate"]
fn gpu_engine_lower_third_trace_and_output_comparisons() {
    let mut runs = Vec::new();
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (mut engine, ticks) = hardware_engine();
        let mut doc = lower_third();
        doc.working_color_space = space;
        let before = RenderWork::snapshot();
        let pin = publish(&mut engine, doc);
        let prepare_work = RenderWork::snapshot().since(before);
        assert_eq!(prepare_work.cpu_full_frame_rasterizations, 0);
        // 3.17 and 3.18: the plate, the accent and the headline's glyph
        // outlines are all drawn on the GPU.
        assert_eq!(prepare_work.cpu_source_rasterizations, 0);
        assert!(prepare_work.gpu_resource_builds > 0);
        let sources = engine.gpu_source_trace(&pin.0, pin.1).unwrap().to_vec();
        assert_eq!(
            sources
                .iter()
                .map(|s| s.object_id.as_str())
                .collect::<Vec<_>>(),
            ["plate", "headline", "accent"]
        );
        assert_eq!(
            sources.iter().map(|s| s.route).collect::<Vec<_>>(),
            [
                "gpu-vello-coverage-at-prepare",
                "gpu-vello-coverage-at-prepare",
                "gpu-vello-coverage-at-prepare"
            ]
        );
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        let mut frames = Vec::new();
        for scene_frame in [0, 25, 50, 100] {
            ticks.store(1 + scene_frame, Ordering::Relaxed);
            let program = engine.emit_frame_settled().unwrap().frame;
            let preview = engine.take_preview().unwrap();
            let trace = engine.program_frame_trace().unwrap().clone();
            assert_eq!(trace.backend, "gpu-compositor");
            assert_eq!(trace.scene_frame, scene_frame);
            assert_eq!(trace.work.cpu_full_frame_rasterizations, 0);
            assert_eq!(trace.work.cpu_source_rasterizations, 0);
            assert_eq!(trace.work.gpu_resource_builds, 0);
            assert_eq!(trace.work.gpu_layer_dispatches, 3);
            if scene_frame == 0 {
                assert!(program.is_black());
            } else {
                assert!(!program.is_black());
                if scene_frame == 100 {
                    assert!(preview.pixels.chunks_exact(4).filter(|p| p[0] > 240 && p[1] > 240 && p[2] > 240).count() > 100,
                        "packaged glyph outlines must appear in the real engine Preview at full opacity");
                }
            }
            let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
            let reference_program = cpu.frame_at(scene_frame, OutputTransform::Rec709).unwrap();
            let reference_preview = cpu.frame_at(scene_frame, OutputTransform::Srgb).unwrap();
            assert_within_one_code(
                &program,
                &reference_program,
                &format!("lower-third Program at {space:?}/{scene_frame}"),
            );
            assert_within_one_code(
                &preview,
                &reference_preview,
                &format!("lower-third Preview at {space:?}/{scene_frame}"),
            );
            if scene_frame == 100 {
                if let Some(dir) = std::env::var_os("GX_GPU_316_EVIDENCE_DIR") {
                    std::fs::create_dir_all(&dir).unwrap();
                    std::fs::write(
                        std::path::PathBuf::from(&dir)
                            .join(format!("lower-third-{}-preview.png", space.as_str())),
                        crate::headless::encode_png(&preview),
                    )
                    .unwrap();
                }
            }
            frames.push(json!({"trace": trace,
                "previewVersusCpuReference": difference(&preview, &reference_preview),
                "programVersusCpuReference": difference(&program, &reference_program)}));
        }
        runs.push(json!({"workingSpace": space, "adapter": engine.gpu_description(),
            "prepareWork": prepare_work, "sources": sources, "frames": frames,
            "readback": "bounded synchronous float readback; output encoding once per output; 3.21 not claimed"}));
    }
    evidence(
        "lower-third-trace.json",
        &json!({"fixture": "gpu-lower-third-50.json", "runs": runs}),
    );
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 Engine Program execution gate"]
fn gpu_engine_half_black_working_spaces_and_order() {
    for (space, preview_code, program_code) in [
        (WorkingColorSpace::Srgb, 128_u8, 115_u8),
        (WorkingColorSpace::LinearSrgb, 188, 180),
    ] {
        let (mut engine, ticks) = hardware_engine();
        let mut doc = super::tests::animated_scene();
        doc.working_color_space = space;
        doc.timeline.channels.clear();
        doc.objects = [1.0, 0.0]
            .into_iter()
            .enumerate()
            .map(|(index, c)| {
                let mut base = ObjectBase::new(format!("layer-{index}"), "half-black overlap");
                base.width = 16.0;
                base.height = 16.0;
                base.fill = Some(ColorValue::Solid {
                    color: Rgba::srgb(c, c, c, 1.0),
                });
                base.opacity = if index == 0 { 1.0 } else { 0.5 };
                SceneObject::Rect(RectObject { base, radius: 0.0 })
            })
            .collect();
        let pin = publish(&mut engine, doc);
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        ticks.store(1, Ordering::Relaxed);
        let program = engine.emit_frame_settled().unwrap().frame;
        let preview = engine.take_preview().unwrap();
        for (frame, code) in [(&*program, program_code), (&*preview, preview_code)] {
            let pixel = &frame.pixels[(5 * frame.width as usize + 5) * 4..][..4];
            assert!(
                pixel[..3].iter().all(|p| p.abs_diff(code) <= 1),
                "{space:?}: {pixel:?}"
            );
            assert_eq!(pixel[3], 255);
        }
    }
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 Engine Program execution gate"]
fn gpu_engine_unchanged_golden_frames_measured_without_rebaselining() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let (mut engine, ticks) = hardware_engine();
    let mut comparisons = Vec::new();
    let mut paths: Vec<_> = std::fs::read_dir(root.join("tests/reference-scenes"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    for path in paths {
        let doc = parse_scene_document(&std::fs::read(&path).unwrap()).unwrap();
        let pin = publish(&mut engine, doc);
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        ticks.fetch_add(1, Ordering::Relaxed);
        engine.emit_frame_settled().unwrap();
        let preview = engine.take_preview().unwrap();
        let baseline = root
            .join("tests/baselines")
            .join(path.file_stem().unwrap())
            .with_extension("png");
        let golden = crate::headless::decode_png(&std::fs::read(baseline).unwrap()).unwrap();
        let measured = difference(&preview, &golden);
        // Source textures may resample differently at subpixel placements.
        // Record the executed difference; never rewrite a golden image.
        comparisons.push(
            json!({"scene": path.file_name().unwrap().to_string_lossy(), "difference": measured}),
        );
        assert_within_one_code(
            &preview,
            &golden,
            &format!("GPU golden comparison: {}", path.display()),
        );
        assert_eq!(
            engine.program_frame_trace().unwrap().backend,
            "gpu-compositor"
        );
    }
    assert_eq!(comparisons.len(), 6);
    evidence(
        "golden-differences.json",
        &json!({"adapter": engine.gpu_description(), "comparisons": comparisons,
            "rebaselined": "15 Nov 2026 from the Vello CPU path (3.17, user decision; previous in tests/baselines/history/2026-11-15-before-3.17), and colour-ramp-50 again for its text (3.18; previous in tests/baselines/history/2026-11-15-before-3.18)"}),
    );
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 Engine Program execution gate"]
fn gpu_engine_stage_above_texture_limit_and_clear() {
    let (mut engine, ticks) = hardware_engine();
    let limit = engine.gpu.max_texture_dimension_2d().unwrap();
    let mut doc = super::tests::animated_scene();
    doc.timeline.channels.clear();
    doc.canvas.width = limit + 7;
    doc.canvas.height = 3;
    let base = doc.objects[0].base_mut();
    base.width = 2.0;
    base.height = 2.0;
    base.scale_x = f64::from(doc.canvas.width);
    base.scale_y = 10.0;
    base.x = -f64::from(doc.canvas.width) / 2.0;
    base.y = -5.0;
    let pin = publish(&mut engine, doc);
    assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
    ticks.store(1, Ordering::Relaxed);
    let program = engine.emit_frame_settled().unwrap().frame;
    assert_eq!(program.width, limit + 7);
    assert!(
        program
            .pixels
            .chunks_exact(4)
            .all(|p| p == [255, 255, 255, 255]),
        "tile seams must be invisible"
    );
    let trace = engine.program_frame_trace().unwrap().clone();
    assert!(trace.work.gpu_layer_dispatches > 1);
    evidence(
        "engine-large-stage.json",
        &json!({"textureLimit": limit, "stageWidth": program.width, "height": program.height, "allPixelsWhite": true, "trace": trace}),
    );
    let mut unsupported = super::tests::animated_scene();
    unsupported.objects[0].base_mut().width = f64::from(limit + 1);
    assert!(
        matches!(engine.publish(unsupported), PublishReply::Refused(PublishRefusal::PreparationRefused {
        cause: Refusal::ScenePropertyNotDrawable { object, property, .. }
    }) if object == "card" && property.starts_with("objects[0]:"))
    );
    assert_eq!(
        engine.emit_frame_settled().unwrap().frame,
        program,
        "a refused publish must not alter pinned Program"
    );
    assert!(matches!(
        engine.handle(ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity
        })),
        EngineReply::Cleared(_)
    ));
    let clear = engine.emit_frame_settled().unwrap().frame;
    assert!(clear.is_black());
    assert_eq!((clear.width, clear.height), (program.width, program.height));
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.16 Engine recovery execution gate"]
fn gpu_engine_recovery_rebuilds_only_at_prepare_and_never_falls_back() {
    let path = std::env::temp_dir().join(format!(
        "gx-gpu-recovery-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    {
        let (mut original, ticks) = hardware_engine();
        original
            .attach_recovery_journal(RecoveryJournal::open_at(path.clone()).unwrap())
            .unwrap();
        let pin = publish(&mut original, super::tests::animated_scene());
        assert!(matches!(take(&mut original, &pin), EngineReply::Taken(_)));
        ticks.store(1, Ordering::Relaxed);
        assert!(!original.emit_frame_settled().unwrap().frame.is_black());
    }
    let (mut engine, ticks) = hardware_engine();
    let before = RenderWork::snapshot();
    engine
        .attach_recovery_journal(RecoveryJournal::open_at(path.clone()).unwrap())
        .unwrap();
    let prepare = RenderWork::snapshot().since(before);
    assert_eq!(prepare.cpu_full_frame_rasterizations, 0);
    assert!(prepare.gpu_resource_builds > 0);
    assert!(engine.output_inhibited());
    assert!(engine.emit_frame_settled().unwrap().frame.is_black());
    assert!(matches!(
        engine.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "virtual".into(),
            live: false,
            accept_free_run: false,
        })),
        EngineReply::OutputConfigured { .. }
    ));
    ticks.store(2, Ordering::Relaxed);
    assert!(!engine.emit_frame_settled().unwrap().frame.is_black());
    let trace = engine.program_frame_trace().unwrap().clone();
    assert_eq!(trace.backend, "gpu-compositor");
    assert_eq!(trace.work.gpu_resource_builds, 0);
    assert_eq!(trace.work.cpu_full_frame_rasterizations, 0);
    engine.gpu = Gpu::without_hardware(DeviceTier::T2);
    let before = RenderWork::snapshot();
    assert!(matches!(
        engine.emit_frame_settled(),
        Err(OutputAdapterError::Render {
            cause: Refusal::TierTooLow {
                actual: DeviceTier::T2
            }
        })
    ));
    assert_eq!(
        RenderWork::snapshot().since(before),
        RenderWork::default(),
        "lost hardware must not invoke a CPU fallback"
    );
    evidence(
        "recovery.json",
        &json!({"prepareWork": prepare, "resumedFrame": trace, "hardwareLossRefused": "tierTooLow(T2)", "cpuFallback": false}),
    );
    let _ = std::fs::remove_file(path);
}

/// 3.17's fixture: every stroke join and cap, a dash pattern with an offset,
/// both fill rules, a rounded rectangle, an ellipse and a polyline, each at a
/// whole-pixel placement with no rotation or scale. That is where the GPU's
/// object-local source and the CPU's direct drawing are the same geometry, as
/// in 3.16's gate; a transformed layer is resampled by the compositor (3.16),
/// which this row does not change. Shapes start at x = 20 + 100 * i.
fn vector_fixture() -> SceneDocument {
    use gx_contracts::scene::{
        BezierPath, EllipseObject, FillRule, LineObject, ShapeObject, StrokeCap, StrokeJoin,
        StrokeStyle, Vec2,
    };
    let v = |x: f64, y: f64| Vec2 { x, y };
    let colour = |r: f64, g: f64, b: f64, a: f64| ColorValue::Solid {
        color: Rgba::srgb(r, g, b, a),
    };
    let mut doc = lower_third();
    doc.objects.clear();
    doc.assets.clear();
    doc.fonts.clear();
    doc.timeline.channels.clear();
    let zigzag = |id: &str, x: f64, y: f64, join, cap, dash: Vec<f64>| {
        let mut base = ObjectBase::new(id, id);
        base.x = x;
        base.y = y;
        base.stroke = Some(colour(0.95, 0.85, 0.2, 0.8));
        base.stroke_width = 9.0;
        base.stroke_style = Some(StrokeStyle {
            join,
            cap,
            miter_limit: 4.0,
            dash,
            dash_offset: 3.0,
        });
        SceneObject::Shape(ShapeObject {
            base,
            path: BezierPath {
                closed: false,
                vertices: vec![v(0.0, 0.0), v(70.0, 10.0), v(10.0, 50.0), v(80.0, 70.0)],
                in_tangents: vec![v(0.0, 0.0); 4],
                out_tangents: vec![v(0.0, 0.0); 4],
            },
            compound_paths: None,
            fill_enabled: false,
            stroke_enabled: true,
            fill_rule: FillRule::Nonzero,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
        })
    };
    let joins = [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel];
    let caps = [StrokeCap::Butt, StrokeCap::Round, StrokeCap::Square];
    for i in 0..3 {
        doc.objects.push(zigzag(
            &format!("zigzag-{i}"),
            20.0 + 100.0 * i as f64,
            20.0,
            joins[i],
            caps[i],
            Vec::new(),
        ));
    }
    doc.objects.push(zigzag(
        "dashed",
        320.0,
        20.0,
        StrokeJoin::Round,
        StrokeCap::Round,
        vec![12.0, 7.0, 3.0],
    ));
    // A star with crossing edges: even-odd leaves its centre open.
    let star: Vec<Vec2> = (0..5)
        .map(|k| {
            let a = std::f64::consts::PI * (0.5 + 0.8 * k as f64);
            v(40.0 + 38.0 * a.cos(), 40.0 + 38.0 * a.sin())
        })
        .collect();
    for (i, rule) in [FillRule::Evenodd, FillRule::Nonzero]
        .into_iter()
        .enumerate()
    {
        let id = format!("star-{i}");
        let mut base = ObjectBase::new(&id, &id);
        base.x = 20.0 + 100.0 * i as f64;
        base.y = 120.0;
        base.fill = Some(colour(0.2, 0.6, 0.95, 1.0));
        SceneObject::Shape(ShapeObject {
            base,
            path: BezierPath {
                closed: true,
                vertices: star.clone(),
                in_tangents: vec![v(0.0, 0.0); 5],
                out_tangents: vec![v(0.0, 0.0); 5],
            },
            compound_paths: None,
            fill_enabled: true,
            stroke_enabled: false,
            fill_rule: rule,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
        })
        .pipe(|o| doc.objects.push(o));
    }
    let mut base = ObjectBase::new("card", "card");
    base.x = 230.0;
    base.y = 125.0;
    base.width = 80.0;
    base.height = 50.0;
    base.fill = Some(colour(0.8, 0.2, 0.3, 0.9));
    base.stroke = Some(colour(1.0, 1.0, 1.0, 1.0));
    base.stroke_width = 3.0;
    doc.objects
        .push(SceneObject::Rect(RectObject { base, radius: 12.0 }));
    let mut base = ObjectBase::new("disc", "disc");
    base.x = 340.0;
    base.y = 120.0;
    base.width = 70.0;
    base.height = 44.0;
    base.fill = Some(colour(0.3, 0.9, 0.4, 0.6));
    doc.objects
        .push(SceneObject::Ellipse(EllipseObject { base }));
    let mut base = ObjectBase::new("polyline", "polyline");
    base.x = 430.0;
    base.y = 30.0;
    base.stroke = Some(colour(0.9, 0.4, 0.9, 1.0));
    base.stroke_width = 2.5;
    doc.objects.push(SceneObject::Line(LineObject {
        base,
        points: vec![v(0.0, 0.0), v(40.0, 60.0), v(80.0, 5.0), v(120.0, 90.0)],
    }));
    // Gradients (3.17), object space: a repeating linear fill with a hard
    // stop, a reflected radial fill, and a linear stroke.
    use gx_contracts::color::{GradientSpread, GradientStop};
    let stops = vec![
        GradientStop {
            position: 0.0,
            color: Rgba::srgb(1.0, 0.2, 0.1, 1.0),
        },
        GradientStop {
            position: 0.5,
            color: Rgba::srgb(0.1, 0.3, 1.0, 0.6),
        },
        GradientStop {
            position: 0.5,
            color: Rgba::srgb(0.9, 0.9, 0.2, 1.0),
        },
        GradientStop {
            position: 1.0,
            color: Rgba::srgb(0.0, 0.0, 0.0, 0.0),
        },
    ];
    let linear = |spread| ColorValue::LinearGradient {
        angle: 0.0,
        start_x: 0.1,
        start_y: 0.0,
        end_x: 0.6,
        end_y: 0.3,
        stops: stops.clone(),
        spread,
        coordinate_mode: Default::default(),
    };
    let mut base = ObjectBase::new("linear", "linear");
    base.x = 20.0;
    base.y = 230.0;
    base.width = 150.0;
    base.height = 80.0;
    base.fill = Some(linear(GradientSpread::Repeat));
    doc.objects
        .push(SceneObject::Rect(RectObject { base, radius: 6.0 }));
    let mut base = ObjectBase::new("radial", "radial");
    base.x = 200.0;
    base.y = 230.0;
    base.width = 140.0;
    base.height = 90.0;
    base.fill = Some(ColorValue::RadialGradient {
        center_x: 0.5,
        center_y: 0.5,
        radius_x: 0.3,
        radius_y: 0.25,
        focal_x: None,
        focal_y: None,
        stops: stops.clone(),
        spread: GradientSpread::Reflect,
        coordinate_mode: Default::default(),
    });
    doc.objects
        .push(SceneObject::Ellipse(EllipseObject { base }));
    let mut base = ObjectBase::new("ringed", "ringed");
    base.x = 370.0;
    base.y = 235.0;
    base.width = 110.0;
    base.height = 70.0;
    base.stroke = Some(linear(GradientSpread::Pad));
    base.stroke_width = 8.0;
    doc.objects
        .push(SceneObject::Rect(RectObject { base, radius: 20.0 }));
    doc
}

trait Pipe: Sized {
    fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R {
        f(self)
    }
}
impl<T> Pipe for T {}

#[test]
#[ignore = "requires hardware GPU; explicit 3.17 drawing gate"]
fn gpu_engine_draws_vector_content_within_one_code_of_the_vello_cpu_reference() {
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (mut engine, ticks) = hardware_engine();
        let mut doc = vector_fixture();
        doc.working_color_space = space;
        let before = RenderWork::snapshot();
        let pin = publish(&mut engine, doc);
        let prepare = RenderWork::snapshot().since(before);
        assert_eq!(
            prepare.cpu_source_rasterizations, 0,
            "every vector source is drawn on the GPU"
        );
        let sources = engine.gpu_source_trace(&pin.0, pin.1).unwrap().to_vec();
        assert_eq!(sources.len(), 12);
        assert!(sources
            .iter()
            .all(|s| s.route == "gpu-vello-coverage-at-prepare"));
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        ticks.store(1, Ordering::Relaxed);
        let program = engine.emit_frame_settled().unwrap().frame;
        let preview = engine.take_preview().unwrap();
        let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
        for (frame, output, name) in [
            (&*program, OutputTransform::Rec709, "Program"),
            (&*preview, OutputTransform::Srgb, "Preview"),
        ] {
            let reference = cpu.frame_at(0, output).unwrap();
            assert_within_one_code(frame, &reference, &format!("{space:?} {name}"));
        }
        let alpha = |x: u32, y: u32| preview.pixels[((y * preview.width + x) * 4 + 3) as usize];
        // Anti-aliased: edges carry partial coverage.
        let partial = preview
            .pixels
            .chunks_exact(4)
            .filter(|p| p[3] > 0 && p[3] < 255)
            .count();
        assert!(
            partial > 200,
            "{space:?}: only {partial} partial-coverage pixels"
        );
        // Even-odd leaves the star's centre open; non-zero fills it.
        assert_eq!(alpha(60, 160), 0, "{space:?}: even-odd star centre");
        assert_eq!(alpha(160, 160), 255, "{space:?}: non-zero star centre");
    }
}

/// 3.17's image fixture: one PNG, tagged sRGB on its asset record, drawn by
/// eight image objects, one per fit mode, at whole-pixel placements.
fn image_fixture() -> (SceneDocument, Vec<u8>) {
    use gx_contracts::color::SourceColorSpace;
    use gx_contracts::material::FitMode;
    use gx_contracts::scene::{AssetKind, AssetLibraryItem, ImageObject, ImageSlice};
    // 12 x 8 texels: a hue ramp with a soft alpha border.
    let (iw, ih) = (12_u32, 8_u32);
    let mut rgba = Vec::new();
    for y in 0..ih {
        for x in 0..iw {
            let edge = x == 0 || y == 0 || x == iw - 1 || y == ih - 1;
            rgba.extend_from_slice(&[
                (x * 21) as u8,
                (y * 31) as u8,
                (255 - x * 20) as u8,
                if edge { 140 } else { 255 },
            ]);
        }
    }
    let bytes = crate::image::tests::png_bytes(iw, ih, &rgba, true);
    let mut doc = lower_third();
    doc.objects.clear();
    doc.fonts.clear();
    doc.timeline.channels.clear();
    doc.assets = vec![AssetLibraryItem {
        asset_id: "asset_images_ramp".into(),
        name: "ramp".into(),
        kind: AssetKind::Image,
        path: "images/ramp.png".into(),
        checksum: Some(gx_asset_plane::content_hash(&bytes)),
        mime_type: Some("image/png".into()),
        size_bytes: Some(bytes.len() as u64),
        status: None,
        provenance: Default::default(),
        color_space: Some(SourceColorSpace::Srgb),
    }];
    let fits = [
        FitMode::Stretch,
        FitMode::Contain,
        FitMode::Cover,
        FitMode::Crop,
        FitMode::Tile,
        FitMode::Original,
        FitMode::PixelPerfect,
        FitMode::NineSlice,
    ];
    for (k, fit) in fits.into_iter().enumerate() {
        let id = format!("image-{k}");
        let mut base = ObjectBase::new(&id, &id);
        base.x = 20.0 + 110.0 * (k % 4) as f64;
        base.y = 20.0 + 140.0 * (k / 4) as f64;
        base.width = 90.0;
        base.height = 55.0;
        base.opacity = 0.9;
        doc.objects.push(SceneObject::Image(ImageObject {
            base,
            asset_id: "asset_images_ramp".into(),
            fit,
            slice: Some(ImageSlice {
                left: 3.0,
                top: 2.0,
                right: 3.0,
                bottom: 2.0,
            }),
        }));
    }
    (doc, bytes)
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.17 drawing gate"]
fn gpu_engine_draws_image_quads_in_every_fit_mode_within_one_code_of_the_cpu_reference() {
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (mut engine, ticks) = hardware_engine();
        let (mut doc, bytes) = image_fixture();
        doc.working_color_space = space;
        engine.record_verified_asset_bytes(gx_asset_plane::content_hash(&bytes), bytes);
        let before = RenderWork::snapshot();
        let pin = match engine.publish(doc) {
            PublishReply::Published {
                take_id,
                revision,
                content_hash,
            } => (take_id, revision, content_hash),
            other => panic!("the image scene must publish: {other:?}"),
        };
        let prepare = RenderWork::snapshot().since(before);
        // Publication also prepares the CPU reference, which builds each
        // image's layer on the CPU; the GPU sources take the GPU route (the
        // trace below), so these eight are the reference's alone.
        assert_eq!(prepare.cpu_source_rasterizations, 8);
        let sources = engine.gpu_source_trace(&pin.0, pin.1).unwrap().to_vec();
        assert_eq!(sources.len(), 8);
        assert!(sources
            .iter()
            .all(|s| s.route == "gpu-image-fit-at-prepare"));
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        ticks.store(1, Ordering::Relaxed);
        let program = engine.emit_frame_settled().unwrap().frame;
        let preview = engine.take_preview().unwrap();
        let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
        for (frame, output, name) in [
            (&*program, OutputTransform::Rec709, "Program"),
            (&*preview, OutputTransform::Srgb, "Preview"),
        ] {
            let reference = cpu.frame_at(0, output).unwrap();
            assert_within_one_code(frame, &reference, &format!("{space:?} {name}"));
        }
        // Every image object put pixels down.
        for k in 0..8 {
            let (x, y) = (20 + 110 * (k % 4) + 45, 20 + 140 * (k / 4) + 27);
            let alpha = preview.pixels[((y * preview.width + x) * 4 + 3) as usize];
            assert!(alpha > 100, "{space:?}: image {k} centre alpha {alpha}");
        }
    }
}

/// 3.18's text fixture: Latin, Telugu, Hindi and mixed-bidi lines, shaped
/// from packaged faces only, plus a gradient fill and a stroked line.
fn text_fixture() -> (SceneDocument, Vec<(gx_contracts::ContentHash, Vec<u8>)>) {
    use gx_contracts::color::{GradientStop, Rgba};
    use gx_contracts::scene::{AssetKind, AssetLibraryItem, TextLayout, TextObject};
    const TELUGU: &[u8] = include_bytes!("../../tests/fixtures/NotoSansTelugu-Regular.ttf");
    const DEVANAGARI: &[u8] = include_bytes!("../../tests/fixtures/NotoSansDevanagari-Regular.ttf");
    const HEBREW: &[u8] = include_bytes!("../../tests/fixtures/NotoSansHebrew.ttf");
    const NASTALIQ: &[u8] = include_bytes!("../../tests/fixtures/NotoNastaliqUrdu-Regular.ttf");
    const NASKH: &[u8] = include_bytes!("../../tests/fixtures/NotoSansArabic-Regular.ttf");
    // Two Inter definitions over the same file: one falls back to Nastaliq
    // for Urdu, the other to Naskh.
    let faces: [(&str, &str, &str, &[u8]); 7] = [
        ("inter", "inter", "Inter", INTER),
        ("inter-naskh", "inter", "Inter Naskh", INTER),
        ("telugu", "telugu", "Noto Sans Telugu", TELUGU),
        (
            "devanagari",
            "devanagari",
            "Noto Sans Devanagari",
            DEVANAGARI,
        ),
        ("hebrew", "hebrew", "Noto Sans Hebrew", HEBREW),
        ("nastaliq", "nastaliq", "Noto Nastaliq Urdu", NASTALIQ),
        ("naskh", "naskh", "Noto Sans Arabic", NASKH),
    ];
    let mut doc = lower_third();
    doc.objects.clear();
    doc.timeline.channels.clear();
    doc.assets.clear();
    doc.fonts.clear();
    let mut bytes = Vec::new();
    for (id, asset, family, data) in faces {
        let hash = gx_asset_plane::content_hash(data);
        if doc
            .assets
            .iter()
            .any(|a| a.asset_id == format!("asset_font_{asset}"))
        {
            doc.fonts
                .push(font_definition(id, asset, family, Vec::new()));
            continue;
        }
        doc.assets.push(AssetLibraryItem {
            asset_id: format!("asset_font_{asset}"),
            name: family.into(),
            kind: AssetKind::Font,
            path: format!("fonts/{asset}.ttf"),
            checksum: Some(hash.clone()),
            mime_type: Some("font/ttf".into()),
            size_bytes: Some(data.len() as u64),
            status: None,
            provenance: Default::default(),
            color_space: None,
        });
        bytes.push((hash, data.to_vec()));
        doc.fonts
            .push(font_definition(id, asset, family, Vec::new()));
    }
    for font in &mut doc.fonts {
        font.fallback_families = match font.font_id.as_str() {
            "inter" => vec![
                "Noto Sans Telugu".into(),
                "Noto Sans Devanagari".into(),
                "Noto Sans Hebrew".into(),
                "Noto Nastaliq Urdu".into(),
            ],
            "inter-naskh" => vec!["Noto Sans Arabic".into()],
            _ => Vec::new(),
        };
    }
    let line = |id: &str, value: &str, y: f64| {
        let mut base = ObjectBase::new(id, id);
        base.x = 40.0;
        base.y = y;
        base.width = 900.0;
        base.height = 70.0;
        base.fill = Some(ColorValue::Solid {
            color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
        });
        TextObject {
            base,
            text: value.into(),
            font_id: "inter".into(),
            size: 44.0,
            layout: TextLayout::Paragraph,
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: Default::default(),
            text_case: Default::default(),
            decoration: Default::default(),
            overflow: Default::default(),
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
        }
    };
    doc.objects.push(SceneObject::Text(line(
        "latin",
        "GrapiX lower third, office",
        20.0,
    )));
    doc.objects.push(SceneObject::Text(line(
        "telugu",
        "తెలుగు వార్తలు క్షేత్రం",
        100.0,
    )));
    doc.objects.push(SceneObject::Text(line(
        "hindi",
        "हिन्दी समाचार क्षत्रिय",
        180.0,
    )));
    doc.objects.push(SceneObject::Text(line(
        "bidi",
        "Score 3 - 2 שלום עולם",
        260.0,
    )));
    let mut gradient = line("gradient", "Gradient title", 340.0);
    gradient.base.fill = Some(ColorValue::LinearGradient {
        angle: 0.0,
        start_x: 0.0,
        start_y: 0.0,
        end_x: 0.4,
        end_y: 0.0,
        stops: vec![
            GradientStop {
                position: 0.0,
                color: Rgba::srgb(1.0, 0.8, 0.1, 1.0),
            },
            GradientStop {
                position: 1.0,
                color: Rgba::srgb(0.1, 0.4, 1.0, 1.0),
            },
        ],
        spread: Default::default(),
        coordinate_mode: Default::default(),
    });
    doc.objects.push(SceneObject::Text(gradient));
    let mut stroked = line("stroked", "Stroked", 420.0);
    stroked.base.stroke = Some(ColorValue::Solid {
        color: Rgba::srgb(0.9, 0.1, 0.2, 1.0),
    });
    stroked.base.stroke_width = 2.0;
    doc.objects.push(SceneObject::Text(stroked));
    // Urdu, right to left: Nastaliq, the same words in Naskh, and a line
    // mixing Urdu with English and numerals.
    doc.objects.push(SceneObject::Text(line(
        "urdu-nastaliq",
        "اردو خبریں تازہ ترین",
        500.0,
    )));
    let mut naskh = line("urdu-naskh", "اردو خبریں تازہ ترین", 600.0);
    naskh.font_id = "inter-naskh".into();
    doc.objects.push(SceneObject::Text(naskh));
    doc.objects.push(SceneObject::Text(line(
        "urdu-mixed",
        "میچ اسکور 3 - 2 Live",
        700.0,
    )));
    (doc, bytes)
}

fn font_definition(
    id: &str,
    asset: &str,
    family: &str,
    fallbacks: Vec<String>,
) -> gx_contracts::font::FontDefinition {
    use gx_contracts::font::{
        EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus,
        FontSource, FontStyle,
    };
    FontDefinition {
        font_id: id.into(),
        family: family.into(),
        display_name: family.into(),
        faces: vec![FontFaceDefinition {
            face_id: format!("{id}-regular"),
            family: family.into(),
            weight: 400,
            style: FontStyle::Normal,
            stretch: None,
            unicode_range: None,
            source: FontSource::File {
                asset_id: format!("asset_font_{asset}"),
                format: FontFormat::Ttf,
                original_url: None,
                stylesheet_url: None,
            },
            status: Some(FontLoadStatus::Ready),
            error_message: None,
        }],
        fallback_families: fallbacks,
        embedding_policy: EmbeddingPolicy::Package,
        license: Some("OFL-1.1".into()),
        enabled: true,
        source_label: None,
        status: FontLoadStatus::Ready,
        error_message: None,
    }
}

/// The share of pixels with any channel off by more than zero, and the worst
/// delta: what strict 4.4 reads (at most one code value, on at most 0.1%).
fn strict_44(actual: &Frame, expected: &Frame) -> (f64, u8) {
    let mut differing = 0usize;
    let mut worst = 0u8;
    for (a, b) in actual
        .pixels
        .chunks_exact(4)
        .zip(expected.pixels.chunks_exact(4))
    {
        if a[3] == 0 && b[3] == 0 {
            continue;
        }
        let d = a
            .iter()
            .zip(b)
            .map(|(x, y)| x.abs_diff(*y))
            .max()
            .unwrap_or(0);
        worst = worst.max(d);
        differing += usize::from(d > 0);
    }
    (differing as f64 / (actual.pixels.len() / 4) as f64, worst)
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.18 text gate"]
fn gpu_engine_draws_text_in_five_scripts_within_one_code_of_the_cpu_reference() {
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (mut engine, ticks) = hardware_engine();
        let (mut doc, bytes) = text_fixture();
        doc.working_color_space = space;
        for (hash, data) in bytes {
            engine.record_verified_asset_bytes(hash, data);
        }
        let before = RenderWork::snapshot();
        let pin = match engine.publish(doc) {
            PublishReply::Published {
                take_id,
                revision,
                content_hash,
            } => (take_id, revision, content_hash),
            other => panic!("the text scene must publish: {other:?}"),
        };
        let prepare = RenderWork::snapshot().since(before);
        assert_eq!(
            prepare.cpu_source_rasterizations, 0,
            "every text source is drawn on the GPU"
        );
        let sources = engine.gpu_source_trace(&pin.0, pin.1).unwrap().to_vec();
        assert_eq!(sources.len(), 9);
        assert!(sources
            .iter()
            .all(|s| s.route == "gpu-vello-coverage-at-prepare"));
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        ticks.store(1, Ordering::Relaxed);
        let program = engine.emit_frame_settled().unwrap().frame;
        let preview = engine.take_preview().unwrap();
        let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
        let mut strict = Vec::new();
        for (frame, output, name) in [
            (&*program, OutputTransform::Rec709, "Program"),
            (&*preview, OutputTransform::Srgb, "Preview"),
        ] {
            let reference = cpu.frame_at(0, output).unwrap();
            assert_within_one_code(frame, &reference, &format!("{space:?} {name}"));
            strict.push((name, strict_44(frame, &reference)));
        }
        // Each line put glyph pixels down, anti-aliased.
        for (k, y) in [20, 100, 180, 260, 340, 420, 500, 600, 700]
            .into_iter()
            .enumerate()
        {
            let row = |dy: u32| (y + dy) as usize * preview.width as usize;
            let lit = (10..60)
                .flat_map(|dy| (40..900).map(move |x| row(dy) + x))
                .filter(|&i| preview.pixels[i * 4 + 3] > 0)
                .count();
            assert!(lit > 500, "{space:?}: line {k} drew {lit} pixels");
        }
        println!(
            "3.18 {space:?}: strict 4.4 reading (differing share, worst): {:?}",
            strict
        );
        evidence(
            &format!("text-{}.json", space.as_str()),
            &json!({"strict44": strict.iter().map(|(n, (share, worst))| json!({"output": n, "differingShare": share, "worst": worst})).collect::<Vec<_>>(),
                    "sources": sources, "adapter": engine.gpu_description()}),
        );
    }
}

/// 3.19's mask fixture: an image, a rect, a shape and a text line, each under
/// masks in its own coordinates (every mode, feather, both expansions,
/// inversion, opacity).
fn mask_fixture() -> (SceneDocument, Vec<(gx_contracts::ContentHash, Vec<u8>)>) {
    use gx_contracts::material::FitMode;
    use gx_contracts::scene::{
        AssetKind, AssetLibraryItem, BezierPath, FillRule, Mask, MaskMode, ShapeObject, TextLayout,
        TextObject, Vec2,
    };
    let v = |x: f64, y: f64| Vec2 { x, y };
    let rect_path = |x0: f64, y0: f64, x1: f64, y1: f64| BezierPath {
        closed: true,
        vertices: vec![v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)],
        in_tangents: vec![v(0.0, 0.0); 4],
        out_tangents: vec![v(0.0, 0.0); 4],
    };
    let ellipse_path = |cx: f64, cy: f64, rx: f64, ry: f64| {
        const K: f64 = 0.552_284_75;
        BezierPath {
            closed: true,
            vertices: vec![
                v(cx + rx, cy),
                v(cx, cy + ry),
                v(cx - rx, cy),
                v(cx, cy - ry),
            ],
            in_tangents: vec![
                v(0.0, -K * ry),
                v(K * rx, 0.0),
                v(0.0, K * ry),
                v(-K * rx, 0.0),
            ],
            out_tangents: vec![
                v(0.0, K * ry),
                v(-K * rx, 0.0),
                v(0.0, -K * ry),
                v(K * rx, 0.0),
            ],
        }
    };
    let mask = |path, mode, feather, expansion, opacity, inverted| Mask {
        path,
        mode,
        feather,
        expansion,
        opacity,
        inverted,
    };
    let solid = |r: f64, g: f64, b: f64, a: f64| ColorValue::Solid {
        color: Rgba::srgb(r, g, b, a),
    };
    let (mut doc, png) = image_fixture();
    doc.objects.truncate(1);
    let SceneObject::Image(image) = &mut doc.objects[0] else {
        unreachable!()
    };
    image.fit = FitMode::Stretch;
    image.base.x = 600.0;
    image.base.y = 40.0;
    image.base.width = 160.0;
    image.base.height = 120.0;
    image.base.opacity = 1.0;
    image.base.masks = Some(vec![mask(
        ellipse_path(80.0, 60.0, 70.0, 50.0),
        MaskMode::Add,
        6.0,
        0.0,
        0.9,
        false,
    )]);
    let inter = gx_asset_plane::content_hash(INTER);
    doc.assets.push(AssetLibraryItem {
        asset_id: "asset_font_inter".into(),
        name: "Inter".into(),
        kind: AssetKind::Font,
        path: "fonts/inter.ttf".into(),
        checksum: Some(inter.clone()),
        mime_type: Some("font/ttf".into()),
        size_bytes: Some(INTER.len() as u64),
        status: None,
        provenance: Default::default(),
        color_space: None,
    });
    doc.fonts = vec![font_definition("inter", "inter", "Inter", Vec::new())];
    // The rect: a feathered ellipse added, then a shrunk rect subtracted.
    let mut base = ObjectBase::new("card", "card");
    base.x = 40.0;
    base.y = 40.0;
    base.width = 240.0;
    base.height = 120.0;
    base.fill = Some(solid(0.95, 0.5, 0.1, 1.0));
    base.masks = Some(vec![
        mask(
            ellipse_path(120.0, 60.0, 100.0, 50.0),
            MaskMode::Add,
            10.0,
            0.0,
            1.0,
            false,
        ),
        mask(
            rect_path(150.0, 0.0, 240.0, 120.0),
            MaskMode::Subtract,
            0.0,
            -6.0,
            1.0,
            false,
        ),
    ]);
    doc.objects
        .push(SceneObject::Rect(RectObject { base, radius: 10.0 }));
    // The shape: an inverted rect intersected (a hole), then an ellipse at
    // 70% differenced back into the hole.
    let mut base = ObjectBase::new("plate", "plate");
    base.x = 320.0;
    base.y = 40.0;
    base.fill = Some(solid(0.1, 0.5, 0.95, 1.0));
    base.masks = Some(vec![
        mask(
            rect_path(20.0, 20.0, 140.0, 100.0),
            MaskMode::Intersect,
            0.0,
            0.0,
            1.0,
            true,
        ),
        mask(
            ellipse_path(80.0, 60.0, 40.0, 30.0),
            MaskMode::Difference,
            0.0,
            0.0,
            0.7,
            false,
        ),
    ]);
    doc.objects.push(SceneObject::Shape(ShapeObject {
        base,
        path: rect_path(0.0, 0.0, 160.0, 120.0),
        compound_paths: None,
        fill_enabled: true,
        stroke_enabled: false,
        fill_rule: FillRule::Nonzero,
        trim_start: None,
        trim_end: None,
        trim_offset: None,
    }));
    // The text: only its first 200 pixels show, grown by 3 and feathered.
    let mut base = ObjectBase::new("caption", "caption");
    base.x = 40.0;
    base.y = 200.0;
    base.width = 900.0;
    base.height = 70.0;
    base.fill = Some(solid(1.0, 1.0, 1.0, 1.0));
    base.masks = Some(vec![mask(
        rect_path(0.0, 0.0, 200.0, 70.0),
        MaskMode::Add,
        4.0,
        3.0,
        1.0,
        false,
    )]);
    doc.objects.push(SceneObject::Text(TextObject {
        base,
        text: "Masked caption, office hours".into(),
        font_id: "inter".into(),
        size: 44.0,
        layout: TextLayout::Paragraph,
        auto_fit: Default::default(),
        writing_mode: Default::default(),
        vertical_align: Default::default(),
        direction: Default::default(),
        text_case: Default::default(),
        decoration: Default::default(),
        overflow: Default::default(),
        align: Default::default(),
        line_height: None,
        letter_spacing: 0.0,
        word_spacing: 0.0,
        paragraph_spacing: 0.0,
        text_indent: 0.0,
    }));
    let png_hash = gx_asset_plane::content_hash(&png);
    (doc, vec![(png_hash, png), (inter, INTER.to_vec())])
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.19 mask gate"]
fn gpu_engine_draws_masked_layers_within_one_code_of_the_cpu_reference() {
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (mut engine, ticks) = hardware_engine();
        let (mut doc, bytes) = mask_fixture();
        doc.working_color_space = space;
        for (hash, data) in bytes {
            engine.record_verified_asset_bytes(hash, data);
        }
        let before = RenderWork::snapshot();
        let pin = match engine.publish(doc) {
            PublishReply::Published {
                take_id,
                revision,
                content_hash,
            } => (take_id, revision, content_hash),
            other => panic!("the masked scene must publish: {other:?}"),
        };
        let prepare = RenderWork::snapshot().since(before);
        // A masked object is drawn in its own layer space; the CPU reference
        // builds those four layers on the CPU, the GPU sources take the GPU
        // routes below.
        assert_eq!(prepare.cpu_source_rasterizations, 4);
        let sources = engine.gpu_source_trace(&pin.0, pin.1).unwrap().to_vec();
        let routes: Vec<_> = sources.iter().map(|s| s.route).collect();
        assert_eq!(
            routes,
            [
                "gpu-image-fit-at-prepare",
                "gpu-vello-coverage-at-prepare",
                "gpu-vello-coverage-at-prepare",
                "gpu-vello-coverage-at-prepare"
            ]
        );
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        ticks.store(1, Ordering::Relaxed);
        let program = engine.emit_frame_settled().unwrap().frame;
        let preview = engine.take_preview().unwrap();
        let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
        let mut strict = Vec::new();
        for (frame, output, name) in [
            (&*program, OutputTransform::Rec709, "Program"),
            (&*preview, OutputTransform::Srgb, "Preview"),
        ] {
            let reference = cpu.frame_at(0, output).unwrap();
            assert_within_one_code(frame, &reference, &format!("{space:?} {name}"));
            strict.push((name, strict_44(frame, &reference)));
        }
        // The masks landed where their object coordinates put them.
        let alpha = |x: u32, y: u32| preview.pixels[((y * preview.width + x) * 4 + 3) as usize];
        assert_eq!(alpha(160, 100), 255, "{space:?}: rect, inside the ellipse");
        assert_eq!(alpha(240, 100), 0, "{space:?}: rect, subtracted");
        assert_eq!(alpha(45, 45), 0, "{space:?}: rect, outside the ellipse");
        assert_eq!(alpha(325, 45), 255, "{space:?}: shape, outside the hole");
        assert_eq!(alpha(350, 100), 0, "{space:?}: shape, in the hole");
        assert!(
            (176..=180).contains(&alpha(400, 100)),
            "{space:?}: shape, the 70% ellipse differenced back: {}",
            alpha(400, 100)
        );
        assert!(alpha(680, 100) > 200, "{space:?}: image centre");
        assert_eq!(alpha(605, 45), 0, "{space:?}: image corner, masked off");
        let lit = |x0: u32, x1: u32| {
            (200..270)
                .flat_map(|y| (x0..x1).map(move |x| (x, y)))
                .filter(|&(x, y)| alpha(x, y) > 0)
                .count()
        };
        assert!(
            lit(40, 230) > 300,
            "{space:?}: the caption's first 200 pixels show"
        );
        assert_eq!(
            lit(260, 940),
            0,
            "{space:?}: the rest of the caption is masked off"
        );
        println!("3.19 {space:?}: strict 4.4 reading (differing share, worst): {strict:?}");
        evidence(
            &format!("masks-{}.json", space.as_str()),
            &json!({"strict44": strict.iter().map(|(n, (share, worst))| json!({"output": n, "differingShare": share, "worst": worst})).collect::<Vec<_>>(),
                    "sources": sources, "adapter": engine.gpu_description()}),
        );
    }
}

/// 3.19's clip-group fixture: a half-opaque group clipped by a hidden,
/// moving ellipse at 80% (its own opacity), holding a plain fill, a Multiply
/// rect and a nested clip group whose masked fill is clipped by a square; a
/// second group clipped by a visible rect; and an unclipped rect.
fn clip_fixture() -> SceneDocument {
    use gx_contracts::animation::{KeyframeChannel, SceneKeyframe};
    use gx_contracts::material::BlendMode;
    use gx_contracts::scene::{BezierPath, EllipseObject, GroupObject, Mask, MaskMode, Vec2};
    let solid = |r: f64, g: f64, b: f64| ColorValue::Solid {
        color: Rgba::srgb(r, g, b, 1.0),
    };
    let rect = |id: &str, x: f64, y: f64, w: f64, h: f64, fill: ColorValue| {
        let mut base = ObjectBase::new(id, id);
        base.x = x;
        base.y = y;
        base.width = w;
        base.height = h;
        base.fill = Some(fill);
        SceneObject::Rect(RectObject { base, radius: 0.0 })
    };
    let group = |id: &str, children: &[&str], clip: &str| {
        SceneObject::Group(GroupObject {
            base: ObjectBase::new(id, id),
            child_ids: children.iter().map(|c| (*c).into()).collect(),
            clip_child_id: Some(clip.into()),
        })
    };
    let mut doc = lower_third();
    doc.objects.clear();
    doc.assets.clear();
    doc.fonts.clear();
    doc.timeline.channels.clear();
    let mut card = group(
        "card",
        &["card-clip", "card-fill", "card-multiply", "inner"],
        "card-clip",
    );
    card.base_mut().opacity = 0.5;
    doc.objects.push(card);
    let mut base = ObjectBase::new("card-clip", "card-clip");
    base.x = 100.0;
    base.y = 100.0;
    base.width = 400.0;
    base.height = 200.0;
    base.opacity = 0.8;
    base.visible = false;
    base.fill = Some(solid(1.0, 1.0, 1.0));
    doc.objects
        .push(SceneObject::Ellipse(EllipseObject { base }));
    doc.objects.push(rect(
        "card-fill",
        50.0,
        80.0,
        520.0,
        240.0,
        solid(0.95, 0.5, 0.1),
    ));
    let mut multiply = rect(
        "card-multiply",
        300.0,
        150.0,
        300.0,
        100.0,
        solid(0.2, 0.4, 0.9),
    );
    multiply.base_mut().blend_mode = Some(BlendMode::Multiply);
    doc.objects.push(multiply);
    doc.objects
        .push(group("inner", &["inner-clip", "inner-fill"], "inner-clip"));
    doc.objects.push(rect(
        "inner-clip",
        120.0,
        120.0,
        100.0,
        100.0,
        solid(1.0, 1.0, 1.0),
    ));
    let mut inner_fill = rect("inner-fill", 0.0, 0.0, 700.0, 400.0, solid(0.1, 0.8, 0.3));
    let v = |x: f64, y: f64| Vec2 { x, y };
    inner_fill.base_mut().masks = Some(vec![Mask {
        path: BezierPath {
            closed: true,
            vertices: vec![v(0.0, 0.0), v(170.0, 0.0), v(170.0, 400.0), v(0.0, 400.0)],
            in_tangents: vec![v(0.0, 0.0); 4],
            out_tangents: vec![v(0.0, 0.0); 4],
        },
        mode: MaskMode::Add,
        feather: 0.0,
        expansion: 0.0,
        opacity: 1.0,
        inverted: false,
    }]);
    doc.objects.push(inner_fill);
    doc.objects
        .push(group("badge", &["badge-clip", "badge-fill"], "badge-clip"));
    doc.objects.push(rect(
        "badge-clip",
        900.0,
        100.0,
        100.0,
        100.0,
        solid(0.9, 0.1, 0.1),
    ));
    doc.objects.push(rect(
        "badge-fill",
        950.0,
        150.0,
        150.0,
        100.0,
        solid(0.1, 0.2, 0.9),
    ));
    doc.objects.push(rect(
        "outside",
        700.0,
        100.0,
        100.0,
        100.0,
        solid(0.9, 0.9, 0.9),
    ));
    // The clip moves 60 px right over ten frames.
    doc.timeline.channels.push(KeyframeChannel {
        object_id: "card-clip".into(),
        property: "x".into(),
        keys: vec![
            SceneKeyframe {
                frame: 0,
                value: 100.0,
                easing: Default::default(),
                bezier: None,
            },
            SceneKeyframe {
                frame: 10,
                value: 160.0,
                easing: Default::default(),
                bezier: None,
            },
        ],
    });
    doc
}

#[test]
#[ignore = "requires hardware GPU; explicit 3.19 clip gate"]
fn gpu_engine_clips_groups_by_a_moving_matte_within_one_code_of_the_cpu_reference() {
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        let (mut engine, ticks) = hardware_engine();
        let mut doc = clip_fixture();
        doc.working_color_space = space;
        let pin = publish(&mut engine, doc);
        let sources = engine.gpu_source_trace(&pin.0, pin.1).unwrap().to_vec();
        assert_eq!(sources.len(), 8, "every drawing object, clip children too");
        assert!(sources
            .iter()
            .all(|s| s.route == "gpu-vello-coverage-at-prepare"));
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        assert!(engine
            .prepared_scene(&pin.0, pin.1)
            .unwrap()
            .has_animation());
        let mut seen = Vec::new();
        let mut strict = Vec::new();
        // Frames 0, 5 and 10: the clip at rest, half way and arrived.
        for tick in [1, 6, 11] {
            ticks.store(tick, Ordering::Relaxed);
            let program = engine.emit_frame_settled().unwrap().frame;
            let scene_frame = engine.program_frame_trace().unwrap().scene_frame;
            let cpu = engine.prepared_scene(&pin.0, pin.1).unwrap();
            let reference = cpu.frame_at(scene_frame, OutputTransform::Rec709).unwrap();
            let checked = scene_frame == 0 || scene_frame == 10;
            let preview_reference =
                checked.then(|| cpu.frame_at(scene_frame, OutputTransform::Srgb).unwrap());
            assert_within_one_code(
                &program,
                &reference,
                &format!("{space:?} frame {scene_frame}"),
            );
            if let Some(preview_reference) = preview_reference {
                let preview = engine.take_preview().unwrap();
                assert_within_one_code(
                    &preview,
                    &preview_reference,
                    &format!("{space:?} Preview frame {scene_frame}"),
                );
                strict.push((scene_frame, strict_44(&preview, &preview_reference)));
                seen.push((scene_frame, preview));
            }
        }
        let at = |frame: u64| {
            &seen
                .iter()
                .find(|(f, _)| *f == frame)
                .expect("frame seen")
                .1
        };
        let alpha =
            |f: &Frame, x: u32, y: u32| i32::from(f.pixels[((y * f.width + x) * 4 + 3) as usize]);
        let near = |actual: i32, expected: f64, what: &str| {
            let expected = (expected * 255.0).round() as i32;
            assert!(
                (actual - expected).abs() <= 1,
                "{space:?}: {what}: alpha {actual}, expected {expected}"
            );
        };
        let first = at(0);
        // Group 50% x the clip's own 80%: 0.4, not 0.5 x 0.4.
        near(alpha(first, 200, 200), 0.4, "card fill inside the clip");
        // The nested fill, masked and inside both clips, over the card fill.
        near(
            alpha(first, 150, 150),
            0.64,
            "nested fill inside both clips",
        );
        near(
            alpha(first, 110, 200),
            0.4,
            "card fill near the clip's left edge",
        );
        near(
            alpha(first, 520, 200),
            0.0,
            "card fill and Multiply outside the clip",
        );
        near(alpha(first, 750, 150), 1.0, "the unclipped rect");
        near(
            alpha(first, 920, 120),
            0.0,
            "a visible clip child is not drawn",
        );
        near(alpha(first, 970, 170), 1.0, "badge fill inside its clip");
        near(alpha(first, 1050, 220), 0.0, "badge fill outside its clip");
        // Ten frames on, the clip has moved 60 px right.
        let last = at(10);
        near(alpha(last, 110, 200), 0.0, "the clip has left");
        // There both the fill and the Multiply rect show, each at 0.4.
        near(alpha(last, 520, 200), 0.64, "the clip has arrived");
        println!(
            "3.19 {space:?} clip: strict 4.4 reading (frame, (differing share, worst)): {strict:?}"
        );
        evidence(
            &format!("clips-{}.json", space.as_str()),
            &json!({"strict44": strict.iter().map(|(f, (share, worst))| json!({"frame": f, "differingShare": share, "worst": worst})).collect::<Vec<_>>(),
                    "sources": sources, "adapter": engine.gpu_description()}),
        );
    }
}
