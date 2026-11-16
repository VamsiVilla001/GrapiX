//! 8.12 over the shipped `gx-editor-mcp` binary: `ifRevision`, idempotency
//! keys and the batch as one write, on the real wire and across processes.
//!
//! The done-when is "a retry after a timeout does not duplicate". A timeout is
//! a reply the client never read: the write landed, the answer was lost, and
//! the client tries again, often through a new server process because a stdio
//! server lives as long as its client session. So the retries here go to a
//! second process, and the write being retried is one that would visibly
//! duplicate if run twice: `createObject`, which mints a new object each time.

mod support;

use std::path::PathBuf;
use std::time::Duration;

use gx_contracts::color::WorkingColorSpace;
use gx_contracts::scene::{new_scene, SceneDocument};
use gx_editor::Projects;
use support::{call, Session};

fn scratch(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "gx-editor-mcp-write-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    projects
        .write_scene(
            "news",
            &new_scene("bug", "Bug", WorkingColorSpace::NEW_PROJECT),
        )
        .expect("an empty scene is stored");
    root
}

fn stored(root: &std::path::Path) -> SceneDocument {
    Projects::at_root(root)
        .read_scene("news", "bug")
        .expect("the scene is stored")
}

fn object_ids(scene: &SceneDocument) -> Vec<String> {
    scene
        .objects
        .iter()
        .map(|object| object.base().id.clone())
        .collect()
}

/// `scenes.edit` creating one rect, with the revision read and an optional key.
fn create_rect(id: u64, revision: u64, key: Option<&str>, name: &str) -> serde_json::Value {
    let mut arguments = serde_json::json!({
        "target": { "target": "stored", "project": "news", "sceneId": "bug" },
        "edits": [{ "edit": "createObject", "kind": "rect", "name": name }],
        "ifRevision": revision,
    });
    if let Some(key) = key {
        arguments["idempotencyKey"] = serde_json::json!(key);
    }
    call(id, "scenes.edit", arguments)
}

fn refusal(reply: &serde_json::Value) -> &serde_json::Value {
    assert!(reply["result"].is_null(), "expected a refusal: {reply}");
    &reply["error"]["data"]["code"]["refusal"]
}

