//! 12.10 (decision Q8): a Program command carries the channel and layer it is aimed at; only the
//! Program channel and in-range integer layers pass transport validation. A single-layer peer
//! still refuses other layers without applying them to layer zero.
//!
//! A real server, client and mock engine over TCP.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use gx_contracts::auth::OperatorName;
use gx_contracts::{ContentHash, RationalRate, Refusal, Revision, TakeId};
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::intent::{ClearRequest, CueRequest, PhaseRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{
    ClientRequest, EngineEvent, EngineReply, Envelope, OutputConfig, OutputTarget, MAIN_LAYER,
    PROGRAM_CHANNEL,
};
use gx_control_plane::peer::{EnginePeer, Handled};
use gx_control_plane::sequence::{MessageId, Sequence};
use gx_control_transport::Client;
use gx_mock_engine::MockEngine;

fn serve() -> (SocketAddr, Arc<Mutex<MockEngine>>) {
    let mut engine = MockEngine::new().genlocked(RationalRate::P29_97);
    engine.publish(TakeId("t".into()), Revision(1), ContentHash("a".repeat(64)));
    serve_peer(engine)
}

fn serve_peer<P: EnginePeer + Send + 'static>(peer: P) -> (SocketAddr, Arc<Mutex<P>>) {
    let server = gx_control_transport::Server::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        None,
        peer,
    )
    .unwrap();
    let addr = server.local_addr().unwrap();
    let engine = server.engine();
    server.serve_in_background();
    (addr, engine)
}

fn client(addr: SocketAddr) -> Client {
    let mut client = Client::connect(addr).unwrap();
    client.set_operator(Some(&OperatorName::parse("Ada Lovelace").unwrap()));
    client
}

fn take() -> ClientRequest {
    ClientRequest::Take(TakeRequest {
        take_id: TakeId("t".into()),
        revision: Revision(1),
        content_hash: Some(ContentHash("a".repeat(64))),
        at: TakeAt::NextOpportunity,
    })
}

fn targeted() -> Vec<ClientRequest> {
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
    ]
}

fn on_program(engine: &Arc<Mutex<MockEngine>>) -> bool {
    match engine.lock().unwrap().handle(ClientRequest::Status) {
        EngineReply::Status(status) => status.program.is_some(),
        other => panic!("status: {other:?}"),
    }
}

fn target(channel: &str, layer: i32) -> OutputTarget {
    OutputTarget {
        channel: channel.to_owned(),
        layer,
    }
}

#[derive(Default)]
struct RecordingPeer {
    seen: Vec<(&'static str, i32)>,
}

impl EnginePeer for RecordingPeer {
    fn capability(&self) -> EngineCapability {
        MockEngine::new().capability()
    }

    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        assert!(!request.is_targeted(), "request lost its layer: {request:?}");
        MockEngine::new().handle(request)
    }

    fn handle_on_layer(&mut self, request: ClientRequest, layer: i32) -> Handled {
        self.seen.push((request.name(), layer));
        Handled::Reply(EngineReply::Refused(Refusal::NotImplemented {
            what: "recorded without rendering".to_owned(),
        }))
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        Vec::new()
    }
}

#[test]
fn a_command_aimed_at_another_channel_is_refused_by_name_and_never_reaches_the_engine() {
    let (addr, engine) = serve();
    let mut client = client(addr);
    client.set_target(Some(target("preview", 100_000)));
    for request in targeted() {
        let kind = request.name();
        let reply = client.handle(request);
        assert!(
            matches!(&reply, EngineReply::Refused(Refusal::ChannelNotSupported { request, channel })
                if request == kind && channel == "preview"),
            "{kind}: {reply:?}"
        );
    }
    assert!(
        !on_program(&engine),
        "a refused take must not reach Program"
    );
}

