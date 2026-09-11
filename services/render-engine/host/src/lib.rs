//! gx-engine-host
//!
//! Persistent supervisor for the render worker (ADR B.4: "Program continues.
//! Engine outlives both UIs").
//!
//! **Status: Partial.** The ensure/adopt policy and the bounded-restart
//! decision are real and unit-tested. The WAL journal and output-inhibited
//! restore named in the crate README are **Planned** — they need the engine
//! to expose a mutation journal, which it does not yet. Nothing here claims
//! otherwise.
//!
//! The one rule this module exists to enforce: **the host ensures an engine,
//! it never stops one.** An engine it started itself is adopted on the next
//! run exactly like a stranger's, because Program belongs to the machine, not
//! to whichever shell happened to launch the process. A `Drop` that kills the
//! child would be a bug, not a convenience.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::{Child, Command};
use std::time::Duration;

use gx_control_plane::peer::EnginePeer;
use gx_control_plane::status::EngineStatus;
use gx_control_transport::Client;

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
pub fn ensure(worker_program: &str, port: u16, spawn_args: &[String]) -> io::Result<Supervised> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);

    // Adopt: something is already answering the capability exchange here.
    if let Ok(client) = Client::connect(addr) {
        return Ok(Supervised {
            client,
            provenance: Provenance::Adopted,
            child: None,
        });
    }

    // Nothing there: start one, then adopt the child we just made.
    //
    // The worker is told which port to bind: `ensure` is asked to supervise
    // `port`, so it — not the caller — is responsible for the worker ending up
    // there. Passing the port only through `spawn_args` would let a caller ask
    // for one port and spawn on another, and the supervise-then-adopt below
    // would then wait on a port nothing is listening to.
    let mut command = Command::new(worker_program);
    command.arg("--port").arg(port.to_string()).args(spawn_args);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn()?;

    match wait_for_engine(addr, Duration::from_secs(10)) {
        Ok(client) => Ok(Supervised {
            client,
            provenance: Provenance::Spawned,
            child: Some(child),
        }),
        Err(e) => {
            // Capture why the child never answered: a bind refusal or a slow
            // start is actionable, a bare "did not start" is not.
            use std::io::Read;
            let detail = match child.try_wait().ok().flatten() {
                Some(status) => {
                    let mut err = String::new();
                    if let Some(mut p) = child.stderr.take() {
                        let _ = p.read_to_string(&mut err);
                    }
                    format!("worker exited {status}: {err}")
                }
                None => {
                    // Still running but unreachable: kill it so the diagnostic
                    // does not leak a process, then read what it printed.
                    let _ = child.kill();
                    let mut err = String::new();
                    if let Some(mut p) = child.stderr.take() {
                        let _ = p.read_to_string(&mut err);
                    }
                    let mut out = String::new();
                    if let Some(mut p) = child.stdout.take() {
                        let _ = p.read_to_string(&mut out);
                    }
                    format!("{e}; worker still running, killed. stdout: {out} stderr: {err}")
                }
            };
            Err(io::Error::new(e.kind(), detail))
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
