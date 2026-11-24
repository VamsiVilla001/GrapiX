use super::*;

fn scratch(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-assets-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn png(width: u32, height: u32, filler: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend(std::iter::repeat_n(7u8, filler));
    bytes
}

fn riff(form: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(4 + body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(form);
    bytes.extend_from_slice(body);
    bytes
}

fn webp(width: u32, height: u32) -> Vec<u8> {
    let mut chunk = b"VP8L".to_vec();
    chunk.extend_from_slice(&5u32.to_le_bytes());
    chunk.push(0x2f);
    chunk.extend_from_slice(&((width - 1) | ((height - 1) << 14)).to_le_bytes());
    riff(b"WEBP", &chunk)
}

fn jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    bytes.extend_from_slice(b"JFIF\0");
    bytes.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
    bytes.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 8]);
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    bytes
}

fn mp4(brand: &[u8; 4]) -> Vec<u8> {
    let mut bytes = vec![0, 0, 0, 24];
    bytes.extend_from_slice(b"ftyp");
    bytes.extend_from_slice(brand);
    bytes.extend_from_slice(&[0; 12]);
    bytes
}

fn webm() -> Vec<u8> {
    let mut bytes = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84];
    bytes.extend_from_slice(b"webm");
    bytes.extend_from_slice(&[0; 20]);
    bytes
}

fn stl_binary() -> Vec<u8> {
    let mut bytes = vec![0u8; 80];
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 50]);
    bytes
}

fn ttf(tag: u8) -> Vec<u8> {
    let mut bytes = vec![0x00, 0x01, 0x00, 0x00];
    bytes.extend_from_slice(&[tag; 32]);
    bytes
}

fn d(bytes: &[u8], ext: &str) -> Option<Detected> {
    detect(bytes, bytes.len() as u64, ext)
}

