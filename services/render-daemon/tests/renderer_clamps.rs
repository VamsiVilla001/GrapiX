//! Cross-language numeric clamp contract test.
//!
//! Asserts that the bounds this renderer enforces on read are the ones declared in
//! `Shared/shared-types/contracts/renderer-clamps.json`, which the Editor enforces on **write**.
//!
//! It asserts behaviour, not a constant: out-of-range values are pushed through `prepare_scene` and the
//! prepared light is measured. A clamp that moves in the renderer therefore fails here until the shared
//! claim moves with it — which is the only thing stopping the scene from quietly storing a value the
//! renderer refuses, the defect where typing 500 into a cone angle saved 500 and drew 179.

use serde_json::{json, Value};

fn load_clamps() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Shared/shared-types/contracts/renderer-clamps.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read the shared clamp contract at {path}: {error}"));
    serde_json::from_str(&raw).expect("renderer-clamps.json must be valid JSON")
}

fn bound(clamps: &Value, property: &str, key: &str) -> f64 {
    clamps["light"][property][key]
        .as_f64()
        .unwrap_or_else(|| panic!("light.{property}.{key} must be a number"))
}

/// A spot light with the given cone angle and penumbra, however unreasonable.
fn scene_with_spot(cone_angle: Value, penumbra: Value, intensity: Value) -> Value {
    json!({
        "id": "scene_clamp",
        "name": "Clamp probe",
        "version": 1,
        "canvas": { "width": 1920, "height": 1080, "background": "#000000" },
        "dataContext": {},
        "assets": [],
        "materials": [],
        "objects": [{
            "id": "light_1",
            "name": "Spot",
            "type": "light",
            "x": 960.0, "y": 540.0, "zDepth": 500.0, "zIndex": 0, "layerId": "main",
            "width": 10.0, "height": 10.0, "rotation": 0.0, "opacity": 1.0,
            "visible": true, "locked": false,
            "fill": "#ffffff", "stroke": "#000000", "strokeWidth": 0.0,
            "bindings": {}, "materialSlots": {},
            "lightKind": "spot",
            "intensity": intensity,
            "color": "#ffffff",
            "coneAngleDeg": cone_angle,
            "penumbra": penumbra
        }],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-08-08T00:00:00.000Z",
        "updatedAt": "2026-08-08T00:00:00.000Z"
    })
}

fn prepared_spot(cone_angle: Value, penumbra: Value, intensity: Value)
    -> grapix_render_core::scene::PreparedLight
{
    let scene = scene_with_spot(cone_angle, penumbra, intensity);
    let prepared = grapix_render_core::scene::prepare_scene(&scene).expect("probe scene must prepare");
    prepared
        .lights
        .into_iter()
        .next()
        .expect("the probe scene must prepare exactly one light")
}

/// The cosine of the outer half-angle a cone of `degrees` produces.
fn outer_cosine_for(degrees: f64) -> f32 {
    ((degrees as f32) * 0.5).to_radians().cos()
}

#[test]
fn an_over_wide_cone_is_clamped_to_the_declared_maximum() {
    let clamps = load_clamps();
    let max = bound(&clamps, "coneAngleDeg", "max");
    let light = prepared_spot(json!(500.0), json!(0.25), json!(1.0));
    // The prepared light carries cosines rather than degrees, so the bound is checked through them.
    let expected = outer_cosine_for(max);
    assert!(
        (light.spot_outer_cos - expected).abs() < 1e-5,
        "a 500° cone should prepare as {max}°: expected outer cosine {expected}, got {}",
        light.spot_outer_cos
    );
}

#[test]
fn an_under_narrow_cone_is_clamped_to_the_declared_minimum() {
    let clamps = load_clamps();
    let min = bound(&clamps, "coneAngleDeg", "min");
    let light = prepared_spot(json!(0.0), json!(0.25), json!(1.0));
    let expected = outer_cosine_for(min);
    assert!(
        (light.spot_outer_cos - expected).abs() < 1e-5,
        "a 0° cone should prepare as {min}°: expected outer cosine {expected}, got {}",
        light.spot_outer_cos
    );
}

#[test]
fn a_cone_inside_the_declared_range_is_left_alone() {
    let light = prepared_spot(json!(45.0), json!(0.25), json!(1.0));
    let expected = outer_cosine_for(45.0);
    assert!((light.spot_outer_cos - expected).abs() < 1e-5);
}

#[test]
fn an_absent_cone_falls_back_to_the_declared_default() {
    let clamps = load_clamps();
    let fallback = bound(&clamps, "coneAngleDeg", "fallback");
    // The field is **omitted**, not nulled: serde's `default` covers a missing key, while an explicit
    // null fails deserialisation and the light would not prepare at all — which is a different path.
    let scene = json!({
        "id": "scene_clamp",
        "name": "Clamp probe",
        "version": 1,
        "canvas": { "width": 1920, "height": 1080, "background": "#000000" },
        "dataContext": {},
        "assets": [],
        "materials": [],
        "objects": [{
            "id": "light_1",
            "name": "Spot",
            "type": "light",
            "x": 960.0, "y": 540.0, "zDepth": 500.0, "zIndex": 0, "layerId": "main",
            "width": 10.0, "height": 10.0, "rotation": 0.0, "opacity": 1.0,
            "visible": true, "locked": false,
            "fill": "#ffffff", "stroke": "#000000", "strokeWidth": 0.0,
            "bindings": {}, "materialSlots": {},
            "lightKind": "spot",
            "intensity": 1.0,
            "color": "#ffffff"
        }],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-08-08T00:00:00.000Z",
        "updatedAt": "2026-08-08T00:00:00.000Z"
    });
    let prepared = grapix_render_core::scene::prepare_scene(&scene).expect("probe scene must prepare");
    let light = prepared.lights.into_iter().next().expect("one light");
    let expected = outer_cosine_for(fallback);
    assert!(
        (light.spot_outer_cos - expected).abs() < 1e-5,
        "an absent cone should prepare as the declared fallback {fallback}°"
    );
}

#[test]
fn a_negative_intensity_is_floored_at_the_declared_minimum() {
    let clamps = load_clamps();
    let min = bound(&clamps, "intensity", "min") as f32;
    let light = prepared_spot(json!(45.0), json!(0.25), json!(-5.0));
    assert!(
        light.intensity >= min,
        "intensity should be floored at {min}, got {}",
        light.intensity
    );
}
