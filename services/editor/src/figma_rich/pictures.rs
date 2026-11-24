//! Picture fills: found in the project's `Images/<frame>/`, drawn as image objects, or named with
//! the path to file them at.

use super::*;
use gx_contracts::scene::AssetKind;
use serde_json::json;

fn frame(value: serde_json::Value) -> FigmaNode {
    serde_json::from_value(value).expect("a frame in the typed shape")
}

fn item(stem: &str) -> AssetLibraryItem {
    let hash = content_hash(stem.as_bytes());
    AssetLibraryItem {
        asset_id: format!("img_{}", &hash.0[..16]),
        name: format!("{stem}.png"),
        kind: AssetKind::Image,
        path: format!("Images/League/{stem}.png"),
        checksum: Some(hash),
        mime_type: Some("image/png".into()),
        size_bytes: Some(10),
        status: None,
        provenance: Default::default(),
        color_space: None,
    }
}

fn find_in(stems: &'static [&'static str]) -> impl Fn(&str) -> Option<AssetLibraryItem> {
    move |stem| stems.contains(&stem).then(|| item(stem))
}

fn sample() -> FigmaNode {
    frame(json!({
        "id": "r", "kind": "frame", "name": "League", "width": 1920, "height": 1080,
        "fills": [{ "type": "image", "image": "bg" }],
        "children": [
          { "id": "a", "kind": "rectangle", "x": 10, "y": 10, "width": 50, "height": 50,
            "fills": [{ "type": "image", "image": "helmet.png", "scaleMode": "fit" }] },
          { "id": "b", "kind": "instance", "x": 70, "y": 10, "width": 50, "height": 50,
            "fills": [{ "type": "image", "image": "helmet" }] },
          { "id": "c", "kind": "instance", "x": 130, "y": 10, "width": 13, "height": 20,
            "fills": [{ "type": "image", "image": "chevron" }] },
          { "id": "d", "kind": "rectangle", "x": 0, "y": 0, "width": 9, "height": 9, "cornerRadius": 4,
            "fills": [{ "type": "image", "image": "gone" }] },
          { "id": "e", "kind": "frame", "x": 200, "y": 200, "width": 100, "height": 100,
            "fills": [{ "type": "image", "image": "panel", "scaleMode": "tile" }],
            "children": [{ "id": "f", "kind": "rectangle", "x": 210, "y": 210, "width": 5, "height": 5 }] }
        ]
    }))
}

fn run(stems: &'static [&'static str]) -> ImportOutcome {
    let find = find_in(stems);
    let no_fonts = |_: &str, _: &str| None;
    let lookup = PictureLookup {
        folder: "League".into(),
        find: &find,
        font: &no_fonts,
    };
    import_figma_frame_with("League", &sample(), "s", Some(&lookup)).unwrap()
}

fn find_object<'a>(scene: &'a SceneDocument, id: &str) -> &'a SceneObject {
    scene
        .objects
        .iter()
        .find(|o| o.base().id == id)
        .unwrap_or_else(|| panic!("no object {id}"))
}

#[test]
fn a_picture_the_project_holds_is_drawn_as_an_image_object_with_its_fit() {
    let out = run(&["bg", "helmet", "chevron", "panel"]);
    let SceneObject::Image(background) = &out.scene.objects[0] else {
        panic!("the root's picture is the bottom object")
    };
    assert_eq!(background.base.id, "r::fill");
    assert_eq!(background.fit, FitMode::Cover, "Figma's default is fill");
    assert_eq!(
        (background.base.width, background.base.height),
        (1920.0, 1080.0)
    );

    let SceneObject::Image(helmet) = find_object(&out.scene, "a") else {
        panic!("an image")
    };
    assert_eq!(helmet.fit, FitMode::Contain, "fit");
    assert_eq!(
        helmet.asset_id,
        item("helmet").asset_id,
        "the extension is ignored"
    );

    let SceneObject::Image(panel) = find_object(&out.scene, "e::fill") else {
        panic!("a frame's picture fill sits behind its children")
    };
    assert_eq!(panel.fit, FitMode::Tile);
}

#[test]
fn the_scene_names_each_picture_once_and_the_report_says_what_a_picture_cost() {
    let out = run(&["bg", "helmet", "chevron", "panel"]);
    let ids: Vec<_> = out
        .scene
        .assets
        .iter()
        .filter(|a| a.kind == AssetKind::Image)
        .map(|a| a.path.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "Images/League/bg.png",
            "Images/League/helmet.png",
            "Images/League/chevron.png",
            "Images/League/panel.png"
        ],
        "helmet is used twice and listed once"
    );
    let entry = |id: &str| {
        out.report
            .entries
            .iter()
            .find(|e| e.source_id == id)
            .unwrap()
    };
    // A vector or instance that arrived as its picture is pixels: the lowest tier, and says so.
    assert_eq!(entry("c").tier, ImportTier::Rasterized);
    assert!(entry("c").substitutions[0]
        .source_feature
        .contains("as a picture"));
    // A rectangle that is a picture is native and loses nothing else.
    assert!(
        entry("a").substitutions.is_empty(),
        "{:?}",
        entry("a").substitutions
    );
    assert!(
        !out.report
            .entries
            .iter()
            .flat_map(|e| &e.substitutions)
            .any(|s| s.source_feature.starts_with("figma:picture ")
                && s.source_feature != "figma:picture gone"),
        "nothing is left unresolved but the one that is not filed"
    );
}

