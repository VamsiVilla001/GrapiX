//! The Figma link (build plan 18.2).
//!
//! GrapiX reads a Figma frame by being an MCP client of the Figma desktop app's local
//! server (`http://127.0.0.1:3845/mcp`). That server is the user's open Figma session on
//! this machine: no OAuth, no personal access token, no keychain entry, so nothing about
//! Figma's sign-in is ever stored by GrapiX, and the remote server's client allowlist is
//! not involved.
//!
//! Three rules hold here and are tested:
//! 1. **Loopback only.** [`Link::connect`] refuses any address that is not loopback, before
//!    a socket is opened, so a frame is never fetched through (or leaked to) another host.
//! 2. **Every reply is kept as it came**, with its SHA-256, so a later re-import can be
//!    diffed against it and an offline re-run needs no network ([`Reply::raw`], [`Reply::hash`]).
//! 3. **Bounded.** A reply over [`MAX_REPLY`] bytes, a silent server and a malformed one each
//!    end in a named [`LinkError`], never a hang or an unbounded read.
#![forbid(unsafe_code)]

mod frame;
pub use frame::{Content, NodeRef};

use std::fmt;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Where the Figma desktop app serves MCP when its Dev Mode server is on.
pub const FIGMA_DESKTOP: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3845);
/// The largest reply read. A frame's design context is a few hundred KB; this is a bound, not a target.
pub const MAX_REPLY: usize = 64 * 1024 * 1024;
const PATH: &str = "/mcp";
const PROTOCOL: &str = "2025-03-26";
const CRLF: &[u8] = b"\r\n";
const END_OF_HEAD: &[u8] = b"\r\n\r\n";

#[derive(Debug, PartialEq, Eq)]
pub enum LinkError {
    /// The address is not loopback.
    NotLocal(SocketAddr),
    /// Nothing is listening: Figma is closed or its MCP server is off.
    Unreachable(String),
    /// The socket failed or timed out part-way.
    Transport(String),
    /// The reply was not HTTP, not JSON-RPC, or too large.
    Protocol(String),
    /// The server answered with a JSON-RPC error.
    Remote { code: i64, message: String },
    /// The server answered with a non-success HTTP status.
    Status(u16),
    /// A tool ran and reported failure (`isError`), with the text it gave.
    Tool(String),
}

impl fmt::Display for LinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotLocal(a) => write!(
                f,
                "{a} is not a loopback address; the Figma link is local only"
            ),
            Self::Unreachable(why) => write!(
                f,
                "Figma desktop is not answering ({why}): open Figma and turn on the MCP server in Dev Mode"
            ),
            Self::Transport(why) => write!(f, "the link to Figma failed: {why}"),
            Self::Protocol(why) => write!(f, "Figma sent something that is not MCP: {why}"),
            Self::Remote { code, message } => write!(f, "Figma refused ({code}): {message}"),
            Self::Status(code) => write!(f, "Figma answered HTTP {code}"),
            Self::Tool(text) => write!(f, "a Figma tool reported an error: {text}"),
        }
    }
}

impl std::error::Error for LinkError {}

/// One reply, kept exactly as received.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    /// The JSON-RPC message, as text (the body of a JSON reply, or the `data:` of an event stream).
    pub raw: String,
    /// Lower-case hex SHA-256 of `raw`.
    pub hash: String,
    /// The `result` member.
    pub result: Value,
}

/// One tool the server offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tool {
    pub name: String,
    pub description: String,
}

/// An open MCP session with the Figma desktop server.
#[derive(Debug)]
pub struct Link {
    addr: SocketAddr,
    session: Option<String>,
    server: String,
    next_id: u64,
    timeout: Duration,
}

impl Link {
    /// Open a session: `initialize`, then `notifications/initialized`. Loopback only.
    pub fn connect(addr: SocketAddr) -> Result<Self, LinkError> {
        Self::connect_with_timeout(addr, Duration::from_secs(30))
    }

