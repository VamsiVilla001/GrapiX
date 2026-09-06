//! NDI output safety contracts that are executable without an installed NDI SDK.

use std::path::PathBuf;

use grapix_render_core::output::{VideoFrame, VideoFramePool};
use grapix_render_engine::outputs::{
    create_sink, validate_ndi_format, validate_ndi_options, OutputAlphaMode, OutputFormat, OutputInstance, OutputSink,
    OutputState,
};
use grapix_render_engine::stage::FrameRate;
use grapix_render_engine::protocol::AeFrameColorFormat;

fn cache() -> PathBuf {
    std::env::temp_dir().join("grapix-engine-ndi-output-tests")
}

fn format() -> OutputFormat {
    OutputFormat {
        width: 4,
        height: 2,
        frame_rate: FrameRate {
            numerator: 60,
            denominator: 1,
        },
        color_format: AeFrameColorFormat::Bgra8,
        alpha_mode: OutputAlphaMode::Premultiplied,
        color_space: "rec709".to_string(),
    }
}

fn frame() -> VideoFrame {
    let pool = VideoFramePool::new(1, 4 * 2 * 4).expect("test frame pool");
    VideoFrame {
        width: 4,
        height: 2,
        data: pool.try_acquire().expect("test frame lease"),
        frame_index: 1,
    }
}

#[test]
fn ndi_refuses_non_bgra8_or_non_premultiplied_format_with_actual_values() {
    let mut non_bgra = format();
    non_bgra.color_format = AeFrameColorFormat::Rgba8;
    let error = validate_ndi_format(&non_bgra).expect_err("rgba8 must be refused");
    assert!(error.contains("Rgba8"), "error must name the received color format: {error}");

    let mut straight = format();
    straight.alpha_mode = OutputAlphaMode::Straight;
    let error = validate_ndi_format(&straight).expect_err("straight alpha must be refused");
    assert!(error.contains("Straight"), "error must name the received alpha mode: {error}");
}

#[test]
fn output_format_defaults_color_format_for_older_documents() {
    let parsed: OutputFormat = serde_json::from_value(serde_json::json!({
        "width": 4,
        "height": 2,
        "frameRate": { "numerator": 60, "denominator": 1 },
        "alphaMode": "premultiplied",
        "colorSpace": "rec709"
    }))
    .expect("older format without colorFormat remains valid");
    assert_eq!(parsed.color_format, AeFrameColorFormat::Bgra8);
}
#[test]
fn ndi_source_name_validation_enforces_network_identifier_boundary() {
    for options in [
        serde_json::json!({}),
        serde_json::json!({ "sourceName": "" }),
        serde_json::json!({ "sourceName": "x".repeat(65) }),
        serde_json::json!({ "sourceName": "Program\nPreview" }),
    ] {
        assert!(
            validate_ndi_options(&options).is_err(),
            "invalid NDI source name was accepted: {options}"
        );
    }

    assert!(validate_ndi_options(&serde_json::json!({
        "sourceName": "x".repeat(64),
        "groups": "studio-a"
    }))
    .is_ok());
}

#[cfg(feature = "ndi")]
#[test]
fn ndi_pool_drops_when_every_preallocated_slab_is_leased() {
    use grapix_render_engine::outputs::NdiFramePool;

    let pool = NdiFramePool::new(4, 2, 3).expect("fixed pool");
    let first = pool.try_acquire_for_readback().expect("slab 0");
    let second = pool.try_acquire_for_readback().expect("slab 1");
    let third = pool.try_acquire_for_readback().expect("slab 2");

    // The fourth render tick cannot allocate or wait for the worker. It drops
    // only this NDI handoff and leaves Program free to render its other outputs.
    assert!(pool.try_acquire_for_readback().is_none());
    assert_eq!(pool.stats().dropped_pool_exhausted, 1);

    first.cancel();
    second.cancel();
    third.cancel();
}

#[cfg(not(feature = "ndi"))]
#[test]
fn ndi_without_the_feature_refuses_live_transmission() {
    let mut sink = create_sink(
        "ndi",
        &cache(),
        &serde_json::json!({ "sourceName": "Program" }),
    )
    .expect("an unavailable NDI sink is still describable");

    assert!(sink.is_live());
    assert!(!sink.available());
    assert!(!sink.hardware_certified());
    assert!(sink
        .configure(&format())
        .expect_err("a build without NDI must not swallow Program frames")
        .contains("without --features ndi"));
}

struct AsyncFailureSink {
    failure: Option<String>,
}

impl OutputSink for AsyncFailureSink {
    fn adapter_id(&self) -> &'static str {
        "test-async-failure"
    }

    fn name(&self) -> &'static str {
        "Test async failure"
    }

    fn is_live(&self) -> bool {
        true
    }

    fn configure(&mut self, _format: &OutputFormat) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) {}

    fn send(&mut self, _frame: &VideoFrame) -> Result<bool, String> {
        panic!("a terminal worker failure must prevent further Program handoff")
    }

    fn take_async_error(&mut self) -> Option<String> {
        self.failure.take()
    }
}

#[test]
fn worker_failure_is_contained_as_output_health() {
    let mut output = OutputInstance::new(
        "ndi-program".to_string(),
        Box::new(AsyncFailureSink {
            failure: Some("NDI worker lost its network sender".to_string()),
        }),
    );
    output.configure(format()).expect("configure");
    output.start().expect("start");

    // The Program-side call never propagates the worker error or invokes the
    // failed sink. It turns the one output unhealthy so Engine emits its normal
    // output-health event while the renderer continues with other outputs.
    assert!(!output.send(&frame()));
    assert_eq!(output.state, OutputState::Error);
    assert_eq!(
        output.status().last_error.as_deref(),
        Some("NDI worker lost its network sender")
    );
    assert_eq!(output.status().frames_accepted, 0);
}
