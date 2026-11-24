//! The Editor shell's workspace commands (build plan 11.94 and 2.29).
//!
//! The page keeps its saved panel arrangements through these. Each function takes the store as an
//! argument, so the tests run against a scratch folder and never touch the user's own. The Tauri
//! commands in `lib.rs` pass the store in its usual places.
//!
//! Nothing here reads or changes a scene, the selection, the undo history or any output: a workspace is
//! interface state.

use gx_workspace_store::{App, Kind, Read, WorkspaceError, WorkspaceStore};
use serde::Serialize;
use serde_json::Value;

use crate::EditorError;

/// What reading one workspace found, as the page receives it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "read", rename_all = "camelCase")]
pub enum WorkspaceRead {
    /// There is no such file.
    Missing,
    /// The document, as stored.
    Found { value: Value },
    /// The file did not read and was renamed to `aside`. `backup` is the copy the last write replaced, if
    /// that reads.
    #[serde(rename_all = "camelCase")]
    SetAside {
        aside: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        backup: Option<Value>,
    },
    /// The file was written by a newer build and is untouched.
    Newer { found: u64, supported: u32 },
}

fn error(error: WorkspaceError) -> EditorError {
    match error {
        WorkspaceError::Refused(cause) => crate::refused(cause),
        other => EditorError::ProjectFailed {
            detail: other.to_string(),
        },
    }
}

fn invalid(what: &str, given: &str) -> EditorError {
    crate::refused(gx_contracts::Refusal::WorkspaceInvalid {
        id: given.to_owned(),
        detail: format!("{what} is not one the store knows"),
    })
}

fn app(text: &str) -> Result<App, EditorError> {
    App::parse(text).ok_or_else(|| invalid("an application", text))
}

fn kind(text: &str) -> Result<Kind, EditorError> {
    Kind::parse(text).ok_or_else(|| invalid("a kind of workspace", text))
}

pub fn get(
    store: &WorkspaceStore,
    app_name: &str,
    kind_name: &str,
    id: &str,
) -> Result<WorkspaceRead, EditorError> {
    Ok(
        match store
            .get(app(app_name)?, kind(kind_name)?, id)
            .map_err(error)?
        {
            Read::Missing => WorkspaceRead::Missing,
            Read::Found(value) => WorkspaceRead::Found { value },
            Read::SetAside { aside, backup } => WorkspaceRead::SetAside {
                aside: aside.display().to_string(),
                backup,
            },
            Read::Newer { found, supported } => WorkspaceRead::Newer { found, supported },
        },
    )
}

pub fn put(
    store: &WorkspaceStore,
    app_name: &str,
    kind_name: &str,
    id: &str,
    value: &Value,
) -> Result<(), EditorError> {
    store
        .put(app(app_name)?, kind(kind_name)?, id, value)
        .map_err(error)
}

pub fn delete(
    store: &WorkspaceStore,
    app_name: &str,
    kind_name: &str,
    id: &str,
) -> Result<bool, EditorError> {
    store
        .delete(app(app_name)?, kind(kind_name)?, id)
        .map_err(error)
}

pub fn list(
    store: &WorkspaceStore,
    app_name: &str,
    kind_name: &str,
) -> Result<Vec<String>, EditorError> {
    store.list(app(app_name)?, kind(kind_name)?).map_err(error)
}

pub fn active(store: &WorkspaceStore, app_name: &str) -> Result<Option<String>, EditorError> {
    store.active(app(app_name)?).map_err(error)
}

pub fn set_active(
    store: &WorkspaceStore,
    app_name: &str,
    id: Option<&str>,
) -> Result<(), EditorError> {
    store.set_active(app(app_name)?, id).map_err(error)
}

pub fn order(store: &WorkspaceStore, app_name: &str) -> Result<Vec<String>, EditorError> {
    store.order(app(app_name)?).map_err(error)
}

