//! Runs the mock engine as a real control-plane server.
//!
//! This is what ADR-003 means by "each product develops against a mock peer":
//! an Editor or Playout developer starts this, connects to 4400, and gets a
//! peer that refuses exactly where the real engine will.
//!
//! It is a mock and says so on every line of its output. It has no GPU, no
//! renderer and no outputs — a take here moves a state field and nothing
//! reaches a screen.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use gx_contracts::{DeviceTier, RationalRate, Revision, TakeId};
use gx_control_plane::bind::ENGINE_CONTROL_PORT;
use gx_control_transport::Server;
use gx_mock_engine::{describe, MockEngine};

fn main() {
    let mut args = std::env::args().skip(1);
    let mut port = ENGINE_CONTROL_PORT;
    let mut engine = MockEngine::new();
    let mut described = Vec::new();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => match args.next().and_then(|p| p.parse::<u16>().ok()) {
                Some(p) => port = p,
                None => return usage("--port needs a number"),
            },
            "--genlocked" => {
                engine = engine.genlocked(RationalRate::P29_97);
                described.push("genlocked at 29.97");
            }
            "--lan" => {
                engine = engine.over_lan();
                described.push("declaring LAN locality (longer lead)");
            }
            "--tier" => match args.next().as_deref() {
                Some("T0") => engine = engine.with_device_tier(DeviceTier::T0),
                Some("T1") => engine = engine.with_device_tier(DeviceTier::T1),
                Some("T2") => engine = engine.with_device_tier(DeviceTier::T2),
                Some("T3") => engine = engine.with_device_tier(DeviceTier::T3),
                _ => return usage("--tier needs T0, T1, T2 or T3"),
            },
            "--publish" => match args.next() {
                // `id:revision`, so a client has something a take can succeed
                // against without a publish path existing yet.
                Some(spec) => match parse_publish(&spec) {
                    Some((id, revision)) => {
                        described.push("with a published scene");
                        engine.publish(id, revision);
                    }
                    None => return usage("--publish needs id:revision"),
                },
                None => return usage("--publish needs id:revision"),
            },
            "--help" | "-h" => return usage(""),
            other => return usage(&format!("unknown argument {other}")),
        }
    }

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    println!("MOCK ENGINE - not a renderer, nothing reaches an output");
    println!("{}", describe(&engine));
    for note in &described {
        println!("  {note}");
    }

    // Loopback only, and no token: the bind policy permits exactly this and
    // would refuse anything wider (invariant 41).
    let server = match Server::bind(addr, None, engine) {
        Ok(server) => server,
        Err(e) => {
            eprintln!("cannot serve: {e}");
            std::process::exit(1);
        }
    };

    match server.local_addr() {
        Ok(bound) => println!("listening on {bound}"),
        Err(e) => eprintln!("bound, but cannot report the address: {e}"),
    }
    println!("ctrl-c to stop");
    server.serve();
}

fn parse_publish(spec: &str) -> Option<(TakeId, Revision)> {
    let (id, revision) = spec.rsplit_once(':')?;
    if id.is_empty() {
        return None;
    }
    Some((TakeId(id.to_string()), Revision(revision.parse().ok()?)))
}

fn usage(problem: &str) {
    if !problem.is_empty() {
        eprintln!("{problem}\n");
    }
    eprintln!(
        "gx-mock-engine - a valid control-plane peer, for Editor and Playout development

usage: gx-mock-engine [options]

  --port <n>          listen on this port (default {ENGINE_CONTROL_PORT})
  --genlocked         report a locked reference at 29.97 instead of free-run
  --lan               declare LAN locality, which lengthens the commit lead
  --tier <T0..T3>     report this device tier; below T0 refuses live output
  --publish <id:rev>  publish a scene so a take of it can succeed
  --help

Listens on loopback only. The bind policy refuses anything wider without a
token, and this binary never offers one."
    );
    if !problem.is_empty() {
        std::process::exit(2);
    }
}
