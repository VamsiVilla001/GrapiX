//! The shipped `gx-editor-mcp` binary over stateless streamable HTTP (build
//! plan 8.14): `gx-editor-mcp --root <dir> --http <port>` serves the same
//! tools, through the same scope gate, on 127.0.0.1 only.

mod support;

use gx_contracts::scene::SceneDocument;
use gx_editor::Projects;
use support::{
    call, initialize_request, post, stateless, tool_reply, HttpProcess, STATELESS_VERSION,
};

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-http-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn seeded(label: &str) -> std::path::PathBuf {
    let root = scratch(label);
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    let scene: SceneDocument = serde_json::from_value(serde_json::json!({
        "id": "scorebug",
        "name": "Scorebug",
        "version": 3,
        "workingColorSpace": "srgb",
        "canvas": { "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 } },
        "dataContext": { "match": { "home": { "score": 2 } } },
        "objects": [
            { "type": "rect", "id": "bar", "name": "Bar", "bindings": { "x": "match.home.score" } }
        ]
    }))
    .expect("the fixture is a scene");
    projects
        .write_scene("news", &scene)
        .expect("the fixture is stored");
    root
}

/// The headers SEP-2243 asks a 2026-07-28 client to send with a tool call.
fn stateless_headers(tool: &str) -> Vec<(&'static str, String)> {
    vec![
        ("MCP-Protocol-Version", STATELESS_VERSION.to_owned()),
        ("Mcp-Method", "tools/call".to_owned()),
        ("Mcp-Name", tool.to_owned()),
    ]
}

fn headers<'a>(owned: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    owned
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect()
}

#[test]
fn a_2026_07_28_client_calls_a_tool_over_http() {
    let root = seeded("call");
    let server = HttpProcess::launch(&root);
    assert!(server.addr.ip().is_loopback(), "{}", server.addr);
    assert_eq!(server.addr.ip().to_string(), "127.0.0.1");

    let request = stateless(call(
        1,
        "bindings.schema",
        serde_json::json!({ "project": "news", "scene_id": "scorebug" }),
    ));
    let owned = stateless_headers("bindings.schema");
    let reply = server.post(&headers(&owned), &request);
    assert_eq!(reply.status, 200, "{reply:?}");
    assert!(
        reply
            .header("content-type")
            .is_some_and(|value| value.contains("application/json")),
        "{reply:?}"
    );
    let reply = tool_reply(reply.json());
    assert!(reply["error"].is_null(), "{reply}");
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"]["sceneId"], "scorebug");
    assert_eq!(
        reply["result"]["fields"]["match.home.score"],
        serde_json::json!([{ "object": "bar", "property": "x", "expects": "number" }])
    );
    // Stateless: no session is handed out.
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_refusal_over_http_is_the_same_structured_error() {
    let root = seeded("refusal");
    let server = HttpProcess::launch(&root);
    let edit = stateless(call(
        2,
        "scenes.edit",
        serde_json::json!({
            "target": { "target": "stored", "project": "news", "sceneId": "scorebug" },
            "edits": [{ "edit": "setBinding", "objectId": "bar", "property": "y", "path": "match.away.score" }],
        }),
    ));
    let owned = stateless_headers("scenes.edit");
    let reply = server.post(&headers(&owned), &edit).json();
    assert!(
        reply["result"].is_null(),
        "a bad path was accepted: {reply}"
    );
    assert_eq!(reply["error"]["code"], -32000, "{reply}");
    assert_eq!(
        reply["error"]["data"]["code"]["refusal"], "bindingPathInvalid",
        "{reply}"
    );

    // Operator tools stay behind their scope on this transport too.
    let owned = stateless_headers("playout.take");
    let take = server
        .post(
            &headers(&owned),
            &stateless(call(3, "playout.take", serde_json::json!({}))),
        )
        .json();
    assert_eq!(
        take["error"]["data"]["code"]["refusal"], "unauthenticated",
        "{take}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_2025_06_18_client_negotiates_over_http() {
    let root = seeded("legacy");
    let server = HttpProcess::launch(&root);
    let reply = server.post(&[], &initialize_request("2026-07-28"));
    assert_eq!(reply.status, 200, "{reply:?}");
    assert_eq!(
        reply.json()["result"]["protocolVersion"],
        "2025-06-18",
        "{reply:?}"
    );
    assert!(
        reply.header("mcp-session-id").is_none(),
        "stateless: no session is issued: {reply:?}"
    );

    let listed = server
        .post(
            &[("MCP-Protocol-Version", "2025-06-18")],
            &serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .json();
    let tools = listed["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("{listed}"));
    assert!(
        tools.iter().any(|tool| tool["name"] == "bindings.schema"),
        "{listed}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_foreign_host_or_any_browser_origin_is_refused() {
    let root = seeded("origin");
    let server = HttpProcess::launch(&root);
    let request =
        stateless(serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    let list = [
        ("MCP-Protocol-Version", STATELESS_VERSION),
        ("Mcp-Method", "tools/list"),
    ];
    // DNS rebinding: a page that resolved its own name to 127.0.0.1.
    let rebound = post(server.addr, "attacker.example", &list, &request);
    assert_eq!(rebound.status, 403, "{rebound:?}");
    // A browser page on any origin, even a local one.
    let browser = server.post(
        &[list[0], list[1], ("Origin", "http://localhost:5173")],
        &request,
    );
    assert_eq!(browser.status, 403, "{browser:?}");
    // The same request from a local agent is served.
    let agent = server.post(&list, &request);
    assert_eq!(agent.status, 200, "{agent:?}");
    let _ = std::fs::remove_dir_all(root);
}
