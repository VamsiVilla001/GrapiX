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

/// A running engine that is killed when it goes out of scope, so a failed
/// assertion never leaves one running (it would also hold a test harness's output
/// pipe open for as long as it lives).
struct Engine(std::process::Child);

impl Engine {
    fn id(&self) -> u32 {
        self.0.id()
    }

    /// Kill it outright: none of its own code runs, as when it is ended by force.
    fn kill(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.kill();
    }
}

fn start_worker(dir: &Path, logs: &Path) -> Engine {
    Engine(
        Command::new(env!("CARGO_BIN_EXE_gx-render-worker"))
            .args(["--port", "0", "--asset-port", "0", "--recovery-journal"])
            .arg(dir.join("journal.json"))
            .env("GX_LOG_DIR", logs)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the worker starts"),
    )
}

/// Poll the engine's log folder until `done` holds of what is in it.
fn wait_until(logs: &Path, done: impl Fn(&[serde_json::Value]) -> bool) -> Vec<serde_json::Value> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let found = records(&logs.join("engine"));
        if done(&found) || Instant::now() > deadline {
            return found;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 2.16: an engine that was killed leaves no `engine.stop`; the next engine that
/// starts says so, naming the file, its last sequence number and its last
/// timestamp, and an engine that is still running is never called killed.
#[test]
fn a_killed_engine_is_named_by_the_next_start_and_a_running_one_is_not() {
    let dir = scratch();
    let logs = dir.join("logs");
    let mut first = start_worker(&dir, &logs);
    let first_pid = u64::from(first.id());
    let found = wait_until(&logs, |found| {
        found
            .iter()
            .any(|r| r["event"] == "engine.heartbeat" && r["pid"] == first_pid)
    });
    assert!(
        found
            .iter()
            .all(|r| r["event"] != "log.previous_unfinished"),
        "the first engine has no predecessor"
    );

    // A second engine starts while the first is running: it is not named.
    let mut beside = start_worker(&dir, &logs);
    let beside_pid = u64::from(beside.id());
    let found = wait_until(&logs, |found| {
        found
            .iter()
            .any(|r| r["event"] == "engine.start" && r["pid"] == beside_pid)
    });
    assert!(
        found
            .iter()
            .all(|r| r["event"] != "log.previous_unfinished"),
        "an engine that is still running is not a killed predecessor: {found:#?}"
    );
    let listed = found
        .iter()
        .find(|r| r["event"] == "log.start" && r["pid"] == beside_pid)
        .map(|r| r["fields"]["running"].clone());
    assert!(
        listed
            .as_ref()
            .and_then(|running| running.as_array())
            .is_some_and(|running| running.len() == 1
                && running[0]
                    .as_str()
                    .is_some_and(|name| name.ends_with(&format!("-{first_pid}")))),
        "the second engine lists the first as running: {listed:?}"
    );

    // Both are killed (no code of theirs runs). The third engine is the first
    // start after either death, so it names both, once each.
    beside.kill();
    first.kill();
    let mut third = start_worker(&dir, &logs);
    let third_pid = u64::from(third.id());
    let found = wait_until(&logs, |found| {
        found
            .iter()
            .any(|r| r["event"] == "engine.start" && r["pid"] == third_pid)
    });
    third.kill();
    let named: Vec<&serde_json::Value> = found
        .iter()
        .filter(|r| r["event"] == "log.previous_unfinished" && r["pid"] == third_pid)
        .collect();
    let mut pids: Vec<u64> = named
        .iter()
        .filter_map(|r| r["fields"]["predecessor_pid"].as_u64())
        .collect();
    pids.sort_unstable();
    let mut expected = vec![first_pid, beside_pid];
    expected.sort_unstable();
    assert_eq!(pids, expected, "both killed engines, once each: {named:#?}");
    for record in &named {
        assert_eq!(record["level"], "warn");
        let fields = &record["fields"];
        assert!(
            fields["file"]
                .as_str()
                .is_some_and(|f| f.starts_with("worker-") && f.ends_with("-1.jsonl")),
            "{record}"
        );
        assert!(
            fields["last_seq"].as_u64().is_some_and(|s| s >= 2),
            "{record}"
        );
        assert!(fields["last_ts"].as_str().is_some(), "{record}");
    }
    // The record a killed engine did not write is not invented for it.
    assert!(
        found
            .iter()
            .all(|r| !(r["event"] == "engine.stop"
                && (r["pid"] == beside_pid || r["pid"] == first_pid))),
        "a killed engine writes no stop record"
    );
    let _ = std::fs::remove_dir_all(dir);
}
