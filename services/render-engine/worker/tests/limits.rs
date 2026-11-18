//! 2.22: the shipped `gx-render-worker` holds every connection to the transport
//! bounds, with the defaults it ships with (nothing shortened for the test).
//!
//! A peer that connects to the control plane or the asset plane and sends nothing
//! is dropped at the first-frame deadline (10 s); the control plane holds at most
//! 32 connections and closes the 33rd at once.

use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn scratch() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gx-worker-limits-{}-{nanos}", std::process::id()));
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

/// A running engine that is killed when it goes out of scope.
struct Engine(Child);

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start an engine on loopback with no token and return where it listens.
fn start(dir: &Path) -> (Engine, SocketAddr, SocketAddr) {
    let engine = Engine(
        Command::new(env!("CARGO_BIN_EXE_gx-render-worker"))
            .args(["--port", "0", "--asset-port", "0"])
            .arg("--recovery-journal")
            .arg(dir.join("journal.json"))
            .env("GX_LOG_DIR", dir.join("logs"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the worker starts"),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let found = records(&dir.join("logs").join("engine"));
        if let Some(started) = found.iter().find(|r| r["event"] == "engine.start") {
            let address = |field: &str| -> SocketAddr {
                started["fields"][field]
                    .as_str()
                    .and_then(|a| a.parse().ok())
                    .unwrap_or_else(|| panic!("{field} in {started}"))
            };
            return (engine, address("control"), address("assets"));
        }
        assert!(Instant::now() < deadline, "no engine.start: {found:#?}");
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// How long until the engine closes `stream`, or `None` if it is still open after
/// `limit`. Anything it sends meanwhile is read and thrown away.
fn closed_after(stream: &mut TcpStream, limit: Duration) -> Option<Duration> {
    let started = Instant::now();
    let mut sink = [0u8; 256];
    while started.elapsed() < limit {
        let left = limit
            .saturating_sub(started.elapsed())
            .max(Duration::from_millis(1));
        stream.set_read_timeout(Some(left)).expect("a read timeout");
        match stream.read(&mut sink) {
            Ok(0) => return Some(started.elapsed()),
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return None
            }
            Err(_) => return Some(started.elapsed()),
        }
    }
    None
}

#[test]
fn a_peer_that_sends_nothing_is_dropped_by_both_planes_at_the_first_frame_deadline() {
    let dir = scratch();
    let (_engine, control, assets) = start(&dir);
    let mut on_control = TcpStream::connect(control).expect("the control plane accepts");
    let mut on_assets = TcpStream::connect(assets).expect("the asset plane accepts");
    for (plane, stream) in [("control", &mut on_control), ("asset", &mut on_assets)] {
        let took = closed_after(stream, Duration::from_secs(20))
            .unwrap_or_else(|| panic!("{plane}: a silent peer was still held after 20 s"));
        eprintln!("{plane} plane dropped a silent peer after {took:?}");
        // Both were accepted at the same moment, so the second is already gone
        // when the first closes: its own time is only known to be at or after the deadline.
        assert!(
            took < Duration::from_secs(14),
            "{plane}: dropped after {took:?}; the deadline is 10 s"
        );
    }
    // The control plane's own record says why, naming the time.
    let found = records(&dir.join("logs").join("engine"));
    assert!(
        found.iter().any(|r| r["event"] == "control.disconnected"
            && r["fields"]["reason"]
                .as_str()
                .is_some_and(|why| why.contains("no request arrived within"))),
        "the dropped peer is on record: {found:#?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_control_plane_holds_thirty_two_connections_and_closes_the_next_at_once() {
    let dir = scratch();
    let (_engine, control, _) = start(&dir);
    let held: Vec<TcpStream> = (0..32)
        .map(|_| TcpStream::connect(control).expect("a connection inside the cap"))
        .collect();
    // Let the engine take all 32 places before the next arrives.
    std::thread::sleep(Duration::from_millis(500));
    let mut one_more = TcpStream::connect(control).expect("the socket opens");
    let took = closed_after(&mut one_more, Duration::from_secs(5))
        .expect("the 33rd connection was held, not closed");
    eprintln!("the 33rd connection was closed after {took:?}");
    assert!(
        took < Duration::from_secs(2),
        "closed after {took:?}, not at once"
    );
    let found = records(&dir.join("logs").join("engine"));
    assert!(
        found
            .iter()
            .any(|r| r["event"] == "control.connection_refused" && r["fields"]["cap"] == 32),
        "the refusal is on record, naming the cap"
    );
    drop(held);
    let _ = std::fs::remove_dir_all(dir);
}
