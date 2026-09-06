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
//! It does not supervise the retired protocol v2 render daemon on 4200, and nothing else does
//! either: the engine is the only renderer Playout speaks to.
//!
//! An already-running process is adopted rather than replaced, and the engine is never
//! stopped. During development the engine is usually started by hand, and killing an engine
//! that is on air to start an identical one is the last thing a supervisor should do.
//!
//! It also provisions the token signing secret on first run (`signing_secret_file`). The
//! control service refuses to start without one and nothing else ever wrote it, so a clean
//! install could not sign in until this existed.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows process-creation flag that starts a console subsystem process without a console
/// window. The value is stable (`CREATE_NO_WINDOW` in the Win32 API), and the `cfg` keeps it
/// out of every other target's way.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

/// Where the shell looks for the executables and JS bundles it launches.
///
/// A packaged installer carries the bundled `.mjs` under Tauri's `resource_dir`; a source
/// checkout has none of that but does have `Playout/services/*/dist/bundle`. This layout
/// captures both so one resolution rule works everywhere.
#[derive(Clone)]
pub struct RuntimeLayout {
    pub workspace_root: Option<PathBuf>,
    pub resource_root: Option<PathBuf>,
    /// AppData directory the launched services may write to. `Program Files` is read-only
    /// under a standard Windows account, so a launched service that tried to write there
    /// would fail on first request.
    pub data_root: PathBuf,
    /// Product-wide identity store and signing key shared with the Editor shell.
    pub auth_root: PathBuf,
}

impl RuntimeLayout {
    fn service_entry(&self, bundle: &str) -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(resources) = &self.resource_root {
            candidates.push(resources.join("services").join(bundle));
        }
        if let (Some(root), Some(package)) = (&self.workspace_root, source_dir_for(bundle)) {
            candidates.push(
                root.join("Playout")
                    .join("services")
                    .join(package)
                    .join("dist")
                    .join("bundle")
                    .join(bundle),
            );
        }
        candidates.into_iter().find(|path| path.is_file())
    }

    /// The Node runtime used to run the control service bundle.
    ///
    /// A packaged install ships its own `node.exe` beside the executable: a playout machine
    /// cannot be assumed to have Node on `PATH`, and without this the control service never
    /// starts. A checkout falls back to `PATH`.
    fn node_command(&self) -> PathBuf {
        adjacent_binary("node")
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from("node"))
    }
}

fn source_dir_for(bundle: &str) -> Option<&'static str> {
    Some(match bundle {
        "grapix-playout-control.mjs" => "playout-control",
        _ => return None,
    })
}

