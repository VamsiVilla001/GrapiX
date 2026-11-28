//! Where each asset of a project is used (build plan 11.122, the Library panel; Panchayati task 119).
//!
//! One rule, in one place (invariant 27). Until this existed the Editor read every stored scene itself and worked the usage out in
//! TypeScript (`projectAssetUsage` and `assetUsers` in `Editor/src`). This is that rule, ported exactly, and the fixture
//! `Shared/contracts/fixtures/asset-usage.json` is read by this module's tests and by the Editor's, so the two cannot disagree.
//!
//! The rule:
//!  * **The key is the content hash**, and an asset that has none is keyed `id:<assetId>`. The same file in two scenes has two asset ids
//!    but one hash, so the hash is what says it is the same asset.
//!  * **An asset is used by a scene when an object draws it**: an image object's `asset_id`, a mesh's `model_asset_id`, a texture of a
//!    material bound to one of the object's slots, or, for a font file, a text object whose font has a face whose source is that file. An
//!    asset a scene declares and no object draws is not used by that scene.
//!  * **A hidden object still draws.** `visible: false` is a state a designer toggles, and the object keeps needing its file for when it
//!    is shown again; the answer exists so that nobody deletes an asset a graphic still depends on. Images, models and fonts are counted
//!    the same way. (A text *style* that names a font does not draw; it is copied onto a text object when applied, and removing a font
//!    that a style names is refused separately, by `font_edit`.)
//!  * **A scene counts once** for an asset, however many objects draw it, and scenes are listed in the order they were given (the project's
//!    stored order).
//!  * **A scene that could not be read is named** in `problems` and is not counted: an answer that silently left it out would say "unused".
//!
//! The direct references are an exhaustive `match` over the object kinds, so a new kind of object cannot be added without deciding here
//! whether it draws an asset.
//!
//! Fonts are counted here and were not by the Editor's old client rule (it never followed a text object's font id to a face and its
//! file), so a font file the Library listed was always tagged unused even when text drew with it. The shared fixture therefore holds no
//! font: the client is compared on the cases it covered, and the font cases are tested here, in Rust only.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::font::FontSource;
use crate::scene::{AssetLibraryItem, SceneDocument, SceneObject};

/// A scene that uses an asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SceneUse {
    /// The scene's id in the project store (the file's name), not the document's own `id`.
    pub scene_id: String,
    /// The scene's name, as its document gives it.
    pub name: String,
}

/// What uses one asset, by usage key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetUsageEntry {
    /// The content hash, or `id:<assetId>` for an asset that has none ([`usage_key`]).
    pub key: String,
    /// Every asset id that has this key, in the order they were first met: the project library's first, then each scene's.
    pub asset_ids: Vec<String>,
    /// The scenes that draw it, in the order the scenes were given, once each. Empty means nothing uses it: an answer, not a gap.
    pub scenes: Vec<SceneUse>,
}

/// A stored scene whose usage could not be counted, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageProblem {
    pub scene_id: String,
    pub reason: String,
}

/// The usage of every asset the project's library or any of its scenes declares.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetUsageReport {
    pub entries: Vec<AssetUsageEntry>,
    pub problems: Vec<UsageProblem>,
}

/// The key an asset's usage is kept under: its content hash, else `id:<assetId>`. Identical to `usageKey` in `Editor/src/library.ts`.
pub fn usage_key(asset: &AssetLibraryItem) -> String {
    match &asset.checksum {
        Some(hash) => hash.0.clone(),
        None => format!("id:{}", asset.asset_id),
    }
}

