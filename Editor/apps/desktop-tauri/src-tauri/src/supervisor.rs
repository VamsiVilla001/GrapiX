//! Editor desktop supervisor.
//!
//! Starts what the Editor needs and, deliberately, nothing more. What it supervises:
//!
//! | Process | Port | Ownership |
//! | --- | --- | --- |
//! | `project-api` | 4100 | owned: the Editor's own project/asset service |
//! | `editor-assistant` | 4160 | owned: the AI assistant broker (Editor-only, no Program authority) |
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

use std::env;
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
const ASSISTANT_ADDRESS: &str = "127.0.0.1:4160";
const ADOBE_ADDRESS: &str = "127.0.0.1:4784";
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
    pub assistant: ProcessSnapshot,
    pub adobe: ProcessSnapshot,
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
    assistant: ProcessSlot,
    adobe: ProcessSlot,
    engine: ProcessSlot,
    stopping: bool,
}

impl Inner {
    fn snapshot(&self) -> SupervisorSnapshot {
        SupervisorSnapshot {
            api: self.api.snapshot(),
            assistant: self.assistant.snapshot(),
            adobe: self.adobe.snapshot(),
            engine: self.engine.snapshot(),
            ready: self.api.state.is_up() && self.engine.state.is_up(),
            certification_warning: CERTIFICATION_WARNING.to_string(),
        }
    }
}
/// Where the shell looks for the executables and JS bundles it launches.
///
/// A packaged installer has no `Editor/services/*/dist` source tree beside the .exe: it
/// carries the bundled `.mjs` files under Tauri's own `resource_dir`. A development
/// checkout has neither `resource_dir` nor packaged binaries, but does have the source
/// tree. This runtime record captures both, so a single resolution rule works everywhere.
#[derive(Clone)]
pub struct RuntimeLayout {
    /// Repository root when running from a `cargo run` / `tauri dev` checkout. `None` in
    /// packaged builds, whose source tree is not on disk beside the .exe.
    pub workspace_root: Option<PathBuf>,
    /// Directory Tauri unpacked its `bundle.resources` into. `None` when running from
    /// source, where every artifact lives in the workspace tree.
    pub resource_root: Option<PathBuf>,
    /// Where the Editor's data (scenes, assets, packages, logs) is written. Defaults to
    /// the per-user AppData directory rather than Program Files, so a packaged installer
    /// running under a standard Windows account does not try to write to a read-only tree.
    pub data_root: PathBuf,
}

impl RuntimeLayout {
    fn service_entry(&self, name: &str) -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(resources) = &self.resource_root {
            candidates.push(resources.join("services").join(name));
        }
        if let (Some(root), Some(package)) = (&self.workspace_root, source_dir_for(name)) {
            candidates.push(
                root.join("Editor")
                    .join("services")
                    .join(package)
                    .join("dist")
                    .join("bundle")
                    .join(name),
            );
        }
        candidates.into_iter().find(|path| path.is_file())
    }

    /// Root the MCP server ingests its architecture and contract knowledge from.
    ///
    /// A checkout is its own corpus root and is preferred, because reading the live tree
    /// can never serve a stale invariant. A packaged install has no tree, so it falls back
    /// to the `knowledge/` resource the installer stages. Returning `None` would leave the
    /// MCP server to auto-detect and throw, taking the assistant's tools with it.
    fn knowledge_root(&self) -> Option<PathBuf> {
        if let Some(root) = &self.workspace_root {
            if root.join("docs").join("architecture.md").is_file() {
                return Some(root.clone());
            }
        }
        let staged = self.resource_root.as_ref()?.join("knowledge");
        staged
            .join("docs")
            .join("architecture.md")
            .is_file()
            .then_some(staged)
    }

    /// The Node runtime used to run the service bundles.
    ///
    /// A packaged install ships its own `node.exe` beside the executable, because a
    /// broadcast machine cannot be assumed to have Node on `PATH` — without this every
    /// service fails to spawn on a clean install. A checkout falls back to `PATH`.
    fn node_command(&self) -> PathBuf {
        adjacent_binary("node")
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from("node"))
    }
}

