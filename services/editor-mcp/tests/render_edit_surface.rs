//! The render features (3.17 to 3.19) authored through `scenes.edit` on the
//! shipped `gx-editor-mcp` binary an agent launches.
//!
//! 3.19 made masks, clip groups, track mattes and trim render; until now no
//! edit could set them, so an MCP agent could not use any of them. This builds
//! a scene from nothing over the wire (a group holding a shape and an ellipse,
//! the shape as the clip child, a mask, a track matte, a trim window, a
//! gradient and a round dashed stroke), reads the stored scene back, and
//! refuses what the engine cannot draw by its name, each with the store
//! unchanged.

mod support;

use gx_contracts::color::WorkingColorSpace;
use gx_contracts::scene::{new_scene, SceneDocument, SceneObject};
use gx_editor::Projects;
use support::{call, shipped_session, Session};

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-render-edit-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn zero(n: usize) -> serde_json::Value {
    serde_json::Value::Array(vec![serde_json::json!({ "x": 0.0, "y": 0.0 }); n])
}

fn path(points: &[(f64, f64)], closed: bool) -> serde_json::Value {
    serde_json::json!({
        "closed": closed,
        "vertices": points.iter().map(|(x, y)| serde_json::json!({ "x": x, "y": y })).collect::<Vec<_>>(),
        "inTangents": zero(points.len()),
        "outTangents": zero(points.len()),
    })
}

fn mask(feather: f64) -> serde_json::Value {
    serde_json::json!({
        "path": path(&[(0.0, 0.0), (80.0, 0.0), (40.0, 60.0)], true),
        "mode": "add",
        "feather": feather,
        "expansion": 0.0,
        "opacity": 1.0,
        "inverted": false,
    })
}

fn gradient(angle: f64) -> serde_json::Value {
    let stop = |position: f64, b: f64| serde_json::json!({ "position": position, "color": { "r": 1.0 - b, "g": 1.0 - b, "b": 1.0, "a": 1.0, "space": "srgb" } });
    serde_json::json!({
        "type": "linear-gradient",
        "angle": angle,
        "startX": 0.0, "startY": 0.0, "endX": 1.0, "endY": 0.0,
        "stops": [stop(0.0, 0.0), stop(1.0, 1.0)],
    })
}

