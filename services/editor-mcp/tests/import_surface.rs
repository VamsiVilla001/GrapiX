//! `scenes.import` (build plan 7.2) driven through the shipped `gx-editor-mcp`
//! binary an agent launches.
//!
//! The pipeline's unit tests prove the tiers. This proves the pipeline is
//! reachable: one SVG that exercises all four tiers is imported over the
//! wire, the reply names every substitution, the stored scene reads back
//! from a second process, and the source bytes are in the project under the
//! hash the report gives.

mod support;

use gx_contracts::color::WorkingColorSpace;
use gx_contracts::project::ProjectSettings;
use gx_contracts::ContentHash;
use gx_editor::Projects;

const EVERY_TIER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg">
    <rect id="background" x="0" y="0" width="1920" height="1080"/>
    <g id="lower-third"/>
    <path id="swoosh" d="M0 0 L10 10 Z" width="100" height="20"/>
    <image id="logo" href="data:image/png;base64,AAAA"/>
</svg>"#;

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-import-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

// The shipped binary is driven through the shared conformant client (8.14):
// real handshake, one request at a time, the value read from
// `structuredContent`.
use support::{call, shipped_session};

fn import_args(scene_id: &str) -> serde_json::Value {
    serde_json::json!({
        "project": "news",
        "sceneId": scene_id,
        "sourceName": "brand.svg",
        "svg": EVERY_TIER,
    })
}

#[test]
fn an_svg_is_imported_with_every_tier_named_and_its_source_kept() {
    let root = scratch("tiers");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    let replies = shipped_session(&root, &[call(1, "scenes.import", import_args("brand"))]);
    assert!(
        replies[0]["error"].is_null(),
        "unexpected refusal: {}",
        replies[0]
    );
    let outcome = &replies[0]["result"];
    assert_eq!(
        outcome["effects"][0],
        serde_json::json!({ "effect": "stored", "origin": { "project": "news", "sceneId": "brand" } }),
        "{outcome}"
    );
    let report = &outcome["effects"][1]["report"];
    assert_eq!(outcome["effects"][1]["effect"], "imported", "{outcome}");

    // Every tier, in source order, each demotion with its reason.
    let entries = report["entries"].as_array().expect("report entries");
    let tiers: Vec<(&str, &str)> = entries
        .iter()
        .map(|entry| {
            (
                entry["sourceId"].as_str().unwrap(),
                entry["tier"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        tiers,
        vec![
            ("background", "native"),
            ("lower-third", "container"),
            ("swoosh", "flattened"),
            ("logo", "rasterized"),
        ]
    );
    for entry in &entries[1..] {
        let substitutions = entry["substitutions"].as_array().expect("substitutions");
        assert!(
            !substitutions.is_empty(),
            "{} lost a tier without a reason",
            entry["sourceId"]
        );
        for substitution in substitutions {
            assert!(
                substitution["reason"]
                    .as_str()
                    .is_some_and(|reason| !reason.is_empty()),
                "{substitution}"
            );
        }
    }

    // The scene is stored, and a second process reads the same document.
    let stored = projects
        .read_scene("news", "brand")
        .expect("the import is stored");
    assert_eq!(stored.name, "brand", "named after its source file");
    let ids: Vec<&str> = stored
        .objects
        .iter()
        .map(|object| object.base().id.as_str())
        .collect();
    // The embedded raster is not imported; the report says so and names no object.
    assert_eq!(ids, vec!["background", "lower-third", "swoosh"]);
    assert!(entries[3]["objectId"].is_null(), "{}", entries[3]);
    let again = shipped_session(
        &root,
        &[call(
            2,
            "scenes.get",
            serde_json::json!({ "project": "news", "scene_id": "brand" }),
        )],
    );
    assert_eq!(again[0]["result"], serde_json::to_value(&stored).unwrap());

    // The source bytes are in the project under the report's hash.
    let hash: ContentHash =
        serde_json::from_value(report["sourceHash"].clone()).expect("a source hash");
    assert_eq!(
        projects
            .read_asset("news", &hash)
            .expect("the project reads its assets")
            .as_deref(),
        Some(EVERY_TIER.as_bytes()),
        "the source is retained byte for byte"
    );
    assert!(
        stored
            .assets
            .iter()
            .any(|item| item.checksum.as_ref() == Some(&hash)),
        "the scene's library names its source"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_import_never_overwrites_and_never_half_lands() {
    let root = scratch("refusals");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    projects
        .create_project_with(
            "linear",
            ProjectSettings {
                working_color_space: WorkingColorSpace::LinearSrgb,
            },
        )
        .expect("a linear project exists");

    let not_svg = serde_json::json!({
        "project": "news", "sceneId": "broken", "sourceName": "broken.svg", "svg": "<svg><rect",
    });
    let mut linear = import_args("brand");
    linear["project"] = "linear".into();
    let replies = shipped_session(
        &root,
        &[
            call(1, "scenes.import", import_args("brand")),
            call(2, "scenes.import", import_args("brand")),
            call(3, "scenes.import", not_svg),
            call(4, "scenes.import", linear),
        ],
    );
    assert!(replies[0]["error"].is_null(), "{}", replies[0]);
    let code = |reply: &serde_json::Value| {
        reply["error"]["data"]["code"]["refusal"]
            .as_str()
            .map(str::to_owned)
    };
    assert_eq!(
        code(&replies[1]).as_deref(),
        Some("sceneAlreadyExists"),
        "{}",
        replies[1]
    );
    assert_eq!(
        code(&replies[2]).as_deref(),
        Some("sceneParseFailed"),
        "{}",
        replies[2]
    );
    assert_eq!(
        code(&replies[3]).as_deref(),
        Some("sceneWorkingSpaceMismatch"),
        "{}",
        replies[3]
    );

    // Nothing from a refused import is left behind.
    assert_eq!(
        projects.list_scenes("news").unwrap(),
        vec!["brand".to_owned()]
    );
    assert!(projects.list_scenes("linear").unwrap().is_empty());
    let hash: ContentHash =
        serde_json::from_value(replies[0]["result"]["effects"][1]["report"]["sourceHash"].clone())
            .expect("a source hash");
    assert_eq!(
        projects.read_asset("linear", &hash).unwrap(),
        None,
        "no source adopted for a refused import"
    );
    let _ = std::fs::remove_dir_all(root);
}
