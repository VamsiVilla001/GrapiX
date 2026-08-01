use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    stage_render_engine_sidecar();
    tauri_build::build()
}

/// Copy the render engine next to the bundle, so a packaged Editor can ensure one is running.
///
/// The engine, not the retired protocol v2 daemon: no packaged application launches or
/// connects to protocol v2 (`docs/architecture.md`, V1 acceptance gates). A missing binary is
/// a warning and not an error — a developer running `tauri dev` against an engine they started
/// by hand does not need a staged copy.
fn stage_render_engine_sidecar() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    // Four levels: src-tauri -> desktop-tauri -> apps -> Editor -> repository root.
    let Some(root) = manifest
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
    else {
        println!("cargo:warning=unable to resolve the GrapiX workspace root for the engine sidecar");
        return;
    };

    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let target = env::var("TARGET").unwrap_or_else(|_| "unknown-target".to_string());
    let extension = if target.contains("windows") { ".exe" } else { "" };

    let source = root
        .join("services")
        .join("render-engine")
        .join("target")
        .join(&profile)
        .join(format!("grapix-render-engine{extension}"));

    // Restage whenever the engine is rebuilt.
    //
    // Without this cargo caches the build script and never re-runs it, so the staged sidecar
    // keeps whatever engine existed the last time something else in this crate changed. That
    // silently shipped a 20-hour-old engine: the app launched it, the app looked fine, and a
    // fix made in the engine was simply absent. Declared before the existence check so a
    // missing engine still arms the trigger for when it appears.
    println!("cargo:rerun-if-changed={}", source.display());

    if !source.is_file() {
        println!(
            "cargo:warning=render engine sidecar not found at {}; build it before packaging",
            source.display()
        );
        return;
    }

    let binaries = manifest.join("binaries");
    if let Err(error) = fs::create_dir_all(&binaries) {
        println!("cargo:warning=failed to create the sidecar directory: {error}");
        return;
    }
    let destination: PathBuf = binaries.join(format!("grapix-render-engine-{target}{extension}"));
    if let Err(error) = fs::copy(&source, &destination) {
        println!(
            "cargo:warning=failed to stage the engine sidecar {}: {error}",
            destination.display()
        );
    }
}
