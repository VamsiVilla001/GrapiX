//! A raw HTTP/1.1 client for the MCP HTTP transport, so the tests need no
//! HTTP client crate. Shared with `gx-editor-mcp`'s tests by `#[path]`.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// The path the MCP endpoint is served on.
pub const MCP_PATH: &str = "/mcp";

const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct HttpReply {
    pub status: u16,
    /// Lower-cased names.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl HttpReply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("a JSON body: {self:?}"))
    }
}

/// POST one JSON-RPC message to `/mcp` with `Connection: close`. `host` is
/// sent as the `Host` header, so a test can present a foreign one.
pub fn post(
    addr: SocketAddr,
    host: &str,
    headers: &[(&str, &str)],
    body: &serde_json::Value,
) -> HttpReply {
    let body = body.to_string();
    let mut stream = TcpStream::connect(addr).expect("the HTTP server accepts");
    stream.set_read_timeout(Some(REPLY_TIMEOUT)).unwrap();
    let mut request = format!(
        "POST {MCP_PATH} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(&body);
    stream
        .write_all(request.as_bytes())
        .expect("the request is sent");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("the response is read");
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("an HTTP response has a header block");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut payload = raw[split + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    if headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value.contains("chunked"))
    {
        payload = dechunk(&payload);
    }
    HttpReply {
        status,
        headers,
        body: String::from_utf8(payload).expect("a UTF-8 body"),
    }
}

/// `post` to the server's own address with a matching `Host`.
pub fn post_local(
    addr: SocketAddr,
    headers: &[(&str, &str)],
    body: &serde_json::Value,
) -> HttpReply {
    post(addr, &format!("127.0.0.1:{}", addr.port()), headers, body)
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let line_end = data
            .windows(2)
            .position(|window| window == b"\r\n")
            .expect("a chunk size line");
        let size_text = String::from_utf8_lossy(&data[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap().trim(), 16)
            .expect("a hex chunk size");
        data = &data[line_end + 2..];
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}
