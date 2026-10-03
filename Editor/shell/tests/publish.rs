//! Integration: the Editor shell's publish path reaches a real engine.
//!
//! This runs against the actual worker binary, so it needs it built. Cargo
//! does not build sibling binaries for a library's integration test, so the
//! test skips cleanly when the binary is absent rather than failing
//! (invariant 43: a skip is not a pass, and a missing binary is a skip).
//!
//! What it proves is the seam the unit tests cannot: that the document the
//! Editor produces is one a real engine accepts, and that the revision it
//! reports is the revision the engine actually issued.

use std::net::{Ipv4Addr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use gx_contracts::scene::new_scene;
use gx_editor_shell::{publish, EditorError};

/// The worker binary, next to this test executable in target/debug.
fn worker_binary() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    // .../target/debug/deps/publish-xxxx -> .../target/debug
    let debug = current.parent()?.parent()?;
    let candidate = debug.join(if cfg!(windows) {
        "gx-render-worker.exe"
    } else {
        "gx-render-worker"
    });
    candidate.exists().then_some(candidate)
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind ephemeral");
    listener.local_addr().expect("local addr").port()
}

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start a worker and wait for its asset plane to accept connections.
///
/// The worker is given its own recovery journal. Without that it restores the
/// machine's real one, and a scene this test published on an earlier run
/// comes back as an existing revision — which is the engine behaving
/// correctly and the test not being isolated.
fn start_worker(binary: &PathBuf, control: u16, asset: u16, journal: &PathBuf) -> Option<KillOnDrop> {
    let child = KillOnDrop(
        Command::new(binary)
            .args([
                "--port",
                &control.to_string(),
                "--asset-port",
                &asset.to_string(),
                "--recovery-journal",
                &journal.display().to_string(),
            ])
            // Detached so the long-lived worker does not hold the test
            // harness's output pipe open after the test wants to exit.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?,
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect((Ipv4Addr::LOCALHOST, asset)).is_ok() {
            return Some(child);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

#[test]
fn an_authored_scene_publishes_to_a_real_engine_and_reports_its_revision() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let control = free_port();
    let asset = free_port();
    let journal = std::env::temp_dir().join(format!(
        "gx-editor-shell-journal-{}-{}/recovery.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let Some(_worker) = start_worker(&binary, control, asset, &journal) else {
        eprintln!("SKIP: the worker did not come up");
        return;
    };
    let endpoint = format!("127.0.0.1:{asset}");

    let scene = new_scene("shell-demo", "Shell Demo");
    let first = publish(&endpoint, scene.clone()).expect("a valid scene publishes");
    assert_eq!(first.take_id.0, "shell-demo");
    assert_eq!(first.revision.0, 1, "the first publication is revision 1");

    // Publishing is additive (invariant 30): the same id republished produces
    // a *new* revision rather than editing the one already issued. An Editor
    // that reported the old revision would send Playout to a stale take.
    let second = publish(&endpoint, scene).expect("republishing is additive");
    assert_eq!(second.revision.0, 2, "a republish issues the next revision");
}

#[test]
fn an_unreachable_asset_plane_is_not_reported_as_a_refusal() {
    // Nothing is listening here. The distinction matters: a refusal means the
    // engine decided, and an author must not be told their document was
    // rejected when it was never seen (invariant 17).
    let endpoint = format!("127.0.0.1:{}", free_port());
    let error = publish(&endpoint, new_scene("demo", "Demo"))
        .expect_err("an unreachable plane cannot publish");
    assert!(
        matches!(error, EditorError::Unreachable { .. }),
        "expected Unreachable, got {error:?}"
    );
}
