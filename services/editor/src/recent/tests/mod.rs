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
