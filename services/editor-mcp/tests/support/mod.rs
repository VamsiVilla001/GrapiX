//! A conformant MCP client for the shipped `gx-editor-mcp` binary, shared by
//! every test that launches it (build plan 8.14).
//!
//! The binary speaks MCP through rmcp, so a test talks to it as a real client
//! does: `initialize` with real params, `notifications/initialized`, then one
//! request at a time, each reply read before the next is sent. Pipelining is
//! not something a test may rely on: rmcp runs requests concurrently, so two
//! writes sent back to back are not ordered.
//!
//! [`tool_reply`] is the only place a tool-call envelope is read. It checks
//! the spec framing (`structuredContent`, one text block with the same JSON,
//! no `isError`) and hands the test the reply with `result` set to the tool's
//! value. The assertions a test makes on values and refusals are therefore
//! the ones it made before the port.

// Each test target includes this module and uses a different part of it.
#![allow(dead_code, unused_imports)]

#[path = "../../../mcp-server/tests/http/client.rs"]
mod client;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

pub use client::{post, post_local, HttpReply};

/// The revision this client asks for at `initialize`.
pub const HANDSHAKE_VERSION: &str = "2025-06-18";
/// The stateless revision, which has no `initialize`.
pub const STATELESS_VERSION: &str = "2026-07-28";

const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

/// A `tools/call` request.
pub fn call(id: u64, tool: &str, arguments: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    })
}

/// The per-request `_meta` the 2026-07-28 revision requires in place of a
/// handshake.
pub fn stateless_meta() -> serde_json::Value {
    serde_json::json!({
        "io.modelcontextprotocol/protocolVersion": STATELESS_VERSION,
        "io.modelcontextprotocol/clientInfo": { "name": "gx-test-client", "version": "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
    })
}

/// `request` with the 2026-07-28 `_meta` added to its params.
pub fn stateless(mut request: serde_json::Value) -> serde_json::Value {
    if request.get("params").is_none() {
        request["params"] = serde_json::json!({});
    }
    request["params"]["_meta"] = stateless_meta();
    request
}

pub fn initialize_request(version: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": version,
            "capabilities": {},
            "clientInfo": { "name": "gx-test-client", "version": "1" },
        },
    })
}

/// Check a `tools/call` reply's spec framing and return it with `result` set
/// to the tool's value. A refusal (a JSON-RPC error) is returned as it came.
pub fn tool_reply(mut reply: serde_json::Value) -> serde_json::Value {
    if reply.get("result").is_none() {
        assert!(reply["error"].is_object(), "a reply is a result or an error: {reply}");
        return reply;
    }
    let result = reply["result"].take();
    assert_ne!(result["isError"], true, "a tool value is not an error result: {result}");
    let structured = result
        .get("structuredContent")
        .cloned()
        .unwrap_or_else(|| panic!("a tool value travels as structuredContent: {result}"));
    let content = result["content"].as_array().expect("a tool result has content");
    let text = content
        .iter()
        .find(|block| block["type"] == "text")
        .and_then(|block| block["text"].as_str())
        .unwrap_or_else(|| panic!("a client reading only content gets the value as text: {result}"));
    let parsed: serde_json::Value = serde_json::from_str(text).expect("the text block is the value as JSON");
    assert_eq!(parsed, structured, "the text block and structuredContent carry the same value");
    reply["result"] = structured;
    reply
}

/// One running `gx-editor-mcp --root <root>` on stdio.
pub struct Session {
    child: Child,
    input: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl Session {
    /// Launch the binary. No message is sent.
    pub fn launch(root: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_gx-editor-mcp"))
            .arg("--root")
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the shipped server starts");
        let input = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout");
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Self { child, input, lines }
    }

    /// Launch and complete the 2025-06-18 handshake.
    pub fn start(root: &Path) -> Self {
        let mut session = Self::launch(root);
        let reply = session.request(&initialize_request(HANDSHAKE_VERSION));
        assert_eq!(reply["result"]["protocolVersion"], HANDSHAKE_VERSION, "{reply}");
        session.send(&serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        session
    }

    /// Write one line. Use for notifications and for lines that are not JSON.
    pub fn send_line(&mut self, line: &str) {
        let input = self.input.as_mut().expect("stdin is open");
        writeln!(input, "{line}").expect("the server reads stdin");
        input.flush().expect("stdin flushes");
    }

    pub fn send(&mut self, message: &serde_json::Value) {
        self.send_line(&message.to_string());
    }

    /// The next line the server writes, if one arrives within `wait`.
    pub fn next_reply(&mut self, wait: Duration) -> Option<serde_json::Value> {
        self.lines
            .recv_timeout(wait)
            .ok()
            .map(|line| serde_json::from_str(&line).unwrap_or_else(|_| panic!("stdout carries only JSON-RPC: {line}")))
    }

    /// Send a request and wait for its reply.
    pub fn request(&mut self, message: &serde_json::Value) -> serde_json::Value {
        self.send(message);
        let reply = self
            .next_reply(REPLY_TIMEOUT)
            .unwrap_or_else(|| panic!("no reply to {message}"));
        assert_eq!(reply["id"], message["id"], "the reply answers the request sent");
        reply
    }

    /// Call a tool and return the reply in the shape [`tool_reply`] gives.
    pub fn call(&mut self, request: &serde_json::Value) -> serde_json::Value {
        tool_reply(self.request(request))
    }

    /// Close stdin, require a clean exit and no further output.
    pub fn finish(mut self) {
        drop(self.input.take());
        let status = self.child.wait().expect("the shipped server exits");
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        assert!(status.success(), "{stderr}");
        let trailing: Vec<String> = self.lines.try_iter().collect();
        assert!(trailing.is_empty(), "no output after the last reply: {trailing:?}");
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.input.is_some() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// One session with the shipped binary: handshake, then each tool call in
/// turn. The replies, one per call, are in [`tool_reply`]'s shape.
pub fn shipped_session(root: &Path, calls: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut session = Session::start(root);
    let replies = calls.iter().map(|request| session.call(request)).collect();
    session.finish();
    replies
}

/// A running `gx-editor-mcp --root <root> --http 0`.
pub struct HttpProcess {
    child: Child,
    pub addr: SocketAddr,
}

impl HttpProcess {
    pub fn launch(root: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_gx-editor-mcp"))
            .arg("--root")
            .arg(root)
            .args(["--http", "0"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the shipped server starts");
        let stderr = child.stderr.take().expect("stderr");
        let (sender, announced) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let _ = sender.send(line);
            }
        });
        let addr = loop {
            let line = announced
                .recv_timeout(REPLY_TIMEOUT)
                .expect("the server announces its address on stderr");
            if let Some(url) = line.split_whitespace().find(|word| word.starts_with("http://")) {
                let authority = url
                    .trim_start_matches("http://")
                    .split('/')
                    .next()
                    .expect("an authority");
                break authority.parse().expect("a socket address");
            }
        };
        Self { child, addr }
    }

    /// POST one JSON-RPC message to `/mcp` with a matching `Host`.
    pub fn post(&self, headers: &[(&str, &str)], body: &serde_json::Value) -> HttpReply {
        post_local(self.addr, headers, body)
    }
}

impl Drop for HttpProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
