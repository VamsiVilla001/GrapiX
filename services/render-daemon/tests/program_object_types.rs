//! Cross-language object-type support contract test.
//!
//! Asserts that the object types this renderer actually prepares are exactly the ones declared in
//! `Shared/shared-types/contracts/program-object-types.json`, which the Editor reads to decide whether
//! a property control may claim on-air support.
//!
//! This asserts **behaviour, not a mirrored list**: every declared `SceneObjectType` is fed through
//! `prepare_scene`, and the types that avoid the "are NOT rendered" warning are compared against the
//! file. A renderer that gains or loses a type therefore fails this test until the shared claim is
//! updated, and the Editor cannot promise support that was never implemented — the defect that let the
//! Object Inspector offer an `image` fit mode and a `camera` clipping plane that no published frame
//! honours.

use serde_json::{json, Value};

fn load_contract() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Shared/shared-types/contracts/program-object-types.json"
    );
    let raw = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!("failed to read the shared object-type contract at {path}: {error}")
    });
    serde_json::from_str(&raw).expect("program-object-types.json must be valid JSON")
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} must be an array"))
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .unwrap_or_else(|| panic!("{key} entries must be strings"))
                .to_string()
        })
        .collect()
}

/// A scene carrying exactly one object, with every field the shared contract requires of a base object.
fn scene_with(object_type: &str) -> Value {
    let mut object = json!({
        "id": format!("{object_type}_1"),
        "name": format!("Probe {object_type}"),
        "type": object_type,
        "x": 10.0, "y": 20.0, "zDepth": 0.0, "zIndex": 1, "layerId": "main",
        "width": 200.0, "height": 100.0, "rotation": 0.0, "opacity": 1.0,
        "visible": true, "locked": false,
        "fill": "#ff0000", "stroke": "#ffffff", "strokeWidth": 0.0,
        "bindings": {}, "materialSlots": {}
    });

    // The per-type members each object kind requires to deserialise at all. A probe that failed to
    // parse would be reported as skipped rather than unsupported, which would make this test lie.
    let extra = match object_type {
        "text" => json!({ "text": "PROBE", "fontSize": 48.0, "fontFamily": "Arial", "fontWeight": "400", "align": "left" }),
        "rect" => json!({ "radius": 0.0 }),
        "image" => json!({ "src": "", "objectFit": "stretch" }),
        "line" => json!({ "points": [{ "x": 0.0, "y": 0.0 }, { "x": 10.0, "y": 10.0 }] }),
        "shape" => json!({
            "path": { "closed": true, "points": [
                { "x": 0.0, "y": 0.0, "inX": 0.0, "inY": 0.0, "outX": 0.0, "outY": 0.0 },
                { "x": 10.0, "y": 0.0, "inX": 0.0, "inY": 0.0, "outX": 0.0, "outY": 0.0 },
                { "x": 10.0, "y": 10.0, "inX": 0.0, "inY": 0.0, "outX": 0.0, "outY": 0.0 }
            ] },
            "fillEnabled": true, "strokeEnabled": false, "fillRule": "nonzero"
        }),
        "paint" => json!({ "strokes": [], "paintBlendMode": "normal" }),
        "mesh" => json!({ "meshKind": "cube", "depth": 50.0 }),
        "light" => json!({ "lightKind": "directional", "intensity": 1.0, "color": "#ffffff" }),
        "camera" => json!({ "cameraKind": "perspective", "fov": 45.0, "zoom": 1.0 }),
        "layer" => json!({ "layerKind": "object", "childIds": [] }),
        "marker" => json!({ "markerKind": "marker", "eventName": "" }),
        "group" => json!({ "childIds": [] }),
        _ => json!({}),
    };

    if let (Some(base), Some(fields)) = (object.as_object_mut(), extra.as_object()) {
        for (key, value) in fields {
            base.insert(key.clone(), value.clone());
        }
    }

    json!({
        "id": "scene_probe",
        "name": "Object type probe",
        "version": 1,
        "canvas": { "width": 1920, "height": 1080, "background": "#000000" },
        "dataContext": {},
        "assets": [],
        "materials": [],
        "objects": [object],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-08-08T00:00:00.000Z",
        "updatedAt": "2026-08-08T00:00:00.000Z"
    })
}

/// True when `prepare_scene` reported this type as one it does not render.
fn reported_unsupported(object_type: &str) -> bool {
    let scene = scene_with(object_type);
    let prepared = grapix_render_core::scene::prepare_scene(&scene)
        .unwrap_or_else(|error| panic!("{object_type} probe scene must prepare: {error}"));

    prepared
        .warnings
        .iter()
        .any(|warning| warning.contains("are NOT rendered") && warning.contains(object_type))
}

#[test]
fn program_renders_exactly_the_declared_object_types() {
    let contract = load_contract();
    let declared_supported = string_list(&contract, "programObjectTypes");
    let declared_unsupported = string_list(&contract, "notRenderedByProgram");

    let mut actually_supported: Vec<String> = Vec::new();
    let mut actually_unsupported: Vec<String> = Vec::new();

    for object_type in declared_supported.iter().chain(declared_unsupported.iter()) {
        if reported_unsupported(object_type) {
            actually_unsupported.push(object_type.clone());
        } else {
            actually_supported.push(object_type.clone());
        }
    }

    actually_supported.sort();
    actually_unsupported.sort();
    let mut expected_supported = declared_supported.clone();
    let mut expected_unsupported = declared_unsupported.clone();
    expected_supported.sort();
    expected_unsupported.sort();

    assert_eq!(
        actually_supported, expected_supported,
        "the types this renderer prepares no longer match programObjectTypes in the shared contract"
    );
    assert_eq!(
        actually_unsupported, expected_unsupported,
        "the types this renderer refuses no longer match notRenderedByProgram in the shared contract"
    );
}

#[test]
fn an_unsupported_type_is_named_rather_than_silently_dropped() {
    // The Editor's parity notes quote this behaviour to the operator, so the warning has to exist and
    // has to name the type. A silent drop would leave the Inspector claiming Preview parity it cannot
    // justify.
    let prepared = grapix_render_core::scene::prepare_scene(&scene_with("camera"))
        .expect("camera probe scene must prepare");
    let named = prepared
        .warnings
        .iter()
        .any(|warning| warning.contains("camera") && warning.contains("NOT rendered"));
    assert!(named, "expected a warning naming camera; got {:?}", prepared.warnings);
}
