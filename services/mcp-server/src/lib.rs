//! The MCP server: the one scope gate and the one dispatcher (build plan 8.1,
//! transport half; 8.14 for the wire).
//!
//! Real clients reach it through [`wire`], which carries it on the official
//! Rust SDK (rmcp) over stdio and stateless streamable HTTP, speaking the
//! 2026-07-28 and 2025-06-18 revisions. [`Server::handle`] and
//! [`Server::serve`] are the in-process API the handler tests and the
//! conformance harness drive: newline-delimited JSON-RPC with no handshake,
//! the tool's value as `result`. Both paths call [`Server::call_tool`], and
//! that is the one rule everything else depends on: **the scope gate lives
//! here and nowhere else.** Every `tools/call` passes through
//! `ToolRegistry::authorise` before a handler is reached, so a tool cannot be
//! reached by a caller that does not hold its scope — and a handler author
//! never has the option of forgetting to check.
//!
//! Handlers are supplied by the tool crates (editor, playout, motion). This
//! module does not know what any tool *does*; it knows what every tool is
//! allowed to be called by, and that is the whole of its authority.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use gx_contracts::auth::Scope;
use gx_contracts::mcp::{ToolRegistry, TOOL_SCHEMA_VERSION};
use gx_contracts::{Refusal, StructuredRefusal};
use serde::{Deserialize, Serialize};

pub mod wire;

pub use wire::{
    serve_http_listener, Jobs, McpService, HANDSHAKE_PROTOCOL_VERSION, HTTP_PATH,
    SUPPORTED_PROTOCOL_VERSIONS,
};

/// What a tool does when called.
///
/// Arguments arrive as `serde_json::Value` because the wire is untyped; the
/// handler is responsible for parsing them into the contract type the registry
/// names as its `input`, so a malformed argument fails in the handler with a
/// named refusal rather than as a transport error.
pub trait ToolHandler {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal>;

    /// True when `handle` already returns an MCP `CallToolResult`
    /// (`content` plus `structuredContent`), as `render.preview` does to carry
    /// its PNG as an image block. The wire passes such a value through instead
    /// of wrapping it a second time. Declared, never sniffed from the value.
    fn returns_call_tool_result(&self) -> bool {
        false
    }
}

/// One tool as `tools/list` advertises it: its registry entry and the input
/// schema generated from the contract type it takes.
#[derive(Debug, Clone)]
pub struct ListedTool {
    pub descriptor: &'static gx_contracts::mcp::ToolDescriptor,
    pub input_schema: serde_json::Value,
}

/// What a handler returned, and whether it is already a `CallToolResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolOutput {
    /// A contract value; the wire carries it as `structuredContent`.
    Value(serde_json::Value),
    /// A complete MCP `CallToolResult` built by the handler.
    CallToolResult(serde_json::Value),
}

impl ToolOutput {
    /// The value as the in-process API has always returned it.
    pub fn into_value(self) -> serde_json::Value {
        match self {
            Self::Value(value) | Self::CallToolResult(value) => value,
        }
    }
}

/// `system.capability`: the discovery surface, as a tool.
///
/// Lives here rather than in a tool crate because it needs no state beyond the
/// contracts themselves, and because the server registers it by construction —
/// an agent must be able to ask what it may do before it can do anything.
pub struct CapabilityTool;

impl ToolHandler for CapabilityTool {
    fn handle(&self, _args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        serde_json::to_value(gx_contracts::mcp::capability_surface()).map_err(|error| {
            Refusal::TransportFailed {
                detail: error.to_string(),
            }
        })
    }
}

/// A parsed JSON-RPC 2.0 request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

/// One JSON-RPC 2.0 reply.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    /// The structured refusal, so an agent can act on it without parsing
    /// prose (D.1 principle 3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<StructuredRefusal>,
}

// JSON-RPC 2.0's own error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
/// Refusals are not protocol errors, so they get an application code rather
/// than masquerading as one of the reserved ones.
const REFUSED: i64 = -32000;

