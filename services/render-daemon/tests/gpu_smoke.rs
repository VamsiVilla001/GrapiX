//! Headless GPU smoke test: renders one real frame off-screen and checks
//! pixels. Skips (with a message) when no GPU adapter is available, so plain
//! `cargo test` still passes in GPU-less CI.

#![recursion_limit = "256"]

use base64::Engine;
use grapix_render_daemon::renderer::{gpu::GpuContext, render_single_frame};
use grapix_render_daemon::scene::prepare_scene;
use image::ImageEncoder;

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

#[tokio::test]
async fn renders_depth_tested_textured_cube_faces() {
    let gpu = match GpuContext::new().await {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("SKIPPED textured mesh smoke: no GPU adapter available ({error})");
            return;
        }
    };

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 32, 224, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .expect("test texture must encode");
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    let scene_json = serde_json::json!({
        "id": "scene_mesh_smoke",
        "name": "Native Mesh Smoke",
        "version": 1,
        "canvas": { "width": 96, "height": 96, "background": "#020408" },
        "assets": [{
            "assetId": "asset_magenta",
            "name": "Magenta",
            "kind": "image",
            "source": format!("data:image/png;base64,{encoded}"),
            "mimeType": "image/png",
            "importedAt": "2026-07-25T00:00:00.000Z",
            "status": "READY"
        }],
        "materials": [{
            "materialId": "mat_magenta",
            "name": "Magenta texture",
            "type": "image",
            "assetId": "asset_magenta",
            "dynamic": false,
            "opacity": 1,
            "readiness": "READY",
            "parameters": { "baseColor": "#ffffff", "roughness": 0.7 },
            "textureSlots": [{
                "name": "baseTexture",
                "assetId": "asset_magenta",
                "fit": "stretch",
                "wrap": "clamp",
                "filtering": "nearest",
                "uvScale": [1, 1],
                "uvOffset": [0, 0],
                "uvRotation": 0,
                "uvPivot": [0.5, 0.5],
                "flipX": false,
                "flipY": false
            }]
        }],
        "materialInstances": [],
        "objects": [{
            "id": "cube_native",
            "name": "Native Cube",
            "type": "mesh",
            "meshKind": "cube",
            "x": 48,
            "y": 48,
            "zDepth": 0,
            "zIndex": 0,
            "layerId": "main",
            "width": 58,
            "height": 58,
            "depth": 58,
            "rotation": 0,
            "rotationX": -16,
            "rotationY": -28,
            "rotationZ": 0,
            "scaleX": 1,
            "scaleY": 1,
            "scaleZ": 1,
            "anchor": { "x": 29, "y": 29 },
            "anchor3d": { "x": 29, "y": 29, "z": 29 },
            "opacity": 1,
            "visible": true,
            "locked": false,
            "fill": "#4080c0",
            "stroke": "#ffffff",
            "strokeWidth": 0,
            "bindings": {},
            "materialSlots": { "main": "mat_magenta" }
        }],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-07-25T00:00:00.000Z",
        "updatedAt": "2026-07-25T00:00:00.000Z"
    });

    let scene = prepare_scene(&scene_json).expect("mesh scene must prepare");
    assert_eq!(scene.meshes.len(), 1);
    assert_eq!(scene.meshes[0].surfaces.len(), 6);
    assert!(scene.take_blockers.is_empty(), "{:?}", scene.warnings);
    let frame = render_single_frame(&gpu, &scene, 96, 96).expect("mesh frame must render");

    let textured_pixels = frame
        .data
        .chunks_exact(4)
        .filter(|pixel| pixel[2] > 100 && pixel[0] > 80 && pixel[1] < 100)
        .count();
    assert!(
        textured_pixels > 250,
        "expected a substantial magenta textured face, got {textured_pixels} pixels"
    );
}

