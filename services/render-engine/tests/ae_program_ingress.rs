//! Deterministic AE-F2a ingress harness.
//!
//! Every producer below is scripted. These tests exercise Program's descriptor
//! contract without an After Effects host, adapter SDK, or network transport.

use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use grapix_render_core::output::{VideoFrame, VideoFramePool};
use grapix_render_engine::ae_ingress::{
    AeFrameSourceError, AeIngressSession, AeLeasedFrame, AeNegotiatedFormat, AeProgramFrameSource,
    AeProgramSource, AeSessionOrigin,
};
use grapix_render_engine::auth::{Permission, UserRole, VerifiedIdentity};
use grapix_render_engine::capabilities::{
    ConnectionPrincipal, CpuInfo, EngineCapabilities, EngineFeatures, EngineLimits, GpuInfo, OsInfo,
};
use grapix_render_engine::config::EngineConfig;
use grapix_render_engine::engine::Engine;
use grapix_render_engine::outputs::{OutputAlphaMode, OutputFormat, OutputSink, RecordingSink};
use grapix_render_engine::protocol::{
    AeFrameColorFormat, AeFrameDescriptor, AeFrameStatus, Envelope, RequestType, PROTOCOL_VERSION,
};
use grapix_render_engine::stage::{AeCompositionClock, FrameRate};

const RATE: FrameRate = FrameRate {
    numerator: 60_000,
    denominator: 1_001,
};
const REVISION: u64 = 41;
const WIDTH: u32 = 4;
const HEIGHT: u32 = 3;
const STRIDE: u32 = WIDTH * 4;

fn session(origin: AeSessionOrigin) -> AeIngressSession {
    AeIngressSession {
        origin,
        ring_generation: 7,
        composition_item_id: 99,
        format: AeNegotiatedFormat {
            width: WIDTH,
            height: HEIGHT,
            stride: STRIDE,
            color_format: AeFrameColorFormat::Bgra8,
            alpha_mode: "premultiplied".to_string(),
            color_space: "rec709".to_string(),
        },
    }
}

fn source() -> AeProgramSource {
    AeProgramSource::new(
        session(AeSessionOrigin::LocalSharedMemory),
        // 60,000 ticks per 1,001 seconds: exactly 60000/1001 frames per second.
        AeCompositionClock::from_decimal_strings("1001", "60000").expect("valid clock"),
        RATE,
        REVISION,
    )
    .expect("local session and reconciled clock")
}

fn descriptor(request: &grapix_render_engine::ae_ingress::AeFrameRequest) -> AeFrameDescriptor {
    AeFrameDescriptor {
        ring_generation: 7,
        slot_index: 2,
        frame_id: request.frame,
        data_revision: request.data_revision,
        composition_item_id: request.composition_item_id,
        requested_time: request.requested_time.clone(),
        evaluated_time: request.requested_time.clone(),
        presentation_deadline_nanos: request.deadline_nanos,
        width: WIDTH,
        height: HEIGHT,
        stride: STRIDE,
        color_format: AeFrameColorFormat::Bgra8,
        alpha_mode: "premultiplied".to_string(),
        color_space: "rec709".to_string(),
        status: AeFrameStatus::Ready,
    }
}

#[test]
fn scripted_producer_sweeps_one_hundred_requested_frames_exactly() {
    let mut program = source();

    for frame in 1..=100 {
        let deadline = RATE.deadline_nanos(frame);
        let request = program.issue(frame, deadline).expect("one request per due frame");
        let published = descriptor(&request);

        assert_eq!(published.frame_id, request.frame, "frame {frame}");
        assert_eq!(published.evaluated_time, request.requested_time, "frame {frame}");
        assert_eq!(published.data_revision, request.data_revision, "frame {frame}");

        let accepted = program
            .accept(&published, frame, deadline)
            .unwrap_or_else(|error| panic!("frame {frame} must be accepted: {}", error.code()));
        assert_eq!(accepted.frame, request.frame);
        assert_eq!(accepted.data_revision, request.data_revision);
        assert!(accepted.presented_before_deadline);
    }

    let counters = program.counters();
    assert_eq!(counters.requested, 100);
    assert_eq!(counters.ready_before_deadline, 100);
    assert_eq!(counters.late, 0);
    assert_eq!(counters.missed, 0);
    assert_eq!(counters.stale_revision, 0);
    assert_eq!(counters.rejected_format, 0);
}

#[test]
fn out_of_order_completion_is_refused() {
    let mut program = source();
    let four = program.issue(4, RATE.deadline_nanos(4)).expect("frame four request");
    let five = program.issue(5, RATE.deadline_nanos(5)).expect("frame five request");

    program.accept(&descriptor(&five), 5, five.deadline_nanos).expect("frame five");
    let error = program
        .accept(&descriptor(&four), 5, five.deadline_nanos)
        .expect_err("older completion must not run Program backwards");
    assert_eq!(error.code(), "AE_FRAME_OUT_OF_ORDER");
}

#[test]
fn duplicate_completion_is_refused_and_never_presented_twice() {
    let mut program = source();
    let five = program.issue(5, RATE.deadline_nanos(5)).expect("frame five request");
    let published = descriptor(&five);

    program.accept(&published, 5, five.deadline_nanos).expect("first completion");
    let error = program
        .accept(&published, 5, five.deadline_nanos)
        .expect_err("duplicate completion must be refused");
    assert_eq!(error.code(), "AE_FRAME_DUPLICATE");
    assert_eq!(program.counters().ready_before_deadline, 1);
}

#[test]
fn stale_revision_is_refused_and_counted() {
    let mut program = source();
    let request = program.issue(1, RATE.deadline_nanos(1)).expect("request");
    let mut published = descriptor(&request);
    published.data_revision += 1;

    let error = program
        .accept(&published, 1, request.deadline_nanos)
        .expect_err("stale revision must be refused");
    assert_eq!(error.code(), "AE_STALE_REVISION");
    assert_eq!(program.counters().stale_revision, 1);
}

