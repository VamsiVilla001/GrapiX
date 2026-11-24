use super::*;
use gx_contracts::settings::{DefaultInterpolation, LogLevel};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

fn scratch(label: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "gx-settings-{label}-{nanos}-{}",
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn files(dir: &Path) -> (PathBuf, PathBuf) {
    (
        dir.join("user").join("user-settings.json"),
        dir.join("machine").join("machine-settings.json"),
    )
}

fn open(dir: &Path) -> (SettingsStore, LoadReport) {
    let (u, m) = files(dir);
    SettingsStore::open(u, m).unwrap()
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

fn is_refusal_for(result: Result<bool, SettingsError>, key: &str) -> bool {
    matches!(result, Err(SettingsError::Refused(Refusal::SettingInvalid { key: k, .. })) if k == key)
}

#[test]
fn a_new_store_holds_the_defaults_and_writes_nothing_until_something_changes() {
    let dir = scratch("defaults");
    let (store, report) = open(&dir);
    assert_eq!(report, LoadReport::default());
    assert_eq!(store.user(), UserSettings::default());
    assert_eq!(store.machine(), MachineSettings::default());
    assert_eq!(store.revision(), 0);
    let (u, m) = files(&dir);
    assert!(!u.exists() && !m.exists(), "nothing is written by opening");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_change_is_durable_announced_and_the_same_value_again_is_not_a_change() {
    let dir = scratch("change");
    let (store, _) = open(&dir);
    let seen = Arc::new(Mutex::new(Vec::<SettingsChange>::new()));
    let sink = Arc::clone(&seen);
    store.subscribe(move |c| sink.lock().unwrap().push(c.clone()));

    assert!(store
        .set(SettingsScope::User, "language", json!("hi"))
        .unwrap());
    assert!(!store
        .set(SettingsScope::User, "language", json!("hi"))
        .unwrap());
    assert!(store
        .set(SettingsScope::Machine, "logLevel", json!("debug"))
        .unwrap());
    assert_eq!(store.revision(), 2);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            SettingsChange {
                scope: SettingsScope::User,
                key: Some("language".into()),
                revision: 1
            },
            SettingsChange {
                scope: SettingsScope::Machine,
                key: Some("logLevel".into()),
                revision: 2
            },
        ],
        "one announcement per real change"
    );

    // Durable: a second store over the same files reads it back.
    let (again, report) = open(&dir);
    assert_eq!(report, LoadReport::default());
    assert_eq!(again.user().language, "hi");
    assert_eq!(again.machine().log_level, LogLevel::Debug);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_unknown_key_a_wrong_kind_and_an_out_of_range_value_each_refuse_by_name_and_change_nothing() {
    let dir = scratch("refusals");
    let (store, _) = open(&dir);
    let heard = Arc::new(Mutex::new(0u32));
    let counter = Arc::clone(&heard);
    store.subscribe(move |_| *counter.lock().unwrap() += 1);

    assert!(is_refusal_for(
        store.set(SettingsScope::User, "colorDepth", json!("32")),
        "colorDepth"
    ));
    assert!(is_refusal_for(
        store.set(SettingsScope::User, "confirmDeletes", json!("yes")),
        "confirmDeletes"
    ));
    assert!(is_refusal_for(
        store.set(SettingsScope::User, "defaultAnimationFrames", json!(0)),
        "defaultAnimationFrames"
    ));
    assert!(is_refusal_for(
        store.set(SettingsScope::Machine, "textureCacheMb", json!(63)),
        "textureCacheMb"
    ));
    assert!(is_refusal_for(
        store.set(SettingsScope::Machine, "controlPort", json!(80)),
        "controlPort"
    ));
    // A machine key in the user scope is unknown there.
    assert!(is_refusal_for(
        store.set(SettingsScope::User, "controlPort", json!(7788)),
        "controlPort"
    ));
    assert_eq!(store.user(), UserSettings::default());
    assert_eq!(store.machine(), MachineSettings::default());
    assert_eq!(store.revision(), 0);
    assert_eq!(*heard.lock().unwrap(), 0, "a refusal is not announced");
    let (u, m) = files(&dir);
    assert!(!u.exists() && !m.exists(), "a refusal writes nothing");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn user_and_machine_settings_are_two_files_and_never_mix() {
    let dir = scratch("scopes");
    let (store, _) = open(&dir);
    store
        .set(SettingsScope::User, "confirmDeletes", json!(false))
        .unwrap();
    let (u, m) = files(&dir);
    assert!(
        u.is_file() && !m.exists(),
        "a user change writes the user file only"
    );
    let user_text = std::fs::read_to_string(&u).unwrap();
    assert!(!user_text.contains("textureCacheMb") && user_text.contains("confirmDeletes"));
    store
        .set(SettingsScope::Machine, "antiAlias", json!(false))
        .unwrap();
    let machine_text = std::fs::read_to_string(&m).unwrap();
    assert!(!machine_text.contains("confirmDeletes") && machine_text.contains("antiAlias"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn each_change_keeps_the_last_good_copy_and_leaves_no_temporary_file() {
    let dir = scratch("backup");
    let (store, _) = open(&dir);
    let (u, _) = files(&dir);
    store
        .set(SettingsScope::User, "language", json!("fr"))
        .unwrap();
    assert!(
        !backup_of(&u).exists(),
        "the first write has nothing to back up"
    );
    store
        .set(SettingsScope::User, "language", json!("de"))
        .unwrap();
    let backup = std::fs::read_to_string(backup_of(&u)).unwrap();
    assert!(
        backup.contains("\"fr\""),
        "the copy is what the file held before: {backup}"
    );
    assert!(std::fs::read_to_string(&u).unwrap().contains("\"de\""));
    assert_eq!(
        names(u.parent().unwrap()),
        vec![
            "user-settings.json".to_owned(),
            "user-settings.json.bak".to_owned()
        ]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_unreadable_file_is_set_aside_and_the_last_good_copy_is_used() {
    let dir = scratch("recover");
    let (u, _) = files(&dir);
    {
        let (store, _) = open(&dir);
        store
            .set(SettingsScope::User, "language", json!("fr"))
            .unwrap();
        store
            .set(SettingsScope::User, "language", json!("de"))
            .unwrap();
    }
    std::fs::write(&u, b"{ this is not json").unwrap();
    let (store, report) = open(&dir);
    assert_eq!(report.recovered_from_backup, vec![SettingsScope::User]);
    assert!(report.reset_to_defaults.is_empty());
    assert_eq!(
        store.user().language,
        "fr",
        "the backup held the value before the last change"
    );
    assert_eq!(report.set_aside.len(), 1);
    assert_eq!(
        std::fs::read(&report.set_aside[0]).unwrap(),
        b"{ this is not json",
        "the bad file is kept, not deleted"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_unreadable_file_with_no_good_copy_falls_back_to_the_defaults_and_says_so() {
    let dir = scratch("defaults-fallback");
    let (_, m) = files(&dir);
    std::fs::create_dir_all(m.parent().unwrap()).unwrap();
    // A file from a build that added a setting without a schema bump: unknown fields refuse.
    let mut value = serde_json::to_value(Document {
        schema_version: SETTINGS_SCHEMA_VERSION,
        settings: MachineSettings::default(),
    })
    .unwrap();
    value["settings"]["fromTheFuture"] = json!(1);
    std::fs::write(&m, serde_json::to_vec(&value).unwrap()).unwrap();
    let (store, report) = open(&dir);
    assert_eq!(report.reset_to_defaults, vec![SettingsScope::Machine]);
    assert_eq!(store.machine(), MachineSettings::default());
    assert_eq!(report.set_aside.len(), 1);
    assert!(report.set_aside[0].exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_file_from_a_newer_schema_is_refused_and_left_exactly_as_it_was() {
    let dir = scratch("newer");
    let (u, _) = files(&dir);
    std::fs::create_dir_all(u.parent().unwrap()).unwrap();
    let text = br#"{"schemaVersion": 99, "settings": {"somethingNew": true}}"#;
    std::fs::write(&u, text).unwrap();
    let (user_file, machine_file) = files(&dir);
    let error = SettingsStore::open(user_file, machine_file)
        .err()
        .expect("a newer file refuses");
    assert!(
        matches!(error, SettingsError::NewerSchema { found: 99, .. }),
        "{error}"
    );
    assert_eq!(std::fs::read(&u).unwrap(), text, "untouched");
    assert_eq!(
        names(u.parent().unwrap()),
        vec!["user-settings.json".to_owned()]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn reset_puts_back_one_setting_or_the_whole_scope_and_says_when_nothing_changed() {
    let dir = scratch("reset");
    let (store, _) = open(&dir);
    store
        .set(SettingsScope::User, "language", json!("hi"))
        .unwrap();
    store
        .set(SettingsScope::User, "defaultInterpolation", json!("bezier"))
        .unwrap();
    assert!(store.reset(SettingsScope::User, Some("language")).unwrap());
    assert_eq!(store.user().language, "en");
    assert_eq!(
        store.user().default_interpolation,
        DefaultInterpolation::Bezier
    );
    assert!(!store.reset(SettingsScope::User, Some("language")).unwrap());
    assert!(is_refusal_for(
        store.reset(SettingsScope::User, Some("nope")),
        "nope"
    ));

    let seen = Arc::new(Mutex::new(Vec::<SettingsChange>::new()));
    let sink = Arc::clone(&seen);
    store.subscribe(move |c| sink.lock().unwrap().push(c.clone()));
    assert!(store.reset(SettingsScope::User, None).unwrap());
    assert_eq!(store.user(), UserSettings::default());
    assert!(!store.reset(SettingsScope::User, None).unwrap());
    assert!(!store.reset(SettingsScope::Machine, None).unwrap());
    let changes = seen.lock().unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].key, None, "a whole-scope reset names no key");
    std::fs::remove_dir_all(dir).unwrap();
}
