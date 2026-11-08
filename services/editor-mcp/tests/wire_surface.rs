//! The shipped `gx-editor-mcp` binary's MCP protocol behaviour on stdio
//! (build plan 8.14): which revisions it negotiates, that the stateless
//! 2026-07-28 revision needs no handshake, and what it does with a line that
//! is not JSON-RPC.

mod support;

use std::time::Duration;
use support::{call, initialize_request, stateless, tool_reply, Session};

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-wire-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

#[test]
fn initialize_negotiates_every_revision_down_to_2025_06_18() {
    let root = scratch("negotiate");
    for asked in ["2025-06-18", "2025-11-25", "2026-07-28", "2024-11-05"] {
        let mut session = Session::launch(&root);
        let reply = session.request(&initialize_request(asked));
        assert_eq!(
            reply["result"]["protocolVersion"], "2025-06-18",
            "asked {asked}: {reply}"
        );
        assert_eq!(reply["result"]["serverInfo"]["name"], "gx-mcp-server");
        assert!(
            reply["result"]["capabilities"]["tools"].is_object(),
            "{reply}"
        );
        session.finish();
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_2026_07_28_client_calls_tools_with_no_handshake() {
    let root = scratch("stateless");
    let projects = gx_editor::Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");
    let mut session = Session::launch(&root);

    let listed = session.request(&stateless(
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
    ));
    let tools = listed["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("{listed}"));
    assert!(
        tools.iter().any(|tool| tool["name"] == "project.list"),
        "{listed}"
    );

    let reply =
        tool_reply(session.request(&stateless(call(2, "project.list", serde_json::json!({})))));
    assert!(reply["error"].is_null(), "{reply}");
    assert_eq!(
        reply["result"],
        serde_json::json!({ "projects": ["news"] }),
        "{reply}"
    );

    // A refusal is the same structured error on the stateless revision.
    let refused = session.request(&stateless(call(3, "playout.take", serde_json::json!({}))));
    assert_eq!(refused["error"]["code"], -32000, "{refused}");
    assert_eq!(
        refused["error"]["data"]["code"]["refusal"], "unauthenticated",
        "{refused}"
    );
    session.finish();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_request_with_neither_handshake_nor_meta_is_refused_by_name() {
    // What the hand-rolled server used to accept. rmcp names the missing
    // 2026-07-28 `_meta` keys and keeps the session open.
    let root = scratch("bare");
    let mut session = Session::launch(&root);
    let reply = session.request(&call(1, "project.list", serde_json::json!({})));
    assert_eq!(reply["error"]["code"], -32602, "{reply}");
    let message = reply["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("io.modelcontextprotocol/protocolVersion"),
        "{message}"
    );
    let reply = session.request(&initialize_request("2025-06-18"));
    assert_eq!(reply["result"]["protocolVersion"], "2025-06-18", "{reply}");
    session.finish();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_line_that_is_not_json_rpc_gets_no_reply_on_the_shipped_wire() {
    // Pinned so it cannot change silently. rmcp drops an unparseable line;
    // the in-process `Server::serve` answers it with -32700 instead, and
    // `gx-mcp-server`'s `malformed_json_is_a_parse_error_not_a_crash` pins
    // that half. The session survives either way.
    let root = scratch("garbage");
    let mut session = Session::start(&root);
    session.send_line("not json");
    assert!(
        session.next_reply(Duration::from_millis(500)).is_none(),
        "an unparseable line is dropped"
    );
    let reply = session.call(&call(1, "project.list", serde_json::json!({})));
    assert!(
        reply["error"].is_null(),
        "the session still answers: {reply}"
    );
    session.finish();
    let _ = std::fs::remove_dir_all(root);
}