#[test]
fn wrong_colour_format_and_stride_are_refused_and_counted() {
    let mut program = source();
    let colour_request = program.issue(1, RATE.deadline_nanos(1)).expect("colour request");
    let mut wrong_colour = descriptor(&colour_request);
    wrong_colour.color_format = AeFrameColorFormat::Rgba8;
    assert_eq!(
        program
            .accept(&wrong_colour, 1, colour_request.deadline_nanos)
            .expect_err("colour mismatch must be refused")
            .code(),
        "AE_REJECTED_FORMAT"
    );

    let stride_request = program.issue(2, RATE.deadline_nanos(2)).expect("stride request");
    let mut wrong_stride = descriptor(&stride_request);
    wrong_stride.stride += 4;
    assert_eq!(
        program
            .accept(&wrong_stride, 2, stride_request.deadline_nanos)
            .expect_err("stride mismatch must be refused")
            .code(),
        "AE_REJECTED_FORMAT"
    );
    assert_eq!(program.counters().rejected_format, 2);
}

#[test]
fn late_completion_is_counted_without_blocking_the_next_deadline() {
    let mut program = source();
    let first = program.issue(1, RATE.deadline_nanos(1)).expect("first request");
    let accepted = program
        .accept(&descriptor(&first), 1, first.deadline_nanos + 1)
        .expect("the currently due frame is accepted even when late");
    assert!(!accepted.presented_before_deadline);

    let second = program.issue(2, RATE.deadline_nanos(2)).expect("next request");
    let accepted = program
        .accept(&descriptor(&second), 2, second.deadline_nanos)
        .expect("late completion must not block the following frame");
    assert_eq!(accepted.frame, 2);
    assert_eq!(program.counters().late, 1);
}

#[test]
fn unreturned_request_is_missed_and_late_arrival_is_historical() {
    let mut program = source();
    let request = program.issue(7, RATE.deadline_nanos(7)).expect("request");

    assert_eq!(program.abandon_before(8), vec![7]);
    assert_eq!(program.counters().missed, 1);
    assert_eq!(program.in_flight_len(), 0);

    let error = program
        .accept(&descriptor(&request), 8, request.deadline_nanos)
        .expect_err("abandoned frame must never be queued later");
    assert_eq!(error.code(), "AE_FRAME_HISTORICAL");
}

#[test]
fn non_local_session_cannot_present_at_all() {
    let result = AeProgramSource::new(
        session(AeSessionOrigin::Remote),
        AeCompositionClock::from_decimal_strings("1001", "60000").expect("valid clock"),
        RATE,
        REVISION,
    );

    match result {
        Err(error) => assert_eq!(error.code(), "AE_SESSION_NOT_LOCAL"),
        Ok(_) => panic!("remote sessions are structurally refused"),
    }
}

#[test]
fn recording_sink_preserves_known_premultiplied_bgra_bytes_exactly() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let mut sink = RecordingSink::new(directory.path().to_path_buf(), "transparent-pattern".to_string(), 1);
    let format = OutputFormat {
        width: WIDTH,
        height: HEIGHT,
        frame_rate: RATE,
        color_format: AeFrameColorFormat::Bgra8,
        alpha_mode: OutputAlphaMode::Premultiplied,
        color_space: "rec709".to_string(),
    };
    sink.configure(&format).expect("configure deterministic recording");
    sink.start().expect("start deterministic recording");

    // BGRA8 premultiplied: transparent, opaque, and partial-alpha samples all occur.
    let expected: [u8; (WIDTH * HEIGHT * 4) as usize] = [
        0, 0, 0, 0, 17, 34, 51, 255, 32, 16, 8, 64, 64, 48, 16, 128,
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ];
    let pool = VideoFramePool::new(1, expected.len()).expect("frame pool");
    let mut lease = pool.try_acquire().expect("frame lease");
    lease.as_mut_slice().copy_from_slice(&expected);
    let frame = VideoFrame {
        width: WIDTH,
        height: HEIGHT,
        data: lease,
        frame_index: 17,
    };

    assert!(sink.send(&frame).expect("record raw frame"));
    let actual = std::fs::read(directory.path().join("transparent-pattern-000017.bgra"))
        .expect("recorded raw frame");
    assert_eq!(actual.as_slice(), expected.as_slice());
}

struct ScriptedFrame {
    descriptor: AeFrameDescriptor,
    bytes: Vec<u8>,
}

struct ScriptedFrameSource {
    frames: Vec<ScriptedFrame>,
    next: usize,
    take_error: Option<AeFrameSourceError>,
    releases: Arc<AtomicUsize>,
}

impl ScriptedFrameSource {
    fn frames(frames: Vec<ScriptedFrame>, releases: Arc<AtomicUsize>) -> Self {
        Self { frames, next: 0, take_error: None, releases }
    }

    fn error(error: AeFrameSourceError, releases: Arc<AtomicUsize>) -> Self {
        Self { frames: Vec::new(), next: 0, take_error: Some(error), releases }
    }
}

impl AeProgramFrameSource for ScriptedFrameSource {
    fn take_ready_frame(
        &mut self,
        _frame: u64,
    ) -> Result<Option<AeLeasedFrame<'_>>, AeFrameSourceError> {
        if let Some(error) = self.take_error.take() {
            return Err(error);
        }
        let index = self.next;
        self.next += 1;
        Ok(self.frames.get(index).map(|frame| AeLeasedFrame {
            descriptor: &frame.descriptor,
            bytes: &frame.bytes,
        }))
    }

    fn release_frame(&mut self, _slot_index: u32) {
        self.releases.fetch_add(1, Ordering::SeqCst);
    }
}

