//! Local IPC transport.
//!
//! Uses a real named pipe (Windows) or socket (Unix), a real handshake and real frames.
//! The point of these tests is that the IPC path is not a second-class one: the same
//! envelope, the same reliability rules, and the same refusals as the WebSocket
//! transport, because both call the same `process_frame`.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use grapix_render_engine::capabilities::{EngineCapabilities, EngineState};
use grapix_render_engine::config::EngineConfig;
use grapix_render_engine::engine::Engine;
use grapix_render_engine::ipc;
use grapix_render_engine::protocol::PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

#[test]
fn a_frame_is_its_length_then_its_bytes() {
    let framed = ipc::frame("{\"a\":1}");
    // Four-byte big-endian length, so a reader knows the size before allocating.
    assert_eq!(&framed[..4], &[0, 0, 0, 7]);
    assert_eq!(&framed[4..], b"{\"a\":1}");
}

#[tokio::test]
async fn a_frame_round_trips_including_payloads_containing_newlines() {
    // The reason for length prefixes rather than newline delimiting: a scene's text
    // content can contain newlines, and a line-based reader would split a message in two.
    let message = "{\"text\":\"line one\\nline two\"}";
    let framed = ipc::frame(message);

    let mut cursor = std::io::Cursor::new(framed);
    let read = ipc::read_frame(&mut cursor, 1024)
        .await
        .expect("read")
        .expect("a frame");
    assert_eq!(read, message);
}

#[tokio::test]
async fn a_clean_end_of_stream_is_not_an_error() {
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    assert!(ipc::read_frame(&mut cursor, 1024)
        .await
        .expect("read")
        .is_none());
}

#[tokio::test]
async fn an_oversized_length_is_refused_before_the_body_is_read() {
    // The property that matters: a client must not be able to make the engine allocate
    // gigabytes by declaring a length it never sends.
    let mut framed = 64_u32.to_be_bytes().to_vec();
    framed.extend_from_slice(b"only a few bytes");

    let mut cursor = std::io::Cursor::new(framed);
    let error = ipc::read_frame(&mut cursor, 16)
        .await
        .expect_err("must refuse");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("at most 16"));
}

#[tokio::test]
async fn a_truncated_body_ends_the_stream_rather_than_hanging() {
    let mut framed = 32_u32.to_be_bytes().to_vec();
    framed.extend_from_slice(b"short");

    let mut cursor = std::io::Cursor::new(framed);
    assert!(ipc::read_frame(&mut cursor, 1024).await.is_err());
}

// ---------------------------------------------------------------------------
// A live endpoint
// ---------------------------------------------------------------------------

fn test_engine(config: &EngineConfig) -> Arc<Mutex<Engine>> {
    Arc::new(Mutex::new(Engine::without_gpu(
        config.clone(),
        "engine_ipc".to_string(),
        synthetic_capabilities(config),
    )))
}

fn synthetic_capabilities(config: &EngineConfig) -> EngineCapabilities {
    use grapix_render_engine::capabilities::*;

    EngineCapabilities {
        engine_id: "engine_ipc".to_string(),
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
        cpu: CpuInfo {
            model: "Test".to_string(),
            logical_cores: 8,
        },
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
            preview_streaming: true,
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
        rendered_object_types: vec!["rect".to_string(), "text".to_string()],
        // Both transports, because this engine genuinely serves both.
        transports: vec!["websocket".to_string(), "ipc".to_string()],
    }
}

/// A unique endpoint per test, so a parallel run cannot collide.
fn endpoint(name: &str) -> String {
    let unique = format!("{}-{name}", std::process::id());
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\grapix-ipc-test-{unique}")
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir()
            .join(format!("grapix-ipc-test-{unique}.sock"))
            .to_string_lossy()
            .to_string()
    }
}

struct IpcClient {
    #[cfg(windows)]
    stream: tokio::net::windows::named_pipe::NamedPipeClient,
    #[cfg(not(windows))]
    stream: tokio::net::UnixStream,
    sequence: u64,
    message_id: u64,
}

impl IpcClient {
    async fn connect(endpoint: &str) -> anyhow::Result<Self> {
        // The listener may not have created the endpoint yet; retry briefly rather than
        // sleeping a fixed time.
        for _ in 0..200 {
            #[cfg(windows)]
            let attempt = tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint);
            #[cfg(not(windows))]
            let attempt = tokio::net::UnixStream::connect(endpoint).await;

            match attempt {
                Ok(stream) => {
                    return Ok(Self {
                        stream,
                        sequence: 0,
                        message_id: 0,
                    })
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
            }
        }
        anyhow::bail!("could not connect to {endpoint}")
    }

    async fn request(&mut self, message_type: &str, payload: Value) -> Value {
        self.request_scoped(message_type, payload, Value::Null).await
    }

