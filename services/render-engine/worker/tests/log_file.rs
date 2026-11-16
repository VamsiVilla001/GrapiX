//! 2.12: the shipped `gx-render-worker` binary writes its JSON Lines log.
//!
//! The process is started as an operator starts it, with `GX_LOG_DIR` naming a
//! scratch log root; within a few seconds its file holds `log.start`,
//! `engine.start` (tier, adapter, rate, the bound addresses) and the engine's
//! once-a-second heartbeat from the live frame path.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn scratch() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gx-worker-log-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn records(directory: &Path) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<serde_json::Value>>()
        })
        .collect()
}

#[test]
fn the_shipped_worker_writes_its_start_and_heartbeat_to_its_log() {
    let dir = scratch();
    let logs = dir.join("logs");
    let mut child = Command::new(env!("CARGO_BIN_EXE_gx-render-worker"))
        .args(["--port", "0", "--asset-port", "0", "--recovery-journal"])
        .arg(dir.join("journal.json"))
        .env("GX_LOG_DIR", &logs)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the worker starts");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut found = Vec::new();
    while Instant::now() < deadline {
        found = records(&logs.join("engine"));
        if found.iter().any(|r| r["event"] == "engine.heartbeat") {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    let start = found
        .iter()
        .find(|r| r["event"] == "engine.start")
        .unwrap_or_else(|| panic!("no engine.start in {found:#?}"));
    assert_eq!(start["process"], "worker");
    assert!(start["epoch"].as_u64().is_some(), "which run: {start}");
    assert!(start["fields"]["clock"].as_str().is_some(), "{start}");
    assert!(start["fields"]["tier"].as_str().is_some(), "{start}");
    assert!(start["fields"]["rate"].as_str().is_some(), "{start}");
    assert!(
        start["fields"]["control"]
            .as_str()
            .is_some_and(|a| a.contains("127.0.0.1")),
        "{start}"
    );
    assert!(
        found.iter().any(|r| r["event"] == "log.start"),
        "the file says what it is first"
    );
    let beat = found
        .iter()
        .find(|r| r["event"] == "engine.heartbeat")
        .unwrap_or_else(|| panic!("no heartbeat within 30 s in {found:#?}"));
    assert!(beat["frame"].as_u64().is_some(), "{beat}");
    assert!(beat["fields"]["rendered"].as_u64().is_some(), "{beat}");
    let _ = std::fs::remove_dir_all(dir);
}
