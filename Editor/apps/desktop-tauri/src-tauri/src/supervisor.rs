//! Editor desktop supervisor.
//!
//! Starts what the Editor needs and, deliberately, nothing more. What it supervises:
//!
//! | Process | Port | Ownership |
//! | --- | --- | --- |
//! | `project-api` | 4100 | owned: the Editor's own project/asset service |
//! | `grapix-render-engine` | 4400 | *ensured*, never owned |
//!
//! The engine is ensured rather than owned. `docs/architecture.md` invariant 5 is that
//! Program, its frame clock and its outputs continue when the Editor closes, so this
//! supervisor starts an engine when none is running and then leaves it alone — including on
//! window close, and including an engine it started itself. An Editor window is not allowed
//! to take a show off air by being shut.
//!
//! What it deliberately does **not** do, and used to:
//!
//! - supervise the protocol v2 render daemon on 4200 (retired: `architecture.md`, repository
//!   ownership — no packaged application launches or connects to protocol v2);
//! - restart the renderer, restore a Program scene or reconfigure and restart outputs. That
//!   is the Engine Host's durable-recovery path, and Program authority belongs to Playout
//!   (invariants 3 and 4). A shell that re-took a scene on air from a cached guess is exactly
//!   the failure mode the journal-and-verify recovery model exists to prevent.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const API_ADDRESS: &str = "127.0.0.1:4100";
const ENGINE_ADDRESS: &str = "127.0.0.1:4400";

/// How long a process is given to answer before it is reported as failed.
const STARTUP_GRACE: Duration = Duration::from_secs(45);
/// Health poll interval. Two seconds is frequent enough for a status strip and cheap.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessState {
    /// Not started yet.
    Idle,
    /// Started by this supervisor, not answering yet.
    Starting,
    /// Started by this supervisor and answering.
    Online,
    /// Already running when this supervisor looked. Never stopped by it.
    Adopted,
    /// Was answering and stopped.
    Lost,
    /// Could not be started, or never answered within the startup grace.
    Failed,
}

impl ProcessState {
    fn is_up(self) -> bool {
        matches!(self, ProcessState::Online | ProcessState::Adopted)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub label: String,
    pub address: String,
    pub state: ProcessState,
    pub detail: Option<String>,
    /// True when this supervisor owns the process and will stop it on close.
    pub supervised: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSnapshot {
    pub api: ProcessSnapshot,
    pub engine: ProcessSnapshot,
    pub ready: bool,
    /// Stated on every build on purpose. Repository tests cannot certify a GPU and output
    /// combination, so no build may imply that they did.
    pub certification_warning: String,
}

const CERTIFICATION_WARNING: &str =
    "Hardware/output combination has not completed GrapiX certification.";

struct ProcessSlot {
    label: &'static str,
    address: &'static str,
    child: Option<Child>,
    state: ProcessState,
    detail: Option<String>,
}

impl ProcessSlot {
    fn new(label: &'static str, address: &'static str) -> Self {
        Self {
            label,
            address,
            child: None,
            state: ProcessState::Idle,
            detail: None,
        }
    }

    fn snapshot(&self) -> ProcessSnapshot {
        ProcessSnapshot {
            label: self.label.to_string(),
            address: self.address.to_string(),
            state: self.state,
            detail: self.detail.clone(),
            supervised: self.child.is_some(),
        }
    }
}

struct Inner {
    api: ProcessSlot,
    engine: ProcessSlot,
    stopping: bool,
}

impl Inner {
    fn snapshot(&self) -> SupervisorSnapshot {
        SupervisorSnapshot {
            api: self.api.snapshot(),
            engine: self.engine.snapshot(),
            ready: self.api.state.is_up() && self.engine.state.is_up(),
            certification_warning: CERTIFICATION_WARNING.to_string(),
        }
    }
}

pub struct DesktopSupervisor {
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl DesktopSupervisor {
    /// Start what is missing and watch everything.
    pub fn start(root: PathBuf, app: AppHandle) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            api: ProcessSlot::new("Project service", API_ADDRESS),
            engine: ProcessSlot::new("Render engine", ENGINE_ADDRESS),
            stopping: false,
        }));

        let supervisor = Self {
            root: root.clone(),
            inner: Arc::clone(&inner),
        };

        thread::spawn(move || {
            // The engine first: the editor's engine client connects on start-up, and the
            // other order means it spends its first seconds retrying.
            ensure_engine(&root, &inner);
            start_api(&root, &inner);
            watch(&inner, &app);
        });

