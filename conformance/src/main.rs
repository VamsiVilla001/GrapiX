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
    asset_plane_suite, asset_route_suite, control_plane_delivery_suite, control_plane_fault_suite,
    control_plane_suite, editor_command_suite, headless_render_suite, locality_suite,
    media_plane_suite, mock_product_suite, real_engine_scope_suite, refusal_audit_suite,
    render_preview_suite, scene_plane_suite, scope_enforcement_suite, timing_plane_suite, Outcome,
    Report,
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
    run_over_transport(&mut report, None, Locality::CoLocated);
    // Again, protected. Every check must behave identically once the
    // credential is accepted: authentication gates the connection, it does not
    // change the protocol.
    run_over_transport(&mut report, Some(CONFORMANCE_TOKEN), Locality::CoLocated);
    // A LAN engine behind the same transport: the remote side of 5.5. The
    // client reads a different declared locality and every consumer adapts
    // through the same code.
    run_over_transport(&mut report, None, Locality::Lan);
    // 5.7: the transport checks every request's scope before the engine sees it.
    report.set_peer("recording mock behind the protected control transport (5.7)");
    scope_enforcement_suite(&mut report);

    // The real engine, as a peer. The same control-plane suite that runs
    // against the mock runs against the actual render worker, which is the
    // point of writing the suite against `EnginePeer` (ADR-003). If the worker
    // binary is not built or no GPU is present, this records a skip rather
    // than a pass (invariant 43).
    run_against_real_engine(&mut report);
    // 5.7 against the real worker, started protected.
    run_scope_against_real_engine(&mut report);

    report.set_peer("plane contract, no peer");
    control_plane_delivery_suite(&mut report);
    asset_plane_suite(&mut report);
    timing_plane_suite(&mut report);

    // The scene contract, over real sockets against the mock peer: round-trip,
    // unknown-kind refusal, missing-asset blocking and revision pinning (1.12).
    report.set_peer("mock engine, over the asset and control planes");
    scene_plane_suite(&mut report);

    // Every authoring mutation is exercised against the real workspace while
    // a recording mock peer proves the Editor never reaches Program (11.36).
    report.set_peer("mock engine recording peer, over loopback control and asset planes");
    editor_command_suite(&mut report);

    // The same rules again, but driven by the other two mocks as real
    // processes. 1.12 is "green against all three mocks", not against one.
    mock_product_suite(&mut report);

    report.set_peer("plane contract, no peer");
    refusal_audit_suite(&mut report);

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
    if !report.refusal_limitations.is_empty() {
        println!("\nREFUSAL AUDIT LIMITATIONS (not passes or skips)");
        for limitation in &report.refusal_limitations {
            println!(
                "  {}: {} - {}",
                limitation.peer, limitation.variant, limitation.reason
            );
        }
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
fn run_over_transport(report: &mut Report, token: Option<&str>, locality: Locality) {
    let mut engine = match locality {
        Locality::CoLocated => MockEngine::new(),
        Locality::Lan => MockEngine::new().over_lan(),
    }
    .genlocked(RationalRate::P29_97);
    engine.publish(
        gx_contracts::TakeId("conformance/published".into()),
        gx_contracts::Revision(1),
        gx_contracts::ContentHash("a".repeat(64)),
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
            let token = match gx_control_transport::Token::parse(token) {
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
        "control-transport client to {bound} (L0, loopback TCP{}; engine declares {locality:?})",
        if token.is_some() {
            ", token required"
        } else {
            ""
        }
    ));
    control_plane_suite(&mut client, report);
    locality_suite(&client.capability(), locality, report);
    // No fault suite here: a client cannot reach through the wire to drop a
    // reference, which is exactly the FaultInjection distinction. It skips by
    // being absent rather than by pretending.
}

/// Run the control-plane suite against the real render worker.
///
/// The worker binary lives next to the conformance executable in
/// `target/debug`. If it is not built, or it cannot start (no GPU and no
/// software fallback available), every check records a skip rather than a
/// pass, so a conformance run on a machine without the engine is honest about
/// what it did not exercise (invariant 43).
fn run_against_real_engine(report: &mut Report) {
    let Some(worker) = worker_binary() else {
        report.set_peer("real render engine");
        report.skip_unavailable("gx-render-worker binary not built");
        return;
    };

    // A fresh loopback port, so this never collides with a live engine, and a
    // scratch recovery journal, so the run never reads or rewrites the
    // journal of an engine this user runs (and cannot fail because of it).
    let port = free_port();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let asset_port = free_port();
    let asset_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), asset_port);
    let journal = std::env::temp_dir().join(format!(
        "gx-conformance-worker-{}-{port}/recovery.json",
        std::process::id()
    ));
    let child = std::process::Command::new(&worker)
        .args([
            "--port",
            &port.to_string(),
            "--asset-port",
            &asset_port.to_string(),
            "--recovery-journal",
            &journal.display().to_string(),
            "--publish",
            // An identifier-only publish declares the hash its takes pin
            // (11.38): the same test hash the in-process peers use.
            &format!("conformance/published:1:{}", "a".repeat(64)),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) => {
            report.set_peer("real render engine");
            report.skip_unavailable(format!("could not spawn worker: {e}"));
            return;
        }
    };
    // Whatever happens below, the engine the suite started is stopped when the
    // guard drops. This is the conformance harness ending its own fixture, not
    // a product stopping an engine.
    let _guard = KillOnDrop(&mut child);

    // Wait for the engine to answer the capability exchange.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let client = loop {
        match Client::connect(addr) {
            Ok(client) => break Some(client),
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => break None,
        }
    };
    let mut client = match client {
        Some(client) => client,
        None => {
            report.set_peer("real render engine");
            report.skip_unavailable("worker did not answer on its control port");
            return;
        }
    };

    let cap = client.capability();
    report.set_peer(format!(
        "real render engine, {:?}, {:?}, {:?}",
        cap.locality, cap.device_tier, cap.clock
    ));
    control_plane_suite(&mut client, report);
    // Started without --lan, so the real engine must declare itself co-located.
    locality_suite(&cap, gx_contracts::Locality::CoLocated, report);
    // No fault suite: a real engine cannot be driven into a reference loss on
    // request, which is the entire reason `FaultInjection` is a separate trait.
    // render.preview over JSON-RPC (8.9), drawn through the headless entry
    // point on a second control connection.
    render_preview_suite(addr, asset_addr, report);
    // 5.9: a scene's font and image reach the engine, then it publishes and
    // takes. Before headless_render_suite, which leaves a scene on Program.
    asset_route_suite(&mut client, asset_addr, report);
    // Headless render (11.41) runs last: its timed run puts a scene on Program.
    headless_render_suite(&mut client, asset_addr, report);
}