    pub fn connect_with_timeout(addr: SocketAddr, timeout: Duration) -> Result<Self, LinkError> {
        if !addr.ip().is_loopback() {
            return Err(LinkError::NotLocal(addr));
        }
        let mut link = Self {
            addr,
            session: None,
            server: String::new(),
            next_id: 1,
            timeout,
        };
        let (reply, session) = link.exchange(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL,
                "capabilities": {},
                "clientInfo": { "name": "grapix", "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        link.session = session;
        link.server = reply.result["serverInfo"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        link.notify("notifications/initialized")?;
        Ok(link)
    }

    /// The server's own name, as it announced itself.
    pub fn server(&self) -> &str {
        &self.server
    }

    /// The tools the server offers.
    pub fn tools(&mut self) -> Result<Vec<Tool>, LinkError> {
        let (reply, _) = self.exchange("tools/list", json!({}))?;
        let list = reply.result["tools"]
            .as_array()
            .ok_or_else(|| LinkError::Protocol("tools/list has no tools array".into()))?;
        Ok(list
            .iter()
            .filter_map(|t| {
                Some(Tool {
                    name: t["name"].as_str()?.to_owned(),
                    description: t["description"].as_str().unwrap_or_default().to_owned(),
                })
            })
            .collect())
    }

    /// Call one tool. The whole reply is returned, raw and hashed.
    pub fn call(&mut self, name: &str, arguments: Value) -> Result<Reply, LinkError> {
        let (reply, _) = self.exchange(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )?;
        Ok(reply)
    }

    fn notify(&mut self, method: &str) -> Result<(), LinkError> {
        let body = json!({ "jsonrpc": "2.0", "method": method }).to_string();
        // A notification has no reply body (202); only the status matters.
        let (status, _, _) = self.post(&body)?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(LinkError::Status(status))
        }
    }

    fn exchange(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(Reply, Option<String>), LinkError> {
        let id = self.next_id;
        self.next_id += 1;
        let body =
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        let (status, session, text) = self.post(&body)?;
        if !(200..300).contains(&status) {
            return Err(LinkError::Status(status));
        }
        let raw = message_of(&text)?;
        let message: Value = serde_json::from_str(&raw)
            .map_err(|e| LinkError::Protocol(format!("not JSON: {e}")))?;
        if message["id"] != json!(id) {
            return Err(LinkError::Protocol(format!(
                "a reply to request {} came back for {id}",
                message["id"]
            )));
        }
        if let Some(error) = message.get("error") {
            return Err(LinkError::Remote {
                code: error["code"].as_i64().unwrap_or(0),
                message: error["message"].as_str().unwrap_or("no message").to_owned(),
            });
        }
        let hash = hex(&Sha256::digest(raw.as_bytes()));
        let result = message["result"].clone();
        Ok((Reply { raw, hash, result }, session))
    }

    /// POST once with `Connection: close`; returns the status, the session id and the body.
    fn post(&self, body: &str) -> Result<(u16, Option<String>, String), LinkError> {
        let mut stream = TcpStream::connect_timeout(&self.addr, self.timeout)
            .map_err(|e| LinkError::Unreachable(e.to_string()))?;
        let transport = |e: std::io::Error| LinkError::Transport(e.to_string());
        stream
            .set_read_timeout(Some(self.timeout))
            .map_err(transport)?;
        stream
            .set_write_timeout(Some(self.timeout))
            .map_err(transport)?;
        let mut request = format!(
            "POST {PATH} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
            self.addr,
            body.len()
        );
        if let Some(session) = &self.session {
            request.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
        }
        request.push_str("\r\n");
        request.push_str(body);
        stream.write_all(request.as_bytes()).map_err(transport)?;
        let mut raw = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        // Figma holds an event stream open after the answer, so the reply ends where one complete
        // message ends, not where the connection does.
        loop {
            let n = stream.read(&mut chunk).map_err(transport)?;
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..n]);
            if raw.len() > MAX_REPLY {
                return Err(LinkError::Protocol(format!(
                    "a reply over {MAX_REPLY} bytes"
                )));
            }
            if reply_is_complete(&raw) {
                break;
            }
        }
        parse_http(&raw)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_http(raw: &[u8]) -> Result<(u16, Option<String>, String), LinkError> {
    let split =
        find(raw, END_OF_HEAD).ok_or_else(|| LinkError::Protocol("no HTTP header block".into()))?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| LinkError::Protocol("no HTTP status line".into()))?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let header = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    };
    let payload = &raw[split + 4..];
    let chunked =
        header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        dechunk_partial(payload)?.0
    } else {
        payload.to_vec()
    };
    Ok((
        status,
        header("mcp-session-id"),
        String::from_utf8_lossy(&body).into_owned(),
    ))
}

/// Undo HTTP/1.1 chunked transfer coding of a complete body.
#[cfg(test)]
fn dechunk(data: &[u8]) -> Result<Vec<u8>, LinkError> {
    match dechunk_partial(data)? {
        (body, true) => Ok(body),
        _ => Err(LinkError::Protocol(
            "a chunked body that does not end".into(),
        )),
    }
}

/// Undo chunked coding of what has arrived: the bytes of the whole chunks so far, and whether
/// the final (zero) chunk was seen. A size that is not hex is an error; a chunk still arriving is not.
fn dechunk_partial(mut data: &[u8]) -> Result<(Vec<u8>, bool), LinkError> {
    let bad = || LinkError::Protocol("a malformed chunked body".into());
    let mut out = Vec::new();
    loop {
        let Some(line_end) = find(data, CRLF) else {
            return Ok((out, false));
        };
        let size_text = std::str::from_utf8(&data[..line_end]).map_err(|_| bad())?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| bad())?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Ok((out, true));
        }
        if data.len() < size + 2 {
            return Ok((out, false));
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

/// Has one whole reply arrived? By length when the server says how long, by the end of the
/// first message when it streams, and at once for a bodiless 202 or 204.
fn reply_is_complete(raw: &[u8]) -> bool {
    let Some(split) = find(raw, END_OF_HEAD) else {
        return false;
    };
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok());
    let payload = &raw[split + 4..];
    if let Some(length) = head
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse::<usize>().ok())
    {
        return payload.len() >= length;
    }
    if matches!(status, Some(202 | 204)) {
        return true;
    }
    if head.contains("transfer-encoding: chunked") {
        let Ok((body, finished)) = dechunk_partial(payload) else {
            return true; // malformed: stop reading; parse_http names it
        };
        return finished || message_ended(&String::from_utf8_lossy(&body));
    }
    message_ended(&String::from_utf8_lossy(payload))
}

