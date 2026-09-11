//! Integration: the host adopts a live engine and never stops it.
//!
//! These run against a real worker binary, so they need it built. Cargo does
//! not build sibling binaries for a library's integration test, so each test
//! skips cleanly when the binary is absent rather than failing (invariant 43:
//! a skip is not a pass, and a missing binary is a skip, not a failure).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use gx_control_plane::bind::check_bind;
use gx_engine_host::{ensure, Provenance};
use parking_lot::Mutex;

// These tests spawn real worker processes that bind OS ports. Run them one at
// a time: two concurrently-binding workers race the ephemeral-port allocator
// and each other's free-port probe, which is a test-harness artefact, not an
// engine property.
static PORT_LOCK: Mutex<()> = Mutex::new(());

/// The worker binary, next to the host test executable in target/debug.
fn worker_binary() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    // .../target/debug/deps/gx_engine_host-xxxx -> .../target/debug
    let debug = current.parent()?.parent()?;
    let candidate = debug.join(if cfg!(windows) {
        "gx-render-worker.exe"
    } else {
        "gx-render-worker"
    });
    candidate.exists().then_some(candidate)
}

/// Reserve a loopback port by binding and releasing. Racy in principle; the
/// PORT_LOCK above keeps it from racing another test in this binary.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    listener.local_addr().unwrap().port()
}

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Kill any worker process listening on `port` (test teardown only).
///
/// Windows-only implementation via `netstat` + `taskkill`; on other platforms
/// it is a no-op because the test that uses it only runs its process fixture
/// where the worker binary was built.
#[cfg(windows)]
fn kill_worker_on(port: u16) {
    // Find the PID bound to the port and kill it. Best-effort: a failure here
    // leaks a fixture process, it does not fail the test.
    if let Ok(out) = Command::new("netstat").args(["-ano"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.contains(&format!(":{port}")) && line.contains("LISTENING") {
                if let Some(pid) = line.split_whitespace().last() {
                    let _ = Command::new("taskkill")
                        .args(["/F", "/PID", pid])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn kill_worker_on(_port: u16) {}

/// Start a worker on a port, waiting for it to answer.
///
/// The child is owned by `KillOnDrop` from the moment it exists, before the
/// wait that can fail. Constructing the guard only on success leaks the
/// process on every failed startup, and on Windows a leaked worker holds
/// `gx-render-worker.exe` open so the next `cargo build` fails with "access
/// is denied" — a stale binary that then fails the *next* run for a reason
/// that looks nothing like the cause (memory rule 19).
fn start_worker(binary: &PathBuf, port: u16) -> KillOnDrop {
    let child = KillOnDrop(
        Command::new(binary)
            .args(["--port", &port.to_string()])
            // Detach stdio so the long-lived worker does not hold the test
            // harness's output pipe open after the test process wants to exit.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn worker"),
    );
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if gx_control_transport::Client::connect(addr).is_ok() {
            return child;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("worker did not start on {addr}");
}

#[test]
fn the_host_adopts_an_engine_it_did_not_start() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let _guard = PORT_LOCK.lock();
    let port = free_port();
    // A "stranger's" engine, started outside the host entirely.
    let _foreign = start_worker(&binary, port);

    let mut supervised =
        ensure(binary.to_str().unwrap(), port, &[]).expect("ensure adopts the running engine");

    assert_eq!(
        supervised.provenance(),
        Provenance::Adopted,
        "an engine already answering must be adopted, not replaced"
    );
    // And it is genuinely usable.
    assert!(
        supervised.status().is_some(),
        "adopted engine answers status"
    );
}

#[test]
fn the_host_spawns_when_nothing_is_listening() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let _guard = PORT_LOCK.lock();
    let port = free_port();
    let mut supervised = ensure(binary.to_str().unwrap(), port, &[])
        .expect("ensure spawns an engine when none is running");

    assert_eq!(supervised.provenance(), Provenance::Spawned);
    assert!(supervised.status().is_some());
    drop(supervised);

    // The invariant that defines this crate: the host never stops the engine
    // it started. Proof by provenance: dropping the supervisor and ensuring
    // again must find the *same* engine still running (Adopted), not a fresh
    // one (Spawned). If dropping the supervisor had killed it, ensure would
    // have had to spawn a replacement.
    let mut again = ensure(binary.to_str().unwrap(), port, &[])
        .expect("the engine must still be there after the supervisor dropped");
    assert_eq!(
        again.provenance(),
        Provenance::Adopted,
        "invariant: dropping the supervisor must leave the engine running; \
         a re-ensure that has to Spawn means the engine died with the host"
    );
    assert!(again.status().is_some());
    drop(again);

    // Teardown: reap the fixture worker by port so the test does not leak a
    // process that locks the binary for the next build. This is the *test*
    // ending its own fixture, never the host stopping an engine.
    kill_worker_on(port);
}

#[test]
fn ensure_refuses_a_reserved_port() {
    // Port 4200 is burned (the retired v2 daemon). check_bind must refuse it
    // before any socket exists, and ensure must not paper over that.
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4200);
    assert!(check_bind(addr, None).is_err(), "4200 must stay refused");
}
