//! 2.15: every Program command names the person who sent it, and the engine refuses one that
//! does not, by name, before the engine sees it.
//!
//! An integration test on purpose: the published surface (`Client::set_operator`, the raw
//! envelope) has to be enough to sign in, and a raw peer must be refused as a client is.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};

use gx_contracts::auth::{OperatorName, OperatorNameFault, Role, Scope};
use gx_contracts::{ContentHash, RationalRate, Refusal, Revision, TakeId};
use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
use gx_control_plane::intent::{ClearRequest, CueRequest, PhaseRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply, Envelope, OutputConfig};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::sequence::{MessageId, Sequence};
use gx_control_transport::{Client, Server, Token};
use gx_mock_engine::MockEngine;

const SECRET: &str = "operator-test-secret-0123456789abcd";

fn loopback() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

fn serve(secret: Option<&str>) -> (SocketAddr, Arc<Mutex<MockEngine>>) {
    let mut engine = MockEngine::new().genlocked(RationalRate::P29_97);
    engine.publish(TakeId("t".into()), Revision(1), ContentHash("a".repeat(64)));
    let server = Server::bind(loopback(), secret, engine).expect("bind loopback");
    let addr = server.local_addr().expect("local addr");
    let engine = server.engine();
    server.serve_in_background();
    (addr, engine)
}

fn playout_token(subject: &str) -> Token {
    Token::mint(
        subject,
        Role::Playout,
        vec![
            Scope::Cue,
            Scope::Take,
            Scope::Clear,
            Scope::ConfigureOutput,
        ],
        SECRET,
    )
    .expect("mint")
}

fn name(text: &str) -> OperatorName {
    OperatorName::parse(text).expect("a valid operator name")
}

fn take() -> ClientRequest {
    ClientRequest::Take(TakeRequest {
        take_id: TakeId("t".into()),
        revision: Revision(1),
        content_hash: Some(ContentHash("a".repeat(64))),
        at: TakeAt::NextOpportunity,
    })
}

/// Every Program command, one of each kind.
fn program_commands() -> Vec<ClientRequest> {
    vec![
        ClientRequest::Cue(CueRequest {
            take_id: TakeId("t".into()),
            revision: Revision(1),
            content_hash: Some(ContentHash("a".repeat(64))),
            at: TakeAt::NextOpportunity,
        }),
        take(),
        ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
            expected: None,
        }),
        ClientRequest::Phase(PhaseRequest {
            phase: "hold".into(),
            at: TakeAt::NextOpportunity,
        }),
        ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "null".into(),
            live: false,
            accept_free_run: false,
        }),
    ]
}

fn on_program(engine: &Arc<Mutex<MockEngine>>) -> bool {
    match engine.lock().unwrap().handle(ClientRequest::Status) {
        EngineReply::Status(status) => status.program.is_some(),
        other => panic!("status: {other:?}"),
    }
}

#[test]
fn a_program_command_with_no_operator_is_refused_by_name_and_never_reaches_the_engine() {
    let (addr, engine) = serve(None);
    let mut client = Client::connect(addr).expect("connect");
    for request in program_commands() {
        let kind = request.name();
        let reply = client.handle(request);
        assert!(
            matches!(&reply, EngineReply::Refused(Refusal::OperatorRequired { request }) if request == kind),
            "{kind}: {reply:?}"
        );
    }
    assert!(
        !on_program(&engine),
        "a refused take must not reach Program"
    );
}

#[test]
fn a_signed_in_operator_may_send_each_program_command() {
    let (addr, engine) = serve(None);
    let mut client = Client::connect(addr).expect("connect");
    client.set_operator(Some(&name("Ada Lovelace")));
    assert_eq!(client.operator(), Some("Ada Lovelace"));
    let reply = client.handle(take());
    assert!(matches!(reply, EngineReply::Taken(_)), "{reply:?}");
    assert!(on_program(&engine));
    let cleared = client.handle(ClientRequest::Clear(ClearRequest {
        at: TakeAt::NextOpportunity,
        expected: None,
    }));
    assert!(matches!(cleared, EngineReply::Cleared(_)), "{cleared:?}");
}

