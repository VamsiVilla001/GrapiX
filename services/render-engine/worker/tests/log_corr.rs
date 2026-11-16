//! 2.13: a request made inside a correlation scope is followed by its id into
//! the engine, over the control plane.
//!
//! A real `Engine` is served by the real control transport on loopback. The
//! client makes one request inside a scope (as a shell does for a take) and
//! one outside it. The engine's records for the first carry the scope's id and
//! the second's carry none; an id that does not pass the shape check is not
//! kept anywhere.
//!
//! One test in this binary: it installs the process's global log, as a shipped
//! process does, so the transport's connection threads write to it.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use gx_contracts::{ContentHash, Locality, Revision, TakeId};
use gx_control_plane::intent::{ClearRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_transport::{Client, Server};
use gx_render_worker::Engine;
use gx_telemetry::sink::{init_logging, LogConfig};

fn records(directory: &std::path::Path) -> Vec<serde_json::Value> {
    let mut all = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap().flatten() {
        for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
            all.push(serde_json::from_str(line).unwrap());
        }
    }
    all
}

#[test]
fn the_engine_writes_a_requests_correlation_id_on_every_record_the_request_causes() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gx-worker-corr-{}-{nanos}", std::process::id()));
    let guard = init_logging(LogConfig::new("engine", "worker", &dir)).expect("the log starts");

    let engine = Engine::new(Arc::new(AtomicU64::new(0)), Locality::CoLocated);
    let server = Server::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        None,
        engine,
    )
    .expect("bind loopback");
    let address = server.local_addr().expect("local address");
    server.serve_in_background();

    let take = |name: &str| {
        ClientRequest::Take(TakeRequest {
            take_id: TakeId(name.into()),
            revision: Revision(1),
            content_hash: Some(ContentHash("a".repeat(64))),
            at: TakeAt::NextOpportunity,
        })
    };
    {
        let mut client = Client::connect(address).expect("connect");
        // As the Playout shell does for one operator command.
        {
            let _scope = gx_telemetry::corr::enter("po-take-9");
            let reply = client.request(take("not-published")).expect("a reply");
            assert!(matches!(reply, EngineReply::Refused(_)), "{reply:?}");
        }
        // The next command is another action, or none.
        let reply = client
            .request(ClientRequest::Clear(ClearRequest {
                at: TakeAt::NextOpportunity,
            }))
            .expect("a reply");
        assert!(matches!(reply, EngineReply::Cleared(_)), "{reply:?}");
        {
            let _scope = gx_telemetry::corr::enter("po-take-10");
            client.request(take("also-not-published")).expect("a reply");
        }
    }
    // The server's connection thread writes the leave; wait for it.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline
        && !records(&dir.join("engine"))
            .iter()
            .any(|r| r["event"] == "control.disconnected")
    {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    guard.finish().expect("the log finishes");

    let found = records(&dir.join("engine"));
    let _ = std::fs::remove_dir_all(&dir);
    let of = |event: &str| -> Vec<&serde_json::Value> {
        found.iter().filter(|r| r["event"] == event).collect()
    };

    let takes = of("program.take");
    assert_eq!(takes.len(), 2, "{found:#?}");
    assert!(takes.iter().all(|r| r["fields"]["result"] == "refused"));
    assert_eq!(
        takes[0]["corr"], "po-take-9",
        "the engine's record of the take carries the id the request arrived with"
    );
    assert_eq!(
        takes[1]["corr"], "po-take-10",
        "the next action has its own id"
    );
    let clears = of("program.clear");
    assert_eq!(clears.len(), 1);
    assert!(
        clears[0]["corr"].is_null(),
        "a request outside any scope is not given the previous request's id: {}",
        clears[0]
    );
    // The transport's own records for the connection are outside every scope.
    assert!(of("control.connected").iter().all(|r| r["corr"].is_null()));
}