/// Whether an object names the asset itself: an image's asset, or a mesh's model. The match has no wildcard: a new kind of object is
/// put on one side or the other here before this compiles.
fn names_asset(object: &SceneObject, asset_id: &str) -> bool {
    match object {
        SceneObject::Image(image) => image.asset_id == asset_id,
        SceneObject::Mesh(mesh) => mesh.model_asset_id.as_deref() == Some(asset_id),
        SceneObject::Text(_)
        | SceneObject::Rect(_)
        | SceneObject::Ellipse(_)
        | SceneObject::Line(_)
        | SceneObject::Shape(_)
        | SceneObject::Paint(_)
        | SceneObject::Light(_)
        | SceneObject::Camera(_)
        | SceneObject::Layer(_)
        | SceneObject::Marker(_)
        | SceneObject::Group(_) => false,
    }
}

/// Whether a material bound to one of the object's slots has a texture from the asset.
fn textured_by(document: &SceneDocument, object: &SceneObject, asset_id: &str) -> bool {
    let Some(slots) = &object.base().material_slots else {
        return false;
    };
    document.materials.iter().any(|material| {
        slots
            .values()
            .any(|binding| binding.material_id == material.material_id)
            && material
                .textures
                .iter()
                .any(|texture| texture.asset_id == asset_id)
    })
}

/// Whether a text object's font has a face whose bytes are this asset's file. A text object reaches a font file through a font id, the
/// scene's font with that id, and that font's faces: the same chain `font_edit` follows to refuse removing a font in use.
fn lettered_by(document: &SceneDocument, object: &SceneObject, asset_id: &str) -> bool {
    let SceneObject::Text(text) = object else {
        return false;
    };
    document
        .font(&text.font_id)
        .is_some_and(|font| font.faces.iter().any(|face| matches!(&face.source, FontSource::File { asset_id: file, .. } if file == asset_id)))
}

/// The ids of the objects in a scene that draw an asset, in document order. The same as `assetUsers` in `Editor/src/asset-manager.ts`
/// for images, models and textures, and it also follows a text object to its font's files (which that function never did).
pub fn objects_drawing<'a>(document: &'a SceneDocument, asset_id: &str) -> Vec<&'a str> {
    document
        .objects
        .iter()
        .filter(|object| {
            names_asset(object, asset_id)
                || textured_by(document, object, asset_id)
                || lettered_by(document, object, asset_id)
        })
        .map(|object| object.base().id.as_str())
        .collect()
}

