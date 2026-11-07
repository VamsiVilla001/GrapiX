//! The shipped `gx-editor-mcp` binary's `tools/list` over stdio: every
//! advertised schema is the generated one and is usable by a client.

mod support;

use support::Session;

#[test]
fn shipped_stdio_tools_list_carries_usable_generated_schemas() {
    let mut session = Session::start(std::path::Path::new("."));
    let reply = session.request(&serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    session.finish();
    let tools = reply["result"]["tools"].as_array().unwrap_or_else(|| panic!("{reply}"));
    assert!(tools.len() > 1, "the actual Editor surface is installed");
    for tool in tools {
        let name = tool["name"].as_str().unwrap();
        let descriptor = gx_contracts::mcp::ToolRegistry::get(name).unwrap();
        let generated = gx_contracts::mcp::input_schema(descriptor.input).unwrap();
        assert_eq!(tool["inputSchema"], generated, "{name}");
        let validator = jsonschema::validator_for(&generated).unwrap();
        assert!(!validator.is_valid(&serde_json::json!([])), "{name} requires object arguments");
    }
    let edit = tools.iter().find(|tool| tool["name"] == "scenes.edit").unwrap();
    let validator = jsonschema::validator_for(&edit["inputSchema"]).unwrap();
    assert!(validator.is_valid(&serde_json::json!({
        "target":{"target":"stored","project":"news","sceneId":"score"},
        "edits":[]
    })));
    assert!(!validator.is_valid(&serde_json::json!({"target":42,"edits":[]})));
    assert!(!validator.is_valid(&serde_json::json!({"edits":[]})));
}
