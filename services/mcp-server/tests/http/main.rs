//! The stateless streamable HTTP transport (build plan 8.14) driven by a raw
//! HTTP client: a 2026-07-28 call with no handshake, a refusal, the legacy
//! handshake, and the two request shapes a local-only endpoint must refuse.

mod client;

use std::net::SocketAddr;

use client::{post, post_local};
use gx_contracts::auth::Scope;
use gx_contracts::Refusal;
use gx_mcp_server::{serve_http_listener, McpService, Server, ToolHandler};
use tokio_util::sync::CancellationToken;

struct Echo;
impl ToolHandler for Echo {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        Ok(args)
    }
}

/// Cancels the transport when the test thread ends, by return or by panic.
struct StopOnExit(CancellationToken);
impl Drop for StopOnExit {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Serve `server` on a free loopback port, run `test` against the address on
/// another thread, then stop. The server is driven on this thread, as the
/// shipped binaries drive it on their main one; `drive` returns once the
/// cancelled transport has dropped its last handle to the service.
fn with_http(server: Server, test: impl FnOnce(SocketAddr) + Send + 'static) {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)))
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    let (service, jobs) = McpService::pair();
    let transport = runtime.spawn(serve_http_listener(service, listener, shutdown.clone()));
    let stop = StopOnExit(shutdown);
    let tester = std::thread::spawn(move || {
        let _stop = stop;
        test(addr);
    });
    server.drive(jobs);
    let outcome = tester.join();
    runtime.block_on(transport).unwrap().unwrap();
    outcome.expect("the HTTP test passed");
}

fn call(id: u64, name: &str, arguments: serde_json::Value, meta: bool) -> serde_json::Value {
    let mut request = serde_json::json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    if meta {
        request["params"]["_meta"] = serde_json::json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { "name": "http-test", "version": "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
        });
    }
    request
}

/// The headers SEP-2243 requires of a 2026-07-28 client on every POST: the
/// revision, the method and, for a tool call, the tool's name.
fn stateless_headers(method: &'static str, name: &'static str) -> Vec<(&'static str, &'static str)> {
    let mut headers = vec![("MCP-Protocol-Version", "2026-07-28"), ("Mcp-Method", method)];
    if !name.is_empty() {
        headers.push(("Mcp-Name", name));
    }
    headers
}

#[test]
fn a_2026_07_28_client_calls_a_tool_over_http_with_no_handshake() {
    let mut server = Server::new(vec![Scope::Author]);
    server.register("scenes.create", Box::new(Echo));
    with_http(server, |addr| {
        let headers = stateless_headers("tools/call", "scenes.create");
        let reply = post_local(addr, &headers, &call(1, "scenes.create", serde_json::json!({ "id": "x" }), true));
        assert_eq!(reply.status, 200, "{reply:?}");
        assert!(reply.header("content-type").is_some_and(|value| value.contains("application/json")), "{reply:?}");
        assert!(reply.header("mcp-session-id").is_none(), "stateless: no session is issued: {reply:?}");
        let body = reply.json();
        assert_eq!(body["id"], 1);
        assert_eq!(body["result"]["structuredContent"], serde_json::json!({ "id": "x" }), "{body}");
        assert_eq!(body["result"]["content"][0]["type"], "text", "{body}");
    });
}

#[test]
fn a_refusal_over_http_is_the_structured_json_rpc_error() {
    let mut server = Server::new(vec![Scope::Author]);
    server.register("playout.take", Box::new(Echo));
    with_http(server, |addr| {
        let headers = stateless_headers("tools/call", "playout.take");
        let body = post_local(addr, &headers, &call(2, "playout.take", serde_json::json!({}), true)).json();
        assert!(body["result"].is_null(), "{body}");
        assert_eq!(body["error"]["code"], -32000, "{body}");
        assert_eq!(body["error"]["data"]["code"]["refusal"], "unauthenticated", "{body}");
    });
}

#[test]
fn a_2025_06_18_client_negotiates_over_http() {
    with_http(Server::new(Vec::new()), |addr| {
        let initialize = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2026-07-28",
                "capabilities": {},
                "clientInfo": { "name": "http-test", "version": "1" },
            },
        });
        let reply = post_local(addr, &[], &initialize);
        assert_eq!(reply.status, 200, "{reply:?}");
        assert_eq!(reply.json()["result"]["protocolVersion"], "2025-06-18", "{reply:?}");
        assert!(reply.header("mcp-session-id").is_none(), "stateless: no session is issued: {reply:?}");
        let listed = post_local(
            addr,
            &[("MCP-Protocol-Version", "2025-06-18")],
            &serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .json();
        assert_eq!(listed["result"]["tools"][0]["name"], "system.capability", "{listed}");
    });
}

#[test]
fn a_foreign_host_or_any_browser_origin_is_refused() {
    with_http(Server::new(Vec::new()), |addr| {
        let request = call(1, "system.capability", serde_json::json!({}), true);
        let headers = stateless_headers("tools/call", "system.capability");
        // DNS rebinding: a page that resolved its own name to 127.0.0.1.
        let rebound = post(addr, "attacker.example", &headers, &request);
        assert_eq!(rebound.status, 403, "{rebound:?}");
        // A browser page on any origin, even a local one.
        let mut from_browser = headers.clone();
        from_browser.push(("Origin", "http://localhost:5173"));
        let browser = post_local(addr, &from_browser, &request);
        assert_eq!(browser.status, 403, "{browser:?}");
        // The same request from a local agent is served.
        let agent = post_local(addr, &headers, &request);
        assert_eq!(agent.status, 200, "{agent:?}");
    });
}