fn engine_capabilities(config: &EngineConfig) -> EngineCapabilities {
    EngineCapabilities {
        engine_id: "ae-ingress-test".to_string(),
        engine_name: config.identity.name.clone(),
        software_version: "0.2.0".to_string(),
        protocol_version: PROTOCOL_VERSION,
        scene_document_versions: vec![1],
        stage_document_versions: vec![1],
        os: OsInfo {
            platform: "test".to_string(),
            release: "0".to_string(),
            arch: "x86_64".to_string(),
        },
        cpu: CpuInfo { model: "Test".to_string(), logical_cores: 8 },
        gpu: GpuInfo {
            adapter: "Test adapter".to_string(),
            backend: "test".to_string(),
            device_type: "DiscreteGpu".to_string(),
            driver: "test".to_string(),
            driver_info: "test".to_string(),
            vendor_id: 0,
            device_id: 0,
            memory_bytes_estimate: 8 * 1024 * 1024 * 1024,
        },
        limits: EngineLimits {
            max_texture_dimension_2d: 16_384,
            max_texture_dimension_3d: 2_048,
            max_texture_array_layers: 256,
            max_buffer_size: 1 << 31,
            max_bind_groups: 8,
            max_logical_canvas_width: config.stage.max_logical_canvas_width,
            max_logical_canvas_height: config.stage.max_logical_canvas_height,
            max_tile_size: 4_096,
            max_active_scenes: config.stage.max_active_scenes,
            max_warm_scenes: 3,
            max_preview_pixels: config.preview.max_pixels,
            max_message_bytes: config.security.max_message_bytes,
            max_upload_bytes: config.assets.max_upload_bytes,
            max_outputs: config.stage.max_outputs,
            max_surfaces: config.stage.max_surfaces,
        },
        supported_texture_formats: vec!["rgba8unorm".to_string()],
        supported_video_formats: Vec::new(),
        supported_shader_features: vec!["wgsl".to_string()],
        output_adapters: Vec::new(),
        features: EngineFeatures {
            tile_rendering: true,
            headless_rendering: true,
            virtual_canvas: true,
            multi_surface_mapping: true,
            scene_patching: true,
            preview_streaming: false,
            shared_memory_preview: false,
            native_text_render: true,
            packaged_font_files: true,
            native_video_decode: false,
            native_3d_render: true,
            hardware_encoding: false,
            surface_warp_compositing: false,
            edge_blend_compositing: false,
            distributed_rendering: false,
            device_loss_recovery: true,
        },
        supported_transitions: vec!["cut".to_string()],
        supported_quality_profiles: vec!["PROGRAM_HD".to_string()],
        rendered_object_types: vec!["rect".to_string()],
        transports: vec!["test".to_string()],
    }
}

fn playout_principal() -> ConnectionPrincipal {
    ConnectionPrincipal::identified(
        "ae-ingress-test",
        VerifiedIdentity {
            user_id: "operator".to_string(),
            username: "Operator".to_string(),
            role: UserRole::PlayoutOperator,
            session_id: "test-session".to_string(),
            permissions: BTreeSet::from([Permission::OutputManage]),
        },
    )
}

fn command(message_type: &str, payload: serde_json::Value, sequence: u64) -> Envelope {
    Envelope {
        protocol_version: PROTOCOL_VERSION,
        message_id: format!("ae-ingress-{sequence}"),
        request_id: Some(format!("request-{sequence}")),
        engine_id: None,
        scene_ref: None,
        timestamp_ms: 0,
        message_type: message_type.to_string(),
        requires_ack: true,
        sequence,
        direction: "client-to-engine".to_string(),
        payload,
    }
}

fn configured_engine(directory: &std::path::Path, color_space: &str, max_frames: u64) -> Engine {
    configured_engine_with_rate(directory, color_space, max_frames, RATE)
}

fn configured_engine_with_rate(
    directory: &std::path::Path,
    color_space: &str,
    max_frames: u64,
    rate: FrameRate,
) -> Engine {
    configured_engine_with_geometry(directory, color_space, max_frames, rate, WIDTH, HEIGHT)
}

fn configured_engine_with_geometry(
    directory: &std::path::Path,
    color_space: &str,
    max_frames: u64,
    rate: FrameRate,
    width: u32,
    height: u32,
) -> Engine {
    let mut config = EngineConfig::default();
    config.assets.cache_directory = directory.display().to_string();
    let mut engine = Engine::without_gpu(
        config.clone(),
        "ae-ingress-test".to_string(),
        engine_capabilities(&config),
    );
    let principal = playout_principal();
    let format = serde_json::json!({
        "width": width,
        "height": height,
        "frameRate": { "numerator": rate.numerator, "denominator": rate.denominator },
        "colorFormat": "bgra8",
        "alphaMode": "premultiplied",
        "colorSpace": color_space,
    });
    engine
        .handle(
            RequestType::OutputConfigure,
            &command(
                "output.configure",
                serde_json::json!({
                    "outputId": "recording",
                    "adapterId": "recording",
                    "format": format,
                    "options": { "recordingName": "ae", "maxFrames": max_frames },
                }),
                1,
            ),
            &principal,
        )
        .expect("configure recording output");
    engine
        .handle(
            RequestType::OutputStart,
            &command("output.start", serde_json::json!({ "outputId": "recording" }), 2),
            &principal,
        )
        .expect("start recording output");
    engine
}

fn srgb_session() -> AeIngressSession {
    let mut value = session(AeSessionOrigin::LocalSharedMemory);
    value.format.color_space = "srgb".to_string();
    value
}

fn scripted_frame(request: &grapix_render_engine::ae_ingress::AeFrameRequest, bytes: Vec<u8>) -> ScriptedFrame {
    let mut published = descriptor(request);
    published.color_space = "srgb".to_string();
    ScriptedFrame { descriptor: published, bytes }
}

fn install_scripted_ae_source(
    engine: &mut Engine,
    source: ScriptedFrameSource,
) {
    engine
        .set_ae_program_source(
            srgb_session(),
            AeCompositionClock::from_decimal_strings("1001", "60000").expect("valid clock"),
            REVISION,
        )
        .expect("install local AE ingress");
    engine
        .set_ae_program_frame_source(Box::new(source))
        .expect("attach scripted source");
}

