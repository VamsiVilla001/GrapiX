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
        assert_eq!(prepare_work.cpu_source_rasterizations, 3);
        assert!(prepare_work.gpu_resource_builds > 0);
        let sources = engine.gpu_source_trace(&pin.0, pin.1).unwrap().to_vec();
        assert_eq!(
            sources
                .iter()
                .map(|s| s.object_id.as_str())
                .collect::<Vec<_>>(),
            ["plate", "headline", "accent"]
        );
        assert!(matches!(take(&mut engine, &pin), EngineReply::Taken(_)));
        let mut frames = Vec::new();
        for scene_frame in [0, 25, 50, 100] {
            ticks.store(1 + scene_frame, Ordering::Relaxed);
            let program = engine.emit_frame().unwrap().frame;
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
            assert_eq!(
                *program, reference_program,
                "lower-third Program differs at {space:?}/{scene_frame}"
            );
            assert_eq!(
                *preview, reference_preview,
                "lower-third Preview differs at {space:?}/{scene_frame}"
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
        let program = engine.emit_frame().unwrap().frame;
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
        engine.emit_frame().unwrap();
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
        assert_eq!(
            *preview,
            golden,
            "GPU golden comparison: {}",
            path.display()
        );
        assert_eq!(
            engine.program_frame_trace().unwrap().backend,
            "gpu-compositor"
        );
    }
    assert_eq!(comparisons.len(), 6);
    evidence(
        "golden-differences.json",
        &json!({"adapter": engine.gpu_description(), "comparisons": comparisons, "rebaselined": false}),
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
    let program = engine.emit_frame().unwrap().frame;
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
        engine.emit_frame().unwrap().frame,
        program,
        "a refused publish must not alter pinned Program"
    );
    assert!(matches!(
        engine.handle(ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity
        })),
        EngineReply::Cleared(_)
    ));
    let clear = engine.emit_frame().unwrap().frame;
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
        assert!(!original.emit_frame().unwrap().frame.is_black());
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
    assert!(engine.emit_frame().unwrap().frame.is_black());
    assert!(matches!(
        engine.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "virtual".into(),
            live: false,
            accept_free_run: false,
        })),
        EngineReply::OutputConfigured { .. }
    ));
    ticks.store(2, Ordering::Relaxed);
    assert!(!engine.emit_frame().unwrap().frame.is_black());
    let trace = engine.program_frame_trace().unwrap().clone();
    assert_eq!(trace.backend, "gpu-compositor");
    assert_eq!(trace.work.gpu_resource_builds, 0);
    assert_eq!(trace.work.cpu_full_frame_rasterizations, 0);
    engine.gpu = Gpu::without_hardware(DeviceTier::T2);
    let before = RenderWork::snapshot();
    assert!(matches!(
        engine.emit_frame(),
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
