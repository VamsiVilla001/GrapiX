//! 2.12: the shipped `gx-engine-host` writes its JSON Lines log, both when it
//! adopts a running engine and when it cannot ensure one.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn scratch(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "gx-host-log-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn records(directory: &Path) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("host-"))
        })
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<serde_json::Value>>()
        })
        .collect()
}

/// The render worker built beside this host binary.
fn worker() -> PathBuf {
    let host = PathBuf::from(env!("CARGO_BIN_EXE_gx-engine-host"));
    host.with_file_name(format!("gx-render-worker{}", std::env::consts::EXE_SUFFIX))
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn the_host_records_the_engine_it_adopted() {
    let worker = worker();
    if !worker.exists() {
        // The worker is another crate's binary; `cargo test -p gx-engine-host`
        // alone may not have built it. Say so rather than pass silently.
        panic!(
            "build the render worker first (cargo build -p gx-render-worker): {} is missing",
            worker.display()
        );
    }
    let dir = scratch("adopt");
    let port = free_port();
    let mut engine = Command::new(&worker)
        .args([
            "--port",
            &port.to_string(),
            "--asset-port",
            "0",
            "--recovery-journal",
        ])
        .arg(dir.join("journal.json"))
        .env("GX_LOG_DIR", dir.join("engine-logs"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the worker starts");
    // Wait for the worker to listen before the host looks for it.
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline && std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        std::thread::sleep(Duration::from_millis(100));
    }
    let status = Command::new(env!("CARGO_BIN_EXE_gx-engine-host"))
        .args(["--port", &port.to_string(), "--worker"])
        .arg(&worker)
        .env("GX_LOG_DIR", dir.join("logs"))
        .env("GX_EDITOR_PACKAGE_DIR", dir.join("packages"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("the host runs");
    let _ = engine.kill();
    let _ = engine.wait();
    assert!(status.success(), "the host adopts a running engine");
    let found = records(&dir.join("logs").join("engine"));
    let start = found
        .iter()
        .find(|r| r["event"] == "host.start")
        .unwrap_or_else(|| panic!("no host.start in {found:#?}"));
    assert_eq!(start["fields"]["port"], port);
    let ready = found
        .iter()
        .find(|r| r["event"] == "host.engine_ready")
        .unwrap_or_else(|| panic!("no host.engine_ready in {found:#?}"));
    assert_eq!(ready["fields"]["provenance"], "adopted");
    assert!(ready["epoch"].as_u64().is_some(), "{ready}");
    assert!(ready["fields"]["tier"].as_str().is_some(), "{ready}");
    assert!(found.iter().any(|r| r["event"] == "host.exit"));
    assert_eq!(
        found.last().unwrap()["event"],
        "log.stop",
        "the log was finished"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_host_records_why_it_could_not_ensure_an_engine() {
    let dir = scratch("fail");
    let port = free_port();
    let status = Command::new(env!("CARGO_BIN_EXE_gx-engine-host"))
        .args(["--port", &port.to_string(), "--worker"])
        .arg(dir.join("no-such-worker.exe"))
        .env("GX_LOG_DIR", dir.join("logs"))
        .env("GX_EDITOR_PACKAGE_DIR", dir.join("packages"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("the host runs");
    assert!(!status.success(), "nothing to adopt and nothing to start");
    let found = records(&dir.join("logs").join("engine"));
    let failed = found
        .iter()
        .find(|r| r["event"] == "host.failed")
        .unwrap_or_else(|| panic!("no host.failed in {found:#?}"));
    assert_eq!(failed["level"], "error");
    assert!(
        failed["fields"]["detail"]
            .as_str()
            .is_some_and(|d| d.contains(&port.to_string())),
        "{failed}"
    );
    assert_eq!(
        found.last().unwrap()["event"],
        "log.stop",
        "written out before the exit"
    );
    let _ = std::fs::remove_dir_all(dir);
}