#[cfg(windows)]
#[test]
// The two live gates each claim the ring's single consumer slot, so they cannot share a process
// concurrently: run the ignored set with `--test-threads=1`.
#[ignore = "requires a managed AE runtime publishing a live ring frame; run with --test-threads=1"]
fn live_ae_ring_frame_reaches_recording_sink_byte_identically() {
    use grapix_render_engine::ae_ring_source::MappedAeProgramFrameSource;

    let session_id = std::env::var("GRAPIX_AE_RUNTIME_SESSION_ID")
        .expect("a managed AE runtime session id");
    let mapping = MappedAeProgramFrameSource::mapping_name_for_session(&session_id);
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let live_rate = FrameRate {
        numerator: 2_997,
        denominator: 100,
    };
    let mut engine = configured_engine_with_geometry(directory.path(), "srgb", 1, live_rate, 1920, 1080);
    let mut session = srgb_session();
    session.composition_item_id = 1;
    session.ring_generation = 1;
    session.format.width = 1920;
    session.format.height = 1080;
    session.format.stride = 7680;
    session.format.color_space = "sRGB".to_string();
    let clock = AeCompositionClock::from_decimal_strings("800", "23976").expect("LOWER_THIRD clock");
    assert_eq!(clock.composition_rate(), Some(live_rate));
    assert_eq!(engine.program_frame_rate(), live_rate);
    engine
        .set_ae_program_source(
            session,
            clock,
            0,
        )
        .expect("install live local AE ingress");
    // The request now travels on the protocol, and it has to come first.
    //
    // Every earlier version of this test had the frame pushed in from outside - a `checkout … ring`
    // typed at the legacy file channel - so it proved the ring and proved nothing about who asks. The
    // engine asks here: `request_ae_program_frame` posts `RENDER_FRAME` through the requester, which is
    // the wiring `AE-F2b` computed a schedule for and never had.
    //
    // Order is forced by the adapter: it creates the ring mapping lazily, on its first publish, so
    // there is nothing to open until a frame has been asked for.
    let token = std::env::var("GRAPIX_AE_RUNTIME_TOKEN").expect("a managed AE runtime token");
    let requester = grapix_render_engine::ae_runtime_client::connect(
        grapix_render_engine::ae_runtime_client::AeRuntimeClientConfig::new(&session_id, token),
    )
    .expect("connect the engine's own requester to the live adapter");
    engine
        .set_ae_render_requester(requester)
        .expect("install the live frame requester");

    // Four frame periods of lead, which is what `AE-F3` measured as the knee - and one period is
    // provably impossible: After Effects services this request from its idle callback, whose own period
    // measured ~46.9 ms against a 33.4 ms frame period at 29.97. Asking for punctuality inside one
    // period would be asserting that the host runs faster than it does.
    let request = engine
        .request_ae_program_frame(1, 4 * 33_366_700)
        .expect("issue one live request");
    assert_eq!(request.requested_time.value, "800");
    assert_eq!(request.requested_time.scale, "23976");
    assert_eq!(
        engine.ae_render_requester_status().map(|status| status.submitted),
        Some(1),
        "the scheduled frame was handed to the requester, not merely computed"
    );

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut seen_feedback = Vec::new();
    let source = loop {
        match MappedAeProgramFrameSource::open(
            mapping.clone(),
            std::process::id() as u64,
            0,
            Some(1),
        ) {
            Ok(source) => break source,
            Err(error) => {
                // The requester's own account of what the wire did, so a silent non-publish names its
                // refusal instead of only saying "no mapping".
                seen_feedback.extend(engine.apply_ae_render_feedback());
                assert!(
                    std::time::Instant::now() < deadline,
                    "the adapter never published a frame for the engine's request: {} \
                     (requester {:?}, feedback {:?})",
                    error.detail,
                    engine.ae_render_requester_status(),
                    seen_feedback
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    };
    engine
        .set_ae_program_frame_source(Box::new(source))
        .expect("attach live ring source");

    assert!(engine.has_running_outputs(), "live recording output is running");
    let mut delivered = 0usize;
    for _ in 0..10 {
        match engine.render_program_frame(1) {
            Ok(count) if count != 0 => {
                delivered = count;
                break;
            }
            Ok(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(error) if error.starts_with("AE_REJECTED_FORMAT") => {
                panic!("egress rejected the live frame before diagnostics could run: {error}");
            }
            Err(error) => panic!("live AE frame failed before delivery: {error}"),
        }
    }
    assert_eq!(
        delivered,
        1,
        "one running output received the live frame: delivered={delivered} outputs={}",
        engine.outputs_payload()
    );
    let recorded = std::fs::read(directory.path().join("recordings").join("ae-000001.bgra"))
        .expect("recorded live Program frame");
    assert_eq!(recorded.len(), (1920 * 1080 * 4) as usize);
    assert!(recorded.iter().any(|byte| *byte != 0), "live frame bytes were recorded");
    assert_eq!(engine.ae_program_counters().expect("AE counters").ready_before_deadline, 1);
}

#[test]
fn accepted_ae_frame_reaches_recording_sink_byte_identically_and_releases_its_lease() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let releases = Arc::new(AtomicUsize::new(0));
    let mut engine = configured_engine(directory.path(), "srgb", 1);
    install_scripted_ae_source(
        &mut engine,
        ScriptedFrameSource::frames(Vec::new(), Arc::clone(&releases)),
    );
    let request = engine
        .request_ae_program_frame(1, RATE.deadline_nanos(1))
        .expect("request one");
    let expected: Vec<u8> = (0..(WIDTH * HEIGHT * 4)).map(|value| value as u8).collect();
    engine
        .set_ae_program_frame_source(Box::new(ScriptedFrameSource::frames(
            vec![scripted_frame(&request, expected.clone())],
            Arc::clone(&releases),
        )))
        .expect("replace scripted source");

    assert_eq!(engine.render_program_frame(1).expect("accepted AE frame"), 1);
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read(directory.path().join("recordings").join("ae-000001.bgra"))
            .expect("recorded AE frame"),
        expected
    );
}

#[test]
fn egress_format_disagreement_refuses_without_writing_and_releases_its_lease() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let releases = Arc::new(AtomicUsize::new(0));
    let mut engine = configured_engine(directory.path(), "rec709", 1);
    install_scripted_ae_source(
        &mut engine,
        ScriptedFrameSource::frames(Vec::new(), Arc::clone(&releases)),
    );
    let request = engine
        .request_ae_program_frame(1, RATE.deadline_nanos(1))
        .expect("request one");
    engine
        .set_ae_program_frame_source(Box::new(ScriptedFrameSource::frames(
            vec![scripted_frame(&request, vec![7; (WIDTH * HEIGHT * 4) as usize])],
            Arc::clone(&releases),
        )))
        .expect("replace scripted source");

    let error = engine
        .render_program_frame(1)
        .expect_err("rec709 egress must refuse the sRGB AE bytes");
    assert!(error.starts_with("AE_REJECTED_FORMAT"));
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(engine.ae_program_counters().expect("AE counters").rejected_format, 1);
    assert!(!directory.path().join("recordings").join("ae-000001.bgra").exists());
}

#[test]
fn acquired_lease_is_returned_when_the_frame_source_errors() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let releases = Arc::new(AtomicUsize::new(0));
    let mut engine = configured_engine(directory.path(), "srgb", 1);
    install_scripted_ae_source(
        &mut engine,
        ScriptedFrameSource::error(
            AeFrameSourceError {
                slot_index: Some(23),
                detail: "scripted mapping read failure".to_string(),
            },
            Arc::clone(&releases),
        ),
    );

    let error = engine
        .render_program_frame(1)
        .expect_err("source failure is explicit");
    assert!(error.contains("scripted mapping read failure"));
    assert_eq!(releases.load(Ordering::SeqCst), 1);
}

