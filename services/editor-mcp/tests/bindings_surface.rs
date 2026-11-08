//! `bindings.schema` (build plan 8.6) driven over the real JSON-RPC transport.
//!
//! The unit tests in `src/lib.rs` prove the handler body. This proves the
//! declared tool answers through the server an agent actually talks to: a
//! registry entry with no reachable handler would satisfy every unit test and
//! still leave the schema undiscoverable, which is the whole of 8.6's
//! done-when.

mod support;

use gx_contracts::auth::Scope;
use gx_contracts::scene::SceneDocument;
use gx_editor::Projects;
use gx_editor_mcp::BindingsSchema;
use gx_mcp_server::Server;
// The shipped binary is driven through the shared conformant client (8.14):
// real handshake, one request at a time, the value read from
// `structuredContent`. The in-process tests below keep `drive`.
use support::shipped_session;

fn drive(server: &Server, requests: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let input: String = requests
        .iter()
        .map(|request| format!("{request}\n"))
        .collect();
    let mut output = Vec::new();
    server
        .serve(std::io::BufReader::new(input.as_bytes()), &mut output)
        .expect("the transport writes its replies");
    String::from_utf8(output)
        .expect("replies are UTF-8")
        .lines()
        .map(|line| serde_json::from_str(line).expect("each reply is one JSON object"))
        .collect()
}

fn call(id: u64, tool: &str, arguments: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    })
}

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-bindings-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn server_with(projects: &Projects, scopes: Vec<Scope>) -> Server {
    let mut server = Server::new(scopes);
    server.register(
        "bindings.schema",
        Box::new(BindingsSchema(projects.clone())),
    );
    server
}

