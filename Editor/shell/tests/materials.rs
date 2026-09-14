//! The material library over the shell's own surface (11.12).
//!
//! These drive the functions the Tauri commands are one-line wrappers around,
//! so what the panel calls is what is exercised here. Two things they exist to
//! hold:
//!
//! - **The Editor authors the vocabulary, not one peer's capability.** A blend
//!   mode the Editor's own preview cannot composite must still be authorable,
//!   because what a device can draw is that device's declaration to make
//!   (invariant 21). The Editor refuses only what is wrong in every engine.
//! - **An asset path is the library address and is treated as hostile.** It
//!   arrives from a document, so a `..` component must be refused by name
//!   rather than read from outside the project.

use gx_contracts::material::{MaterialDefinition, MaterialKind};
use gx_contracts::scene::{parse_scene_document, SceneDocument};
use gx_editor::project::Projects;
use gx_editor_shell::{
    asset_source, material_assign, material_create, material_delete, material_duplicate,
    material_relink, material_update,
};

fn scene() -> SceneDocument {
    parse_scene_document(
        br#"{"id":"materials","name":"Materials","version":1,
             "canvas":{"width":1920,"height":1080,"frameRate":{"num":50,"den":1}},
             "timeline":{"durationFrames":100},"dataContext":{},
             "assets":[
               {"assetId":"logo","name":"Logo","kind":"image","path":"assets/logo.png"},
               {"assetId":"clip","name":"Clip","kind":"video","path":"assets/clip.mp4"}],
             "fonts":[],"materials":[],
             "objects":[
               {"type":"rect","id":"bar","name":"Bar","width":100,"height":50,"radius":0},
               {"type":"rect","id":"strap","name":"Strap","width":100,"height":50,"radius":0}]}"#,
    )
    .expect("the fixture scene parses through the closed reader")
}

fn material<'a>(scene: &'a SceneDocument, id: &str) -> &'a MaterialDefinition {
    scene
        .materials
        .iter()
        .find(|material| material.material_id == id)
        .expect("the material is in the library")
}

#[test]
fn a_two_d_and_a_three_d_material_are_created_bound_and_shared() {
    let scene = scene();

    // A 2D solid colour needs nothing but a name.
    let created = material_create(scene, MaterialKind::SolidColor, "Bar fill", None)
        .expect("a solid colour can be created from nothing");
    let flat = created.material_id.clone();
    assert!(material(&created.scene, &flat).lighting.is_none());

    // A 3D material arrives with a real lighting block rather than an empty
    // section governed by defaults the author cannot read.
    let created = material_create(created.scene, MaterialKind::Pbr, "Chrome", None)
        .expect("a lit material can be created from nothing");
    let lit = created.material_id.clone();
    let lighting = material(&created.scene, &lit)
        .lighting
        .as_ref()
        .expect("a 3D material carries lighting");
    assert_eq!(lighting.roughness, 0.5);

    // A video material needs a clip, and says so by name.
    let refused = material_create(created.scene.clone(), MaterialKind::Video, "Wall", None)
        .expect_err("a video material cannot be completed from nothing");
    assert!(
        refused.to_string().contains("video asset"),
        "the refusal must name what the kind needs, got: {refused}"
    );

    let created = material_create(created.scene, MaterialKind::Video, "Wall", Some("clip"))
        .expect("a clip completes it");
    let wall = created.material_id.clone();
    let texture = &material(&created.scene, &wall).textures[0];
    assert_eq!(texture.slot, "baseColor");
    assert_eq!(texture.asset_id, "clip");

    // Binding the same material to two objects makes it shared, and the
    // delete then refuses with the count rather than restyling both.
    let scene = material_assign(created.scene, "bar", "fill", &flat).expect("bar takes it");
    let scene = material_assign(scene, "strap", "fill", &flat).expect("strap takes it");
    let refused = material_delete(scene.clone(), &flat).expect_err("two objects still bind it");
    assert!(
        refused.to_string().contains("used by 2"),
        "the refusal must carry the user count, got: {refused}"
    );

    // Duplicating is how one object diverges from a shared material.
    let copied = material_duplicate(scene, &flat).expect("the source exists");
    let copy = copied.material_id.clone();
    assert_eq!(material(&copied.scene, &copy).name, "Bar fill copy");

    // Relinking reports the objects it moved, by name, and then the original
    // is free to delete — which is the whole point of showing the radius.
    let relinked = material_relink(copied.scene, &flat, &copy).expect("both exist");
    assert_eq!(relinked.changed_object_ids, ["bar", "strap"]);
    let scene = material_delete(relinked.scene, &flat).expect("nothing binds it now");
    assert!(scene.materials.iter().all(|m| m.material_id != flat));
}