#[tokio::test]
async fn legacy_surface_aliases_are_lit_and_emissive_remains_visible() {
    let gpu = match GpuContext::new().await {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("SKIPPED material lighting smoke: no GPU adapter available ({error})");
            return;
        }
    };

    let scene_for = |material_type: &str| {
        serde_json::json!({
            "id": format!("scene_{material_type}"),
            "name": "Material lighting",
            "version": 1,
            "canvas": { "width": 96, "height": 96, "background": "#000000" },
            "assets": [],
            "materials": [{
                "materialId": "mat_red",
                "name": "Red",
                "type": material_type,
                "opacity": 1,
                "parameters": {
                    "baseColor": "#ff0000",
                    "metalness": 0,
                    "roughness": 0.6
                }
            }],
            "materialInstances": [],
            "objects": [
                {
                    "id": "cube",
                    "name": "Cube",
                    "type": "mesh",
                    "meshKind": "cube",
                    "x": 48,
                    "y": 48,
                    "zDepth": 0,
                    "width": 58,
                    "height": 58,
                    "depth": 58,
                    "rotationX": 0,
                    "rotationY": 0,
                    "rotationZ": 0,
                    "anchor": { "x": 29, "y": 29 },
                    "anchor3d": { "x": 29, "y": 29, "z": 29 },
                    "visible": true,
                    "opacity": 1,
                    "fill": "#ffffff",
                    "materialSlots": { "main": "mat_red" }
                },
                {
                    "id": "zero_key",
                    "name": "Zero key",
                    "type": "light",
                    "lightKind": "directional",
                    "x": 0,
                    "y": 0,
                    "zDepth": 500,
                    "visible": true,
                    "opacity": 1,
                    "intensity": 0,
                    "color": "#ffffff",
                    "target": { "x": 48, "y": 48, "z": 0 }
                }
            ],
            "updatedAt": "2026-07-27T00:00:00.000Z"
        })
    };

    for material_type in [
        "material",
        "solid-color",
        "image",
        "unlit-texture",
        "basic-lit",
        "pbr",
    ] {
        let scene = prepare_scene(&scene_for(material_type))
            .unwrap_or_else(|error| panic!("{material_type} scene must prepare: {error}"));
        let frame = render_single_frame(&gpu, &scene, 96, 96)
            .unwrap_or_else(|error| panic!("{material_type} frame must render: {error}"));
        let center = pixel(&frame.data, 96, 48, 48);
        assert!(
            center[2] < 8 && center[1] < 8 && center[0] < 8,
            "{material_type} bypassed an authored zero light: {center:?}"
        );
    }

    let additive = prepare_scene(&scene_for("additive-glow")).expect("additive scene must prepare");
    let additive_frame =
        render_single_frame(&gpu, &additive, 96, 96).expect("additive frame must render");
    let additive_center = pixel(&additive_frame.data, 96, 48, 48);
    assert!(
        additive_center[2] > 240 && additive_center[1] < 8 && additive_center[0] < 8,
        "legacy additive glow must remain self-lit: {additive_center:?}"
    );

    let mut emissive_json = scene_for("pbr");
    emissive_json["materials"][0]["parameters"] = serde_json::json!({
        "baseColor": "#000000",
        "metalness": 0,
        "roughness": 0.6,
        "emissiveColor": "#ff0000",
        "emissiveIntensity": 1
    });
    let emissive = prepare_scene(&emissive_json).expect("emissive scene must prepare");
    let emissive_frame =
        render_single_frame(&gpu, &emissive, 96, 96).expect("emissive frame must render");
    let emissive_center = pixel(&emissive_frame.data, 96, 48, 48);
    assert!(
        emissive_center[2] > 240 && emissive_center[1] < 8 && emissive_center[0] < 8,
        "emissive material disappeared under an authored zero light: {emissive_center:?}"
    );
}

#[tokio::test]
async fn renders_imported_gltf_triangle_material_elements() {
    let gpu = match GpuContext::new().await {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("SKIPPED glTF mesh smoke: no GPU adapter available ({error})");
            return;
        }
    };

    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../api-server/tests/fixtures/two-material-triangles.gltf"
    );
    let fixture = std::fs::read(fixture_path).expect("glTF test fixture must exist");
    let encoded = base64::engine::general_purpose::STANDARD.encode(fixture);
    let scene_json = serde_json::json!({
        "id": "scene_gltf_smoke",
        "name": "Native glTF Smoke",
        "version": 1,
        "canvas": { "width": 96, "height": 96, "background": "#020408" },
        "assets": [{
            "assetId": "asset_model",
            "name": "two-material-triangles.gltf",
            "kind": "model",
            "source": format!("data:model/gltf+json;base64,{encoded}"),
            "mimeType": "model/gltf+json",
            "importedAt": "2026-07-25T00:00:00.000Z",
            "status": "READY",
            "modelMaterialNames": ["Body PBR", "Sponsor Screen"]
        }],
        "materials": [],
        "materialInstances": [],
        "objects": [{
            "id": "model_native",
            "name": "Native glTF",
            "type": "mesh",
            "meshKind": "model",
            "modelAssetId": "asset_model",
            "src": "data:model/gltf+json;base64,ignored-object-src",
            "materialElements": ["Body PBR", "Sponsor Screen"],
            "x": 48,
            "y": 48,
            "zDepth": 0,
            "zIndex": 0,
            "layerId": "main",
            "width": 72,
            "height": 52,
            "depth": 24,
            "rotation": 0,
            "rotationX": 0,
            "rotationY": 0,
            "rotationZ": 0,
            "scaleX": 1,
            "scaleY": 1,
            "scaleZ": 1,
            "anchor": { "x": 36, "y": 26 },
            "anchor3d": { "x": 36, "y": 26, "z": 12 },
            "opacity": 1,
            "visible": true,
            "locked": false,
            "fill": "#ffffff",
            "stroke": "#ffffff",
            "strokeWidth": 0,
            "bindings": {},
            "materialSlots": {}
        }],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-07-25T00:00:00.000Z",
        "updatedAt": "2026-07-25T00:00:00.000Z"
    });

    let scene = prepare_scene(&scene_json).expect("glTF scene must prepare");
    assert_eq!(scene.meshes.len(), 1, "{:?}", scene.warnings);
    assert_eq!(scene.meshes[0].surfaces.len(), 2);
    assert!(scene.take_blockers.is_empty(), "{:?}", scene.warnings);
    let frame = render_single_frame(&gpu, &scene, 96, 96).expect("glTF frame must render");
    let red_pixels = frame
        .data
        .chunks_exact(4)
        .filter(|pixel| pixel[2] > pixel[0].saturating_add(30) && pixel[2] > 80)
        .count();
    let blue_pixels = frame
        .data
        .chunks_exact(4)
        .filter(|pixel| pixel[0] > pixel[2].saturating_add(30) && pixel[0] > 80)
        .count();
    assert!(
        red_pixels > 100,
        "authored red material did not render ({red_pixels})"
    );
    assert!(
        blue_pixels > 100,
        "authored blue material did not render ({blue_pixels})"
    );
}