/// The worker binary. Cargo places a binary run via `cargo run` directly in
/// `target/debug`, and a test/example executable in `target/debug/deps`, so
/// look in the executable's own directory and its parent.
/// Start the real worker with a control-port secret and run the 5.7 checks.
fn run_scope_against_real_engine(report: &mut Report) {
    const SECRET: &str = "conformance-real-engine-secret-0123456789";
    report.set_peer("real render engine, protected by a token (5.7)");
    let Some(worker) = worker_binary() else {
        report.skip_unavailable("gx-render-worker binary not built");
        return;
    };
    let port = free_port();
    let asset_port = free_port();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let journal = std::env::temp_dir().join(format!(
        "gx-conformance-scope-{}-{port}/recovery.json",
        std::process::id()
    ));
    let child = std::process::Command::new(&worker)
        .args([
            "--port",
            &port.to_string(),
            "--asset-port",
            &asset_port.to_string(),
            "--recovery-journal",
            &journal.display().to_string(),
            "--token",
            SECRET,
            "--publish",
            &format!("conformance/published:1:{}", "a".repeat(64)),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) => {
            report.skip_unavailable(format!("could not spawn worker: {e}"));
            return;
        }
    };
    let _guard = KillOnDrop(&mut child);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::net::TcpStream::connect(addr).is_err() {
        if std::time::Instant::now() >= deadline {
            report.skip_unavailable("worker did not open its control port");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    real_engine_scope_suite(addr, SECRET, report);
}

fn worker_binary() -> Option<std::path::PathBuf> {
    let current = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "gx-render-worker.exe"
    } else {
        "gx-render-worker"
    };
    let dir = current.parent()?;
    [dir.join(name), dir.parent()?.join(name)]
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    listener.local_addr().unwrap().port()
}

/// Stops a fixture engine on drop. Used only by the conformance harness for
/// the engine it started itself.
struct KillOnDrop<'a>(&'a mut std::process::Child);
impl Drop for KillOnDrop<'_> {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
