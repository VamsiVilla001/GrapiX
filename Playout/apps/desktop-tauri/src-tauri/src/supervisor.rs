//! Playout desktop supervisor.
//!
//! Starts and watches the processes an operator needs, and — the part that matters — never
//! becomes authoritative for what is on air. Program state lives in the render engine, so
//! this window can be closed and reopened while the show continues.
//!
//! What it supervises:
//!
//! | Process | Port | Why |
//! | --- | --- | --- |
//! | `grapix-render-engine` | 4400 | owns Program, the frame clock and the outputs |
//! | `playout-control` | 4300 | published scene library, rundowns, operator commands |
//!
//! It deliberately does **not** supervise the protocol v2 render daemon on 4200. Playout
//! prefers the engine and falls back to the daemon only when the engine is absent; starting
//! both by default would mean two renderers competing for the GPU on a machine that needs
//! one of them to hold a frame deadline.
//!
//! An already-running process is adopted rather than replaced. During development the engine
//! is usually started by hand, and killing an engine that is on air to start an identical one
//! is the last thing a supervisor should do.

use std::env;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const ENGINE_ADDRESS: &str = "127.0.0.1:4400";
const CONTROL_ADDRESS: &str = "127.0.0.1:4300";

/// How long a process is given to answer on its port before it is reported as failed.
const STARTUP_GRACE: Duration = Duration::from_secs(45);
/// Health poll interval. Two seconds is frequent enough for an operator strip and cheap.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessState {
    /// Not started, and not needed yet.
    Idle,
    Starting,
    /// Answering on its port.
    Online,
    /// Was online and is not now.
    Lost,
    /// Could not be started at all, with a reason.
    Failed,
    /// Already running when the supervisor started, so it is left alone.
    Adopted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub label: String,
    pub address: String,
    pub state: ProcessState,
    pub detail: Option<String>,
    /// True when this supervisor started it, so the UI can say what it owns.
    pub supervised: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSnapshot {
    pub engine: ProcessSnapshot,
    pub control: ProcessSnapshot,
    /// True once both are answering, which is what the operator UI waits for.
    pub ready: bool,
}

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
    engine: ProcessSlot,
    control: ProcessSlot,
    stopping: bool,
}

pub struct PlayoutSupervisor {
    inner: Arc<Mutex<Inner>>,
}

impl PlayoutSupervisor {
    /// Start what is missing and watch everything.
    pub fn start(root: PathBuf, app: AppHandle) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            engine: ProcessSlot::new("Render engine", ENGINE_ADDRESS),
            control: ProcessSlot::new("Playout control", CONTROL_ADDRESS),
            stopping: false,
        }));

        let supervisor = Self {
            inner: Arc::clone(&inner),
        };

        thread::spawn(move || {
            // The engine first: playout-control connects to it on startup, and starting them
            // the other way round means the control service spends its first seconds
            // retrying.
            start_engine(&root, &inner);
            start_control(&root, &inner);
            watch(&inner, &app);
        });

        supervisor
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        let inner = self.inner.lock().expect("supervisor mutex poisoned");
        SupervisorSnapshot {
            engine: inner.engine.snapshot(),
            control: inner.control.snapshot(),
            ready: inner.engine.state.is_up() && inner.control.state.is_up(),
        }
    }

    /// Stop only what this supervisor started.
    ///
    /// An adopted process is left running on purpose: it may be an engine that is on air, and
    /// closing an operator window must never take a show off air.
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().expect("supervisor mutex poisoned");
        inner.stopping = true;

        // Control first, then the engine: the control service holds a connection to the
        // engine, and stopping the engine underneath it produces a pointless error in its log.
        stop_slot(&mut inner.control);
        stop_slot(&mut inner.engine);
    }
}

/// Stop one slot, if this supervisor owns it.
fn stop_slot(slot: &mut ProcessSlot) {
    if let Some(child) = slot.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
        println!("[playout] stopped {}", slot.label);
    } else if slot.state == ProcessState::Adopted {
        // Deliberate: it may be an engine that is on air, and closing an operator window
        // must never take a show off air.
        println!(
            "[playout] leaving {} running: this supervisor did not start it",
            slot.label
        );
    }
    slot.child = None;
}

