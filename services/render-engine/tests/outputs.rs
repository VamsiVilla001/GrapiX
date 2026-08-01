//! Output adapters: live versus virtual, and the guarantees around each.
//!
//! The property under test throughout is the one an operator has to be able to
//! trust: whether a frame reaching an output is visible to an audience. Nothing may
//! be ambiguous about that, and nothing may accept frames it cannot transmit.

use std::path::PathBuf;

use grapix_render_core::output::VideoFrame;
use grapix_render_engine::outputs::{
    create_sink, is_live_adapter, OutputAlphaMode, OutputFormat, OutputInstance, OutputSink,
    OutputState, VirtualSink, LIVE_ADAPTER_IDS,
};
use grapix_render_engine::stage::FrameRate;

fn format() -> OutputFormat {
    OutputFormat {
        width: 1920,
        height: 1080,
        frame_rate: FrameRate {
            numerator: 50,
            denominator: 1,
        },
        alpha_mode: OutputAlphaMode::Premultiplied,
        color_space: "rec709".to_string(),
    }
}

fn frame(index: u64) -> VideoFrame {
    VideoFrame {
        width: 4,
        height: 2,
        data: vec![0u8; 4 * 2 * 4],
        frame_index: index,
    }
}

fn cache() -> PathBuf {
    std::env::temp_dir().join("grapix-engine-output-tests")
}

// ---------------------------------------------------------------------------
// Live versus not live
// ---------------------------------------------------------------------------

#[test]
fn only_ndi_decklink_and_aja_are_live() {
    // The whole point of the distinction: an operator must never have to infer from
    // a name whether something is going out.
    assert!(is_live_adapter("ndi"));
    assert!(is_live_adapter("decklink"));
    assert!(is_live_adapter("aja"));

    assert!(!is_live_adapter("null"));
    assert!(!is_live_adapter("virtual"));
    assert!(!is_live_adapter("recording"));

    assert_eq!(LIVE_ADAPTER_IDS.len(), 3);
}

#[test]
fn every_sink_agrees_with_the_live_adapter_list() {
    // A sink whose `is_live` disagreed with the list would make status lie.
    for adapter_id in ["null", "virtual", "recording", "ndi", "decklink", "aja"] {
        let sink = create_sink(adapter_id, &cache(), &serde_json::Value::Null)
            .unwrap_or_else(|error| panic!("{adapter_id} should be constructible: {error}"));
        assert_eq!(
            sink.is_live(),
            is_live_adapter(adapter_id),
            "{adapter_id} disagrees about being live"
        );
    }
}

#[test]
fn an_unknown_adapter_is_refused_and_lists_the_real_ones() {
    // `Box<dyn OutputSink>` is not Debug, so unwrap the error by hand.
    let error = match create_sink("hologram", &cache(), &serde_json::Value::Null) {
        Ok(_) => panic!("an unknown adapter must be refused"),
        Err(error) => error,
    };

    // Never a silent no-op output: that would swallow Program.
    assert!(error.contains("unknown output adapter"));
    assert!(error.contains("virtual"));
    assert!(error.contains("ndi"));
}

// ---------------------------------------------------------------------------
// The virtual output
// ---------------------------------------------------------------------------

#[test]
fn the_virtual_output_is_never_live_and_always_available() {
    let sink = create_sink("virtual", &cache(), &serde_json::Value::Null).expect("virtual");

    // These three properties are the entire contract of the adapter.
    assert!(!sink.is_live(), "the virtual output must never be live");
    assert!(
        sink.available(),
        "it needs no SDK, so it is always available"
    );
    assert_eq!(sink.unavailable_reason(), None);

    // No hardware is involved, so there is nothing to certify against.
    assert!(sink.hardware_certified());
    assert!(sink.name().contains("never live"));
}

