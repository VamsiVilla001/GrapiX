//! The MCP wire on the official Rust SDK, rmcp (build plan 8.14, transport half).
//!
//! [`Server`] stays the one gate and the one dispatcher. This module carries
//! it over the protocol revisions and transports rmcp implements, and decides
//! nothing about who may call what.
//!
//! - **Revisions.** 2026-07-28, where there is no `initialize` and every
//!   request carries its own `_meta` (protocol version and client
//!   capabilities), and 2025-06-18, which has the `initialize` handshake. A
//!   client that names any other revision in `initialize`, 2026-07-28
//!   included, is answered 2025-06-18.
//! - **Transports.** Newline-delimited stdio, and stateless streamable HTTP
//!   bound to 127.0.0.1 and nothing else.
//! - **Results.** A tool's value is `structuredContent`, with one text block
//!   holding the same JSON for clients that read only `content`. A handler
//!   that builds its own `CallToolResult` (`render.preview`'s image block)
//!   declares so and is passed through.
//! - **Refusals** are not tool results. They stay JSON-RPC errors, code
//!   -32000, with the `StructuredRefusal` in `data`, exactly as the in-process
//!   API returns them.
//!
//! The server is owned by one thread. rmcp answers the transport on a tokio
//! runtime and hands every `tools/list` and `tools/call` to that thread over
//! a channel ([`Server::drive`]), so calls run one at a time as they did on
//! the hand-rolled loop — the handlers write the project store, and a second
//! client on HTTP must not interleave a write with the first one's — and a
//! handler need not be `Send`.
//!
//! On the stdio wire a line that is not JSON-RPC is dropped with no reply.
//! That is rmcp's behaviour, pinned by a test in `gx-editor-mcp`; the
//! in-process [`Server::serve`] still answers it with -32700.

use std::borrow::Cow;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use gx_contracts::mcp::{ToolEffect, TOOL_SCHEMA_VERSION};
use gx_contracts::{Refusal, StructuredRefusal};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ErrorCode, Implementation,
    ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
    Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use tokio_util::sync::CancellationToken;

use crate::{ListedTool, Server, ToolOutput, REFUSED};

/// The revisions this server speaks, oldest first. Nothing between them is
/// claimed: a 2025-11-25 client is answered 2025-06-18 at `initialize`.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[ProtocolVersion] =
    &[ProtocolVersion::V_2025_06_18, ProtocolVersion::V_2026_07_28];

/// The revision `initialize` answers when the client asks for one this server
/// cannot serve over the handshake. 2026-07-28 has no handshake to answer.
pub const HANDSHAKE_PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V_2025_06_18;

/// Where the HTTP transport is advertised. Every path is served, so a client
/// configured with the bare origin still reaches the same endpoint.
pub const HTTP_PATH: &str = "/mcp";

/// The `_meta` key under which each listed tool carries its registry entry:
/// group, effect, required scope and contract types. A client that reads only
/// the spec fields loses nothing it needs; one that knows GrapiX gets the
/// scope before it calls.
pub const TOOL_META_KEY: &str = "dev.grapix/tool";

/// One unit of work for the thread that owns the server.
struct Job {
    kind: JobKind,
    reply: tokio::sync::oneshot::Sender<Result<Answer, Refusal>>,
}

enum JobKind {
    List,
    Call {
        name: String,
        args: serde_json::Value,
    },
}

enum Answer {
    Listed(Vec<ListedTool>),
    Called(ToolOutput),
}

/// The receiving end of a service's calls. See [`Server::drive`].
pub struct Jobs(mpsc::Receiver<Job>);

/// A [`Server`] as an rmcp service: the sending end of its job channel.
/// Cloning shares the one server.
#[derive(Clone)]
pub struct McpService {
    jobs: mpsc::Sender<Job>,
}

impl McpService {
    /// A service and the jobs it will send. The jobs must be driven by the
    /// thread that owns the server, or every request waits forever.
    pub fn pair() -> (Self, Jobs) {
        let (sender, receiver) = mpsc::channel();
        (Self { jobs: sender }, Jobs(receiver))
    }

    async fn ask(&self, kind: JobKind) -> Result<Answer, ErrorData> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        let gone = || {
            refused(Refusal::TransportFailed {
                detail: "the MCP server thread is no longer answering".into(),
            })
        };
        self.jobs.send(Job { kind, reply }).map_err(|_| gone())?;
        answer.await.map_err(|_| gone())?.map_err(refused)
    }
}