/// `scenes.edit` on the stored scene, naming the revision the agent read.
fn edit(id: u64, revision: u64, edits: serde_json::Value) -> serde_json::Value {
    call(
        id,
        "scenes.edit",
        serde_json::json!({
            "target": { "target": "stored", "project": "news", "sceneId": "bug" },
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
fn the_shipped_editor_mcp_authors_the_render_features_and_refuses_what_cannot_be_drawn_by_name() {
    let root = scratch("shipped");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    projects
        .write_scene(
            "news",
            &new_scene("bug", "Bug", WorkingColorSpace::NEW_PROJECT),
        )
        .expect("an empty scene is stored");

    // The whole feature set in one batch: one undo entry, atomic.
    let build = serde_json::json!([
        { "edit": "createObject", "kind": "rect", "name": "Card" },
        { "edit": "createObject", "kind": "group", "name": "Stack" },
        { "edit": "createShape", "name": "Wipe", "path": path(&[(0.0, 0.0), (100.0, 0.0)], false) },
        { "edit": "createObject", "kind": "ellipse", "name": "Disc" },
        { "edit": "setGroupChildren", "groupId": "group-1", "childIds": ["shape-1", "ellipse-1"] },
        { "edit": "setClipChild", "groupId": "group-1", "clipChildId": "shape-1" },
        { "edit": "setObjectMasks", "objectId": "rect-1", "masks": [mask(4.0)] },
        { "edit": "setTrackMatte", "objectId": "rect-1", "trackMatte": { "sourceId": "ellipse-1", "mode": "luma" } },
        { "edit": "setTrim", "objectId": "shape-1", "start": 0.0, "end": 50.0, "offset": 25.0 },
        { "edit": "setPaint", "objectIds": ["ellipse-1"], "slot": "fill", "paint": gradient(0.0) },
        { "edit": "setPaint", "objectIds": ["shape-1"], "slot": "stroke",
          "paint": { "type": "solid", "color": { "r": 1.0, "g": 0.5, "b": 0.0, "a": 1.0, "space": "srgb" } } },
        { "edit": "setStroke", "objectIds": ["shape-1"], "width": 6.0,
          "style": { "join": "round", "cap": "round", "miterLimit": 4.0, "dash": [12.0, 6.0], "dashOffset": 0.0 } },
    ]);
    let built = shipped_session(&root, &[edit(1, 0, build)]);
    assert!(built[0]["error"].is_null(), "refused: {}", built[0]);
    let effects = built[0]["result"]["effects"].as_array().expect("effects");
    assert_eq!(
        effects.len(),
        13,
        "one effect per edit, then the store write: {effects:?}"
    );
    let created: Vec<&str> = effects
        .iter()
        .filter(|effect| effect["effect"] == "objectCreated")
        .map(|effect| effect["objectId"].as_str().unwrap())
        .collect();
    assert_eq!(created, ["rect-1", "group-1", "shape-1", "ellipse-1"]);

    // A second process reads the stored scene: every feature is there.
    let stored = projects.read_scene("news", "bug").expect("stored");
    let SceneObject::Group(group) = object(&stored, "group-1") else {
        panic!("a group");
    };
    assert_eq!(group.child_ids, ["shape-1", "ellipse-1"]);
    assert_eq!(group.clip_child_id.as_deref(), Some("shape-1"));
    let card = object(&stored, "rect-1").base();
    assert_eq!(card.masks().len(), 1);
    assert_eq!(card.masks()[0].feather, 4.0);
    assert_eq!(
        card.track_matte().map(|m| m.source_id.as_str()),
        Some("ellipse-1")
    );
    let SceneObject::Shape(wipe) = object(&stored, "shape-1") else {
        panic!("a shape");
    };
    assert_eq!(
        (wipe.trim_start, wipe.trim_end, wipe.trim_offset),
        (Some(0.0), Some(50.0), Some(25.0))
    );
    assert!(
        wipe.stroke_enabled,
        "a stroke paint turns a shape's stroke on"
    );
    assert_eq!(wipe.base.stroke_width, 6.0);
    let style = wipe.base.stroke_style();
    assert_eq!(style.dash, [12.0, 6.0]);
    assert_eq!(
        (style.join, style.cap),
        (
            gx_contracts::scene::StrokeJoin::Round,
            gx_contracts::scene::StrokeCap::Round
        )
    );
    assert_eq!(
        card.track_matte().map(|m| m.mode),
        Some(gx_contracts::scene::TrackMatteMode::Luma)
    );
    assert!(matches!(
        object(&stored, "ellipse-1").base().fill,
        Some(gx_contracts::color::ColorValue::LinearGradient { .. })
    ));
    // The scene the agent built passes the preflight an author runs.
    let pre = shipped_session(
        &root,
        &[call(
            2,
            "validate.preflight",
            serde_json::json!({ "project": "news", "scene_id": "bug" }),
        )],
    );
    assert!(pre[0]["error"].is_null(), "preflight refused: {}", pre[0]);

    // What the engine cannot draw is refused by its name, and each refusal
    // leaves the stored scene exactly as it was.
    let refused: [(&str, serde_json::Value); 9] = [
        (
            "maskInvalid",
            serde_json::json!({ "edit": "setObjectMasks", "objectId": "group-1", "masks": [mask(1.0)] }),
        ),
        (
            "maskInvalid",
            serde_json::json!({ "edit": "setObjectMasks", "objectId": "rect-1", "masks": [mask(1.0e9)] }),
        ),
        (
            "clipGroupInvalid",
            serde_json::json!({ "edit": "setClipChild", "groupId": "group-1", "clipChildId": "rect-1" }),
        ),
        (
            "trackMatteInvalid",
            serde_json::json!({ "edit": "setTrackMatte", "objectId": "rect-1", "trackMatte": { "sourceId": "rect-1", "mode": "alpha" } }),
        ),
        (
            "objectFieldNotApplicable",
            serde_json::json!({ "edit": "setTrim", "objectId": "rect-1", "start": 0.0, "end": 50.0 }),
        ),
        (
            "shapeTrimInvalid",
            serde_json::json!({ "edit": "setTrim", "objectId": "shape-1", "start": 140.0 }),
        ),
        (
            "gradientNotDrawable",
            serde_json::json!({ "edit": "setPaint", "objectIds": ["rect-1"], "slot": "fill", "paint": gradient(45.0) }),
        ),
        (
            "objectFieldValueInvalid",
            serde_json::json!({ "edit": "setStroke", "objectIds": ["shape-1"], "width": 2.0,
                                "style": { "join": "miter", "cap": "butt", "miterLimit": 0.5 } }),
        ),
        (
            "sceneHierarchyInvalid",
            serde_json::json!({ "edit": "setGroupChildren", "groupId": "group-1", "childIds": ["ghost"] }),
        ),
    ];
    let mut session = Session::start(&root);
    for (index, (code, bad)) in refused.iter().enumerate() {
        let reply = session.call(&edit(10 + index as u64, 1, serde_json::json!([bad])));
        assert!(
            reply["result"].is_null(),
            "{code}: the edit was accepted: {reply}"
        );
        assert_eq!(
            reply["error"]["data"]["code"]["refusal"], *code,
            "{bad} -> {reply}"
        );
        assert_eq!(
            projects.read_scene("news", "bug").expect("stored"),
            stored,
            "{code}: a refused edit changed the store"
        );
    }
    // A misspelt key is refused with its name, not dropped in silence: a
    // trim "begin" that became no trim at all is the failure this prevents.
    let misspelt = session.call(&edit(
        29,
        1,
        serde_json::json!([{ "edit": "setTrim", "objectId": "shape-1", "begin": 10.0 }]),
    ));
    assert!(misspelt["result"].is_null(), "{misspelt}");
    assert!(
        misspelt["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("begin")),
        "{misspelt}"
    );
    assert_eq!(projects.read_scene("news", "bug").expect("stored"), stored);
    // One bad edit refuses the whole batch: the good edit before it is not kept.
    let atomic = session.call(&edit(
        30,
        1,
        serde_json::json!([
            { "edit": "setPaint", "objectIds": ["rect-1"], "slot": "fill",
              "paint": { "type": "solid", "color": { "r": 0.0, "g": 1.0, "b": 0.0, "a": 1.0, "space": "srgb" } } },
            { "edit": "setClipChild", "groupId": "group-1", "clipChildId": "rect-1" },
        ]),
    ));
    assert_eq!(
        atomic["error"]["data"]["code"]["refusal"], "clipGroupInvalid",
        "{atomic}"
    );
    assert_eq!(projects.read_scene("news", "bug").expect("stored"), stored);

    // The advertised schema accepts each new edit, and rejects a misspelt key.
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
    let target = serde_json::json!({ "target": "stored", "project": "news", "sceneId": "bug" });
    for good in [
        serde_json::json!({ "edit": "setObjectMasks", "objectId": "a", "masks": [mask(1.0)] }),
        serde_json::json!({ "edit": "setClipChild", "groupId": "g" }),
        serde_json::json!({ "edit": "setTrackMatte", "objectId": "a", "trackMatte": { "sourceId": "b", "mode": "lumaInverted" } }),
        serde_json::json!({ "edit": "setTrim", "objectId": "s", "start": 10.0 }),
        serde_json::json!({ "edit": "setPaint", "objectIds": ["a"], "slot": "stroke" }),
        serde_json::json!({ "edit": "setStroke", "objectIds": ["a"], "width": 2.0 }),
        serde_json::json!({ "edit": "createShape", "name": "S", "path": path(&[(0.0, 0.0), (1.0, 1.0)], false) }),
        serde_json::json!({ "edit": "setGroupChildren", "groupId": "g", "childIds": [] }),
    ] {
        assert!(
            validator.is_valid(&serde_json::json!({ "target": target, "edits": [good] })),
            "the schema rejects {good}"
        );
    }
    for bad in [
        serde_json::json!({ "edit": "setPaint", "objectIds": ["a"], "slot": "middle" }),
        serde_json::json!({ "edit": "setTrackMatte", "objectId": "a", "trackMatte": { "sourceId": "b", "mode": "multiply" } }),
    ] {
        assert!(
            !validator.is_valid(&serde_json::json!({ "target": target, "edits": [bad] })),
            "the schema accepts {bad}"
        );
    }
    std::fs::remove_dir_all(root).expect("clean up");
}
