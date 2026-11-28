//! The HTTP transport against the 2026-07-28 specification's own words (build plan 8.14, claude-grapix-f1, 25 Nov 2026).
//!
//! Each case sends the real transport one request the specification names and asserts what it answers. Where the specification decides,
//! the assertion is what it says; where the transport departs from it, the test pins what it does today and says so, so a change on
//! either side has to update `docs/evidence/8.14/spec-check.md`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};

use gx_contracts::auth::Scope;
use gx_mcp_server::Server;

use super::client::{self, post_local};
use super::{call, stateless_headers, with_http, Echo};

/// A request with no body, in the same raw style as `post`: GET and DELETE are not in `client.rs`.
fn bodiless(addr: SocketAddr, method: &str, headers: &[(&str, &str)]) -> client::HttpReply {
    let mut stream = TcpStream::connect(addr).expect("the HTTP server accepts");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .unwrap();
    let credential = format!("Bearer {}", client::author_credential());
    let mut request = format!(
        "{method} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json, text/event-stream\r\nAuthorization: {credential}\r\nConnection: close\r\n",
        client::MCP_PATH,
        addr.port()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    let mut raw = Vec::new();
    // A server that held a GET open as an event stream would never close it; the read timeout would end this and the test would fail on
    // the status it did not get.
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    client::HttpReply {
        status,
        headers: lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect(),
        body: body.to_owned(),
    }
}

/// A `system.capability` call whose `_meta` names `version`.
fn with_version(version: &str, id: u64) -> serde_json::Value {
    let mut request = call(id, "system.capability", serde_json::json!({}), true);
    request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] = version.into();
    request
}

#[test]
fn the_transport_answers_as_the_2026_07_28_specification_says_where_it_decides() {
    let mut server = Server::new(vec![Scope::Author]);
    server.register("scenes.create", Box::new(Echo));
    with_http(server, |addr| {
        let error_code = |reply: &client::HttpReply| reply.json()["error"]["code"].clone();

        // "If the server does not implement the requested version ... it MUST respond with an UnsupportedProtocolVersionError listing
        // the versions it does support" (basic/versioning): code -32022, HTTP 400, `data.supported` and `data.requested`.
        let unknown = post_local(
            addr,
            &[
                ("MCP-Protocol-Version", "2099-01-01"),
                ("Mcp-Method", "tools/call"),
                ("Mcp-Name", "system.capability"),
            ],
            &with_version("2099-01-01", 1),
        );
        assert_eq!(unknown.status, 400, "{unknown:?}");
        assert_eq!(error_code(&unknown), -32022, "{unknown:?}");
        let data = &unknown.json()["error"]["data"];
        assert_eq!(data["requested"], "2099-01-01", "{unknown:?}");
        let supported: Vec<&str> = data["supported"]
            .as_array()
            .expect("the supported list")
            .iter()
            .filter_map(|version| version.as_str())
            .collect();
        assert_eq!(supported, ["2025-06-18", "2026-07-28"], "{unknown:?}");

        // The `MCP-Protocol-Version` header "must match the body value": a header that disagrees with `_meta`, and a body that names a
        // revision with no header, are each refused (-32020, HTTP 400) before any tool is reached.
        let mismatch = post_local(
            addr,
            &stateless_headers("tools/call", "system.capability"),
            &with_version("2025-06-18", 2),
        );
        assert_eq!(mismatch.status, 400, "{mismatch:?}");
        assert_eq!(error_code(&mismatch), -32020, "{mismatch:?}");
        let no_header = post_local(
            addr,
            &[
                ("Mcp-Method", "tools/call"),
                ("Mcp-Name", "system.capability"),
            ],
            &with_version("2026-07-28", 3),
        );
        assert_eq!(no_header.status, 400, "{no_header:?}");
        assert_eq!(error_code(&no_header), -32020, "{no_header:?}");

        // The specification removes protocol-level sessions: a server "do[es] not mint or echo session IDs".
        let mut with_session = stateless_headers("tools/call", "system.capability");
        with_session.push(("Mcp-Session-Id", "abc-123"));
        let session = post_local(addr, &with_session, &with_version("2026-07-28", 4));
        assert_eq!(session.status, 200, "{session:?}");
        assert!(session.header("mcp-session-id").is_none(), "{session:?}");

        // "HTTP GET or DELETE on the MCP endpoint should get 405 Method Not Allowed".
        for method in ["GET", "DELETE"] {
            let reply = bodiless(addr, method, &[("MCP-Protocol-Version", "2026-07-28")]);
            assert_eq!(reply.status, 405, "{method}: {reply:?}");
            assert_eq!(reply.header("allow"), Some("POST"), "{method}: {reply:?}");
        }

        // A method nobody defined is JSON-RPC "method not found".
        let method = post_local(
            addr,
            &stateless_headers("no/such", ""),
            &serde_json::json!({ "jsonrpc": "2.0", "id": 6, "method": "no/such",
                "params": { "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": { "name": "http-test", "version": "1" },
                    "io.modelcontextprotocol/clientCapabilities": {} } } }),
        );
        assert_eq!(error_code(&method), -32601, "{method:?}");

        // WHERE IT DEPARTS FROM THE SPECIFICATION, pinned as it is today (docs/evidence/8.14/spec-check.md, finding S1): the
        // specification's example for an unknown tool is a protocol error with code -32602; this server answers every refusal, an
        // unknown tool included, as a JSON-RPC error with code -32000 and the structured refusal in `data` (wire.rs: "Refusals are not
        // tool results"), at HTTP 200.
        let unknown_tool = post_local(
            addr,
            &stateless_headers("tools/call", "scenes.obliterate"),
            &call(7, "scenes.obliterate", serde_json::json!({}), true),
        );
        assert_eq!(unknown_tool.status, 200, "{unknown_tool:?}");
        assert_eq!(error_code(&unknown_tool), -32000, "{unknown_tool:?}");
        assert_eq!(
            unknown_tool.json()["error"]["data"]["code"]["refusal"],
            "notImplemented",
            "{unknown_tool:?}"
        );
    });
}
