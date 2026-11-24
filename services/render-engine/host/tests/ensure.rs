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
use gx_engine_host::{ensure_with_journal, Provenance};
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
        // The local address column must end with exactly this port: a bare `contains` would
        // also match port 5439 inside `:54395` and end a process that is not this fixture.
        let suffix = format!(":{port}");
        for line in text.lines() {
            let mut columns = line.split_whitespace();
            let local = columns.nth(1).unwrap_or("");
            if local.ends_with(&suffix) && line.contains("LISTENING") {
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

/// End the worker listening on `port` (test teardown only) by asking it to stop over the
/// control plane (2.19), and wait until its port is closed.
///
/// `taskkill` alone is not enough: on the machine these tests are run on it hangs for a minute
/// and ends nothing (23 Nov 2026), so every run left a worker holding `gx-render-worker.exe`
/// open and the next build failed with "access is denied". The engine's own `stop` needs no
/// operating-system tool. `kill_worker_on` stays as the fallback for a worker that does not
/// answer.
fn stop_worker_on(port: u16) {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut client) = gx_control_transport::Client::connect(addr) else {
        // Nothing is listening: there is no worker to end.
        return;
    };
    let reply = client.request(gx_control_plane::message::ClientRequest::Stop);
    drop(client);
    if matches!(reply, Ok(gx_control_plane::message::EngineReply::Stopping)) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    eprintln!("the worker on {addr} did not stop when asked ({reply:?}); ending it by process id");
    kill_worker_on(port);
}

/// Reaps the worker a test made `ensure` spawn on `port`, when the test ends for any reason.
/// A teardown call at the end of the test body is skipped by a failed assertion, and the worker
/// it leaves holds `gx-render-worker.exe` open, so the next build fails with "access is denied"
/// (it did, on 23 Nov 2026, twice). This is the test ending its own fixture, never the host
/// stopping an engine.
struct ReapOnDrop(u16);
impl Drop for ReapOnDrop {
    fn drop(&mut self) {
        stop_worker_on(self.0);
    }
}

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
            // 2.12: a test process logs to a scratch folder, not the operator's log root.
            .env("GX_LOG_DIR", std::env::temp_dir().join("gx-test-logs"))
            .args(["--port", &port.to_string()])
            // A test never reads or writes the operator's own recovery journal: an old journal
            // that no longer restores would fail a test that is about adopting an engine.
            .args(["--recovery-journal"])
            .arg(scratch_journal(port))
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

    let mut supervised = {
        quiet_logs();
        ensure_with_journal(binary.to_str().unwrap(), port, &[], &scratch_journal(port))
    }
    .expect("ensure adopts the running engine");

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
    // Declared before anything can spawn, so a failed assertion below still reaps the worker.
    let _reap = ReapOnDrop(port);
    let mut supervised = {
        quiet_logs();
        ensure_with_journal(binary.to_str().unwrap(), port, &[], &scratch_journal(port))
    }
    .expect("ensure spawns an engine when none is running");

    assert_eq!(supervised.provenance(), Provenance::Spawned);
    assert!(supervised.status().is_some());
    drop(supervised);

    // The invariant that defines this crate: the host never stops the engine
    // it started. Proof by provenance: dropping the supervisor and ensuring
    // again must find the *same* engine still running (Adopted), not a fresh
    // one (Spawned). If dropping the supervisor had killed it, ensure would
    // have had to spawn a replacement.
    let mut again = {
        quiet_logs();
        ensure_with_journal(binary.to_str().unwrap(), port, &[], &scratch_journal(port))
    }
    .expect("the engine must still be there after the supervisor dropped");
    assert_eq!(
        again.provenance(),
        Provenance::Adopted,
        "invariant: dropping the supervisor must leave the engine running; \
         a re-ensure that has to Spawn means the engine died with the host"
    );
    assert!(again.status().is_some());
    drop(again);

    // Teardown: the fixture worker is asked to stop, and it must be gone, or the next build
    // cannot replace its binary. `_reap` does the same when an assertion above fails.
    stop_worker_on(port);
    assert!(
        gx_control_transport::Client::connect(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            port
        ))
        .is_err(),
        "the fixture worker on port {port} is still answering after the test ended it"
    );
}

#[test]
fn ensure_refuses_a_reserved_port() {
    // Port 4200 is burned (the retired v2 daemon). check_bind must refuse it
    // before any socket exists, and ensure must not paper over that.
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4200);
    assert!(check_bind(addr, None).is_err(), "4200 must stay refused");
}

/// 2.12: a worker that `ensure` spawns inherits this test's environment, so it
/// logs to a scratch folder rather than the operator's log root.
/// A recovery journal in a scratch folder, one per port, so no test touches the operator's own.
fn scratch_journal(port: u16) -> PathBuf {
    let dir = std::env::temp_dir().join("gx-test-journals");
    std::fs::create_dir_all(&dir).expect("scratch folder for journals");
    dir.join(format!("recovery-{port}-{}.json", std::process::id()))
}

fn quiet_logs() {
    std::env::set_var("GX_LOG_DIR", std::env::temp_dir().join("gx-test-logs"));
}
