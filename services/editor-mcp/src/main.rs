//! Local author MCP process. The parent grants access by launching this
//! process with an explicit project-store root; no operator scope is granted.
#![forbid(unsafe_code)]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let flag = args.next();
    let root = args.next();
    if flag.as_deref() != Some(std::ffi::OsStr::new("--root")) || root.is_none() || args.next().is_some() {
        return Err("usage: gx-editor-mcp --root <project-store-folder>".into());
    }
    let projects = gx_editor::Projects::at_root(std::path::PathBuf::from(root.unwrap()));
    gx_editor_mcp::server(projects).serve(std::io::stdin().lock(), std::io::stdout().lock())?;
    Ok(())
}