        supervisor
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.inner
            .lock()
            .map(|inner| inner.snapshot())
            .unwrap_or_else(|_| SupervisorSnapshot {
                api: ProcessSlot::new("Project service", API_ADDRESS).snapshot(),
                engine: ProcessSlot::new("Render engine", ENGINE_ADDRESS).snapshot(),
                ready: false,
                certification_warning: CERTIFICATION_WARNING.to_string(),
            })
    }

    /// Stop the Editor's own service. The engine is left running, always.
    pub fn shutdown(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.stopping = true;
        stop_owned(&mut inner.api);

        // Not a bug and not laziness: an engine may be rendering Program. Closing an Editor
        // window must never stop it, whoever started it.
        if inner.engine.child.is_some() {
            println!("[grapix] leaving the render engine running: Program outlives the Editor");
            inner.engine.child = None;
        }
    }

    #[allow(dead_code)]
    pub fn workspace_root(&self) -> &Path {
        &self.root
    }
}

/// Stop one slot, if this supervisor owns it.
fn stop_owned(slot: &mut ProcessSlot) {
    if let Some(child) = slot.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
        println!("[grapix] stopped {}", slot.label);
    } else if slot.state == ProcessState::Adopted {
        println!(
            "[grapix] leaving {} running: this supervisor did not start it",
            slot.label
        );
    }
    slot.child = None;
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

fn ensure_engine(root: &Path, inner: &Arc<Mutex<Inner>>) {
    if port_open(ENGINE_ADDRESS) {
        adopt(inner, |inner| &mut inner.engine, "already running on :4400");
        return;
    }

    let configured = std::env::var_os("GRAPIX_RENDER_ENGINE_BIN").map(PathBuf::from);
    let candidates = [
        configured,
        adjacent_binary("grapix-render-engine"),
        Some(engine_binary(root, "debug")),
        Some(engine_binary(root, "release")),
    ];
    let Some(executable) = candidates.into_iter().flatten().find(|path| path.is_file()) else {
        fail(
            inner,
            |inner| &mut inner.engine,
            "binary not found; run `cargo build --manifest-path services/render-engine/Cargo.toml`",
        );
        return;
    };

    let config = root
        .join("services")
        .join("render-engine")
        .join("engine.toml");
    let mut command = Command::new(executable);
    command.current_dir(root);
    if config.is_file() {
        command.arg("--config").arg(config);
    }

    spawn(inner, |inner| &mut inner.engine, command);
}

fn start_api(root: &Path, inner: &Arc<Mutex<Inner>>) {
    if port_open(API_ADDRESS) {
        adopt(inner, |inner| &mut inner.api, "already running on :4100");
        return;
    }

    // The project API moved to Editor/services/project-api in the Phase 2 migration; the npm
    // package is still @grapix/api-server.
    let entry = root
        .join("Editor")
        .join("services")
        .join("project-api")
        .join("dist")
        .join("index.js");
    if !entry.is_file() {
        fail(
            inner,
            |inner| &mut inner.api,
            "build output not found; run `npm run build -w @grapix/api-server`",
        );
        return;
    }

    let mut command = Command::new("node");
    command.arg(entry).current_dir(root);
    spawn(inner, |inner| &mut inner.api, command);
}

fn engine_binary(root: &Path, profile: &str) -> PathBuf {
    root.join("services")
        .join("render-engine")
        .join("target")
        .join(profile)
        .join(binary_name("grapix-render-engine"))
}

/// A binary shipped beside the bundled application, which is where a packaged build finds it.
fn adjacent_binary(name: &str) -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|parent| parent.join(binary_name(name)))
}

fn binary_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

fn spawn(
    inner: &Arc<Mutex<Inner>>,
    select: impl Fn(&mut Inner) -> &mut ProcessSlot,
    mut command: Command,
) {
    // Inherited output on purpose: whoever is debugging a start-up failure needs the
    // process's own words, not a supervisor's summary of them.
    command.stdin(Stdio::null());

    match command.spawn() {
        Ok(child) => {
            let Ok(mut guard) = inner.lock() else { return };
            let slot = select(&mut guard);
            println!("[grapix] started {}", slot.label);
            slot.child = Some(child);
            slot.state = ProcessState::Starting;
            slot.detail = None;
        }
        Err(error) => {
            let Ok(mut guard) = inner.lock() else { return };
            let slot = select(&mut guard);
            eprintln!("[grapix] could not start {}: {error}", slot.label);
            slot.state = ProcessState::Failed;
            slot.detail = Some(error.to_string());
        }
    }
}

fn adopt(
    inner: &Arc<Mutex<Inner>>,
    select: impl Fn(&mut Inner) -> &mut ProcessSlot,
    detail: &str,
) {
    let Ok(mut guard) = inner.lock() else { return };
    let slot = select(&mut guard);
    println!("[grapix] adopting {}: {detail}", slot.label);
    slot.state = ProcessState::Adopted;
    slot.detail = Some(detail.to_string());
}

