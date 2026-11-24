use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

const SCHEMA: u32 = 1;

fn scratch(label: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "gx-workspace-store-{label}-{nanos}-{}",
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn store(dir: &Path) -> WorkspaceStore {
    WorkspaceStore::open(dir.join("roaming"), dir.join("local"), SCHEMA)
}

fn doc(id: &str, name: &str) -> Value {
    json!({ "schemaVersion": 1, "workspaceId": id, "name": name, "root": { "kind": "tabs" } })
}

fn names(folder: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(folder)
        .map(|r| {
            r.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn refused(result: Result<impl std::fmt::Debug, WorkspaceError>) -> Refusal {
    match result {
        Err(WorkspaceError::Refused(refusal)) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn an_id_is_a_safe_file_name() {
    for good in [
        "design",
        "user.my-layout_2",
        "factory.editor.design",
        "0abc",
        "a",
        &"x".repeat(64),
    ] {
        assert!(check_id(good).is_ok(), "{good}");
    }
    for bad in [
        "",
        " ",
        "Design",
        "a b",
        "../x",
        "a/b",
        "a\\b",
        ".hidden",
        "-x",
        "_x",
        "a:b",
        "a*b",
        "ünï",
        "trailing.",
        "con",
        "nul",
        "com1",
        "lpt9",
        "aux.txt",
        "prn.json",
        &"x".repeat(65),
    ] {
        assert!(
            matches!(
                check_id(bad),
                Err(WorkspaceError::Refused(Refusal::WorkspaceInvalid { .. }))
            ),
            "{bad:?} should be refused"
        );
    }
    // A name that only starts like a reserved one is fine.
    assert!(check_id("console").is_ok());
    assert!(check_id("com10").is_ok());
}

#[test]
fn a_workspace_is_kept_where_its_kind_belongs_and_reads_back() {
    let dir = scratch("kinds");
    let s = store(&dir);
    let value = doc("design", "Design");
    for kind in [Kind::Saved, Kind::Session, Kind::LastGood] {
        s.put(App::Editor, kind, "design", &value).unwrap();
        assert_eq!(
            s.get(App::Editor, kind, "design").unwrap(),
            Read::Found(value.clone())
        );
    }
    // Saved baselines roam; the rest stay on this computer.
    assert_eq!(
        names(&dir.join("roaming/editor/saved")),
        vec!["design.json"]
    );
    assert_eq!(
        names(&dir.join("local/editor/session")),
        vec!["design.json"]
    );
    assert_eq!(
        names(&dir.join("local/editor/last-good")),
        vec!["design.json"]
    );
    assert!(!dir.join("roaming/editor/session").exists());
    assert!(!dir.join("local/editor/saved").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_editor_and_playout_never_share_a_workspace() {
    let dir = scratch("apps");
    let s = store(&dir);
    s.put(
        App::Editor,
        Kind::Saved,
        "design",
        &doc("design", "Editor one"),
    )
    .unwrap();
    assert_eq!(
        s.get(App::Playout, Kind::Saved, "design").unwrap(),
        Read::Missing
    );
    s.put(
        App::Playout,
        Kind::Saved,
        "design",
        &doc("design", "Playout one"),
    )
    .unwrap();
    assert_eq!(
        s.get(App::Editor, Kind::Saved, "design").unwrap(),
        Read::Found(doc("design", "Editor one"))
    );
    assert_eq!(s.list(App::Playout, Kind::Saved).unwrap(), vec!["design"]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn nothing_is_created_by_opening_or_reading() {
    let dir = scratch("quiet");
    let s = store(&dir);
    assert_eq!(
        s.get(App::Editor, Kind::Saved, "design").unwrap(),
        Read::Missing
    );
    assert_eq!(
        s.list(App::Editor, Kind::Saved).unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(s.active(App::Editor).unwrap(), None);
    assert_eq!(s.order(App::Editor).unwrap(), Vec::<String>::new());
    assert_eq!(names(&dir), Vec::<String>::new());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_write_replaces_the_file_whole_and_keeps_the_copy_it_replaced() {
    let dir = scratch("replace");
    let s = store(&dir);
    s.put(App::Editor, Kind::Saved, "design", &doc("design", "One"))
        .unwrap();
    assert!(
        !dir.join("roaming/editor/saved/design.json.bak").exists(),
        "the first write has nothing to keep"
    );
    s.put(App::Editor, Kind::Saved, "design", &doc("design", "Two"))
        .unwrap();
    s.put(App::Editor, Kind::Saved, "design", &doc("design", "Three"))
        .unwrap();
    assert_eq!(
        s.get(App::Editor, Kind::Saved, "design").unwrap(),
        Read::Found(doc("design", "Three"))
    );
    let kept: Value = serde_json::from_slice(
        &std::fs::read(dir.join("roaming/editor/saved/design.json.bak")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        kept,
        doc("design", "Two"),
        "the copy is the one the last write replaced"
    );
    // No temporary file is left behind.
    assert_eq!(
        names(&dir.join("roaming/editor/saved")),
        vec!["design.json", "design.json.bak"]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_write_that_cannot_keep_its_copy_leaves_the_file_as_it_was() {
    let dir = scratch("failed");
    let s = store(&dir);
    s.put(App::Editor, Kind::Saved, "design", &doc("design", "One"))
        .unwrap();
    // The place the copy goes is a folder, so the copy fails.
    std::fs::create_dir(dir.join("roaming/editor/saved/design.json.bak")).unwrap();
    let before = std::fs::read(dir.join("roaming/editor/saved/design.json")).unwrap();
    assert!(matches!(
        s.put(App::Editor, Kind::Saved, "design", &doc("design", "Two")),
        Err(WorkspaceError::Io { .. })
    ));
    assert_eq!(
        std::fs::read(dir.join("roaming/editor/saved/design.json")).unwrap(),
        before
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_document_that_is_not_a_workspace_is_refused_by_name_and_nothing_is_written() {
    let dir = scratch("envelope");
    let s = store(&dir);
    let cases: Vec<(Value, &str)> = vec![
        (json!([1, 2]), "a workspace is a JSON object"),
        (json!("text"), "a workspace is a JSON object"),
        (
            json!({ "workspaceId": "design" }),
            "carries a schemaVersion",
        ),
        (
            json!({ "schemaVersion": "1", "workspaceId": "design" }),
            "carries a schemaVersion",
        ),
        (
            json!({ "schemaVersion": 0, "workspaceId": "design" }),
            "carries a schemaVersion",
        ),
        (
            json!({ "schemaVersion": 1.5, "workspaceId": "design" }),
            "carries a schemaVersion",
        ),
        (
            json!({ "schemaVersion": -1, "workspaceId": "design" }),
            "carries a schemaVersion",
        ),
        (
            json!({ "schemaVersion": 1 }),
            "workspaceId inside the document",
        ),
        (
            json!({ "schemaVersion": 1, "workspaceId": "other" }),
            "workspaceId inside the document",
        ),
        (
            json!({ "schemaVersion": 1, "workspaceId": 7 }),
            "workspaceId inside the document",
        ),
    ];
    for (value, why) in cases {
        match refused(s.put(App::Editor, Kind::Saved, "design", &value)) {
            Refusal::WorkspaceInvalid { id, detail } => {
                assert_eq!(id, "design");
                assert!(detail.contains(why), "{detail} should contain {why}");
            }
            other => panic!("{other:?}"),
        }
    }
    assert!(
        !dir.join("roaming").exists(),
        "a refused write creates nothing"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_workspace_over_the_size_limit_is_refused_and_one_just_under_is_kept() {
    let dir = scratch("size");
    let s = store(&dir);
    let big =
        json!({ "schemaVersion": 1, "workspaceId": "big", "pad": "x".repeat(MAX_WORKSPACE_BYTES) });
    match refused(s.put(App::Editor, Kind::Saved, "big", &big)) {
        Refusal::WorkspaceInvalid { detail, .. } => assert!(detail.contains("at most")),
        other => panic!("{other:?}"),
    }
    assert!(!dir.join("roaming").exists());
    let fits = json!({ "schemaVersion": 1, "workspaceId": "big", "pad": "x".repeat(MAX_WORKSPACE_BYTES - 200) });
    s.put(App::Editor, Kind::Saved, "big", &fits).unwrap();
    assert_eq!(
        s.get(App::Editor, Kind::Saved, "big").unwrap(),
        Read::Found(fits)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_unsafe_id_is_refused_before_any_path_is_made_from_it() {
    let dir = scratch("unsafe");
    let s = store(&dir);
    for bad in ["../escape", "a/b", "CON", ""] {
        assert!(
            matches!(
                refused(s.put(App::Editor, Kind::Saved, bad, &doc(bad, "x"))),
                Refusal::WorkspaceInvalid { .. }
            ),
            "{bad}"
        );
        assert!(
            matches!(
                refused(s.get(App::Editor, Kind::Saved, bad)),
                Refusal::WorkspaceInvalid { .. }
            ),
            "{bad}"
        );
        assert!(
            matches!(
                refused(s.delete(App::Editor, Kind::Saved, bad)),
                Refusal::WorkspaceInvalid { .. }
            ),
            "{bad}"
        );
    }
    assert_eq!(names(&dir), Vec::<String>::new());
    assert!(!dir.parent().unwrap().join("escape.json").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_file_written_by_a_newer_build_is_left_alone_and_never_written_over() {
    let dir = scratch("newer");
    let s = store(&dir);
    let file = dir.join("roaming/editor/saved/design.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let newer_text = r#"{ "schemaVersion": 2, "workspaceId": "design", "future": true }"#;
    std::fs::write(&file, newer_text).unwrap();
    assert_eq!(
        s.get(App::Editor, Kind::Saved, "design").unwrap(),
        Read::Newer {
            found: 2,
            supported: 1
        }
    );
    assert_eq!(
        refused(s.put(App::Editor, Kind::Saved, "design", &doc("design", "Mine"))),
        Refusal::WorkspaceNewer {
            id: "design".into(),
            found: 2,
            supported: 1
        }
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer_text);
    assert_eq!(
        names(file.parent().unwrap()),
        vec!["design.json"],
        "no copy, no set-aside, nothing"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_document_this_build_does_not_write_is_not_written() {
    let dir = scratch("newer-doc");
    let s = store(&dir);
    let value = json!({ "schemaVersion": 2, "workspaceId": "design" });
    assert_eq!(
        refused(s.put(App::Editor, Kind::Saved, "design", &value)),
        Refusal::WorkspaceNewer {
            id: "design".into(),
            found: 2,
            supported: 1
        }
    );
    assert!(!dir.join("roaming").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_file_that_does_not_read_is_set_aside_and_the_backup_is_offered() {
    let dir = scratch("corrupt");
    let s = store(&dir);
    s.put(App::Editor, Kind::Session, "design", &doc("design", "Good"))
        .unwrap();
    s.put(
        App::Editor,
        Kind::Session,
        "design",
        &doc("design", "Later"),
    )
    .unwrap();
    let file = dir.join("local/editor/session/design.json");
    std::fs::write(&file, b"{ this is not json").unwrap();

    match s.get(App::Editor, Kind::Session, "design").unwrap() {
        Read::SetAside { aside, backup } => {
            assert!(aside
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("design.json.corrupt-"));
            assert_eq!(
                std::fs::read(&aside).unwrap(),
                b"{ this is not json",
                "the broken bytes are kept"
            );
            assert_eq!(
                backup,
                Some(doc("design", "Good")),
                "the copy the last write replaced"
            );
        }
        other => panic!("{other:?}"),
    }
    assert!(!file.exists(), "nothing was written in its place");
    assert_eq!(
        s.get(App::Editor, Kind::Session, "design").unwrap(),
        Read::Missing
    );
    // The set-aside file is not a workspace and is not listed.
    assert_eq!(
        s.list(App::Editor, Kind::Session).unwrap(),
        Vec::<String>::new()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_file_with_no_usable_version_does_not_read_either() {
    let dir = scratch("noversion");
    let s = store(&dir);
    for (n, text) in [
        r#"[1]"#,
        r#"{"workspaceId":"design"}"#,
        r#"{"schemaVersion":0}"#,
        r#"{"schemaVersion":"1"}"#,
        "null",
        "",
    ]
    .iter()
    .enumerate()
    {
        let file = dir.join("roaming/editor/saved/design.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, text).unwrap();
        assert!(
            matches!(
                s.get(App::Editor, Kind::Saved, "design").unwrap(),
                Read::SetAside { backup: None, .. }
            ),
            "{text:?}"
        );
        assert!(!file.exists());
        assert_eq!(
            names(file.parent().unwrap())
                .iter()
                .filter(|name| name.contains(".corrupt-"))
                .count(),
            n + 1,
            "every one is kept"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_backup_that_does_not_read_or_is_from_a_newer_build_is_not_offered() {
    let dir = scratch("badbackup");
    let s = store(&dir);
    let folder = dir.join("roaming/editor/saved");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("a.json"), "broken").unwrap();
    std::fs::write(folder.join("a.json.bak"), "also broken").unwrap();
    assert!(matches!(
        s.get(App::Editor, Kind::Saved, "a").unwrap(),
        Read::SetAside { backup: None, .. }
    ));
    std::fs::write(folder.join("b.json"), "broken").unwrap();
    std::fs::write(
        folder.join("b.json.bak"),
        r#"{"schemaVersion":9,"workspaceId":"b"}"#,
    )
    .unwrap();
    assert!(matches!(
        s.get(App::Editor, Kind::Saved, "b").unwrap(),
        Read::SetAside { backup: None, .. }
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn files_set_aside_in_one_moment_do_not_replace_each_other() {
    let dir = scratch("twice");
    let s = store(&dir);
    let file = dir.join("roaming/editor/saved/design.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    for n in 0..5 {
        std::fs::write(&file, format!("broken {n}")).unwrap();
        match s.get(App::Editor, Kind::Saved, "design").unwrap() {
            Read::SetAside { aside, .. } => assert!(seen.insert(aside)),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(seen.len(), 5);
    for (n, aside) in seen.iter().enumerate() {
        assert!(
            std::fs::read_to_string(aside)
                .unwrap()
                .starts_with("broken "),
            "{n}"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn listing_gives_the_ids_of_one_kind_sorted_and_nothing_else() {
    let dir = scratch("list");
    let s = store(&dir);
    for id in ["zeta", "alpha", "user.mine"] {
        s.put(App::Editor, Kind::Saved, id, &doc(id, id)).unwrap();
        s.put(App::Editor, Kind::Saved, id, &doc(id, "again"))
            .unwrap();
    }
    s.put(
        App::Editor,
        Kind::Session,
        "only-session",
        &doc("only-session", "s"),
    )
    .unwrap();
    let folder = dir.join("roaming/editor/saved");
    std::fs::write(folder.join("note.txt"), "x").unwrap();
    std::fs::write(folder.join("Bad Name.json"), "{}").unwrap();
    std::fs::create_dir(folder.join("sub.json")).unwrap();
    std::fs::write(folder.join("x.json.corrupt-1"), "x").unwrap();
    assert_eq!(
        s.list(App::Editor, Kind::Saved).unwrap(),
        vec!["alpha", "user.mine", "zeta"]
    );
    assert_eq!(
        s.list(App::Editor, Kind::Session).unwrap(),
        vec!["only-session"]
    );
    assert_eq!(
        s.list(App::Editor, Kind::LastGood).unwrap(),
        Vec::<String>::new()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn deleting_removes_the_file_and_its_copy_and_keeps_what_was_set_aside() {
    let dir = scratch("delete");
    let s = store(&dir);
    s.put(App::Editor, Kind::Saved, "design", &doc("design", "One"))
        .unwrap();
    s.put(App::Editor, Kind::Saved, "design", &doc("design", "Two"))
        .unwrap();
    let folder = dir.join("roaming/editor/saved");
    std::fs::write(folder.join("design.json.corrupt-5"), "old").unwrap();
    assert!(s.delete(App::Editor, Kind::Saved, "design").unwrap());
    assert_eq!(names(&folder), vec!["design.json.corrupt-5"]);
    assert!(
        !s.delete(App::Editor, Kind::Saved, "design").unwrap(),
        "absent is reported, not treated as a delete"
    );
    assert_eq!(
        s.get(App::Editor, Kind::Saved, "design").unwrap(),
        Read::Missing
    );
    // Another kind of the same id is not touched.
    s.put(App::Editor, Kind::Session, "design", &doc("design", "S"))
        .unwrap();
    s.delete(App::Editor, Kind::Saved, "design").unwrap();
    assert!(matches!(
        s.get(App::Editor, Kind::Session, "design").unwrap(),
        Read::Found(_)
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_workspace_in_use_is_kept_for_each_application_on_this_computer() {
    let dir = scratch("active");
    let s = store(&dir);
    assert_eq!(s.active(App::Editor).unwrap(), None);
    s.set_active(App::Editor, Some("user.mine")).unwrap();
    s.set_active(App::Playout, Some("operator")).unwrap();
    assert_eq!(s.active(App::Editor).unwrap().as_deref(), Some("user.mine"));
    assert_eq!(s.active(App::Playout).unwrap().as_deref(), Some("operator"));
    assert!(
        dir.join("local/editor/active.json").exists(),
        "this computer's"
    );
    s.set_active(App::Editor, None).unwrap();
    assert_eq!(s.active(App::Editor).unwrap(), None);
    assert!(matches!(
        refused(s.set_active(App::Editor, Some("../x"))),
        Refusal::WorkspaceInvalid { .. }
    ));
    assert_eq!(s.active(App::Playout).unwrap().as_deref(), Some("operator"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_order_roams_with_the_saved_workspaces_and_refuses_a_repeat_or_an_unsafe_id() {
    let dir = scratch("order");
    let s = store(&dir);
    let ids: Vec<String> = ["b", "a", "user.c"]
        .iter()
        .map(|id| (*id).to_owned())
        .collect();
    s.set_order(App::Editor, &ids).unwrap();
    assert_eq!(s.order(App::Editor).unwrap(), ids);
    assert!(dir.join("roaming/editor/order.json").exists());
    assert_eq!(s.order(App::Playout).unwrap(), Vec::<String>::new());
    let twice: Vec<String> = ["a", "a"].iter().map(|id| (*id).to_owned()).collect();
    assert!(matches!(
        refused(s.set_order(App::Editor, &twice)),
        Refusal::WorkspaceInvalid { .. }
    ));
    assert!(matches!(
        refused(s.set_order(App::Editor, &["Bad".to_owned()])),
        Refusal::WorkspaceInvalid { .. }
    ));
    assert_eq!(
        s.order(App::Editor).unwrap(),
        ids,
        "a refused order changes nothing"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_index_that_does_not_read_is_set_aside_and_reads_as_absent() {
    let dir = scratch("index");
    let s = store(&dir);
    let active = dir.join("local/editor/active.json");
    std::fs::create_dir_all(active.parent().unwrap()).unwrap();
    std::fs::write(&active, "garbage").unwrap();
    assert_eq!(s.active(App::Editor).unwrap(), None);
    assert!(!active.exists());
    assert_eq!(names(active.parent().unwrap()).len(), 1);
    assert!(names(active.parent().unwrap())[0].starts_with("active.json.corrupt-"));
    // An id inside a readable index that is not a safe one is not handed out.
    std::fs::write(&active, r#"{"schemaVersion":1,"workspaceId":"../x"}"#).unwrap();
    assert_eq!(s.active(App::Editor).unwrap(), None);
    let order = dir.join("roaming/editor/order.json");
    std::fs::create_dir_all(order.parent().unwrap()).unwrap();
    std::fs::write(&order, r#"{"schemaVersion":1,"ids":["a","../x",7,"b"]}"#).unwrap();
    assert_eq!(s.order(App::Editor).unwrap(), vec!["a", "b"]);
    // A newer index is set aside too: this build cannot honour it.
    std::fs::write(&order, r#"{"schemaVersion":2,"ids":["a"]}"#).unwrap();
    assert_eq!(s.order(App::Editor).unwrap(), Vec::<String>::new());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_default_store_is_in_the_users_and_this_computers_folders() {
    let store = WorkspaceStore::open_default(SCHEMA).unwrap();
    let saved = gx_contracts::platform::service_data_root()
        .unwrap()
        .join("workspaces");
    let local = gx_contracts::platform::machine_settings_root()
        .unwrap()
        .join("workspaces");
    assert_eq!(
        store.folder(App::Editor, Kind::Saved),
        saved.join("editor").join("saved")
    );
    assert_eq!(
        store.folder(App::Playout, Kind::Session),
        local.join("playout").join("session")
    );
    assert_eq!(
        store.folder(App::Editor, Kind::LastGood),
        local.join("editor").join("last-good")
    );
}

#[test]
fn applications_and_kinds_are_read_from_their_wire_names() {
    assert_eq!(App::parse("editor"), Some(App::Editor));
    assert_eq!(App::parse("playout"), Some(App::Playout));
    assert_eq!(App::parse("Editor"), None);
    assert_eq!(Kind::parse("saved"), Some(Kind::Saved));
    assert_eq!(Kind::parse("session"), Some(Kind::Session));
    assert_eq!(Kind::parse("lastGood"), Some(Kind::LastGood));
    assert_eq!(Kind::parse("last-good"), None);
    assert_eq!(App::Playout.as_str(), "playout");
}

#[test]
fn a_file_that_does_not_read_is_set_aside_by_a_write_and_the_good_backup_is_kept() {
    let dir = scratch("keepbak");
    let s = store(&dir);
    s.put(App::Editor, Kind::Session, "design", &doc("design", "One"))
        .unwrap();
    s.put(App::Editor, Kind::Session, "design", &doc("design", "Two"))
        .unwrap();
    let folder = dir.join("local/editor/session");
    // The file is damaged after it was read (a crash, a sync conflict); the backup is the good "One".
    std::fs::write(folder.join("design.json"), b"{ trunc").unwrap();
    s.put(
        App::Editor,
        Kind::Session,
        "design",
        &doc("design", "Three"),
    )
    .unwrap();
    let kept: Value =
        serde_json::from_slice(&std::fs::read(folder.join("design.json.bak")).unwrap()).unwrap();
    assert_eq!(
        kept,
        doc("design", "One"),
        "the good backup was not overwritten with the broken bytes"
    );
    let asides: Vec<String> = names(&folder)
        .into_iter()
        .filter(|n| n.contains(".corrupt-"))
        .collect();
    assert_eq!(asides.len(), 1);
    assert_eq!(std::fs::read(folder.join(&asides[0])).unwrap(), b"{ trunc");
    assert_eq!(
        s.get(App::Editor, Kind::Session, "design").unwrap(),
        Read::Found(doc("design", "Three"))
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_file_written_by_a_newer_build_is_never_deleted() {
    let dir = scratch("newerdelete");
    let s = store(&dir);
    let file = dir.join("roaming/editor/saved/design.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, r#"{"schemaVersion":4,"workspaceId":"design"}"#).unwrap();
    assert_eq!(
        refused(s.delete(App::Editor, Kind::Saved, "design")),
        Refusal::WorkspaceNewer {
            id: "design".into(),
            found: 4,
            supported: 1
        }
    );
    assert!(file.exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_index_written_by_a_newer_build_is_left_where_it_is_and_never_written_over() {
    let dir = scratch("newerindex");
    let s = store(&dir);
    let order = dir.join("roaming/editor/order.json");
    std::fs::create_dir_all(order.parent().unwrap()).unwrap();
    let text = r#"{"schemaVersion":2,"ids":["future","a"]}"#;
    std::fs::write(&order, text).unwrap();
    assert_eq!(s.order(App::Editor).unwrap(), Vec::<String>::new());
    assert_eq!(
        std::fs::read_to_string(&order).unwrap(),
        text,
        "not set aside, not changed"
    );
    assert_eq!(names(order.parent().unwrap()), vec!["order.json"]);
    assert_eq!(
        refused(s.set_order(App::Editor, &["a".to_owned()])),
        Refusal::WorkspaceNewer {
            id: "order".into(),
            found: 2,
            supported: 1
        }
    );
    assert_eq!(std::fs::read_to_string(&order).unwrap(), text);
    let active = dir.join("local/editor/active.json");
    std::fs::create_dir_all(active.parent().unwrap()).unwrap();
    std::fs::write(&active, r#"{"schemaVersion":3,"workspaceId":"x"}"#).unwrap();
    assert_eq!(s.active(App::Editor).unwrap(), None);
    assert!(matches!(
        refused(s.set_active(App::Editor, Some("y"))),
        Refusal::WorkspaceNewer { .. }
    ));
    // A broken index is set aside by the write that replaces it.
    std::fs::write(&active, "broken").unwrap();
    s.set_active(App::Editor, Some("y")).unwrap();
    assert_eq!(s.active(App::Editor).unwrap().as_deref(), Some("y"));
    assert_eq!(
        names(active.parent().unwrap())
            .iter()
            .filter(|n| n.contains(".corrupt-"))
            .count(),
        1
    );
    std::fs::remove_dir_all(dir).unwrap();
}
