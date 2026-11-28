//! The probe behind docs/evidence/11.61/gpu-glyph-instances-28-nov.txt (claude-backend, row 11.61, 28 Nov 2026): what one frame
//! of an animated text costs on the GPU. Not a test of anything and not built with the tree. To run it again, copy it to
//! services/render-engine/worker/tests/probe_text_frame_cost.rs and run
//!   GX_TEST_SCALAR_GPU=dx12   cargo test -p gx-render-worker --test probe_text_frame_cost -- --nocapture
//!   GX_TEST_SCALAR_GPU=vulkan cargo test -p gx-render-worker --test probe_text_frame_cost -- --nocapture
//! then delete the copy. The "after" numbers were taken with `batch: true` as the default in compositor/draw.rs.
use std::collections::{HashMap, HashSet};

use gx_contracts::{
    color::OutputTransform, material::MaterialSupport, scene::parse_scene_document, scene::SceneObject,
};
use gx_render_worker::compositor::scene::GpuScene;
use gx_render_worker::prepared::PreparedScene;
use gx_render_worker::render_work::RenderWork;

#[test]
fn probe() {
    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::text_animator::{TextAnimator, TextRangeSelector, TextRangeShape};
    use gx_contracts::text_animator_presets::{apply, ID_PREFIX};
    use gx_render_worker::gpu;

    let Ok(backend) = std::env::var("GX_TEST_SCALAR_GPU") else {
        eprintln!("PROBE skipped: set GX_TEST_SCALAR_GPU");
        return;
    };
    let gpu = match backend.as_str() {
        "dx12" => gpu::negotiate_backends(wgpu::Backends::DX12),
        "vulkan" => gpu::negotiate_backends(wgpu::Backends::VULKAN),
        other => panic!("unknown backend {other}"),
    };
    assert!(gpu.has_hardware());

    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare = |scene| PreparedScene::prepare(scene, &available, &assets, &materials).unwrap();

    let mut base = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    base.objects.retain(|object| object.base().id == "caption");
    base.timeline.duration_frames = 200;

    for (label, text) in [
        ("15 glyphs", "GrapiX\nreference".to_owned()),
        ("60 glyphs", "GrapiX reference\ncaption line two\nand a third line\nfourth line here".to_owned()),
    ] {
        let mut scene = base.clone();
        let SceneObject::Text(object) = &mut scene.objects[0] else { panic!() };
        object.text = text;
        object.base.height = 140.0;

        // A: nothing animated. B: geometry only (one path for the whole text). C: fadeUp (opacity: one path a glyph).
        let plain = scene.clone();
        let mut geometry = scene.clone();
        let SceneObject::Text(object) = &mut geometry.objects[0] else { panic!() };
        object.text_animator = Some(TextAnimator {
            y: 40.0,
            selector: TextRangeSelector { shape: TextRangeShape::RampUp, offset: -1.0, ..Default::default() },
            ..Default::default()
        });
        geometry.timeline.channels.push(KeyframeChannel {
            object_id: "caption".into(),
            property: "textAnimator.selector.offset".into(),
            keys: [(0, -1.0), (75, 1.0)]
                .into_iter()
                .map(|(frame, value)| SceneKeyframe { frame, value, easing: SceneEasing::Linear, bezier: None })
                .collect(),
        });
        let mut fade = scene.clone();
        apply(&mut fade, "caption", &format!("{ID_PREFIX}fadeUpCharacters"), 0).unwrap();

        for (kind, document) in [("static", plain), ("geometry only", geometry), ("fadeUp (opacity)", fade)] {
            let prepared = prepare(document);
            let glyphs = prepared.texts().objects[0].glyphs.len();
            let mut gpu_scene = GpuScene::prepare(&gpu, &prepared).unwrap();
            let _ = gpu_scene.render(10).unwrap(); // warm up
            let frames: Vec<u64> = (20..40).collect();
            let before = RenderWork::snapshot();
            let started = std::time::Instant::now();
            for frame in &frames {
                let _ = gpu_scene.render(*frame).unwrap();
            }
            let elapsed = started.elapsed();
            let work = RenderWork::snapshot().since(before);
            let cpu_started = std::time::Instant::now();
            for frame in &frames {
                let _ = prepared.frame_at(*frame, OutputTransform::Srgb).unwrap();
            }
            let cpu = cpu_started.elapsed();
            eprintln!(
                "PROBE {backend} | {label} ({glyphs} glyphs) | {kind} | gpu {:.2} ms/frame, {} resource builds/frame, {} layer dispatches/frame | cpu path {:.2} ms/frame",
                elapsed.as_secs_f64() * 1000.0 / frames.len() as f64,
                work.gpu_resource_builds / frames.len() as u64,
                work.gpu_layer_dispatches / frames.len() as u64,
                cpu.as_secs_f64() * 1000.0 / frames.len() as f64,
            );
        }
    }
}