/// A scene as an agent would read it: nested data, an array path, one path
/// the data context lacks and one binding that is not a path at all. Seeded
/// through the store, because no MCP write accepts a whole document.
fn scene() -> serde_json::Value {
    serde_json::json!({
        "id": "scorebug",
        "name": "Scorebug",
        "version": 3,
        "workingColorSpace": "srgb",
        "canvas": { "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 } },
        "dataContext": {
            "match": { "home": { "name": "Rovers", "score": 2 }, "alpha": 0.18823529411764706 },
            "flags": [true, false]
        },
        "objects": [
            {
                "type": "rect", "id": "bar", "name": "Bar",
                "bindings": { "x": "match.home.score", "visible": "flags.0" }
            },
            {
                "type": "rect", "id": "referee", "name": "Referee",
                "bindings": { "x": "match.referee.x", "y": 7 }
            }
        ]
    })
}

#[test]
fn an_agent_discovers_a_scenes_data_schema_over_the_wire() {
    let root = scratch("schema");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    let seeded: SceneDocument = serde_json::from_value(scene()).expect("the fixture is a scene");
    projects
        .write_scene("news", &seeded)
        .expect("the fixture is stored");
    let server = server_with(&projects, vec![Scope::Author]);

    let replies = drive(
        &server,
        &[call(
            1,
            "bindings.schema",
            serde_json::json!({ "project": "news", "scene_id": "scorebug" }),
        )],
    );
    assert!(
        replies[0]["error"].is_null(),
        "unexpected refusal: {}",
        replies[0]
    );
    let schema = &replies[0]["result"];

    assert_eq!(schema["sceneId"], "scorebug");
    assert_eq!(schema["dataContext"], scene()["dataContext"]);
    assert_eq!(
        schema["dataContext"]["match"]["alpha"]
            .as_f64()
            .map(f64::to_bits),
        Some((48.0_f64 / 255.0).to_bits()),
        "the data context crosses the wire bit for bit"
    );
    assert_eq!(
        schema["fields"],
        serde_json::json!({
            "flags.0": [{ "object": "bar", "property": "visible", "expects": "boolean" }],
            "match.home.score": [{ "object": "bar", "property": "x", "expects": "number" }],
            "match.referee.x": [{ "object": "referee", "property": "x", "expects": "number" }],
        })
    );
    assert_eq!(
        schema["invalid"],
        serde_json::json!([
            {
                "object": "referee",
                "property": "x",
                "binding": "match.referee.x",
                "reason": "match.referee.x is absent from the scene data context",
            },
            {
                "object": "referee",
                "property": "y",
                "binding": 7,
                "reason": "y binding on referee must be a string path",
            },
        ])
    );
    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn the_schema_is_gated_by_the_transport_not_the_handler() {
    // A caller with no scopes is refused before the handler is reached, and
    // the refusal is an error reply rather than an empty schema.
    let root = scratch("gate");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    let server = server_with(&projects, Vec::new());

    let replies = drive(
        &server,
        &[call(
            1,
            "bindings.schema",
            serde_json::json!({ "project": "news", "scene_id": "scorebug" }),
        )],
    );
    assert!(
        replies[0]["result"].is_null(),
        "an unscoped caller got a result: {}",
        replies[0]
    );
    assert!(!replies[0]["error"].is_null());
    std::fs::remove_dir_all(root).expect("clean up");
}

/// 8.6 against the entry point an agent launches: the data schema is
/// discoverable with every consumer of a shared field and the type it
/// expects; a binding that would not apply is named with its reason; a write
/// of a path the data lacks is refused by name and changes nothing; a valid
/// binding written through `scenes.edit` is in the schema a second process
/// reads back from the project store.
#[test]
fn the_shipped_editor_mcp_discovers_bindings_and_refuses_bad_paths_by_name() {
    let root = scratch("shipped");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    let seeded: SceneDocument = serde_json::from_value(scene()).expect("the fixture is a scene");
    projects
        .write_scene("news", &seeded)
        .expect("the fixture is stored");
    let schema_call = |id: u64| {
        call(
            id,
            "bindings.schema",
            serde_json::json!({ "project": "news", "scene_id": "scorebug" }),
        )
    };
    let edit = |id: u64, edits: serde_json::Value| {
        call(
            id,
            "scenes.edit",
            serde_json::json!({ "target": { "target": "stored", "project": "news", "sceneId": "scorebug" }, "edits": edits }),
        )
    };

    let replies = shipped_session(
        &root,
        &[
            schema_call(1),
            // A path the data context lacks: refused by name, nothing written.
            edit(
                2,
                serde_json::json!([{ "edit": "setBinding", "objectId": "referee", "property": "y", "path": "match.away.score" }]),
            ),
            // A second consumer of an existing field.
            edit(
                3,
                serde_json::json!([{ "edit": "setBinding", "objectId": "referee", "property": "y", "path": "match.home.score" }]),
            ),
        ],
    );

    let schema = &replies[0]["result"];
    assert!(replies[0]["error"].is_null(), "{}", replies[0]);
    assert_eq!(
        schema["fields"]["match.home.score"],
        serde_json::json!([{ "object": "bar", "property": "x", "expects": "number" }])
    );
    let invalid: Vec<(&str, &str)> = schema["invalid"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| {
            (
                issue["property"].as_str().unwrap(),
                issue["reason"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        invalid,
        [
            ("x", "match.referee.x is absent from the scene data context"),
            ("y", "y binding on referee must be a string path"),
        ]
    );

    let refused = &replies[1];
    assert!(
        refused["result"].is_null(),
        "a bad path was accepted: {refused}"
    );
    assert_eq!(
        refused["error"]["data"]["code"]["refusal"], "bindingPathInvalid",
        "{refused}"
    );
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("match.away.score"),
        "{refused}"
    );
    assert!(
        replies[2]["error"].is_null(),
        "the valid binding was refused: {}",
        replies[2]
    );

    // A new process reads the project store: the written binding is there and
    // the refused one is not.
    let reread = shipped_session(&root, &[schema_call(4)]);
    let schema = &reread[0]["result"];
    assert_eq!(
        schema["fields"]["match.home.score"],
        serde_json::json!([
            { "object": "bar", "property": "x", "expects": "number" },
            { "object": "referee", "property": "y", "expects": "number" },
        ])
    );
    assert!(schema["fields"].get("match.away.score").is_none());
    assert_eq!(
        schema["invalid"].as_array().map(Vec::len),
        Some(1),
        "only the unresolved x remains: {}",
        schema["invalid"]
    );
    std::fs::remove_dir_all(root).expect("clean up");
}
