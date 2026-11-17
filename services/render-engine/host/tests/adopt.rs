//! 2.20: the host tells "nothing is listening" from "something answered and
//! refused me".
//!
//! Before this any failed connect meant no engine, and the host started a second
//! worker beside one it merely could not use (an engine with a token the host
//! does not hold, or on another protocol): the second worker failed to bind and
//! the host reported that, never the refusal.

use std::io::{self, ErrorKind};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};

use gx_contracts::PROTOCOL_VERSION;
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::Server;
use gx_engine_host::{ensure_with_journal, nothing_is_listening, SupervisorError};
use gx_mock_engine::MockEngine;

const SECRET: &str = "adopt-test-secret-0123456789abcdef";

fn loopback(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

/// An engine whose capability reports another protocol.
struct OtherProtocol(MockEngine);

impl EnginePeer for OtherProtocol {
    fn capability(&self) -> EngineCapability {
        EngineCapability {
            protocol: PROTOCOL_VERSION + 1,
            ..self.0.capability()
        }
    }

    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        match self.0.handle(request) {
            EngineReply::Capability(capability) => EngineReply::Capability(EngineCapability {
                protocol: PROTOCOL_VERSION + 1,
                ..capability
            }),
            other => other,
        }
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        self.0.drain_events()
    }
}

fn journal() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("gx-host-adopt-{}.json", std::process::id()))
}

#[test]
fn only_the_systems_own_refusal_or_silence_says_nothing_is_listening() {
    // A real refused connect: a port that was open and is closed.
    let port = TcpListener::bind(loopback(0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let refused = std::net::TcpStream::connect(loopback(port)).expect_err("nothing listens");
    assert!(nothing_is_listening(&refused), "{refused:?}");
    assert!(nothing_is_listening(&io::Error::from(ErrorKind::TimedOut)));
    // What the transport reports when an engine answered and refused: no system code.
    for kind in [
        ErrorKind::PermissionDenied,
        ErrorKind::InvalidData,
        ErrorKind::ConnectionRefused,
        ErrorKind::ConnectionAborted,
    ] {
        assert!(
            !nothing_is_listening(&io::Error::new(kind, "refused by name")),
            "{kind:?}"
        );
    }
}

#[test]
fn an_engine_that_refuses_the_host_is_named_and_no_worker_is_started_beside_it() {
    let server = Server::bind(loopback(0), Some(SECRET), MockEngine::new()).expect("bind");
    let port = server.local_addr().unwrap().port();
    server.serve_in_background();
    // The host holds no token, and the program it would spawn does not exist: if it
    // tried to start one, the error would be a spawn failure, not the refusal.
    let error = ensure_with_journal("no-such-worker-program", port, &[], &journal())
        .err()
        .expect("an engine that refuses the host is not adopted");
    match error {
        SupervisorError::EngineUnusable { endpoint, source } => {
            assert_eq!(endpoint.port(), port);
            assert_eq!(source.kind(), ErrorKind::PermissionDenied, "{source}");
        }
        other => panic!("expected EngineUnusable, got {other}"),
    }
}

#[test]
fn an_engine_on_another_protocol_is_named_and_no_worker_is_started_beside_it() {
    let server = Server::bind(loopback(0), None, OtherProtocol(MockEngine::new())).expect("bind");
    let port = server.local_addr().unwrap().port();
    server.serve_in_background();
    let error = ensure_with_journal("no-such-worker-program", port, &[], &journal())
        .err()
        .expect("an engine on another protocol is not adopted");
    match error {
        SupervisorError::EngineUnusable { source, .. } => {
            assert_eq!(source.kind(), ErrorKind::InvalidData, "{source}");
            assert!(
                source
                    .to_string()
                    .contains(&(PROTOCOL_VERSION + 1).to_string()),
                "{source}"
            );
        }
        other => panic!("expected EngineUnusable, got {other}"),
    }
}

#[test]
fn nothing_listening_still_tries_to_start_a_worker() {
    let port = TcpListener::bind(loopback(0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let error = ensure_with_journal("no-such-worker-program", port, &[], &journal())
        .err()
        .expect("no worker program exists");
    assert!(matches!(error, SupervisorError::Spawn { .. }), "{error}");
}
