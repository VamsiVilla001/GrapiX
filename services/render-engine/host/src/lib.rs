//! gx-engine-host
//!
//! Persistent supervisor for the render worker (ADR B.4: "Program continues.
//! Engine outlives both UIs").
//!
//! The host gives every worker a recovery-journal path under the platform
//! service data root. A worker restores that durable state, advances its
//! incarnation epoch, and inhibits outputs before it accepts control traffic.
//! The host never silently substitutes a repository-relative journal: being
//! unable to name the platform root is a named supervisor error.
//!
//! The one rule this module exists to enforce: **the host ensures an engine,
//! it never stops one.** An engine it started itself is adopted on the next
//! run exactly like a stranger's, because Program belongs to the machine, not
//! to whichever shell happened to launch the process. A `Drop` that kills the
//! child would be a bug, not a convenience.

use std::error::Error;
use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

use gx_contracts::platform::service_data_root;
use gx_contracts::Refusal;
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::status::EngineStatus;
use gx_control_transport::Client;

/// The supervisor's named startup failures. A recovery journal that cannot be
/// located or a worker that cannot restore it must fail closed, not be
/// replaced with an empty, potentially live engine.
#[derive(Debug)]
pub enum SupervisorError {
    DataRoot(Refusal),
    ReservedSpawnArgument { argument: &'static str },
    Spawn { program: String, source: io::Error },
    WorkerUnavailable { source: io::Error, detail: String },
}

impl fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DataRoot(refusal) => write!(f, "cannot locate service data root: {refusal}"),
            Self::ReservedSpawnArgument { argument } => {
                write!(f, "{argument} is owned by the engine supervisor")
            }
            Self::Spawn { program, source } => write!(f, "cannot spawn {program}: {source}"),
            Self::WorkerUnavailable { detail, .. } => f.write_str(detail),
        }
    }
}

impl Error for SupervisorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::DataRoot(refusal) => Some(refusal),
            Self::Spawn { source, .. } | Self::WorkerUnavailable { source, .. } => Some(source),
            Self::ReservedSpawnArgument { .. } => None,
        }
    }
}

/// The standard recovery journal path. This is intentionally below the
/// platform-owned service root, never a launch directory or repository path.
pub fn recovery_journal_path() -> Result<PathBuf, SupervisorError> {
    service_data_root()
        .map(|root| root.join("render-engine").join("recovery.json"))
        .map_err(SupervisorError::DataRoot)
}

/// How a running engine came to be under this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// Already listening when the host looked. Never stopped by this host.
    Adopted,
    /// Spawned by this host. Still never stopped on shutdown: a restart of
    /// the host must not take Program down with it.
    Spawned,
}

/// A live engine under supervision.
pub struct Supervised {
    client: Client,
    provenance: Provenance,
    /// Kept so the process is not reaped as a zombie while the host lives.
    /// Deliberately never read: the whole point is that nothing may kill it.
    #[allow(dead_code)]
    child: Option<Child>,
}

impl Supervised {
    pub fn provenance(&self) -> Provenance {
        self.provenance
    }

    /// The engine's reported status, asked the way any client would.
    pub fn status(&mut self) -> Option<EngineStatus> {
        self.client.status()
    }
}

// No `Drop` impl that terminates `child`. That absence is the feature: the
// host outlives its own lifetime only by *not* owning the engine's.

/// Ensure an engine is reachable, adopting one that is and spawning one that
/// is not.
///
/// Adopt-first is the whole point. A second host, or a host restarted after a
/// crash, must find the engine that is already putting out Program and leave
/// it alone — starting a second one would contend for the GPU and the control
/// port for no reason.
pub fn ensure(
    worker_program: &str,
    port: u16,
    spawn_args: &[String],
) -> Result<Supervised, SupervisorError> {
    let journal = recovery_journal_path()?;
    ensure_with_journal(worker_program, port, spawn_args, &journal)
}

