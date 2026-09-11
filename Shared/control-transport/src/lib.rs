//! protocol v3 over a stream: the L0 control transport.
//!
//! ADR-001 gives the control plane a named pipe or Unix socket at L0 and
//! QUIC/TLS at L1. This crate is the L0 binding: loopback TCP on 4400, with
//! the framing and dispatch shared by both halves.
//!
//! **Why both halves live here.** ADR-001 places protocol clients in `Shared`.
//! The server is the same wire format read in the other direction, and two
//! copies of framing plus dispatch would be exactly the parallel
//! implementation invariant 27 forbids. Nothing in this crate contains product
//! logic: the server is generic over `EnginePeer` and has never heard of a
//! scene.
//!
//! **What this is not.** It is TCP on loopback, not a named pipe. The
//! difference matters for L0 security posture — a pipe can carry an OS-level
//! peer identity where loopback TCP cannot — and it is recorded as a gap
//! rather than dressed up. What the choice buys today is one code path across
//! Windows and Unix, and the bind policy in `gx_control_plane::bind` refusing
//! anything that is not loopback without a token.

#![forbid(unsafe_code)]

pub mod auth;
pub mod client;
pub mod server;

pub use auth::{Claims, ClaimsError, Token, TokenError};
pub use client::{Client, Reconciliation, REQUEST_TIMEOUT};
pub use server::{ServeError, Server};

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use gx_contracts::{DeviceTier, RationalRate, ReferenceState, Refusal, Revision, TakeId};
    use gx_control_plane::intent::{ClearRequest, TakeAt, TakeRequest};
    use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, OutputConfig};
    use gx_control_plane::peer::{EnginePeer, FaultInjection};
    use gx_mock_engine::MockEngine;

    use super::*;

    /// Bind to port 0 so the OS picks a free port: a fixed port would make
    /// these tests fail when run beside a real engine, or beside each other.
    fn loopback() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
    }

    /// Start a server carrying `engine` and return a client connected to it.
    fn connected(engine: MockEngine) -> Client {
        let server = Server::bind(loopback(), None, engine).expect("bind loopback");
        let addr = server.local_addr().expect("local addr");
        server.serve_in_background();
        Client::connect(addr).expect("connect")
    }

    #[test]
    fn a_client_completes_the_capability_exchange_on_connect() {
        let client = connected(MockEngine::new().genlocked(RationalRate::P29_97));
        let cap = client.capability();
        assert_eq!(cap.protocol, gx_contracts::PROTOCOL_VERSION);
        assert_eq!(cap.reference, ReferenceState::Locked);
        assert_eq!(cap.device_tier, DeviceTier::T0);
    }

    #[test]
    fn a_take_crosses_the_wire_and_returns_a_committed_frame() {
        let mut engine = MockEngine::new();
        engine.publish(TakeId("lower-third".into()), Revision(4));
        let mut client = connected(engine);

        let reply = client.handle(ClientRequest::Take(TakeRequest {
            take_id: TakeId("lower-third".into()),
            revision: Revision(4),
            at: TakeAt::NextOpportunity,
        }));

        match reply {
            EngineReply::Taken(committed) => {
                assert_eq!(committed.frame, 1);
                assert_eq!(committed.timebase, RationalRate::P50);
            }
            other => panic!("expected Taken, got {other:?}"),
        }

        // And the engine's state changed, as seen through a second request.
        let status = client.status().expect("status");
        assert_eq!(status.program.expect("program").committed_frame, 1);
    }

    #[test]
    fn a_refusal_crosses_the_wire_intact() {
        let mut client = connected(MockEngine::new());
        let reply = client.handle(ClientRequest::Take(TakeRequest {
            take_id: TakeId("never-published".into()),
            revision: Revision(1),
            at: TakeAt::NextOpportunity,
        }));
        assert!(
            matches!(reply, EngineReply::Refused(Refusal::UnknownTake { .. })),
            "a refusal must survive serialisation with its reason, got {reply:?}"
        );
    }

    #[test]
    fn events_reach_the_client_and_are_not_mistaken_for_replies() {
        // The server writes a reply and then an event on the same stream. The
        // client separates them by id prefix, which is invariant 34 doing real
        // work rather than sitting in a doc comment.
        let mut engine = MockEngine::new().genlocked(RationalRate::P50);
        engine.publish(TakeId("t".into()), Revision(1));
        engine.set_reference(ReferenceState::Unlocked);
        let mut client = connected(engine);

        // The reference event was queued before connect; a status request
        // gives the server an occasion to flush it.
        let reply = client.handle(ClientRequest::Status);
        assert!(
            matches!(reply, EngineReply::Status(_)),
            "the reply must be the reply, not the event"
        );

        // Allow the reader thread a moment to route the event frame.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let events = client.drain_events();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, EngineEvent::ReferenceChanged(_))),
            "expected the reference transition, got {events:?}"
        );
    }

    #[test]
    fn many_requests_keep_their_order_and_pairing() {
        let mut engine = MockEngine::new();
        engine.publish(TakeId("t".into()), Revision(1));
        let mut client = connected(engine);

        // Each clear commits to a frame; the frames must not go backwards, and
        // no reply may be delivered to the wrong request.
        let mut last = 0u64;
        for _ in 0..25 {
            match client.handle(ClientRequest::Clear(ClearRequest {
                at: TakeAt::NextOpportunity,
            })) {
                EngineReply::Cleared(c) => {
                    assert!(
                        c.frame >= last,
                        "frames went backwards: {last} then {}",
                        c.frame
                    );
                    last = c.frame;
                }
                other => panic!("expected Cleared, got {other:?}"),
            }
        }
    }

    #[test]
    fn the_bind_policy_is_enforced_before_a_socket_exists() {
        // 0.0.0.0 with no token must be refused, and must not have bound
        // anything on the way to being refused.
        let exposed = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
        let err = Server::bind(exposed, None, MockEngine::new())
            .err()
            .expect("an unspecified bind without a token must refuse");
        assert!(
            matches!(err, ServeError::Refused(_)),
            "expected a policy refusal, got {err:?}"
        );
    }

    #[test]
    fn a_live_output_refusal_survives_the_wire_with_its_named_cause() {
        let mut client = connected(
            MockEngine::new()
                .genlocked(RationalRate::P50)
                .with_device_tier(DeviceTier::T2),
        );
        let reply = client.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "decklink".into(),
            live: true,
            accept_free_run: false,
        }));
        assert!(
            matches!(
                reply,
                EngineReply::Refused(Refusal::TierTooLow {
                    actual: DeviceTier::T2
                })
            ),
            "the cause must arrive, not just the fact of refusal: got {reply:?}"
        );
    }

    #[test]
    fn two_clients_share_one_engine() {
        // One engine, many clients (ADR: Editor and Playout both connect). A
        // take through one client must be visible to the other.
        let mut engine = MockEngine::new();
        engine.publish(TakeId("t".into()), Revision(1));
        let server = Server::bind(loopback(), None, engine).expect("bind");
        let addr = server.local_addr().unwrap();
        server.serve_in_background();

        let mut a = Client::connect(addr).expect("client a");
        let mut b = Client::connect(addr).expect("client b");

        a.handle(ClientRequest::Take(TakeRequest {
            take_id: TakeId("t".into()),
            revision: Revision(1),
            at: TakeAt::NextOpportunity,
        }));

        let seen_by_b = b.status().expect("status via b");
        assert!(
            seen_by_b.program.is_some(),
            "the second client must see Program state set by the first"
        );
    }
}
