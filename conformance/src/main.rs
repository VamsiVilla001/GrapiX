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
use gx_mock_engine::MockEngine;

fn main() {
    let mut report = Report::new();

    // Two peers, because locality changes lead and media negotiation, and a
    // suite that only ever saw a co-located peer would never exercise either.
    let mut local = MockEngine::new();
    let mut lan = MockEngine::new().over_lan().genlocked(RationalRate::P29_97);

    println!("peer: {}", gx_mock_engine::describe(&local));
    control_plane_suite(&mut local, &mut report);
    control_plane_fault_suite(&mut local, &mut report);
    media_plane_suite(local.capability().locality, &mut report);

    println!("peer: {}", gx_mock_engine::describe(&lan));
    control_plane_suite(&mut lan, &mut report);
    control_plane_fault_suite(&mut lan, &mut report);
    media_plane_suite(Locality::Lan, &mut report);

    // A sub-T0 peer, so the tier refusal is exercised rather than skipped. A
    // suite that always skips a check is not testing it.
    let mut degraded = MockEngine::new()
        .genlocked(RationalRate::P50)
        .with_device_tier(DeviceTier::T2);
    println!("peer: {}", gx_mock_engine::describe(&degraded));
    control_plane_suite(&mut degraded, &mut report);

    control_plane_delivery_suite(&mut report);
    asset_plane_suite(&mut report);
    timing_plane_suite(&mut report);

    print_report(&report);

    if !report.is_conformant() {
        std::process::exit(1);
    }
}

fn print_report(report: &Report) {
    let mut plane = "";
    for result in &report.results {
        if result.plane != plane {
            plane = result.plane;
            println!("\n{} plane", plane.to_uppercase());
        }
        match &result.outcome {
            Outcome::Pass => println!("  PASS  {}", result.name),
            Outcome::Skip(why) => println!("  SKIP  {} - {why}", result.name),
            Outcome::Fail(why) => println!("  FAIL  {} - {why}", result.name),
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
