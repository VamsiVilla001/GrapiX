//! A project is a named `.gpx` beside Images, Footage and Fonts (build plan 11.43), and the Figma
//! flow runs inside it: pictures filed as PNG or WebP over MCP, a font dropped in `Fonts/`, then
//! `scenes.ingest_figma` draws both. Driven through the shipped `gx-editor-mcp`.

mod support;

use gx_contracts::ContentHash;
use gx_editor::Projects;
use support::{call, shipped_session};

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-layout-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn png(width: u32, height: u32, filler: u8) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend_from_slice(&[filler; 64]);
    bytes
}

fn code(reply: &serde_json::Value) -> Option<String> {
    reply["error"]["data"]["code"]["refusal"]
        .as_str()
        .map(str::to_owned)
}

#[test]
fn the_figma_flow_runs_inside_a_gpx_project_with_its_pictures_and_fonts() {
    let root = scratch("flow");
    let store = root.join("store");
    let projects = Projects::at_root(&store);
    projects.create_project("PAC").unwrap();
    assert!(
        store.join("PAC").join("PAC.gpx").is_file(),
        "the named .gpx"
    );
    for folder in [
        "Assets/Images",
        "Assets/Videos",
        "Assets/Audio",
        "Assets/Models",
        "Fonts",
    ] {
        assert!(store.join("PAC").join(folder).is_dir(), "{folder}");
    }
    assert!(!store.join("PAC").join("Footage").exists());

    // What the agent downloaded from Figma, and a font the user dropped in Fonts.
    let helmet = root.join("helmet.png");
    std::fs::write(&helmet, png(31, 23, 1)).unwrap();
    let mut font = vec![0x00, 0x01, 0x00, 0x00];
    font.extend_from_slice(&[5; 40]);
    std::fs::write(
        store.join("PAC").join("Fonts").join("NewScience-Bold.ttf"),
        &font,
    )
    .unwrap();

    // One of each other kind, filed over MCP: a video, audio, a 3D model and a web font.
    let mut mp4 = vec![0, 0, 0, 24];
    mp4.extend_from_slice(b"ftypisom");
    mp4.extend_from_slice(&[0; 12]);
    let clip = root.join("intro.mp4");
    std::fs::write(&clip, &mp4).unwrap();
    let sting = root.join("sting.wav");
    std::fs::write(&sting, b"RIFF\x04\0\0\0WAVE").unwrap();
    let trophy = root.join("trophy.glb");
    std::fs::write(&trophy, b"glTF\x02\0\0\0").unwrap();
    let webfont = root.join("Face-Regular.woff2");
    std::fs::write(&webfont, b"wOF2xxxx").unwrap();

    let frame = serde_json::json!({
        "id": "1:1", "kind": "frame", "name": "League", "width": 1920, "height": 1080,
        "children": [
          { "id": "1:2", "kind": "instance", "name": "Helmet", "x": 100, "y": 100, "width": 31, "height": 23,
            "fills": [{ "type": "image", "image": "helmet" }] },
          { "id": "1:3", "kind": "instance", "name": "Logo", "x": 200, "y": 100, "width": 104, "height": 92,
            "fills": [{ "type": "image", "image": "logo" }] },
          { "id": "1:4", "kind": "text", "name": "Title", "x": 80, "y": 300, "width": 600, "height": 40,
            "fills": [{ "type": "solid", "color": { "r": 1, "g": 1, "b": 1 } }],
            "text": { "characters": "LEAGUE", "fontFamily": "New Science", "fontStyle": "Bold", "fontSize": 26 } },
          { "id": "1:5", "kind": "text", "name": "Missing font", "x": 80, "y": 400, "width": 600, "height": 40,
            "text": { "characters": "TOP 5", "fontFamily": "Refrigerator Deluxe", "fontStyle": "Heavy", "fontSize": 72 } }
        ]
    });
    let replies = shipped_session(
        &root.join("store"),
        &[
            call(
                1,
                "assets.import",
                serde_json::json!({ "project": "PAC", "folder": "League", "from": helmet.display().to_string(),
                                    "source": "figma:1674:29177" }),
            ),
            call(
                2,
                "assets.import",
                serde_json::json!({ "project": "PAC", "folder": "League", "from": helmet.display().to_string() }),
            ),
            call(
                4,
                "assets.import",
                serde_json::json!({ "project": "PAC", "folder": "League", "from": clip.display().to_string() }),
            ),
            call(
                5,
                "assets.import",
                serde_json::json!({ "project": "PAC", "folder": "League", "from": sting.display().to_string() }),
            ),
            call(
                6,
                "assets.import",
                serde_json::json!({ "project": "PAC", "folder": "League", "from": trophy.display().to_string() }),
            ),
            call(
                7,
                "assets.import",
                serde_json::json!({ "project": "PAC", "from": webfont.display().to_string() }),
            ),
            call(
                3,
                "scenes.ingest_figma",
                serde_json::json!({ "project": "PAC", "sceneId": "league", "sourceName": "League", "frame": frame }),
            ),
        ],
    );
    assert!(replies[0]["error"].is_null(), "{}", replies[0]);
    let report = &replies[0]["result"]["effects"][0]["report"];
    assert_eq!(report["sourceFormat"], "png");
    assert_eq!(
        report["entries"][0]["sourceName"],
        "Assets/Images/League/helmet.png"
    );
    assert!(
        replies[1]["error"].is_null(),
        "filing the same bytes again is a no-op"
    );
    assert_eq!(
        replies[1]["result"]["effects"][0]["report"]["sourceHash"],
        report["sourceHash"]
    );
    assert!(store
        .join("PAC")
        .join("Assets")
        .join("Images")
        .join("League")
        .join("helmet.png")
        .is_file());

    let filed = |i: usize| {
        replies[i]["result"]["effects"][0]["report"]["entries"][0]["sourceName"]
            .as_str()
            .unwrap_or_else(|| panic!("{}", replies[i]))
            .to_owned()
    };
    assert_eq!(filed(2), "Assets/Videos/League/intro.mp4");
    assert_eq!(filed(3), "Assets/Audio/League/sting.wav");
    assert_eq!(filed(4), "Assets/Models/League/trophy.glb");
    assert_eq!(filed(5), "Fonts/Face-Regular.woff2");
    assert!(store
        .join("PAC")
        .join("Assets")
        .join("Videos")
        .join("League")
        .join("intro.mp4")
        .is_file());

    assert!(replies[6]["error"].is_null(), "{}", replies[6]);
    let stored = projects.read_scene("PAC", "league").expect("stored");
    let kinds: Vec<_> = stored
        .objects
        .iter()
        .map(|o| {
            serde_json::to_value(o).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        kinds,
        ["image", "rect", "text", "text"],
        "the filed picture is an image, the unfiled one a box"
    );
    let helmet_object = serde_json::to_value(&stored.objects[0]).unwrap();
    assert!(helmet_object["assetId"]
        .as_str()
        .unwrap()
        .starts_with("img_"));

    // The picture is in the scene's library with its project path and hash, and readable by it.
    let hash: ContentHash = serde_json::from_value(report["sourceHash"].clone()).unwrap();
    let item = stored
        .assets
        .iter()
        .find(|a| a.checksum.as_ref() == Some(&hash))
        .expect("the scene names the picture");
    assert_eq!(item.path, "Assets/Images/League/helmet.png");
    assert_eq!(
        projects.read_asset("PAC", &hash).unwrap().as_deref(),
        Some(png(31, 23, 1).as_slice()),
        "publish and the viewport read it by content"
    );

    // The font in Fonts is ready; the one that is not there is named and stays missing.
    let status = |id: &str| {
        serde_json::to_value(
            stored
                .fonts
                .iter()
                .find(|f| f.font_id == id)
                .unwrap()
                .status,
        )
        .unwrap()
    };
    assert_eq!(status("new-science-bold"), "Ready");
    assert_eq!(status("refrigerator-deluxe-heavy"), "Missing");

    // The report says which picture is not filed, and where to file it.
    let entries = replies[6]["result"]["effects"][1]["report"]["entries"]
        .as_array()
        .unwrap()
        .clone();
    let logo = entries.iter().find(|e| e["sourceId"] == "1:3").unwrap();
    let reason = logo["substitutions"][0]["reason"].as_str().unwrap();
    assert!(reason.contains("Assets/Images/League/logo"), "{reason}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_file_that_is_not_a_picture_or_would_overwrite_or_is_not_absolute_is_refused() {
    let root = scratch("refusals");
    let store = root.join("store");
    Projects::at_root(&store).create_project("PAC").unwrap();
    let good = root.join("a.png");
    std::fs::write(&good, png(10, 10, 1)).unwrap();
    let other = root.join("other.png");
    std::fs::write(&other, png(10, 10, 2)).unwrap();
    let svg = root.join("logo.svg");
    std::fs::write(&svg, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
    let arg = |from: &std::path::Path, name: Option<&str>| {
        let mut v = serde_json::json!({ "project": "PAC", "folder": "f", "from": from.display().to_string() });
        if let Some(name) = name {
            v["name"] = name.into();
        }
        v
    };
    let replies = shipped_session(
        &store,
        &[
            call(1, "assets.import", arg(&good, None)),
            call(2, "assets.import", arg(&other, Some("a.png"))),
            call(3, "assets.import", arg(&svg, Some("logo.png"))),
            call(
                4,
                "assets.import",
                serde_json::json!({ "project": "PAC", "folder": "f", "from": "relative/a.png" }),
            ),
            call(
                5,
                "assets.import",
                serde_json::json!({ "project": "PAC", "folder": "../x", "from": good.display().to_string() }),
            ),
        ],
    );
    assert!(replies[0]["error"].is_null(), "{}", replies[0]);
    assert_eq!(
        code(&replies[1]).as_deref(),
        Some("assetStoreFailed"),
        "{}",
        replies[1]
    );
    assert_eq!(
        code(&replies[2]).as_deref(),
        Some("assetFormatUnrecognised"),
        "{}",
        replies[2]
    );
    assert_eq!(
        code(&replies[3]).as_deref(),
        Some("assetFormatUnrecognised"),
        "{}",
        replies[3]
    );
    assert!(
        !replies[4]["error"].is_null(),
        "a folder that climbs out is refused"
    );
    assert_eq!(
        std::fs::read(
            store
                .join("PAC")
                .join("Assets")
                .join("Images")
                .join("f")
                .join("a.png")
        )
        .unwrap(),
        png(10, 10, 1),
        "the first picture is untouched"
    );
    assert!(!store.join("PAC").join("x").exists());
    let _ = std::fs::remove_dir_all(root);
}
