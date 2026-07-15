//! Headless GPU smoke test: renders one real frame off-screen and checks
//! pixels. Skips (with a message) when no GPU adapter is available, so plain
//! `cargo test` still passes in GPU-less CI.

use grapix_render_daemon::renderer::{gpu::GpuContext, render_single_frame};
use grapix_render_daemon::scene::prepare_scene;

#[tokio::test]
async fn renders_a_rect_offscreen() {
    let gpu = match GpuContext::new().await {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("SKIPPED gpu_smoke: no GPU adapter available ({error})");
            return;
        }
    };

    // Left half red rect on a dark blue background.
    let scene_json = serde_json::json!({
        "id": "scene_smoke",
        "name": "Smoke",
        "version": 1,
        "canvas": { "width": 64, "height": 36, "background": "#103050" },
        "dataContext": {},
        "assets": [],
        "materials": [],
        "objects": [{
            "id": "rect_smoke", "name": "Half", "type": "rect",
            "x": 0, "y": 0, "zDepth": 0, "zIndex": 0, "layerId": "main",
            "width": 32, "height": 36, "rotation": 0, "opacity": 1,
            "visible": true, "locked": false,
            "fill": "#ff0000", "stroke": "#000000", "strokeWidth": 0,
            "bindings": {}, "materialSlots": {}, "radius": 0
        }],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-07-15T00:00:00.000Z",
        "updatedAt": "2026-07-15T00:00:00.000Z"
    });

    let scene = prepare_scene(&scene_json).expect("smoke scene must prepare");
    let frame = render_single_frame(&gpu, &scene, 64, 36).expect("frame must render");

    assert_eq!(frame.width, 64);
    assert_eq!(frame.height, 36);
    assert_eq!(frame.data.len(), 64 * 36 * 4);

    // Pixel (16, 18): inside the rect. BGRA bytes, sRGB-encoded. Pure red
    // round-trips exactly through the linear<->sRGB conversion.
    let inside = pixel(&frame.data, 64, 16, 18);
    assert!(
        inside[2] >= 250,
        "expected red inside the rect, got {inside:?}"
    );
    assert!(
        inside[0] <= 5 && inside[1] <= 5,
        "expected no blue/green inside the rect, got {inside:?}"
    );
    assert_eq!(inside[3], 255, "rect must be opaque");

    // Pixel (48, 18): background #103050 -> BGRA ~(0x50, 0x30, 0x10). The
    // sRGB round trip may wobble by ±2 per channel.
    let outside = pixel(&frame.data, 64, 48, 18);
    assert!(
        (outside[0] as i32 - 0x50).abs() <= 2,
        "background blue drifted: {outside:?}"
    );
    assert!(
        (outside[1] as i32 - 0x30).abs() <= 2,
        "background green drifted: {outside:?}"
    );
    assert!(
        (outside[2] as i32 - 0x10).abs() <= 2,
        "background red drifted: {outside:?}"
    );
}

fn pixel(data: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let offset = ((y * width + x) * 4) as usize;
    [
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]
}