impl ProcessState {
    fn is_up(self) -> bool {
        matches!(self, ProcessState::Online | ProcessState::Adopted)
    }
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

fn start_engine(root: &Path, inner: &Arc<Mutex<Inner>>) {
    if port_open(ENGINE_ADDRESS) {
        adopt(inner, |inner| &mut inner.engine, "already running on :4400");
        return;
    }

    let configured = env::var_os("GRAPIX_RENDER_ENGINE_BIN").map(PathBuf::from);
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

    let config = root.join("services").join("render-engine").join("engine.toml");
    let mut command = Command::new(executable);
    command.current_dir(root);
    if config.is_file() {
        command.arg("--config").arg(config);
    }

    spawn(inner, |inner| &mut inner.engine, command);
}

fn start_control(root: &Path, inner: &Arc<Mutex<Inner>>) {
    if port_open(CONTROL_ADDRESS) {
        adopt(inner, |inner| &mut inner.control, "already running on :4300");
        return;
    }

    let entry = root
        .join("Playout")
        .join("services")
        .join("playout-control")
        .join("dist")
        .join("index.js");
    if !entry.is_file() {
        fail(
            inner,
            |inner| &mut inner.control,
            "build output not found; run `npm run build -w @grapix/playout-control`",
        );
        return;
    }

    let mut command = Command::new("node");
    command.arg(entry).current_dir(root);
    spawn(inner, |inner| &mut inner.control, command);
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
    env::current_exe()
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
    // Inherited output on purpose: an operator debugging a start-up failure needs the
    // process's own words, not a supervisor's summary of them.
    command.stdin(Stdio::null());

    match command.spawn() {
        Ok(child) => {
            let mut guard = inner.lock().expect("supervisor mutex poisoned");
            let slot = select(&mut guard);
            println!("[playout] started {}", slot.label);
            slot.child = Some(child);
            slot.state = ProcessState::Starting;
            slot.detail = None;
        }
        Err(error) => {
            let mut guard = inner.lock().expect("supervisor mutex poisoned");
            let slot = select(&mut guard);
            eprintln!("[playout] could not start {}: {error}", slot.label);
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
    let mut guard = inner.lock().expect("supervisor mutex poisoned");
    let slot = select(&mut guard);
    println!("[playout] adopting {}: {detail}", slot.label);
    slot.state = ProcessState::Adopted;
    slot.detail = Some(detail.to_string());
}

fn fail(inner: &Arc<Mutex<Inner>>, select: impl Fn(&mut Inner) -> &mut ProcessSlot, detail: &str) {
    let mut guard = inner.lock().expect("supervisor mutex poisoned");
    let slot = select(&mut guard);
    eprintln!("[playout] {} unavailable: {detail}", slot.label);
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
        {
            let guard = inner.lock().expect("supervisor mutex poisoned");
            if guard.stopping {
                return;
            }
        }

        let engine_up = port_open(ENGINE_ADDRESS);
        let control_up = port_open(CONTROL_ADDRESS);

        {
            let mut guard = inner.lock().expect("supervisor mutex poisoned");
            let within_grace = started.elapsed() < STARTUP_GRACE;
            update(&mut guard.engine, engine_up, within_grace);
            update(&mut guard.control, control_up, within_grace);
        }

        let snapshot = {
            let guard = inner.lock().expect("supervisor mutex poisoned");
            SupervisorSnapshot {
                engine: guard.engine.snapshot(),
                control: guard.control.snapshot(),
                ready: guard.engine.state.is_up() && guard.control.state.is_up(),
            }
        };

        // Emitted only on change: an event every two seconds forever would be noise, and the
        // UI polls the command for its initial state anyway.
        let fingerprint = format!(
            "{:?}/{:?}/{}",
            snapshot.engine.state, snapshot.control.state, snapshot.ready
        );
        if previous.as_deref() != Some(fingerprint.as_str()) {
            let _ = app.emit("playout://supervisor", &snapshot);
            previous = Some(fingerprint);
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn update(slot: &mut ProcessSlot, up: bool, within_grace: bool) {
    match (slot.state, up) {
        (_, true) if slot.state == ProcessState::Adopted => {}
        (_, true) => {
            if slot.state != ProcessState::Online {
                println!("[playout] {} online", slot.label);
            }
            slot.state = ProcessState::Online;
            slot.detail = None;
        }
        (ProcessState::Online, false) => {
            eprintln!("[playout] {} stopped answering", slot.label);
            slot.state = ProcessState::Lost;
            slot.detail = Some("stopped answering on its port".to_string());
        }
        (ProcessState::Adopted, false) => {
            slot.state = ProcessState::Lost;
            slot.detail = Some("the process this supervisor adopted has gone".to_string());
        }
        (ProcessState::Starting, false) if !within_grace => {
            slot.state = ProcessState::Failed;
            slot.detail = Some("did not answer on its port within the startup grace".to_string());
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

/// Ask the control service for its own view of the engine, for the operator strip.
///
/// Goes through the control service rather than the engine directly: the control service is
/// what Playout's UI trusts, and a supervisor reporting a different answer than the service
/// would leave an operator with two truths.
pub fn control_engine_status() -> Option<String> {
    let target = CONTROL_ADDRESS.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&target, Duration::from_millis(500)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .ok()?;

    let request = format!(
        "GET /api/playout/engine HTTP/1.1\r\nHost: {CONTROL_ADDRESS}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let body = response.split("\r\n\r\n").nth(1)?;
    Some(body.to_string())
}
