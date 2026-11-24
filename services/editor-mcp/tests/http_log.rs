//! 2.23: a call over HTTP is on record with the subject of the credential that made it, and the
//! credential itself is in no line.

mod support;

use support::{call, stateless, HttpProcess, STATELESS_VERSION};

fn records(directory: &std::path::Path) -> (String, Vec<serde_json::Value>) {
    let mut text = String::new();
    let mut found = Vec::new();
    for entry in std::fs::read_dir(directory).into_iter().flatten().flatten() {
        let file = std::fs::read_to_string(entry.path()).unwrap_or_default();
        found.extend(
            file.lines()
                .filter_map(|line| serde_json::from_str(line).ok()),
        );
        text.push_str(&file);
    }
    (text, found)
}

#[test]
fn an_http_call_is_on_record_with_the_credentials_subject_and_never_the_credential() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gx-mcp-http-log-{}-{nanos}", std::process::id()));
    let root = dir.join("store");
    std::fs::create_dir_all(&root).unwrap();
    let logs = dir.join("logs");
    let server = HttpProcess::launch_logging_to(&root, &logs);
    let host = format!("127.0.0.1:{}", server.addr.port());
    let headers = [
        ("MCP-Protocol-Version", STATELESS_VERSION),
        ("Mcp-Method", "tools/call"),
        ("Mcp-Name", "project.create"),
    ];
    let create = stateless(call(
        1,
        "project.create",
        serde_json::json!({ "project": "news", "idempotencyKey": "http-log-1" }),
    ));
    // One call with the credential the harness sends (subject "http-test"), one with none.
    assert_eq!(server.post(&headers, &create).status, 200);
    let refused = support::post_anonymous(server.addr, &host, &headers, &create);
    assert_eq!(refused.status, 401);
    // `finish` ends the server process at once, and the log is written by its own thread: under
    // a loaded machine the last line was still in that thread's hands when the process ended
    // (the full workspace run of 23 Nov 2026 lost it once). Wait for the line to be in the file
    // before ending the server; the assertions below still fail by name if it never arrives.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline
        && !records(&logs.join("mcp"))
            .1
            .iter()
            .any(|r| r["event"] == "mcp.unauthenticated")
    {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    server.finish();

    let (text, found) = records(&logs.join("mcp"));
    let ok = found
        .iter()
        .find(|r| r["event"] == "mcp.call" && r["fields"]["result"] == "ok")
        .unwrap_or_else(|| panic!("no successful mcp.call in {found:#?}"));
    assert_eq!(ok["fields"]["tool"], "project.create");
    assert_eq!(ok["fields"]["subject"], "http-test", "{ok}");
    let unauthenticated = found
        .iter()
        .find(|r| r["event"] == "mcp.unauthenticated")
        .unwrap_or_else(|| panic!("the refused request is not on record in {found:#?}"));
    assert_eq!(
        unauthenticated["fields"]["fault"], "noCredential",
        "{unauthenticated}"
    );
    assert!(
        !text.contains("gx1.") && !text.contains(support::TEST_SECRET),
        "a credential or the secret reached the log"
    );
    let _ = std::fs::remove_dir_all(dir);
}
