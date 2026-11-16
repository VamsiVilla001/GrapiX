//! The MCP edit gaps (16 Nov 2026) through `scenes.edit` on the shipped
//! `gx-editor-mcp` binary: object width and height, draw order, layer blend
//! mode, anchor, the effect stack, and compound shape paths.
//!
//! One batch sets each through the wire and a second process reads the stored
//! scene back. What cannot be drawn, or names a kind that draws nothing
//! itself, is refused by its name with the store unchanged.

mod support;

use gx_contracts::color::WorkingColorSpace;
use gx_contracts::material::BlendMode;
use gx_contracts::scene::{new_scene, SceneDocument, SceneObject, Vec2};
use gx_editor::Projects;
use support::{call, shipped_session, Session};

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-layout-edit-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn square(x: f64, y: f64, side: f64) -> serde_json::Value {
    let p = |x: f64, y: f64| serde_json::json!({ "x": x, "y": y });
    serde_json::json!({
        "closed": true,
        "vertices": [p(x, y), p(x + side, y), p(x + side, y + side), p(x, y + side)],
        "inTangents": [p(0.0, 0.0), p(0.0, 0.0), p(0.0, 0.0), p(0.0, 0.0)],
        "outTangents": [p(0.0, 0.0), p(0.0, 0.0), p(0.0, 0.0), p(0.0, 0.0)],
    })
}

fn field(id: &str, name: &str, value: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "edit": "setObjectField", "objectIds": [id], "field": { "name": name, "value": value } })
}

fn edit(id: u64, revision: u64, edits: serde_json::Value) -> serde_json::Value {
    call(
        id,
        "scenes.edit",
        serde_json::json!({
            "target": { "target": "stored", "project": "news", "sceneId": "page" },
            "edits": edits,
            "ifRevision": revision,
        }),
    )
}

fn object<'a>(scene: &'a SceneDocument, id: &str) -> &'a SceneObject {
    scene
        .objects
        .iter()
        .find(|object| object.base().id == id)
        .unwrap_or_else(|| panic!("{id} is in the scene"))
}