fn fail(inner: &Arc<Mutex<Inner>>, select: impl Fn(&mut Inner) -> &mut ProcessSlot, detail: &str) {
    let Ok(mut guard) = inner.lock() else { return };
    let slot = select(&mut guard);
    eprintln!("[grapix] {} unavailable: {detail}", slot.label);
    slot.state = ProcessState::Failed;
    slot.detail = Some(detail.to_string());
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

fn watch(inner: &Arc<Mutex<Inner>>, app: &AppHandle) {
    let started = Instant::now();
    let mut previous: Option<String> = None;

    loop {
        match inner.lock() {
            Ok(guard) if guard.stopping => return,
            Ok(_) => {}
            Err(_) => return,
        }

        // The API answers HTTP, so ask it: a hung Fastify still holds its port. The engine
        // speaks protocol v3 over WebSocket, and a real hello handshake belongs to the
        // editor's engine client, not to a status strip — a reachable port is what this
        // supervisor can honestly claim.
        let api_up = api_health();
        let engine_up = port_open(ENGINE_ADDRESS);

        let snapshot = {
            let Ok(mut guard) = inner.lock() else { return };
            let within_grace = started.elapsed() < STARTUP_GRACE;
            update(&mut guard.api, api_up, within_grace);
            update(&mut guard.engine, engine_up, within_grace);
            guard.snapshot()
        };

        // Emitted only on change: an event every two seconds forever would be noise, and the
        // UI polls the command for its initial state anyway.
        let fingerprint = format!(
            "{:?}/{:?}/{}",
            snapshot.api.state, snapshot.engine.state, snapshot.ready
        );
        if previous.as_deref() != Some(fingerprint.as_str()) {
            let _ = app.emit("grapix-supervisor-status", &snapshot);
            previous = Some(fingerprint);
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn update(slot: &mut ProcessSlot, up: bool, within_grace: bool) {
    match (slot.state, up) {
        (ProcessState::Adopted, true) => {}
        (_, true) => {
            if slot.state != ProcessState::Online {
                println!("[grapix] {} online", slot.label);
            }
            slot.state = ProcessState::Online;
            slot.detail = None;
        }
        (ProcessState::Online, false) => {
            eprintln!("[grapix] {} stopped answering", slot.label);
            slot.state = ProcessState::Lost;
            slot.detail = Some("stopped answering on its port".to_string());
        }
        (ProcessState::Adopted, false) => {
            slot.state = ProcessState::Lost;
            slot.detail = Some("the process this supervisor adopted has gone".to_string());
        }
        (ProcessState::Starting, false) if !within_grace => {
            slot.state = ProcessState::Failed;
            slot.detail = Some("did not answer within the startup grace".to_string());
        }
        _ => {}
    }
}

fn port_open(address: &str) -> bool {
    let Ok(mut candidates) = address.to_socket_addrs() else {
        return false;
    };
    let Some(target) = candidates.next() else {
        return false;
    };
    TcpStream::connect_timeout(&target, Duration::from_millis(300)).is_ok()
}

fn api_health() -> bool {
    http_get(API_ADDRESS, "/health").is_some_and(|status| status == 200)
}

/// Minimal HTTP status probe. A dependency would be a larger surface than one request.
fn http_get(address: &str, path: &str) -> Option<u16> {
    let target: SocketAddr = address.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&target, Duration::from_millis(750)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;

    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    parse_status(&response)
}

fn parse_status(raw: &str) -> Option<u16> {
    raw.lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_status_line() {
        assert_eq!(
            parse_status("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"),
            Some(200)
        );
        assert_eq!(parse_status("HTTP/1.1 503 Service Unavailable\r\n\r\n"), Some(503));
        assert_eq!(parse_status("not http"), None);
    }

    #[test]
    fn only_online_and_adopted_count_as_up() {
        assert!(ProcessState::Online.is_up());
        assert!(ProcessState::Adopted.is_up());
        assert!(!ProcessState::Starting.is_up());
        assert!(!ProcessState::Lost.is_up());
        assert!(!ProcessState::Failed.is_up());
        assert!(!ProcessState::Idle.is_up());
    }

    #[test]
    fn an_adopted_slot_is_never_owned_and_so_is_never_stopped() {
        let mut slot = ProcessSlot::new("Render engine", ENGINE_ADDRESS);
        slot.state = ProcessState::Adopted;
        assert!(!slot.snapshot().supervised);
        stop_owned(&mut slot);
        assert_eq!(slot.state, ProcessState::Adopted);
    }

    #[test]
    fn a_lost_process_is_reported_rather_than_restarted() {
        let mut slot = ProcessSlot::new("Project service", API_ADDRESS);
        slot.state = ProcessState::Online;
        update(&mut slot, false, false);
        assert_eq!(slot.state, ProcessState::Lost);
        assert!(slot.detail.is_some());
    }

    #[test]
    fn a_starting_process_is_given_the_grace_before_it_fails() {
        let mut slot = ProcessSlot::new("Render engine", ENGINE_ADDRESS);
        slot.state = ProcessState::Starting;
        update(&mut slot, false, true);
        assert_eq!(slot.state, ProcessState::Starting);
        update(&mut slot, false, false);
        assert_eq!(slot.state, ProcessState::Failed);
    }
}
