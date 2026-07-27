use std::collections::VecDeque;
use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const API_ADDRESS: &str = "127.0.0.1:4100";
const DAEMON_ADDRESS: &str = "127.0.0.1:4200";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const FAILURE_THRESHOLD: u32 = 3;
const MAX_RESTARTS_PER_WINDOW: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSnapshot {
    pub api_healthy: bool,
    pub renderer_healthy: bool,
    pub output_healthy: bool,
    pub fallback_active: bool,
    pub fallback_reason: Option<String>,
    pub restart_count: u64,
    pub consecutive_failures: u32,
    pub last_heartbeat_at_ms: Option<u64>,
    pub last_frame_count: Option<u64>,
    pub program_scene_id: Option<String>,
    pub output_state: Option<String>,
    pub renderer_last_error: Option<String>,
    pub gpu_adapter: Option<String>,
    pub gpu_backend: Option<String>,
    pub max_texture_dimension: Option<u64>,
    pub certification_warning: String,
}

impl Default for SupervisorSnapshot {
    fn default() -> Self {
        Self {
            api_healthy: false,
            renderer_healthy: false,
            output_healthy: false,
            fallback_active: false,
            fallback_reason: None,
            restart_count: 0,
            consecutive_failures: 0,
            last_heartbeat_at_ms: None,
            last_frame_count: None,
            program_scene_id: None,
            output_state: None,
            renderer_last_error: None,
            gpu_adapter: None,
            gpu_backend: None,
            max_texture_dimension: None,
            certification_warning:
                "Hardware/output combination has not completed GrapiX certification.".to_string(),
        }
    }
}

#[derive(Clone)]
struct RuntimeRecovery {
    program_scene_id: Option<String>,
    output_config: Option<Value>,
    output_was_running: bool,
}

struct SupervisorInner {
    api_child: Option<Child>,
    daemon_child: Option<Child>,
    snapshot: SupervisorSnapshot,
    recovery: RuntimeRecovery,
    restart_times: VecDeque<Instant>,
    last_observed_frames: Option<u64>,
    stalled_frame_polls: u32,
}

pub struct DesktopSupervisor {
    root: PathBuf,
    inner: Arc<Mutex<SupervisorInner>>,
    shutdown: Arc<AtomicBool>,
}

impl DesktopSupervisor {
    pub fn start(root: PathBuf, app: AppHandle) -> Self {
        let api_child = spawn_api(&root);
        let daemon_child = spawn_daemon(&root);
        let inner = Arc::new(Mutex::new(SupervisorInner {
            api_child,
            daemon_child,
            snapshot: SupervisorSnapshot::default(),
            recovery: RuntimeRecovery {
                program_scene_id: None,
                output_config: None,
                output_was_running: false,
            },
            restart_times: VecDeque::new(),
            last_observed_frames: None,
            stalled_frame_polls: 0,
        }));
        let shutdown = Arc::new(AtomicBool::new(false));

        spawn_watchdog(root.clone(), Arc::clone(&inner), Arc::clone(&shutdown), app);

        Self {
            root,
            inner,
            shutdown,
        }
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.inner
            .lock()
            .map(|inner| inner.snapshot.clone())
            .unwrap_or_else(|_| SupervisorSnapshot {
                fallback_active: true,
                fallback_reason: Some("supervisor state lock was poisoned".to_string()),
                ..SupervisorSnapshot::default()
            })
    }

    pub fn shutdown(&self) {
        if self.shutdown.swap(true, Ordering::Relaxed) {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            stop_child(&mut inner.daemon_child);
            stop_child(&mut inner.api_child);
        }
    }

    #[allow(dead_code)]
    pub fn workspace_root(&self) -> &Path {
        &self.root
    }
}

fn spawn_watchdog(
    root: PathBuf,
    inner: Arc<Mutex<SupervisorInner>>,
    shutdown: Arc<AtomicBool>,
    app: AppHandle,
) {
    std::thread::Builder::new()
        .name("grapix-supervisor".to_string())
        .spawn(move || {
            while !shutdown.load(Ordering::Relaxed) {
                supervise_once(&root, &inner);
                let snapshot = inner
                    .lock()
                    .map(|state| state.snapshot.clone())
                    .unwrap_or_default();
                let _ = app.emit("grapix-supervisor-status", &snapshot);
                std::thread::sleep(POLL_INTERVAL);
            }
        })
        .expect("failed to spawn GrapiX supervisor watchdog");
}