#[test]
fn the_shipped_editor_mcp_sets_size_order_blend_anchor_effects_and_compound_paths() {
    let root = scratch("shipped");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    projects
        .write_scene(
            "news",
            &new_scene("page", "Page", WorkingColorSpace::NEW_PROJECT),
        )
        .expect("an empty scene is stored");

    let build = serde_json::json!([
        { "edit": "createObject", "kind": "rect", "name": "Card" },
        { "edit": "createObject", "kind": "ellipse", "name": "Disc" },
        { "edit": "createObject", "kind": "group", "name": "Stack" },
        { "edit": "createShape", "name": "Pair", "path": square(0.0, 0.0, 50.0),
          "compoundPaths": [square(100.0, 0.0, 50.0)] },
        { "edit": "createShape", "name": "Swap", "path": square(0.0, 0.0, 10.0) },
        field("rect-1", "width", serde_json::json!(320.0)),
        field("rect-1", "height", serde_json::json!(90.0)),
        field("ellipse-1", "zIndex", serde_json::json!(4)),
        { "edit": "setBlendMode", "objectIds": ["rect-1", "ellipse-1"], "blendMode": "screen" },
        { "edit": "setAnchor", "objectIds": ["rect-1"], "anchor": { "x": 160.0, "y": 45.0 } },
        { "edit": "setEffects", "objectId": "ellipse-1", "effects": [
            { "effectId": "lift", "effect": "exposure", "exposure": 1.0, "offset": 0.0, "gammaCorrection": 1.0 }] },
        { "edit": "setShapePath", "shapeId": "shape-2", "path": square(0.0, 0.0, 40.0),
          "compoundPaths": [square(60.0, 0.0, 40.0), square(120.0, 0.0, 40.0)], "fillRule": "evenodd" },
    ]);
    let built = shipped_session(&root, &[edit(1, 0, build)]);
    assert!(
        built[0]["error"].is_null(),
        "the batch applied: {}",
        built[0]
    );
    assert_eq!(built[0]["result"]["revision"], 1, "{}", built[0]);

    // A second process reads back what the first one stored.
    let stored = projects.read_scene("news", "page").expect("stored");
    let card = object(&stored, "rect-1").base();
    assert_eq!((card.width, card.height), (320.0, 90.0));
    assert_eq!(card.blend_mode, Some(BlendMode::Screen));
    assert_eq!(card.anchor, Some(Vec2 { x: 160.0, y: 45.0 }));
    let disc = object(&stored, "ellipse-1").base();
    assert_eq!(disc.z_index, 4);
    assert_eq!(disc.blend_mode, Some(BlendMode::Screen));
    assert_eq!(disc.effects().len(), 1);
    assert_eq!(disc.effects()[0].effect_id, "lift");
    let SceneObject::Shape(pair) = object(&stored, "shape-1") else {
        panic!("shape-1 is a shape");
    };
    assert_eq!(pair.compound_paths.as_ref().map(Vec::len), Some(1));
    assert_eq!((pair.base.width, pair.base.height), (150.0, 50.0));
    let SceneObject::Shape(swap) = object(&stored, "shape-2") else {
        panic!("shape-2 is a shape");
    };
    assert_eq!(swap.compound_paths.as_ref().map(Vec::len), Some(2));
    assert_eq!(swap.path.vertices[2], Vec2 { x: 40.0, y: 40.0 });
    assert_eq!((swap.base.width, swap.base.height), (160.0, 40.0));
    assert_eq!(swap.fill_rule, gx_contracts::scene::FillRule::Evenodd);
    // The scene an agent built passes the preflight an author runs.
    let pre = shipped_session(
        &root,
        &[call(
            2,
            "validate.preflight",
            serde_json::json!({ "project": "news", "scene_id": "page" }),
        )],
    );
    assert!(pre[0]["error"].is_null(), "preflight refused: {}", pre[0]);

    // Refused by name over the wire, each with the store unchanged.
    let refused: [(&str, serde_json::Value); 7] = [
        (
            "objectFieldNotApplicable",
            serde_json::json!({ "edit": "setBlendMode", "objectIds": ["group-1"], "blendMode": "multiply" }),
        ),
        (
            "objectFieldNotApplicable",
            field("group-1", "zIndex", serde_json::json!(2)),
        ),
        (
            "objectFieldNotApplicable",
            field("shape-1", "width", serde_json::json!(10.0)),
        ),
        (
            "objectFieldValueInvalid",
            field("rect-1", "width", serde_json::json!(-5.0)),
        ),
        (
            "effectInvalid",
            serde_json::json!({ "edit": "setEffects", "objectId": "rect-1", "effects": [
            { "effectId": "lift", "effect": "exposure", "exposure": 99.0, "offset": 0.0, "gammaCorrection": 1.0 }] }),
        ),
        (
            "objectFieldNotApplicable",
            serde_json::json!({ "edit": "setShapePath", "shapeId": "rect-1", "path": square(0.0, 0.0, 5.0) }),
        ),
        (
            "objectFieldUnchanged",
            serde_json::json!({ "edit": "setAnchor", "objectIds": ["rect-1"], "anchor": { "x": 160.0, "y": 45.0 } }),
        ),
    ];
    let mut session = Session::start(&root);
    for (index, (code, bad)) in refused.iter().enumerate() {
        let reply = session.call(&edit(10 + index as u64, 1, serde_json::json!([bad])));
        assert!(reply["result"].is_null(), "{code}: accepted: {reply}");
        assert_eq!(
            reply["error"]["data"]["code"]["refusal"], *code,
            "{bad} -> {reply}"
        );
        assert_eq!(
            projects.read_scene("news", "page").expect("stored"),
            stored,
            "{code}: a refused edit changed the store"
        );
    }
    // A misspelt effect parameter is refused naming it.
    let misspelt = session.call(&edit(
        30,
        1,
        serde_json::json!([{ "edit": "setEffects", "objectId": "rect-1", "effects": [
            { "effectId": "lift", "effect": "exposure", "exposur": 1.0, "offset": 0.0, "gammaCorrection": 1.0 }] }]),
    ));
    assert!(misspelt["result"].is_null(), "{misspelt}");
    assert!(
        misspelt["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("exposur")),
        "{misspelt}"
    );
    assert_eq!(projects.read_scene("news", "page").expect("stored"), stored);

    // The advertised schema accepts each new edit.
    let listed =
        session.request(&serde_json::json!({ "jsonrpc": "2.0", "id": 40, "method": "tools/list" }));
    session.finish();
    let tools = listed["result"]["tools"].as_array().expect("tools");
    let schema = tools
        .iter()
        .find(|tool| tool["name"] == "scenes.edit")
        .map(|tool| &tool["inputSchema"])
        .expect("scenes.edit is listed");
    let validator = jsonschema::validator_for(schema).expect("a valid schema");
    let target = serde_json::json!({ "target": "stored", "project": "news", "sceneId": "page" });
    for good in [
        field("a", "width", serde_json::json!(1.0)),
        field("a", "height", serde_json::json!(1.0)),
        field("a", "zIndex", serde_json::json!(-3)),
        serde_json::json!({ "edit": "setBlendMode", "objectIds": ["a"] }),
        serde_json::json!({ "edit": "setAnchor", "objectIds": ["a"], "anchor": { "x": 1.0, "y": 2.0 } }),
        serde_json::json!({ "edit": "setEffects", "objectId": "a", "effects": [] }),
        serde_json::json!({ "edit": "setShapePath", "shapeId": "s", "path": square(0.0, 0.0, 1.0) }),
        serde_json::json!({ "edit": "createShape", "name": "S", "path": square(0.0, 0.0, 1.0), "compoundPaths": [] }),
    ] {
        assert!(
            validator.is_valid(
                &serde_json::json!({ "target": target, "edits": [good], "ifRevision": 0 })
            ),
            "the schema rejects {good}"
        );
    }
    assert!(
        !validator.is_valid(&serde_json::json!({ "target": target, "ifRevision": 0,
            "edits": [{ "edit": "setBlendMode", "objectIds": ["a"], "blendMode": "glowing" }] })),
        "an unknown blend mode is outside the schema"
    );
    let _ = std::fs::remove_dir_all(root);
}
