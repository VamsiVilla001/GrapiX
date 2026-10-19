use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn shipped_stdio_tools_list_carries_usable_generated_schemas() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gx-editor-mcp"))
        .args(["--root", "."])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize"})).unwrap();
    writeln!(input, "{}", serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})).unwrap();
    writeln!(input, "{}", serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).unwrap();
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let replies: Vec<serde_json::Value> = String::from_utf8(output.stdout).unwrap()
        .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(replies.len(), 2, "notifications produce no reply or stdout noise");
    let tools = replies[1]["result"]["tools"].as_array().unwrap();
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