/// Ensure an engine using one platform-rooted journal path. This exists for
/// process-death verification and for a future multi-instance supervisor; the
/// normal host always uses [`recovery_journal_path`].
pub fn ensure_with_journal(
    worker_program: &str,
    port: u16,
    spawn_args: &[String],
    journal: &Path,
) -> Result<Supervised, SupervisorError> {
    if spawn_args.iter().any(|arg| arg == "--port") {
        return Err(SupervisorError::ReservedSpawnArgument { argument: "--port" });
    }
    if spawn_args.iter().any(|arg| arg == "--recovery-journal") {
        return Err(SupervisorError::ReservedSpawnArgument {
            argument: "--recovery-journal",
        });
    }

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);

    // Adopt: something is already answering the capability exchange here.
    if let Ok(client) = Client::connect(addr) {
        return Ok(Supervised {
            client,
            provenance: Provenance::Adopted,
            child: None,
        });
    }

    // Nothing there: start one, then adopt the child we just made. Both the
    // port and journal are supervisor-owned so a caller cannot make it wait on
    // one worker while spawning another with an unjournaled recovery path.
    let mut command = Command::new(worker_program);
    command
        .arg("--port")
        .arg(port.to_string())
        .arg("--recovery-journal")
        .arg(journal)
        .args(spawn_args);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|source| SupervisorError::Spawn {
        program: worker_program.to_owned(),
        source,
    })?;

    match wait_for_engine(addr, Duration::from_secs(10)) {
        Ok(client) => Ok(Supervised {
            client,
            provenance: Provenance::Spawned,
            child: Some(child),
        }),
        Err(source) => {
            // Capture why the child never answered: a bind refusal or a safe
            // recovery refusal is actionable, while "did not start" is not.
            use std::io::Read;
            let detail = match child.try_wait().ok().flatten() {
                Some(status) => {
                    let mut err = String::new();
                    if let Some(mut pipe) = child.stderr.take() {
                        let _ = pipe.read_to_string(&mut err);
                    }
                    format!("worker exited {status}: {err}")
                }
                None => {
                    // Still running but unreachable: terminate this failed
                    // spawn so the diagnostic does not leak a process.
                    let _ = child.kill();
                    let mut err = String::new();
                    if let Some(mut pipe) = child.stderr.take() {
                        let _ = pipe.read_to_string(&mut err);
                    }
                    let mut out = String::new();
                    if let Some(mut pipe) = child.stdout.take() {
                        let _ = pipe.read_to_string(&mut out);
                    }
                    format!("{source}; worker still running, killed. stdout: {out} stderr: {err}")
                }
            };
            Err(SupervisorError::WorkerUnavailable { source, detail })
        }
    }
}

/// The restart policy: bounded backoff, and a hard stop after too many.
///
/// Restarting forever hides a worker that cannot come up; refusing to restart
/// at all takes Program down over a transient fault. The bound makes the
/// failure visible instead of either silent.
#[derive(Debug, Clone, Copy)]
pub struct RestartPolicy {
    /// Longest back-off between attempts.
    pub max_backoff: Duration,
    /// Attempts allowed before the supervisor gives up and reports.
    pub max_attempts: u32,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_backoff: Duration::from_secs(30),
            max_attempts: 5,
        }
    }
}

impl RestartPolicy {
    /// The delay before attempt `n` (1-based), doubling to a ceiling.
    pub fn backoff(&self, attempt: u32) -> Duration {
        let shift = attempt.saturating_sub(1).min(10);
        let base = Duration::from_millis(250) * 2u32.saturating_pow(shift);
        base.min(self.max_backoff)
    }

    /// Whether another restart may be attempted after `failures`.
    pub fn should_restart(&self, failures: u32) -> bool {
        failures < self.max_attempts
    }
}

/// Poll until the engine answers or the deadline passes.
fn wait_for_engine(addr: SocketAddr, within: Duration) -> io::Result<Client> {
    let deadline = std::time::Instant::now() + within;
    let mut last_err = None;
    while std::time::Instant::now() < deadline {
        match Client::connect(addr) {
            Ok(client) => return Ok(client),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "engine did not start")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_a_ceiling() {
        let policy = RestartPolicy::default();
        assert_eq!(policy.backoff(1), Duration::from_millis(250));
        assert_eq!(policy.backoff(2), Duration::from_millis(500));
        assert_eq!(policy.backoff(3), Duration::from_millis(1000));
        // Clamps at max_backoff rather than growing without bound.
        assert_eq!(policy.backoff(20), Duration::from_secs(30));
    }

    #[test]
    fn restarts_are_bounded() {
        let policy = RestartPolicy::default();
        assert!(policy.should_restart(0));
        assert!(policy.should_restart(4));
        assert!(
            !policy.should_restart(5),
            "after max_attempts the supervisor reports instead of spinning"
        );
    }
}
