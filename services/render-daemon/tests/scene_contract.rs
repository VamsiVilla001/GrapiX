//! TypeScript <-> Rust `SceneDocument` contract test.
//!
//! The fixture JSON is emitted from the TypeScript source of truth
//! (`Shared/shared-types/src/fixtures.ts`, compile-time checked against the
//! real `SceneDocument` type) via `npm run fixtures:emit -w @grapix/shared-types`.
//! If shared-types changes shape, regenerating the fixture makes this test
//! fail loudly instead of the daemon misreading scenes at runtime.

use grapix_render_core::scene::prepare_scene;

fn load_fixture() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Shared/shared-types/fixtures/scene-document.v1.json"
    );
    let raw = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!(
            "failed to read scene fixture at {path}: {error}\n\
             regenerate it with: npm run fixtures:emit -w @grapix/shared-types"
        )
    });

    serde_json::from_str(&raw).expect("fixture must be valid JSON")
}

#[test]
fn fixture_scene_prepares_for_rendering() {
    let fixture = load_fixture();
    let scene = prepare_scene(&fixture).expect("the shared-types fixture must always prepare");

    assert_eq!(scene.scene_id, "scene_fixture_v1");
    assert_eq!(scene.canvas_width, 1920.0);
    assert_eq!(scene.canvas_height, 1080.0);

    // The fixture contains one visible rect and one ellipse the shared quad
    // shader renders with its analytic ellipse fragment path.
    assert_eq!(
        scene.rects.len(),
        2,
        "expected a renderable rect and ellipse in the fixture"
    );
    let rect = &scene.rects[0];
    assert_eq!(rect.object_id, "rect_fixture_plate");
    assert_eq!(rect.x, 140.0);
    assert_eq!(rect.y, 742.0);
    assert_eq!(rect.width, 640.0);
    assert_eq!(rect.height, 120.0);

    assert_eq!(scene.rects[1].object_id, "ellipse_fixture_badge");
    assert_eq!(scene.rects[1].primitive_kind, 1);

    // Text is retained as one Unicode shaping run for the native compositor.
    assert_eq!(scene.object_count, 3);
    assert_eq!(scene.texts.len(), 1);
    assert_eq!(scene.texts[0].object_id, "text_fixture_name");
    assert!(scene
        .warnings
        .iter()
        .all(|warning| !warning.contains("\"text\"")));
}

#[test]
fn fixture_declares_supported_document_version() {
    let fixture = load_fixture();
    assert_eq!(
        fixture["version"].as_u64(),
        Some(1),
        "SceneDocument version changed; update the daemon's scene module and this contract together"
    );
}
