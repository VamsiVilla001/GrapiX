//! The link against a fake local server that speaks what Figma's desktop server speaks:
//! HTTP/1.1, an event-stream reply, a session id, a 202 for notifications.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gx_figma_link::{Link, LinkError, NodeRef, FIGMA_DESKTOP};
use serde_json::{json, Value};

/// What the fake saw: each request's session header and JSON body.
type Seen = Arc<Mutex<Vec<(Option<String>, Value)>>>;

/// Serve `replies` (status, extra headers, body) to the next requests, in order, one per connection.
fn fake(replies: Vec<(u16, String, String)>) -> (SocketAddr, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let seen: Seen = Arc::default();
    let log = seen.clone();
    thread::spawn(move || {
        for (status, headers, body) in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            let (head_end, length) = loop {
                let n = stream.read(&mut buf).unwrap();
                raw.extend_from_slice(&buf[..n]);
                if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..p]).to_ascii_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    break (p + 4, len);
                }
            };
            while raw.len() < head_end + length {
                let n = stream.read(&mut buf).unwrap();
                raw.extend_from_slice(&buf[..n]);
            }
            let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
            let session = head.lines().find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("mcp-session-id:")
                    .map(|v| v.trim().to_owned())
            });
            let json: Value = serde_json::from_slice(&raw[head_end..head_end + length]).unwrap();
            log.lock().unwrap().push((session, json));
            let reply = format!(
                "HTTP/1.1 {status} X\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
        }
    });
    (addr, seen)
}

fn sse(message: Value) -> String {
    format!("event: message\ndata: {message}\n\n")
}

fn init_reply(id: u64) -> (u16, String, String) {
    (
        200,
        "Content-Type: text/event-stream\r\nMcp-Session-Id: s-1\r\n".into(),
        sse(
            json!({ "jsonrpc": "2.0", "id": id, "result": { "serverInfo": { "name": "Figma Dev Mode MCP Server" }, "capabilities": {} } }),
        ),
    )
}

fn accepted() -> (u16, String, String) {
    (202, String::new(), String::new())
}

#[test]
fn a_session_opens_lists_tools_and_calls_one_carrying_its_id() {
    let (addr, seen) = fake(vec![
        init_reply(1),
        accepted(),
        (200, "Content-Type: application/json\r\n".into(), json!({ "jsonrpc": "2.0", "id": 2, "result": { "tools": [{ "name": "get_metadata", "description": "d" }, { "name": "get_screenshot" }] } }).to_string()),
        (200, "Content-Type: text/event-stream\r\n".into(), sse(json!({ "jsonrpc": "2.0", "id": 3, "result": { "content": [{ "type": "text", "text": "<frame/>" }] } }))),
    ]);
    let mut link = Link::connect(addr).unwrap();
    assert_eq!(link.server(), "Figma Dev Mode MCP Server");
    let tools = link.tools().unwrap();
    assert_eq!(
        tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["get_metadata", "get_screenshot"]
    );
    assert_eq!(tools[0].description, "d");
    assert_eq!(tools[1].description, "");
    let reply = link
        .call("get_metadata", json!({ "nodeId": "1:2" }))
        .unwrap();
    assert_eq!(reply.result["content"][0]["text"], "<frame/>");

    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].0, None, "the first request has no session yet");
    assert_eq!(seen[0].1["method"], "initialize");
    assert_eq!(seen[0].1["params"]["clientInfo"]["name"], "grapix");
    assert_eq!(seen[1].1["method"], "notifications/initialized");
    assert!(seen[1].1.get("id").is_none(), "a notification has no id");
    for later in &seen[1..] {
        assert_eq!(
            later.0.as_deref(),
            Some("s-1"),
            "every later request carries the session"
        );
    }
    assert_eq!(
        seen[3].1["params"],
        json!({ "name": "get_metadata", "arguments": { "nodeId": "1:2" } })
    );
    let ids: Vec<_> = seen
        .iter()
        .filter_map(|(_, j)| j.get("id").cloned())
        .collect();
    assert_eq!(ids, [json!(1), json!(2), json!(3)], "ids count up");
}

#[test]
fn a_reply_is_kept_exactly_and_hashed_the_same_every_time() {
    let message = json!({ "jsonrpc": "2.0", "id": 2, "result": { "content": [{ "type": "text", "text": "x" }] } });
    let run = || {
        let (addr, _) = fake(vec![
            init_reply(1),
            accepted(),
            (
                200,
                "Content-Type: text/event-stream\r\n".into(),
                sse(message.clone()),
            ),
        ]);
        Link::connect(addr).unwrap().call("t", json!({})).unwrap()
    };
    let (first, second) = (run(), run());
    assert_eq!(
        first.raw,
        message.to_string(),
        "the message as it came, not re-serialised"
    );
    assert_eq!(first.hash, second.hash);
    assert_eq!(first.hash.len(), 64);
    let changed = {
        let (addr, _) = fake(vec![
            init_reply(1),
            accepted(),
            (
                200,
                String::new(),
                sse(json!({ "jsonrpc": "2.0", "id": 2, "result": { "content": [] } })),
            ),
        ]);
        Link::connect(addr).unwrap().call("t", json!({})).unwrap()
    };
    assert_ne!(
        first.hash, changed.hash,
        "a different reply hashes differently"
    );
}