impl Server {
    /// Answer `jobs` on this thread until every [`McpService`] that sends
    /// them has been dropped. Calls run strictly one after another.
    pub fn drive(&self, jobs: Jobs) {
        for job in jobs.0 {
            let answer = match job.kind {
                JobKind::List => self.listed_tools().map(Answer::Listed),
                JobKind::Call { name, args } => self.call_tool(&name, args).map(Answer::Called),
            };
            // A client that went away mid-call is not an error here.
            let _ = job.reply.send(answer);
        }
    }
}

/// A refusal as the JSON-RPC error the in-process API has always produced.
fn refused(refusal: Refusal) -> ErrorData {
    let message = refusal.to_string();
    let data = serde_json::to_value(StructuredRefusal::error(refusal))
        .expect("a structured refusal is serialisable");
    ErrorData::new(ErrorCode(REFUSED as i32), message, Some(data))
}

/// One registry entry as an MCP `Tool`.
fn tool(listed: ListedTool) -> Result<Tool, ErrorData> {
    let descriptor = listed.descriptor;
    let value = serde_json::json!({
        "name": descriptor.name,
        "description": descriptor.summary,
        "inputSchema": listed.input_schema,
        "annotations": { "readOnlyHint": descriptor.effect == ToolEffect::Read },
        "_meta": { TOOL_META_KEY: descriptor },
    });
    serde_json::from_value(value).map_err(|error| {
        refused(Refusal::TransportFailed {
            detail: format!(
                "MCP tool {} does not fit the Tool shape: {error}",
                descriptor.name
            ),
        })
    })
}

impl ServerHandler for McpService {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
        info.protocol_version = HANDSHAKE_PROTOCOL_VERSION;
        info.server_info = Implementation::new("gx-mcp-server", TOOL_SCHEMA_VERSION.to_string());
        info
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(SUPPORTED_PROTOCOL_VERSIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let Answer::Listed(listed) = self.ask(JobKind::List).await? else {
            unreachable!("a list job is answered with a listing")
        };
        let tools = listed
            .into_iter()
            .map(tool)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.into_owned();
        // An absent `arguments` reaches the handler as null, as it always has,
        // so the handler's own parse names what is missing.
        let args = request
            .arguments
            .map(serde_json::Value::Object)
            .unwrap_or(serde_json::Value::Null);
        let job = JobKind::Call {
            name: name.clone(),
            args,
        };
        let Answer::Called(output) = self.ask(job).await? else {
            unreachable!("a call job is answered with the tool's output")
        };
        let result = match output {
            ToolOutput::Value(value) => CallToolResult::structured(value),
            ToolOutput::CallToolResult(value) => {
                serde_json::from_value(value).map_err(|error| {
                    refused(Refusal::TransportFailed {
                        detail: format!(
                            "{name} declared a CallToolResult it did not return: {error}"
                        ),
                    })
                })?
            }
        };
        Ok(result.into())
    }
}

fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
}

impl Server {
    /// Serve MCP on this process's stdin and stdout until the client closes
    /// stdin. A client that closes before saying anything is a clean exit.
    pub fn serve_stdio(self) -> std::io::Result<()> {
        let runtime = runtime()?;
        let (service, jobs) = McpService::pair();
        let transport = runtime.spawn(async move {
            let running = match service.serve(rmcp::transport::stdio()).await {
                Ok(running) => running,
                Err(rmcp::service::ServerInitializeError::ConnectionClosed(_)) => return Ok(()),
                Err(error) => return Err(std::io::Error::other(error)),
            };
            running.waiting().await.map_err(std::io::Error::other)?;
            Ok(())
        });
        self.drive(jobs);
        runtime.block_on(transport).map_err(std::io::Error::other)?
    }

    /// Serve stateless streamable HTTP on `127.0.0.1:port` until the process
    /// ends. The address is fixed: there is no way to ask this for any
    /// interface but loopback. `on_bound` learns the bound address (port 0
    /// picks a free one) before the first request is accepted.
    pub fn serve_http(self, port: u16, on_bound: impl FnOnce(SocketAddr)) -> std::io::Result<()> {
        check_http_listen(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))?;
        let runtime = runtime()?;
        let listener =
            runtime.block_on(tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)))?;
        on_bound(listener.local_addr()?);
        let (service, jobs) = McpService::pair();
        let transport = runtime.spawn(serve_http_listener(
            service,
            listener,
            CancellationToken::new(),
        ));
        self.drive(jobs);
        runtime.block_on(transport).map_err(std::io::Error::other)?
    }
}

