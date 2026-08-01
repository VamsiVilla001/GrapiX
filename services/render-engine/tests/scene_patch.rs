//! Incremental scene patches.
//!
//! Two things are under test: that the document ends up exactly as the sender intended,
//! and that a patch which cannot be applied cleanly changes nothing at all. The second
//! matters more — an engine holding a half-patched document renders something that
//! exists nowhere else, and no operator can tell from the picture.

use serde_json::{json, Value};

use grapix_render_engine::patch::{apply_patch, PatchFailure, PatchOperation, ScenePatch};

fn scene(revision: u64) -> Value {
    json!({
        "id": "scene_1",
        "name": "Lower third",
        "version": 1,
        "revision": revision,
        "canvas": { "width": 1920, "height": 1080, "background": "#00000000" },
        "dataContext": { "player": { "name": "Alice", "number": 9 } },
        "assets": [],
        "materials": [],
        "objects": [
            {
                "id": "rect_1", "name": "Band", "type": "rect",
                "x": 100.0, "y": 800.0, "width": 900.0, "height": 160.0,
                "zDepth": 0.0, "zIndex": 0, "layerId": "layer_1", "visible": true,
                "fill": "#0b3d91"
            },
            {
                "id": "text_1", "name": "Name", "type": "text",
                "x": 140.0, "y": 840.0, "width": 700.0, "height": 60.0,
                "zDepth": 0.0, "zIndex": 1, "layerId": "layer_1", "visible": true,
                "text": "ALICE"
            }
        ],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    })
}

fn patch(operations: Vec<PatchOperation>) -> ScenePatch {
    ScenePatch {
        scene_id: "scene_1".to_string(),
        base_revision: 1,
        revision: 2,
        timestamp_ms: 0,
        operations,
        origin: None,
    }
}

fn object<'a>(document: &'a Value, object_id: &str) -> &'a Value {
    document["objects"]
        .as_array()
        .expect("objects")
        .iter()
        .find(|object| object["id"] == object_id)
        .unwrap_or_else(|| panic!("no object {object_id}"))
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

#[test]
fn a_patch_based_on_the_wrong_revision_is_refused_and_demands_a_resync() {
    let mut document = scene(5);
    let error = apply_patch(
        &mut document,
        &ScenePatch {
            base_revision: 4,
            revision: 5,
            ..patch(vec![PatchOperation::ObjectVisibility {
                object_id: "rect_1".to_string(),
                visible: false,
            }])
        },
    )
    .expect_err("must refuse");

    assert_eq!(error.failure, PatchFailure::RevisionMismatch);
    assert!(error.failure.requires_full_sync());
    assert!(error.message.contains("scene.fullSync"));
    // Untouched: the sender and the engine disagree, so nothing may be guessed.
    assert_eq!(document["revision"], 5);
    assert_eq!(object(&document, "rect_1")["visible"], true);
}

#[test]
fn a_patch_that_does_not_advance_the_revision_is_refused() {
    let mut document = scene(1);
    let error = apply_patch(
        &mut document,
        &ScenePatch {
            base_revision: 1,
            revision: 1,
            ..patch(vec![PatchOperation::ObjectText {
                object_id: "text_1".to_string(),
                text: "BIANCA".to_string(),
            }])
        },
    )
    .expect_err("must refuse");

    assert_eq!(error.failure, PatchFailure::RevisionNotAdvancing);
}

#[test]
fn a_patch_for_a_different_scene_is_refused_without_a_resync() {
    let mut document = scene(1);
    let error = apply_patch(
        &mut document,
        &ScenePatch {
            scene_id: "scene_other".to_string(),
            ..patch(vec![PatchOperation::ObjectVisibility {
                object_id: "rect_1".to_string(),
                visible: false,
            }])
        },
    )
    .expect_err("must refuse");

    assert_eq!(error.failure, PatchFailure::SceneIdMismatch);
    // Sending the whole scene would not help: the patch is simply addressed wrongly.
    assert!(!error.failure.requires_full_sync());
}

