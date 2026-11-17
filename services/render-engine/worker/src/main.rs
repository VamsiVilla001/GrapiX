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
use gx_render_worker::engine::Restored;
use gx_render_worker::recovery::RecoveryJournal;
use gx_render_worker::Engine;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut port = ENGINE_CONTROL_PORT;
    let mut token: Option<String> = None;
    let mut asset_port = None;
    let mut recovery_path: Option<PathBuf> = None;
    let mut package_dir: Option<PathBuf> = None;
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
            "--package-dir" => match args.next() {
                Some(dir) => package_dir = Some(PathBuf::from(dir)),
                None => return usage("--package-dir needs a path"),
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

    // 5.10: a LAN-declared engine reads no path, so the two flags together
    // are a contradiction the operator must resolve, not one to guess at.
    if lan && package_dir.is_some() {
        return usage(
            "--lan declares an engine that is handed assets over the network, so it reads no package path: drop --package-dir",
        );
    }
    let locality = if lan {
        Locality::Lan
    } else {
        Locality::CoLocated
    };
    // 2.12: the engine's log, from here on. Kept for the life of the process, and
    // shared with the interrupt handler (2.16), which is what ends it on Ctrl+C.
    let log: SharedLog = Arc::new(Mutex::new(gx_telemetry::sink::init_process_logging(
        "engine", "worker",
    )));
    install_interrupt_handler(&log);

    // The clock pump owns the passage of time. The engine observes the shared
    // counter; nothing on the control plane can write it (ADR-002).
    let frame_source = Arc::new(AtomicU64::new(0));
    spawn_pump(Arc::clone(&frame_source), rate);

    let mut engine = Engine::new(Arc::clone(&frame_source), locality);
    let tier = engine.device_tier();
    for (id, revision, content_hash) in publish_specs {
        engine.publish_identifier(id, revision, content_hash);
    }
    // 5.8: packages by local path, from this directory only. Checked here so
    // a mistyped directory stops the engine instead of refusing every package.
    // Resolved here as every package request resolves it, so a directory on
    // a volume that cannot be resolved also stops it (5.8 review).
    if let Some(dir) = package_dir {
        let checked = std::path::absolute(&dir)
            .and_then(|absolute| absolute.canonicalize().map(|_| absolute));
        match checked {
            Ok(dir) if dir.is_dir() => {
                println!("  packages by local path from {}", dir.display());
                engine.set_package_directory(dir);
            }
            Ok(_) => {
                return usage(&format!(
                    "--package-dir {} is not a directory",
                    dir.display()
                ))
            }
            Err(error) => {
                return usage(&format!(
                    "--package-dir {} cannot be resolved: {error}",
                    dir.display()
                ))
            }
        }
    }
    let recovery = match recovery_path {
        Some(path) => RecoveryJournal::open_at(path),
        None => RecoveryJournal::open(),
    };
    let recovery = match recovery {
        Ok(recovery) => recovery,
        Err(error) => fatal(
            &log,
            "recovery.open_failed",
            format!("cannot open recovery journal: {error}"),
        ),
    };
    match engine.attach_recovery_journal(recovery) {
        Ok(restored) => report_drops(&restored),
        Err(error) => fatal(
            &log,
            "recovery.restore_failed",
            format!("cannot restore recovery journal: {error}"),
        ),
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
    let adapter = engine.gpu_description();
    // The epoch, clock source and reference this run starts with, from the
    // engine's own status answer, so the start record says which run it is.
    let start_status = match gx_control_plane::EnginePeer::handle(
        &mut engine,
        gx_control_plane::message::ClientRequest::Status,
    ) {
        gx_control_plane::message::EngineReply::Status(status) => Some(status),
        _ => None,
    };
    let server = match Server::bind(addr, token.as_deref(), engine) {
        Ok(server) => server,
        Err(error) => fatal(
            &log,
            "engine.bind_failed",
            format!("cannot serve control plane: {error}"),
        ),
    };
    let shared_engine = server.engine();
    let asset_server = match AssetPublishServer::bind(asset_addr, Arc::clone(&shared_engine)) {
        Ok(server) => server,
        Err(error) => fatal(
            &log,
            "engine.bind_failed",
            format!("cannot serve asset plane: {error}"),
        ),
    };
    let control = match server.local_addr() {
        Ok(bound) => bound,
        Err(e) => fatal(
            &log,
            "engine.bind_failed",
            format!("cannot read local address: {e}"),
        ),
    };
    println!("  listening on {control}");
    let assets = match asset_server.local_addr() {
        Ok(bound) => bound,
        Err(error) => fatal(
            &log,
            "engine.bind_failed",
            format!("cannot read asset-plane address: {error}"),
        ),
    };
    println!("  asset publication on {assets}");
    tracing::info!(
        event = "engine.start",
        epoch = start_status.as_ref().map(|s| s.epoch.0),
        clock = start_status.as_ref().map(|s| format!("{:?}", s.clock)).as_deref(),
        reference = start_status.as_ref().map(|s| format!("{:?}", s.reference)).as_deref(),
        version = env!("CARGO_PKG_VERSION"),
        tier = ?tier,
        live_capable = tier.live_capable(),
        adapter = adapter.as_deref(),
        rate = format!("{}/{}", rate.num, rate.den).as_str(),
        locality = ?locality,
        control = %control,
        assets = %assets,
        token_required = token.is_some(),
        log_directory = log_directory(&log).as_deref(),
    );
    spawn_render_loop(shared_engine, frame_source);
    asset_server.serve_in_background();
    println!("ctrl-c to stop");
    server.serve();
    // The listener returns only when it can no longer accept (invariant 50):
    // the engine is ending by its own code, and says so before it does (2.12).
    tracing::error!(
        event = "engine.stop",
        reason = "the control listener stopped"
    );
    finish_log(&log);
}

/// The process's log, shared between the main thread and the interrupt handler
/// (2.16). Whichever ends the process takes the guard out and finishes it.
type SharedLog = Arc<Mutex<Option<gx_telemetry::sink::LogGuard>>>;

/// Why the engine stopped when a console control event ended it. The handler is
/// the same for each event and is not told which, so the reason names them all.
const INTERRUPT_REASON: &str =
    "a console control event (Ctrl+C, Ctrl+Break, window close, logoff or shutdown)";

/// Write the log out and end it. The lock is held while the log finishes, so an
/// interrupt that arrives during a normal exit waits for it instead of ending
/// the process in the middle of the last lines.
fn finish_log(log: &SharedLog) {
    let Ok(mut slot) = log.lock() else { return };
    if let Some(guard) = slot.take() {
        let _ = guard.finish();
    }
}

fn log_directory(log: &SharedLog) -> Option<String> {
    let slot = log.lock().ok()?;
    slot.as_ref()
        .map(|guard| guard.directory().display().to_string())
}

/// What an interrupt does to the record: say why the engine stopped, then write
/// the log out. The handler then ends the process.
fn record_interrupt(log: &SharedLog) {
    tracing::info!(event = "engine.stop", reason = INTERRUPT_REASON);
    finish_log(log);
}

/// Make Ctrl+C an orderly stop, on record. Without a handler a Windows process
/// ended from the console runs none of its own code, so the log has no
/// `engine.stop` and no `log.stop`, and the file of an engine that was stopped
/// on purpose looks like the file of one that died. `#![forbid(unsafe_code)]`
/// rules out a hand-written console handler; this is the `ctrlc` crate.
///
/// Ctrl+C and Ctrl+Break end the engine with `engine.stop`, `log.stop` and exit
/// code 0 (run live, `docs/evidence/2.16`). A console window close, logoff or
/// shutdown reach the same handler, but Windows ends the process as soon as the
/// crate's system handler returns, which is before this one has finished: the
/// file usually ends at `engine.stop` without `log.stop`, and the next start names
/// it as unfinished. That is a limit of the crate, not something to hide.
fn install_interrupt_handler(log: &SharedLog) {
    let log = Arc::clone(log);
    let installed = ctrlc::set_handler(move || {
        record_interrupt(&log);
        std::process::exit(0);
    });
    if let Err(error) = installed {
        eprintln!(
            "cannot watch for Ctrl+C ({error}): an interrupt will end the engine without a stop record"
        );
        tracing::warn!(event = "engine.interrupt_handler_failed", detail = %error);
    }
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
                tracing::error!(
                    event = "engine.render_loop_stopped",
                    detail = "engine lock poisoned"
                );
                return;
            };
            match engine.emit_frame() {
                Ok(emission) => emitted = emission.sample.frame,
                Err(error) => {
                    eprintln!("output emission failed at frame {current}: {error}");
                    tracing::error!(
                        event = "output.emit_failed",
                        frame = current,
                        detail = %error,
                    );
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
    if id.is_empty() || !ContentHash(hash.to_owned()).is_sha256() {
        return None;
    }
    Some((
        TakeId(id.to_string()),
        Revision(revision.parse().ok()?),
        ContentHash(hash.to_string()),
    ))
}

/// Name, on stderr, the scenes a restore dropped (5.11). The engine host does
/// not drain a running worker's stderr, so the lines stop at a small budget
/// and point to the drop report beside the journal, which names every one.
/// Stop the process for a reason the operator must act on: on record, on
/// stderr, and with the log written out before the exit.
fn fatal(log: &SharedLog, event: &str, detail: String) -> ! {
    eprintln!("{detail}");
    tracing::error!(event, detail = detail.as_str());
    finish_log(log);
    std::process::exit(1);
}

fn report_drops(restored: &Restored) {
    let count = restored.dropped.len();
    tracing::info!(
        event = "recovery.restored",
        dropped = count,
        scenes = ?restored.dropped,
    );
    if count == 0 {
        return;
    }
    eprintln!("recovery: {count} journaled scene(s) dropped; re-publish them");
    let mut budget = 2048_usize;
    let mut shown = 0;
    for scene in &restored.dropped {
        let line = format!("recovery: dropped scene {scene}");
        if line.len() > budget {
            break;
        }
        budget -= line.len();
        eprintln!("{line}");
        shown += 1;
    }
    if shown < count {
        eprintln!("recovery: and {} more", count - shown);
    }
    match &restored.report {
        Some(Ok(path)) => eprintln!(
            "recovery: every dropped scene is listed in {}",
            path.display()
        ),
        Some(Err(error)) => eprintln!("recovery: the drop report could not be written: {error}"),
        None => {}
    }
}

fn usage(problem: &str) {
    if !problem.is_empty() {
        eprintln!("error: {problem}");
    }
    eprintln!(
        "gx-render-worker [--port N] [--asset-port N] [--recovery-journal PATH] \
         [--lan] [--package-dir DIR] [--rate R] [--publish id:rev:sha256 ...] [--token SECRET]"
    );
    std::process::exit(if problem.is_empty() { 0 } else { 2 });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    /// 2.16: an interrupt leaves `engine.stop` with its reason and then
    /// `log.stop`, as the last two lines of the file, at info.
    #[test]
    fn an_interrupt_writes_engine_stop_and_finishes_the_log() {
        let directory = std::env::temp_dir().join(format!(
            "gx-worker-interrupt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos())
        ));
        std::fs::create_dir_all(&directory).expect("a scratch folder is created");
        let guard = gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new(
            "engine", "worker", &directory,
        ))
        .expect("the sink starts");
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        let log: SharedLog = Arc::new(Mutex::new(Some(guard)));

        tracing::subscriber::with_default(subscriber, || record_interrupt(&log));

        let file = std::fs::read_dir(directory.join("engine"))
            .expect("the product folder exists")
            .flatten()
            .next()
            .expect("one file was written")
            .path();
        let records: Vec<serde_json::Value> = std::fs::read_to_string(file)
            .expect("the file reads")
            .lines()
            .map(|line| serde_json::from_str(line).expect("every line is JSON"))
            .collect();
        let events: Vec<&str> = records
            .iter()
            .map(|record| record["event"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(events, ["log.start", "engine.stop", "log.stop"]);
        assert_eq!(records[1]["level"], "info");
        assert_eq!(records[1]["fields"]["reason"], INTERRUPT_REASON);
        // The guard was taken, so a normal exit that follows finishes nothing twice.
        assert!(log.lock().expect("lock").is_none());
        finish_log(&log);
        let _ = std::fs::remove_dir_all(directory);
    }
}
