//! Drain the adapter-owned AE frame ring, so a producer can be measured without back-pressure.
//!
//! `AE-F1`'s ring holds four slots and refuses rather than overwrites once they are all ready — proven
//! live, and correct. It also means a producer measured with **no consumer** stops after four frames, so
//! any throughput number taken that way measures the refusal path, not the frame path.
//!
//! This is the consumer half, and nothing more: it takes each ready frame, optionally verifies the
//! descriptor's checksum-backed geometry, releases the lease, and prints what it saw. It performs no
//! render, no output, and no Program work — `render_program_frame` is where a frame becomes Program, and
//! that path is `AE-F2a`'s, already covered by its own tests.
//!
//! Usage:
//!   ae-ring-drain --session <GRAPIX_AE_RUNTIME_SESSION_ID> [--seconds 30] [--expect-frames N]

use std::time::{Duration, Instant};

use grapix_render_engine::ae_ingress::AeProgramFrameSource;

#[cfg(windows)]
fn main() {
    use grapix_render_engine::ae_ring_source::MappedAeProgramFrameSource;

    let mut session = String::new();
    let mut seconds = 30u64;
    let mut expect_frames: Option<u64> = None;
    let mut wait_seconds = 30u64;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--session" => session = arguments.next().unwrap_or_default(),
            "--seconds" => seconds = arguments.next().and_then(|value| value.parse().ok()).unwrap_or(30),
            "--expect-frames" => expect_frames = arguments.next().and_then(|value| value.parse().ok()),
            "--wait-seconds" => wait_seconds = arguments.next().and_then(|value| value.parse().ok()).unwrap_or(30),
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    if session.is_empty() {
        session = std::env::var("GRAPIX_AE_RUNTIME_SESSION_ID").unwrap_or_default();
    }
    if session.is_empty() {
        eprintln!("a runtime session id is required (--session or GRAPIX_AE_RUNTIME_SESSION_ID)");
        std::process::exit(2);
    }

    // The adapter creates the mapping lazily, on its first ring publish, so a consumer started first
    // finds nothing. Waiting is the correct behaviour rather than exiting: the alternative is a start
    // ordering the operator has to get right by hand, and a drain that exits silently makes a producer
    // look like it back-pressures for no reason.
    let mapping = MappedAeProgramFrameSource::mapping_name_for_session(&session);
    let open_deadline = Instant::now() + Duration::from_secs(wait_seconds);
    let mut source = loop {
        match MappedAeProgramFrameSource::open(mapping.clone(), std::process::id() as u64, 0, None) {
            Ok(source) => break source,
            Err(error) => {
                if Instant::now() >= open_deadline {
                    eprintln!("could not open the adapter ring: {}", error.detail);
                    std::process::exit(1);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };
    let slots = source.ring_slot_count();

    let started = Instant::now();
    let deadline = started + Duration::from_secs(seconds);
    let mut drained = 0u64;
    let mut errors = 0u64;
    let mut first_frame: Option<u64> = None;
    let mut last_frame: Option<u64> = None;
    let mut gaps = 0u64;

    while Instant::now() < deadline {
        match source.take_any_ready_frame() {
            Ok(Some((frame_id, slot_index))) => {
                // Sequence continuity is the one thing a drain can prove for free: the producer
                // publishes ascending frame ids, so a gap means a frame was refused or lost upstream.
                if let Some(previous) = last_frame {
                    if frame_id > previous + 1 {
                        gaps += 1;
                    }
                }
                if first_frame.is_none() {
                    first_frame = Some(frame_id);
                }
                last_frame = Some(frame_id);
                drained += 1;
                source.release_frame(slot_index);
            }
            Ok(None) => std::thread::sleep(Duration::from_micros(500)),
            Err(error) => {
                errors += 1;
                if let Some(slot) = error.slot_index {
                    source.release_frame(slot);
                }
                if errors <= 5 {
                    eprintln!("ring read error: {}", error.detail);
                }
            }
        }
    }

    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "{}",
        serde_json::json!({
            "session": session,
            "ringSlots": slots,
            "elapsedSeconds": (elapsed * 1000.0).round() / 1000.0,
            "drained": drained,
            "framesPerSecond": if elapsed > 0.0 { (drained as f64 / elapsed * 1000.0).round() / 1000.0 } else { 0.0 },
            "firstFrame": first_frame,
            "lastFrame": last_frame,
            "sequenceGaps": gaps,
            "errors": errors,
        })
    );
    if let Some(expected) = expect_frames {
        if drained < expected {
            eprintln!("drained {drained} frames, expected at least {expected}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("the AE frame ring is a Windows shared-memory mapping; this tool is Windows-only");
    std::process::exit(2);
}