pub fn set_order(
    store: &WorkspaceStore,
    app_name: &str,
    ids: &[String],
) -> Result<(), EditorError> {
    store.set_order(app(app_name)?, ids).map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gx-editor-workspaces-{label}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(dir: &std::path::Path) -> WorkspaceStore {
        WorkspaceStore::open(
            dir.join("roaming"),
            dir.join("local"),
            gx_workspace_store::LAYOUT_SCHEMA_VERSION,
        )
    }

    fn doc(id: &str) -> Value {
        json!({ "schemaVersion": 1, "workspaceId": id, "name": "Mine" })
    }

    fn refusal_code(result: Result<impl std::fmt::Debug, EditorError>) -> String {
        match result {
            Err(EditorError::CommandRefused { cause, .. }) => serde_json::to_value(&cause).unwrap()
                ["refusal"]
                .as_str()
                .unwrap()
                .to_owned(),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_workspace_is_kept_and_read_back_in_the_form_the_page_receives() {
        let dir = scratch("roundtrip");
        let s = store(&dir);
        assert_eq!(
            serde_json::to_value(get(&s, "editor", "saved", "mine").unwrap()).unwrap(),
            json!({ "read": "missing" })
        );
        put(&s, "editor", "saved", "mine", &doc("mine")).unwrap();
        assert_eq!(
            serde_json::to_value(get(&s, "editor", "saved", "mine").unwrap()).unwrap(),
            json!({ "read": "found", "value": doc("mine") })
        );
        assert_eq!(list(&s, "editor", "saved").unwrap(), vec!["mine"]);
        assert!(delete(&s, "editor", "saved", "mine").unwrap());
        assert!(!delete(&s, "editor", "saved", "mine").unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_that_does_not_read_and_a_newer_file_reach_the_page_by_name() {
        let dir = scratch("odd");
        let s = store(&dir);
        let folder = dir.join("roaming/editor/saved");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("broken.json"), "{ nope").unwrap();
        let broken = serde_json::to_value(get(&s, "editor", "saved", "broken").unwrap()).unwrap();
        assert_eq!(broken["read"], "setAside");
        assert!(broken["aside"]
            .as_str()
            .unwrap()
            .contains("broken.json.corrupt-"));
        assert!(
            broken.get("backup").is_none(),
            "no backup: the field is left out"
        );
        std::fs::write(
            folder.join("future.json"),
            r#"{"schemaVersion":3,"workspaceId":"future"}"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(get(&s, "editor", "saved", "future").unwrap()).unwrap(),
            json!({ "read": "newer", "found": 3, "supported": 1 })
        );
        assert_eq!(
            refusal_code(put(&s, "editor", "saved", "future", &doc("future"))),
            "workspaceNewer"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unknown_application_a_kind_or_an_unsafe_id_is_refused_by_name_and_writes_nothing() {
        let dir = scratch("refuse");
        let s = store(&dir);
        assert_eq!(
            refusal_code(get(&s, "viewer", "saved", "mine")),
            "workspaceInvalid"
        );
        assert_eq!(
            refusal_code(get(&s, "editor", "last-good", "mine")),
            "workspaceInvalid"
        );
        assert_eq!(
            refusal_code(put(&s, "editor", "saved", "../x", &doc("x"))),
            "workspaceInvalid"
        );
        assert_eq!(
            refusal_code(put(&s, "editor", "saved", "mine", &json!([1]))),
            "workspaceInvalid"
        );
        assert_eq!(
            refusal_code(set_active(&s, "editor", Some("A b"))),
            "workspaceInvalid"
        );
        assert_eq!(
            refusal_code(set_order(&s, "editor", &["a".into(), "a".into()])),
            "workspaceInvalid"
        );
        assert!(!dir.join("roaming").exists() && !dir.join("local").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_workspace_in_use_and_the_order_are_kept_for_each_application() {
        let dir = scratch("indexes");
        let s = store(&dir);
        set_active(&s, "editor", Some("mine")).unwrap();
        set_active(&s, "playout", Some("operator")).unwrap();
        assert_eq!(active(&s, "editor").unwrap().as_deref(), Some("mine"));
        assert_eq!(active(&s, "playout").unwrap().as_deref(), Some("operator"));
        set_order(&s, "editor", &["b".into(), "a".into()]).unwrap();
        assert_eq!(order(&s, "editor").unwrap(), vec!["b", "a"]);
        assert_eq!(order(&s, "playout").unwrap(), Vec::<String>::new());
        set_active(&s, "editor", None).unwrap();
        assert_eq!(active(&s, "editor").unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