#[test]
fn the_editor_authors_the_vocabulary_and_refuses_only_what_is_wrong_everywhere() {
    let created = material_create(scene(), MaterialKind::Unlit, "Fill", None).unwrap();
    let id = created.material_id.clone();
    let scene = created.scene;

    // `overlay` is not fixed-function, so the Editor's own preview cannot
    // composite it — and it is still authorable, because whether the engine
    // that will render this can draw it is that engine's declaration to make.
    let overlay = MaterialDefinition {
        blend_mode: gx_contracts::material::BlendMode::Overlay,
        ..material(&scene, &id).clone()
    };
    let scene = material_update(scene, overlay).expect("the authoring surface is the vocabulary");
    assert_eq!(
        material(&scene, &id).blend_mode,
        gx_contracts::material::BlendMode::Overlay
    );

    // What it does refuse is what no engine could honour: an opacity outside
    // its unit range, and a texture bound to an asset with no texels.
    let broken = MaterialDefinition {
        opacity: 1.4,
        ..material(&scene, &id).clone()
    };
    let refused = material_update(scene.clone(), broken).expect_err("1.4 is not an opacity");
    assert!(
        refused.to_string().contains("opacity"),
        "the refusal must name the field, got: {refused}"
    );
    // A refused edit changes nothing.
    assert_eq!(material(&scene, &id).opacity, 1.0);

    let dangling = MaterialDefinition {
        textures: vec![gx_contracts::material::MaterialTextureSlot {
            slot: "baseColor".into(),
            asset_id: "not-in-the-library".into(),
            fit: Default::default(),
            wrap: Default::default(),
            filtering: Default::default(),
            color_space: gx_contracts::color::SourceColorSpace::Srgb,
        }],
        ..material(&scene, &id).clone()
    };
    assert!(material_update(scene, dangling).is_err());
}

#[test]
fn asset_bytes_reach_the_preview_and_a_traversal_does_not() {
    let root = std::env::temp_dir().join(format!("gx-material-assets-{}", std::process::id()));
    let projects = Projects::at_root(&root);
    projects.create_project("demo").expect("a project directory");
    let assets = root.join("demo").join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    // A one-pixel PNG: real bytes, so the data URL is a real one.
    let png: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    std::fs::write(assets.join("logo.png"), png).unwrap();

    let source = asset_source(&projects, "demo", "logo", "assets/logo.png", None)
        .expect("the bytes are readable");
    assert_eq!(source.media_type, "image/png");
    assert_eq!(source.size_bytes, 8);
    assert_eq!(source.data_url, "data:image/png;base64,iVBORw0KGgo=");

    // The library's declared type wins over the extension, because that is
    // what the import recorded.
    let declared = asset_source(
        &projects,
        "demo",
        "logo",
        "assets/logo.png",
        Some("image/webp"),
    )
    .expect("the bytes are readable");
    assert!(declared.data_url.starts_with("data:image/webp;base64,"));

    // The path arrives from a document, so it is hostile until checked.
    for hostile in ["../../secrets.png", "/etc/passwd", "assets/../../escape.png"] {
        assert!(
            asset_source(&projects, "demo", "logo", hostile, None).is_err(),
            "{hostile} must be refused rather than read"
        );
    }

    std::fs::remove_dir_all(&root).ok();
}
