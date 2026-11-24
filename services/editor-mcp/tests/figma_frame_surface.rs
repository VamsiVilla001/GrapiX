//! `scenes.ingest_figma` with a full-fidelity `frame` (build plan 18.2), through the shipped
//! `gx-editor-mcp`: paint, text and fonts arrive, the frame is retained byte for byte under the
//! report's hash, and the two-sources rule holds.

mod support;

use gx_contracts::ContentHash;
use gx_editor::Projects;
use support::{call, shipped_session};

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-figma-frame-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn frame() -> serde_json::Value {
    serde_json::json!({
        "id": "1:1", "kind": "frame", "name": "Lower Third", "width": 1920, "height": 1080,
        "children": [
            { "id": "1:2", "kind": "rounded-rectangle", "name": "Plate", "x": 80, "y": 900,
              "width": 800, "height": 100, "cornerRadius": 12,
              "fills": [{ "type": "solid", "color": { "r": 0.0, "g": 0.2, "b": 0.5 } }] },
            { "id": "1:3", "kind": "text", "name": "Name", "x": 110, "y": 925, "width": 700, "height": 50,
              "fills": [{ "type": "solid", "color": { "r": 1, "g": 1, "b": 1 } }],
              "text": { "characters": "TEAM TWIS", "fontFamily": "Inter", "fontStyle": "Bold", "fontSize": 40 } }
        ]
    })
}

fn args(scene_id: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut value = serde_json::json!({
        "project": "news", "sceneId": scene_id, "sourceName": "Lower Third",
    });
    for (k, v) in extra.as_object().unwrap() {
        value[k] = v.clone();
    }
    value
}

#[test]
fn a_frame_arrives_with_its_paint_text_and_fonts_and_is_kept() {
    let root = scratch("frame");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    let replies = shipped_session(
        &root,
        &[call(
            1,
            "scenes.ingest_figma",
            args("lt", serde_json::json!({ "frame": frame() })),
        )],
    );
    assert!(replies[0]["error"].is_null(), "refused: {}", replies[0]);
    let report = &replies[0]["result"]["effects"][1]["report"];
    assert_eq!(report["sourceFormat"], "figma");

    let stored = projects.read_scene("news", "lt").expect("stored");
    let plate = serde_json::to_value(&stored.objects[0]).unwrap();
    assert_eq!(plate["radius"], 12.0, "{plate}");
    assert_eq!(plate["fill"]["type"], "solid", "{plate}");
    let text = serde_json::to_value(&stored.objects[1]).unwrap();
    assert_eq!(text["text"], "TEAM TWIS");
    assert_eq!(text["fontId"], "inter-bold");
    assert_eq!(stored.fonts.len(), 1);
    assert_eq!(
        serde_json::to_value(stored.fonts[0].status).unwrap(),
        "Missing",
        "declared missing, never substituted"
    );

    let hash: ContentHash =
        serde_json::from_value(report["sourceHash"].clone()).expect("a source hash");
    let kept = projects.read_asset("news", &hash).unwrap().expect("kept");
    let kept: serde_json::Value = serde_json::from_slice(&kept).unwrap();
    assert_eq!(kept["id"], "1:1", "the frame itself is what is retained");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn exactly_one_source_is_required_and_a_refusal_stores_nothing() {
    let root = scratch("sources");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    let replies = shipped_session(
        &root,
        &[
            call(
                1,
                "scenes.ingest_figma",
                args("none", serde_json::json!({})),
            ),
            call(
                2,
                "scenes.ingest_figma",
                args(
                    "both",
                    serde_json::json!({ "frame": frame(), "metadata": "<frame id=\"1:1\" width=\"10\" height=\"10\"/>" }),
                ),
            ),
            call(
                3,
                "scenes.ingest_figma",
                args(
                    "typo",
                    serde_json::json!({ "frame": { "id": "1:1", "kind": "frame", "width": 10, "height": 10, "fill": [] } }),
                ),
            ),
        ],
    );
    let code = |reply: &serde_json::Value| {
        reply["error"]["data"]["code"]["refusal"]
            .as_str()
            .map(str::to_owned)
    };
    assert_eq!(
        code(&replies[0]).as_deref(),
        Some("sceneParseFailed"),
        "{}",
        replies[0]
    );
    assert_eq!(
        code(&replies[1]).as_deref(),
        Some("sceneParseFailed"),
        "{}",
        replies[1]
    );
    assert!(
        !replies[2]["error"].is_null(),
        "a misspelt field (fill for fills) is refused, not ignored: {}",
        replies[2]
    );
    assert!(projects.list_scenes("news").unwrap().is_empty());
    let _ = std::fs::remove_dir_all(root);
}
