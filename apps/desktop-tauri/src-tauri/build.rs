use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    stage_render_daemon_sidecar();
    tauri_build::build()
}

fn stage_render_daemon_sidecar() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(root) = manifest
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    else {
        println!("cargo:warning=unable to resolve GrapiX workspace root for render sidecar");
        return;
    };
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let target = env::var("TARGET").unwrap_or_else(|_| "unknown-target".to_string());
    let executable_name = if target.contains("windows") {
        "grapix-render-daemon.exe"
    } else {
        "grapix-render-daemon"
    };
    let source = root
        .join("services")
        .join("render-daemon")
        .join("target")
        .join(&profile)
        .join(executable_name);
    if !source.is_file() {
        println!(
            "cargo:warning=render daemon sidecar not found at {}; build it before Tauri",
            source.display()
        );
        return;
    }

    let binaries = manifest.join("binaries");
    if let Err(error) = fs::create_dir_all(&binaries) {
        println!("cargo:warning=failed to create sidecar directory: {error}");
        return;
    }
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let destination: PathBuf = binaries.join(format!("grapix-render-daemon-{target}{extension}"));
    if let Err(error) = fs::copy(&source, &destination) {
        println!(
            "cargo:warning=failed to stage render daemon sidecar {}: {error}",
            destination.display()
        );
    }
}