/// The server: a set of handlers, the caller's scopes, and the one gate.
pub struct Server {
    handlers: BTreeMap<&'static str, Box<dyn ToolHandler>>,
    scopes: Vec<Scope>,
}

impl Server {
    /// Build a server with the caller's scopes.
    ///
    /// Scopes are presented at connection, not per call, for the same reason
    /// the control plane authenticates the connection rather than every
    /// message: a caller that had to prove itself per request would eventually
    /// be trusted on the strength of a handler that forgot to ask.
    pub fn new(scopes: Vec<Scope>) -> Self {
        let mut server = Self {
            handlers: BTreeMap::new(),
            scopes,
        };
        // Registered by construction rather than left to the caller. This is
        // the one tool an agent must call before it knows anything else, and
        // a server that answered "no handler" to capability discovery would
        // be undiscoverable by the very mechanism that exists to make it
        // discoverable (D.1 principle 2).
        server.register("system.capability", Box::new(CapabilityTool));
        server
    }

    /// Register a handler for one tool. The tool must exist in the registry.
    pub fn register(&mut self, tool: &'static str, handler: Box<dyn ToolHandler>) {
        assert!(ToolRegistry::get(tool).is_some(), "unregistered MCP tool {tool}");
        self.handlers.insert(tool, handler);
    }

    /// The handler for one tool, if the caller may reach it.
    fn authorised_handler(
        &self,
        name: &str,
    ) -> Result<&dyn ToolHandler, Refusal> {
        // The gate runs before the lookup, so an out-of-scope call to a tool
        // that exists and one that does not are indistinguishable — a caller
        // probing for what exists learns nothing it was not told.
        ToolRegistry::authorise(name, &self.scopes)?;
        self.handlers
            .get(name)
            .map(|handler| handler.as_ref())
            .ok_or_else(|| Refusal::NotImplemented {
                what: format!("tool {name} is declared but has no handler"),
            })
    }

