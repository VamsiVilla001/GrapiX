//! Credential enforcement and reconnect reconciliation, over a real socket.
//!
//! An integration test on purpose: it may only use the public API, so it also
//! proves the published surface is enough to authenticate, reconnect and
//! reconcile without reaching into internals.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};

use gx_contracts::auth::{Role, Scope};
use gx_contracts::{RationalRate, Refusal, Revision, TakeId};
use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
use gx_control_plane::intent::{TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply, Envelope};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::sequence::{MessageId, Sequence};
use gx_control_transport::{Client, Server, Token};
use gx_mock_engine::MockEngine;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
/// Differs from TOKEN only in the final byte: the case an early-return
/// comparison answers fastest.
const WRONG: &str = "0123456789abcdef0123456789abcdeF";

fn loopback() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

/// A protected server on loopback, with one scene published.
///
/// Loopback does not *require* a token, but a configured one must still be
/// enforced — otherwise the setting is decorative and ADR-001's L1 posture
/// rests on nothing.
fn protected() -> (SocketAddr, Arc<Mutex<MockEngine>>) {
    let mut engine = MockEngine::new().genlocked(RationalRate::P29_97);
    engine.publish(TakeId("t".into()), Revision(1));
    let server = Server::bind(loopback(), Some(TOKEN), engine).expect("bind loopback");
    let addr = server.local_addr().expect("local addr");
    let engine = server.engine();
    server.serve_in_background();
    (addr, engine)
}

fn credential(secret: &str) -> Token {
    Token::mint(
        "playout-test",
        Role::Playout,
        vec![
            Scope::Cue,
            Scope::Take,
            Scope::Clear,
            Scope::ConfigureOutput,
        ],
        secret,
    )
    .expect("mint gx1 credential")
}

fn take() -> ClientRequest {
    ClientRequest::Take(TakeRequest {
        take_id: TakeId("t".into()),
        revision: Revision(1),
        at: TakeAt::NextOpportunity,
    })
}

#[test]
fn a_correct_token_connects() {
    let (addr, _engine) = protected();
    let client =
        Client::connect_with_token(addr, credential(TOKEN)).expect("a correct token must connect");
    assert_eq!(client.capability().protocol, gx_contracts::PROTOCOL_VERSION);
}

