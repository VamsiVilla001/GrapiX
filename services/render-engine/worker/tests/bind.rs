//! 2.21: the shipped `gx-render-worker` listens where `--bind` says, and only where
//! the one bind policy allows.
//!
//! Real engine processes. The control plane may leave loopback only with a token. So may the
//! asset plane since 2.24, which verifies the same gx1 credential on every connection's first
//! frame; without a token it stays on loopback whatever `--bind` says. Both ask the same policy
//! about reserved ports. A refusal names the plane and the reason, in the process's own log.

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
fn with_a_token_both_planes_leave_loopback_and_the_asset_plane_verifies_credentials() {
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
        !is_loopback(assets.ip()),
        "with a token the asset plane follows --bind too: {assets}"
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

    // The asset plane verifies the same credential (2.24), over loopback to the port it listens on.
    let asset_reach = SocketAddr::new(IpAddr::from([127, 0, 0, 1]), assets.port());
    let refused_as = |reply: gx_asset_plane::LocalityReply| match reply {
        gx_asset_plane::LocalityReply::Refused(gx_asset_plane::PublishRefusal::AuthRefused {
            cause,
        }) => Some(cause),
        _ => None,
    };
    let none = gx_asset_plane::declared_locality(asset_reach).expect("a reply");
    assert_eq!(
        refused_as(none),
        Some(gx_contracts::Refusal::Unauthenticated),
        "no credential"
    );
    let other = Token::mint(
        "intruder",
        Role::Editor,
        vec![Scope::Author],
        "another-secret-0123456789abcdefghij",
    )
    .expect("a credential is minted");
    {
        let _credential = gx_asset_plane::auth::enter(other.as_str());
        let reply = gx_asset_plane::declared_locality(asset_reach).expect("a reply");
        assert_eq!(
            refused_as(reply),
            Some(gx_contracts::Refusal::Unauthenticated),
            "a credential made with another secret"
        );
    }
    let author = Token::mint("editor-1", Role::Editor, vec![Scope::Author], &secret)
        .expect("a credential is minted");
    {
        let _credential = gx_asset_plane::auth::enter(author.as_str());
        let reply = gx_asset_plane::declared_locality(asset_reach).expect("a reply");
        assert!(
            matches!(reply, gx_asset_plane::LocalityReply::Declared { .. }),
            "{reply:?}"
        );
    }
    // A Playout credential holds no Author scope: it may read locality and publish nothing.
    let playout = Token::mint("desk-1", Role::Playout, vec![Scope::Cue], &secret)
        .expect("a credential is minted");
    {
        let _credential = gx_asset_plane::auth::enter(playout.as_str());
        let scene: gx_contracts::scene::SceneDocument = serde_json::from_value(serde_json::json!({
            "version": gx_contracts::scene::SCENE_SCHEMA_VERSION,
            "id": "draft", "name": "draft", "workingColorSpace": "linear-srgb", "colorDepth": "32",
            "canvas": { "width": 4, "height": 2, "frameRate": { "num": 50, "den": 1 } },
            "timeline": { "durationFrames": 10, "channels": [] },
            "objects": []
        }))
        .expect("a minimal scene parses");
        match gx_asset_plane::publish_scene(asset_reach, scene).expect("a reply") {
            gx_asset_plane::PublishReply::Refused(
                gx_asset_plane::PublishRefusal::AuthRefused {
                    cause: gx_contracts::Refusal::ScopeNotGranted { required, .. },
                },
            ) => assert_eq!(required, Some(Scope::Author)),
            other => panic!("a Playout credential published: {other:?}"),
        }
    }
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

/// The engine is reached over the interface `--bind` names, and only there: both planes answer on
/// this machine's own network address (the asset plane since 2.24, with the token) and neither
/// answers on loopback.
#[test]
fn an_engine_bound_to_this_machines_address_is_reached_over_it_on_both_planes() {
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
    assert_eq!(
        assets.ip(),
        own,
        "with a token the asset plane is on the named interface too"
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
    // The asset plane is on the same interface and not on loopback either.
    assert!(
        refuses_a_connection(SocketAddr::new(IpAddr::from([127, 0, 0, 1]), assets.port())),
        "an asset plane bound to {own} must not also answer on loopback"
    );
    // It answers where it listens.
    assert!(
        !refuses_a_connection(assets),
        "the asset plane answers on the named interface: {assets}"
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

/// 12.11: the shipped engine writes the as-run record. A take of something never published is
/// refused by the engine, and that refusal is one record, naming who sent it, in a chain that
/// verifies.
#[test]
fn the_engine_writes_an_as_run_record_for_a_program_command() {
    use gx_contracts::auth::OperatorName;
    use gx_contracts::{ContentHash, Revision, TakeId};
    use gx_control_plane::intent::{TakeAt, TakeRequest};

    let dir = scratch();
    let secret = fresh_secret();
    let _engine = start(
        &dir,
        &["--port", "0", "--asset-port", "0", "--token", &secret],
    );
    let started = wait_for(&dir, "engine.start");
    let control = address(&started, "control");
    let token = Token::mint("as-run-test", Role::Playout, vec![Scope::Take], &secret)
        .expect("a credential is minted");
    let mut client = Client::connect_with_token(control, token).expect("connects");
    client.set_operator(Some(&OperatorName::parse("Ada Lovelace").unwrap()));
    let reply = client
        .request(ClientRequest::Take(TakeRequest {
            take_id: TakeId("never-published".into()),
            revision: Revision(1),
            content_hash: Some(ContentHash("a".repeat(64))),
            at: TakeAt::NextOpportunity,
        }))
        .expect("a reply");
    assert!(matches!(reply, EngineReply::Refused(_)), "{reply:?}");

    let as_run = dir.join("logs").join("as-run");
    let file = std::fs::read_dir(&as_run)
        .expect("the as-run directory exists")
        .flatten()
        .next()
        .expect("one as-run file")
        .path();
    let text = std::fs::read_to_string(&file).unwrap();
    let record: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(record["request"], "take");
    assert_eq!(record["operator"], "Ada Lovelace");
    assert_eq!(record["subject"], "as-run-test");
    assert_eq!(record["result"], "refused");
    assert_eq!(record["page"], "never-published");
    assert_eq!(gx_control_transport::verify_as_run(&file), Ok(1));
    assert!(!text.contains(&secret), "the secret is never written");
    let _ = std::fs::remove_dir_all(dir);
}
