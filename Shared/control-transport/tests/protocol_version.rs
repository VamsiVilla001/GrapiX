//! 2.20: the wire version is compared on connect, from both sides.
//!
//! Before this the version was a number each side wrote down and nobody
//! compared: the client stored the engine's reply unread, and the engine
//! compared its own constant with itself.

use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use gx_contracts::{Refusal, PROTOCOL_VERSION};
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::{Client, Server};
use gx_mock_engine::MockEngine;

/// An engine that reports a protocol of its own in its capability, whatever
/// it is asked.
struct Reports {
    inner: MockEngine,
    protocol: u32,
}

impl EnginePeer for Reports {
    fn capability(&self) -> EngineCapability {
        EngineCapability {
            protocol: self.protocol,
            ..self.inner.capability()
        }
    }

    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        match self.inner.handle(request) {
            EngineReply::Capability(capability) => EngineReply::Capability(EngineCapability {
                protocol: self.protocol,
                ..capability
            }),
            other => other,
        }
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        self.inner.drain_events()
    }
}

fn serve<P: EnginePeer + Send + 'static>(peer: P) -> SocketAddr {
    let server = Server::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        None,
        peer,
    )
    .expect("bind loopback");
    let address = server.local_addr().expect("local address");
    server.serve_in_background();
    address
}

#[test]
fn a_client_refuses_an_engine_that_reports_another_protocol_and_says_both() {
    for reported in [PROTOCOL_VERSION + 1, PROTOCOL_VERSION - 1, 0] {
        let address = serve(Reports {
            inner: MockEngine::new(),
            protocol: reported,
        });
        let error = Client::connect(address)
            .err()
            .unwrap_or_else(|| panic!("a client connected to an engine on protocol {reported}"));
        assert_eq!(error.kind(), ErrorKind::InvalidData, "{error}");
        let said = error.to_string();
        assert!(
            said.contains(&PROTOCOL_VERSION.to_string()) && said.contains(&reported.to_string()),
            "the refusal names both versions: {said}"
        );
    }
}

#[test]
fn a_client_connects_to_an_engine_on_its_own_protocol_and_keeps_what_it_reported() {
    let address = serve(Reports {
        inner: MockEngine::new(),
        protocol: PROTOCOL_VERSION,
    });
    let client = Client::connect(address).expect("the same protocol connects");
    assert_eq!(client.capability().protocol, PROTOCOL_VERSION);
}

#[test]
fn the_engine_refuses_a_client_that_states_another_protocol_over_the_wire() {
    let address = serve(MockEngine::new());
    let mut client = Client::connect(address).expect("connects");
    let other = PROTOCOL_VERSION + 1;
    let refused = client
        .request(ClientRequest::Capability {
            protocol: Some(other),
        })
        .expect("a reply");
    assert!(
        matches!(
            &refused,
            EngineReply::Refused(Refusal::ProtocolMismatch { expected, actual })
                if *expected == PROTOCOL_VERSION && *actual == other
        ),
        "{refused:?}"
    );
    // A client that does not say is still served, and still checks the reply.
    let unstated = client
        .request(ClientRequest::Capability { protocol: None })
        .expect("a reply");
    assert!(
        matches!(unstated, EngineReply::Capability(_)),
        "{unstated:?}"
    );
}