    /*
     * A scene-bearing command carries a canonical SceneRef, and the engine refuses one that does
     * not — the same rule the WebSocket clients follow. This used to be untestable: an envelope
     * rejected before parsing was answered without a `requestId`, so this client waited for a reply
     * it could never match and the test hung instead of failing.
     */
    async fn request_scoped(
        &mut self,
        message_type: &str,
        payload: Value,
        scene_ref: Value,
    ) -> Value {
        self.sequence += 1;
        self.message_id += 1;

        let envelope = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "messageId": format!("ipc-{}", self.message_id),
            "requestId": format!("req-{}", self.message_id),
            "engineId": Value::Null,
            "projectId": Value::Null,
            "sceneRef": scene_ref,
            "sceneId": payload.get("sceneId").cloned().unwrap_or(Value::Null),
            "sceneRevision": payload.get("sceneRevision").cloned().unwrap_or(Value::Null),
            "timestampMs": 1_700_000_000_000u64,
            "type": message_type,
            "requiresAck": true,
            "sequence": self.sequence,
            "direction": "client-to-engine",
            "payload": payload,
        });

        self.stream
            .write_all(&ipc::frame(&envelope.to_string()))
            .await
            .expect("write");
        self.stream.flush().await.expect("flush");

        // Read until the correlated reply, skipping unsolicited events as a real client
        // does.
        for _ in 0..24 {
            let text = self.read_frame().await.expect("a frame");
            let value: Value = serde_json::from_str(&text).expect("json");
            if value["requestId"] == format!("req-{}", self.message_id) {
                return value;
            }
        }
        panic!("no reply to {message_type}");
    }

    async fn read_frame(&mut self) -> Option<String> {
        let mut length = [0u8; 4];
        self.stream.read_exact(&mut length).await.ok()?;
        let mut body = vec![0u8; u32::from_be_bytes(length) as usize];
        self.stream.read_exact(&mut body).await.ok()?;
        String::from_utf8(body).ok()
    }
}

async fn start(name: &str, auth: bool) -> (String, Arc<Mutex<Engine>>) {
    let mut config = EngineConfig::default();
    config.network.ipc_endpoint = Some(endpoint(name));
    // No TCP listener at all for these tests: the point is that IPC works on its own.
    config.network.websocket_port = 0;
    config.auth.required = auth;
    if auth {
        config.auth.signing_secret = Some("0123456789abcdef0123456789abcdef".to_string());
    }

    let engine = test_engine(&config);
    let served_config = config.clone();
    let served_engine = Arc::clone(&engine);
    tokio::spawn(async move {
        let _ = ipc::serve(served_config, served_engine).await;
    });

    (
        config.network.ipc_endpoint.clone().expect("endpoint"),
        engine,
    )
}

#[tokio::test]
async fn no_endpoint_configured_means_no_socket_appears() {
    // IPC is opt-in. A deployment that did not ask for it must not get one.
    let config = EngineConfig::default();
    assert!(config.network.ipc_endpoint.is_none());
    let engine = test_engine(&config);
    // Returns immediately rather than listening on something invented.
    ipc::serve(config, engine).await.expect("serve returns");
}

#[tokio::test]
async fn a_client_completes_the_handshake_over_ipc() {
    let (endpoint, engine) = start("hello", false).await;
    let mut client = IpcClient::connect(&endpoint).await.expect("connect");

    let hello = client
        .request(
            "connection.hello",
            json!({
                "clientId": "editor_ipc",
                "clientName": "GrapiX Editor",
                "clientRole": "editor",
                "clientVersion": "0.2.0",
                "protocolVersion": PROTOCOL_VERSION,
                "sceneDocumentVersion": 1,
                "stageDocumentVersion": 1
            }),
        )
        .await;

    assert_eq!(hello["type"], "reply.hello");
    assert_eq!(hello["payload"]["engineId"], "engine_ipc");
    assert_eq!(engine.lock().await.connected_clients, 1);

    // Capabilities read over IPC must be the same document the WebSocket path serves.
    let capabilities = client.request("engine.getCapabilities", json!({})).await;
    assert_eq!(capabilities["type"], "reply.capabilities");
    assert!(capabilities["payload"]["transports"]
        .as_array()
        .unwrap()
        .iter()
        .any(|transport| transport == "ipc"));
}