#[test]
fn the_virtual_output_accepts_frames_and_says_nothing_leaves_the_machine() {
    let mut instance = OutputInstance::new(
        "out_virtual".to_string(),
        create_sink("virtual", &cache(), &serde_json::Value::Null).expect("virtual"),
    );

    let warnings = instance.configure(format()).expect("configure");
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("no frames leave this machine")),
        "the operator must be told this is headless: {warnings:?}"
    );

    instance.start().expect("start");
    assert!(instance.is_running());
    assert!(!instance.is_live());

    for index in 0..5 {
        assert!(
            instance.send(&frame(index)),
            "frame {index} should be accepted"
        );
    }

    let status = instance.status();
    assert_eq!(status.frames_accepted, 5);
    assert_eq!(status.frames_sent, 5);
    assert_eq!(status.frames_dropped, 0);
    assert_eq!(status.live, false);
    assert_eq!(status.state, "running");
    assert_eq!(status.color_space, "rec709");
}

#[test]
fn the_virtual_output_retains_exactly_one_frame() {
    let mut sink = VirtualSink::new(true);
    sink.configure(&format()).expect("configure");
    sink.start().expect("start");

    assert!(sink.last_frame().is_none());

    sink.send(&frame(1)).expect("send");
    assert_eq!(sink.last_frame().expect("frame").frame_index, 1);

    // One frame, never a growing buffer: a UHD frame is 33 MB.
    sink.send(&frame(2)).expect("send");
    assert_eq!(sink.last_frame().expect("frame").frame_index, 2);

    // Stopping releases it rather than holding a full buffer indefinitely.
    sink.stop();
    assert!(sink.last_frame().is_none());
}

#[test]
fn virtual_frame_retention_can_be_turned_off() {
    let mut sink = VirtualSink::new(false);
    sink.configure(&format()).expect("configure");
    sink.start().expect("start");
    sink.send(&frame(1)).expect("send");

    assert!(
        sink.last_frame().is_none(),
        "retention off means nothing is kept"
    );
}

// ---------------------------------------------------------------------------
// Live adapters without an SDK
// ---------------------------------------------------------------------------

#[test]
fn an_unavailable_live_adapter_refuses_rather_than_swallowing_frames() {
    // An output that silently accepts and discards is the worst possible failure:
    // the operator sees a healthy row and the audience sees nothing.
    for adapter_id in ["decklink", "aja"] {
        let sink = create_sink(adapter_id, &cache(), &serde_json::Value::Null).expect(adapter_id);

        assert!(sink.is_live(), "{adapter_id} is a live adapter");
        assert!(!sink.available(), "{adapter_id} has no SDK here");
        assert!(
            sink.unavailable_reason().is_some(),
            "{adapter_id} must say why"
        );
        assert!(
            !sink.hardware_certified(),
            "{adapter_id} has not been run against a device"
        );

        let mut instance = OutputInstance::new(format!("out_{adapter_id}"), sink);
        let error = instance.configure(format()).expect_err("must refuse");
        assert!(error.contains("unavailable"));
        assert_eq!(instance.state, OutputState::Error);
    }
}

#[test]
fn ndi_reports_honestly_about_its_build_and_certification() {
    let sink = create_sink("ndi", &cache(), &serde_json::Value::Null).expect("ndi");

    assert!(sink.is_live());
    // Never true from a compile-time flag: linking the SDK is not certification.
    assert!(!sink.hardware_certified());

    #[cfg(not(feature = "ndi"))]
    {
        assert!(!sink.available());
        let reason = sink.unavailable_reason().expect("a reason");
        assert!(reason.contains("--features ndi"));
    }
}

// ---------------------------------------------------------------------------
// Instance lifecycle
// ---------------------------------------------------------------------------

#[test]
fn an_output_must_be_configured_before_it_can_start() {
    let mut instance = OutputInstance::new(
        "out".to_string(),
        create_sink("null", &cache(), &serde_json::Value::Null).expect("null"),
    );

    assert_eq!(instance.state, OutputState::Idle);
    let error = instance
        .start()
        .expect_err("must refuse to start unconfigured");
    assert!(error.contains("must be configured"));

    instance.configure(format()).expect("configure");
    assert_eq!(instance.state, OutputState::Configured);
    instance.start().expect("start");
    assert_eq!(instance.state, OutputState::Running);
}

#[test]
fn a_stopped_output_drops_frames_rather_than_accepting_them() {
    let mut instance = OutputInstance::new(
        "out".to_string(),
        create_sink("virtual", &cache(), &serde_json::Value::Null).expect("virtual"),
    );
    instance.configure(format()).expect("configure");
    instance.start().expect("start");
    instance.send(&frame(1));

    instance.stop();
    assert_eq!(instance.state, OutputState::Configured);

    // Not counted as accepted: it never entered the sink.
    assert!(!instance.send(&frame(2)));
    assert_eq!(instance.status().frames_accepted, 1);
}

