//! The MCP transport: JSON-RPC 2.0 over stdio (build plan 8.1, transport half).
//!
//! An MCP server for a local tool surface speaks newline-delimited JSON-RPC
//! 2.0 — one message per line, no `Content-Length` headers (the 2025 spec
//! simplified away the LSP framing). This module owns the wire, the three
//! lifecycle methods, and the one rule everything else depends on: **the scope
//! gate lives here and nowhere else.** Every `tools/call` passes through
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

/// What a tool does when called.
///
/// Arguments arrive as `serde_json::Value` because the wire is untyped; the
/// handler is responsible for parsing them into the contract type the registry
/// names as its `input`, so a malformed argument fails in the handler with a
/// named refusal rather than as a transport error.
pub trait ToolHandler {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal>;
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
        Self {
            handlers: BTreeMap::new(),
            scopes,
        }
    }

    /// Register a handler for one tool. The tool must exist in the registry.
    pub fn register(&mut self, tool: &'static str, handler: Box<dyn ToolHandler>) {
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
            "tools/list" => Ok(serde_json::to_value(ToolRegistry::all())
                .expect("the tool registry always serialises")),
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

    /// Dispatch a `tools/call` through the scope gate to its handler.
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

        match self.authorised_handler(name) {
            Ok(handler) => handler.handle(args).map_err(|refusal| {
                (
                    REFUSED,
                    refusal.to_string(),
                    Some(StructuredRefusal::error(refusal)),
                )
            }),
            Err(refusal) => Err((
                REFUSED,
                refusal.to_string(),
                Some(StructuredRefusal::error(refusal)),
            )),
        }
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
    fn capability_discovery_needs_no_scope() {
        let server = Server::new(Vec::new());
        // system.capability is the one tool with no scope requirement: an
        // agent cannot discover what it may do if it cannot ask.
        let handler = server.authorised_handler("system.capability");
        match handler {
            Err(Refusal::NotImplemented { .. }) => {}
            Err(other) => panic!("expected NotImplemented, got {other:?}"),
            Ok(_) => panic!("no handler is registered, but the gate passed"),
        }
    }

    #[test]
    fn tools_list_returns_the_whole_registry() {
        let server = Server::new(Vec::new());
        let reply = server
            .handle(request(1, "tools/list", serde_json::Value::Null))
            .expect("tools/list always replies");
        let listed = reply
            .result
            .expect("a result")
            .as_array()
            .expect("an array")
            .len();
        assert_eq!(listed, ToolRegistry::all().len());
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