/// The class, extensions and size a file is detected as.
type Seen = (AssetClass, Vec<&'static str>, Option<(u32, u32)>);

fn what(bytes: &[u8], ext: &str) -> Option<Seen> {
    d(bytes, ext).map(|x| {
        let size = x.width.zip(x.height);
        (x.class, x.extensions.to_vec(), size)
    })
}

#[test]
fn every_format_is_known_by_its_bytes() {
    use AssetClass::*;
    // Pictures.
    assert_eq!(
        what(&png(52, 40, 0), "png"),
        Some((Image, vec!["png"], Some((52, 40))))
    );
    assert_eq!(
        what(&webp(1920, 1080), "webp"),
        Some((Image, vec!["webp"], Some((1920, 1080))))
    );
    assert_eq!(
        what(&jpeg(640, 480), "jpg"),
        Some((Image, vec!["jpg", "jpeg"], Some((640, 480))))
    );
    let svg = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="104px" height="92"/>"#;
    assert_eq!(
        what(svg, "svg"),
        Some((Image, vec!["svg"], Some((104, 92))))
    );
    let boxed = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 13 20"></svg>"#;
    assert_eq!(
        what(boxed, "svg"),
        Some((Image, vec!["svg"], Some((13, 20))))
    );
    assert_eq!(
        what(b"<svg xmlns='http://www.w3.org/2000/svg'/>", "svg"),
        Some((Image, vec!["svg"], None)),
        "an SVG with no declared size is still an SVG"
    );
    // Video.
    assert_eq!(what(&mp4(b"isom"), "mp4").map(|w| w.0), Some(Video));
    assert_eq!(
        what(&mp4(b"qt  "), "mov").map(|w| w.1),
        Some(vec!["mp4", "mov"])
    );
    assert_eq!(d(&mp4(b"qt  "), "mov").unwrap().mime, "video/quicktime");
    assert_eq!(d(&mp4(b"isom"), "mp4").unwrap().mime, "video/mp4");
    assert_eq!(
        what(&riff(b"AVI ", b"LIST\0\0\0\0"), "avi"),
        Some((Video, vec!["avi"], None))
    );
    assert_eq!(what(&webm(), "webm"), Some((Video, vec!["webm"], None)));
    // Audio.
    assert_eq!(
        what(&riff(b"WAVE", b"fmt \x10\0\0\0"), "wav"),
        Some((Audio, vec!["wav"], None))
    );
    assert_eq!(
        what(b"ID3\x03\x00\x00\x00\x00\x00\x00", "mp3").map(|w| w.0),
        Some(Audio)
    );
    assert_eq!(
        what(&[0xff, 0xfb, 0x90, 0x00], "mp3").map(|w| w.0),
        Some(Audio)
    );
    // Fonts.
    assert_eq!(d(&ttf(1), "ttf").unwrap().font, Some(FontFormat::Ttf));
    assert_eq!(d(b"OTTOxxxx", "otf").unwrap().font, Some(FontFormat::Otf));
    assert_eq!(d(b"wOFFxxxx", "woff").unwrap().font, Some(FontFormat::Woff));
    assert_eq!(
        d(b"wOF2xxxx", "woff2").unwrap().font,
        Some(FontFormat::Woff2)
    );
    // 3D models.
    assert_eq!(
        what(b"glTF\x02\0\0\0", "glb").map(|w| (w.0, w.1)),
        Some((Model, vec!["glb"]))
    );
    assert_eq!(
        what(br#"{ "asset": { "version": "2.0" } }"#, "gltf").map(|w| w.1),
        Some(vec!["gltf"])
    );
    assert_eq!(
        what(b"# cube\nv 0 0 0\nv 1 0 0\nf 1 2 1\n", "obj").map(|w| w.1),
        Some(vec!["obj"])
    );
    assert_eq!(
        what(b"Kaydara FBX Binary  \0\x1a\0", "fbx").map(|w| w.1),
        Some(vec!["fbx"])
    );
    assert_eq!(
        what(b"; FBX 7.4.0 project file", "fbx").map(|w| w.1),
        Some(vec!["fbx"])
    );
    assert_eq!(
        what(b"solid cube\nendsolid", "stl").map(|w| w.1),
        Some(vec!["stl"])
    );
    assert_eq!(what(&stl_binary(), "stl").map(|w| w.1), Some(vec!["stl"]));
    assert_eq!(
        what(b"ply\nformat ascii 1.0\n", "ply").map(|w| w.1),
        Some(vec!["ply"])
    );
    assert_eq!(
        what(b"<?xml version=\"1.0\"?><COLLADA version=\"1.4.1\">", "dae").map(|w| w.1),
        Some(vec!["dae"])
    );
    assert_eq!(
        what(b"PK\x03\x04zip", "usdz").map(|w| w.1),
        Some(vec!["usdz"])
    );
    assert_eq!(what(b"PXR-USDC\0\0", "usd").map(|w| w.1), Some(vec!["usd"]));
    assert_eq!(what(b"#usda 1.0\n(", "usd").map(|w| w.1), Some(vec!["usd"]));
}

#[test]
fn what_is_none_of_them_or_only_looks_like_one_is_not_detected() {
    assert!(d(b"", "png").is_none());
    assert!(d(b"hello world", "txt").is_none());
    assert!(d(&png(0, 10, 0), "png").is_none(), "a zero side");
    assert!(
        d(&png(MAX_IMAGE_SIDE + 1, 10, 0), "png").is_none(),
        "a side past the bound"
    );
    assert!(
        d(&png(8, 8, 0)[..18], "png").is_none(),
        "a truncated header"
    );
    assert!(d(
        &[0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, b'm', b'a', b't', b'r'],
        "mkv"
    )
    .is_none());
    assert!(
        d(&riff(b"ANIM", &[0; 16]), "avi").is_none(),
        "RIFF is not enough"
    );
    // A text format must look like one under its extension, and the extension must be one.
    assert!(d(b"just some words\n", "obj").is_none());
    assert!(d(br#"{ "name": "not gltf" }"#, "gltf").is_none());
    assert!(d(b"<html></html>", "svg").is_none());
    assert!(d(b"v 0 0 0\n", "stl").is_none(), "an OBJ is not an STL");
    let mut wrong_length = stl_binary();
    wrong_length.push(0);
    assert!(
        d(&wrong_length, "stl").is_none(),
        "a binary STL's length is exact"
    );
    assert!(d(b"v 0 0 0\n", "txt").is_none());
    assert!(
        d(b"ttcfxxxx", "ttc").is_none(),
        "font collections are not taken"
    );
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn project(root: &Path) -> Projects {
    let projects = Projects::at_root(root.join("store"));
    projects.create_project("show").unwrap();
    projects
}

#[test]
fn each_kind_is_filed_in_its_own_folder_and_filing_it_again_changes_nothing() {
    let root = scratch("import");
    let projects = project(&root);
    let files: Vec<(&str, Vec<u8>, &str)> = vec![
        ("helmet.png", png(31, 23, 100), "Assets/Images/F/helmet.png"),
        ("bg.WEBP", webp(64, 64), "Assets/Images/F/bg.webp"),
        ("photo.JPG", jpeg(100, 50), "Assets/Images/F/photo.jpg"),
        (
            "logo.svg",
            br#"<svg width="10" height="10"/>"#.to_vec(),
            "Assets/Images/F/logo.svg",
        ),
        ("intro.mp4", mp4(b"isom"), "Assets/Videos/F/intro.mp4"),
        ("take.mov", mp4(b"qt  "), "Assets/Videos/F/take.mov"),
        ("old.avi", riff(b"AVI ", b"LIST"), "Assets/Videos/F/old.avi"),
        ("loop.webm", webm(), "Assets/Videos/F/loop.webm"),
        ("hit.wav", riff(b"WAVE", b"fmt "), "Assets/Audio/F/hit.wav"),
        (
            "bed.mp3",
            b"ID3\x03\0\0\0\0\0\0".to_vec(),
            "Assets/Audio/F/bed.mp3",
        ),
        (
            "trophy.glb",
            b"glTF\x02\0\0\0".to_vec(),
            "Assets/Models/F/trophy.glb",
        ),
        (
            "cube.obj",
            b"v 0 0 0\nf 1 1 1\n".to_vec(),
            "Assets/Models/F/cube.obj",
        ),
        (
            "Face-Bold.otf",
            b"OTTO0000".to_vec(),
            "Fonts/F/Face-Bold.otf",
        ),
        ("Face-Reg.woff2", b"wOF2".to_vec(), "Fonts/F/Face-Reg.woff2"),
    ];
    for (name, bytes, expected) in &files {
        let from = write(&root, name, bytes);
        let first = projects
            .import_asset("show", "F", &from, None, Some("figma:1:2"))
            .unwrap();
        assert!(first.created, "{name}");
        assert_eq!(&first.item.path, expected, "{name}");
        assert_eq!(first.item.provenance.sources, ["figma:1:2"]);
        assert!(
            projects.project_directory("show").join(expected).is_file(),
            "{name}"
        );
        let again = projects
            .import_asset("show", "F", &from, None, None)
            .unwrap();
        assert!(
            !again.created,
            "{name}: the same bytes under the same name are a no-op"
        );
        assert_eq!(again.item.checksum, first.item.checksum);
    }
    let image = projects
        .import_asset(
            "show",
            "",
            &write(&root, "top.png", &png(5, 5, 0)),
            None,
            None,
        )
        .unwrap();
    assert_eq!(
        image.item.path, "Assets/Images/top.png",
        "an empty folder is the class folder"
    );
    assert_eq!((image.width, image.height), (Some(5), Some(5)));
    let leftovers: Vec<_> = walk(&projects.project_directory("show"))
        .into_iter()
        .filter(|p| p.to_string_lossy().ends_with(".partial"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    std::fs::remove_dir_all(root).expect("clean up");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[test]
fn what_would_overwrite_escape_or_is_not_what_its_name_says_is_refused_by_name() {
    let root = scratch("refusals");
    let projects = project(&root);
    let good = write(&root, "a.png", &png(10, 10, 5));
    projects
        .import_asset("show", "f", &good, None, None)
        .unwrap();

    let unrecognised = |from: &Path, name: Option<&str>| {
        matches!(
            projects.import_asset("show", "f", from, name, None),
            Err(EditorError::Refused(
                Refusal::AssetFormatUnrecognised { .. }
            ))
        )
    };
    let text = write(&root, "notes.txt", b"just some words");
    assert!(unrecognised(&text, None), "not a project format");
    assert!(unrecognised(&root, None), "a folder is not a file");
    assert!(unrecognised(&good, Some("noextension")));

    let says = |from: &Path, name: &str| {
        projects
            .import_asset("show", "f", from, Some(name), None)
            .unwrap_err()
            .to_string()
    };
    let video = write(&root, "v.mp4", &mp4(b"isom"));
    assert!(says(&video, "v.avi").contains("says avi but its bytes are mp4 or mov"));
    let obj = write(&root, "m.obj", b"v 0 0 0\n");
    assert!(
        unrecognised(&obj, Some("m.stl")),
        "an OBJ filed as an STL is not an STL"
    );
    assert!(says(&good, "a.webp").contains("says webp but its bytes are png"));

    let other = write(&root, "other.png", &png(10, 10, 6));
    assert!(says(&other, "a.png").contains("already filed at Assets/Images/f/a.png"));
    assert_eq!(
        std::fs::read(projects.images_directory("show").join("f").join("a.png")).unwrap(),
        std::fs::read(&good).unwrap(),
        "the first file is untouched"
    );
    for (folder, name) in [
        ("..", "x.png"),
        ("a/b", "x.png"),
        ("f", "../x.png"),
        ("f", "a\\b.png"),
    ] {
        assert!(
            projects
                .import_asset("show", folder, &good, Some(name), None)
                .is_err(),
            "{folder:?} {name:?}"
        );
    }
    assert!(!root.join("store").join("show").join("x.png").exists());
    assert!(matches!(
        projects.import_asset("nowhere", "f", &good, None, None),
        Err(EditorError::Refused(Refusal::ProjectNotFound { .. }))
    ));
    assert!(projects
        .import_asset("show", "f", &root.join("missing.png"), None, None)
        .is_err());
    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn the_folders_are_the_truth_and_a_file_is_found_by_its_content() {
    let root = scratch("truth");
    let projects = project(&root);
    let a = write(&root, "a.png", &png(10, 10, 5));
    let clip = write(&root, "clip.mp4", &mp4(b"isom"));
    let imported = projects
        .import_asset("show", "Frame", &a, None, None)
        .unwrap();
    projects
        .import_asset("show", "Frame", &clip, None, None)
        .unwrap();
    // A file of the user's own that is not one of the folder's formats is not listed; a loose
    // one is.
    write(
        &projects.images_directory("show").join("Frame"),
        "notes.txt",
        b"x",
    );
    write(
        &projects.images_directory("show"),
        "loose.png",
        &png(3, 3, 0),
    );
    write(&projects.fonts_directory("show"), "Face.ttf", &ttf(2));
    write(
        &projects.fonts_directory("show"),
        "Impostor.ttf",
        &png(4, 4, 0),
    );

    let listed: Vec<String> = projects
        .project_files("show")
        .unwrap()
        .into_iter()
        .map(|(i, _)| i.path)
        .collect();
    assert_eq!(
        listed,
        [
            "Assets/Images/Frame/a.png",
            "Assets/Images/loose.png",
            "Assets/Videos/Frame/clip.mp4",
            "Fonts/Face.ttf"
        ]
    );

    // Read by content: this is how publish and the viewport read it, whatever the folder.
    let hash = imported.item.checksum.clone().unwrap();
    assert_eq!(
        projects.read_asset("show", &hash).unwrap().as_deref(),
        Some(std::fs::read(&a).unwrap().as_slice())
    );
    let video_hash = hash_of(&root.join("clip.mp4")).unwrap();
    assert!(projects.has_asset("show", &video_hash).unwrap());
    let assets = projects.project_assets("show").unwrap();
    assert!(assets
        .iter()
        .any(|i| i.path == "Assets/Videos/Frame/clip.mp4" && i.kind == AssetKind::Video));
    assert!(assets
        .iter()
        .any(|i| i.path == "Fonts/Face.ttf" && i.kind == AssetKind::Font));

    // Swap the file on disk: the old address is gone and the new bytes have their own.
    let swapped = png(10, 10, 40);
    std::fs::write(
        projects
            .images_directory("show")
            .join("Frame")
            .join("a.png"),
        &swapped,
    )
    .unwrap();
    assert!(!projects.has_asset("show", &hash).unwrap());
    assert_eq!(
        projects
            .read_asset("show", &gx_asset_plane::content_hash(&swapped))
            .unwrap()
            .as_deref(),
        Some(swapped.as_slice())
    );
    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn a_picture_is_found_by_name_png_first_then_webp_jpg_and_svg() {
    let root = scratch("find-image");
    let projects = project(&root);
    for (name, bytes) in [
        ("both.png", png(5, 5, 0)),
        ("both.webp", webp(6, 6)),
        ("photo.jpeg", jpeg(8, 8)),
        ("mark.svg", b"<svg width=\"3\" height=\"3\"/>".to_vec()),
        ("only.webp", webp(7, 7)),
    ] {
        let from = write(&root, name, &bytes);
        projects
            .import_asset("show", "Frame", &from, None, None)
            .unwrap();
    }
    let path = |stem: &str| {
        projects
            .find_image("show", "Frame", stem)
            .unwrap()
            .map(|i| i.path)
    };
    assert_eq!(
        path("both").as_deref(),
        Some("Assets/Images/Frame/both.png")
    );
    assert_eq!(
        path("only").as_deref(),
        Some("Assets/Images/Frame/only.webp")
    );
    assert_eq!(
        path("photo").as_deref(),
        Some("Assets/Images/Frame/photo.jpeg")
    );
    assert_eq!(
        path("mark").as_deref(),
        Some("Assets/Images/Frame/mark.svg")
    );
    assert_eq!(path("missing"), None);
    assert_eq!(path("../x"), None);
    assert_eq!(projects.find_image("show", "..", "both").unwrap(), None);
    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn a_font_is_found_by_family_and_style_in_any_of_the_four_formats() {
    let root = scratch("find-font");
    let projects = project(&root);
    let fonts = projects.fonts_directory("show");
    std::fs::write(fonts.join("NewScience-SemiBold.ttf"), ttf(1)).unwrap();
    std::fs::write(fonts.join("New Science Bold.TTF"), ttf(2)).unwrap();
    std::fs::write(fonts.join("refrigerator_deluxe-heavy.otf"), b"OTTO-heavy").unwrap();
    std::fs::write(fonts.join("Web-Regular.woff2"), b"wOF2-web").unwrap();
    std::fs::write(fonts.join("Old-Bold.woff"), b"wOFF-old").unwrap();
    std::fs::write(fonts.join("Inter.ttf"), ttf(3)).unwrap();
    std::fs::write(fonts.join("Impostor-Bold.ttf"), png(4, 4, 0)).unwrap();
    std::fs::create_dir_all(fonts.join("Brand")).unwrap();
    std::fs::write(fonts.join("Brand").join("Display-Black.ttf"), ttf(4)).unwrap();

    let find = |family: &str, style: &str| {
        projects
            .find_font("show", family, style)
            .unwrap()
            .map(|(i, f)| (i.path, f))
    };
    assert_eq!(
        find("New Science", "Semi Bold"),
        Some(("Fonts/NewScience-SemiBold.ttf".into(), FontFormat::Ttf)),
        "Figma writes the style with a space"
    );
    assert_eq!(
        find("Refrigerator Deluxe", "Heavy"),
        Some((
            "Fonts/refrigerator_deluxe-heavy.otf".into(),
            FontFormat::Otf
        ))
    );
    assert_eq!(find("Web", "Regular").map(|f| f.1), Some(FontFormat::Woff2));
    assert_eq!(find("Old", "Bold").map(|f| f.1), Some(FontFormat::Woff));
    assert_eq!(
        find("Inter", "Regular").map(|f| f.0),
        Some("Fonts/Inter.ttf".into())
    );
    assert_eq!(
        find("Display", "Black").map(|f| f.0),
        Some("Fonts/Brand/Display-Black.ttf".into()),
        "one folder deep"
    );
    assert_eq!(
        find("Inter", "Bold"),
        None,
        "a style that is not filed stays missing"
    );
    assert_eq!(
        find("Impostor", "Bold"),
        None,
        "a file that is not a font is not one"
    );
    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn a_project_laid_out_the_earlier_way_moves_to_assets_and_sources_without_losing_a_file() {
    let root = scratch("migrate");
    let projects = Projects::at_root(root.join("store"));
    let folder = root.join("store").join("old");
    // The hash store as it was (`assets`), and the first .gpx layout (`Images`, `Footage`).
    std::fs::create_dir_all(folder.join("scenes")).unwrap();
    std::fs::create_dir_all(folder.join("assets")).unwrap();
    std::fs::write(folder.join("assets").join("abc.json"), b"{}").unwrap();
    std::fs::create_dir_all(folder.join("Images").join("Frame")).unwrap();
    std::fs::write(
        folder.join("Images").join("Frame").join("a.png"),
        png(9, 9, 0),
    )
    .unwrap();
    std::fs::create_dir_all(folder.join("Footage")).unwrap();
    std::fs::write(folder.join("Footage").join("clip.mp4"), mp4(b"isom")).unwrap();

    assert!(projects.upgrade_project("old").unwrap());
    let names: Vec<String> = std::fs::read_dir(&folder)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.contains(&"Sources".to_owned()), "{names:?}");
    assert!(!names.contains(&"assets".to_owned()), "{names:?}");
    assert!(!names.contains(&"Footage".to_owned()), "{names:?}");
    assert!(!names.contains(&"Images".to_owned()), "{names:?}");
    assert!(folder.join("Sources").join("abc.json").is_file());
    assert!(folder.join("Assets/Images/Frame/a.png").is_file());
    assert!(folder.join("Assets/Videos/clip.mp4").is_file());
    for sub in ["Assets/Audio", "Assets/Models", "Fonts"] {
        assert!(folder.join(sub).is_dir(), "{sub}");
    }
    assert!(
        !projects.upgrade_project("old").unwrap(),
        "a second upgrade changes nothing"
    );
    std::fs::remove_dir_all(root).expect("clean up");
}
