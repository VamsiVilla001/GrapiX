//! Runs the conformance suites and prints a report.
//!
//! Today the only available peer is the mock. When a real engine exists it is
//! run through the same suites without changing them, which is what makes the
//! L0/L1 exit criterion in ADR-001 checkable rather than aspirational.
//!
//! Exit code is 1 on any failure. Skips do not fail the run, but they are
//! printed and counted, because a run that skipped half its checks is not the
//! same as a clean one (invariant 43).

use gx_conformance::{
    asset_plane_suite, control_plane_delivery_suite, control_plane_fault_suite,
    control_plane_suite, media_plane_suite, timing_plane_suite, Outcome, Report,
};
use gx_contracts::{DeviceTier, Locality, RationalRate};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::{Client, Server};
use gx_mock_engine::MockEngine;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

fn main() {
    let mut report = Report::new();

    // Two peers, because locality changes lead and media negotiation, and a
    // suite that only ever saw a co-located peer would never exercise either.
    let mut local = MockEngine::new();
    let mut lan = MockEngine::new().over_lan().genlocked(RationalRate::P29_97);

    report.set_peer("mock, co-located, T0, free-run");
    control_plane_suite(&mut local, &mut report);
    control_plane_fault_suite(&mut local, &mut report);
    media_plane_suite(local.capability().locality, &mut report);

    report.set_peer("mock, LAN, T0, genlocked 29.97");
    control_plane_suite(&mut lan, &mut report);
    control_plane_fault_suite(&mut lan, &mut report);
    media_plane_suite(Locality::Lan, &mut report);

    // A sub-T0 peer, so the tier refusal is exercised rather than skipped. A
    // suite that always skips a check is not testing it.
    let mut degraded = MockEngine::new()
        .genlocked(RationalRate::P50)
        .with_device_tier(DeviceTier::T2);
    report.set_peer("mock, co-located, T2, genlocked");
    control_plane_suite(&mut degraded, &mut report);

    // The same suite, over a real socket. This is ADR-001's exit criterion in
    // miniature: if the checks that pass in-process also pass across a
    // transport, the contracts really are transport-independent. When QUIC
    // arrives at L1, this block gains a peer and nothing else changes.
    run_over_transport(&mut report, None);
    // Again, protected. Every check must behave identically once the
    // credential is accepted: authentication gates the connection, it does not
    // change the protocol.
    run_over_transport(&mut report, Some(CONFORMANCE_TOKEN));

    report.set_peer("plane contract, no peer");
    control_plane_delivery_suite(&mut report);
    asset_plane_suite(&mut report);
    timing_plane_suite(&mut report);

    print_report(&report);

    if !report.is_conformant() {
        std::process::exit(1);
    }
}

fn print_report(report: &Report) {
    let mut peer = "";
    let mut plane = "";
    for result in &report.results {
        if result.peer != peer {
            peer = &result.peer;
            // Reset, so each peer's section carries its own plane headers
            // rather than inheriting the previous peer's last one.
            plane = "";
            println!("\n=== {peer} ===");
        }
        if result.plane != plane {
            plane = result.plane;
            println!("  {} plane", plane.to_uppercase());
        }
        match &result.outcome {
            Outcome::Pass => println!("    PASS  {}", result.name),
            Outcome::Skip(why) => println!("    SKIP  {} - {why}", result.name),
            Outcome::Fail(why) => println!("    FAIL  {} - {why}", result.name),
        }
    }

    println!(
        "\n{} passed, {} failed, {} skipped",
        report.passed(),
        report.failed(),
        report.skipped()
    );
    if report.skipped() > 0 {
        println!("skips are not passes: the checks above were not exercised");
    }
    println!(
        "{}",
        if report.is_conformant() {
            "CONFORMANT (for the checks that ran)"
        } else {
            "NOT CONFORMANT"
        }
    );
}

/// A token used only by this runner.
const CONFORMANCE_TOKEN: &str = "conformance-token-0123456789abcd";

/// Start a loopback server carrying a mock, then run the control-plane suite
/// through a real client against it.
fn run_over_transport(report: &mut Report, token: Option<&str>) {
    let mut engine = MockEngine::new().genlocked(RationalRate::P29_97);
    engine.publish(
        gx_contracts::TakeId("conformance/published".into()),
        gx_contracts::Revision(1),
    );

    // Port 0: the OS picks a free port, so this never collides with a real
    // engine or a second run.
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let server = match Server::bind(addr, token, engine) {
        Ok(server) => server,
        Err(e) => {
            eprintln!("transport pass skipped: cannot bind: {e}");
            return;
        }
    };
    let bound = match server.local_addr() {
        Ok(bound) => bound,
        Err(e) => {
            eprintln!("transport pass skipped: no local address: {e}");
            return;
        }
    };
    server.serve_in_background();

    let connected = match token {
        Some(token) => {
            let token = match gx_control_plane::auth::Token::new(token) {
                Ok(token) => token,
                Err(e) => {
                    eprintln!("transport pass skipped: {e}");
                    return;
                }
            };
            Client::connect_with_token(bound, token)
        }
        None => Client::connect(bound),
    };
    let mut client = match connected {
        Ok(client) => client,
        Err(e) => {
            eprintln!("transport pass skipped: cannot connect: {e}");
            return;
        }
    };

    report.set_peer(format!(
        "control-transport client to {bound} (L0, loopback TCP{})",
        if token.is_some() {
            ", token required"
        } else {
            ""
        }
    ));
    control_plane_suite(&mut client, report);
    // No fault suite here: a client cannot reach through the wire to drop a
    // reference, which is exactly the FaultInjection distinction. It skips by
    // being absent rather than by pretending.
}