/// Map a bundled resource file back to the source-tree package directory it came from.
/// A development checkout does not stage a `resource_root`, so the supervisor needs to
/// know which `Editor/services/*` to fall back to.
fn source_dir_for(bundle_file: &str) -> Option<&'static str> {
    Some(match bundle_file {
        "grapix-api-server.mjs" => "project-api",
        "grapix-editor-assistant.mjs" => "editor-assistant",
        "grapix-adobe-mcp-gateway.mjs" => "adobe-mcp-gateway",
        "grapix-editor-mcp.mjs" => "editor-mcp",
        _ => return None,
    })
}

pub struct DesktopSupervisor {
    layout: RuntimeLayout,
    inner: Arc<Mutex<Inner>>,
}

impl DesktopSupervisor {
    /// Start what is missing and watch everything.
    pub fn start(layout: RuntimeLayout, app: AppHandle) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            api: ProcessSlot::new("Project service", API_ADDRESS),
            assistant: ProcessSlot::new("AI assistant", ASSISTANT_ADDRESS),
            adobe: ProcessSlot::new("Adobe gateway", ADOBE_ADDRESS),
            engine: ProcessSlot::new("Render engine", ENGINE_ADDRESS),
            stopping: false,
        }));

        let supervisor = Self {
            layout: layout.clone(),
            inner: Arc::clone(&inner),
        };

        thread::spawn(move || {
            // The engine first: the editor's engine client connects on start-up, and the
            // other order means it spends its first seconds retrying.
            ensure_engine(&layout, &inner);
            start_api(&layout, &inner);
            start_assistant(&layout, &inner);
            start_adobe(&layout, &inner);
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
                assistant: ProcessSlot::new("AI assistant", ASSISTANT_ADDRESS).snapshot(),
                adobe: ProcessSlot::new("Adobe gateway", ADOBE_ADDRESS).snapshot(),
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
        stop_owned(&mut inner.assistant);
        stop_owned(&mut inner.adobe);

        // Not a bug and not laziness: an engine may be rendering Program. Closing an Editor
        // window must never stop it, whoever started it.
        if inner.engine.child.is_some() {
            println!("[grapix] leaving the render engine running: Program outlives the Editor");
            inner.engine.child = None;
        }
    }

    #[allow(dead_code)]
    pub fn layout(&self) -> &RuntimeLayout {
        &self.layout
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

fn ensure_engine(layout: &RuntimeLayout, inner: &Arc<Mutex<Inner>>) {
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

    let config = layout
        .workspace_root
        .as_ref()
        .map(|root| root.join("services").join("render-engine").join("engine.toml"));
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
    spawn(inner, |inner| &mut inner.engine, command);
}

fn start_api(layout: &RuntimeLayout, inner: &Arc<Mutex<Inner>>) {
    if api_health() {
        adopt(inner, |inner| &mut inner.api, "already running and healthy on :4100");
        return;
    }
    launch_node_service(
        layout,
        inner,
        |inner| &mut inner.api,
        "grapix-api-server.mjs",
        "@grapix/api-server",
        &[],
    );
}

fn start_assistant(layout: &RuntimeLayout, inner: &Arc<Mutex<Inner>>) {
    if assistant_health() {
        adopt(
            inner,
            |inner| &mut inner.assistant,
            "already running and healthy on :4160",
        );
        return;
    }

    // The assistant spawns the MCP server as a child process. Left to itself it looks for
    // `../../editor-mcp/dist/index.js` relative to its own file — true in the source tree,
    // false in an installed build, where both are flat files in one `services` directory.
    // Without this the assistant starts, reports `MCP error`, and the chat dock is dead.
    let mut extra: Vec<(&str, PathBuf)> = Vec::new();
    if let Some(mcp_entry) = layout.service_entry("grapix-editor-mcp.mjs") {
        extra.push(("GRAPIX_ASSISTANT_MCP_ENTRY", mcp_entry));
    }
    extra.push((
        "GRAPIX_ASSISTANT_DATA_DIR",
        layout.data_root.join("assistant"),
    ));

    // Forwarded by the assistant into the MCP child's environment. Without a root the MCP
    // server cannot locate the corpus and throws on start-up rather than degrading, so an
    // installed build reports `MCP error` and exposes no tools at all.
    if let Some(knowledge) = layout.knowledge_root() {
        extra.push(("GRAPIX_REPOSITORY_ROOT", knowledge));
    }

    launch_node_service(
        layout,
        inner,
        |inner| &mut inner.assistant,
        "grapix-editor-assistant.mjs",
        "@grapix/editor-assistant",
        &extra,
    );
}

fn start_adobe(layout: &RuntimeLayout, inner: &Arc<Mutex<Inner>>) {
    if adobe_health() {
        adopt(
            inner,
            |inner| &mut inner.adobe,
            "already running and healthy on :4784",
        );
        return;
    }
    launch_node_service(
        layout,
        inner,
        |inner| &mut inner.adobe,
        "grapix-adobe-mcp-gateway.mjs",
        "@grapix/adobe-mcp-gateway",
        &[],
    );
}

/// Shared "run this Node bundle" launcher. The only real work of `start_*`.
///
/// Resolves the entry through `RuntimeLayout::service_entry`, sets `cwd` and env, and
/// reports the concrete remedy when the bundle is missing from both `resource_root` and
/// the development tree.
fn launch_node_service(
    layout: &RuntimeLayout,
    inner: &Arc<Mutex<Inner>>,
    select: impl Fn(&mut Inner) -> &mut ProcessSlot + Copy + 'static,
    bundle_name: &str,
    npm_workspace: &str,
    extra_env: &[(&str, PathBuf)],
) {
    let Some(entry) = layout.service_entry(bundle_name) else {
        fail(
            inner,
            select,
            &format!(
                "bundle not found; run `npm run build -w {npm_workspace}` and re-run `tauri build`"
            ),
        );
        return;
    };

    let mut command = Command::new(layout.node_command());
    command.arg(entry).current_dir(&layout.data_root);
    apply_shared_env(&mut command, layout);
    for (key, value) in extra_env {
        command.env(key, value);
    }
    spawn(inner, select, command);
}

/// Environment every launched process shares.
///
/// A packaged installer runs under a standard Windows account, whose write access to
/// `C:\Program Files` is blocked. `GRAPIX_DATA_ROOT` is therefore pinned to the per-user
/// AppData directory — the project service and every downstream writer read this same
/// variable, so one write here keeps disk I/O off `Program Files` everywhere.
fn apply_shared_env(command: &mut Command, layout: &RuntimeLayout) {
    command.env("GRAPIX_DATA_ROOT", &layout.data_root);
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
        let assistant_up = assistant_health();
        let adobe_up = adobe_health();

        let snapshot = {
            let Ok(mut guard) = inner.lock() else { return };
            let within_grace = started.elapsed() < STARTUP_GRACE;
            update(&mut guard.api, api_up, within_grace);
            update(&mut guard.engine, engine_up, within_grace);
            update(&mut guard.assistant, assistant_up, within_grace);
            update(&mut guard.adobe, adobe_up, within_grace);
            guard.snapshot()
        };

        // Emitted only on change: an event every two seconds forever would be noise, and the
        // UI polls the command for its initial state anyway.
        let fingerprint = format!(
            "{:?}/{:?}/{:?}/{:?}/{}",
            snapshot.api.state, snapshot.assistant.state, snapshot.adobe.state, snapshot.engine.state, snapshot.ready
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

fn assistant_health() -> bool {
    http_get(ASSISTANT_ADDRESS, "/assistant/health").is_some_and(|status| status == 200)
}
fn adobe_health() -> bool {
    http_get(ADOBE_ADDRESS, "/health").is_some_and(|status| status == 200)
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