#[test]
fn a_picture_that_is_not_filed_is_named_with_the_path_to_file_it_at() {
    let out = run(&["bg", "helmet", "chevron", "panel"]);
    let SceneObject::Rect(missing) = find_object(&out.scene, "d") else {
        panic!("an empty box keeps its place")
    };
    assert!(missing.base.fill.is_none());
    let entry = out
        .report
        .entries
        .iter()
        .find(|e| e.source_id == "d")
        .unwrap();
    let sub = entry
        .substitutions
        .iter()
        .find(|s| s.source_feature == "figma:picture gone")
        .expect("named");
    assert!(sub.reason.contains("Images/League/"), "{}", sub.reason);
    assert!(sub.reason.contains("assets.import"), "{}", sub.reason);

    // With no lookup at all, every picture is named the same way and none is dropped silently.
    let none = import_figma_frame("League", &sample(), "s").unwrap();
    assert!(none
        .scene
        .objects
        .iter()
        .all(|o| !matches!(o, SceneObject::Image(_))));
    let named = none
        .report
        .entries
        .iter()
        .flat_map(|e| &e.substitutions)
        .filter(|s| s.source_feature.starts_with("figma:picture "))
        .count();
    assert_eq!(named, 6, "one for each node that names a picture");
}

#[test]
fn a_font_filed_in_the_project_is_ready_and_one_that_is_not_stays_missing() {
    let f = frame(json!({
        "id": "r", "kind": "frame", "name": "League", "width": 100, "height": 100, "children": [
          { "id": "t1", "kind": "text", "x": 0, "y": 0, "width": 50, "height": 10,
            "text": { "characters": "A", "fontFamily": "New Science", "fontStyle": "SemiBold", "fontSize": 20 } },
          { "id": "t2", "kind": "text", "x": 0, "y": 20, "width": 50, "height": 10,
            "text": { "characters": "B", "fontFamily": "Refrigerator Deluxe", "fontStyle": "Heavy", "fontSize": 20 } }
        ]
    }));
    let no_pictures = |_: &str| None;
    let font = |family: &str, style: &str| {
        (family == "New Science" && style == "SemiBold").then(|| {
            let mut item = item("NewScience-SemiBold");
            item.kind = AssetKind::Font;
            item.path = "Fonts/NewScience-SemiBold.ttf".into();
            (item, FontFormat::Ttf)
        })
    };
    let lookup = PictureLookup {
        folder: "League".into(),
        find: &no_pictures,
        font: &font,
    };
    let out = import_figma_frame_with("League", &f, "s", Some(&lookup)).unwrap();
    let by_id = |id: &str| {
        out.scene
            .fonts
            .iter()
            .find(|f| f.font_id == id)
            .unwrap_or_else(|| panic!("no font {id}"))
    };
    assert_eq!(by_id("new-science-semibold").status, FontLoadStatus::Ready);
    assert_eq!(
        by_id("refrigerator-deluxe-heavy").status,
        FontLoadStatus::Missing
    );
    let FontSource::File { asset_id, .. } = &by_id("new-science-semibold").faces[0].source else {
        panic!("a file source")
    };
    assert!(
        out.scene
            .assets
            .iter()
            .any(|a| &a.asset_id == asset_id && a.kind == AssetKind::Font),
        "the scene's library names the font file it uses"
    );
    let named = |id: &str| {
        out.report
            .entries
            .iter()
            .find(|e| e.source_id == id)
            .unwrap()
            .substitutions
            .iter()
            .any(|s| s.source_feature.starts_with("figma:font"))
    };
    assert!(!named("t1"), "a font that is there is not a loss");
    assert!(named("t2"), "a font that is not there is named");
    let bytes = serde_json::to_vec(&out.scene).unwrap();
    gx_contracts::scene::parse_scene_document(&bytes).expect("the engine's reader accepts it");
}

#[test]
fn the_scene_with_pictures_is_one_the_strict_reader_accepts() {
    let out = run(&["bg", "helmet", "chevron", "panel"]);
    let bytes = serde_json::to_vec(&out.scene).unwrap();
    gx_contracts::scene::parse_scene_document(&bytes).expect("the engine's own reader accepts it");
}
