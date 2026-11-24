//! `scenes.ingest_figma` (build plan 18.2, 18.3) driven through the shipped `gx-editor-mcp`
//! binary an agent launches: the last step of Claude (or any LLM) -> Figma -> GrapiX.
//!
//! The metadata below is a trimmed copy of a real `get_metadata` reply from the Figma desktop
//! app (20 Nov 2026), sentences and all. The test proves the frame arrives as one scene of the
//! frame's size, the reply names what the metadata does not carry, the metadata text is kept
//! byte for byte under the report's hash, and a refusal leaves nothing behind.

mod support;

use gx_contracts::ContentHash;
use gx_editor::Projects;
use support::{call, shipped_session};

const METADATA: &str = r#"Currently selected nodes:
- 3300:2528: Full-Screen · Qualified for Finals v1

<frame id="3300:2528" name="Full-Screen · Qualified for Finals v1" x="2098" y="20202" width="1920" height="1080">
  <frame id="3300:2530" name="Background" x="0" y="0" width="1920" height="1080">
    <instance id="3300:2531" name="BG Style" x="0" y="0" width="1920" height="1080" hidden="true" />
    <rounded-rectangle id="3300:2532" name="BG · PIC plate" x="0" y="0" width="1920" height="1080" />
  </frame>
  <instance id="3300:2615" name="Logo · Mono &amp; Year" x="1736" y="80" width="103.94" height="92" />
  <text id="3300:2616" name="Context" x="80" y="80" width="428" height="29" />
</frame>IMPORTANT: After you call this tool, you MUST call get_design_context."#;

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-figma-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn args(scene_id: &str, metadata: &str) -> serde_json::Value {
    serde_json::json!({
        "project": "news",
        "sceneId": scene_id,
        "sourceName": "Qualified for Finals",
        "metadata": metadata,
    })
}

#[test]
fn a_frame_read_through_figma_arrives_as_one_scene_with_its_losses_named() {
    let root = scratch("frame");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    let replies = shipped_session(
        &root,
        &[call(1, "scenes.ingest_figma", args("finals", METADATA))],
    );
    assert!(replies[0]["error"].is_null(), "refused: {}", replies[0]);
    let outcome = &replies[0]["result"];
    assert_eq!(outcome["effects"][0]["effect"], "stored", "{outcome}");
    assert_eq!(outcome["effects"][1]["effect"], "imported", "{outcome}");
    let report = &outcome["effects"][1]["report"];
    assert_eq!(report["sourceFormat"], "figma");

    let stored = projects.read_scene("news", "finals").expect("stored");
    assert_eq!(
        (stored.canvas.width, stored.canvas.height),
        (1920, 1080),
        "the frame is the canvas"
    );
    assert_eq!(stored.name, "Full-Screen · Qualified for Finals v1");
    let ids: Vec<&str> = stored
        .objects
        .iter()
        .map(|o| o.base().id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "3300:2530",
            "3300:2531",
            "3300:2532",
            "3300:2615",
            "3300:2616"
        ]
    );
    assert!(!stored.objects[1].base().visible, "hidden stays hidden");

    // Every node has an entry, and the text one says what is missing and what to do.
    let entries = report["entries"].as_array().expect("entries");
    let text = entries
        .iter()
        .find(|e| e["sourceId"] == "3300:2616")
        .expect("the text node has an entry");
    assert_eq!(text["tier"], "flattened");
    assert!(
        text["substitutions"][0]["sourceFeature"]
            .as_str()
            .unwrap()
            .contains("text content"),
        "{text}"
    );

    // The metadata text is kept byte for byte under the report's hash.
    let hash: ContentHash =
        serde_json::from_value(report["sourceHash"].clone()).expect("a source hash");
    assert_eq!(
        projects.read_asset("news", &hash).unwrap().as_deref(),
        Some(METADATA.as_bytes())
    );
    assert!(stored
        .assets
        .iter()
        .any(|a| a.checksum.as_ref() == Some(&hash)));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_ingest_never_overwrites_and_a_page_list_or_two_frames_store_nothing() {
    let root = scratch("refusals");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    let two = format!(
        "{}{}",
        r#"<frame id="1:1" width="10" height="10"/>"#,
        r#"<frame id="1:2" width="10" height="10"/>"#
    );
    let replies = shipped_session(
        &root,
        &[
            call(1, "scenes.ingest_figma", args("finals", METADATA)),
            call(2, "scenes.ingest_figma", args("finals", METADATA)),
            call(
                3,
                "scenes.ingest_figma",
                args("pages", "Pages:\n- 0:1 Page 1"),
            ),
            call(4, "scenes.ingest_figma", args("two", &two)),
        ],
    );
    let code = |reply: &serde_json::Value| {
        reply["error"]["data"]["code"]["refusal"]
            .as_str()
            .map(str::to_owned)
    };
    assert!(replies[0]["error"].is_null(), "{}", replies[0]);
    assert_eq!(code(&replies[1]).as_deref(), Some("sceneAlreadyExists"));
    assert_eq!(code(&replies[2]).as_deref(), Some("sceneParseFailed"));
    assert_eq!(code(&replies[3]).as_deref(), Some("sceneParseFailed"));
    assert_eq!(
        projects.list_scenes("news").unwrap(),
        vec!["finals".to_owned()],
        "a refused ingest leaves nothing behind"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_tool_is_listed_for_an_agent() {
    let root = scratch("listed");
    Projects::at_root(&root)
        .create_project("news")
        .expect("a project exists");
    let mut session = support::Session::start(&root);
    let reply =
        session.request(&serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    session.finish();
    let tools = reply["result"]["tools"].as_array().expect("tools");
    let tool = tools
        .iter()
        .find(|t| t["name"] == "scenes.ingest_figma")
        .expect("scenes.ingest_figma is offered");
    assert!(tool["description"]
        .as_str()
        .unwrap()
        .contains("get_metadata"));
    assert_eq!(
        tool["inputSchema"]["required"].as_array().map(|r| r.len()),
        Some(3)
    );
    let _ = std::fs::remove_dir_all(root);
}