#[test]
fn ae_staging_slab_is_reused_across_identical_geometry() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let releases = Arc::new(AtomicUsize::new(0));
    let mut engine = configured_engine(directory.path(), "srgb", 32);
    install_scripted_ae_source(
        &mut engine,
        ScriptedFrameSource::frames(Vec::new(), Arc::clone(&releases)),
    );
    let initial_allocations = engine.ae_program_staging_allocations();
    let mut frames = Vec::new();
    for frame in 1..=20 {
        let request = engine
            .request_ae_program_frame(frame, RATE.deadline_nanos(frame))
            .expect("one request");
        frames.push(scripted_frame(
            &request,
            vec![frame as u8; (WIDTH * HEIGHT * 4) as usize],
        ));
    }
    engine
        .set_ae_program_frame_source(Box::new(ScriptedFrameSource::frames(
            frames,
            Arc::clone(&releases),
        )))
        .expect("replace scripted source");

    for frame in 1..=20 {
        assert_eq!(engine.render_program_frame(frame).expect("accepted frame {frame}"), 1);
    }
    assert_eq!(engine.ae_program_staging_allocations(), initial_allocations);
    assert_eq!(releases.load(Ordering::SeqCst), 20);
}


#[test]
fn changed_negotiated_geometry_replaces_the_single_staging_slab_once() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let releases = Arc::new(AtomicUsize::new(0));
    let mut engine = configured_engine(directory.path(), "srgb", 1);
    install_scripted_ae_source(
        &mut engine,
        ScriptedFrameSource::frames(Vec::new(), Arc::clone(&releases)),
    );
    let initial_allocations = engine.ae_program_staging_allocations();
    let mut changed = srgb_session();
    changed.format.width = WIDTH * 2;
    changed.format.stride = changed.format.width * 4;

    engine
        .set_ae_program_source(
            changed,
            AeCompositionClock::from_decimal_strings("1001", "60000").expect("valid clock"),
            REVISION,
        )
        .expect("replace AE source with a new negotiated geometry");

    assert_eq!(engine.ae_program_staging_allocations(), initial_allocations + 1);
}

// ---------------------------------------------------------------------------
// AE-F2b — bounded lead-time scheduling, its policy, and its counters.
// ---------------------------------------------------------------------------

/// A source that owns no frames and exists only to report a ring size to the engine.
struct RingCapacitySource {
    slots: u32,
}

impl AeProgramFrameSource for RingCapacitySource {
    fn take_ready_frame(
        &mut self,
        _frame: u64,
    ) -> Result<Option<AeLeasedFrame<'_>>, AeFrameSourceError> {
        Ok(None)
    }

    fn release_frame(&mut self, _slot_index: u32) {}

    fn ring_slot_count(&self) -> Option<u32> {
        Some(self.slots)
    }
}

/// The whole loop shape, 100 ticks: the window fills, each frame is asked for **once**, and the
/// pipeline neither saturates nor changes depth while every frame presents on time.
///
/// This is the test that would fail if the window re-requested frames already in flight, or if a
/// depth-3 pipeline against a capacity-3 ring reported spurious back-pressure in steady state.
#[test]
fn the_lead_window_asks_for_each_frame_once_and_settles_at_its_configured_depth() {
    let mut program = source();
    let depth = program.pipeline().effective_depth();
    assert_eq!(depth, 3, "50ms of lead over a 16.68ms period is three frames");

    let mut first_requested_at: std::collections::BTreeMap<u64, u64> =
        std::collections::BTreeMap::new();

    for tick in 1..=100u64 {
        // The clock's request point: one period before this frame's deadline.
        let requested_at = RATE.deadline_nanos(tick).saturating_sub(RATE.frame_duration_nanos());
        for request in program.issue_window(tick, requested_at) {
            assert!(
                first_requested_at.insert(request.frame, tick).is_none(),
                "frame {} was requested twice, most recently at tick {tick}",
                request.frame
            );
        }

        // Presentation, on time, exactly as the clock's second stage does it.
        let deadline = RATE.deadline_nanos(tick);
        let published = descriptor(&program.request_for(tick, deadline).expect("on-frame instant"));
        let accepted = program
            .accept(&published, tick, deadline)
            .unwrap_or_else(|error| panic!("tick {tick} must present: {}", error.code()));
        assert!(accepted.presented_before_deadline, "tick {tick}");
    }

    // Frames 1..=102 were each asked for exactly once: three in the first window, then one per tick.
    let counters = program.counters();
    assert_eq!(counters.requested, 102);
    assert_eq!(first_requested_at.len(), 102);
    assert_eq!(counters.ready_before_deadline, 100);
    assert_eq!(counters.late, 0);
    assert_eq!(counters.missed, 0);

    // The lead itself: a frame is requested `depth - 1` ticks before its own tick, which is what puts
    // its request three periods ahead of its deadline instead of one.
    for frame in 4..=100u64 {
        assert_eq!(
            first_requested_at.get(&frame).copied(),
            Some(frame - (depth as u64 - 1)),
            "frame {frame} must be requested {} ticks early",
            depth - 1
        );
    }

    assert_eq!(
        counters.in_flight_saturated, 0,
        "a depth that equals the ring capacity must not report back-pressure in steady state"
    );
    assert_eq!(counters.lead_depth_reduced, 0);
    assert_eq!(program.pipeline().effective_depth(), depth);
}

/// A stalled producer drains rather than wedges: the frames Program has passed are abandoned, and the
/// window keeps asking. Frames in flight stay bounded by the ring throughout.
#[test]
fn a_stalled_producer_abandons_what_program_passed_and_keeps_the_window_moving() {
    let mut program = source();
    let capacity = program.pipeline().capacity();
    assert_eq!(program.issue_window(1, 0).len(), 3, "the first window fills the ring");

    for tick in 2..=20u64 {
        let requested_at = RATE.deadline_nanos(tick).saturating_sub(RATE.frame_duration_nanos());
        let issued = program.issue_window(tick, requested_at);
        assert_eq!(
            issued.len(),
            1,
            "tick {tick} abandons the frame Program passed and asks for one more"
        );
        assert!(
            program.in_flight_len() <= capacity,
            "tick {tick} left {} frames in flight against a capacity of {capacity}",
            program.in_flight_len()
        );
    }

    let counters = program.counters();
    assert_eq!(counters.requested, 22, "three in the first window, then one per tick");
    assert_eq!(counters.missed, 19, "every frame Program passed undelivered is one miss");
    assert_eq!(counters.ready_before_deadline, 0);
    assert_eq!(
        counters.in_flight_saturated, 0,
        "a drained ring is not saturation: nothing here is competing for a slot"
    );
}