fn supervise_once(root: &Path, shared: &Arc<Mutex<SupervisorInner>>) {
    let api_healthy = http_request("GET", "/health", None)
        .map(|response| response.status == 200)
        .unwrap_or(false);

    if !api_healthy {
        if let Ok(mut inner) = shared.lock() {
            inner.snapshot.api_healthy = false;
            inner.snapshot.renderer_healthy = false;
            inner.snapshot.output_healthy = false;
            inner.snapshot.consecutive_failures =
                inner.snapshot.consecutive_failures.saturating_add(1);
            if inner.snapshot.consecutive_failures >= FAILURE_THRESHOLD
                && (inner.api_child.is_some() || !port_open(API_ADDRESS))
            {
                stop_child(&mut inner.api_child);
                inner.api_child = spawn_api(root);
                inner.snapshot.fallback_active = true;
                inner.snapshot.fallback_reason =
                    Some("project service unavailable; restart requested".to_string());
            }
        }
        return;
    }

    let renderer_response = http_request("GET", "/api/render-daemon/status", None);
    let renderer_status = renderer_response
        .as_ref()
        .ok()
        .filter(|response| response.status == 200)
        .and_then(|response| serde_json::from_str::<Value>(&response.body).ok());

    let mut should_restart = false;
    if let Ok(mut inner) = shared.lock() {
        inner.snapshot.api_healthy = true;
        match renderer_status {
            Some(status) => {
                // Fastify wraps daemon replies as { ok, reply }. Accept a raw
                // status too so the watchdog remains compatible with direct
                // diagnostic fixtures.
                let status = status.get("reply").unwrap_or(&status);
                let frames = status
                    .pointer("/output/framesRendered")
                    .and_then(Value::as_u64);
                let output_state = status
                    .pointer("/output/state")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let output_running = output_state.as_deref() == Some("running");

                if output_running && frames == inner.last_observed_frames {
                    inner.stalled_frame_polls = inner.stalled_frame_polls.saturating_add(1);
                } else {
                    inner.stalled_frame_polls = 0;
                }
                inner.last_observed_frames = frames;

                inner.snapshot.renderer_healthy = true;
                inner.snapshot.output_healthy = !output_running
                    || (inner.stalled_frame_polls < FAILURE_THRESHOLD
                        && status
                            .pointer("/output/lastError")
                            .and_then(Value::as_str)
                            .is_none());
                inner.snapshot.last_heartbeat_at_ms = Some(now_epoch_ms());
                inner.snapshot.last_frame_count = frames;
                inner.snapshot.program_scene_id = status
                    .get("programSceneId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                inner.snapshot.output_state = output_state;
                inner.snapshot.renderer_last_error = status
                    .pointer("/output/lastError")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                inner.snapshot.gpu_adapter = status
                    .pointer("/gpu/adapter")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                inner.snapshot.gpu_backend = status
                    .pointer("/gpu/backend")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                inner.snapshot.max_texture_dimension = status
                    .pointer("/gpu/maxTextureDimension2d")
                    .and_then(Value::as_u64);
                inner.snapshot.consecutive_failures = 0;

                inner.recovery = RuntimeRecovery {
                    program_scene_id: inner.snapshot.program_scene_id.clone(),
                    output_config: status.pointer("/output/config").cloned(),
                    output_was_running: output_running,
                };

                if inner.stalled_frame_polls >= FAILURE_THRESHOLD {
                    inner.snapshot.fallback_active = true;
                    inner.snapshot.fallback_reason =
                        Some("Program frame counter stopped advancing".to_string());
                    should_restart = true;
                } else {
                    inner.snapshot.fallback_active = false;
                    inner.snapshot.fallback_reason = None;
                }
            }
            None => {
                inner.snapshot.renderer_healthy = false;
                inner.snapshot.output_healthy = false;
                inner.snapshot.consecutive_failures =
                    inner.snapshot.consecutive_failures.saturating_add(1);
                should_restart = inner.snapshot.consecutive_failures >= FAILURE_THRESHOLD;
                if should_restart {
                    inner.snapshot.fallback_active = true;
                    inner.snapshot.fallback_reason = Some("renderer heartbeat failed".to_string());
                }
            }
        }
    }

    if should_restart {
        restart_renderer(root, shared);
    }
}

fn restart_renderer(root: &Path, shared: &Arc<Mutex<SupervisorInner>>) {
    let recovery = {
        let Ok(mut inner) = shared.lock() else {
            return;
        };
        let now = Instant::now();
        while inner
            .restart_times
            .front()
            .is_some_and(|started| now.duration_since(*started) > RESTART_WINDOW)
        {
            inner.restart_times.pop_front();
        }
        if inner.restart_times.len() >= MAX_RESTARTS_PER_WINDOW {
            inner.snapshot.fallback_active = true;
            inner.snapshot.fallback_reason = Some(format!(
                "renderer restart limit reached ({MAX_RESTARTS_PER_WINDOW} per {}s)",
                RESTART_WINDOW.as_secs()
            ));
            return;
        }
        inner.restart_times.push_back(now);
        inner.snapshot.restart_count = inner.snapshot.restart_count.saturating_add(1);
        stop_child(&mut inner.daemon_child);
        inner.recovery.clone()
    };

    wait_for_port_to_close(DAEMON_ADDRESS, Duration::from_secs(2));
    let new_child = spawn_daemon(root);
    if let Ok(mut inner) = shared.lock() {
        inner.daemon_child = new_child;
    }

    if !wait_for_renderer_health(Duration::from_secs(15)) {
        if let Ok(mut inner) = shared.lock() {
            inner.snapshot.fallback_active = true;
            inner.snapshot.fallback_reason =
                Some("renderer did not recover after restart".to_string());
        }
        return;
    }

    let restored = restore_runtime(&recovery);
    if let Ok(mut inner) = shared.lock() {
        inner.snapshot.renderer_healthy = true;
        inner.snapshot.consecutive_failures = 0;
        inner.stalled_frame_polls = 0;
        inner.snapshot.fallback_active = !restored;
        inner.snapshot.fallback_reason = if restored {
            None
        } else {
            Some("renderer restarted but Program restoration failed".to_string())
        };
    }
}

fn restore_runtime(recovery: &RuntimeRecovery) -> bool {
    let fallback_scene = env::var("GRAPIX_SAFE_FALLBACK_SCENE_ID").ok();
    let scene_id = recovery
        .program_scene_id
        .as_deref()
        .or(fallback_scene.as_deref());

    if let Some(scene_id) = scene_id {
        if !is_safe_scene_id(scene_id)
            || http_request(
                "POST",
                &format!("/api/render-daemon/scenes/{scene_id}/take"),
                Some("{}"),
            )
            .map(|response| response.status != 200)
            .unwrap_or(true)
        {
            return false;
        }
    }

    if let Some(config) = recovery.output_config.as_ref() {
        let configure = json!({
            "width": config.get("width"),
            "height": config.get("height"),
            "frameRateNumerator": config.pointer("/frameRate/numerator"),
            "frameRateDenominator": config.pointer("/frameRate/denominator"),
            "scanMode": config.get("scanMode"),
            "alphaMode": config.get("alphaMode"),
            "colorFormat": config.get("colorFormat"),
            "colorSpace": config.get("colorSpace"),
            "ndiSourceName": config.get("ndiSourceName"),
            "recordingName": config.get("recordingName"),
            "backend": config.get("backend")
        });
        if http_request(
            "POST",
            "/api/render-daemon/output/configure",
            Some(&configure.to_string()),
        )
        .map(|response| response.status != 200)
        .unwrap_or(true)
        {
            return false;
        }
    }

    if recovery.output_was_running {
        return http_request("POST", "/api/render-daemon/output/start", Some("{}"))
            .map(|response| response.status == 200)
            .unwrap_or(false);
    }
    true
}

fn spawn_api(root: &Path) -> Option<Child> {
    if port_open(API_ADDRESS) {
        println!("[grapix] API already online on :4100 — reusing it");
        return None;
    }
    let api_entry = root
        .join("services")
        .join("api-server")
        .join("dist")
        .join("index.js");
    if !api_entry.exists() {
        eprintln!(
            "[grapix] API entry not found at {api_entry:?}; run `npm run build -w @grapix/api-server`"
        );
        return None;
    }
    spawn_command(Command::new("node").arg(api_entry).current_dir(root), "API")
}

fn spawn_daemon(root: &Path) -> Option<Child> {
    if port_open(DAEMON_ADDRESS) {
        println!("[grapix] render daemon already online on :4200 — reusing it");
        return None;
    }

    let configured = env::var_os("GRAPIX_RENDER_DAEMON_BIN").map(PathBuf::from);
    let debug_binary = root
        .join("services")
        .join("render-daemon")
        .join("target")
        .join("debug")
        .join(binary_name("grapix-render-daemon"));
    let release_binary = root
        .join("services")
        .join("render-daemon")
        .join("target")
        .join("release")
        .join(binary_name("grapix-render-daemon"));
    let adjacent_binary = env::current_exe().ok().and_then(|path| {
        path.parent()
            .map(|parent| parent.join(binary_name("grapix-render-daemon")))
    });
    let executable = configured
        .filter(|path| path.is_file())
        .or_else(|| adjacent_binary.filter(|path| path.is_file()))
        .or_else(|| debug_binary.is_file().then_some(debug_binary))
        .or_else(|| release_binary.is_file().then_some(release_binary));

    let Some(executable) = executable else {
        eprintln!(
            "[grapix] render daemon binary not found; run `cargo build --manifest-path services/render-daemon/Cargo.toml` or set GRAPIX_RENDER_DAEMON_BIN"
        );
        return None;
    };

    spawn_command(Command::new(executable).current_dir(root), "render daemon")
}

fn spawn_command(command: &mut Command, label: &str) -> Option<Child> {
    match command.spawn() {
        Ok(child) => {
            println!("[grapix] {label} started (pid {})", child.id());
            Some(child)
        }
        Err(error) => {
            eprintln!("[grapix] failed to start {label}: {error}");
            None
        }
    }
}

fn stop_child(child: &mut Option<Child>) {
    if let Some(mut process) = child.take() {
        let _ = process.kill();
        let _ = process.wait();
    }
}

fn wait_for_port_to_close(address: &str, timeout: Duration) {
    let started = Instant::now();
    while started.elapsed() < timeout && port_open(address) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn wait_for_renderer_health(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if http_request("GET", "/api/render-daemon/heartbeat", None)
            .map(|response| response.status == 200)
            .unwrap_or(false)
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn port_open(address: &str) -> bool {
    address
        .parse::<SocketAddr>()
        .ok()
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_millis(300)).ok())
        .is_some()
}

struct HttpResponse {
    status: u16,
    body: String,
}

fn http_request(method: &str, path: &str, body: Option<&str>) -> Result<HttpResponse, String> {
    let address: SocketAddr = API_ADDRESS
        .parse()
        .map_err(|error| format!("invalid API address: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(750))
        .map_err(|error| format!("API connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:4100\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    parse_http_response(&response)
}

fn parse_http_response(raw: &str) -> Result<HttpResponse, String> {
    let (headers, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "HTTP response has no status".to_string())?;
    Ok(HttpResponse {
        status,
        body: body.to_string(),
    })
}

fn is_safe_scene_id(scene_id: &str) -> bool {
    !scene_id.is_empty()
        && scene_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn binary_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_http_response() {
        let response =
            parse_http_response("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}")
                .expect("response must parse");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "{\"ok\":true}");
    }

    #[test]
    fn scene_ids_used_in_recovery_cannot_escape_the_route() {
        assert!(is_safe_scene_id("lower_third-01"));
        assert!(!is_safe_scene_id("../secrets"));
        assert!(!is_safe_scene_id("scene/name"));
        assert!(!is_safe_scene_id(""));
    }
}
