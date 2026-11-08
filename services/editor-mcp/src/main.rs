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
    let projects = gx_editor::Projects::at_root(root.ok_or(USAGE)?);
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