    /// Answer one request.
    pub fn handle(&self, request: Request) -> Option<Response> {
        // A notification carries no id and gets no reply.
        let id = request.id.clone()?;

        if request.jsonrpc != "2.0" {
            return Some(self.error(id, INVALID_REQUEST, "not JSON-RPC 2.0", None));
        }

        let result = match request.method.as_str() {
            "initialize" => Ok(serde_json::json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "gx-mcp-server",
                    "version": TOOL_SCHEMA_VERSION,
                },
            })),
            // The spec's shape is an object, not a bare array: the field is
            // what makes room for `nextCursor` later without the reply
            // changing type. A client reading `result.tools` against an array
            // finds nothing and concludes the server has no tools at all —
            // which is the discovery failure this surface exists to prevent.
            "tools/list" => self.list(),
            "tools/call" => self.call(request.params),
            other => Err((
                METHOD_NOT_FOUND,
                format!("no method {other}"),
                None,
            )),
        };

        Some(match result {
            Ok(value) => Response {
                jsonrpc: "2.0",
                id,
                result: Some(value),
                error: None,
            },
            Err((code, message, data)) => self.error(id, code, &message, data),
        })
    }

    /// The installed tools, in registry order, with schemas generated from
    /// their inputs. Both the in-process API and the MCP wire list from here.
    pub fn listed_tools(&self) -> Result<Vec<ListedTool>, Refusal> {
        ToolRegistry::all()
            .iter()
            .filter(|tool| self.handlers.contains_key(tool.name))
            .map(|descriptor| {
                Ok(ListedTool {
                    descriptor,
                    input_schema: gx_contracts::mcp::input_schema(descriptor.input)?,
                })
            })
            .collect()
    }

    /// Call one tool through the scope gate. Both the in-process API and the
    /// MCP wire dispatch from here, so there is one gate on every path.
    pub fn call_tool(&self, name: &str, args: serde_json::Value) -> Result<ToolOutput, Refusal> {
        let handler = self.authorised_handler(name)?;
        let value = handler.handle(args)?;
        Ok(if handler.returns_call_tool_result() {
            ToolOutput::CallToolResult(value)
        } else {
            ToolOutput::Value(value)
        })
    }

    /// Discover installed handlers with schemas generated from their inputs.
    // A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
    #[allow(clippy::result_large_err)]
    fn list(&self) -> Result<serde_json::Value, (i64, String, Option<StructuredRefusal>)> {
        let listed = self
            .listed_tools()
            .map_err(|refusal| (REFUSED, refusal.to_string(), Some(StructuredRefusal::error(refusal))))?;
        let tools: Vec<serde_json::Value> = listed
            .into_iter()
            .map(|tool| {
                let mut value = serde_json::to_value(tool.descriptor)
                    .expect("a tool descriptor is serialisable");
                value["description"] = serde_json::json!(tool.descriptor.summary);
                value["inputSchema"] = tool.input_schema;
                value
            })
            .collect();
        Ok(serde_json::json!({ "tools": tools }))
    }

    /// Dispatch a `tools/call` through the scope gate to its handler.
    // A refusal carries its field, the given value and the allowed list; the Err variant is large by design.
    #[allow(clippy::result_large_err)]
    fn call(
        &self,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, (i64, String, Option<StructuredRefusal>)> {
        let params = params.ok_or((
            INVALID_PARAMS,
            "tools/call needs params".to_string(),
            None,
        ))?;
        let name = params
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or((
                INVALID_PARAMS,
                "tools/call needs a tool name".to_string(),
                None,
            ))?;
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        self.call_tool(name, args)
            .map(ToolOutput::into_value)
            .map_err(|refusal| {
                (
                    REFUSED,
                    refusal.to_string(),
                    Some(StructuredRefusal::error(refusal)),
                )
            })
    }

    fn error(
        &self,
        id: serde_json::Value,
        code: i64,
        message: &str,
        data: Option<StructuredRefusal>,
    ) -> Response {
        Response {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.to_string(),
                data,
            }),
        }
    }

    /// Read newline-delimited JSON-RPC from `input` and write replies to
    /// `output`.
    pub fn serve(
        &self,
        input: impl std::io::BufRead,
        mut output: impl std::io::Write,
    ) -> std::io::Result<()> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Request>(&line) {
                Ok(request) => self.handle(request),
                Err(_) => Some(self.error(
                    serde_json::Value::Null,
                    PARSE_ERROR,
                    "not valid JSON-RPC",
                    None,
                )),
            };
            if let Some(reply) = reply {
                let bytes = serde_json::to_string(&reply).map_err(std::io::Error::other)?;
                output.write_all(bytes.as_bytes())?;
                output.write_all(b"\n")?;
                output.flush()?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo;
    impl ToolHandler for Echo {
        fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
            Ok(args)
        }
    }

    fn request(id: u64, method: &str, params: serde_json::Value) -> Request {
        Request {
            jsonrpc: "2.0".into(),
            id: Some(serde_json::json!(id)),
            method: method.into(),
            params: Some(params),
        }
    }

    fn call(server: &Server, name: &str, args: serde_json::Value) -> Option<Response> {
        server.handle(request(
            1,
            "tools/call",
            serde_json::json!({ "name": name, "arguments": args }),
        ))
    }

    #[test]
    fn a_call_reaches_its_handler_after_the_gate() {
        let mut server = Server::new(vec![Scope::Author]);
        server.register("scenes.create", Box::new(Echo));

        let reply = call(&server, "scenes.create", serde_json::json!({"id": "x"}))
            .expect("a request with an id gets a reply");
        assert_eq!(reply.result, Some(serde_json::json!({"id": "x"})));
        assert!(reply.error.is_none());
    }

    #[test]
    fn an_unknown_tool_is_refused_by_name_not_reached() {
        let server = Server::new(vec![Scope::Author]);
        let reply = call(&server, "scenes.obliterate", serde_json::Value::Null)
            .expect("a refusal is a reply");
        let error = reply.error.expect("a refusal carries an error");
        assert_eq!(error.code, REFUSED);
        assert!(matches!(
            error.data.expect("structured").code,
            Refusal::NotImplemented { .. }
        ));
    }

    #[test]
    fn an_out_of_scope_call_is_refused_and_the_handler_is_never_reached() {
        // 8.11's done-when lives in the transport, not the handler: the gate
        // refuses before the handler is found, so there is no handler that
        // could forget to check. Register the handler anyway to prove it is
        // not the handler that stops the call.
        let mut server = Server::new(vec![Scope::Author]);
        server.register("playout.take", Box::new(Echo));

        let reply = call(&server, "playout.take", serde_json::Value::Null)
            .expect("a refusal is a reply");
        let error = reply.error.expect("a refusal carries an error");
        assert_eq!(error.code, REFUSED);
        assert!(matches!(
            error.data.expect("structured").code,
            Refusal::Unauthenticated
        ));
    }

    #[test]
    fn capability_discovery_answers_with_no_scope_at_all() {
        // The one tool with no scope requirement, and the one registered by
        // construction: an agent that cannot ask what it may do cannot use
        // the surface at all (D.1 principle 2).
        let server = Server::new(Vec::new());
        let reply = call(&server, "system.capability", serde_json::Value::Null)
            .expect("capability always answers");
        assert!(reply.error.is_none(), "capability must not refuse");

        let surface = reply.result.expect("a surface");
        assert_eq!(
            surface["tools"].as_array().map(Vec::len),
            Some(ToolRegistry::all().len()),
            "the surface carries the whole registry"
        );
        assert!(
            surface["refusals"]
                .as_array()
                .expect("refusal codes")
                .contains(&serde_json::json!("revisionMismatch")),
            "an agent learns the refusals it may receive"
        );
    }

    #[test]
    fn tools_list_returns_the_whole_registry_under_the_spec_field() {
        let mut server = Server::new(Vec::new());
        for tool in ToolRegistry::all() {
            server.register(tool.name, Box::new(Echo));
        }
        let reply = server
            .handle(request(1, "tools/list", serde_json::Value::Null))
            .expect("tools/list always replies");
        let result = reply.result.expect("a result");
        // Named field, not a bare array: a spec-conformant client reads
        // `result.tools`, and an array there reads as "no tools".
        let listed = result["tools"]
            .as_array()
            .expect("the registry arrives under `tools`")
            .len();
        assert_eq!(listed, ToolRegistry::all().len());
        for tool in result["tools"].as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            let descriptor = ToolRegistry::get(name).unwrap();
            let generated = gx_contracts::mcp::input_schema(descriptor.input).unwrap();
            assert_eq!(tool["inputSchema"], generated, "{name}");
            assert_eq!(tool["inputSchema"]["type"], "object", "{name}");
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../Shared/generated-ts/schemas/mcp")
                .join(format!("{name}.schema.json"));
            let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(tool["inputSchema"], stored, "stale generated MCP schema for {name}");
        }
    }

    #[test]
    fn tools_list_only_advertises_installed_handlers() {
        let server = Server::new(Vec::new());
        let reply = server.handle(request(1, "tools/list", serde_json::Value::Null)).unwrap();
        let tools = reply.result.unwrap()["tools"].as_array().unwrap().clone();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "system.capability");
    }

    #[test]
    fn a_notification_gets_no_reply() {
        let server = Server::new(Vec::new());
        let notification = Request {
            jsonrpc: "2.0".into(),
            id: None,
            method: "notifications/initialized".into(),
            params: None,
        };
        assert!(server.handle(notification).is_none());
    }

    #[test]
    fn malformed_json_is_a_parse_error_not_a_crash() {
        let server = Server::new(Vec::new());
        let mut out = Vec::new();
        server
            .serve(b"not json\n".as_slice(), &mut out)
            .expect("a bad line is an error reply, not a crash");
        let reply: serde_json::Value =
            serde_json::from_slice(&out).expect("the reply is JSON");
        assert_eq!(reply["error"]["code"], PARSE_ERROR);
    }
}
