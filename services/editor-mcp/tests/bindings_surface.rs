//! `bindings.schema` (build plan 8.6) driven over the real JSON-RPC transport.
//!
//! The unit tests in `src/lib.rs` prove the handler body. This proves the
//! declared tool answers through the server an agent actually talks to: a
//! registry entry with no reachable handler would satisfy every unit test and
//! still leave the schema undiscoverable, which is the whole of 8.6's
//! done-when.

use gx_contracts::auth::Scope;
use gx_contracts::scene::SceneDocument;
use gx_editor::Projects;
use gx_editor_mcp::BindingsSchema;
use gx_mcp_server::Server;

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
    server.register("bindings.schema", Box::new(BindingsSchema(projects.clone())));
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
    projects.write_scene("news", &seeded).expect("the fixture is stored");
    let server = server_with(&projects, vec![Scope::Author]);

    let replies = drive(
        &server,
        &[call(
            1,
            "bindings.schema",
            serde_json::json!({ "project": "news", "scene_id": "scorebug" }),
        )],
    );
    assert!(replies[0]["error"].is_null(), "unexpected refusal: {}", replies[0]);
    let schema = &replies[0]["result"];

    assert_eq!(schema["sceneId"], "scorebug");
    assert_eq!(schema["dataContext"], scene()["dataContext"]);
    assert_eq!(
        schema["dataContext"]["match"]["alpha"].as_f64().map(f64::to_bits),
        Some((48.0_f64 / 255.0).to_bits()),
        "the data context crosses the wire bit for bit"
    );
    assert_eq!(
        schema["fields"],
        serde_json::json!({
            "flags.0": [{ "object": "bar", "property": "visible" }],
            "match.home.score": [{ "object": "bar", "property": "x" }],
            "match.referee.x": [{ "object": "referee", "property": "x" }],
        })
    );
    assert_eq!(
        schema["invalid"],
        serde_json::json!([{
            "object": "referee",
            "property": "y",
            "binding": 7,
            "reason": "binding path is not a string",
        }])
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
    assert!(replies[0]["result"].is_null(), "an unscoped caller got a result: {}", replies[0]);
    assert!(!replies[0]["error"].is_null());
    std::fs::remove_dir_all(root).expect("clean up");
}
