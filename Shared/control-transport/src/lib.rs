//! protocol v3 over a stream: the L0 control transport.
//!
//! ADR-001 gives the control plane named-pipe IPC on Windows, Unix-domain
//! sockets on macOS/Linux, and QUIC/TLS at L1. TCP remains available for
//! existing loopback callers, but local IPC is selected explicitly through
//! [`Server::bind_local`] and [`Client::connect_local`].
//!
//! The framing, acknowledgement cache and `SequenceTracker` dispatch are
//! shared for every endpoint. Locality is an optimisation, never a second
//! control-plane protocol (invariant 13).

#![forbid(unsafe_code)]

pub mod auth;
pub mod client;
pub mod server;

pub use auth::{Claims, ClaimsError, Token, TokenError};
pub use client::{Client, Reconciliation, REQUEST_TIMEOUT};
pub use gx_control_plane::bind::Endpoint;
pub use server::{ServeError, Server};

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    #[cfg(windows)]
    use std::path::PathBuf;
    #[cfg(windows)]
    use std::sync::atomic::{AtomicU64, Ordering};

    use gx_contracts::{DeviceTier, RationalRate, ReferenceState, Refusal, Revision, TakeId};
    #[cfg(windows)]
    use gx_control_plane::bind::connect_endpoint;
    #[cfg(windows)]
    use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
    use gx_control_plane::intent::{ClearRequest, TakeAt, TakeRequest};
    use gx_control_plane::message::{
        ClientRequest, EngineEvent, EngineReply, Envelope, OutputConfig,
    };
    use gx_control_plane::peer::{EnginePeer, FaultInjection};
    #[cfg(windows)]
    use gx_control_plane::sequence::{MessageId, Sequence};
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
        engine.publish(
            TakeId("lower-third".into()),
            Revision(4),
            gx_contracts::ContentHash("a".repeat(64)),
        );
        let mut client = connected(engine);

        let reply = client.handle(ClientRequest::Take(TakeRequest {
            take_id: TakeId("lower-third".into()),
            revision: Revision(4),
            content_hash: Some(gx_contracts::ContentHash("a".repeat(64))),
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
            content_hash: Some(gx_contracts::ContentHash("a".repeat(64))),
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
        engine.publish(
            TakeId("t".into()),
            Revision(1),
            gx_contracts::ContentHash("a".repeat(64)),
        );
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
        engine.publish(
            TakeId("t".into()),
            Revision(1),
            gx_contracts::ContentHash("a".repeat(64)),
        );
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
        engine.publish(
            TakeId("t".into()),
            Revision(1),
            gx_contracts::ContentHash("a".repeat(64)),
        );
        let server = Server::bind(loopback(), None, engine).expect("bind");
        let addr = server.local_addr().unwrap();
        server.serve_in_background();

        let mut a = Client::connect(addr).expect("client a");
        let mut b = Client::connect(addr).expect("client b");

        a.handle(ClientRequest::Take(TakeRequest {
            take_id: TakeId("t".into()),
            revision: Revision(1),
            content_hash: Some(gx_contracts::ContentHash("a".repeat(64))),
            at: TakeAt::NextOpportunity,
        }));

        let seen_by_b = b.status().expect("status via b");
        assert!(
            seen_by_b.program.is_some(),
            "the second client must see Program state set by the first"
        );
    }
    #[cfg(windows)]
    fn local_pipe() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        PathBuf::from(format!(
            r"\\.\pipe\grapix-control-transport-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[cfg(windows)]
    fn write_envelope(
        stream: &mut gx_control_plane::bind::ControlStream,
        envelope: &Envelope<ClientRequest>,
    ) {
        let frame = encode(envelope).expect("encode request");
        stream.write_all(&frame).expect("write request");
        stream.flush().expect("flush request");
    }

    #[cfg(windows)]
    fn read_reply(stream: &mut gx_control_plane::bind::ControlStream) -> Envelope<EngineReply> {
        loop {
            let mut prefix = [0u8; LENGTH_PREFIX];
            stream.read_exact(&mut prefix).expect("read reply prefix");
            let len = decode_length(prefix).expect("valid reply length");
            let mut body = vec![0; len];
            stream.read_exact(&mut body).expect("read reply body");
            let envelope: Envelope<serde_json::Value> =
                decode_body(&body).expect("decode envelope");
            if envelope.id.is_reply() {
                return Envelope::new(
                    envelope.id,
                    envelope.seq,
                    serde_json::from_value(envelope.payload).expect("decode reply"),
                );
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn named_pipe_round_trip_acknowledges_duplicates_and_closes_on_a_gap() {
        let pipe = local_pipe();
        let mut engine = MockEngine::new();
        engine.publish(
            TakeId("pipe-take".into()),
            Revision(1),
            gx_contracts::ContentHash("a".repeat(64)),
        );
        let server = Server::bind_local(&pipe, None, engine).expect("bind owner-only named pipe");
        server.serve_in_background();

        let mut client = Client::connect_local(&pipe).expect("connect local client");
        assert!(matches!(
            client.handle(ClientRequest::Status),
            EngineReply::Status(_)
        ));
        drop(client);

        let endpoint = Endpoint::Local(pipe);
        let mut raw = connect_endpoint(&endpoint).expect("connect raw local client");
        let take = Envelope::new(
            MessageId("req.take".into()),
            Sequence(1),
            ClientRequest::Take(TakeRequest {
                take_id: TakeId("pipe-take".into()),
                revision: Revision(1),
                content_hash: Some(gx_contracts::ContentHash("a".repeat(64))),
                at: TakeAt::NextOpportunity,
            }),
        );
        write_envelope(&mut raw, &take);
        let first = read_reply(&mut raw);
        assert!(matches!(first.payload, EngineReply::Taken(ref committed) if committed.frame == 1));

        write_envelope(&mut raw, &take);
        let duplicate = read_reply(&mut raw);
        assert_eq!(
            duplicate.seq, first.seq,
            "a duplicate must receive its recorded acknowledgement"
        );
        assert!(
            matches!(duplicate.payload, EngineReply::Taken(ref committed) if committed.frame == 1)
        );

        let status = Envelope::new(
            MessageId("req.status".into()),
            Sequence(2),
            ClientRequest::Status,
        );
        write_envelope(&mut raw, &status);
        let status = read_reply(&mut raw);
        assert!(
            matches!(status.payload, EngineReply::Status(ref state)
                if state.program.as_ref().is_some_and(|program| program.committed_frame == 1)),
            "a duplicate take must leave only its original Program commit"
        );

        let gap = Envelope::new(
            MessageId("req.gap".into()),
            Sequence(4),
            ClientRequest::Status,
        );
        write_envelope(&mut raw, &gap);
        let mut byte = [0u8; 1];
        assert!(
            !matches!(raw.read(&mut byte), Ok(read) if read > 0),
            "a sequence gap must close the pipe"
        );
    }
}