#[test]
fn a_token_wrong_in_one_byte_is_refused() {
    let (addr, _engine) = protected();
    let err = Client::connect_with_token(addr, credential(WRONG))
        .err()
        .expect("a wrong token must not connect");
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn an_unauthenticated_client_cannot_even_read_capability() {
    // Refusing capability matters as much as refusing a take: it carries the
    // engine's tier, clock and reference state, and none of that is public.
    let (addr, _engine) = protected();
    let err = Client::connect(addr)
        .err()
        .expect("an unauthenticated client must not complete the exchange");
    assert_eq!(
        err.kind(),
        std::io::ErrorKind::PermissionDenied,
        "a missing credential must be distinguishable from a broken peer: got {err}"
    );
}

#[test]
fn an_unauthenticated_take_is_refused_and_never_reaches_program() {
    // Speaking the wire directly, because a well-behaved Client would not send
    // this. The check is that the *server* refuses, not that the client is
    // polite.
    let (addr, engine) = protected();
    let mut raw = RawPeer::connect(addr);

    let reply = raw.send(take());
    assert!(
        matches!(reply, EngineReply::Refused(Refusal::Unauthenticated)),
        "got {reply:?}"
    );
    assert!(
        engine.lock().unwrap().status().unwrap().program.is_none(),
        "a refused take must not have reached Program"
    );
}

#[test]
fn authenticating_then_taking_works_on_the_same_connection() {
    let (addr, _engine) = protected();
    let mut raw = RawPeer::connect(addr);

    let authed = raw.send(ClientRequest::Authenticate {
        token: credential(TOKEN).as_str().to_owned(),
    });
    assert!(
        matches!(authed, EngineReply::Authenticated),
        "got {authed:?}"
    );

    let reply = raw.send(take());
    assert!(matches!(reply, EngineReply::Taken(_)), "got {reply:?}");
}

#[test]
fn a_failed_authentication_does_not_close_the_connection() {
    // A mistyped token should get a named refusal and a chance to retry. An
    // attacker gains nothing from the socket staying open that redialling
    // would not also give them.
    let (addr, _engine) = protected();
    let mut raw = RawPeer::connect(addr);

    let refused = raw.send(ClientRequest::Authenticate {
        token: credential(WRONG).as_str().to_owned(),
    });
    assert!(
        matches!(refused, EngineReply::Refused(Refusal::Unauthenticated)),
        "got {refused:?}"
    );

    let accepted = raw.send(ClientRequest::Authenticate {
        token: credential(TOKEN).as_str().to_owned(),
    });
    assert!(
        matches!(accepted, EngineReply::Authenticated),
        "a retry on the same connection must be possible: got {accepted:?}"
    );
}

#[test]
fn an_unprotected_server_accepts_a_plain_client() {
    let server = Server::bind(loopback(), None, MockEngine::new()).expect("bind");
    let addr = server.local_addr().unwrap();
    server.serve_in_background();
    assert!(Client::connect(addr).is_ok());
}

#[test]
fn program_survives_a_reconnect_and_the_epoch_matches() {
    // ADR B.4: the engine outlives its clients. A disconnect loses the
    // client's knowledge of Program, not Program itself.
    let (addr, _engine) = protected();
    let mut client = Client::connect_with_token(addr, credential(TOKEN)).expect("connect");

    assert!(matches!(client.handle(take()), EngineReply::Taken(_)));

    let reconciled = client.reconnect().expect("reconnect");
    assert!(
        !reconciled.engine_restarted(),
        "the engine did not restart, so the epoch must match: {reconciled:?}"
    );
    let program = reconciled.program.expect("Program must have survived");
    assert_eq!(program.take_id, TakeId("t".into()));
    assert_eq!(program.revision, Revision(1));
}

#[test]
fn a_restarted_engine_is_detected_by_epoch_not_by_revision() {
    // The trap this guards against: the restarted engine republishes at the
    // same revision. A client comparing revisions alone would see no change
    // and carry on with state that no longer exists.
    let (addr, engine) = protected();
    let mut client = Client::connect_with_token(addr, credential(TOKEN)).expect("connect");
    client.handle(take());

    {
        let mut engine = engine.lock().unwrap();
        engine.restart();
        engine.publish(TakeId("t".into()), Revision(1)); // same id, same revision
    }

    let reconciled = client.reconnect().expect("reconnect");
    assert!(
        reconciled.engine_restarted(),
        "a new incarnation must be visible: {reconciled:?}"
    );
    assert!(
        reconciled.program.is_none(),
        "the restarted engine has nothing on Program"
    );
    assert_eq!(reconciled.previous_epoch.0 + 1, reconciled.current_epoch.0);
}

#[test]
fn reconnecting_re_authenticates_so_a_rotated_token_stops_working() {
    let (addr, _engine) = protected();
    let mut client = Client::connect_with_token(addr, credential(TOKEN)).expect("connect");
    assert!(client.reconnect().is_ok(), "the same token still works");

    client.replace_token_for_test(credential(WRONG));
    let err = client
        .reconnect()
        .expect_err("a credential that no longer matches must fail on reconnect");
    assert!(
        matches!(err, Refusal::TransportFailed { .. }),
        "got {err:?}"
    );
}

/// A peer that speaks the wire directly, for cases a well-behaved `Client`
/// will not produce — such as sending a take without ever authenticating.
struct RawPeer {
    stream: TcpStream,
    seq: u64,
}

impl RawPeer {
    fn connect(addr: SocketAddr) -> Self {
        let stream = TcpStream::connect(addr).expect("connect");
        Self { stream, seq: 0 }
    }

    fn send(&mut self, request: ClientRequest) -> EngineReply {
        self.seq += 1;
        let envelope = Envelope::new(
            MessageId(format!("raw.{}", self.seq)),
            Sequence(self.seq),
            request,
        );
        let frame = encode(&envelope).expect("encode");
        self.stream.write_all(&frame).expect("write");
        self.stream.flush().expect("flush");

        let mut prefix = [0u8; LENGTH_PREFIX];
        self.stream.read_exact(&mut prefix).expect("read prefix");
        let len = decode_length(prefix).expect("length");
        let mut body = vec![0u8; len];
        self.stream.read_exact(&mut body).expect("read body");
        let reply: Envelope<EngineReply> = decode_body(&body).expect("decode");
        assert!(reply.id.is_reply(), "a reply must carry a reply id");
        reply.payload
    }
}
