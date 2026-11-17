//! 2.21: the shipped `gx-render-worker` listens where `--bind` says, and only where
//! the one bind policy allows.
//!
//! Real engine processes. The control plane may leave loopback only with a token;
//! the asset plane verifies no credential yet, so it stays on loopback whatever
//! `--bind` says, and it asks the same policy about reserved ports as the control
//! plane does. A refusal names the plane and the reason, in the process's own log.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use gx_contracts::auth::{Role, Scope};
use gx_contracts::endpoints::is_loopback;
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_transport::{Client, Token};

/// The engine's secret for one test, fresh from the system's randomness each
/// time. These tests listen on a network address for a few seconds, and a
/// secret written in the repository is one anybody on that network holds.
fn fresh_secret() -> String {
    use std::hash::BuildHasher;
    (0..3u8)
        .map(|n| {
            format!(
                "{:016x}",
                std::collections::hash_map::RandomState::new().hash_one(n)
            )
        })
        .collect()
}

fn scratch() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gx-worker-bind-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn records(directory: &Path) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<serde_json::Value>>()
        })
        .collect()
}

/// A running engine that is killed when it goes out of scope, so a failed
/// assertion never leaves one running.
struct Engine(Child);

impl Engine {
    /// Wait for the process to end by itself, up to a minute.
    fn exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = self.0.try_wait().expect("the process can be polled") {
                return status;
            }
            assert!(Instant::now() < deadline, "the engine did not end");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(dir: &Path, arguments: &[&str]) -> Engine {
    Engine(
        Command::new(env!("CARGO_BIN_EXE_gx-render-worker"))
            .args(arguments)
            .arg("--recovery-journal")
            .arg(dir.join("journal.json"))
            .env("GX_LOG_DIR", dir.join("logs"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the worker starts"),
    )
}

fn logged(dir: &Path) -> Vec<serde_json::Value> {
    records(&dir.join("logs").join("engine"))
}

/// The one record named `event`, waited for.
fn wait_for(dir: &Path, event: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let found = logged(dir);
        if let Some(record) = found.iter().find(|r| r["event"] == event) {
            return record.clone();
        }
        assert!(Instant::now() < deadline, "no {event} in {found:#?}");
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn address(record: &serde_json::Value, field: &str) -> SocketAddr {
    record["fields"][field]
        .as_str()
        .and_then(|a| a.parse().ok())
        .unwrap_or_else(|| panic!("{field} in {record}"))
}

#[test]
fn off_loopback_without_a_token_the_control_plane_refuses_by_name_and_nothing_listens() {
    let dir = scratch();
    let mut engine = start(
        &dir,
        &["--bind", "0.0.0.0", "--port", "0", "--asset-port", "0"],
    );
    let failed = wait_for(&dir, "engine.bind_failed");
    let said = failed.to_string();
    assert!(
        said.contains("non-loopback control plane requires a token"),
        "{said}"
    );
    assert_eq!(
        engine.exit().code(),
        Some(1),
        "the engine ends, it does not run unprotected"
    );
    assert!(
        !logged(&dir).iter().any(|r| r["event"] == "engine.start"),
        "it never reported that it started"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn with_a_token_the_control_plane_leaves_loopback_and_the_asset_plane_does_not() {
    let dir = scratch();
    let secret = fresh_secret();
    let _engine = start(
        &dir,
        &[
            "--bind",
            "0.0.0.0",
            "--port",
            "0",
            "--asset-port",
            "0",
            "--token",
            &secret,
        ],
    );
    let started = wait_for(&dir, "engine.start");
    let control = address(&started, "control");
    let assets = address(&started, "assets");
    assert!(
        !is_loopback(control.ip()),
        "the control plane listens off loopback: {control}"
    );
    assert!(
        is_loopback(assets.ip()),
        "the asset plane verifies no credential, so it stays on loopback: {assets}"
    );
    assert_eq!(started["fields"]["bind"], "0.0.0.0", "{started}");

    // The listener answers a client holding a credential for the same secret.
    let reach = SocketAddr::new(IpAddr::from([127, 0, 0, 1]), control.port());
    let token = Token::mint("bind-test", Role::Playout, vec![Scope::Cue], &secret)
        .expect("a credential is minted");
    let mut client =
        Client::connect_with_token(reach, token).expect("a credential for the secret connects");
    let reply = client.request(ClientRequest::Status).expect("a reply");
    assert!(matches!(reply, EngineReply::Status(_)), "{reply:?}");
    let _ = std::fs::remove_dir_all(dir);
}

/// This machine's own address on a network, if it has one: the local address
/// the system would send from. Nothing is sent (a UDP socket is only given a
/// destination), and the destination is a documentation address (TEST-NET-1).
fn own_network_address() -> Option<IpAddr> {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    probe.connect("192.0.2.1:9").ok()?;
    let ip = probe.local_addr().ok()?.ip();
    (!is_loopback(ip) && !ip.is_unspecified()).then_some(ip)
}

fn refuses_a_connection(addr: SocketAddr) -> bool {
    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_err()
}

/// The engine is reached over the interface `--bind` names, and only there: the
/// control plane answers on this machine's own network address and not on
/// loopback, and the asset plane does not answer on the network address at all.
#[test]
fn an_engine_bound_to_this_machines_address_is_reached_over_it_and_only_control() {
    let Some(own) = own_network_address() else {
        // No silent pass: say so. The 0.0.0.0 test above still runs.
        eprintln!("NOT RUN: this machine has no network address to bind");
        return;
    };
    let dir = scratch();
    let secret = fresh_secret();
    let bind = own.to_string();
    let _engine = start(
        &dir,
        &[
            "--bind",
            &bind,
            "--port",
            "0",
            "--asset-port",
            "0",
            "--token",
            &secret,
        ],
    );
    let started = wait_for(&dir, "engine.start");
    let control = address(&started, "control");
    let assets = address(&started, "assets");
    assert_eq!(
        control.ip(),
        own,
        "the control plane is on the named interface"
    );
    assert!(
        is_loopback(assets.ip()),
        "the asset plane stays on loopback: {assets}"
    );

    // Reached over the network address, with a credential for the secret.
    let token = Token::mint("bind-reach", Role::Playout, vec![Scope::Cue], &secret)
        .expect("a credential is minted");
    let mut client = Client::connect_with_token(control, token)
        .expect("the engine answers on the interface it was bound to");
    let reply = client.request(ClientRequest::Status).expect("a reply");
    assert!(matches!(reply, EngineReply::Status(_)), "{reply:?}");

    // Only there: not on loopback, which --bind did not name.
    assert!(
        refuses_a_connection(SocketAddr::new(
            IpAddr::from([127, 0, 0, 1]),
            control.port()
        )),
        "a control plane bound to {own} must not also answer on loopback"
    );
    // And only control: the asset plane does not answer on the network address.
    assert!(
        refuses_a_connection(SocketAddr::new(own, assets.port())),
        "the asset plane must not be reachable over {own}"
    );
    // It does answer where it listens.
    assert!(
        !refuses_a_connection(assets),
        "the asset plane answers on loopback: {assets}"
    );
    eprintln!("RAN: bound and reached over this machine's own network address");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn by_default_both_planes_listen_on_loopback() {
    let dir = scratch();
    let _engine = start(&dir, &["--port", "0", "--asset-port", "0"]);
    let started = wait_for(&dir, "engine.start");
    assert!(is_loopback(address(&started, "control").ip()), "{started}");
    assert!(is_loopback(address(&started, "assets").ip()), "{started}");
    assert_eq!(started["fields"]["bind"], "127.0.0.1", "{started}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_asset_plane_is_refused_a_reserved_port_by_name() {
    let dir = scratch();
    let mut engine = start(&dir, &["--port", "0", "--asset-port", "4100"]);
    let failed = wait_for(&dir, "engine.bind_failed");
    let said = failed.to_string();
    assert!(
        said.contains("asset plane") && said.contains("4100 is reserved"),
        "{said}"
    );
    assert_eq!(engine.exit().code(), Some(1));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_bind_that_is_not_an_address_is_a_usage_error() {
    let dir = scratch();
    let mut engine = start(&dir, &["--bind", "the-lan", "--port", "0"]);
    assert_eq!(engine.exit().code(), Some(2));
    assert!(
        !logged(&dir).iter().any(|r| r["event"] == "engine.start"),
        "it never started"
    );
    let _ = std::fs::remove_dir_all(dir);
}
