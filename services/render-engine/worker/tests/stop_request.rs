//! 2.19: the shipped `gx-render-worker` stops in order when a client holding the
//! `stop` scope asks it to over the control plane.
//!
//! A real engine process, a real control connection with a real credential. A
//! credential without the scope is refused by name and the engine keeps running;
//! one with it gets `Stopping`, and the engine then writes `engine.stop` (naming
//! the request and carrying its correlation id), `log.stop`, and exits 0. The
//! transport's own record of who asked carries the same id.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use gx_contracts::auth::{Role, Scope};
use gx_contracts::Refusal;
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_transport::{Client, Token};

const SECRET: &str = "stop-request-secret-0123456789abcdef";

fn scratch() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("gx-worker-log-stop-{}-{nanos}", std::process::id()));
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

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn credential(subject: &str, scopes: Vec<Scope>) -> Token {
    Token::mint(subject, Role::Playout, scopes, SECRET).expect("a credential is minted")
}

#[test]
fn a_stop_request_stops_the_shipped_engine_in_order_and_names_who_asked() {
    let dir = scratch();
    let logs = dir.join("logs");
    let mut engine = Engine(
        Command::new(env!("CARGO_BIN_EXE_gx-render-worker"))
            .args(["--port", "0", "--asset-port", "0", "--token", SECRET])
            .arg("--recovery-journal")
            .arg(dir.join("journal.json"))
            .env("GX_LOG_DIR", &logs)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the worker starts"),
    );

    // Where it listens: from its own start record.
    let deadline = Instant::now() + Duration::from_secs(30);
    let control: SocketAddr = loop {
        let found = records(&logs.join("engine"));
        if let Some(address) = found
            .iter()
            .find(|r| r["event"] == "engine.start")
            .and_then(|r| r["fields"]["control"].as_str())
            .and_then(|a| a.parse().ok())
        {
            break address;
        }
        assert!(Instant::now() < deadline, "no engine.start: {found:#?}");
        std::thread::sleep(Duration::from_millis(200));
    };

    // 1. Every Program scope but `stop`: refused by name, and the engine runs on.
    let mut without = Client::connect_with_token(
        control,
        credential(
            "operator-without-stop",
            vec![
                Scope::Cue,
                Scope::Take,
                Scope::Clear,
                Scope::ConfigureOutput,
            ],
        ),
    )
    .expect("a credential without the stop scope connects");
    let refused = without.request(ClientRequest::Stop).expect("a reply");
    assert!(
        matches!(
            &refused,
            EngineReply::Refused(Refusal::ScopeNotGranted {
                required: Some(Scope::Stop),
                role: Role::Playout,
                ..
            })
        ),
        "{refused:?}"
    );
    assert!(
        matches!(
            without.request(ClientRequest::Status),
            Ok(EngineReply::Status(_))
        ),
        "the engine still answers"
    );
    assert!(
        engine.0.try_wait().expect("polled").is_none(),
        "a refused stop did not stop the engine"
    );
    drop(without);

    // 2. With the scope, off air: `Stopping`, then the engine ends in order.
    let mut operator =
        Client::connect_with_token(control, credential("stop-operator", vec![Scope::Stop]))
            .expect("a credential with the stop scope connects");
    let reply = {
        let _gesture = gx_telemetry::corr::enter("stop-gesture-1");
        operator.request(ClientRequest::Stop)
    };
    assert!(
        matches!(reply, Ok(EngineReply::Stopping)),
        "the client gets its answer before the engine ends: {reply:?}"
    );

    let exit = {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = engine.0.try_wait().expect("polled") {
                break status;
            }
            assert!(Instant::now() < deadline, "the engine did not end");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert_eq!(exit.code(), Some(0), "an orderly stop exits 0");

    let found = records(&logs.join("engine"));
    let events: Vec<&str> = found
        .iter()
        .map(|r| r["event"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        &events[events.len() - 2..],
        ["engine.stop", "log.stop"],
        "the file ends in order: {events:?}"
    );
    let stop = found
        .iter()
        .find(|r| r["event"] == "engine.stop")
        .expect("engine.stop");
    assert_eq!(stop["level"], "info");
    assert_eq!(
        stop["fields"]["reason"],
        "a stop request on the control plane"
    );
    assert_eq!(stop["corr"], "stop-gesture-1", "{stop}");
    assert_eq!(
        found.iter().filter(|r| r["event"] == "engine.stop").count(),
        1,
        "one engine.stop"
    );

    // Who asked: the transport's record, under the same id, naming the subject
    // and role and never the credential.
    let asked = found
        .iter()
        .find(|r| r["event"] == "control.stop_requested")
        .expect("control.stop_requested");
    assert_eq!(asked["level"], "warn");
    assert_eq!(asked["fields"]["subject"], "stop-operator");
    assert_eq!(asked["fields"]["role"], "Playout");
    assert_eq!(asked["corr"], "stop-gesture-1", "{asked}");
    let everything = std::fs::read_dir(logs.join("engine"))
        .unwrap()
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .collect::<String>();
    assert!(!everything.contains(SECRET), "the secret is never logged");
    assert!(!everything.contains("gx1."), "no credential is ever logged");

    // The refused attempt is on record too, by name.
    assert!(
        found.iter().any(|r| r["event"] == "control.refused"
            && r["fields"]["request"] == "stop"
            && r["refusal"] == "scopeNotGranted"
            && r["fields"]["subject"] == "operator-without-stop"),
        "the refused stop is on record"
    );

    let _ = std::fs::remove_dir_all(dir);
}