/// The capacity guard, reached the only way it can be: by mixing in the pre-`AE-F2b` single-request
/// API, which issues outside the window and knows nothing about the ring's depth.
///
/// Through `issue_window` alone this branch is unreachable by construction — the depth never exceeds
/// the capacity and every tick drains what Program passed — so the guard exists to bound the ledger
/// against *any* caller, not to catch a pipeline that misbehaves.
#[test]
fn a_full_in_flight_set_stops_the_window_and_shrinks_the_lead_depth() {
    let mut program = source();
    let capacity = program.pipeline().capacity();
    for frame in 5..5 + capacity as u64 {
        program
            .issue(frame, RATE.deadline_nanos(frame))
            .unwrap_or_else(|| panic!("frame {frame} is requestable through the AE-F2a API"));
    }
    assert_eq!(program.in_flight_len(), capacity);

    // Frame 1's window wants frames the ring has no room for, and nothing below it can be drained.
    assert!(program.issue_window(1, 0).is_empty(), "no capacity remains for a new frame");
    let counters = program.counters();
    assert_eq!(counters.in_flight_saturated, 1, "counted once for the tick, not once per frame");
    assert_eq!(counters.lead_depth_reduced, 1);
    assert_eq!(program.pipeline().effective_depth(), 2);
    assert_eq!(counters.requested, capacity as u64, "saturation issues nothing");
}

/// Back-pressure from the ring shrinks the depth; a clean second of frames restores exactly one step.
#[test]
fn backpressure_shrinks_the_depth_and_a_clean_run_restores_it() {
    let mut program = source();
    program.note_backpressure();
    assert_eq!(program.pipeline().effective_depth(), 2);
    assert_eq!(program.counters().ring_backpressured, 1);
    assert_eq!(program.counters().lead_depth_reduced, 1);

    for frame in 1..=60u64 {
        let deadline = RATE.deadline_nanos(frame);
        let request = program.issue(frame, deadline).expect("request");
        program.accept(&descriptor(&request), frame, deadline).expect("on-time frame");
    }

    assert_eq!(program.pipeline().effective_depth(), 3, "one clean second restores one step");
    assert_eq!(program.counters().lead_depth_restored, 1);
}

/// The asymmetry the policy turns on: a late frame must never shrink an already-shallow pipeline.
#[test]
fn late_frames_never_shrink_the_lead_depth() {
    let mut program = source();
    let depth = program.pipeline().effective_depth();

    for frame in 1..=30u64 {
        let deadline = RATE.deadline_nanos(frame);
        let request = program.issue(frame, deadline).expect("request");
        let accepted = program
            .accept(&descriptor(&request), frame, deadline + 1_000_000)
            .expect("a late frame that is still due is presented");
        assert!(!accepted.presented_before_deadline, "frame {frame}");
    }

    assert_eq!(program.counters().late, 30);
    assert_eq!(program.counters().lead_depth_reduced, 0);
    assert_eq!(
        program.pipeline().effective_depth(),
        depth,
        "shrinking a late pipeline would only make it later"
    );
}

/// A frame whose deadline has already passed is not requested; the rest of the window still is.
#[test]
fn a_window_skips_only_the_frame_whose_deadline_has_passed() {
    let mut program = source();
    let issued: Vec<u64> = program
        .issue_window(1, RATE.deadline_nanos(1) + 1)
        .into_iter()
        .map(|request| request.frame)
        .collect();

    assert_eq!(
        issued,
        vec![2, 3],
        "frame 1 is already historical; 2 and 3 have deadlines still ahead"
    );
}

/// A data change invalidates work in flight, and the old renders must diagnose as stale — not as
/// frames nobody asked for.
#[test]
fn a_revision_change_supersedes_in_flight_requests_and_refuses_their_old_renders() {
    let mut program = source();
    let old = program.issue_window(1, 0);
    assert_eq!(old.len(), 3);
    let stale_descriptor = descriptor(&old[0]);
    assert_eq!(stale_descriptor.data_revision, REVISION);

    let revised = program.set_data_revision(REVISION + 1);
    assert_eq!(
        revised.iter().map(|request| request.frame).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "every outstanding frame must be asked for again at the new revision"
    );
    assert!(revised.iter().all(|request| request.data_revision == REVISION + 1));
    assert_eq!(program.counters().revision_superseded, 3);
    assert_eq!(program.in_flight_len(), 3, "the frames are still wanted, at the new revision");

    // The render that was already under way arrives against the superseded request.
    let error = program
        .accept(&stale_descriptor, 1, RATE.deadline_nanos(1))
        .expect_err("a render of superseded data must not reach Program");
    assert_eq!(
        error.code(),
        "AE_STALE_REVISION",
        "keeping the request is what preserves this diagnosis instead of AE_FRAME_UNREQUESTED"
    );

    // Re-requested and re-rendered at the new revision, frame 1 presents normally.
    let reissued = program.issue(1, RATE.deadline_nanos(1)).expect("frame 1 is requestable again");
    assert_eq!(reissued.data_revision, REVISION + 1);
    let accepted = program
        .accept(&descriptor(&reissued), 1, RATE.deadline_nanos(1))
        .expect("the new-revision render is the one Program wanted");
    assert_eq!(accepted.data_revision, REVISION + 1);
}

/// An unchanged revision is not a data change and must not churn the pipeline.
#[test]
fn setting_the_same_revision_supersedes_nothing() {
    let mut program = source();
    program.issue_window(1, 0);

    assert!(program.set_data_revision(REVISION).is_empty());
    assert_eq!(program.counters().revision_superseded, 0);
}