/// The MCP HTTP transport's case of the one bind policy (2.21): it verifies no
/// credential, so it listens on loopback only and on no reserved port. A
/// refusal is `PermissionDenied`, naming the transport and the reason.
fn check_http_listen(addr: SocketAddr) -> std::io::Result<()> {
    gx_contracts::endpoints::check_listen_io(gx_contracts::endpoints::Plane::McpHttp, addr, None)
}

/// Serve stateless streamable HTTP on a listener already bound to 127.0.0.1,
/// until `shutdown` is cancelled.
///
/// Refuses a listener on any other address. `Host` must name 127.0.0.1 or
/// localhost (DNS rebinding), and a request that carries any browser `Origin`
/// is rejected: the clients of this endpoint are local agents, not web pages.
pub async fn serve_http_listener(
    service: McpService,
    listener: tokio::net::TcpListener,
    shutdown: CancellationToken,
) -> std::io::Result<()> {
    serve_http_listener_within(service, listener, shutdown, HttpLimits::default()).await
}

/// What the MCP HTTP transport holds every connection to (2.22). A connection
/// that sends nothing, or a request head that begins and stops, costs a task for
/// `header_read_timeout` and no longer; the listener holds at most
/// `max_connections` and closes one more at once; every accepted stream is
/// low-latency.
///
/// Not bounded here, and named: a request body that begins and stops. The
/// service reads it without a deadline of its own, so a peer that sends complete
/// headers and then stalls holds its task until it closes (see 2.22's limits).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HttpLimits {
    pub max_connections: usize,
    /// How long a connection has to send a whole request head, from the moment
    /// it waits for one: when it is new, and again after each response on a
    /// connection kept alive.
    pub header_read_timeout: Duration,
}

impl Default for HttpLimits {
    fn default() -> Self {
        Self {
            max_connections: 16,
            header_read_timeout: Duration::from_secs(10),
        }
    }
}

/// Apply the per-stream limits to an accepted stream. Returns what could not be
/// applied, by name.
fn configure_http_stream(stream: &tokio::net::TcpStream) -> Vec<String> {
    let mut problems = Vec::new();
    if let Err(error) = stream.set_nodelay(true) {
        problems.push(format!("low latency: {error}"));
    }
    problems
}