/// The usage of every asset the project's library or its scenes declare.
///
/// `scenes` are the project's stored scenes in their stored order: each a scene id and the document read from it, or why it could not be
/// read. Entries come in the order their keys were first met (the library, then each scene's declarations), so the answer is the same for
/// the same project every time.
pub fn project_asset_usage(
    project_assets: &[AssetLibraryItem],
    scenes: Vec<(String, Result<SceneDocument, String>)>,
) -> AssetUsageReport {
    let mut report = AssetUsageReport::default();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut entry_for = |report: &mut AssetUsageReport, asset: &AssetLibraryItem| -> usize {
        let key = usage_key(asset);
        let at = *index.entry(key.clone()).or_insert_with(|| {
            report.entries.push(AssetUsageEntry {
                key,
                asset_ids: Vec::new(),
                scenes: Vec::new(),
            });
            report.entries.len() - 1
        });
        if !report.entries[at].asset_ids.contains(&asset.asset_id) {
            report.entries[at].asset_ids.push(asset.asset_id.clone());
        }
        at
    };

    for asset in project_assets {
        entry_for(&mut report, asset);
    }
    for (scene_id, read) in scenes {
        match read {
            Err(reason) => report.problems.push(UsageProblem { scene_id, reason }),
            Ok(document) => {
                for asset in &document.assets {
                    let at = entry_for(&mut report, asset);
                    let drawn = !objects_drawing(&document, &asset.asset_id).is_empty();
                    if drawn
                        && !report.entries[at]
                            .scenes
                            .iter()
                            .any(|scene| scene.scene_id == scene_id)
                    {
                        report.entries[at].scenes.push(SceneUse {
                            scene_id: scene_id.clone(),
                            name: document.name.clone(),
                        });
                    }
                }
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::WorkingColorSpace;
    use crate::scene::new_scene;
    use serde_json::json;

    const HASH_LOGO: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const HASH_MODEL: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const HASH_TEXTURE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
    const HASH_SPARE: &str = "4444444444444444444444444444444444444444444444444444444444444444";

    fn asset(id: &str, kind: &str, checksum: Option<&str>) -> AssetLibraryItem {
        let mut value =
            json!({ "assetId": id, "name": id, "kind": kind, "path": format!("assets/{id}") });
        if let Some(hash) = checksum {
            value["checksum"] = json!(hash);
        }
        serde_json::from_value(value).expect("an asset library item")
    }

    fn image(id: &str, asset_id: &str) -> SceneObject {
        serde_json::from_value(
            json!({ "type": "image", "id": id, "name": id, "assetId": asset_id }),
        )
        .expect("an image object")
    }

    fn mesh(id: &str, model: &str, slots: Option<serde_json::Value>) -> SceneObject {
        let mut value = json!({ "type": "mesh", "id": id, "name": id, "meshKind": "model", "depth": 10.0, "modelAssetId": model });
        if let Some(slots) = slots {
            value["materialSlots"] = slots;
        }
        serde_json::from_value(value).expect("a mesh object")
    }

    fn rect_with_material(id: &str, material: &str) -> SceneObject {
        serde_json::from_value(json!({ "type": "rect", "id": id, "name": id, "materialSlots": { "face": { "materialId": material } } }))
            .expect("a rect with a material")
    }

    fn material(id: &str, texture_asset: &str) -> crate::material::MaterialDefinition {
        serde_json::from_value(json!({
            "materialId": id, "name": id,
            "textures": [{ "slot": "baseColor", "assetId": texture_asset, "colorSpace": "srgb" }],
        }))
        .expect("a material with a texture")
    }

    fn scene(id: &str, name: &str) -> SceneDocument {
        new_scene(id, name, WorkingColorSpace::LinearSrgb)
    }

    #[test]
    fn the_key_is_the_content_hash_and_an_asset_without_one_is_keyed_by_its_id() {
        assert_eq!(usage_key(&asset("a1", "image", Some(HASH_LOGO))), HASH_LOGO);
        assert_eq!(usage_key(&asset("a1", "image", None)), "id:a1");
    }

    #[test]
    fn an_object_draws_an_asset_as_an_image_a_model_or_the_texture_of_a_bound_material() {
        let mut doc = scene("s", "S");
        doc.assets = vec![
            asset("logo", "image", Some(HASH_LOGO)),
            asset("model", "model", Some(HASH_MODEL)),
            asset("tex", "image", Some(HASH_TEXTURE)),
            asset("spare", "image", Some(HASH_SPARE)),
        ];
        doc.materials = vec![material("m1", "tex"), material("m2", "spare")];
        doc.objects = vec![
            image("img", "logo"),
            mesh("box", "model", None),
            rect_with_material("panel", "m1"),
        ];
        assert_eq!(objects_drawing(&doc, "logo"), ["img"]);
        assert_eq!(objects_drawing(&doc, "model"), ["box"]);
        assert_eq!(
            objects_drawing(&doc, "tex"),
            ["panel"],
            "a texture of a material bound to the object"
        );
        assert!(
            objects_drawing(&doc, "spare").is_empty(),
            "m2 is declared and no object is bound to it"
        );
        assert!(objects_drawing(&doc, "nothing").is_empty());
    }

    #[test]
    fn a_material_binds_through_any_slot_and_a_mesh_can_have_both_a_model_and_a_textured_material()
    {
        let mut doc = scene("s", "S");
        doc.assets = vec![
            asset("model", "model", Some(HASH_MODEL)),
            asset("tex", "image", Some(HASH_TEXTURE)),
        ];
        doc.materials = vec![material("m1", "tex")];
        doc.objects = vec![mesh(
            "box",
            "model",
            Some(json!({ "side": { "materialId": "m1" }, "front": { "materialId": "nope" } })),
        )];
        assert_eq!(objects_drawing(&doc, "model"), ["box"]);
        assert_eq!(objects_drawing(&doc, "tex"), ["box"]);
    }

    fn two_scenes() -> (
        Vec<AssetLibraryItem>,
        Vec<(String, Result<SceneDocument, String>)>,
    ) {
        // Scene "a" and scene "b" both import the same logo file: two asset ids, one hash. "b" draws it twice. "a" also declares a spare
        // that nothing draws, and a model and a textured material.
        let mut a = scene("a", "Alpha");
        a.assets = vec![
            asset("logo-a", "image", Some(HASH_LOGO)),
            asset("spare", "image", Some(HASH_SPARE)),
            asset("model", "model", Some(HASH_MODEL)),
            asset("tex", "image", Some(HASH_TEXTURE)),
        ];
        a.materials = vec![material("m1", "tex")];
        a.objects = vec![
            image("logo", "logo-a"),
            mesh("box", "model", None),
            rect_with_material("panel", "m1"),
        ];
        let mut b = scene("b", "Bravo");
        b.assets = vec![asset("logo-b", "image", Some(HASH_LOGO))];
        b.objects = vec![image("first", "logo-b"), image("second", "logo-b")];
        let library = vec![
            asset("lib-logo", "image", Some(HASH_LOGO)),
            asset("lib-unused", "image", None),
        ];
        (library, vec![("a".into(), Ok(a)), ("b".into(), Ok(b))])
    }

    fn entry<'a>(report: &'a AssetUsageReport, key: &str) -> &'a AssetUsageEntry {
        report
            .entries
            .iter()
            .find(|entry| entry.key == key)
            .unwrap_or_else(|| panic!("no entry {key}: {report:?}"))
    }

    fn scene_ids(entry: &AssetUsageEntry) -> Vec<&str> {
        entry
            .scenes
            .iter()
            .map(|scene| scene.scene_id.as_str())
            .collect()
    }

    #[test]
    fn a_file_shared_by_two_scenes_is_one_entry_listing_each_scene_once_in_the_order_given() {
        let (library, scenes) = two_scenes();
        let report = project_asset_usage(&library, scenes);
        let logo = entry(&report, HASH_LOGO);
        assert_eq!(
            scene_ids(logo),
            ["a", "b"],
            "b draws it twice and counts once"
        );
        assert_eq!(logo.scenes[1].name, "Bravo");
        assert_eq!(
            logo.asset_ids,
            ["lib-logo", "logo-a", "logo-b"],
            "the library's id first, then each scene's in order"
        );
        assert_eq!(report.problems, []);
    }

    #[test]
    fn a_scene_order_is_the_order_the_scenes_were_given() {
        let (library, mut scenes) = two_scenes();
        scenes.reverse();
        let report = project_asset_usage(&library, scenes);
        assert_eq!(scene_ids(entry(&report, HASH_LOGO)), ["b", "a"]);
    }

    #[test]
    fn nothing_using_an_asset_is_an_empty_list_not_a_missing_entry() {
        let (library, scenes) = two_scenes();
        let report = project_asset_usage(&library, scenes);
        assert!(
            entry(&report, "id:lib-unused").scenes.is_empty(),
            "a library asset no scene declares"
        );
        assert!(
            entry(&report, HASH_SPARE).scenes.is_empty(),
            "declared by scene a, drawn by no object"
        );
    }

    #[test]
    fn a_model_and_a_bound_material_texture_count_for_their_scene() {
        let (library, scenes) = two_scenes();
        let report = project_asset_usage(&library, scenes);
        assert_eq!(scene_ids(entry(&report, HASH_MODEL)), ["a"]);
        assert_eq!(scene_ids(entry(&report, HASH_TEXTURE)), ["a"]);
    }

    #[test]
    fn a_scene_that_could_not_be_read_is_named_and_not_counted_while_the_others_still_are() {
        let (library, mut scenes) = two_scenes();
        scenes.insert(
            1,
            (
                "broken".into(),
                Err("the scene file is not valid JSON".into()),
            ),
        );
        let report = project_asset_usage(&library, scenes);
        assert_eq!(
            report.problems,
            [UsageProblem {
                scene_id: "broken".into(),
                reason: "the scene file is not valid JSON".into()
            }]
        );
        assert_eq!(scene_ids(entry(&report, HASH_LOGO)), ["a", "b"]);
    }

    #[test]
    fn the_same_project_always_gives_the_same_report() {
        let (library, scenes) = two_scenes();
        let first = project_asset_usage(&library, scenes);
        let (library, scenes) = two_scenes();
        assert_eq!(first, project_asset_usage(&library, scenes));
    }

    /// The fixture the Editor's tests read too (`Editor/tests/asset-usage-parity.test.ts`): a project with a hash-shared asset across two
    /// scenes, an unused asset, a mesh model asset and a bound-material texture, the report this module gives for it, and which objects
    /// draw each declared asset. The client rule (`projectAssetUsage`, `assetUsers`) must give the same, so the two cannot drift.
    #[test]
    fn the_shared_fixture_holds_the_rule() {
        let (library, scenes) = two_scenes();
        let documents: Vec<(String, SceneDocument)> = scenes
            .iter()
            .map(|(id, read)| (id.clone(), read.as_ref().expect("a readable scene").clone()))
            .collect();
        let report = project_asset_usage(&library, scenes);
        let mut drawing = Vec::new();
        for (scene_id, document) in &documents {
            for asset in &document.assets {
                drawing.push(json!({ "sceneId": scene_id, "assetId": asset.asset_id, "objects": objects_drawing(document, &asset.asset_id) }));
            }
        }
        let current = json!({
            "note": "Read by Shared/contracts/src/asset_usage.rs and by Editor/tests/asset-usage-parity.test.ts. Rewrite with GX_WRITE_FIXTURES=1. Fonts are NOT in this fixture: the Editor's old client rule never counted a font file as used by text, so the client is compared on the cases it covered (images, models, bound-material textures) and the font cases are tested in Rust only.",
            "projectAssets": library,
            "scenes": documents.iter().map(|(id, document)| json!({ "sceneId": id, "document": document })).collect::<Vec<_>>(),
            "expected": report,
            "objectsDrawing": drawing,
        });
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/asset-usage.json");
        if std::env::var("GX_WRITE_FIXTURES").is_ok() {
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&current).unwrap() + "\n",
            )
            .unwrap();
        }
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("the fixture is there"))
                .expect("the fixture is JSON");
        assert_eq!(
            stored, current,
            "run with GX_WRITE_FIXTURES=1 to rewrite fixtures/asset-usage.json"
        );

        // And the rule reads its own fixture the way a page would: documents and library as JSON in, the report as JSON out.
        let scenes: Vec<(String, Result<SceneDocument, String>)> = stored["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|scene| {
                (
                    scene["sceneId"].as_str().unwrap().to_owned(),
                    Ok(serde_json::from_value(scene["document"].clone())
                        .expect("a scene document")),
                )
            })
            .collect();
        let library: Vec<AssetLibraryItem> =
            serde_json::from_value(stored["projectAssets"].clone()).expect("the library");
        assert_eq!(
            serde_json::to_value(project_asset_usage(&library, scenes)).unwrap(),
            stored["expected"]
        );
    }

    fn face(face_id: &str, source: serde_json::Value) -> serde_json::Value {
        json!({ "faceId": face_id, "family": "Inter", "weight": 400, "style": "normal", "source": source })
    }

    fn file_face(face_id: &str, asset_id: &str) -> serde_json::Value {
        face(
            face_id,
            json!({ "kind": "file", "assetId": asset_id, "format": "woff2" }),
        )
    }

    fn font(font_id: &str, faces: Vec<serde_json::Value>) -> crate::font::FontDefinition {
        serde_json::from_value(json!({
            "fontId": font_id, "family": "Inter", "displayName": font_id, "faces": faces,
            "fallbackFamilies": [], "embeddingPolicy": "package", "status": "Ready",
        }))
        .expect("a font definition")
    }

    fn text(id: &str, font_id: &str, visible: bool) -> SceneObject {
        serde_json::from_value(json!({ "type": "text", "id": id, "name": id, "text": "Hello", "fontId": font_id, "size": 40.0, "visible": visible }))
            .expect("a text object")
    }

    #[test]
    fn a_font_file_is_used_by_a_scene_whose_text_names_a_font_with_a_face_from_it() {
        let mut doc = scene("a", "Alpha");
        doc.assets = vec![
            asset("inter-regular", "font", Some(HASH_LOGO)),
            asset("inter-bold", "font", Some(HASH_MODEL)),
            asset("spare-font", "font", Some(HASH_SPARE)),
        ];
        doc.fonts = vec![
            font(
                "inter",
                vec![
                    file_face("regular", "inter-regular"),
                    file_face("bold", "inter-bold"),
                ],
            ),
            font("spare", vec![file_face("regular", "spare-font")]),
        ];
        doc.objects = vec![text("title", "inter", true)];
        let report = project_asset_usage(&[], vec![("a".into(), Ok(doc.clone()))]);
        assert_eq!(
            scene_ids(entry(&report, HASH_LOGO)),
            ["a"],
            "a face of the font the text names"
        );
        assert_eq!(
            scene_ids(entry(&report, HASH_MODEL)),
            ["a"],
            "every face of that font: the font is loaded whole"
        );
        assert!(
            entry(&report, HASH_SPARE).scenes.is_empty(),
            "a font declared and named by no text object is unused"
        );
        assert_eq!(objects_drawing(&doc, "inter-regular"), ["title"]);
        assert!(objects_drawing(&doc, "spare-font").is_empty());
    }

    #[test]
    fn a_hidden_object_still_draws_text_images_and_fonts_alike() {
        // `visible: false` is a state, not a deletion: the object needs its file when it is shown again, and the answer exists so that
        // nobody removes an asset a graphic still depends on. Images are counted this way by the client rule too.
        let mut doc = scene("a", "Alpha");
        doc.assets = vec![
            asset("face", "font", Some(HASH_LOGO)),
            asset("logo", "image", Some(HASH_MODEL)),
        ];
        doc.fonts = vec![font("inter", vec![file_face("regular", "face")])];
        let mut hidden_image = serde_json::to_value(image("pic", "logo")).unwrap();
        hidden_image["visible"] = json!(false);
        doc.objects = vec![
            text("title", "inter", false),
            serde_json::from_value(hidden_image).unwrap(),
        ];
        let report = project_asset_usage(&[], vec![("a".into(), Ok(doc))]);
        assert_eq!(
            scene_ids(entry(&report, HASH_LOGO)),
            ["a"],
            "a hidden text object keeps its font file in use"
        );
        assert_eq!(
            scene_ids(entry(&report, HASH_MODEL)),
            ["a"],
            "a hidden image keeps its file in use"
        );
    }

    #[test]
    fn a_face_from_a_stylesheet_or_an_unknown_font_id_counts_no_file_and_does_not_fail() {
        let mut doc = scene("a", "Alpha");
        doc.assets = vec![asset("some-file", "font", Some(HASH_LOGO))];
        doc.fonts = vec![font(
            "web",
            vec![face(
                "regular",
                json!({ "kind": "cssUrl", "url": "https://fonts.example/css?family=Inter" }),
            )],
        )];
        doc.objects = vec![
            text("title", "web", true),
            text("ghost", "no-such-font", true),
        ];
        let report = project_asset_usage(&[], vec![("a".into(), Ok(doc))]);
        assert!(
            entry(&report, HASH_LOGO).scenes.is_empty(),
            "no text names a font with a face from this file"
        );
    }

    #[test]
    fn a_font_file_in_two_scenes_counts_each_scene_once_in_order() {
        let build = |id: &str, name: &str, asset_id: &str| {
            let mut doc = scene(id, name);
            doc.assets = vec![asset(asset_id, "font", Some(HASH_LOGO))];
            doc.fonts = vec![font("inter", vec![file_face("regular", asset_id)])];
            doc.objects = vec![text("one", "inter", true), text("two", "inter", true)];
            doc
        };
        let report = project_asset_usage(
            &[],
            vec![
                ("a".into(), Ok(build("a", "Alpha", "inter-a"))),
                ("b".into(), Ok(build("b", "Bravo", "inter-b"))),
            ],
        );
        let inter = entry(&report, HASH_LOGO);
        assert_eq!(
            scene_ids(inter),
            ["a", "b"],
            "two text objects in a scene count the scene once"
        );
        assert_eq!(inter.asset_ids, ["inter-a", "inter-b"]);
    }

    #[test]
    fn a_scene_that_imported_the_same_file_twice_counts_once() {
        // Two asset ids, one hash, both drawn in one scene: the same asset, used by one scene.
        let mut doc = scene("a", "Alpha");
        doc.assets = vec![
            asset("logo-1", "image", Some(HASH_LOGO)),
            asset("logo-2", "image", Some(HASH_LOGO)),
        ];
        doc.objects = vec![image("one", "logo-1"), image("two", "logo-2")];
        let report = project_asset_usage(&[], vec![("a".into(), Ok(doc))]);
        assert_eq!(report.entries.len(), 1);
        assert_eq!(
            scene_ids(&report.entries[0]),
            ["a"],
            "counted once, not once per asset id"
        );
        assert_eq!(report.entries[0].asset_ids, ["logo-1", "logo-2"]);
    }

    #[test]
    fn the_library_and_a_scene_naming_one_asset_the_same_way_list_its_id_once() {
        // The common case: the scene's declaration is a copy of the library's, with the same id and the same hash.
        let mut doc = scene("a", "Alpha");
        doc.assets = vec![asset("logo", "image", Some(HASH_LOGO))];
        doc.objects = vec![image("img", "logo")];
        let report = project_asset_usage(
            &[asset("logo", "image", Some(HASH_LOGO))],
            vec![("a".into(), Ok(doc))],
        );
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].asset_ids, ["logo"], "one id, once");
    }

    #[test]
    fn a_scene_is_named_by_its_id_in_the_store_not_by_the_id_inside_its_document() {
        let mut doc = scene("id-inside-the-document", "Alpha");
        doc.assets = vec![asset("logo", "image", Some(HASH_LOGO))];
        doc.objects = vec![image("img", "logo")];
        let report = project_asset_usage(&[], vec![("id-in-the-store".into(), Ok(doc))]);
        assert_eq!(scene_ids(&report.entries[0]), ["id-in-the-store"]);
    }

    #[test]
    fn an_asset_without_a_hash_is_kept_apart_by_id_across_scenes() {
        let mut a = scene("a", "A");
        a.assets = vec![asset("one", "image", None)];
        a.objects = vec![image("i", "one")];
        let mut b = scene("b", "B");
        b.assets = vec![asset("one", "image", None), asset("two", "image", None)];
        b.objects = vec![image("i", "one"), image("j", "two")];
        let report = project_asset_usage(&[], vec![("a".into(), Ok(a)), ("b".into(), Ok(b))]);
        assert_eq!(
            scene_ids(entry(&report, "id:one")),
            ["a", "b"],
            "the same id and no hash is the same key"
        );
        assert_eq!(scene_ids(entry(&report, "id:two")), ["b"]);
    }
}