#[test]
fn a_retry_after_a_lost_reply_returns_the_first_answer_and_writes_once() {
    let root = scratch("retry");

    // The first attempt: the write lands, and the client never reads the
    // reply. The process is then gone, as it is when a client times out and
    // reconnects.
    let mut first = Session::start(&root);
    first.send(&create_rect(1, 0, Some("op-create-card"), "Card"));
    let lost = first
        .next_reply(Duration::from_secs(60))
        .expect("the server answered; the client did not read it");
    first.finish();
    assert_eq!(
        object_ids(&stored(&root)),
        ["rect-1"],
        "the first attempt landed"
    );

    // The retry, through a new process, with the same key and arguments.
    let mut second = Session::start(&root);
    let retried = second.call(&create_rect(2, 0, Some("op-create-card"), "Card"));
    assert!(retried["error"].is_null(), "a retry is answered: {retried}");
    assert_eq!(
        object_ids(&stored(&root)),
        ["rect-1"],
        "the retry did not duplicate the object"
    );
    assert_eq!(retried["result"]["revision"], 1, "{retried}");
    // The answer is the first answer, value for value.
    assert_eq!(
        retried["result"], lost["result"]["structuredContent"],
        "the retry returns the first result"
    );

    // The same key on another request is refused by name, and writes nothing.
    let reused = second.call(&create_rect(3, 1, Some("op-create-card"), "Plate"));
    assert_eq!(refusal(&reused), "idempotencyKeyReused", "{reused}");
    assert_eq!(object_ids(&stored(&root)), ["rect-1"]);

    // A new key is a new write.
    let next = second.call(&create_rect(4, 1, Some("op-create-plate"), "Plate"));
    assert!(next["error"].is_null(), "{next}");
    assert_eq!(object_ids(&stored(&root)), ["rect-1", "rect-2"]);
    assert_eq!(next["result"]["revision"], 2);
    second.finish();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_stale_or_missing_revision_writes_nothing_and_says_which_is_current() {
    let root = scratch("stale");
    let mut session = Session::start(&root);

    // Without ifRevision a write to a stored scene is refused by name.
    let missing = session.call(&call(
        1,
        "scenes.edit",
        serde_json::json!({
            "target": { "target": "stored", "project": "news", "sceneId": "bug" },
            "edits": [{ "edit": "setSceneName", "name": "Renamed" }],
        }),
    ));
    assert_eq!(refusal(&missing), "revisionRequired", "{missing}");
    let deleted = session.call(&call(
        2,
        "scenes.delete",
        serde_json::json!({ "project": "news", "sceneId": "bug" }),
    ));
    assert_eq!(refusal(&deleted), "revisionRequired", "{deleted}");
    assert_eq!(stored(&root).name, "Bug");

    // A batch of three edits is one write and one revision, not three.
    let batch = session.call(&call(
        3,
        "scenes.edit",
        serde_json::json!({
            "target": { "target": "stored", "project": "news", "sceneId": "bug" },
            "edits": [
                { "edit": "setSceneName", "name": "Renamed" },
                { "edit": "createObject", "kind": "rect", "name": "Card" },
                { "edit": "renameObject", "objectId": "rect-1", "name": "Card B" },
            ],
            "ifRevision": 0,
        }),
    ));
    assert!(batch["error"].is_null(), "{batch}");
    assert_eq!(batch["result"]["revision"], 1, "{batch}");
    let after = stored(&root);
    assert_eq!(after.revision, Some(gx_contracts::Revision(1)));

    // The writer that read revision 0 has lost: refused, current named.
    let stale = session.call(&create_rect(4, 0, None, "Late"));
    assert_eq!(refusal(&stale), "revisionMismatch", "{stale}");
    let message = stale["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("expected 0") && message.contains("got 1"),
        "the refusal names both revisions: {stale}"
    );
    assert_eq!(stored(&root), after, "a stale write changed nothing");

    // A stale delete keeps the scene; a current one removes it.
    let stale_delete = session.call(&call(
        5,
        "scenes.delete",
        serde_json::json!({ "project": "news", "sceneId": "bug", "ifRevision": 0 }),
    ));
    assert_eq!(refusal(&stale_delete), "revisionMismatch", "{stale_delete}");
    assert_eq!(stored(&root), after);

    // scenes.get reports the revision to send next.
    let read = session.call(&call(
        6,
        "scenes.get",
        serde_json::json!({ "project": "news", "scene_id": "bug" }),
    ));
    assert_eq!(read["result"]["revision"], 1, "{read}");
    let removed = session.call(&call(
        7,
        "scenes.delete",
        serde_json::json!({ "project": "news", "sceneId": "bug", "ifRevision": 1 }),
    ));
    assert!(removed["error"].is_null(), "{removed}");
    assert!(Projects::at_root(&root)
        .list_scenes("news")
        .unwrap()
        .is_empty());
    session.finish();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn writers_racing_on_one_revision_land_exactly_once() {
    // Four server processes, each holding revision 0, write at once. The
    // store's lock makes each read-check-write one step: one lands, three are
    // told the revision moved on. Without the lock two could read 0 and the
    // last would silently overwrite the first.
    let root = scratch("race");
    let replies: Vec<serde_json::Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4u64)
            .map(|index| {
                let root = root.clone();
                scope.spawn(move || {
                    let mut session = Session::start(&root);
                    let reply =
                        session.call(&create_rect(10 + index, 0, None, &format!("Card {index}")));
                    session.finish();
                    reply
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    let landed = replies
        .iter()
        .filter(|reply| reply["error"].is_null())
        .count();
    let lost: Vec<_> = replies
        .iter()
        .filter(|reply| !reply["error"].is_null())
        .map(|reply| reply["error"]["data"]["code"]["refusal"].clone())
        .collect();
    assert_eq!(landed, 1, "exactly one writer lands: {replies:?}");
    assert_eq!(lost, vec![serde_json::json!("revisionMismatch"); 3]);
    let scene = stored(&root);
    assert_eq!(object_ids(&scene), ["rect-1"]);
    assert_eq!(scene.revision, Some(gx_contracts::Revision(1)));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_retry_racing_the_first_attempt_waits_for_it_and_replays_it() {
    // The client timed out while the first attempt was still running, and its
    // retry reaches another process at the same time. The ledger is locked for
    // the whole lookup-execute-record, so one runs and the other replays.
    let root = scratch("retry-race");
    let replies: Vec<serde_json::Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..3u64)
            .map(|index| {
                let root = root.clone();
                scope.spawn(move || {
                    let mut session = Session::start(&root);
                    let reply = session.call(&create_rect(20 + index, 0, Some("op-race"), "Card"));
                    session.finish();
                    reply
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    for reply in &replies {
        assert!(
            reply["error"].is_null(),
            "every attempt is answered: {reply}"
        );
        assert_eq!(reply["result"], replies[0]["result"], "one answer for all");
    }
    assert_eq!(object_ids(&stored(&root)), ["rect-1"], "written once");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_create_retried_with_its_key_is_answered_not_refused() {
    // Without a key a retried create is refused sceneAlreadyExists: safe, but
    // the agent cannot tell its own create from someone else's. With the key
    // it gets its own first answer back.
    let root = scratch("create");
    let create = |id: u64, key: Option<&str>| {
        let mut arguments =
            serde_json::json!({ "project": "news", "sceneId": "card", "name": "Card" });
        if let Some(key) = key {
            arguments["idempotencyKey"] = serde_json::json!(key);
        }
        call(id, "scenes.create", arguments)
    };
    let mut session = Session::start(&root);
    let first = session.call(&create(1, Some("op-new-card")));
    assert!(first["error"].is_null(), "{first}");
    assert_eq!(first["result"]["revision"], 0, "a new scene is revision 0");
    session.finish();
    let mut session = Session::start(&root);
    let retried = session.call(&create(2, Some("op-new-card")));
    assert_eq!(retried["result"], first["result"], "{retried}");
    let unkeyed = session.call(&create(3, None));
    assert_eq!(refusal(&unkeyed), "sceneAlreadyExists", "{unkeyed}");
    // A malformed key is refused before anything runs.
    let mut bad = create(4, None);
    bad["params"]["arguments"]["idempotencyKey"] = serde_json::json!("");
    let bad = session.call(&bad);
    assert!(bad["result"].is_null(), "{bad}");
    assert!(
        bad["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("idempotencyKey")),
        "{bad}"
    );
    session.finish();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn every_editor_write_lists_the_key_and_the_revision_in_its_schema() {
    let root = scratch("schema");
    let mut session = Session::start(&root);
    let listed = session.request(&serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {},
    }));
    session.finish();
    let tools = listed["result"]["tools"].as_array().expect("tools");
    let writes: Vec<&serde_json::Value> = tools
        .iter()
        .filter(|tool| tool["annotations"]["readOnlyHint"] == false)
        .collect();
    assert!(!writes.is_empty());
    for tool in &writes {
        let name = tool["name"].as_str().unwrap();
        let properties = &tool["inputSchema"]["properties"];
        assert_eq!(
            properties["idempotencyKey"]["type"], "string",
            "{name} lists idempotencyKey"
        );
        if name == "scenes.edit" || name == "scenes.delete" {
            assert!(
                properties.get("ifRevision").is_some(),
                "{name} lists ifRevision"
            );
        }
    }
    let _ = std::fs::remove_dir_all(root);
}
