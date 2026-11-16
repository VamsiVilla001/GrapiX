//! 2.12: the shipped `gx-editor-mcp` writes every `tools/call` to its log, in
//! a file, never on stdout (stdout carries the MCP protocol).

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

fn records(directory: &Path) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<serde_json::Value>>()
        })
        .collect()
}

#[test]
fn every_tool_call_is_on_record_and_stdout_carries_only_the_protocol() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gx-mcp-log-{}-{nanos}", std::process::id()));
    let root = dir.join("store");
    std::fs::create_dir_all(&root).unwrap();
    let logs = dir.join("logs");
    let mut child = Command::new(env!("CARGO_BIN_EXE_gx-editor-mcp"))
        .arg("--root")
        .arg(&root)
        .env("GX_LOG_DIR", &logs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the server starts");
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut send = |message: serde_json::Value| {
        writeln!(input, "{message}").unwrap();
        input.flush().unwrap();
    };
    let mut lines = Vec::new();
    let mut read = |lines: &mut Vec<String>| {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        lines.push(line);
    };
    send(
        serde_json::json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": { "name": "gx-log-test", "version": "1" } } }),
    );
    read(&mut lines);
    send(serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    send(
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "project.create", "arguments": { "project": "news", "idempotencyKey": "op-log-1" } } }),
    );
    read(&mut lines);
    send(
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "scenes.create", "arguments": { "project": "nope", "sceneId": "s", "name": "S" } } }),
    );
    read(&mut lines);
    drop(input);
    let _ = child.wait();
    for line in &lines {
        let value: serde_json::Value = serde_json::from_str(line)
            .unwrap_or_else(|_| panic!("stdout is JSON-RPC only: {line}"));
        assert_eq!(value["jsonrpc"], "2.0", "{line}");
    }
    let found = records(&logs.join("mcp"));
    let start = found
        .iter()
        .find(|r| r["event"] == "mcp.start")
        .unwrap_or_else(|| panic!("no mcp.start in {found:#?}"));
    assert_eq!(start["fields"]["transport"], "stdio");
    let ok = found
        .iter()
        .find(|r| r["event"] == "mcp.call" && r["fields"]["result"] == "ok")
        .unwrap_or_else(|| panic!("no successful mcp.call in {found:#?}"));
    assert_eq!(ok["fields"]["tool"], "project.create");
    assert_eq!(ok["fields"]["effect"], "write");
    assert_eq!(ok["fields"]["scope"], "Author", "the scope the call needed");
    assert_eq!(ok["fields"]["idempotency_key"], "op-log-1");
    assert!(ok["fields"]["duration_us"].as_u64().is_some());
    let refused = found
        .iter()
        .find(|r| r["event"] == "mcp.call" && r["fields"]["result"] == "refused")
        .unwrap_or_else(|| panic!("no refused mcp.call in {found:#?}"));
    assert_eq!(refused["fields"]["tool"], "scenes.create");
    assert_eq!(refused["refusal"], "projectNotFound");
    // 2.13: each call is one action with its own id, minted at the gate.
    let ids: Vec<&str> = [ok, refused]
        .iter()
        .map(|r| r["corr"].as_str().expect("an mcp.call carries its id"))
        .collect();
    assert!(
        ids.iter()
            .all(|id| id.starts_with("mcp-") && id.len() <= 64),
        "{ids:?}"
    );
    assert_ne!(ids[0], ids[1], "two calls are two actions");
    assert!(
        found
            .iter()
            .filter(|r| r["event"] == "mcp.start")
            .all(|r| r["corr"].is_null()),
        "the start is not part of a call"
    );
    let _ = std::fs::remove_dir_all(dir);
}
