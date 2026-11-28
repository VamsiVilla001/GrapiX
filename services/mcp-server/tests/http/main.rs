//! The stateless streamable HTTP transport (build plan 8.14) driven by a raw
//! HTTP client: a 2026-07-28 call with no handshake, a refusal, the legacy
//! handshake, and the two request shapes a local-only endpoint must refuse.

mod client;
mod spec_probe;

use std::net::SocketAddr;

use client::{post, post_anonymous, post_local, TEST_SECRET};
use gx_contracts::auth::Scope;
use gx_contracts::Refusal;
use gx_mcp_server::{serve_http_listener, HttpAuth, McpService, Server, ToolHandler};
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
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind((
            std::net::Ipv4Addr::LOCALHOST,
            0,
        )))
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    let (service, jobs) = McpService::pair();
    let auth = HttpAuth::new(TEST_SECRET).expect("a secret");
    let transport = runtime.spawn(serve_http_listener(
        service,
        listener,
        shutdown.clone(),
        auth,
    ));
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
fn stateless_headers(
    method: &'static str,
    name: &'static str,
) -> Vec<(&'static str, &'static str)> {
    let mut headers = vec![
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", method),
    ];
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
        let reply = post_local(
            addr,
            &headers,
            &call(1, "scenes.create", serde_json::json!({ "id": "x" }), true),
        );
        assert_eq!(reply.status, 200, "{reply:?}");
        assert!(
            reply
                .header("content-type")
                .is_some_and(|value| value.contains("application/json")),
            "{reply:?}"
        );
        assert!(
            reply.header("mcp-session-id").is_none(),
            "stateless: no session is issued: {reply:?}"
        );
        let body = reply.json();
        assert_eq!(body["id"], 1);
        assert_eq!(
            body["result"]["structuredContent"],
            serde_json::json!({ "id": "x" }),
            "{body}"
        );
        assert_eq!(body["result"]["content"][0]["type"], "text", "{body}");
    });
}