#[test]
fn signing_out_holds_the_next_command_and_a_reconnect_keeps_the_person() {
    let (addr, _engine) = serve(None);
    let mut client = Client::connect(addr).expect("connect");
    client.set_operator(Some(&name("Ada Lovelace")));
    client.reconnect().expect("reconnect");
    assert_eq!(
        client.operator(),
        Some("Ada Lovelace"),
        "a redial is the same person on a new socket"
    );
    assert!(matches!(client.handle(take()), EngineReply::Taken(_)));
    client.set_operator(None);
    assert!(matches!(
        client.handle(take()),
        EngineReply::Refused(Refusal::OperatorRequired { .. })
    ));
}

#[test]
fn a_read_needs_no_operator_and_the_name_rides_only_a_program_command() {
    let (addr, _engine) = serve(None);
    let mut client = Client::connect(addr).expect("connect");
    assert!(matches!(
        client.handle(ClientRequest::Status),
        EngineReply::Status(_)
    ));
    assert!(matches!(
        client.handle(ClientRequest::Performance),
        EngineReply::Performance(_)
    ));
}

/// What a raw peer can do that `Client` will not: send a name the rules refuse.
fn raw_take_as(addr: SocketAddr, operator: Option<&str>) -> EngineReply {
    let mut stream = TcpStream::connect(addr).expect("connect");
    let envelope = Envelope::new(MessageId("raw.1".into()), Sequence(1), take())
        .with_operator(operator.map(str::to_owned));
    stream
        .write_all(&encode(&envelope).expect("encode"))
        .expect("write");
    let mut prefix = [0u8; LENGTH_PREFIX];
    stream.read_exact(&mut prefix).expect("read prefix");
    let mut body = vec![0u8; decode_length(prefix).expect("length")];
    stream.read_exact(&mut body).expect("read body");
    let reply: Envelope<EngineReply> = decode_body(&body).expect("decode");
    reply.payload
}

#[test]
fn a_name_the_rules_refuse_is_refused_naming_the_rule_and_the_name_is_not_echoed() {
    let (addr, engine) = serve(None);
    for (sent, fault) in [
        ("Ada\nLovelace", OperatorNameFault::BadCharacter),
        ("-Ada", OperatorNameFault::BadStart),
        ("Ada  Lovelace", OperatorNameFault::DoubleSpace),
        ("   ", OperatorNameFault::Empty),
        (&"x".repeat(65), OperatorNameFault::TooLong),
    ] {
        let reply = raw_take_as(addr, Some(sent));
        let EngineReply::Refused(Refusal::OperatorNameInvalid {
            request,
            fault: got,
        }) = &reply
        else {
            panic!("{sent:?}: {reply:?}");
        };
        assert_eq!((request.as_str(), *got), ("take", fault), "{sent:?}");
        assert!(
            !format!("{reply:?}").contains(sent.trim()) || sent.trim().is_empty(),
            "the refused name is not repeated back: {reply:?}"
        );
    }
    assert!(!on_program(&engine));
    // And a good name over the same raw path is accepted.
    assert!(matches!(
        raw_take_as(addr, Some("Ada Lovelace")),
        EngineReply::Taken(_)
    ));
}

#[test]
fn the_credential_and_its_scope_are_judged_before_the_operator() {
    let (addr, engine) = serve(Some(SECRET));
    // An Editor credential may not take at all: it hears that, not "sign in".
    let editor = Token::mint("editor", Role::Editor, vec![Scope::Author], SECRET).expect("mint");
    let mut client = Client::authenticate_only(addr, editor).expect("authenticated");
    assert!(matches!(
        client.handle(take()),
        EngineReply::Refused(Refusal::ScopeNotGranted { .. })
    ));
    // A Playout credential with no operator hears the operator refusal.
    let mut playout = Client::connect_with_token(addr, playout_token("desk-1")).expect("connect");
    assert!(matches!(
        playout.handle(take()),
        EngineReply::Refused(Refusal::OperatorRequired { .. })
    ));
    playout.set_operator(Some(&name("Ada Lovelace")));
    assert!(matches!(playout.handle(take()), EngineReply::Taken(_)));
    assert!(on_program(&engine));
}

#[test]
fn an_unauthenticated_peer_is_asked_to_authenticate_not_to_sign_in() {
    let (addr, _engine) = serve(Some(SECRET));
    let reply = raw_take_as(addr, None);
    assert!(
        matches!(reply, EngineReply::Refused(Refusal::Unauthenticated)),
        "{reply:?}"
    );
}
