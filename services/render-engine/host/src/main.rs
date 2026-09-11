//! gx-engine-host
//!
//! Ensures a render worker is running and reports what it found. Adopts an
//! engine that is already up; spawns one only when nothing is listening. It
//! does not stop the engine — Program outlives the host (ADR B.4), so this
//! process exits and leaves the worker serving.

use gx_control_plane::bind::ENGINE_CONTROL_PORT;
use gx_engine_host::{ensure, Provenance};

fn main() {
    let mut args = std::env::args().skip(1);
    let mut port = ENGINE_CONTROL_PORT;
    // Default to the worker built beside this binary in target/debug.
    let mut worker = default_worker_path();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => match args.next().and_then(|p| p.parse::<u16>().ok()) {
                Some(p) => port = p,
                None => usage("--port needs a number"),
            },
            "--worker" => match args.next() {
                Some(w) => worker = w,
                None => usage("--worker needs a path"),
            },
            "--help" | "-h" => usage(""),
            other => usage(&format!("unknown argument {other}")),
        }
    }

    let spawn_args: Vec<String> = Vec::new();
    let mut supervised = match ensure(&worker, port, &spawn_args) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("could not ensure an engine on port {port}: {e}");
            std::process::exit(1);
        }
    };

    match supervised.provenance() {
        Provenance::Adopted => println!("adopted the engine already running on {port}"),
        Provenance::Spawned => println!("started a render worker on {port}"),
    }

    match supervised.status() {
        Some(status) => println!(
            "  tier {:?} clock {:?} reference {:?} frame {} live {}",
            status.device_tier,
            status.clock,
            status.reference,
            status.current_frame,
            status.live_allowed
        ),
        None => {
            eprintln!("  the engine is up but did not answer status");
            std::process::exit(1);
        }
    }

    println!("leaving the engine running; the host does not stop it");
}

fn default_worker_path() -> String {
    let exe = std::env::current_exe().ok();
    let debug = exe
        .as_ref()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let name = if cfg!(windows) {
        "gx-render-worker.exe"
    } else {
        "gx-render-worker"
    };
    match debug {
        Some(dir) => dir.join(name).to_string_lossy().into_owned(),
        None => name.to_string(),
    }
}

fn usage(problem: &str) -> ! {
    if !problem.is_empty() {
        eprintln!("error: {problem}");
    }
    eprintln!("gx-engine-host [--port N] [--worker PATH]");
    std::process::exit(if problem.is_empty() { 0 } else { 2 });
}