#[test]
fn an_empty_patch_is_refused_rather_than_bumping_the_revision() {
    let mut document = scene(1);
    let error = apply_patch(&mut document, &patch(vec![])).expect_err("must refuse");

    assert_eq!(error.failure, PatchFailure::EmptyPatch);
    // A revision bump with no change would make every other client resync for nothing.
    assert_eq!(document["revision"], 1);
}

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

#[test]
fn a_patch_that_fails_part_way_changes_nothing() {
    // This is the property that makes patching safe rather than merely faster.
    let mut document = scene(1);
    let error = apply_patch(
        &mut document,
        &patch(vec![
            PatchOperation::ObjectText {
                object_id: "text_1".to_string(),
                text: "BIANCA".to_string(),
            },
            PatchOperation::ObjectVisibility {
                object_id: "does_not_exist".to_string(),
                visible: false,
            },
        ]),
    )
    .expect_err("must refuse");

    assert_eq!(error.failure, PatchFailure::UnknownObject);
    assert_eq!(error.operation_index, Some(1));
    // The first operation would have succeeded on its own; it must not have been kept.
    assert_eq!(object(&document, "text_1")["text"], "ALICE");
    assert_eq!(document["revision"], 1);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

#[test]
fn a_transform_writes_only_the_fields_it_carries() {
    let mut document = scene(1);
    let outcome = apply_patch(
        &mut document,
        &patch(vec![PatchOperation::ObjectTransform {
            object_id: "rect_1".to_string(),
            transform: grapix_render_engine::patch::TransformDelta {
                x: Some(250.5),
                opacity: Some(0.5),
                ..Default::default()
            },
        }]),
    )
    .expect("apply");

    let rect = object(&document, "rect_1");
    assert_eq!(rect["x"], 250.5);
    assert_eq!(rect["opacity"], 0.5);
    // Absent fields keep their values: a delta says what changed, not what the object is.
    assert_eq!(rect["y"], 800.0);
    assert_eq!(rect["width"], 900.0);
    assert!(rect.get("rotation").is_none());

    assert_eq!(outcome.revision, 2);
    assert_eq!(document["revision"], 2);
    assert_eq!(outcome.touched_objects, vec!["rect_1".to_string()]);
    // A moved rectangle does not invalidate the whole scene.
    assert!(!outcome.whole_scene_dirty);
}

#[test]
fn creating_an_object_can_choose_its_position_and_re_creating_replaces() {
    let mut document = scene(1);
    apply_patch(
        &mut document,
        &patch(vec![PatchOperation::ObjectCreated {
            object: json!({
                "id": "rect_2", "name": "Accent", "type": "rect",
                "x": 0.0, "y": 0.0, "width": 40.0, "height": 40.0,
                "zDepth": 0.0, "zIndex": 2, "layerId": "layer_1", "visible": true
            }),
            index: Some(0),
        }]),
    )
    .expect("apply");

    assert_eq!(document["objects"][0]["id"], "rect_2");
    assert_eq!(document["objects"].as_array().unwrap().len(), 3);

    // Re-creating an existing id replaces it: two objects sharing an id would make every
    // later operation ambiguous.
    apply_patch(
        &mut document,
        &ScenePatch {
            base_revision: 2,
            revision: 3,
            ..patch(vec![PatchOperation::ObjectCreated {
                object: json!({
                    "id": "rect_2", "name": "Accent v2", "type": "rect",
                    "x": 10.0, "y": 10.0, "width": 40.0, "height": 40.0,
                    "zDepth": 0.0, "zIndex": 2, "layerId": "layer_1", "visible": true
                }),
                index: None,
            }])
        },
    )
    .expect("apply");

    assert_eq!(document["objects"].as_array().unwrap().len(), 3);
    assert_eq!(object(&document, "rect_2")["name"], "Accent v2");
}

#[test]
fn deleting_an_object_reports_it_as_removed_rather_than_touched() {
    let mut document = scene(1);
    let outcome = apply_patch(
        &mut document,
        &patch(vec![PatchOperation::ObjectDeleted {
            object_id: "text_1".to_string(),
        }]),
    )
    .expect("apply");

    assert_eq!(document["objects"].as_array().unwrap().len(), 1);
    assert_eq!(outcome.removed_objects, vec!["text_1".to_string()]);
    // The distinction matters: a removed object's tiles have to be cleared, not redrawn.
    assert!(outcome.touched_objects.is_empty());
}

#[test]
fn an_animation_patch_writes_the_animation_field_not_channels() {
    // The TypeScript twin wrote `channels`, which the renderer never reads, so every
    // animated property silently disappeared.
    let mut document = scene(1);
    let mut channels = serde_json::Map::new();
    channels.insert(
        "x".to_string(),
        json!({
            "property": "x",
            "keys": [{ "id": "k1", "frame": 0, "value": 100.0, "interpolation": "linear" }]
        }),
    );

    apply_patch(
        &mut document,
        &patch(vec![PatchOperation::ObjectAnimation {
            object_id: "rect_1".to_string(),
            channels,
        }]),
    )
    .expect("apply");

    let rect = object(&document, "rect_1");
    assert!(rect["animation"]["x"]["keys"].is_array());
    assert!(rect.get("channels").is_none());
}

#[test]
fn a_material_slot_can_be_set_and_cleared() {
    let mut document = scene(1);
    apply_patch(
        &mut document,
        &patch(vec![PatchOperation::ObjectMaterial {
            object_id: "rect_1".to_string(),
            slot: "face".to_string(),
            material_id: Some("mat_steel".to_string()),
        }]),
    )
    .expect("apply");
    assert_eq!(
        object(&document, "rect_1")["materialSlots"]["face"],
        "mat_steel"
    );

    apply_patch(
        &mut document,
        &ScenePatch {
            base_revision: 2,
            revision: 3,
            ..patch(vec![PatchOperation::ObjectMaterial {
                object_id: "rect_1".to_string(),
                slot: "face".to_string(),
                material_id: None,
            }])
        },
    )
    .expect("apply");

    // Removed rather than set to null: absent is the shape the document uses elsewhere.
    assert!(object(&document, "rect_1")["materialSlots"]
        .get("face")
        .is_none());
}

#[test]
fn a_property_patch_writes_nested_paths_and_array_indices() {
    let mut document = scene(1);
    apply_patch(
        &mut document,
        &patch(vec![
            PatchOperation::ObjectProperty {
                object_id: "rect_1".to_string(),
                path: "style.fill.color".to_string(),
                value: json!("#ff0000"),
            },
            PatchOperation::ObjectProperty {
                object_id: "rect_1".to_string(),
                path: "filters[0].radius".to_string(),
                value: json!(12.0),
            },
        ]),
    )
    .expect("apply");

    let rect = object(&document, "rect_1");
    assert_eq!(rect["style"]["fill"]["color"], "#ff0000");
    assert_eq!(rect["filters"][0]["radius"], 12.0);
}

#[test]
fn a_reorder_keeps_objects_it_did_not_mention() {
    let mut document = scene(1);
    let outcome = apply_patch(
        &mut document,
        &patch(vec![PatchOperation::LayerReorder {
            object_ids: vec!["text_1".to_string()],
        }]),
    )
    .expect("apply");

    // Named first, then everything else in its existing order. Dropping the unmentioned
    // objects would delete content through an operation that only reorders.
    assert_eq!(document["objects"][0]["id"], "text_1");
    assert_eq!(document["objects"][1]["id"], "rect_1");
    assert_eq!(document["objects"].as_array().unwrap().len(), 2);

    // Draw order decides what covers what, so no per-object invalidation is enough.
    assert!(outcome.whole_scene_dirty);
}

#[test]
fn a_reorder_naming_an_unknown_object_is_refused_and_changes_nothing() {
    let mut document = scene(1);
    let error = apply_patch(
        &mut document,
        &patch(vec![PatchOperation::LayerReorder {
            object_ids: vec!["text_1".to_string(), "ghost".to_string()],
        }]),
    )
    .expect_err("must refuse");

    assert_eq!(error.failure, PatchFailure::UnknownObject);
    assert_eq!(document["objects"][0]["id"], "rect_1");
}

#[test]
fn a_data_context_change_invalidates_the_whole_scene() {
    let mut document = scene(1);
    let outcome = apply_patch(
        &mut document,
        &patch(vec![PatchOperation::DataContextChanged {
            path: "player.name".to_string(),
            value: json!("BIANCA"),
        }]),
    )
    .expect("apply");

    assert_eq!(document["dataContext"]["player"]["name"], "BIANCA");
    assert_eq!(document["dataContext"]["player"]["number"], 9);
    // Any object's binding could read it, and the document carries no reverse index.
    assert!(outcome.whole_scene_dirty);
}

#[test]
fn assets_and_materials_are_upserted_by_their_own_id_field() {
    let mut document = scene(1);
    apply_patch(
        &mut document,
        &patch(vec![
            PatchOperation::AssetChanged {
                asset: json!({ "assetId": "asset_1", "name": "Crest", "kind": "image" }),
            },
            PatchOperation::MaterialChanged {
                material: json!({ "materialId": "mat_1", "name": "Steel" }),
            },
        ]),
    )
    .expect("apply");

    assert_eq!(document["assets"][0]["assetId"], "asset_1");
    assert_eq!(document["materials"][0]["materialId"], "mat_1");

    // A second change to the same id replaces rather than appends.
    apply_patch(
        &mut document,
        &ScenePatch {
            base_revision: 2,
            revision: 3,
            ..patch(vec![PatchOperation::AssetChanged {
                asset: json!({ "assetId": "asset_1", "name": "Crest v2", "kind": "image" }),
            }])
        },
    )
    .expect("apply");

    assert_eq!(document["assets"].as_array().unwrap().len(), 1);
    assert_eq!(document["assets"][0]["name"], "Crest v2");
}

#[test]
fn stage_operations_are_reported_rather_than_applied_to_the_scene() {
    let mut document = scene(1);
    let outcome = apply_patch(
        &mut document,
        &patch(vec![PatchOperation::SurfaceChanged {
            surface_id: "surface_led".to_string(),
            value: json!({ "widthPixels": 3840 }),
        }]),
    )
    .expect("apply");

    // The engine holds stages separately from scenes; silently writing this into the
    // scene document would make the two disagree about the surface.
    assert!(outcome.stage_changed);
    assert!(document.get("surfaces").is_none());
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

#[test]
fn a_patch_round_trips_through_the_camel_case_wire_format() {
    // The Editor sends camelCase. A snake_case mismatch here would mean no patch could
    // ever be read, which is exactly the class of fault that hid in the capability
    // structs.
    let wire = json!({
        "sceneId": "scene_1",
        "baseRevision": 1,
        "revision": 2,
        "timestampMs": 1_700_000_000_000u64,
        "origin": "editor_1",
        "operations": [
            { "type": "object.transform", "objectId": "rect_1", "transform": { "x": 10.0, "zDepth": 2.0 } },
            { "type": "object.material", "objectId": "rect_1", "slot": "face", "materialId": null },
            { "type": "dataContext.changed", "path": "player.name", "value": "CHRIS" },
            { "type": "layer.reorder", "objectIds": ["text_1", "rect_1"] }
        ]
    });

    let parsed: ScenePatch = serde_json::from_value(wire).expect("parse");
    assert_eq!(parsed.origin.as_deref(), Some("editor_1"));
    assert_eq!(parsed.operations.len(), 4);
    assert_eq!(parsed.operations[0].name(), "object.transform");
    assert_eq!(parsed.operations[0].object_id(), Some("rect_1"));
    assert_eq!(parsed.operations[3].object_id(), None);

    let mut document = scene(1);
    let outcome = apply_patch(&mut document, &parsed).expect("apply");
    assert_eq!(outcome.applied_operations, 4);
    assert_eq!(object(&document, "rect_1")["zDepth"], 2.0);
}

#[test]
fn an_unknown_operation_type_is_rejected_at_parse_time() {
    // Better than being ignored: a client sending an operation this engine does not
    // implement must be told, not silently rendered without it.
    let wire = json!({
        "sceneId": "scene_1",
        "baseRevision": 1,
        "revision": 2,
        "operations": [{ "type": "object.teleport", "objectId": "rect_1" }]
    });

    assert!(serde_json::from_value::<ScenePatch>(wire).is_err());
}