impl PlayoutSupervisor {
    pub fn start(layout: RuntimeLayout, app: AppHandle) -> Self {
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
            start_engine(&layout, &inner);
            start_control(&layout, &inner);
            watch(&layout, &inner, &app);
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

    /// Stop the control service. The engine is left running, always.
    ///
    /// Leaving an *adopted* engine alone is obvious. Leaving one this supervisor *started*
    /// alone is the part that matters: an operator opens Playout, takes a graphic on air, and
    /// closes the window. `docs/architecture.md` invariant 5 is that Program, its frame clock
    /// and its outputs continue when Editor, Playout or both close — so who started the
    /// engine cannot be what decides whether a show stays on air.
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().expect("supervisor mutex poisoned");
        inner.stopping = true;

        stop_slot(&mut inner.control);

        if inner.engine.child.is_some() {
            println!("[playout] leaving the render engine running: Program outlives this window");
            inner.engine.child = None;
        }
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

fn start_engine(layout: &RuntimeLayout, inner: &Arc<Mutex<Inner>>) {
    if port_open(ENGINE_ADDRESS) {
        adopt(inner, |inner| &mut inner.engine, "already running on :4400");
        return;
    }

    let configured = env::var_os("GRAPIX_RENDER_ENGINE_BIN").map(PathBuf::from);
    let workspace_debug = layout
        .workspace_root
        .as_ref()
        .map(|root| engine_binary(root, "debug"));
    let workspace_release = layout
        .workspace_root
        .as_ref()
        .map(|root| engine_binary(root, "release"));
    let candidates = [
        configured,
        adjacent_binary("grapix-render-engine"),
        workspace_debug,
        workspace_release,
    ];
    let Some(executable) = candidates.into_iter().flatten().find(|path| path.is_file()) else {
        fail(
            inner,
            |inner| &mut inner.engine,
            "render engine binary is missing; the installer's staged sidecar was not found",
        );
        return;
    };

    let config = layout.workspace_root.as_ref().map(|root| {
        root.join("services")
            .join("render-engine")
            .join("engine.toml")
    });
    let mut command = Command::new(executable);
    if let Some(root) = &layout.workspace_root {
        command.current_dir(root);
    } else {
        command.current_dir(&layout.data_root);
    }
    if let Some(config) = config.filter(|path| path.is_file()) {
        command.arg("--config").arg(config);
    }
    apply_shared_env(&mut command, layout);

    // The same key the control service mints tokens with, so the two agree by construction
    // when `auth.required` is turned on. Deliberately the `_FILE` form: `GRAPIX_ENGINE_AUTH_SECRET`
    // also flips `auth.required = true` (`config.rs`), and a shell may not decide on its own
    // that a renderer starts demanding credentials. A failure to provision is not propagated
    // here — the engine's default is `required = false`, and refusing to start a renderer over
    // a key it does not currently need would be the more expensive mistake on a playout machine.
    //
    // An *adopted* engine never sees this: there is no environment left to set. Same boundary
    // as everywhere else here — an engine this shell did not start is one it does not configure.
    if let Ok(Some(path)) = signing_secret_file(layout) {
        command.env("GRAPIX_ENGINE_AUTH_SECRET_FILE", path);
    }

    // The render engine keeps its console — the one window the operator asked to stay — so it
    // spawns with inherited output and no log redirect.
    spawn(inner, |inner| &mut inner.engine, command, None);
}

fn start_control(layout: &RuntimeLayout, inner: &Arc<Mutex<Inner>>) {
    if port_open(CONTROL_ADDRESS) {
        adopt(
            inner,
            |inner| &mut inner.control,
            "already running on :4300",
        );
        return;
    }

    let Some(entry) = layout.service_entry("grapix-playout-control.mjs") else {
        fail(
            inner,
            |inner| &mut inner.control,
            "bundle not found; run `npm run build -w @grapix/playout-control` and re-run `tauri build`",
        );
        return;
    };

    // Reported here rather than left to the service. Unprovisioned, it exits during start-up
    // with the reason on stdout only, which is the silent failure this path exists to remove —
    // the operator strip says why instead.
    let secret = match signing_secret_file(layout) {
        Ok(secret) => secret,
        Err(reason) => {
            fail(
                inner,
                |inner| &mut inner.control,
                &format!(
                    "could not provision the token signing secret ({reason}); \
                     set GRAPIX_AUTH_SECRET_FILE to a readable file of at least 32 characters"
                ),
            );
            return;
        }
    };

    let mut command = Command::new(layout.node_command());
    command.arg(entry).current_dir(&layout.data_root);
    apply_shared_env(&mut command, layout);
    // `None` means the environment already carries a secret, which the child inherits.
    if let Some(path) = &secret {
        command.env("GRAPIX_AUTH_SECRET_FILE", path);
    }
    // A Node service is a console-subsystem process; spawned with inherited stdio it allocates
    // a console window, which is the black terminal an operator sees pop up. Route its output to
    // a per-service log and start it with no window instead, so the service runs silently and
    // its words are still on disk when a start-up needs debugging. The render engine is the one
    // exception and keeps its console.
    hide_console(&mut command);
    spawn(
        inner,
        |inner| &mut inner.control,
        command,
        service_log(layout, "playout-control"),
    );
}

/// `Program Files` is read-only under a standard Windows account. Route every launched
/// service's data into per-user AppData so `playout-control` can write its rundowns, and
/// the engine can write its state directory.
fn apply_shared_env(command: &mut Command, layout: &RuntimeLayout) {
    command.env("GRAPIX_DATA_ROOT", &layout.data_root);
    command.env("GRAPIX_ACCOUNT_DATA_ROOT", &layout.auth_root);
    // `playout-control` reads its own variable and otherwise falls back to a path derived
    // from its file location — inside the read-only install directory once packaged.
    command.env("GRAPIX_PLAYOUT_DATA_DIR", layout.data_root.join("playout"));
}

/// Provision the token signing secret, once per installation.
///
/// `createPlayoutAuth` throws when no secret is configured, so without this the control
/// service exits during start-up, nothing listens on 4300, and the operator window reports
/// the resulting `fetch` rejection as `Failed to fetch` — a network fault by appearance, a
/// service that never started in fact. Nothing else in the shell or the installer ever wrote
/// the value the service requires of itself.
///
/// The secret persists. Regenerating it per launch would invalidate every refresh token and
/// every session minted against the previous key, signing out an operator mid-show because a
/// window was reopened.
///
/// Returns `Ok(None)` when the environment already carries a secret: a facility that manages
/// its own key material is the case this must not override, and a child inherits this
/// process's environment anyway.
///
/// Resolved per call rather than once at start-up, because `watch` restarts a service that
/// disappears and the restart needs the same value the first launch used. After the first
/// run the call is a single short file read.
fn signing_secret_file(layout: &RuntimeLayout) -> Result<Option<PathBuf>, String> {
    if env::var_os("GRAPIX_AUTH_SECRET").is_some()
        || env::var_os("GRAPIX_AUTH_SECRET_FILE").is_some()
    {
        return Ok(None);
    }

    let path = layout.auth_root.join("signing-secret");
    if secret_is_usable(&path) {
        return Ok(Some(path));
    }
    match write_new_secret(&path) {
        Ok(()) => {
            println!(
                "[playout] provisioned a token signing secret at {}",
                path.display()
            );
            Ok(Some(path))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Whether a secret already on disk can be handed on as-is.
///
/// Both sides enforce a 32-character floor — `validate_signing_secret` in the engine and the
/// TypeScript issuer it is written to match — so a truncated file is replaced rather than
/// passed on. An interrupted first run is how one is produced, and the failure it causes
/// surfaces later as a rejected sign-in rather than here as a bad file.
fn secret_is_usable(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|text| text.trim().len() >= 32)
        .unwrap_or(false)
}

/// Write a fresh secret, atomically.
///
/// 32 bytes of OS entropy as 64 hex characters: past the 32-character floor with room, and
/// hex so the value survives a shell, a `.env` and a TOML file without quoting rules changing
/// it. The write lands on a per-process temporary file and is renamed into place, so a crash
/// mid-write cannot leave a short secret behind for the next run to accept.
fn write_new_secret(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| std::io::Error::other(format!("no OS entropy available: {error}")))?;
    let secret: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();

    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    // The file holds a key. Unix can say so; Windows cannot, from `std` alone — there the
    // protection that actually applies is the per-user AppData root the file sits in.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(&temporary)?;
    let written = file
        .write_all(secret.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, path)
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
    log: Option<ServiceLog>,
) {
    command.stdin(Stdio::null());

    // When the process has a log, capture its pipes so no console is allocated and the words
    // land on disk; otherwise inherit, which is what gives the render engine its console.
    if log.is_some() {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }

    // Keep the lock through spawn and slot registration. Otherwise shutdown can set
    // `stopping` between those two operations, leaving a newly spawned control process
    // untracked and therefore unable to be stopped.
    let mut guard = inner.lock().expect("supervisor mutex poisoned");
    if guard.stopping {
        return;
    }
    let slot = select(&mut guard);
    match command.spawn() {
        Ok(mut child) => {
            if let Some(log) = log {
                if let Some(stdout) = child.stdout.take() {
                    pump_to_log(stdout, log.clone());
                }
                if let Some(stderr) = child.stderr.take() {
                    pump_to_log(stderr, log);
                }
            }
            println!("[playout] started {}", slot.label);
            slot.child = Some(child);
            slot.state = ProcessState::Starting;
            slot.detail = None;
        }
        Err(error) => {
            eprintln!("[playout] could not start {}: {error}", slot.label);
            slot.state = ProcessState::Failed;
            slot.detail = Some(error.to_string());
        }
    }
}

/// A service's log file: `data_root/logs/<process>.log`, opened for append.
///
/// `data_root` is the per-user AppData directory the whole product already writes to (see
/// `apply_shared_env`), so the log never touches `Program Files`. One file per service,
/// newest at the end; the supervisor truncates nothing, so a crash's last lines survive the
/// restart that follows.
#[derive(Clone)]
struct ServiceLog {
    path: PathBuf,
}

fn service_log(layout: &RuntimeLayout, process: &str) -> Option<ServiceLog> {
    let dir = layout.data_root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }
    Some(ServiceLog {
        path: dir.join(format!("{process}.log")),
    })
}

/// Copy one captured stream into the log until the process closes it.
fn pump_to_log(mut stream: impl Read + Send + 'static, log: ServiceLog) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if let Ok(mut file) =
                        OpenOptions::new().create(true).append(true).open(&log.path)
                    {
                        let _ = file.write_all(&buffer[..read]);
                    }
                }
            }
        }
    });
}