#[tokio::test]
async fn a_scene_loads_and_commands_work_over_ipc() {
    let (endpoint, _engine) = start("scene", false).await;
    let mut client = IpcClient::connect(&endpoint).await.expect("connect");
    client
        .request(
            "connection.hello",
            json!({
                "clientId": "editor_ipc",
                "clientName": "GrapiX Editor",
                "clientRole": "editor",
                "clientVersion": "0.2.0",
                "protocolVersion": PROTOCOL_VERSION,
                "sceneDocumentVersion": 1,
                "stageDocumentVersion": 1
            }),
        )
        .await;

    let scene = json!({
        "id": "scene_ipc",
        "name": "IPC scene",
        "version": 1,
        "revision": 1,
        "canvas": { "width": 1920, "height": 1080, "background": "#00000000" },
        "dataContext": {},
        "assets": [],
        "materials": [],
        "objects": [{
            "id": "rect_1", "name": "Band", "type": "rect",
            "x": 10.0, "y": 20.0, "width": 100.0, "height": 50.0,
            "zDepth": 0.0, "zIndex": 0, "layerId": "layer_1", "visible": true,
            "fill": "#ffffff"
        }],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    });

    let loaded = client
        .request_scoped(
            "scene.load",
            json!({ "scene": scene }),
            json!({
                "projectId": "default",
                "domain": "published",
                "sceneId": "scene_ipc",
                "revision": 1
            }),
        )
        .await;
    assert!(
        loaded["type"] == "reply.ack" || loaded["type"] == "reply.scenePrepared",
        "{loaded}"
    );

    // A patch over IPC behaves exactly as it does over WebSocket.
    let patched = client
        .request_scoped(
            "scene.applyPatch",
            json!({
                "patch": {
                    "sceneId": "scene_ipc",
                    "baseRevision": 1,
                    "revision": 2,
                    "operations": [
                        { "type": "object.transform", "objectId": "rect_1", "transform": { "x": 99.5 } }
                    ]
                }
            }),
            // The ref names the scene being patched, which is still at the base revision.
            json!({
                "projectId": "default",
                "domain": "published",
                "sceneId": "scene_ipc",
                "revision": 1
            }),
        )
        .await;
    assert_eq!(patched["payload"]["sceneRevision"], 2, "{patched}");

    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(status["payload"]["scenes"][0]["revision"], 2);
}

#[tokio::test]
async fn an_ipc_client_still_has_to_authenticate_when_a_token_is_required() {
    // Local does not mean trusted. A user session can contain more than one program.
    let (endpoint, _engine) = start("auth", true).await;
    let mut client = IpcClient::connect(&endpoint).await.expect("connect");

    let hello = client
        .request(
            "connection.hello",
            json!({
                "clientId": "editor_ipc",
                "clientName": "GrapiX Editor",
                "clientRole": "editor",
                "clientVersion": "0.2.0",
                "protocolVersion": PROTOCOL_VERSION,
                "sceneDocumentVersion": 1,
                "stageDocumentVersion": 1
            }),
        )
        .await;
    // The handshake is allowed so the client can learn that a token is needed.
    assert_eq!(hello["type"], "reply.hello");
    assert_eq!(hello["payload"]["authenticationRequired"], true);

    let refused = client.request("engine.getStatus", json!({})).await;
    assert_eq!(refused["payload"]["code"], "UNAUTHENTICATED");
}

#[tokio::test]
async fn an_ipc_client_disconnecting_never_disturbs_program() {
    let (endpoint, engine) = start("disconnect", false).await;
    let mut client = IpcClient::connect(&endpoint).await.expect("connect");
    client
        .request(
            "connection.hello",
            json!({
                "clientId": "editor_ipc",
                "clientName": "GrapiX Editor",
                "clientRole": "editor",
                "clientVersion": "0.2.0",
                "protocolVersion": PROTOCOL_VERSION,
                "sceneDocumentVersion": 1,
                "stageDocumentVersion": 1
            }),
        )
        .await;
    assert_eq!(engine.lock().await.connected_clients, 1);

    drop(client);

    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        if engine.lock().await.connected_clients == 0 {
            break;
        }
    }
    assert_eq!(engine.lock().await.connected_clients, 0);
    // Program state lives in the engine, not in a connection.
    assert_eq!(engine.lock().await.state(), EngineState::Ready);
}

#[tokio::test]
async fn a_second_client_can_connect_after_the_first_leaves() {
    // On Windows each named-pipe instance serves one client, so the listener has to keep
    // creating instances. Getting this wrong makes the endpoint work exactly once.
    let (endpoint, _engine) = start("sequential", false).await;

    for attempt in 0..3 {
        let mut client = IpcClient::connect(&endpoint)
            .await
            .unwrap_or_else(|error| panic!("connect {attempt}: {error}"));
        let hello = client
            .request(
                "connection.hello",
                json!({
                    "clientId": format!("editor_{attempt}"),
                    "clientName": "GrapiX Editor",
                    "clientRole": "editor",
                    "clientVersion": "0.2.0",
                    "protocolVersion": PROTOCOL_VERSION,
                    "sceneDocumentVersion": 1,
                    "stageDocumentVersion": 1
                }),
            )
            .await;
        assert_eq!(hello["type"], "reply.hello", "attempt {attempt}");
    }
}
