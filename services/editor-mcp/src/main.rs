//! Local author MCP process. The parent grants access by launching this
//! process with an explicit project-store root; no operator scope is granted.
//!
//! `--root <folder>` serves MCP on stdio. Adding `--http <port>` serves
//! stateless streamable HTTP on `127.0.0.1:<port>` instead (0 picks a free
//! port); the bound URL is printed on stderr before the first request is
//! accepted. There is no flag for any other interface. HTTP is a port any local
//! process can reach, so it needs `--token <secret>` (the secret the control plane
//! is started with) and refuses every request that does not carry a gx1 credential
//! made with it, granting the scopes that credential holds (2.23).
#![forbid(unsafe_code)]

const USAGE: &str =
    "usage: gx-editor-mcp --root <project-store-folder> [--http <port> --token <secret>]";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let mut root = None;
    let mut http: Option<u16> = None;
    let mut secret: Option<String> = None;
    while let Some(flag) = args.next() {
        match (flag.to_str(), args.next()) {
            (Some("--root"), Some(folder)) if root.is_none() => {
                root = Some(std::path::PathBuf::from(folder))
            }
            (Some("--http"), Some(port)) if http.is_none() => {
                http = Some(
                    port.to_str()
                        .and_then(|port| port.parse().ok())
                        .ok_or(USAGE)?,
                );
            }
            (Some("--token"), Some(value)) if secret.is_none() => {
                secret = Some(value.to_str().ok_or(USAGE)?.to_owned());
            }
            _ => return Err(USAGE.into()),
        }
    }
    let root = root.ok_or(USAGE)?;
    // 2.23: HTTP is never served without a secret to verify credentials against, and a secret is
    // not accepted where nothing would use it (stdio is a process the parent started).
    let auth = match (http, secret) {
        (Some(_), Some(secret)) => Some(gx_mcp_server::HttpAuth::new(secret)?),
        (Some(_), None) => {
            return Err(
                "--http needs --token <secret>: HTTP is not served without credentials".into(),
            )
        }
        (None, Some(_)) => {
            return Err("--token is for --http; stdio is the parent's own process".into())
        }
        (None, None) => None,
    };
    // 2.12: this server's log, to a file: stdout carries the MCP protocol.
    let mut log = gx_telemetry::sink::init_process_logging("mcp", "editor-mcp");
    tracing::info!(
        event = "mcp.start",
        version = env!("CARGO_PKG_VERSION"),
        root = %root.display(),
        transport = if http.is_some() { "http" } else { "stdio" },
        http_port = http,
    );
    let projects = gx_editor::Projects::at_root(root);
    let server = gx_editor_mcp::server(projects);
    let served = match (http, auth) {
        (Some(port), Some(auth)) => server.serve_http(port, auth, |addr| {
            eprintln!(
                "gx-editor-mcp listening on http://{addr}{}",
                gx_mcp_server::HTTP_PATH
            );
        }),
        _ => server.serve_stdio(),
    };
    // 2.12: the server's last record, then its log written out. A stdio
    // server ends when its client closes the connection.
    match &served {
        Ok(()) => tracing::info!(
            event = "mcp.stop",
            reason = if http.is_some() {
                "the listener ended"
            } else {
                "the client closed the connection"
            },
        ),
        Err(error) => tracing::error!(
            event = "mcp.stop",
            reason = "the transport failed",
            detail = %error,
        ),
    }
    if let Some(guard) = log.take() {
        let _ = guard.finish();
    }
    served?;
    Ok(())
}