#[test]
fn starting_resets_the_frame_counters() {
    let mut instance = OutputInstance::new(
        "out".to_string(),
        create_sink("virtual", &cache(), &serde_json::Value::Null).expect("virtual"),
    );
    instance.configure(format()).expect("configure");
    instance.start().expect("start");
    instance.send(&frame(1));
    instance.send(&frame(2));
    assert_eq!(instance.status().frames_sent, 2);

    instance.stop();
    instance.start().expect("restart");

    // A fresh run reports its own numbers rather than a running total across runs.
    assert_eq!(instance.status().frames_sent, 0);
    assert_eq!(instance.status().frames_accepted, 0);
}

#[test]
fn a_failing_send_records_the_error_without_propagating_it() {
    // A failing output must not be able to block the Program clock, so `send`
    // swallows the error into status rather than returning it.
    let mut instance = OutputInstance::new(
        "out_broken".to_string(),
        create_sink("decklink", &cache(), &serde_json::Value::Null).expect("decklink"),
    );

    // Force it into a running state past the refusal, to exercise the send path.
    instance.state = OutputState::Running;
    assert!(!instance.send(&frame(1)));

    let status = instance.status();
    assert_eq!(status.state, "error");
    assert_eq!(status.frames_dropped, 1);
    assert!(status.last_error.expect("an error").contains("unavailable"));
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

#[test]
fn recording_writes_frames_and_stops_at_its_bound() {
    let directory =
        std::env::temp_dir().join(format!("grapix-recording-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);

    let mut instance = OutputInstance::new(
        "out_rec".to_string(),
        create_sink(
            "recording",
            &directory,
            &serde_json::json!({ "recordingName": "test", "maxFrames": 3 }),
        )
        .expect("recording"),
    );

    instance.configure(format()).expect("configure");
    instance.start().expect("start");
    assert!(!instance.is_live());

    for index in 0..5 {
        instance.send(&frame(index));
    }

    let status = instance.status();
    // Bounded, so a forgotten recording cannot fill the disk.
    assert_eq!(status.frames_sent, 3);
    assert_eq!(status.frames_dropped, 2);

    let _ = std::fs::remove_dir_all(&directory);
}

// ---------------------------------------------------------------------------
// Format validation
// ---------------------------------------------------------------------------

#[test]
fn output_format_defaults_are_broadcast_sane() {
    let default = OutputFormat::default();
    assert_eq!(default.width, 1920);
    assert_eq!(default.height, 1080);
    assert_eq!(default.alpha_mode, OutputAlphaMode::Premultiplied);
    assert_eq!(default.color_space, "rec709");
}

#[test]
fn output_format_round_trips_through_camel_case_json() {
    // The Editor and Playout speak camelCase; a snake_case wire format would mean no
    // client could configure an output at all.
    let json = serde_json::json!({
        "width": 3840,
        "height": 2160,
        "frameRate": { "numerator": 60000, "denominator": 1001 },
        "alphaMode": "straight",
        "colorSpace": "rec2020-pq"
    });

    let parsed: OutputFormat = serde_json::from_value(json).expect("parse");
    assert_eq!(parsed.width, 3840);
    assert_eq!(parsed.frame_rate.numerator, 60_000);
    assert_eq!(parsed.alpha_mode, OutputAlphaMode::Straight);
    assert_eq!(parsed.color_space, "rec2020-pq");

    let encoded = serde_json::to_value(&parsed).expect("encode");
    assert!(encoded.get("frameRate").is_some());
    assert!(encoded.get("alphaMode").is_some());
    assert!(encoded.get("colorSpace").is_some());
}

#[test]
fn a_missing_frame_rate_falls_back_rather_than_failing() {
    let parsed: OutputFormat =
        serde_json::from_value(serde_json::json!({ "width": 1280, "height": 720 })).expect("parse");

    assert_eq!(parsed.frame_rate.numerator, 50);
    assert_eq!(parsed.frame_rate.denominator, 1);
}
