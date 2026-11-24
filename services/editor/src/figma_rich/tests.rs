use super::*;
use serde_json::json;

fn frame(value: serde_json::Value) -> FigmaNode {
    serde_json::from_value(value).expect("a frame in the typed shape")
}

fn find<'a>(scene: &'a SceneDocument, id: &str) -> &'a SceneObject {
    scene
        .objects
        .iter()
        .find(|o| o.base().id == id)
        .unwrap_or_else(|| panic!("no object {id}"))
}

/// A small broadcast frame: a filled root, a rounded card with a stroke and a shadow, a gradient
/// bar, a rotated blended tick, a hidden helper, a picture fill, a vector and three texts.
fn sample() -> FigmaNode {
    serde_json::from_str(r#"{
        "id": "1:1", "kind": "frame", "name": "Full-Screen", "x": 2098, "y": 20202,
        "width": 1920, "height": 1080, "clipsContent": true,
        "fills": [{ "type": "solid", "color": { "r": 0.0, "g": 0.1, "b": 0.2 } }],
        "children": [
          { "id": "1:2", "kind": "frame", "name": "Card", "x": 85, "y": 300, "width": 196, "height": 237,
            "cornerRadius": 12, "strokeWeight": 2, "strokeAlign": "inside",
            "fills": [{ "type": "solid", "color": { "r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0 }, "opacity": 0.5 }],
            "strokes": [{ "type": "solid", "color": { "r": 1.0, "g": 0.8, "b": 0.0 } }],
            "effects": [{ "type": "drop-shadow", "color": { "r": 0.0, "g": 0.0, "b": 0.0, "a": 0.4 },
                          "offsetX": 0, "offsetY": 8, "radius": 16 }],
            "children": [
              { "id": "1:3", "kind": "text", "name": "Name", "x": 147, "y": 494, "width": 70, "height": 21,
                "fills": [{ "type": "solid", "color": { "r": 1.0, "g": 1.0, "b": 1.0 } }],
                "text": { "characters": "TEAM TWIS", "fontFamily": "Inter", "fontStyle": "Semi Bold",
                          "fontSize": 20, "lineHeightPx": 24, "letterSpacingPx": 2,
                          "align": "center", "verticalAlign": "center", "textCase": "upper" } }
            ] },
          { "id": "1:4", "kind": "rounded-rectangle", "name": "Bar", "x": 0, "y": 900, "width": 1920, "height": 20,
            "cornerRadii": [10, 0, 0, 10],
            "fills": [{ "type": "linear-gradient", "angle": 0, "stops": [
              { "position": 0, "color": { "r": 1, "g": 0, "b": 0 } },
              { "position": 1, "color": { "r": 0, "g": 0, "b": 1 } } ] }] },
          { "id": "1:5", "kind": "rectangle", "name": "Tick", "x": 400, "y": 400, "width": 24, "height": 4,
            "rotation": 30, "opacity": 0.8, "blendMode": "MULTIPLY",
            "fills": [{ "type": "solid", "color": { "r": 1, "g": 1, "b": 1 } }] },
          { "id": "1:6", "kind": "rectangle", "name": "Helper", "x": 0, "y": 0, "width": 5, "height": 5, "visible": false },
          { "id": "1:7", "kind": "rectangle", "name": "Photo", "x": 10, "y": 10, "width": 50, "height": 50,
            "fills": [{ "type": "image", "image": "abc123" }] },
          { "id": "1:8", "kind": "vector", "name": "Swoosh", "x": 5, "y": 5, "width": 40, "height": 10,
            "fills": [{ "type": "solid", "color": { "r": 0.5, "g": 0.5, "b": 0.5 } }] },
          { "id": "1:9", "kind": "text", "name": "Title", "x": 78, "y": 110, "width": 815, "height": 96,
            "text": { "characters": "QUALIFIED", "fontFamily": "Inter", "fontStyle": "Bold", "fontSize": 80 } },
          { "id": "1:10", "kind": "text", "name": "Second", "x": 78, "y": 210, "width": 815, "height": 40,
            "text": { "characters": "again", "fontFamily": "Inter", "fontStyle": "Bold", "fontSize": 32 } }
        ]
    }"#)
    .expect("a frame in the typed shape")
}

fn import() -> ImportOutcome {
    import_figma_frame("Full-Screen", &sample(), "finals").unwrap()
}

#[test]
fn the_scene_is_one_the_strict_reader_accepts() {
    let out = import();
    let bytes = serde_json::to_vec(&out.scene).unwrap();
    gx_contracts::scene::parse_scene_document(&bytes)
        .expect("the engine's own reader accepts what the ingest built, missing fonts included");
    assert_eq!(
        (out.scene.canvas.width, out.scene.canvas.height),
        (1920, 1080)
    );
}

#[test]
fn paint_radius_opacity_rotation_blend_and_visibility_arrive() {
    let out = import();
    let SceneObject::Rect(tick) = find(&out.scene, "1:5") else {
        panic!("a rectangle")
    };
    assert_eq!(
        tick.base.rotation, -30.0,
        "Figma turns counter-clockwise, the scene clockwise"
    );
    assert_eq!(tick.base.opacity, 0.8);
    assert_eq!(tick.base.blend_mode, Some(BlendMode::Multiply));
    assert_eq!((tick.base.x, tick.base.y), (400.0, 400.0));
    let Some(ColorValue::Solid { color }) = &tick.base.fill else {
        panic!("a solid fill")
    };
    assert_eq!((color.r, color.g, color.b, color.a), (1.0, 1.0, 1.0, 1.0));
    assert!(!find(&out.scene, "1:6").base().visible);
    let SceneObject::Rect(bar) = find(&out.scene, "1:4") else {
        panic!("a rectangle")
    };
    assert_eq!(bar.radius, 10.0, "differing corners take the largest");
    assert!(matches!(
        bar.base.fill,
        Some(ColorValue::LinearGradient { .. })
    ));
}

#[test]
fn a_linear_gradient_runs_across_the_box_at_its_angle() {
    let out = import();
    let SceneObject::Rect(bar) = find(&out.scene, "1:4") else {
        panic!()
    };
    let Some(ColorValue::LinearGradient {
        start_x,
        start_y,
        end_x,
        end_y,
        stops,
        ..
    }) = &bar.base.fill
    else {
        panic!()
    };
    assert_eq!(
        (*start_x, *start_y, *end_x, *end_y),
        (0.0, 10.0, 1920.0, 10.0)
    );
    assert_eq!(stops.len(), 2);
}

#[test]
fn a_frame_keeps_its_paint_as_a_rectangle_behind_its_children() {
    let out = import();
    let SceneObject::Group(card) = find(&out.scene, "1:2") else {
        panic!("a group")
    };
    assert_eq!(
        card.child_ids,
        ["1:2::fill", "1:3"],
        "the paint first, then the children"
    );
    let SceneObject::Rect(paint) = find(&out.scene, "1:2::fill") else {
        panic!()
    };
    assert_eq!(paint.radius, 12.0);
    assert_eq!(paint.base.stroke_width, 2.0);
    let Some(ColorValue::Solid { color }) = &paint.base.fill else {
        panic!()
    };
    assert_eq!(
        color.a, 0.5,
        "the paint's own opacity is folded into its alpha"
    );
    assert_eq!(
        out.scene.objects[0].base().id,
        "1:1::fill",
        "the root's fill is the bottom object"
    );
}

#[test]
fn text_carries_its_words_font_size_spacing_and_case() {
    let out = import();
    let SceneObject::Text(text) = find(&out.scene, "1:3") else {
        panic!("text")
    };
    assert_eq!(text.text, "TEAM TWIS");
    assert_eq!(text.font_id, "inter-semi-bold");
    assert_eq!(text.size, 20.0);
    assert_eq!(text.line_height, Some(1.2));
    assert_eq!(
        text.letter_spacing, 100.0,
        "2 px at 20 px is 100 thousandths of an em"
    );
    assert_eq!(text.align, TextAlign::Center);
    assert_eq!(text.vertical_align, VerticalAlign::Middle);
    assert_eq!(text.text_case, TextCase::Upper);
    assert!(text.base.fill.is_some());
}

#[test]
fn each_family_and_style_is_one_font_declared_missing_never_substituted() {
    let out = import();
    let ids: Vec<_> = out.scene.fonts.iter().map(|f| f.font_id.as_str()).collect();
    assert_eq!(
        ids,
        ["inter-bold", "inter-semi-bold"],
        "Bold is shared by the two texts"
    );
    let bold = &out.scene.fonts[0];
    assert_eq!(bold.status, FontLoadStatus::Missing);
    assert_eq!(
        (bold.faces[0].weight, bold.faces[0].style),
        (700, FontStyle::Normal)
    );
    assert_eq!(out.scene.fonts[1].faces[0].weight, 600);
}

#[test]
fn what_cannot_be_carried_is_named_on_the_node_that_lost_it() {
    let out = import();
    let features = |id: &str| -> Vec<String> {
        out.report
            .entries
            .iter()
            .find(|e| e.source_id == id)
            .unwrap()
            .substitutions
            .iter()
            .map(|s| s.source_feature.clone())
            .collect()
    };
    assert!(
        features("1:2").iter().any(|f| f == "figma:drop shadow"),
        "{:?}",
        features("1:2")
    );
    assert!(features("1:2").iter().any(|f| f.contains("stroke inside")));
    assert!(features("1:4")
        .iter()
        .any(|f| f == "figma:per-corner radii"));
    assert!(
        features("1:5").is_empty(),
        "a plain rectangle loses nothing: {:?}",
        features("1:5")
    );
    assert!(features("1:7").iter().any(|f| f.contains("picture abc123")));
    assert!(features("1:8").iter().any(|f| f.contains("vector outline")));
    assert!(features("1:3")
        .iter()
        .any(|f| f.starts_with("figma:font Inter")));
    assert!(
        features("1:1").iter().any(|f| f.contains("fill")),
        "the root's fill became an object"
    );
    let by = |id: &str| {
        out.report
            .entries
            .iter()
            .find(|e| e.source_id == id)
            .unwrap()
    };
    assert_eq!(by("1:5").tier, ImportTier::Native);
    assert_eq!(by("1:8").tier, ImportTier::Flattened);
    assert_eq!(by("1:2").tier, ImportTier::Container);
    out.report.validate().unwrap();
}

#[test]
fn the_same_frame_gives_the_same_scene_and_source_hash() {
    let (a, b) = (import(), import());
    assert_eq!(a, b);
    assert_eq!(
        a.report.source_hash,
        Some(content_hash(canonical_source(&sample()).as_bytes()))
    );
}

#[test]
fn a_bad_frame_is_refused_before_anything_is_built() {
    let mut too_big = sample();
    too_big.width = 99_999.0;
    assert!(import_figma_frame("f", &too_big, "s").is_err());
    let mut nan = sample();
    nan.children[0].x = f64::NAN;
    assert!(import_figma_frame("f", &nan, "s")
        .unwrap_err()
        .to_string()
        .contains("not a number"));
    let mut deep = frame(json!({ "id": "d:0", "kind": "rectangle", "width": 1, "height": 1 }));
    for i in 1..=70 {
        deep = frame(
            json!({ "id": format!("d:{i}"), "kind": "frame", "width": 1, "height": 1,
                              "children": [serde_json::to_value(&deep).unwrap()] }),
        );
    }
    let root = frame(
        json!({ "id": "r", "kind": "frame", "width": 10, "height": 10,
                              "children": [serde_json::to_value(&deep).unwrap()] }),
    );
    assert!(import_figma_frame("f", &root, "s")
        .unwrap_err()
        .to_string()
        .contains("deeper"));
}

#[test]
fn a_text_node_handed_over_without_its_text_keeps_its_place() {
    let f = frame(
        json!({ "id": "r", "kind": "frame", "width": 100, "height": 100, "children": [
        { "id": "t", "kind": "text", "x": 5, "y": 6, "width": 40, "height": 10 } ] }),
    );
    let out = import_figma_frame("f", &f, "s").unwrap();
    assert!(matches!(find(&out.scene, "t"), SceneObject::Rect(_)));
    let entry = out
        .report
        .entries
        .iter()
        .find(|e| e.source_id == "t")
        .unwrap();
    assert_eq!(entry.tier, ImportTier::Flattened);
}

#[test]
fn a_plain_group_that_loses_nothing_is_native() {
    let f = frame(
        json!({ "id": "r", "kind": "frame", "width": 100, "height": 100, "children": [
        { "id": "g", "kind": "group", "x": 0, "y": 0, "width": 50, "height": 50, "children": [
            { "id": "a", "kind": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10 } ] } ] }),
    );
    let out = import_figma_frame("f", &f, "s").unwrap();
    let entry = out
        .report
        .entries
        .iter()
        .find(|e| e.source_id == "g")
        .unwrap();
    assert_eq!(entry.tier, ImportTier::Native);
    assert!(entry.substitutions.is_empty());
}
