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
use gx_mock_engine::{describe, AssetPublishServer, MockEngine};

fn main() {
    let mut args = std::env::args().skip(1);
    let mut port = ENGINE_CONTROL_PORT;
    let mut asset_port = None;
    let mut engine = MockEngine::new();
    let mut described = Vec::new();
    let mut token: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => match args.next().and_then(|p| p.parse::<u16>().ok()) {
                Some(p) => port = p,
                None => return usage("--port needs a number"),
            },
            "--asset-port" => match args.next().and_then(|p| p.parse::<u16>().ok()) {
                Some(p) => asset_port = Some(p),
                None => return usage("--asset-port needs a number"),
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
            "--token" => match args.next() {
                Some(t) => token = Some(t),
                None => return usage("--token needs a value"),
            },
            "--help" | "-h" => return usage(""),
            other => return usage(&format!("unknown argument {other}")),
        }
    }

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let asset_port = match asset_port.or_else(|| port.checked_add(1)) {
        Some(port) => port,
        None => return usage("--port leaves no asset-plane port"),
    };
    let asset_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), asset_port);
    println!("MOCK ENGINE - not a renderer, nothing reaches an output");
    println!("{}", describe(&engine));
    for note in &described {
        println!("  {note}");
    }

    if token.is_some() {
        println!("  requiring a token on every connection");
    }

    // Loopback, optionally protected. The bind policy permits loopback without
    // a token and refuses anything wider without one (invariant 41).
    let server = match Server::bind(addr, token.as_deref(), engine) {
        Ok(server) => server,
        Err(e) => {
            eprintln!("cannot serve: {e}");
            std::process::exit(1);
        }
    };

    let asset_server = match AssetPublishServer::bind(asset_addr, server.engine()) {
        Ok(server) => server,
        Err(e) => {
            eprintln!("cannot serve asset plane: {e}");
            std::process::exit(1);
        }
    };

    match server.local_addr() {
        Ok(bound) => println!("control listening on {bound}"),
        Err(e) => eprintln!("bound, but cannot report the control address: {e}"),
    }
    match asset_server.local_addr() {
        Ok(bound) => println!("asset publish listening on {bound}"),
        Err(e) => eprintln!("bound, but cannot report the asset address: {e}"),
    }
    let _asset_listener = asset_server.serve_in_background();
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

  --port <n>          control listener (default {ENGINE_CONTROL_PORT})
  --asset-port <n>    scene publication listener (default control port + 1)
  --genlocked         report a locked reference at 29.97 instead of free-run
  --lan               declare LAN locality, which lengthens the commit lead
  --tier <T0..T3>     report this device tier; below T0 refuses live output
  --publish <id:rev>  preload a scene identifier so a take can succeed
  --token <secret>    require this token on every control connection
  --help

Both listeners bind loopback. Scene documents publish on the restartable asset
plane; cue/take/clear stay on the intent-only control plane."
    );
    if !problem.is_empty() {
        std::process::exit(2);
    }
}