#[test]
fn a_refusal_over_http_is_the_structured_json_rpc_error() {
    let mut server = Server::new(vec![Scope::Author]);
    server.register("playout.take", Box::new(Echo));
    with_http(server, |addr| {
        let headers = stateless_headers("tools/call", "playout.take");
        let body = post_local(
            addr,
            &headers,
            &call(2, "playout.take", serde_json::json!({}), true),
        )
        .json();
        assert!(body["result"].is_null(), "{body}");
        assert_eq!(body["error"]["code"], -32000, "{body}");
        assert_eq!(
            body["error"]["data"]["code"]["refusal"], "unauthenticated",
            "{body}"
        );
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
        assert_eq!(
            reply.json()["result"]["protocolVersion"],
            "2025-06-18",
            "{reply:?}"
        );
        assert!(
            reply.header("mcp-session-id").is_none(),
            "stateless: no session is issued: {reply:?}"
        );
        let listed = post_local(
            addr,
            &[("MCP-Protocol-Version", "2025-06-18")],
            &serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .json();
        assert_eq!(
            listed["result"]["tools"][0]["name"], "system.capability",
            "{listed}"
        );
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

// ---- 2.23: the HTTP transport judges every request's credential before the protocol sees it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// A tool that counts how often it was reached, so a refusal can be shown to have stopped short of it.
struct Counting(Arc<AtomicUsize>);
impl ToolHandler for Counting {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(args)
    }
}

fn author_call(id: u64) -> serde_json::Value {
    call(id, "scenes.create", serde_json::json!({ "id": "x" }), true)
}

fn refusal_of(reply: &client::HttpReply) -> serde_json::Value {
    reply.json()["error"]["data"]["code"]["refusal"].clone()
}

#[test]
fn a_request_with_no_credential_is_refused_by_name_before_the_protocol_and_the_tool_is_not_reached()
{
    let reached = Arc::new(AtomicUsize::new(0));
    let mut server = Server::new(vec![Scope::Author]);
    server.register("scenes.create", Box::new(Counting(Arc::clone(&reached))));
    let seen = Arc::clone(&reached);
    with_http(server, move |addr| {
        let headers = stateless_headers("tools/call", "scenes.create");
        let reply = post_anonymous(
            addr,
            &format!("127.0.0.1:{}", addr.port()),
            &headers,
            &author_call(1),
        );
        assert_eq!(reply.status, 401, "{reply:?}");
        assert_eq!(
            reply.header("www-authenticate"),
            Some("Bearer"),
            "{reply:?}"
        );
        assert!(
            reply
                .header("content-type")
                .is_some_and(|value| value.contains("application/json")),
            "{reply:?}"
        );
        assert_eq!(
            reply.json()["error"]["code"]["refusal"],
            "unauthenticated",
            "{reply:?}"
        );
        // Discovery is not a way round it: the surface itself is behind the credential.
        let capability = call(2, "system.capability", serde_json::json!({}), true);
        let headers = stateless_headers("tools/call", "system.capability");
        let discovered = post_anonymous(
            addr,
            &format!("127.0.0.1:{}", addr.port()),
            &headers,
            &capability,
        );
        assert_eq!(discovered.status, 401, "{discovered:?}");
        // The same call with a credential is served.
        let served = post_local(
            addr,
            &stateless_headers("tools/call", "scenes.create"),
            &author_call(3),
        );
        assert_eq!(served.status, 200, "{served:?}");
        assert_eq!(
            seen.load(Ordering::SeqCst),
            1,
            "only the credentialed call reached the tool"
        );
    });
    assert_eq!(reached.load(Ordering::SeqCst), 1);
}

#[test]
fn a_credential_that_does_not_verify_is_refused_and_is_never_echoed() {
    let mut server = Server::new(vec![Scope::Author]);
    server.register("scenes.create", Box::new(Echo));
    with_http(server, |addr| {
        let host = format!("127.0.0.1:{}", addr.port());
        let headers = stateless_headers("tools/call", "scenes.create");
        let other_secret = gx_credential::Token::mint(
            "intruder",
            gx_contracts::auth::Role::Editor,
            vec![Scope::Author],
            "another-secret-0123456789abcdefghi",
        )
        .unwrap();
        let mut tampered = client::author_credential();
        tampered.push('0');
        for (what, authorization) in [
            (
                "a credential made with another secret",
                format!("Bearer {}", other_secret.as_str()),
            ),
            (
                "a credential that was altered",
                format!("Bearer {tampered}"),
            ),
            (
                "a credential that is not gx1",
                "Bearer not-a-credential-at-all".to_owned(),
            ),
            ("another scheme", "Basic dXNlcjpwYXNz".to_owned()),
            (
                "a real credential under another scheme",
                format!("Basic {}", client::author_credential()),
            ),
            (
                "a bare credential with no scheme",
                client::author_credential(),
            ),
            ("an empty bearer", "Bearer ".to_owned()),
        ] {
            let mut with = headers.clone();
            with.push(("Authorization", authorization.as_str()));
            let reply = post_anonymous(addr, &host, &with, &author_call(1));
            assert_eq!(reply.status, 401, "{what}: {reply:?}");
            assert_eq!(
                refusal_of(&reply),
                serde_json::Value::Null,
                "{what}: the body names no tool refusal"
            );
            assert_eq!(
                reply.json()["error"]["code"]["refusal"],
                "unauthenticated",
                "{what}: {reply:?}"
            );
            let sent = authorization
                .split_whitespace()
                .last()
                .unwrap_or_default()
                .to_owned();
            assert!(
                sent.len() < 8 || !reply.body.contains(&sent),
                "{what}: the credential was echoed back: {reply:?}"
            );
        }
        // The scheme's case does not matter; a real credential is served.
        let credential = client::author_credential();
        for scheme in ["Bearer", "bearer", "BEARER"] {
            let value = format!("{scheme} {credential}");
            let mut with = headers.clone();
            with.push(("Authorization", value.as_str()));
            let reply = post_anonymous(addr, &host, &with, &author_call(2));
            assert_eq!(reply.status, 200, "{scheme}: {reply:?}");
        }
    });
}

#[test]
fn the_scopes_come_from_the_credential_not_from_the_server() {
    // The server is built with the Author scope. Over HTTP that no longer matters: each call is
    // gated by what its own credential holds.
    let reached = Arc::new(AtomicUsize::new(0));
    let mut server = Server::new(vec![Scope::Author]);
    server.register("scenes.create", Box::new(Counting(Arc::clone(&reached))));
    server.register("playout.take", Box::new(Counting(Arc::clone(&reached))));
    with_http(server, |addr| {
        let host = format!("127.0.0.1:{}", addr.port());
        let create = stateless_headers("tools/call", "scenes.create");
        let take = stateless_headers("tools/call", "playout.take");
        let take_call = call(2, "playout.take", serde_json::json!({}), true);
        let as_author = format!("Bearer {}", client::author_credential());
        let as_operator = format!(
            "Bearer {}",
            client::credential_for(
                "desk-1",
                gx_contracts::auth::Role::Playout,
                vec![Scope::Take]
            )
        );
        let as_nobody = format!(
            "Bearer {}",
            client::credential_for("read-only", gx_contracts::auth::Role::Editor, vec![])
        );
        let send = |headers: &[(&str, &str)], authorization: &str, body: &serde_json::Value| {
            let mut with = headers.to_vec();
            with.push(("Authorization", authorization));
            post_anonymous(addr, &host, &with, body)
        };
        // A credential with no scope cannot author, though the server was built to allow it.
        let refused = send(&create, &as_nobody, &author_call(1));
        assert_eq!(refused.status, 200, "{refused:?}");
        assert_eq!(refusal_of(&refused), "unauthenticated", "{refused:?}");
        // A credential with Take may take, though the server was built with Author only.
        let taken = send(&take, &as_operator, &take_call);
        assert_eq!(
            taken.json()["result"]["structuredContent"],
            serde_json::json!({}),
            "{taken:?}"
        );
        // An author credential may author and may not take.
        assert_eq!(send(&create, &as_author, &author_call(3)).status, 200);
        let not_taken = send(&take, &as_author, &take_call);
        assert_eq!(refusal_of(&not_taken), "unauthenticated", "{not_taken:?}");
    });
    assert_eq!(
        reached.load(Ordering::SeqCst),
        2,
        "the author's create and the operator's take, and nothing else"
    );
}

#[test]
fn a_transport_cannot_be_given_an_empty_secret() {
    assert!(gx_mcp_server::HttpAuth::new("").is_err());
    assert!(gx_mcp_server::HttpAuth::new("a-secret").is_ok());
}
