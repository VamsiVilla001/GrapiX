use super::*;

fn scratch(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-recent-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn gpx(root: &Path, name: &str) -> PathBuf {
    root.join(name).join(format!("{name}.gpx"))
}

#[test]
fn a_project_opened_goes_to_the_top_once_and_the_oldest_fall_off() {
    let root = scratch("order");
    let recent = RecentProjects::at(root.join("prefs").join("recent-projects.json"));
    assert!(recent.list().is_empty(), "no file is an empty list");

    for (i, name) in ["A", "B", "C"].iter().enumerate() {
        recent
            .record(&gpx(&root, name), name, 100 + i as u64)
            .unwrap();
    }
    let names = |r: &RecentProjects| r.list().into_iter().map(|p| p.name).collect::<Vec<_>>();
    assert_eq!(names(&recent), ["C", "B", "A"], "newest first");

    // Opening A again moves it to the top and does not list it twice.
    recent.record(&gpx(&root, "A"), "A", 500).unwrap();
    assert_eq!(names(&recent), ["A", "C", "B"]);

    for i in 0..RECENT_LIMIT + 3 {
        let name = format!("P{i}");
        recent
            .record(&gpx(&root, &name), &name, 1000 + i as u64)
            .unwrap();
    }
    let all = recent.list();
    assert_eq!(all.len(), RECENT_LIMIT, "bounded");
    assert_eq!(
        all[0].name,
        format!("P{}", RECENT_LIMIT + 2),
        "the newest is first"
    );
    assert!(
        all.iter().all(|p| p.name.starts_with('P')),
        "the oldest fell off"
    );
    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn forgetting_takes_one_off_the_list_and_nothing_else() {
    let root = scratch("forget");
    let recent = RecentProjects::at(root.join("recent.json"));
    let a = gpx(&root, "A");
    let b = gpx(&root, "B");
    recent.record(&a, "A", 1).unwrap();
    recent.record(&b, "B", 2).unwrap();
    std::fs::create_dir_all(a.parent().unwrap()).unwrap();
    std::fs::write(&a, b"project").unwrap();

    recent.forget(&a.display().to_string()).unwrap();
    let names: Vec<_> = recent.list().into_iter().map(|p| p.name).collect();
    assert_eq!(names, ["B"]);
    assert!(a.is_file(), "the project itself is not touched");
    recent.forget("not listed").unwrap();
    assert_eq!(
        recent.list().len(),
        1,
        "forgetting what is not there changes nothing"
    );
    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn a_file_that_does_not_read_is_an_empty_list_that_the_next_open_repairs() {
    let root = scratch("corrupt");
    let file = root.join("recent.json");
    let recent = RecentProjects::at(&file);
    std::fs::write(&file, b"{ not json").unwrap();
    assert!(recent.list().is_empty());
    recent.record(&gpx(&root, "A"), "A", 1).unwrap();
    assert_eq!(recent.list().len(), 1, "a good file replaces the bad one");
    std::fs::write(&file, br#"{"recent":[{"gpx":"x","name":"y"}]}"#).unwrap();
    assert!(
        recent.list().is_empty(),
        "a record missing its fields is not trusted"
    );
    std::fs::remove_dir_all(root).expect("clean up");
}

#[cfg(windows)]
#[test]
fn on_windows_case_and_separators_do_not_make_a_second_entry() {
    let root = scratch("windows");
    let recent = RecentProjects::at(root.join("recent.json"));
    recent
        .record(Path::new(r"D:\Shows\Finals\Finals.gpx"), "Finals", 1)
        .unwrap();
    recent
        .record(Path::new("d:/shows/finals/finals.gpx"), "Finals", 2)
        .unwrap();
    assert_eq!(recent.list().len(), 1);
    std::fs::remove_dir_all(root).expect("clean up");
}

fn small_png(width: u32, shade: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, 1);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&vec![shade; width as usize])
            .unwrap();
    }
    bytes
}

#[test]
fn thumbnails_are_scoped_to_recent_projects_and_survive_reopening() {
    let root = scratch("thumbnails");
    let list = root.join("recent.json");
    let recent = RecentProjects::at(&list);
    let a = gpx(&root, "A");
    let b = gpx(&root, "B");
    let (a_id, b_id) = (a.to_str().unwrap(), b.to_str().unwrap());
    let first = small_png(2, 10);
    let second = small_png(2, 20);
    assert!(recent.store_thumbnail(a_id, &first).is_err());
    recent.record(&a, "A", 1).unwrap();
    recent.record(&b, "B", 2).unwrap();
    assert_eq!(recent.thumbnail(a_id), None);
    recent.store_thumbnail(a_id, &first).unwrap();
    recent.store_thumbnail(b_id, &second).unwrap();
    recent.record(&a, "A", 3).unwrap();
    let reopened = RecentProjects::at(&list);
    assert_eq!(reopened.list()[0].opened_ms, 3);
    assert_eq!(reopened.thumbnail(a_id), Some(first));
    assert_eq!(reopened.thumbnail(b_id), Some(second));
    reopened.forget(a_id).unwrap();
    assert!(!reopened.thumbnail_path(a_id).exists());
    assert_eq!(reopened.thumbnail(a_id), None);
    std::fs::remove_file(reopened.thumbnail_path(b_id)).unwrap();
    std::fs::remove_dir(list.with_extension("thumbnails")).unwrap();
    std::fs::remove_file(list).unwrap();
    std::fs::remove_file(root.join("recent.json.lock")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn invalid_preview_does_not_replace_a_valid_thumbnail() {
    let root = scratch("thumbnail-bound");
    let list = root.join("recent.json");
    let recent = RecentProjects::at(&list);
    let a = gpx(&root, "A");
    let a_id = a.to_str().unwrap();
    recent.record(&a, "A", 1).unwrap();
    let png = small_png(2, 51);
    recent.store_thumbnail(a_id, &png).unwrap();
    for invalid in [
        b"not a PNG".to_vec(),
        png[..24].to_vec(),
        small_png(MAX_THUMBNAIL_DIMENSION + 1, 0),
        vec![0; MAX_THUMBNAIL_BYTES + 1],
    ] {
        assert!(recent.store_thumbnail(a_id, &invalid).is_err());
    }
    assert_eq!(recent.thumbnail(a_id), Some(png));
    std::fs::write(recent.thumbnail_path(a_id), b"corrupt cache").unwrap();
    assert_eq!(recent.thumbnail(a_id), None);
    recent.forget(a_id).unwrap();
    std::fs::remove_dir(list.with_extension("thumbnails")).unwrap();
    std::fs::remove_file(list).unwrap();
    std::fs::remove_file(root.join("recent.json.lock")).unwrap();
    std::fs::remove_dir(root).unwrap();
}
