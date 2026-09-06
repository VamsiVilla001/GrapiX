//! Cross-language contract: this renderer resolves no data bindings.
//!
//! The Editor tells authors which value is in force for a property, and a bound property is the one case
//! where Preview and Program disagree: `sceneMaterial.ts` calls `applyBindings` before drawing, and
//! nothing here does. `SceneDocumentDto` has no `dataContext` field at all, so the data a binding would
//! read never arrives.
//!
//! That claim is load-bearing for the panel's wording — `describePropertySource` says "Program draws N,
//! which resolves no bindings" — and a claim about another language is worthless unless something checks
//! it. So this asserts the **behaviour**: a scene carrying a `dataContext` and a bound `x` prepares with
//! the authored `x`, untouched.
//!
//! If native binding resolution is ever implemented, this test fails. That is the point: the failure is
//! the reminder that `Shared/shared-types/src/propertySource.ts` now reports a parity gap that no longer
//! exists, and that its wording has to change with the renderer.

use serde_json::{json, Value};

/// A rect whose `x` is bound to a path that resolves, in a scene that carries the data.
fn scene_with_bound_x(authored_x: f64, bound_x: f64) -> Value {
    json!({
        "id": "scene_binding",
        "name": "Binding probe",
        "version": 1,
        "canvas": { "width": 1920, "height": 1080, "background": "#000000" },
        // Present, well-formed, and resolvable by the Editor's `resolveDataPath`.
        "dataContext": { "layout": { "x": bound_x } },
        "assets": [],
        "materials": [],
        "objects": [{
            "id": "rect_1",
            "name": "Plate",
            "type": "rect",
            "x": authored_x,
            "y": 200.0,
            "zDepth": 0.0,
            "zIndex": 0,
            "layerId": "main",
            "width": 400.0,
            "height": 120.0,
            "rotation": 0.0,
            "opacity": 1.0,
            "visible": true,
            "locked": false,
            "fill": "#FF0000",
            "stroke": "#FFFFFF",
            "strokeWidth": 1.0,
            "bindings": { "x": "layout.x" },
            "materialSlots": {},
            "radius": 0.0
        }],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-08-08T00:00:00.000Z",
        "updatedAt": "2026-08-08T00:00:00.000Z"
    })
}

fn prepared_rect_x(scene: &Value) -> f32 {
    let prepared = grapix_render_core::scene::prepare_scene(scene).expect("scene must prepare");
    let rect = prepared
        .rects
        .first()
        .expect("the probe scene has exactly one rect");
    rect.x
}

#[test]
fn a_bound_x_is_ignored_and_the_authored_value_is_prepared() {
    let x = prepared_rect_x(&scene_with_bound_x(100.0, 900.0));
    assert_eq!(
        x, 100.0,
        "this renderer must prepare the authored x; a bound value reaching the picture would mean \
         propertySource.ts is wrong to report Program as unbound"
    );
}

#[test]
fn a_scene_carrying_a_data_context_still_prepares() {
    // The field is unknown to `SceneDocumentDto` and must be ignored rather than rejected: a scene
    // authored with bindings has to render on air, just without them.
    let scene = scene_with_bound_x(250.0, 900.0);
    assert_eq!(prepared_rect_x(&scene), 250.0);
}

#[test]
fn a_binding_to_a_missing_path_changes_nothing_either() {
    let mut scene = scene_with_bound_x(300.0, 900.0);
    scene["objects"][0]["bindings"] = json!({ "x": "nowhere.at.all" });
    assert_eq!(prepared_rect_x(&scene), 300.0);
}

#[test]
fn an_animation_channel_is_not_a_binding_and_must_still_be_absent_from_this_stage() {
    /*
     * Channels *are* honoured on air, but by `services/render-engine/src/animation.rs`, which samples a
     * document into per-frame values before a scene is prepared. So an unsampled channel must not move
     * anything here either: `prepare_scene` reads the authored field, and the two stages stay separate.
     */
    let mut scene = scene_with_bound_x(400.0, 900.0);
    scene["objects"][0]["bindings"] = json!({});
    scene["objects"][0]["animation"] = json!({
        "x": { "keys": [
            { "id": "k0", "frame": 0, "value": 0.0, "easing": "linear" },
            { "id": "k1", "frame": 10, "value": 1000.0, "easing": "linear" }
        ] }
    });
    assert_eq!(prepared_rect_x(&scene), 400.0);
}
