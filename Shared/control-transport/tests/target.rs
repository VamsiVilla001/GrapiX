//! 12.10 (decision Q8): a Program command carries the channel and layer it is aimed at; only the
//! Program channel exists, so another is refused by name, and so is a layer the engine does not
//! draw. Checked by the transport before the engine sees the command.
//!
//! A real server, client and mock engine over TCP.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use gx_contracts::auth::OperatorName;
use gx_contracts::{ContentHash, RationalRate, Refusal, Revision, TakeId};
use gx_control_plane::intent::{ClearRequest, CueRequest, PhaseRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{
    ClientRequest, EngineReply, Envelope, OutputConfig, OutputTarget, MAIN_LAYER, PROGRAM_CHANNEL,
};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::sequence::{MessageId, Sequence};
use gx_control_transport::Client;
use gx_mock_engine::MockEngine;

fn serve() -> (SocketAddr, Arc<Mutex<MockEngine>>) {
    let mut engine = MockEngine::new().genlocked(RationalRate::P29_97);
    engine.publish(TakeId("t".into()), Revision(1), ContentHash("a".repeat(64)));
    let server = gx_control_transport::Server::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        None,
        engine,
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

fn target(channel: &str, layer: &str) -> OutputTarget {
    OutputTarget {
        channel: channel.to_owned(),
        layer: layer.to_owned(),
    }
}

#[test]
fn a_command_aimed_at_another_channel_is_refused_by_name_and_never_reaches_the_engine() {
    let (addr, engine) = serve();
    let mut client = client(addr);
    client.set_target(Some(target("preview", MAIN_LAYER)));
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
fn a_layer_the_engine_does_not_draw_is_refused_by_name() {
    let (addr, engine) = serve();
    let mut client = client(addr);
    client.set_target(Some(OutputTarget::program("bug")));
    for request in targeted() {
        let kind = request.name();
        let reply = client.handle(request);
        assert!(
            matches!(&reply, EngineReply::Refused(Refusal::LayerNotSupported { request, layer })
                if request == kind && layer == "bug"),
            "{kind}: {reply:?}"
        );
    }
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
            at: TakeAt::NextOpportunity
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
    client.set_target(Some(target("preview", "bug")));
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
        .with_target(Some(OutputTarget::program("bug")));
    let text = serde_json::to_string(&aimed).unwrap();
    assert!(
        text.contains(r#""target":{"channel":"program","layer":"bug"}"#),
        "{text}"
    );
    let back: Envelope<ClientRequest> = serde_json::from_str(&text).unwrap();
    assert_eq!(back, aimed);

    // The target is closed: an unknown member is not a side channel.
    let bad = text.replace(r#""layer":"bug""#, r#""layer":"bug","z":1"#);
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
