#![forbid(unsafe_code)]

//! The render worker binary: the engine, on a socket, with a live clock.
//!
//! This is the real peer an Editor or Playout connects to on 4400. It is not
//! the mock: the device tier is whatever the machine actually has, the clock
//! advances on its own pump, and a take drives a rasteriser. It still claims
//! no scene renderer — Program is a deterministic take key until a scene
//! contract exists (see `lib.rs`).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use gx_asset_plane::AssetPublishServer;
use gx_contracts::{ContentHash, Locality, RationalRate, Revision, TakeId};
use gx_control_plane::bind::ENGINE_CONTROL_PORT;
use gx_control_transport::Server;
use gx_render_worker::recovery::RecoveryJournal;
use gx_render_worker::Engine;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut port = ENGINE_CONTROL_PORT;
    let mut token: Option<String> = None;
    let mut asset_port = None;
    let mut recovery_path: Option<PathBuf> = None;
    let mut lan = false;
    let mut rate = RationalRate::P50;
    let mut publish_specs: Vec<(TakeId, Revision, ContentHash)> = Vec::new();

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
            "--recovery-journal" => match args.next() {
                Some(path) => recovery_path = Some(PathBuf::from(path)),
                None => return usage("--recovery-journal needs a path"),
            },
            "--lan" => lan = true,
            "--rate" => match args.next().as_deref().and_then(parse_rate) {
                Some(r) => rate = r,
                None => return usage("--rate needs 50, 29.97, 59.94, 25, 30 or 60"),
            },
            "--publish" => match args.next().and_then(|s| parse_publish(&s)) {
                Some(spec) => publish_specs.push(spec),
                None => return usage("--publish needs id:revision:sha256"),
            },
            "--token" => match args.next() {
                Some(t) => token = Some(t),
                None => return usage("--token needs a value"),
            },
            "--help" | "-h" => return usage(""),
            other => return usage(&format!("unknown argument {other}")),
        }
    }

    let locality = if lan {
        Locality::Lan
    } else {
        Locality::CoLocated
    };

    // The clock pump owns the passage of time. The engine observes the shared
    // counter; nothing on the control plane can write it (ADR-002).
    let frame_source = Arc::new(AtomicU64::new(0));
    spawn_pump(Arc::clone(&frame_source), rate);

    let mut engine = Engine::new(Arc::clone(&frame_source), locality);
    let tier = engine.device_tier();
    for (id, revision, content_hash) in publish_specs {
        engine.publish_identifier(id, revision, content_hash);
    }
    let recovery = match recovery_path {
        Some(path) => RecoveryJournal::open_at(path),
        None => RecoveryJournal::open(),
    };
    let recovery = match recovery {
        Ok(recovery) => recovery,
        Err(error) => {
            eprintln!("cannot open recovery journal: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = engine.attach_recovery_journal(recovery) {
        eprintln!("cannot restore recovery journal: {error}");
        std::process::exit(1);
    }

    println!("RENDER ENGINE - real device, engine-owned clock");
    println!(
        "  device tier {tier:?} ({})",
        if tier.live_capable() {
            "hardware"
        } else {
            "software fallback, cannot go live"
        }
    );
    println!("  clock: free-running at {}/{}", rate.num, rate.den);
    if token.is_some() {
        println!("  requiring a token on every connection");
    }

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let asset_port = match asset_port.or_else(|| port.checked_add(1)) {
        Some(asset_port) => asset_port,
        None => return usage("--port leaves no asset-plane port"),
    };
    let asset_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), asset_port);
    let server = Server::bind(addr, token.as_deref(), engine).unwrap_or_else(|error| {
        eprintln!("cannot serve control plane: {error}");
        std::process::exit(1);
    });
    let shared_engine = server.engine();
    let asset_server = AssetPublishServer::bind(asset_addr, Arc::clone(&shared_engine))
        .unwrap_or_else(|error| {
            eprintln!("cannot serve asset plane: {error}");
            std::process::exit(1);
        });
    match server.local_addr() {
        Ok(bound) => println!("  listening on {bound}"),
        Err(e) => {
            eprintln!("cannot read local address: {e}");
            std::process::exit(1);
        }
    }
    match asset_server.local_addr() {
        Ok(bound) => println!("  asset publication on {bound}"),
        Err(error) => {
            eprintln!("cannot read asset-plane address: {error}");
            std::process::exit(1);
        }
    }
    spawn_render_loop(shared_engine, frame_source);
    asset_server.serve_in_background();
    println!("ctrl-c to stop");
    server.serve();
}

/// Advance the shared frame counter at the configured rational rate.
///
/// This stands in for the genlock / vsync callback that will drive the clock
/// on a real output adapter (ADR-002). It sleeps in whole-frame intervals
/// derived from the rational rate in integer arithmetic — no float rate, so
/// no drift (invariant 12).
fn spawn_pump(frame_source: Arc<AtomicU64>, rate: RationalRate) {
    thread::spawn(move || {
        let interval = Duration::from_nanos(
            (u128::from(rate.den) * 1_000_000_000 / u128::from(rate.num)) as u64,
        );
        let mut next = Instant::now();
        loop {
            next += interval;
            let now = Instant::now();
            if next > now {
                thread::sleep(next - now);
            }
            frame_source.fetch_add(1, Ordering::Relaxed);
        }
    });
}

/// Emit each newly reached frame without making the control listener own
/// cadence. The bounded media slots ensure a slow consumer cannot stall this
/// loop; skipped observations simply advance to the freshest clock frame.
fn spawn_render_loop(engine: Arc<Mutex<Engine>>, frame_source: Arc<AtomicU64>) {
    thread::spawn(move || {
        let mut emitted = u64::MAX;
        loop {
            let current = frame_source.load(Ordering::Relaxed);
            if current == emitted {
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            let Ok(mut engine) = engine.lock() else {
                eprintln!("render loop stopping: engine lock poisoned");
                return;
            };
            match engine.emit_frame() {
                Ok(emission) => emitted = emission.sample.frame,
                Err(error) => {
                    eprintln!("output emission failed at frame {current}: {error}");
                    emitted = current;
                }
            }
            drop(engine);
            thread::sleep(Duration::from_millis(1));
        }
    });
}

fn parse_rate(s: &str) -> Option<RationalRate> {
    Some(match s {
        "50" => RationalRate::P50,
        "29.97" => RationalRate::P29_97,
        "59.94" => RationalRate::P59_94,
        "25" => RationalRate::P25,
        "30" => RationalRate::P30,
        "60" => RationalRate::P60,
        _ => return None,
    })
}

/// `id:revision:sha256`: an identifier-only publish declares the content hash
/// a take must pin (invariant 61).
fn parse_publish(spec: &str) -> Option<(TakeId, Revision, ContentHash)> {
    let (rest, hash) = spec.rsplit_once(':')?;
    let (id, revision) = rest.rsplit_once(':')?;
    let is_hash = hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if id.is_empty() || !is_hash {
        return None;
    }
    Some((TakeId(id.to_string()), Revision(revision.parse().ok()?), ContentHash(hash.to_string())))
}

fn usage(problem: &str) {
    if !problem.is_empty() {
        eprintln!("error: {problem}");
    }
    eprintln!(
        "gx-render-worker [--port N] [--asset-port N] [--recovery-journal PATH] \
         [--lan] [--rate R] [--publish id:rev:sha256 ...] [--token SECRET]"
    );
    std::process::exit(if problem.is_empty() { 0 } else { 2 });
}