/// The ring is the physical bound: a two-slot mapping leaves room for one frame in flight.
#[test]
fn a_real_ring_slot_count_bounds_the_lead_depth() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let mut engine = configured_engine(directory.path(), "srgb", 1);
    engine
        .set_ae_program_source(
            srgb_session(),
            AeCompositionClock::from_decimal_strings("1001", "60000").expect("valid clock"),
            REVISION,
        )
        .expect("install local AE ingress");
    assert_eq!(
        engine.ae_program_pipeline().expect("installed").effective_depth(),
        3,
        "the conservative default stands until a ring reports its size"
    );

    engine
        .set_ae_program_frame_source(Box::new(RingCapacitySource { slots: 2 }))
        .expect("attach a two-slot ring");

    let pipeline = engine.ae_program_pipeline().expect("installed");
    assert_eq!(pipeline.capacity(), 1, "one slot is reserved for the publish in progress");
    assert_eq!(pipeline.effective_depth(), 1);
    assert_eq!(
        engine.request_ae_program_frames(1, 0).len(),
        1,
        "a one-slot pipeline asks for exactly the frame it needs"
    );
}

/// The `PL4`/`CB4` handoff: the facts are in status, and a non-AE engine's status is unchanged.
#[test]
fn status_reports_the_pipeline_and_its_counters_only_with_an_ae_source() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let releases = Arc::new(AtomicUsize::new(0));
    let mut engine = configured_engine(directory.path(), "srgb", 1);

    assert!(
        engine.status_payload(false).get("aeProgram").is_none(),
        "an engine with no AE source must not grow a block describing one"
    );

    install_scripted_ae_source(
        &mut engine,
        ScriptedFrameSource::frames(Vec::new(), Arc::clone(&releases)),
    );
    engine.request_ae_program_frames(1, 0);
    engine.note_ae_program_backpressure();

    let status = engine.status_payload(false);
    let ae = status.get("aeProgram").expect("an AE source publishes its facts");
    assert_eq!(ae["leadDepth"], 2, "back-pressure reduced the depth in force");
    assert_eq!(ae["configuredLeadDepth"], 3);
    assert_eq!(ae["ringCapacity"], 3);
    assert_eq!(ae["inFlight"], 3);
    assert_eq!(ae["requested"], 3);
    assert_eq!(ae["ringBackpressured"], 1);
    assert_eq!(ae["leadDepthReduced"], 1);
    assert_eq!(ae["leadDepthRestored"], 0);
    assert_eq!(ae["inFlightSaturated"], 0);
    assert_eq!(ae["revisionSuperseded"], 0);
}

/// The real `ProgramClock` loop, driven for a fraction of a second against a stalled producer.
///
/// Every other test here calls the scheduling surface directly. This one runs the actual clock — its
/// request point, its window call, its presentation sleep and its render branch — because the wiring
/// between the loop and the pipeline is exactly the part a unit test cannot prove.
///
/// The producer never returns a frame, which is the failure that matters twice over: a stalled After
/// Effects must not make the engine ask for frames without bound, **and** it must not wedge the
/// pipeline with requests that can never be presented. This test is why `issue_window` drains dead
/// requests: before it did, the clock stayed punctual, never skipped, never abandoned, and Program
/// stopped asking for frames permanently.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_program_clock_keeps_asking_while_a_stalled_producer_delivers_nothing() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let releases = Arc::new(AtomicUsize::new(0));
    let mut engine = configured_engine(directory.path(), "srgb", 8);
    install_scripted_ae_source(
        &mut engine,
        ScriptedFrameSource::frames(Vec::new(), Arc::clone(&releases)),
    );
    assert!(engine.has_running_outputs(), "the clock only renders while an output is running");
    assert_eq!(engine.program_frame_rate(), RATE);

    let engine = Arc::new(tokio::sync::Mutex::new(engine));
    let clock = tokio::spawn(
        grapix_render_engine::program::ProgramClock::new(Arc::clone(&engine)).run(),
    );

    // Twelve periods at 59.94, so the window fills and then cycles several times.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    clock.abort();

    let guard = engine.lock().await;
    let counters = guard.ae_program_counters().expect("an AE source is installed");
    let pipeline = guard.ae_program_pipeline().expect("an AE source is installed");

    assert!(
        counters.requested > 3,
        "the clock must keep asking as frames go by, not stop at the first full window; requested {}",
        counters.requested
    );
    assert!(
        counters.missed >= 1,
        "a frame the producer never delivered is a miss, and abandoning it is what frees the ring"
    );
    assert_eq!(
        counters.requested,
        counters.missed + guard.ae_program_pipeline().expect("installed").capacity() as u64,
        "every request is either abandoned or still outstanding; none may be lost"
    );
    assert!(
        pipeline.capacity() >= 1 && counters.requested >= pipeline.capacity() as u64,
        "frames in flight stay bounded by the ring rather than growing with elapsed time"
    );
    assert_eq!(counters.late, 0, "nothing was presented, so nothing was late");
    assert_eq!(counters.ready_before_deadline, 0);
    assert_eq!(
        releases.load(Ordering::SeqCst), 0,
        "no lease was taken, so none was returned"
    );
}

// ---------------------------------------------------------------------------
// PL3 — the container LOAD verb, so a running engine attaches the frame path itself.
// ---------------------------------------------------------------------------

fn load_payload() -> serde_json::Value {
    serde_json::json!({
        "sessionId": "ae-pl3-test",
        "token": "0123456789abcdef0123456789abcdef",
        "compositionItemId": 1,
        "clock": { "frameDuration": "1001", "timeScale": "60000" },
        "format": { "width": 1920, "height": 1080, "colorSpace": "sRGB", "alphaMode": "premultiplied" },
        "ringGeneration": 1,
        "dataRevision": 0
    })
}

fn load(engine: &mut Engine, payload: serde_json::Value) -> Result<(String, serde_json::Value), grapix_render_engine::protocol::ProtocolError> {
    engine.handle(
        RequestType::AeContainerLoad,
        &command("ae.container.load", payload, 10),
        &playout_principal(),
    )
}

#[test]
fn the_container_verbs_are_on_the_protocol_and_grouped_for_audit() {
    assert_eq!(
        RequestType::parse("ae.container.load"),
        Some(RequestType::AeContainerLoad)
    );
    assert_eq!(
        RequestType::parse("ae.container.unload"),
        Some(RequestType::AeContainerUnload)
    );
    assert_eq!(RequestType::AeContainerLoad.group(), "ae-container");
    // Adding the verb must not have displaced a neighbour in the parse table.
    assert_eq!(
        RequestType::parse("output.configure"),
        Some(RequestType::OutputConfigure)
    );
}

