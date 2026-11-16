//! Local author MCP process. The parent grants access by launching this
//! process with an explicit project-store root; no operator scope is granted.
//!
//! `--root <folder>` serves MCP on stdio. Adding `--http <port>` serves
//! stateless streamable HTTP on `127.0.0.1:<port>` instead (0 picks a free
//! port); the bound URL is printed on stderr before the first request is
//! accepted. There is no flag for any other interface.
#![forbid(unsafe_code)]

const USAGE: &str = "usage: gx-editor-mcp --root <project-store-folder> [--http <port>]";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let mut root = None;
    let mut http: Option<u16> = None;
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
            _ => return Err(USAGE.into()),
        }
    }
    let root = root.ok_or(USAGE)?;
    // 2.12: this server's log, to a file: stdout carries the MCP protocol.
    let _log = gx_telemetry::sink::init_process_logging("mcp", "editor-mcp");
    tracing::info!(
        event = "mcp.start",
        version = env!("CARGO_PKG_VERSION"),
        root = %root.display(),
        transport = if http.is_some() { "http" } else { "stdio" },
        http_port = http,
    );
    let projects = gx_editor::Projects::at_root(root);
    let server = gx_editor_mcp::server(projects);
    match http {
        Some(port) => server.serve_http(port, |addr| {
            eprintln!(
                "gx-editor-mcp listening on http://{addr}{}",
                gx_mcp_server::HTTP_PATH
            );
        })?,
        None => server.serve_stdio()?,
    }
    Ok(())
}