#[test]
fn layers_outside_the_range_are_refused_before_the_peer_sees_them() {
    let (addr, peer) = serve_peer(RecordingPeer::default());
    let mut client = client(addr);
    for layer_number in [-100_000, 100_000] {
        client.set_target(Some(OutputTarget::program(layer_number)));
        for request in targeted() {
            let kind = request.name();
            let reply = client.handle(request);
            assert!(
                matches!(&reply, EngineReply::Refused(Refusal::LayerNotSupported { request, layer })
                    if request == kind && layer == &layer_number.to_string()),
                "{kind}: {reply:?}"
            );
        }
    }
    assert!(peer.lock().unwrap().seen.is_empty());
}

#[test]
fn the_transport_delivers_in_range_layers_and_defaults_to_zero() {
    let (addr, peer) = serve_peer(RecordingPeer::default());
    let mut client = client(addr);
    let mut expected = Vec::new();
    for layer in [
        None,
        Some(0),
        Some(-99_999),
        Some(99_999),
        Some(-50),
        Some(60),
    ] {
        client.set_target(layer.map(OutputTarget::program));
        for request in targeted() {
            expected.push((request.name(), layer.unwrap_or(0)));
            assert!(matches!(
                client.handle(request),
                EngineReply::Refused(Refusal::NotImplemented { .. })
            ));
        }
    }
    assert_eq!(peer.lock().unwrap().seen, expected);
}

#[test]
fn a_request_sent_on_a_layer_reaches_that_layer_and_leaves_the_clients_own_target_alone() {
    let (addr, peer) = serve_peer(RecordingPeer::default());
    let mut client = client(addr);
    // The client keeps layer 7 for ordinary requests; a request sent on another layer must not disturb that.
    client.set_target(Some(OutputTarget::program(7)));
    for layer in [60, 0, -3] {
        let reply = match client.handle_on_layer(take(), layer) {
            Handled::Reply(reply) => reply,
            Handled::Detached(finish) => finish(),
        };
        assert!(matches!(reply, EngineReply::Refused(Refusal::NotImplemented { .. })), "{reply:?}");
    }
    assert!(matches!(client.handle(take()), EngineReply::Refused(Refusal::NotImplemented { .. })));
    assert_eq!(
        peer.lock().unwrap().seen,
        [("take", 60), ("take", 0), ("take", -3), ("take", 7)],
        "each request went to its own layer, layer zero as no target, and the kept target came back"
    );
}

#[test]
fn a_nonzero_layer_sent_to_a_single_layer_peer_is_refused_by_name_and_nothing_goes_to_air() {
    let (addr, engine) = serve();
    let mut client = client(addr);
    let reply = match client.handle_on_layer(take(), 60) {
        Handled::Reply(reply) => reply,
        Handled::Detached(finish) => finish(),
    };
    assert!(matches!(reply, EngineReply::Refused(Refusal::LayerNotSupported { request, layer }) if request == "take" && layer == "60"));
    assert!(!on_program(&engine));
    // And layer zero by the same route still takes.
    let main = match client.handle_on_layer(take(), 0) {
        Handled::Reply(reply) => reply,
        Handled::Detached(finish) => finish(),
    };
    assert!(matches!(main, EngineReply::Taken(_)), "{main:?}");
    assert!(on_program(&engine));
}

#[test]
fn a_single_layer_peer_does_not_send_a_nonzero_take_to_layer_zero() {
    let (addr, engine) = serve();
    let mut client = client(addr);
    client.set_target(Some(OutputTarget::program(1)));
    assert!(matches!(
        client.handle(take()),
        EngineReply::Refused(Refusal::LayerNotSupported { request, layer })
            if request == "take" && layer == "1"
    ));
    assert!(!on_program(&engine));
}

#[test]
fn the_program_channels_main_layer_is_what_no_target_means() {
    let (addr, engine) = serve();
    let mut plain = client(addr);
    assert!(matches!(plain.handle(take()), EngineReply::Taken(_)));
    assert!(on_program(&engine));
    assert!(matches!(
        plain.handle(ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
            expected: None,
        })),
        EngineReply::Cleared(_)
    ));

    let mut named = client(addr);
    named.set_target(Some(OutputTarget::main()));
    assert_eq!(OutputTarget::main(), target(PROGRAM_CHANNEL, MAIN_LAYER));
    assert!(matches!(named.handle(take()), EngineReply::Taken(_)));
    assert!(on_program(&engine));
}