/// Is there a whole message in this text: a JSON object that parses, or an event whose blank line has arrived?
fn message_ended(text: &str) -> bool {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') {
        return serde_json::from_str::<Value>(trimmed.trim_end()).is_ok();
    }
    text.contains("data:") && text.contains("\n\n")
}

/// The JSON-RPC message in a body: the body itself when it is JSON, else the `data:` lines of
/// the first event of an event stream.
fn message_of(body: &str) -> Result<String, LinkError> {
    let trimmed = body.trim_start();
    if trimmed.starts_with('{') {
        return Ok(trimmed.trim_end().to_owned());
    }
    let mut data = Vec::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.strip_prefix(' ').unwrap_or(rest));
        } else if line.is_empty() && !data.is_empty() {
            break;
        }
    }
    if data.is_empty() {
        return Err(LinkError::Protocol(
            "no JSON-RPC message in the reply".into(),
        ));
    }
    Ok(data.join("\n"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_bodies_are_put_back_together() {
        assert_eq!(
            dechunk(b"5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n").unwrap(),
            b"hello world"
        );
        assert!(dechunk(b"5\r\nhel").is_err(), "a short chunk");
        assert!(
            dechunk(b"zz\r\nhello\r\n0\r\n\r\n").is_err(),
            "a size that is not hex"
        );
        assert!(dechunk(b"5\r\nhello\r\n").is_err(), "no end marker");
    }

    #[test]
    fn a_reply_ends_where_one_message_ends() {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n";
        let event = "event: message\ndata: {\"a\":1}\n\n";
        // A stream with no length, still open: the blank line after the event ends the reply.
        assert!(reply_is_complete(format!("{head}\r\n{event}").as_bytes()));
        assert!(
            !reply_is_complete(format!("{head}\r\nevent: message\ndata: {{\"a\":").as_bytes()),
            "half an event"
        );
        assert!(
            !reply_is_complete(format!("{head}\r\n").as_bytes()),
            "no body yet"
        );
        assert!(
            !reply_is_complete(b"HTTP/1.1 200 OK\r\nContent-Ty"),
            "half a head"
        );
        // By length.
        assert!(reply_is_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
        ));
        assert!(!reply_is_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{}"
        ));
        // A bodiless acceptance.
        assert!(reply_is_complete(b"HTTP/1.1 202 Accepted\r\n\r\n"));
        // Chunked and still open: the event inside the chunk is enough.
        let whole = format!(
            "{head}Transfer-Encoding: chunked\r\n\r\n{:x}\r\n{event}\r\n",
            event.len()
        );
        assert!(reply_is_complete(whole.as_bytes()));
        let half = format!(
            "{head}Transfer-Encoding: chunked\r\n\r\n{:x}\r\n{}",
            event.len(),
            &event[..10]
        );
        assert!(
            !reply_is_complete(half.as_bytes()),
            "a chunk still arriving"
        );
        // A plain JSON body with no length ends when it parses.
        assert!(reply_is_complete(b"HTTP/1.1 200 OK\r\n\r\n{\"a\":1}"));
        assert!(!reply_is_complete(b"HTTP/1.1 200 OK\r\n\r\n{\"a\":"));
    }

    #[test]
    fn a_message_is_found_in_json_or_in_the_first_event() {
        assert_eq!(message_of("  {\"a\":1}\n").unwrap(), "{\"a\":1}");
        assert_eq!(
            message_of("event: message\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\n").unwrap(),
            "{\"a\":1}"
        );
        assert_eq!(
            message_of("data: {\"a\":\ndata: 1}\n\n").unwrap(),
            "{\"a\":\n1}",
            "a message split over data lines"
        );
        assert!(message_of("<html>").is_err());
        assert!(message_of("").is_err());
    }

    #[test]
    fn http_head_is_read() {
        let (status, session, body) =
            parse_http(b"HTTP/1.1 200 OK\r\nMcp-Session-Id: abc\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
        assert_eq!(
            (status, session.as_deref(), body.as_str()),
            (200, Some("abc"), "{}")
        );
        assert!(parse_http(b"garbage").is_err());
        assert!(parse_http(b"HTTP/1.1 xyz\r\n\r\n").is_err());
    }

    #[test]
    fn a_non_local_address_is_refused_before_any_socket() {
        for addr in [
            "10.0.0.5:3845",
            "192.168.1.9:3845",
            "8.8.8.8:3845",
            "[2001:db8::1]:3845",
        ] {
            let addr: SocketAddr = addr.parse().unwrap();
            assert_eq!(Link::connect(addr).unwrap_err(), LinkError::NotLocal(addr));
        }
    }

    #[test]
    fn hashes_are_sha256_hex() {
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