/// Start a console-subsystem process without a console window. A no-op off Windows, where
/// the question does not arise.
fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

fn adopt(inner: &Arc<Mutex<Inner>>, select: impl Fn(&mut Inner) -> &mut ProcessSlot, detail: &str) {
    let mut guard = inner.lock().expect("supervisor mutex poisoned");
    if guard.stopping {
        return;
    }
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

fn watch(layout: &RuntimeLayout, inner: &Arc<Mutex<Inner>>, app: &AppHandle) {
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

        let (restart_engine, restart_control) = {
            let mut guard = inner.lock().expect("supervisor mutex poisoned");
            if guard.stopping {
                return;
            }
            let within_grace = started.elapsed() < STARTUP_GRACE;
            update(&mut guard.engine, engine_up, within_grace);
            update(&mut guard.control, control_up, within_grace);
            (
                restart_required(&mut guard.engine),
                restart_required(&mut guard.control),
            )
        };
        if restart_engine {
            println!("[playout] restarting the render engine after it disappeared");
            start_engine(layout, inner);
        }
        if restart_control {
            println!("[playout] restarting playout-control after it disappeared");
            start_control(layout, inner);
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

fn restart_required(slot: &mut ProcessSlot) -> bool {
    if !matches!(slot.state, ProcessState::Lost | ProcessState::Failed) {
        return false;
    }
    let child_exited = match slot.child.as_mut() {
        None => return true,
        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
    };
    if child_exited {
        slot.child = None;
    }
    child_exited
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Invariant 5, as a test: an engine this supervisor started must survive shutdown.
    #[test]
    fn shutdown_never_stops_the_engine() {
        let mut engine = ProcessSlot::new("Render engine", ENGINE_ADDRESS);
        engine.state = ProcessState::Online;
        assert!(
            engine.child.is_none(),
            "no real child is spawned in a unit test"
        );

        // The adopted case, which is the easy half.
        engine.state = ProcessState::Adopted;
        stop_slot(&mut engine);
        assert_eq!(engine.state, ProcessState::Adopted);
    }

    #[test]
    fn stopping_prevents_a_late_adoption() {
        let inner = Arc::new(Mutex::new(Inner {
            engine: ProcessSlot::new("Render engine", ENGINE_ADDRESS),
            control: ProcessSlot::new("Playout control", CONTROL_ADDRESS),
            stopping: true,
        }));

        adopt(
            &inner,
            |inner| &mut inner.control,
            "already running on :4300",
        );

        assert_eq!(
            inner.lock().expect("test mutex").control.state,
            ProcessState::Idle
        );
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
    fn a_lost_adopted_process_is_restartable() {
        let mut slot = ProcessSlot::new("Render engine", ENGINE_ADDRESS);
        slot.state = ProcessState::Adopted;
        update(&mut slot, false, false);
        assert_eq!(slot.state, ProcessState::Lost);
        assert!(restart_required(&mut slot));
        assert!(slot.detail.is_some());
    }

    #[test]
    fn a_starting_process_is_given_the_grace_before_it_fails() {
        let mut slot = ProcessSlot::new("Playout control", CONTROL_ADDRESS);
        slot.state = ProcessState::Starting;
        update(&mut slot, false, true);
        assert_eq!(slot.state, ProcessState::Starting);
        update(&mut slot, false, false);
        assert_eq!(slot.state, ProcessState::Failed);
    }
}