#[test]
fn attaching_a_container_is_playout_only() {
    // Operations attach a container; authoring never does. The Editor role holds no session token and
    // must not be able to point this engine at an After Effects host.
    assert!(playout_principal().allows(RequestType::AeContainerLoad));
    assert!(playout_principal().allows(RequestType::AeContainerUnload));
    let editor = ConnectionPrincipal::loopback_editor("editor-link");
    assert!(
        !editor.allows(RequestType::AeContainerLoad),
        "the Editor link must not attach a container"
    );
    // And the neighbour it sits beside on the Playout list still works.
    assert!(playout_principal().allows(RequestType::OutputConfigure));
}

#[test]
fn a_container_load_states_what_it_needs() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let mut engine = configured_engine(directory.path(), "srgb", 1);

    for (field, expected) in [
        ("sessionId", "missing sessionId"),
        ("token", "missing token"),
    ] {
        let mut payload = load_payload();
        payload.as_object_mut().expect("object").remove(field);
        let error = load(&mut engine, payload).expect_err("refused");
        assert!(error.message.contains(expected), "{}", error.message);
    }

    let mut payload = load_payload();
    payload["format"]["width"] = serde_json::json!(0);
    let error = load(&mut engine, payload).expect_err("refused");
    assert!(
        error.message.contains("width must be a positive"),
        "{}",
        error.message
    );

    let mut payload = load_payload();
    payload["clock"]["timeScale"] = serde_json::json!("0");
    let error = load(&mut engine, payload).expect_err("refused");
    assert!(
        error.message.contains("not a usable composition frame duration"),
        "{}",
        error.message
    );

    // A composition whose own clock cannot carry the engine's Program rate is refused here rather than
    // producing frames that would be off-boundary for every request.
    let mut payload = load_payload();
    payload["clock"] = serde_json::json!({ "frameDuration": "800", "timeScale": "23976" });
    let error = load(&mut engine, payload).expect_err("refused");
    assert!(
        error.message.contains("cannot carry the Program rate"),
        "{}",
        error.message
    );
}

#[cfg(windows)]
#[test]
fn a_load_that_cannot_reach_the_adapter_leaves_nothing_attached() {
    // The failure this verb exists to prevent is a Program that believes it has an AE source and
    // silently never asks for a frame. So a load which cannot reach the pipe must detach what it had
    // already installed before it returns.
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let mut engine = configured_engine(directory.path(), "srgb", 1);

    let error = load(&mut engine, load_payload()).expect_err("no adapter is listening");
    assert!(
        error.message.contains("request pipe is not available"),
        "{}",
        error.message
    );
    assert!(
        !engine.has_ae_render_requester(),
        "a refused load must not leave a requester installed"
    );
}

#[cfg(windows)]
#[test]
#[ignore = "requires a managed AE runtime with the LOWER_THIRD fixture open; run with --test-threads=1"]
fn the_container_load_verb_attaches_the_live_frame_path_by_itself() {
    // `PL3`'s point, and the whole difference from `AE-F2a`: nothing here installs ingress, opens the
    // ring, or connects a requester by hand. One protocol request does all three, and Program then has
    // real After Effects pixels behind it.
    let session_id = std::env::var("GRAPIX_AE_RUNTIME_SESSION_ID").expect("a managed session id");
    let token = std::env::var("GRAPIX_AE_RUNTIME_TOKEN").expect("a managed session token");
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let live_rate = FrameRate {
        numerator: 2_997,
        denominator: 100,
    };
    let mut engine =
        configured_engine_with_geometry(directory.path(), "srgb", 1, live_rate, 1920, 1080);

    let (message, payload) = engine
        .handle(
            RequestType::AeContainerLoad,
            &command(
                "ae.container.load",
                serde_json::json!({
                    "sessionId": session_id,
                    "token": token,
                    "compositionItemId": 1,
                    "clock": { "frameDuration": "800", "timeScale": "23976" },
                    "format": {
                        "width": 1920,
                        "height": 1080,
                        "colorSpace": "sRGB",
                        "alphaMode": "premultiplied"
                    },
                    "ringGeneration": 1,
                    "dataRevision": 0,
                    "warmUpFrame": 1
                }),
                10,
            ),
            &playout_principal(),
        )
        .expect("the container attaches");

    assert_eq!(message, "ae.container.loaded");
    assert_eq!(payload["warmUpRequested"], serde_json::json!(true));
    // Proven, not configured: the ring only exists because the warm-up frame was really published.
    assert_eq!(payload["ringSlots"], serde_json::json!(4));
    assert_eq!(payload["geometry"]["stride"], serde_json::json!(7680));
    assert!(engine.has_ae_render_requester());
    // The token is Playout's secret and must not come back out.
    assert!(!payload.to_string().contains(&token), "the ack echoed the session token");

    let mut delivered = 0usize;
    for _ in 0..40 {
        match engine.render_program_frame(1) {
            Ok(count) if count != 0 => {
                delivered = count;
                break;
            }
            Ok(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(error) => panic!("live AE frame failed after a verb-driven load: {error}"),
        }
    }
    assert_eq!(delivered, 1, "one running output received the frame the verb asked for");
    let recorded = std::fs::read(directory.path().join("recordings").join("ae-000001.bgra"))
        .expect("recorded live Program frame");
    assert_eq!(recorded.len(), (1920 * 1080 * 4) as usize);
    assert!(recorded.iter().any(|byte| *byte != 0));

    let (unloaded, detail) = engine
        .handle(
            RequestType::AeContainerUnload,
            &command("ae.container.unload", serde_json::json!({}), 11),
            &playout_principal(),
        )
        .expect("the container detaches");
    assert_eq!(unloaded, "ae.container.unloaded");
    assert_eq!(detail["wasAttached"], serde_json::json!(true));
    assert!(
        !engine.has_ae_render_requester(),
        "unload released the request pipe and the ring consumer"
    );
}

#[test]
fn unloading_a_container_that_was_never_attached_is_honest_rather_than_an_error() {
    let directory = tempfile::tempdir().expect("temporary recording directory");
    let mut engine = configured_engine(directory.path(), "srgb", 1);
    let (message, payload) = engine
        .handle(
            RequestType::AeContainerUnload,
            &command("ae.container.unload", serde_json::json!({}), 11),
            &playout_principal(),
        )
        .expect("unload is always answerable");
    assert_eq!(message, "ae.container.unloaded");
    assert_eq!(payload["wasAttached"], serde_json::json!(false));
}