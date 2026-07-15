//! TypeScript <-> Rust `SceneDocument` contract test.
//!
//! The fixture JSON is emitted from the TypeScript source of truth
//! (`packages/shared-types/src/fixtures.ts`, compile-time checked against the
//! real `SceneDocument` type) via `npm run fixtures:emit -w @grapix/shared-types`.
//! If shared-types changes shape, regenerating the fixture makes this test
//! fail loudly instead of the daemon misreading scenes at runtime.

use grapix_render_daemon::scene::prepare_scene;

fn load_fixture() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared-types/fixtures/scene-document.v1.json"
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

    // The fixture contains exactly one visible rect the daemon can render...
    assert_eq!(
        scene.rects.len(),
        1,
        "expected exactly one renderable rect in the fixture"
    );
    let rect = &scene.rects[0];
    assert_eq!(rect.object_id, "rect_fixture_plate");
    assert_eq!(rect.x, 140.0);
    assert_eq!(rect.y, 742.0);
    assert_eq!(rect.width, 640.0);
    assert_eq!(rect.height, 120.0);

    // ...plus a text and an ellipse object that must produce explicit
    // unsupported-type warnings, never silent omission.
    assert_eq!(scene.object_count, 3);
    assert!(
        scene.warnings.iter().any(|w| w.contains("\"text\"")),
        "missing unsupported warning for text: {:?}",
        scene.warnings
    );
    assert!(
        scene.warnings.iter().any(|w| w.contains("\"ellipse\"")),
        "missing unsupported warning for ellipse: {:?}",
        scene.warnings
    );
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