#[test]
fn a_command_that_is_not_aimed_at_a_layer_carries_no_target() {
    let (addr, _engine) = serve();
    let mut client = client(addr);
    client.set_target(Some(target("preview", 100_000)));
    // A read and the output configuration are not aimed at a layer: the target is not sent, so
    // it cannot be refused.
    assert!(matches!(
        client.handle(ClientRequest::Status),
        EngineReply::Status(_)
    ));
    assert!(matches!(
        client.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "null".into(),
            live: false,
            accept_free_run: false,
        })),
        EngineReply::OutputConfigured { .. }
    ));
}

#[test]
fn a_name_that_is_hostile_is_cut_and_escaped_in_the_refusal() {
    let (addr, _engine) = serve();
    let mut client = client(addr);
    let hostile = format!("evil\nline\u{1b}[31m{}", "x".repeat(500));
    client.set_target(Some(target(&hostile, MAIN_LAYER)));
    let EngineReply::Refused(refusal) = client.handle(take()) else {
        panic!("a hostile channel is refused");
    };
    let said = refusal.to_string();
    assert!(!said.contains('\n') && !said.contains('\u{1b}'), "{said:?}");
    assert!(said.len() < 400, "cut short: {} bytes", said.len());
    let Refusal::ChannelNotSupported { channel, .. } = refusal else {
        panic!("ChannelNotSupported");
    };
    assert!(channel.contains("\\n"), "escaped, not raw: {channel}");
}

#[test]
fn the_target_survives_a_redial() {
    let (addr, _engine) = serve();
    let mut client = client(addr);
    client.set_target(Some(target("preview", MAIN_LAYER)));
    client.reconnect().expect("a redial");
    assert!(matches!(
        client.handle(take()),
        EngineReply::Refused(Refusal::ChannelNotSupported { .. })
    ));
}

#[test]
fn an_envelope_with_no_target_has_no_target_on_the_wire_and_one_with_it_round_trips() {
    let plain = Envelope::new(MessageId("m".into()), Sequence(1), ClientRequest::Status);
    let text = serde_json::to_string(&plain).unwrap();
    assert!(
        !text.contains("target"),
        "an engine that predates the field reads it as before: {text}"
    );

    let aimed = Envelope::new(MessageId("m".into()), Sequence(1), take())
        .with_target(Some(OutputTarget::program(-50)));
    let text = serde_json::to_string(&aimed).unwrap();
    assert!(
        text.contains(r#""target":{"channel":"program","layer":-50}"#),
        "{text}"
    );
    let back: Envelope<ClientRequest> = serde_json::from_str(&text).unwrap();
    assert_eq!(back, aimed);

    let legacy = text.replace(r#""layer":-50"#, r#""layer":"main""#);
    let legacy: Envelope<ClientRequest> = serde_json::from_str(&legacy).unwrap();
    assert_eq!(legacy.target, Some(OutputTarget::main()));
    assert!(serde_json::to_string(&legacy)
        .unwrap()
        .contains(r#""layer":0"#));

    let fractional = text.replace(r#""layer":-50"#, r#""layer":-50.5"#);
    assert!(serde_json::from_str::<Envelope<ClientRequest>>(&fractional).is_err());

    // The target is closed: an unknown member is not a side channel.
    let bad = text.replace(r#""layer":-50"#, r#""layer":-50,"z":1"#);
    assert!(serde_json::from_str::<Envelope<ClientRequest>>(&bad).is_err());
}

#[test]
fn only_the_commands_that_are_aimed_are_targeted() {
    let kinds: Vec<_> = targeted().iter().map(ClientRequest::is_targeted).collect();
    assert_eq!(kinds, [true; 4]);
    for request in [
        ClientRequest::Status,
        ClientRequest::Performance,
        ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "null".into(),
            live: false,
            accept_free_run: false,
        }),
        ClientRequest::Stop,
    ] {
        assert!(!request.is_targeted(), "{}", request.name());
    }
}
