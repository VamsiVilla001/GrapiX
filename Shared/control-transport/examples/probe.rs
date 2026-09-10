//! Smoke probe: drive a running engine over the control transport.
//!
//! Run against a live worker:
//!   cargo run -p gx-control-transport --example probe -- <port>

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use gx_control_plane::intent::{TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::Client;
use gx_contracts::{Revision, TakeId};

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .expect("usage: probe <port>");
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);

    let mut client = Client::connect(addr).expect("connect + capability exchange");
    let cap = client.capability();
    println!(
        "capability: protocol {} epoch {} {:?} tier {:?} clock {:?} ref {:?} live {}",
        cap.protocol,
        cap.epoch.0,
        cap.locality,
        cap.device_tier,
        cap.clock,
        cap.reference,
        cap.live_allowed
    );

    let status = client
        .request(ClientRequest::Status)
        .expect("status request");
    match status {
        EngineReply::Status(s) => println!(
            "status: frame {} timebase {}/{} program {:?} degradations {}",
            s.current_frame,
            s.timebase.num,
            s.timebase.den,
            s.program.as_ref().map(|p| p.take_id.0.as_str()),
            s.degradations.len()
        ),
        other => panic!("expected Status, got {other:?}"),
    }

    let take = client
        .request(ClientRequest::Take(TakeRequest {
            take_id: TakeId("lower-third".into()),
            revision: Revision(1),
            at: TakeAt::NextOpportunity,
        }))
        .expect("take request");
    match take {
        EngineReply::Taken(c) => println!(
            "take committed: frame {} timebase {}/{} clock {:?}",
            c.frame, c.timebase.num, c.timebase.den, c.clock
        ),
        other => panic!("expected Taken, got {other:?}"),
    }

    let status2 = client
        .request(ClientRequest::Status)
        .expect("status after take");
    match status2 {
        EngineReply::Status(s) => println!(
            "status after take: frame {} program {:?}",
            s.current_frame,
            s.program
                .as_ref()
                .map(|p| (p.take_id.0.as_str(), p.committed_frame))
        ),
        other => panic!("expected Status, got {other:?}"),
    }

    println!("SMOKE OK");
}