/// [`serve_http_listener`] under explicit limits.
pub async fn serve_http_listener_within(
    service: McpService,
    listener: tokio::net::TcpListener,
    shutdown: CancellationToken,
    limits: HttpLimits,
) -> std::io::Result<()> {
    let local = listener.local_addr()?;
    check_http_listen(local)?;
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .with_allowed_hosts(["127.0.0.1", "localhost"])
        .enforce_origin_validation()
        .with_cancellation_token(shutdown.child_token());
    let http = StreamableHttpService::new(
        move || Ok(service.clone()),
        Arc::new(NeverSessionManager::default()),
        config,
    );
    let places = Arc::new(tokio::sync::Semaphore::new(limits.max_connections));
    loop {
        let (stream, _) = tokio::select! {
            accepted = listener.accept() => accepted?,
            () = shutdown.cancelled() => return Ok(()),
        };
        // A connection over the cap is closed at once (dropped), and the listener
        // keeps accepting. The place is given back when its task ends.
        let Ok(place) = Arc::clone(&places).try_acquire_owned() else {
            tracing::warn!(
                event = "mcp.connection_refused",
                cap = limits.max_connections,
                reason = "the listener is holding its most connections",
            );
            continue;
        };
        for problem in configure_http_stream(&stream) {
            tracing::warn!(event = "mcp.limits_not_applied", detail = problem.as_str());
        }
        let connection = hyper_util::service::TowerToHyperService::new(http.clone());
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let _place = place;
            let serving = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(limits.header_read_timeout)
                .serve_connection(hyper_util::rt::TokioIo::new(stream), connection);
            tokio::select! {
                _ = serving => {}
                () = shutdown.cancelled() => {}
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolHandler;
    use gx_contracts::auth::Scope;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    struct Echo;
    impl ToolHandler for Echo {
        fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
            Ok(args)
        }
    }

    struct Image;
    impl ToolHandler for Image {
        fn handle(&self, _args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
            Ok(serde_json::json!({
                "content": [{ "type": "image", "data": "AAAA", "mimeType": "image/png" }],
                "structuredContent": { "frame": 7 },
            }))
        }
        fn returns_call_tool_result(&self) -> bool {
            true
        }
    }

    /// Drive the rmcp wire over an in-memory pipe the way a client does: send
    /// one message, read its reply, then the next. The server is driven on
    /// the test thread, as the shipped binaries drive it on their main one.
    fn exchange(server: Server, messages: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
        let runtime = runtime().unwrap();
        let (service, jobs) = McpService::pair();
        let client = runtime.spawn(async move {
            let (client, served) = tokio::io::duplex(1 << 16);
            let (read, write) = tokio::io::split(served);
            let task = tokio::spawn(async move {
                if let Ok(running) = service.serve((read, write)).await {
                    let _ = running.waiting().await;
                }
            });
            let (client_read, mut client_write) = tokio::io::split(client);
            let mut lines = BufReader::new(client_read).lines();
            let mut replies = Vec::new();
            for message in messages {
                client_write
                    .write_all(format!("{message}\n").as_bytes())
                    .await
                    .unwrap();
                if message.get("id").is_some() {
                    let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
                        .await
                        .expect("a reply arrives")
                        .unwrap()
                        .expect("the server is still talking");
                    replies.push(serde_json::from_str(&line).unwrap());
                }
            }
            // Shut the write side down so the server reads EOF. Dropping one
            // half of a split duplex closes nothing while the other half lives.
            client_write.shutdown().await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), task)
                .await
                .expect("the server ends when its client closes")
                .unwrap();
            replies
        });
        server.drive(jobs);
        runtime.block_on(client).unwrap()
    }

    fn initialize(version: &str) -> serde_json::Value {
        serde_json::json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {
                "protocolVersion": version,
                "capabilities": {},
                "clientInfo": { "name": "wire-test", "version": "1" },
            },
        })
    }

    fn initialized() -> serde_json::Value {
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
    }

    fn call(id: u64, name: &str, arguments: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        })
    }

    #[test]
    fn a_value_is_structured_content_with_the_same_json_as_text() {
        let mut server = Server::new(vec![Scope::Author]);
        server.register("scenes.create", Box::new(Echo));
        let replies = exchange(
            server,
            vec![
                initialize("2025-06-18"),
                initialized(),
                call(1, "scenes.create", serde_json::json!({ "id": "x" })),
            ],
        );
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "gx-mcp-server");
        let result = &replies[1]["result"];
        assert_eq!(
            result["structuredContent"],
            serde_json::json!({ "id": "x" })
        );
        assert_eq!(result["content"][0]["type"], "text");
        let text: serde_json::Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, result["structuredContent"]);
        assert_ne!(result["isError"], true);
    }

    #[test]
    fn the_scope_gate_refuses_on_the_wire_with_the_structured_refusal() {
        // The same gate as the in-process API: an author cannot reach
        // playout.take even with a handler registered for it.
        let mut server = Server::new(vec![Scope::Author]);
        server.register("playout.take", Box::new(Echo));
        let replies = exchange(
            server,
            vec![
                initialize("2025-06-18"),
                initialized(),
                call(1, "playout.take", serde_json::Value::Null),
            ],
        );
        let reply = &replies[1];
        assert!(reply["result"].is_null(), "{reply}");
        assert_eq!(reply["error"]["code"], REFUSED);
        let expected =
            serde_json::to_value(StructuredRefusal::error(Refusal::Unauthenticated)).unwrap();
        assert_eq!(reply["error"]["data"], expected, "{reply}");
    }

    #[test]
    fn a_declared_call_tool_result_is_passed_through_not_wrapped() {
        let mut server = Server::new(vec![Scope::Author]);
        server.register("render.preview", Box::new(Image));
        let replies = exchange(
            server,
            vec![
                initialize("2025-06-18"),
                initialized(),
                call(1, "render.preview", serde_json::json!({})),
            ],
        );
        let result = &replies[1]["result"];
        assert_eq!(result["content"][0]["type"], "image", "{result}");
        assert_eq!(result["content"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            result["structuredContent"],
            serde_json::json!({ "frame": 7 })
        );
    }

    #[test]
    fn initialize_negotiates_down_to_2025_06_18() {
        for asked in ["2026-07-28", "2025-11-25", "2025-06-18", "2024-11-05"] {
            let replies = exchange(Server::new(Vec::new()), vec![initialize(asked)]);
            assert_eq!(
                replies[0]["result"]["protocolVersion"], "2025-06-18",
                "asked {asked}"
            );
        }
    }

    #[test]
    fn a_2026_07_28_request_is_served_with_no_handshake() {
        let request = serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {
                "name": "system.capability",
                "arguments": {},
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
            },
        });
        let replies = exchange(Server::new(Vec::new()), vec![request]);
        let surface = &replies[0]["result"]["structuredContent"];
        assert_eq!(
            surface["tools"].as_array().map(Vec::len),
            Some(gx_contracts::mcp::ToolRegistry::all().len()),
            "{}",
            replies[0]
        );
    }

    #[test]
    fn tools_list_carries_the_generated_schema_and_the_registry_entry() {
        let mut server = Server::new(Vec::new());
        server.register("scenes.create", Box::new(Echo));
        let replies = exchange(
            server,
            vec![
                initialize("2025-06-18"),
                initialized(),
                serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
            ],
        );
        let tools = replies[1]["result"]["tools"].as_array().unwrap();
        let mut names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        names.sort_unstable();
        assert_eq!(
            names,
            ["scenes.create", "system.capability"],
            "only installed handlers are listed"
        );
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let descriptor = gx_contracts::mcp::ToolRegistry::get(name).unwrap();
            assert_eq!(
                tool["inputSchema"],
                gx_contracts::mcp::input_schema(descriptor.input).unwrap(),
                "{name}"
            );
            assert_eq!(
                tool["_meta"][TOOL_META_KEY],
                serde_json::to_value(descriptor).unwrap(),
                "{name}"
            );
            assert_eq!(
                tool["annotations"]["readOnlyHint"],
                descriptor.effect == ToolEffect::Read,
                "{name}"
            );
        }
    }

    /// 2.21: the transport asks the one bind policy. It verifies no credential,
    /// so no interface but loopback is allowed it, token or not, and the message
    /// names the transport and the reason.
    #[test]
    fn the_http_policy_names_the_transport_and_allows_loopback_only() {
        for ip in ["0.0.0.0", "192.168.1.50", "::"] {
            let addr = SocketAddr::new(ip.parse().unwrap(), 4500);
            let refused = check_http_listen(addr).expect_err("off loopback is refused");
            assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied, "{ip}");
            let said = refused.to_string();
            assert!(
                said.contains("MCP HTTP transport") && said.contains("verifies no credential"),
                "{ip}: {said}"
            );
        }
        for ip in ["127.0.0.1", "::1"] {
            check_http_listen(SocketAddr::new(ip.parse().unwrap(), 4500))
                .expect("loopback is allowed");
        }
    }

    /// 2.21: `--http` no longer takes any port at all: a reserved one is refused
    /// by name before anything binds.
    #[test]
    fn the_http_transport_refuses_a_reserved_port_before_it_binds() {
        for port in [4100, 4200, 4300] {
            let refused = Server::new(Vec::new())
                .serve_http(port, |_| panic!("nothing listens on a reserved port"))
                .expect_err("a reserved port is refused");
            assert_eq!(
                refused.kind(),
                std::io::ErrorKind::PermissionDenied,
                "{port}"
            );
            assert!(
                refused
                    .to_string()
                    .contains(&format!("port {port} is reserved")),
                "{port}: {refused}"
            );
        }
    }

    // --- 2.22: a stalled peer costs a bounded task for a bounded time ----------------

    fn serve_within(
        limits: HttpLimits,
    ) -> (SocketAddr, tokio::runtime::Runtime, CancellationToken) {
        let runtime = runtime().unwrap();
        let (service, _jobs) = McpService::pair();
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)))
            .unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        runtime.spawn(serve_http_listener_within(
            service,
            listener,
            shutdown.clone(),
            limits,
        ));
        (address, runtime, shutdown)
    }

    /// How long until the server closes `stream`, or `None` if it is still open
    /// after `limit`. Anything it sends meanwhile is read and thrown away.
    fn closed_after(stream: &mut std::net::TcpStream, limit: Duration) -> Option<Duration> {
        use std::io::Read as _;
        let started = std::time::Instant::now();
        let mut sink = [0u8; 256];
        while started.elapsed() < limit {
            let left = limit
                .saturating_sub(started.elapsed())
                .max(Duration::from_millis(1));
            stream.set_read_timeout(Some(left)).unwrap();
            match stream.read(&mut sink) {
                Ok(0) => return Some(started.elapsed()),
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return None
                }
                Err(_) => return Some(started.elapsed()),
            }
        }
        None
    }

    #[test]
    fn a_connection_that_sends_nothing_is_dropped_at_the_header_deadline() {
        let (address, _runtime, shutdown) = serve_within(HttpLimits {
            max_connections: 4,
            header_read_timeout: Duration::from_millis(400),
        });
        let mut silent = std::net::TcpStream::connect(address).unwrap();
        let took = closed_after(&mut silent, Duration::from_secs(5))
            .expect("a silent connection was still held after 5 s");
        assert!(
            took >= Duration::from_millis(300) && took < Duration::from_secs(3),
            "dropped after {took:?}, deadline 400 ms"
        );
        shutdown.cancel();
    }

    #[test]
    fn a_request_head_that_begins_and_stalls_is_dropped_at_the_header_deadline() {
        use std::io::Write as _;
        let (address, _runtime, shutdown) = serve_within(HttpLimits {
            max_connections: 4,
            header_read_timeout: Duration::from_millis(400),
        });
        let mut slow = std::net::TcpStream::connect(address).unwrap();
        slow.write_all(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            .unwrap();
        let took = closed_after(&mut slow, Duration::from_secs(5))
            .expect("a head that stalled was still held after 5 s");
        assert!(
            took >= Duration::from_millis(300) && took < Duration::from_secs(3),
            "dropped after {took:?}, deadline 400 ms"
        );
        shutdown.cancel();
    }

    #[test]
    fn a_connection_over_the_cap_is_closed_at_once_and_a_place_is_given_back() {
        let (address, _runtime, shutdown) = serve_within(HttpLimits {
            max_connections: 2,
            header_read_timeout: Duration::from_secs(30),
        });
        let first = std::net::TcpStream::connect(address).unwrap();
        let _second = std::net::TcpStream::connect(address).unwrap();
        // Let the server take both places before the third arrives.
        std::thread::sleep(Duration::from_millis(300));
        let mut third = std::net::TcpStream::connect(address).unwrap();
        let took = closed_after(&mut third, Duration::from_secs(3))
            .expect("a connection over the cap was held");
        assert!(
            took < Duration::from_secs(1),
            "closed after {took:?}, not at once"
        );

        drop(first);
        let started = std::time::Instant::now();
        let mut held = false;
        while started.elapsed() < Duration::from_secs(5) && !held {
            let mut again = std::net::TcpStream::connect(address).unwrap();
            held = closed_after(&mut again, Duration::from_millis(500)).is_none();
        }
        assert!(held, "a place was never given back");
        shutdown.cancel();
    }

    #[test]
    fn an_accepted_stream_is_low_latency() {
        let runtime = runtime().unwrap();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let _client = tokio::net::TcpStream::connect(address).await.unwrap();
            let (accepted, _) = listener.accept().await.unwrap();
            assert!(configure_http_stream(&accepted).is_empty());
            assert!(accepted.nodelay().unwrap(), "Nagle is still on");
        });
    }

    #[test]
    fn the_http_transport_refuses_a_listener_off_loopback() {
        // 0.0.0.0 is the address a careless caller would pass to "listen on
        // everything"; it must not be served.
        let runtime = runtime().unwrap();
        let (service, _jobs) = McpService::pair();
        // A transport that served this listener would serve it for ever; the
        // shutdown ends it after a few seconds so the failure is a failed
        // assertion, not a hung test.
        let shutdown = CancellationToken::new();
        let end = shutdown.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            end.cancel();
        });
        let refused = runtime
            .block_on(async {
                let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
                    .await
                    .unwrap();
                serve_http_listener(service, listener, shutdown).await
            })
            .expect_err(
                "only 127.0.0.1 is served: this listener was served until it was shut down",
            );
        assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
    }
}