#[test]
fn a_remote_error_a_bad_status_and_a_mismatched_id_are_named() {
    let (addr, _) = fake(vec![
        init_reply(1),
        accepted(),
        (
            200,
            String::new(),
            sse(
                json!({ "jsonrpc": "2.0", "id": 2, "error": { "code": -32602, "message": "no such node" } }),
            ),
        ),
        (
            200,
            String::new(),
            sse(json!({ "jsonrpc": "2.0", "id": 99, "result": {} })),
        ),
        (500, String::new(), "oops".into()),
    ]);
    let mut link = Link::connect(addr).unwrap();
    assert_eq!(
        link.call("t", json!({})).unwrap_err(),
        LinkError::Remote {
            code: -32602,
            message: "no such node".into()
        }
    );
    assert!(
        matches!(
            link.call("t", json!({})).unwrap_err(),
            LinkError::Protocol(_)
        ),
        "a reply for another request"
    );
    assert_eq!(
        link.call("t", json!({})).unwrap_err(),
        LinkError::Status(500)
    );
}

#[test]
fn a_frame_is_read_the_way_claude_reads_it() {
    let text = |id: u64, t: &str| {
        (
            200,
            "Content-Type: text/event-stream\r\n".to_string(),
            sse(
                json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": t }] } }),
            ),
        )
    };
    let (addr, seen) = fake(vec![
        init_reply(1),
        accepted(),
        text(2, "<frame id=\"12:34\"/>"),
        text(3, "export default function Frame() {}"),
        (
            200,
            String::new(),
            sse(
                json!({ "jsonrpc": "2.0", "id": 4, "result": { "isError": true, "content": [{ "type": "text", "text": "no node 9:9" }] } }),
            ),
        ),
    ]);
    let mut link = Link::connect(addr).unwrap();
    let node =
        NodeRef::parse("https://www.figma.com/design/AbC123/Scoreboard?node-id=12-34").unwrap();
    assert_eq!(
        link.get_metadata(&node).unwrap().text().unwrap(),
        "<frame id=\"12:34\"/>"
    );
    link.get_design_context(&node).unwrap();
    let missing = NodeRef::parse("9-9").unwrap();
    assert_eq!(
        link.get_screenshot(&missing)
            .unwrap()
            .content()
            .unwrap_err(),
        LinkError::Tool("no node 9:9".into()),
        "a tool that says it failed has failed"
    );

    let seen = seen.lock().unwrap();
    assert_eq!(seen[2].1["params"]["name"], "get_metadata");
    assert_eq!(
        seen[2].1["params"]["arguments"],
        json!({ "nodeId": "12:34", "fileKey": "AbC123" })
    );
    assert_eq!(seen[3].1["params"]["name"], "get_design_context");
    assert_eq!(
        seen[3].1["params"]["arguments"]["clientFrameworks"],
        "tauri"
    );
    assert_eq!(
        seen[4].1["params"]["arguments"],
        json!({ "nodeId": "9:9" }),
        "a bare node id names no file: Figma's open file is meant"
    );
}

#[test]
fn a_server_that_is_not_mcp_is_refused() {
    let (addr, _) = fake(vec![(200, String::new(), "<html>hello</html>".into())]);
    assert!(matches!(
        Link::connect(addr).unwrap_err(),
        LinkError::Protocol(_)
    ));
}

#[test]
fn nothing_listening_is_unreachable_and_says_what_to_do() {
    let free = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let err = Link::connect_with_timeout(free, Duration::from_secs(2)).unwrap_err();
    assert!(matches!(err, LinkError::Unreachable(_)), "{err:?}");
    assert!(err.to_string().contains("Dev Mode"));
}

#[test]
fn a_silent_server_times_out_instead_of_hanging() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let holder = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_secs(3));
        drop(stream);
    });
    let started = std::time::Instant::now();
    let err = Link::connect_with_timeout(addr, Duration::from_millis(400)).unwrap_err();
    assert!(matches!(err, LinkError::Transport(_)), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    holder.join().unwrap();
}

/// Against the real Figma desktop app, with its MCP server on. Read-only. The handshake must
/// work; `tools/list` is attempted with a short timeout and reported, because on 20 November
/// 2026 the desktop server answered `initialize` at once and left `tools/list` unanswered
/// (plain PowerShell too), so that call is the app's state, not the link's.
/// Run with `-- --ignored figma_desktop --nocapture`.
#[test]
#[ignore = "needs the Figma desktop app with its MCP server on"]
fn figma_desktop_answers_the_handshake() {
    let mut link = Link::connect_with_timeout(FIGMA_DESKTOP, Duration::from_secs(8))
        .expect("Figma desktop answers initialize");
    assert!(link.server().contains("Figma"), "{}", link.server());
    match link.tools() {
        Ok(tools) => {
            let names: Vec<_> = tools.iter().map(|t| t.name.as_str()).collect();
            println!("tools: {names:?}");
            assert!(!names.is_empty());
        }
        Err(error) => println!("tools/list did not answer: {error}"),
    }
}
