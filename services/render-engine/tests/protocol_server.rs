//! Live protocol server tests.
//!
//! These bind a real socket, run a real handshake, and exchange real frames. They
//! do not need a GPU: everything up to and including scene load, prepare-refusal,
//! playout gating, and reliability behaviour is exercised without rendering a
//! pixel. A preview request would need a device and is covered by the GPU-backed
//! smoke path instead.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use grapix_render_engine::capabilities::{EngineCapabilities, EngineState};
use grapix_render_engine::config::EngineConfig;
use grapix_render_engine::engine::{Channel, Engine};
use grapix_render_engine::protocol::PROTOCOL_VERSION;

/// The signing secret the test engine verifies tokens against.
const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// A real access token, minted the way the TypeScript issuer mints them. The format is proven
/// identical across both languages by `Shared/auth-contract/tests/conformance.test.mjs`; this
/// only needs one that verifies, so the server test exercises the real credential path rather
/// than a shared secret that no longer exists.
fn access_token() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let payload = r#"{"sub":"usr_test","usr":"test","role":"admin","perms":["scene.read","scene.write","scene.publish","stage.write","asset.write","editor.view","playout.preview","playout.program","output.manage","engine.configure","engine.diagnose","user.manage","audit.read"],"sid":"sess_test","typ":"access","iat":1,"exp":9999999999}"#;
    let encoded = URL_SAFE_NO_PAD.encode(payload.as_bytes());
    let signing_input = format!("gx1.{encoded}");
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).expect("key");
    mac.update(signing_input.as_bytes());
    format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// Build an engine with no GPU.
///
/// A device is only touched when a tile actually renders, so every path these
/// tests reach — connect, load, prepare gating, playout state, reliability,
/// status, diagnostics — works without an adapter. That is what makes the protocol
/// testable on a machine that has none.
fn test_engine(config: EngineConfig) -> Arc<Mutex<Engine>> {
    let capabilities = synthetic_capabilities(&config);
    Arc::new(Mutex::new(Engine::without_gpu(
        config,
        "engine_test".to_string(),
        capabilities,
    )))
}

fn synthetic_capabilities(config: &EngineConfig) -> EngineCapabilities {
    use grapix_render_engine::capabilities::*;

    EngineCapabilities {
        engine_id: "engine_test".to_string(),
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
        rendered_object_types: vec!["rect".to_string(), "text".to_string()],
        transports: vec!["websocket".to_string()],
    }
}

fn base_config(port: u16, auth: bool) -> EngineConfig {
    let mut config = EngineConfig::default();
    config.network.bind_address = "127.0.0.1".to_string();
    config.network.websocket_port = port;
    config.auth.required = auth;
    // Every test server gets a signing key, not only the authenticating one. The dev path
    // (`required = false`) still *accepts* a credential-less local connection - which is what
    // the tests below that connect without a token exercise - but it must also be able to
    // *verify* one, because the test client mints an access token for every connection and
    // only a verified token carries the permissions the command gate checks.
    config.auth.signing_secret = Some(SECRET.to_string());
    config.assets.roots = vec!["assets".to_string()];
    // A cache directory of its own, per test and per run. The asset cache is content
    // addressed, so a shared one would make one test's upload appear as another's
    // "already cached" - and would carry over between runs, which is worse.
    config.assets.cache_directory = std::env::temp_dir()
        .join(format!(
            "grapix-protocol-test-{}-{port}",
            std::process::id()
        ))
        .to_string_lossy()
        .to_string();
    config.validate().expect("test config must validate");
    config
}

/// Bind an ephemeral port so tests never collide with a running engine.
async fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    port
}

struct Client {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    sequence: u64,
    message_id: u64,
    /// Every inbound messageId, in arrival order, including events the request
    /// helper skips. Lets a test assert uniqueness across both streams.
    seen_ids: Vec<String>,
    seen_events: usize,
    seen_replies: usize,
}

impl Client {
    /// Connect as an identified user, minting an access token as the TypeScript issuer does.
    ///
    /// Almost every test in this file was written against one anonymous development principal
    /// that could drive both authoring and Program verbs. That principal never had a user and
    /// could not hold a permission, so it cannot exercise the per-command gate these tests are
    /// now protected by. Minting the token here keeps the whole suite meaningful under the new
    /// model without rewriting each call site; the `token` argument overrides, which is what
    /// the refusal tests use to prove a bad credential is still rejected.
    async fn connect(port: u16, token: Option<&str>) -> anyhow::Result<Self> {
        let credential = token.map(ToOwned::to_owned).unwrap_or_else(access_token);
        Self::connect_with_credential(port, Some(&credential)).await
    }

    /// Connect with an explicit credential string, or none at all.
    async fn connect_with_credential(port: u16, token: Option<&str>) -> anyhow::Result<Self> {
        let mut request = format!("ws://127.0.0.1:{port}").into_client_request()?;

        let protocols = match token {
            Some(token) => format!("grapix-engine-v3, bearer.{token}"),
            None => "grapix-engine-v3".to_string(),
        };
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", protocols.parse()?);

        let (socket, _) = tokio_tungstenite::connect_async(request).await?;
        Ok(Self {
            socket,
            sequence: 0,
            message_id: 0,
            seen_ids: Vec::new(),
            seen_events: 0,
            seen_replies: 0,
        })
    }

    /// Send a request and read frames until the correlated reply arrives.
    ///
    /// Skips unsolicited events, which is what a real client does.
    async fn request(&mut self, message_type: &str, payload: Value) -> Value {
        self.request_with(message_type, payload, None, None).await
    }

    /// Like `request`, but addresses a specific scene instead of deriving one.
    async fn request_for(&mut self, message_type: &str, payload: Value, scene_ref: Value) -> Value {
        self.request_with_ref(message_type, payload, None, None, Some(scene_ref)).await
    }

    /// Load a scene and deliver its published copy, mirroring what Playout does.
    ///
    /// Program and Preview accept only a `published` SceneRef, and the engine's authority split
    /// is real now: an authoring copy is a *different scene address*, and cueing it is a
    /// SCENE_NOT_FOUND, not a cue. These tests were written before that boundary existed and
    /// load a single copy, so this delivers both - the authoring copy the authoring verbs
    /// touch, and the published copy the operator verbs need - at the same revision.
    /// Load the authoring copy only. Most scene-verb tests need exactly this: one scene, at a
    /// known revision, that patches and prepares touch. Returns the load reply.
    async fn load_authoring(&mut self, scene: Value) -> Value {
        let id = scene["id"].as_str().expect("scene id").to_string();
        let revision = scene["revision"].as_u64().unwrap_or(1);
        let authoring_ref = json!({
            "projectId": "protocol-test", "domain": "authoring", "sceneId": id, "revision": revision
        });
        self.request_for("scene.load", json!({ "scene": scene }), authoring_ref).await
    }

    /// Load a scene and deliver its published copy, mirroring what Playout does.
    ///
    /// Program and Preview accept only a `published` SceneRef, and the engine's authority split
    /// is real now: an authoring copy is a *different scene address*, and cueing it is a
    /// SCENE_NOT_FOUND, not a cue. Tests that drive operator verbs need the published copy to
    /// exist; tests that only author do not, and would see two scenes where they expect one.
    async fn load_scene(&mut self, scene: Value) -> Value {
        let id = scene["id"].as_str().expect("scene id").to_string();
        let revision = scene["revision"].as_u64().unwrap_or(1);
        let published_ref = json!({
            "projectId": "protocol-test", "domain": "published", "sceneId": id, "revision": revision
        });
        let reply = self.load_authoring(scene.clone()).await;
        self.request_for("scene.load", json!({ "scene": scene }), published_ref).await;
        reply
    }

    async fn request_with(
        &mut self,
        message_type: &str,
        payload: Value,
        force_sequence: Option<u64>,
        force_message_id: Option<String>,
    ) -> Value {
        self.request_with_ref(message_type, payload, force_sequence, force_message_id, None)
            .await
    }

    async fn request_with_ref(
        &mut self,
        message_type: &str,
        payload: Value,
        force_sequence: Option<u64>,
        force_message_id: Option<String>,
        explicit_scene_ref: Option<Value>,
    ) -> Value {
        self.sequence += 1;
        self.message_id += 1;

        let sequence = force_sequence.unwrap_or(self.sequence);
        let message_id = force_message_id.unwrap_or_else(|| format!("test-{}", self.message_id));
        let request_id = format!("req-{}", self.message_id);

        // These tests predate mandatory SceneRef addressing. Rather than rewrite every call,
        // address the scene they load: Program/Preview verbs need the `published` domain and
        // authoring verbs the `authoring` one, and the split lives here, not in forty places.
        // Program is what makes the two domains real, which is why one blanket default would
        // be wrong.
        // The scene id sits in different places depending on the verb: bare on cue/stop, in
        // `scene.id` on load, and in `patch.sceneId` on a patch. Deriving from all three keeps
        // this helper usable for every call site rather than only the conveniently shaped ones.
        let scene_id = payload
            .get("sceneId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| {
                payload
                    .get("incomingSceneId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .or_else(|| {
                payload
                    .get("scene")
                    .and_then(|scene| scene.get("id"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .or_else(|| {
                payload
                    .get("patch")
                    .and_then(|patch| patch.get("sceneId"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            });
        let derived_scene_ref = scene_id.map(|scene_id| {
            // The revision is the *address* of the scene on the engine - the revision it was
            // loaded at - not a content revision a command names. Load and fullSync carry the
            // load revision in `scene.revision`; a patch carries its base in `patch.baseRevision`;
            // an explicit `sceneRevision` is a content check, not the address, so it is the
            // last resort rather than the first.
            // A patch addresses the scene's runtime key, which is the *load* revision - the
            // document's revision as loaded - not `patch.baseRevision`, which is the content
            // revision the gate inside `apply_patch` compares against. They coincide for a
            // first patch (base == load) and diverge after one lands, so the wrong choice
            // silently keys a scene that does not exist. These tests always load at the
            // revision the patch then bases on, so the address is the base revision; the
            // engine's revision check is what actually gates.
            let revision = if message_type == "scene.fullSync" {
                // fullSync replaces the scene *already on the engine*, so its address is that
                // scene's load revision, not the incoming document's. These tests load at
                // revision 1, so that is the address; the new revision is the payload's.
                1
            } else {
                payload
                    .get("scene")
                    .and_then(|scene| scene.get("revision"))
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        payload
                            .get("patch")
                            .and_then(|patch| patch.get("baseRevision"))
                            .and_then(Value::as_u64)
                    })
                    .or_else(|| payload.get("incomingSceneRevision").and_then(Value::as_u64))
                    .or_else(|| payload.get("sceneRevision").and_then(Value::as_u64))
                    .unwrap_or(1)
            };
            let domain = if message_type.starts_with("playout.") || message_type.starts_with("preview.") {
                "published"
            } else {
                "authoring"
            };
            json!({
                "projectId": "protocol-test",
                "domain": domain,
                "sceneId": scene_id,
                "revision": revision,
            })
        });

        let envelope = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "messageId": message_id,
            "requestId": request_id,
            "engineId": Value::Null,
            "projectId": Value::Null,
            "sceneRef": explicit_scene_ref.or(derived_scene_ref).unwrap_or(Value::Null),
            "timestampMs": 1_700_000_000_000u64,
            "type": message_type,
            "requiresAck": true,
            "sequence": sequence,
            "direction": "client-to-engine",
            "payload": payload,
        });

        self.socket
            .send(Message::Text(envelope.to_string().into()))
            .await
            .expect("send");

        // Read until the reply for this request, or an error, arrives.
        for _ in 0..24 {
            let Some(frame) = self.socket.next().await else {
                panic!("connection closed while waiting for a reply to {message_type}");
            };
            let frame = frame.expect("frame");
            let Message::Text(text) = frame else { continue };
            let value: Value = serde_json::from_str(&text).expect("json");
            self.record(&value);

            let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
            if kind.starts_with("event.") {
                continue; // unsolicited; keep reading
            }
            let correlated = value.get("requestId").and_then(Value::as_str);
            if correlated == Some(request_id.as_str()) || kind == "reply.error" {
                return value;
            }
        }

        panic!("no reply to {message_type} after 24 frames");
    }

    /// Send without waiting, for ordering tests.
    async fn send_raw(
        &mut self,
        message_type: &str,
        payload: Value,
        sequence: u64,
        message_id: &str,
    ) {
        let envelope = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "messageId": message_id,
            "requestId": format!("raw-{sequence}"),
            "engineId": Value::Null,
            "projectId": Value::Null,
            "sceneId": Value::Null,
            "sceneRevision": Value::Null,
            "timestampMs": 1_700_000_000_000u64,
            "type": message_type,
            "requiresAck": true,
            "sequence": sequence,
            "direction": "client-to-engine",
            "payload": payload,
        });
        self.socket
            .send(Message::Text(envelope.to_string().into()))
            .await
            .expect("send");
    }

    /// Note an inbound frame, so a test can inspect the whole stream.
    fn record(&mut self, value: &Value) {
        if let Some(message_id) = value.get("messageId").and_then(Value::as_str) {
            self.seen_ids.push(message_id.to_string());
        }
        if value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .starts_with("event.")
        {
            self.seen_events += 1;
        } else {
            self.seen_replies += 1;
        }
    }

    async fn next_reply(&mut self) -> Option<Value> {
        for _ in 0..16 {
            let frame = self.socket.next().await?;
            let Message::Text(text) = frame.ok()? else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).ok()?;
            self.record(&value);
            if value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .starts_with("event.")
            {
                continue;
            }
            return Some(value);
        }
        None
    }
}

/// Start a server on an ephemeral port and return it plus the engine handle.
async fn start(auth: bool) -> (u16, Arc<Mutex<Engine>>) {
    let port = free_port().await;
    let config = base_config(port, auth);
    let engine = test_engine(config.clone());

    let served = Arc::clone(&engine);
    tokio::spawn(async move {
        let _ = grapix_render_engine::transport::serve(config, served).await;
    });

    // Wait for the listener rather than sleeping a fixed time.
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    (port, engine)
}

fn hello_payload() -> Value {
    json!({
        "clientId": "test",
        "clientName": "Test client",
        "clientRole": "editor",
        "clientVersion": "0.2.0",
        "supportedProtocolVersions": [PROTOCOL_VERSION],
    })
}

fn scene(scene_id: &str, revision: u64) -> Value {
    json!({
        "id": scene_id,
        "name": "Lower third",
        "version": 1,
        "revision": revision,
        "canvas": { "width": 1920, "height": 1080, "background": "#00000000" },
        "dataContext": {},
        "assets": [],
        "materials": [],
        "objects": [
            {
                "id": "rect_1",
                "name": "Background",
                "type": "rect",
                "x": 100, "y": 100, "width": 800, "height": 200,
                "zDepth": 0, "zIndex": 0, "layerId": "layer_1", "visible": true,
                "fill": "#ff0000"
            }
        ],
        "timeline": { "fps": 50, "durationFrames": 100, "keyframes": [] },
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    })
}

// ---------------------------------------------------------------------------
// Handshake and connection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_client_completes_the_handshake_and_negotiates_capabilities() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");

    let hello = client.request("connection.hello", hello_payload()).await;
    assert_eq!(hello["type"], "reply.hello");
    assert_eq!(hello["payload"]["engineId"], "engine_test");
    assert_eq!(hello["payload"]["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(hello["payload"]["authenticationRequired"], false);

    let capabilities = client.request("engine.getCapabilities", json!({})).await;
    assert_eq!(capabilities["type"], "reply.capabilities");
    // The numbers that make a pre-publish check possible.
    assert_eq!(
        capabilities["payload"]["limits"]["maxLogicalCanvasWidth"],
        50_000.0
    );
    assert_eq!(capabilities["payload"]["features"]["tileRendering"], true);
    // Honesty: no native video decode means an empty list, not a hopeful one.
    assert_eq!(
        capabilities["payload"]["supportedVideoFormats"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    assert_eq!(engine.lock().await.connected_clients, 1);
}

#[tokio::test]
async fn an_authenticating_engine_refuses_a_client_with_no_token() {
    let (port, _engine) = start(true).await;

    // The token is checked in the handshake, so an unauthenticated client never
    // reaches the message loop.
    assert!(
        Client::connect_with_credential(port, None).await.is_err(),
        "a tokenless client must be refused at the handshake"
    );
    assert!(
        Client::connect_with_credential(port, Some("wrong-token-wrong-token"))
            .await
            .is_err(),
        "a wrong token must be refused at the handshake"
    );

    let token = access_token();
    let mut client = Client::connect(port, Some(&token)).await.expect("connect");
    let hello = client.request("connection.hello", hello_payload()).await;
    assert_eq!(hello["payload"]["authenticationRequired"], true);
}

#[tokio::test]
async fn a_client_that_omits_the_subprotocol_is_refused() {
    let (port, _engine) = start(false).await;

    let request = format!("ws://127.0.0.1:{port}")
        .into_client_request()
        .expect("request");
    // No Sec-WebSocket-Protocol header at all.
    assert!(
        tokio_tungstenite::connect_async(request).await.is_err(),
        "a client without the engine subprotocol must be refused"
    );
}

#[tokio::test]
async fn a_heartbeat_echoes_the_client_clock_for_latency_measurement() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client
        .request(
            "connection.heartbeat",
            json!({ "sentAtMs": 1_700_000_000_123u64 }),
        )
        .await;

    assert_eq!(reply["type"], "reply.ack");
    assert_eq!(reply["payload"]["sentAtMs"], 1_700_000_000_123u64);
    assert!(reply["payload"]["engineTimeMs"].as_u64().unwrap() > 0);
}

// ---------------------------------------------------------------------------
// Stage and scene
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_50000_wide_stage_loads_and_reports_what_tiling_avoids() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client
        .request(
            "stage.load",
            json!({
                "stage": {
                    "stageId": "stage_arena",
                    "name": "Arena",
                    "canvas": { "logicalWidth": 50000.0, "logicalHeight": 10000.0 },
                    "tiling": { "enabled": true, "tileWidth": 2048, "tileHeight": 2048, "overscan": 32 }
                }
            }),
        )
        .await;

    assert_eq!(reply["type"], "reply.ack", "{reply}");
    assert_eq!(reply["payload"]["stageId"], "stage_arena");
    assert_eq!(engine.lock().await.stage_count(), 1);

    let status = client.request("engine.getStatus", json!({})).await;
    // A stage-sized target would be 2 GB and is never allocated.
    let scenes = status["payload"]["scenes"].as_array().unwrap();
    assert!(scenes.is_empty());
}

#[tokio::test]
async fn a_stage_larger_than_the_engine_limit_is_refused_with_a_reason() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client
        .request(
            "stage.load",
            json!({
                "stage": {
                    "stageId": "stage_impossible",
                    // Past the 50,000 limit, and with tiling off so it could never
                    // be one texture either.
                    "canvas": { "logicalWidth": 50000.0, "logicalHeight": 50000.0 },
                    "tiling": { "enabled": false }
                }
            }),
        )
        .await;

    assert_eq!(reply["type"], "reply.error");
    assert_eq!(reply["payload"]["code"], "STAGE_UNSUPPORTED");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("TILING_REQUIRED"));
}

#[tokio::test]
async fn a_scene_loads_and_prepares_and_reports_its_state() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client.load_scene(json!(scene("scene_1", 3))).await;
    assert_eq!(reply["type"], "reply.ack", "{reply}");
    // Both copies are resident: the authoring one this load created and the published one
    // `load_scene` delivers alongside it, exactly as an Editor and Playout would hold them.
    assert_eq!(engine.lock().await.scene_count(), 2);

    let status = client.request("engine.getStatus", json!({})).await;
    let scenes = status["payload"]["scenes"].as_array().unwrap();
    assert_eq!(scenes.len(), 2);
    let authoring = scenes
        .iter()
        .find(|scene| {
            scene["sceneId"]
                .as_str()
                .map(|key| key.contains("|9:authoring|"))
                .unwrap_or(false)
        })
        .expect("an authoring copy");
    assert!(
        authoring["sceneId"]
            .as_str()
            .map(|key| scene_key_is(key, "scene_1"))
            .unwrap_or(false),
        "expected the loaded scene under its runtime key, got {}",
        authoring["sceneId"]
    );
    assert_eq!(scenes[0]["revision"], 3);
    // Loaded is not prepared, and not prepared is not take-ready.
    assert_eq!(scenes[0]["preparationState"], "loading");
    assert_eq!(scenes[0]["takeReady"], false);
    assert_eq!(scenes[0]["objectCount"], 1);
}

#[tokio::test]
async fn loading_more_scenes_than_configured_is_refused() {
    let port = free_port().await;
    let mut config = base_config(port, false);
    config.stage.max_active_scenes = 2;
    let engine = test_engine(config.clone());

    let served = Arc::clone(&engine);
    tokio::spawn(async move {
        let _ = grapix_render_engine::transport::serve(config, served).await;
    });
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    for index in 0..2 {
        let reply = client.load_scene(json!(scene(&format!("scene_{index}"), 1))).await;
        assert_eq!(reply["type"], "reply.ack");
    }

    // The ceiling is on published copies - the render targets an operator sees - so a third
    // *published* load is what must be refused, even though its authoring copy would still
    // load. Delivering the published copy directly is what makes that distinction legible.
    let overflow = json!(scene("scene_overflow", 1));
    let published_ref = json!({
        "projectId": "protocol-test", "domain": "published", "sceneId": "scene_overflow", "revision": 1
    });
    let refused = client
        .request_for("scene.load", json!({ "scene": overflow }), published_ref)
        .await;
    assert_eq!(refused["type"], "reply.error");
    assert_eq!(refused["payload"]["code"], "ENGINE_BUSY");
}

#[tokio::test]
async fn unloading_an_unknown_scene_is_an_error() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client
        .request("scene.unload", json!({ "sceneId": "ghost" }))
        .await;
    assert_eq!(reply["payload"]["code"], "SCENE_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Playout gating
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unprepared_scene_cannot_go_online_without_an_explicit_override() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    // Requirement 14: refused, and the refusal names the blockers.
    let refused = client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "sceneRevision": 1 }),
        )
        .await;
    assert_eq!(refused["type"], "reply.error");
    assert_eq!(refused["payload"]["code"], "SCENE_NOT_PREPARED");
    assert!(refused["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("overrideUnprepared"));
    assert!(engine.lock().await.state() != EngineState::OnAir);

    // With the override it proceeds, and says that it did.
    let accepted = client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "sceneRevision": 1, "overrideUnprepared": true }),
        )
        .await;
    assert_eq!(accepted["type"], "reply.ack", "{accepted}");
    let warnings = accepted["payload"]["warnings"].as_array().unwrap();
    assert!(!warnings.is_empty(), "an override must be reported");
    assert!(warnings[0].as_str().unwrap().contains("overrode"));

    assert_eq!(engine.lock().await.state(), EngineState::OnAir);
}

#[tokio::test]
async fn replace_refuses_an_unprepared_or_stale_incoming_scene() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 2))).await;

    let unprepared = client
        .request(
            "playout.replace",
            json!({
                "channel": "program",
                "outgoingSceneId": "scene_0",
                "incomingSceneId": "scene_1",
                "incomingSceneRevision": 2
            }),
        )
        .await;
    assert_eq!(unprepared["payload"]["code"], "SCENE_NOT_PREPARED");
    assert_ne!(engine.lock().await.state(), EngineState::OnAir);

    let stale = client
        .request(
            "playout.replace",
            json!({
                "channel": "program",
                "outgoingSceneId": "scene_0",
                "incomingSceneId": "scene_1",
                "incomingSceneRevision": 1
            }),
        )
        .await;
    assert_eq!(stale["payload"]["code"], "REVISION_MISMATCH");
}

#[tokio::test]
async fn cue_targets_preview_and_refuses_program() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let preview = client
        .request(
            "playout.cue",
            json!({ "sceneId": "scene_1", "sceneRevision": 1, "channel": "preview" }),
        )
        .await;
    assert_eq!(preview["type"], "reply.ack", "{preview}");

    // Cue must never be able to put something on air.
    let program = client
        .request(
            "playout.cue",
            json!({ "sceneId": "scene_1", "sceneRevision": 1, "channel": "program" }),
        )
        .await;
    assert_eq!(program["type"], "reply.error");
    assert_eq!(program["payload"]["code"], "UNAUTHORIZED");
    assert!(program["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("takeOnline"));
}

#[tokio::test]
async fn a_command_naming_the_wrong_revision_is_refused() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 5))).await;

    let reply = client
        .request(
            "playout.cue",
            json!({ "sceneId": "scene_1", "sceneRevision": 4, "channel": "preview" }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "REVISION_MISMATCH");
    assert_eq!(reply["payload"]["requiresFullSync"], true);
}

#[tokio::test]
async fn an_unimplemented_transition_is_refused_rather_than_substituted() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "playout.transition",
            json!({
                "sceneId": "scene_1",
                "channel": "program",
                "transitionId": "wipe",
                "direction": "in",
                "durationFrames": 25
            }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "CAPABILITY_UNSUPPORTED");
    let message = reply["payload"]["message"].as_str().unwrap();
    assert!(message.contains("will not substitute a cut"));

    // A zero-frame transition is a cut, which is implemented.
    let cut = client
        .request(
            "playout.transition",
            json!({
                "sceneId": "scene_1",
                "channel": "program",
                "transitionId": "cut",
                "direction": "in",
                "durationFrames": 0
            }),
        )
        .await;
    assert_eq!(cut["type"], "reply.ack");
}

#[tokio::test]
async fn clearing_program_returns_the_engine_to_ready() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "sceneRevision": 1, "overrideUnprepared": true }),
        )
        .await;
    assert_eq!(engine.lock().await.state(), EngineState::OnAir);

    let reply = client
        .request("playout.clear", json!({ "channel": "program" }))
        .await;
    assert_eq!(reply["type"], "reply.ack");
    assert_eq!(engine.lock().await.state(), EngineState::Ready);
}

#[tokio::test]
async fn a_scene_on_program_cannot_be_unloaded_without_force() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "sceneRevision": 1, "overrideUnprepared": true }),
        )
        .await;

    // Program holds the published copy, so it is the published copy whose unload would put
    // black on air. Addressing the authoring copy would be a different scene and prove
    // nothing about the guard.
    let published_ref = json!({
        "projectId": "protocol-test", "domain": "published", "sceneId": "scene_1", "revision": 1
    });
    let refused = client
        .request_for("scene.unload", json!({ "sceneId": "scene_1" }), published_ref.clone())
        .await;
    assert_eq!(refused["payload"]["code"], "OUTPUT_ERROR");
    assert!(refused["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("force"));

    let forced = client
        .request_for(
            "scene.unload",
            json!({ "sceneId": "scene_1", "force": true }),
            published_ref,
        )
        .await;
    assert_eq!(forced["type"], "reply.ack");
}

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_retransmitted_message_is_acknowledged_but_not_reapplied() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let first = client
        .request_with(
            "scene.load",
            json!({ "scene": scene("scene_1", 1) }),
            None,
            Some("dup-1".to_string()),
        )
        .await;
    assert_eq!(first["type"], "reply.ack");
    assert_eq!(engine.lock().await.scene_count(), 1);

    // Same messageId: the engine must recognise the retransmit.
    let repeat = client
        .request_with(
            "scene.load",
            json!({ "scene": scene("scene_other", 1) }),
            None,
            Some("dup-1".to_string()),
        )
        .await;
    assert_eq!(repeat["type"], "reply.ack");
    let warnings = repeat["payload"]["warnings"].as_array().unwrap();
    assert!(warnings[0].as_str().unwrap().contains("duplicate"));

    // The second scene was never loaded.
    assert_eq!(engine.lock().await.scene_count(), 1);
    assert_eq!(engine.lock().await.duplicates_dropped, 1);
}

#[tokio::test]
async fn the_connection_keeps_working_after_a_retransmission() {
    // Regression: duplicate suppression used to short-circuit before sequence
    // tracking. A retransmit reuses its messageId but carries a *fresh* sequence,
    // so the skipped sequence was never consumed and every later message looked
    // like it had arrived early — the connection wedged permanently on the first
    // retransmission, which is precisely when reliability matters most.
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    // A retransmit: same messageId, next sequence.
    let first = client
        .request_with(
            "engine.getStatus",
            json!({}),
            None,
            Some("retransmit-1".to_string()),
        )
        .await;
    assert_eq!(first["type"], "reply.status");

    let repeat = client
        .request_with(
            "engine.getStatus",
            json!({}),
            None,
            Some("retransmit-1".to_string()),
        )
        .await;
    assert_eq!(repeat["type"], "reply.ack");
    assert!(repeat["payload"]["warnings"][0]
        .as_str()
        .unwrap()
        .contains("duplicate"));

    assert_eq!(engine.lock().await.duplicates_dropped, 1);

    // The connection must still answer. Before the fix this timed out.
    let after = client.request("engine.getStatus", json!({})).await;
    assert_eq!(
        after["type"], "reply.status",
        "connection wedged after a retransmit"
    );

    // And no spurious gap was recorded.
    assert_eq!(engine.lock().await.sequence_gaps, 0);
}

#[tokio::test]
async fn replies_and_events_never_share_a_message_id() {
    // Regression: replies are numbered by the connection's outbound sequence and
    // events by the engine's event sequence. Both start at 1, so without distinct
    // namespaces the first reply and the first event both claimed `<engine>-1` and a
    // client's duplicate suppression silently dropped one of them. It only shows up
    // once a command emits events, which is why the earlier tests missed it.
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    // Loading a scene and taking it online emits several lifecycle and channel
    // events alongside their replies.
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "sceneRevision": 1, "overrideUnprepared": true }),
        )
        .await;
    client.request("engine.getStatus", json!({})).await;

    // Drain anything still queued so late events are included too.
    for _ in 0..20 {
        let frame =
            tokio::time::timeout(std::time::Duration::from_millis(60), client.socket.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = frame else {
            break;
        };
        let value: Value = serde_json::from_str(&text).expect("json");
        client.record(&value);
    }

    // Both streams must have been exercised, or the test proves nothing.
    assert!(
        client.seen_events > 0,
        "the run should have produced events"
    );
    assert!(
        client.seen_replies > 0,
        "the run should have produced replies"
    );

    let unique: std::collections::HashSet<&String> = client.seen_ids.iter().collect();
    assert_eq!(
        unique.len(),
        client.seen_ids.len(),
        "message ids must be unique across replies and events; saw {:?}",
        duplicates(&client.seen_ids)
    );
}

/// Ids that appeared more than once, for a useful failure message.
fn duplicates(ids: &[String]) -> Vec<String> {
    let mut counts = std::collections::HashMap::new();
    for id in ids {
        *counts.entry(id.clone()).or_insert(0usize) += 1;
    }
    let mut repeated: Vec<String> = counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, count)| format!("{id} x{count}"))
        .collect();
    repeated.sort();
    repeated
}

#[tokio::test]
async fn a_sequence_gap_demands_a_resync_rather_than_guessing() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    // Flood far-future sequences until the park limit is exceeded.
    for index in 0..40u64 {
        client
            .send_raw(
                "engine.getStatus",
                json!({}),
                500 + index,
                &format!("future-{index}"),
            )
            .await;
    }

    let mut saw_gap = false;
    for _ in 0..40 {
        let Some(reply) = client.next_reply().await else {
            break;
        };
        if reply["payload"]["code"] == "SEQUENCE_GAP" {
            saw_gap = true;
            assert!(reply["payload"]["message"]
                .as_str()
                .unwrap()
                .contains("scene.fullSync"));
            assert_eq!(reply["payload"]["requiresFullSync"], true);
            break;
        }
    }

    assert!(
        saw_gap,
        "a sequence gap must be reported, never guessed past"
    );
    assert!(engine.lock().await.sequence_gaps > 0);
}

#[tokio::test]
async fn an_oversized_frame_is_refused_before_it_is_parsed() {
    let port = free_port().await;
    let mut config = base_config(port, false);
    config.security.max_message_bytes = 4096;
    let engine = test_engine(config.clone());

    let served = Arc::clone(&engine);
    tokio::spawn(async move {
        let _ = grapix_render_engine::transport::serve(config, served).await;
    });
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let mut client = Client::connect(port, None).await.expect("connect");
    let reply = client
        .request("scene.load", json!({ "padding": "x".repeat(8192) }))
        .await;

    assert_eq!(reply["payload"]["code"], "MESSAGE_TOO_LARGE");
    // Nothing was counted as received, because it was never decoded.
    assert_eq!(engine.lock().await.messages_received, 0);
}

#[tokio::test]
async fn a_malformed_frame_is_reported_and_the_connection_survives() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");

    client
        .socket
        .send(Message::Text("{not json".to_string().into()))
        .await
        .expect("send");

    let reply = client.next_reply().await.expect("reply");
    assert_eq!(reply["payload"]["code"], "INVALID_JSON");

    // Still usable.
    let hello = client.request("connection.hello", hello_payload()).await;
    assert_eq!(hello["type"], "reply.hello");
}

#[tokio::test]
async fn a_protocol_version_mismatch_is_named_specifically() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");

    client
        .socket
        .send(Message::Text(
            json!({
                "protocolVersion": 2,
                "messageId": "old",
                "type": "engine.getStatus",
                "sequence": 1,
                "timestampMs": 1,
                "requiresAck": false,
                "direction": "client-to-engine",
                "payload": {}
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send");

    let reply = client.next_reply().await.expect("reply");
    assert_eq!(reply["payload"]["code"], "PROTOCOL_VERSION_MISMATCH");
}

#[tokio::test]
async fn a_client_disconnecting_never_disturbs_program() {
    let (port, engine) = start(false).await;

    {
        let mut client = Client::connect(port, None).await.expect("connect");
        client.request("connection.hello", hello_payload()).await;
        client.load_scene(json!(scene("scene_1", 1))).await;
        client
            .request(
                "playout.takeOnline",
                json!({ "sceneId": "scene_1", "sceneRevision": 1, "overrideUnprepared": true }),
            )
            .await;
        assert_eq!(engine.lock().await.state(), EngineState::OnAir);
        // Client dropped here.
    }

    // Give the server a moment to notice the close.
    for _ in 0..100 {
        if engine.lock().await.connected_clients == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // Program state lives in the engine, not in a connection.
    let guard = engine.lock().await;
    assert_eq!(guard.connected_clients, 0);
    assert_eq!(guard.state(), EngineState::OnAir);
    // Both copies survive the disconnect: the authoring one and the published one on Program.
    assert_eq!(guard.scene_count(), 2);
}

// ---------------------------------------------------------------------------
// Unimplemented features
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unimplemented_message_groups_are_refused_explicitly() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    // Every message group in the contract is now implemented, so what is tested here is
    // that an unimplemented *option within* a group is still refused explicitly rather
    // than quietly substituted. Silent substitution is the failure mode that matters: a
    // client that asked for raw frames and was handed JPEG would decode garbage.
    let raw_stream = client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "s",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 160, "maxHeight": 90 },
                "encoding": "raw-bgra",
                "targetFps": 5
            }),
        )
        .await;
    assert_eq!(raw_stream["payload"]["code"], "CAPABILITY_UNSUPPORTED");
    assert!(!raw_stream["payload"]["message"]
        .as_str()
        .unwrap()
        .is_empty());
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/// The sha256 of some bytes, computed the way the engine does.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

async fn upload_asset(client: &mut Client, asset_id: &str, bytes: &[u8]) -> String {
    let sha = sha256_hex(bytes);
    client
        .request(
            "asset.register",
            json!({
                "assetId": asset_id,
                "uri": "",
                "transport": "upload",
                "mimeType": "image/png",
                "sizeBytes": bytes.len(),
                "sha256": sha
            }),
        )
        .await;
    client
        .request(
            "asset.upload",
            json!({
                "assetId": asset_id,
                "sha256": sha,
                "chunkIndex": 0,
                "chunkCount": 1,
                "data": base64_encode(bytes),
                "totalBytes": bytes.len()
            }),
        )
        .await;
    sha
}

#[tokio::test]
async fn an_asset_uploads_in_chunks_and_the_engine_reports_progress() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let bytes: Vec<u8> = (0..300u32).map(|value| (value % 253) as u8).collect();
    let sha = sha256_hex(&bytes);

    let registered = client
        .request(
            "asset.register",
            json!({
                "assetId": "asset_1",
                "uri": "",
                "transport": "upload",
                "mimeType": "image/png",
                "sizeBytes": bytes.len(),
                "sha256": sha
            }),
        )
        .await;
    assert_eq!(registered["type"], "reply.ack");
    assert_eq!(registered["payload"]["alreadyCached"], false);
    // The client needs the chunk limit to size its transfer.
    assert!(registered["payload"]["maxChunkBytes"].as_u64().unwrap() > 0);

    let chunks: Vec<&[u8]> = bytes.chunks(128).collect();
    let chunk_count = chunks.len();
    let mut last = Value::Null;
    for (index, chunk) in chunks.iter().enumerate() {
        last = client
            .request(
                "asset.upload",
                json!({
                    "assetId": "asset_1",
                    "sha256": sha,
                    "chunkIndex": index,
                    "chunkCount": chunk_count,
                    "data": base64_encode(chunk),
                    "totalBytes": bytes.len()
                }),
            )
            .await;
        assert_eq!(last["type"], "reply.assetProgress", "chunk {index}: {last}");
    }

    assert_eq!(last["payload"]["complete"], true);
    assert_eq!(last["payload"]["receivedBytes"], bytes.len());
    assert_eq!(last["payload"]["checksumMismatch"], false);

    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(status["payload"]["assets"]["readyAssets"], 1);
    assert_eq!(status["payload"]["assets"]["registeredAssets"], 1);
}

#[tokio::test]
async fn an_upload_that_does_not_match_its_digest_is_rejected() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let honest = vec![1u8, 2, 3, 4];
    let sha = sha256_hex(&honest);
    client
        .request(
            "asset.register",
            json!({
                "assetId": "asset_bad",
                "uri": "",
                "transport": "upload",
                "mimeType": "image/png",
                "sizeBytes": 4,
                "sha256": sha
            }),
        )
        .await;

    let reply = client
        .request(
            "asset.upload",
            json!({
                "assetId": "asset_bad",
                "sha256": sha,
                "chunkIndex": 0,
                "chunkCount": 1,
                "data": base64_encode(&[9u8, 9, 9, 9]),
                "totalBytes": 4
            }),
        )
        .await;

    // An error, not a progress update: a client treating it as "keep going" would wait
    // forever for a transfer that has been discarded.
    assert_eq!(reply["payload"]["code"], "ASSET_REJECTED");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("CHECKSUM_MISMATCH"));

    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(status["payload"]["assets"]["failedAssets"], 1);
    assert_eq!(status["payload"]["assets"]["readyAssets"], 0);
}

#[tokio::test]
async fn an_asset_path_outside_the_configured_roots_is_refused() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    // The boundary that stops a remote client naming an arbitrary file.
    let reply = client
        .request(
            "asset.register",
            json!({
                "assetId": "asset_escape",
                "uri": "../../../etc/passwd",
                "transport": "engine-local",
                "mimeType": "image/png",
                "sizeBytes": 10,
                "sha256": "a".repeat(64)
            }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "PATH_NOT_PERMITTED");
}

#[tokio::test]
async fn a_scene_declaring_an_absent_asset_cannot_be_taken() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let mut scene_with_asset = scene("scene_assets", 1);
    scene_with_asset["assets"] = json!([
        { "assetId": "asset_missing", "name": "Crest", "kind": "image" }
    ]);

    client.load_scene(json!(scene_with_asset)).await;
    // The take acts on the published copy, so that is the copy that must be prepared for this
    // to prove anything about going on air. Preparing the authoring copy and taking the
    // published one would test the wrong scene.
    let published_ref = json!({
        "projectId": "protocol-test", "domain": "published", "sceneId": "scene_assets", "revision": 1
    });
    let prepared = client
        .request_for("scene.prepare", json!({ "sceneId": "scene_assets" }), published_ref)
        .await;

    // A scene that goes on air without its logo shows a hole, and the operator finds out
    // from the picture.
    assert_eq!(prepared["type"], "reply.scenePrepared");
    assert_eq!(prepared["payload"]["declaredAssetCount"], 1);
    assert_eq!(prepared["payload"]["preparedAssetCount"], 0);
    assert_eq!(prepared["payload"]["missingAssetIds"][0], "asset_missing");

    let take = client
        .request("playout.takeOnline", json!({ "sceneId": "scene_assets" }))
        .await;
    assert_eq!(take["payload"]["code"], "SCENE_NOT_PREPARED");
    assert!(take["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("asset_missing"));
}

#[tokio::test]
async fn an_asset_a_loaded_scene_needs_cannot_be_released_without_force() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let bytes = vec![7u8; 64];
    upload_asset(&mut client, "asset_held", &bytes).await;

    let mut scene_with_asset = scene("scene_holder", 1);
    scene_with_asset["assets"] = json!([
        { "assetId": "asset_held", "name": "Crest", "kind": "image" }
    ]);
    client.load_scene(json!(scene_with_asset)).await;
    client
        .request("scene.prepare", json!({ "sceneId": "scene_holder" }))
        .await;

    let refused = client
        .request("asset.release", json!({ "assetIds": ["asset_held"] }))
        .await;
    assert_eq!(refused["type"], "reply.ack");
    assert_eq!(refused["payload"]["released"].as_array().unwrap().len(), 0);
    assert_eq!(
        refused["payload"]["refused"][0]["code"],
        "ASSET_STILL_REFERENCED"
    );
    assert!(refused["payload"]["refused"][0]["message"]
        .as_str()
        .unwrap()
        .contains("scene_holder"));

    // Unloading the scene releases the hold, and then the asset can go.
    client
        .request("scene.unload", json!({ "sceneId": "scene_holder" }))
        .await;
    let released = client
        .request("asset.release", json!({ "assetIds": ["asset_held"] }))
        .await;
    assert_eq!(released["payload"]["released"][0], "asset_held");
}

#[tokio::test]
async fn validating_an_asset_answers_the_question_rather_than_erroring() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let bytes = vec![5u8; 32];
    let sha = sha256_hex(&bytes);
    client
        .request(
            "asset.register",
            json!({
                "assetId": "asset_v",
                "uri": "",
                "transport": "upload",
                "mimeType": "image/png",
                "sizeBytes": bytes.len(),
                "sha256": sha
            }),
        )
        .await;

    // Not uploaded yet: a true negative answer, not a failure.
    let before = client
        .request("asset.validate", json!({ "assetId": "asset_v" }))
        .await;
    assert_eq!(before["type"], "reply.ack");
    assert_eq!(before["payload"]["present"], false);

    client
        .request(
            "asset.upload",
            json!({
                "assetId": "asset_v",
                "sha256": sha,
                "chunkIndex": 0,
                "chunkCount": 1,
                "data": base64_encode(&bytes),
                "totalBytes": bytes.len()
            }),
        )
        .await;

    let after = client
        .request("asset.validate", json!({ "assetId": "asset_v" }))
        .await;
    assert_eq!(after["payload"]["present"], true);
    assert_eq!(after["payload"]["digestMatches"], true);
    assert_eq!(after["payload"]["sizeBytes"], bytes.len());
}

#[tokio::test]
async fn preloading_reports_what_is_ready_and_what_is_not() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let bytes = vec![3u8; 16];
    upload_asset(&mut client, "asset_ready", &bytes).await;

    let reply = client
        .request(
            "asset.preload",
            json!({ "assetIds": ["asset_ready", "asset_absent"], "decode": true }),
        )
        .await;

    assert_eq!(reply["payload"]["ready"][0], "asset_ready");
    assert_eq!(reply["payload"]["missing"][0], "asset_absent");
    // Decode-on-preload is not implemented, and the reply says so rather than implying it
    // happened.
    assert!(reply["payload"]["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning.as_str().unwrap().contains("preparation")));
}

#[tokio::test]
async fn an_upload_that_arrives_a_second_time_costs_nothing() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let bytes = vec![11u8; 48];
    let sha = upload_asset(&mut client, "asset_first", &bytes).await;

    // A second asset id with identical content: content addressing means no transfer.
    let registered = client
        .request(
            "asset.register",
            json!({
                "assetId": "asset_second",
                "uri": "",
                "transport": "upload",
                "mimeType": "image/png",
                "sizeBytes": bytes.len(),
                "sha256": sha
            }),
        )
        .await;

    assert_eq!(registered["payload"]["alreadyCached"], true);
    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(status["payload"]["assets"]["readyAssets"], 2);
    assert_eq!(
        status["payload"]["assets"]["detail"]["deduplicatedUploads"],
        1
    );
}

#[tokio::test]
async fn a_patch_is_applied_and_reports_what_it_invalidated() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 2))).await;

    let reply = client
        .request(
            "scene.applyPatch",
            json!({
                "patch": {
                    "sceneId": "scene_1",
                    "baseRevision": 2,
                    "revision": 3,
                    "timestampMs": 0,
                    "operations": [
                        { "type": "object.transform", "objectId": "rect_1", "transform": { "x": 400.0 } }
                    ]
                }
            }),
        )
        .await;

    assert_eq!(reply["type"], "reply.ack", "scene.applyPatch refused: {}", reply);
    assert_eq!(reply["payload"]["sceneRevision"], 3);
    assert_eq!(reply["payload"]["operationsApplied"], 1);
    assert_eq!(reply["payload"]["objectsTouched"][0], "rect_1");
    // The point of a patch: a moved rectangle does not invalidate the whole scene.
    assert_eq!(reply["payload"]["wholeSceneInvalidated"], false);

    // The engine now holds the new revision, so the next patch has to be based on it.
    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(status["payload"]["scenes"][0]["revision"], 3);
    assert!(engine.lock().await.resync_count == 0);
}

#[tokio::test]
async fn a_patch_based_on_the_wrong_revision_is_refused_and_counted_as_a_resync() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 2))).await;

    let stale = client
        .request(
            "scene.applyPatch",
            json!({
                "patch": {
                    "sceneId": "scene_1",
                    "baseRevision": 1,
                    "revision": 2,
                    "timestampMs": 0,
                    "operations": [
                        { "type": "object.visibility", "objectId": "rect_1", "visible": false }
                    ]
                }
            }),
        )
        .await;

    assert_eq!(stale["payload"]["code"], "REVISION_MISMATCH");
    assert!(stale["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("scene.fullSync"));

    // Nothing was applied: the two sides disagree about what is held.
    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(status["payload"]["scenes"][0]["revision"], 2);
    assert!(engine.lock().await.resync_count > 0);
}

#[tokio::test]
async fn a_patch_that_fails_part_way_leaves_the_engine_on_its_previous_revision() {
    // The failure that would be invisible from the output: a half-applied document.
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "scene.applyPatch",
            json!({
                "patch": {
                    "sceneId": "scene_1",
                    "baseRevision": 1,
                    "revision": 2,
                    "timestampMs": 0,
                    "operations": [
                        { "type": "object.visibility", "objectId": "rect_1", "visible": false },
                        { "type": "object.text", "objectId": "ghost", "text": "nope" }
                    ]
                }
            }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "INVALID_PAYLOAD");
    let message = reply["payload"]["message"].as_str().unwrap();
    assert!(message.contains("UNKNOWN_OBJECT"), "{message}");
    // Names which operation failed, so the sender can fix the right one.
    assert!(message.contains("operation 1"), "{message}");

    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(status["payload"]["scenes"][0]["revision"], 1);
}

#[tokio::test]
async fn a_structural_patch_says_it_invalidated_the_whole_scene() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    // A data change can be read by any binding, and the document carries no reverse
    // index, so it cannot be localised to objects.
    let reply = client
        .request(
            "scene.applyPatch",
            json!({
                "patch": {
                    "sceneId": "scene_1",
                    "baseRevision": 1,
                    "revision": 2,
                    "timestampMs": 0,
                    "operations": [
                        { "type": "dataContext.changed", "path": "player.name", "value": "BIANCA" }
                    ]
                }
            }),
        )
        .await;

    assert_eq!(reply["type"], "reply.ack");
    assert_eq!(reply["payload"]["wholeSceneInvalidated"], true);
}

#[tokio::test]
async fn an_operation_this_engine_does_not_implement_is_named_in_the_refusal() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "scene.applyPatch",
            json!({
                "patch": {
                    "sceneId": "scene_1",
                    "baseRevision": 1,
                    "revision": 2,
                    "operations": [{ "type": "object.teleport", "objectId": "rect_1" }]
                }
            }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "INVALID_PAYLOAD");
    // Listing the supported set is what lets a client tell a typo from a version skew.
    let message = reply["payload"]["message"].as_str().unwrap();
    assert!(message.contains("object.transform"), "{message}");
    assert!(message.contains("dataContext.changed"), "{message}");
}

#[tokio::test]
async fn a_full_sync_replaces_the_scene_and_is_counted() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "scene.fullSync",
            json!({ "scene": scene("scene_1", 7), "reason": "revision-gap" }),
        )
        .await;
    assert_eq!(reply["type"], "reply.ack");

    let status = client.request("engine.getStatus", json!({})).await;
    let scenes = status["payload"]["scenes"].as_array().unwrap();
    // The authoring copy is the one fullSync replaced; the published copy is a separate
    // address and is untouched by an authoring-side sync.
    let authoring = scenes
        .iter()
        .find(|scene| {
            scene["sceneId"]
                .as_str()
                .map(|key| key.contains("|9:authoring|"))
                .unwrap_or(false)
        })
        .expect("an authoring copy");
    assert_eq!(authoring["revision"], 7);
    assert!(engine.lock().await.resync_count > 0);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

#[tokio::test]
async fn diagnostics_include_the_tile_table_only_when_asked() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let compact = client
        .request("engine.getDiagnostics", json!({ "includeTiles": false }))
        .await;
    assert_eq!(compact["type"], "reply.diagnostics");
    assert!(compact["payload"].get("tileDetail").is_none());

    // The per-tile table can be thousands of rows, so it is opt-in.
    let full = client
        .request("engine.getDiagnostics", json!({ "includeTiles": true }))
        .await;
    assert!(full["payload"]["tileDetail"].is_array());
    assert!(
        full["payload"]["gpuLimits"]["maxTextureDimension2d"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(full["payload"]["assetRoots"].is_array());
    assert!(full["payload"]["stateHistory"].is_array());
}

#[tokio::test]
async fn status_reports_the_engine_identity_and_network_counters() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let status = client.request("engine.getStatus", json!({})).await;
    let payload = &status["payload"];

    assert_eq!(payload["engineId"], "engine_test");
    assert_eq!(payload["state"], "ready");
    assert_eq!(payload["headless"], true);
    assert_eq!(payload["network"]["connectedClients"], 1);
    assert!(payload["network"]["messagesReceived"].as_u64().unwrap() >= 2);
    assert!(payload["uptimeMs"].as_u64().is_some());
    assert_eq!(payload["tiles"]["overscan"], 32);
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/// Configure a headless virtual output, which needs no SDK and cannot reach air.
async fn configure_virtual(client: &mut Client, output_id: &str) -> Value {
    client
        .request(
            "output.configure",
            json!({
                "outputId": output_id,
                "adapterId": "virtual",
                "format": {
                    "width": 1920,
                    "height": 1080,
                    "frameRate": { "numerator": 50, "denominator": 1 },
                    "alphaMode": "premultiplied",
                    "colorSpace": "rec709"
                }
            }),
        )
        .await
}

fn output_named<'a>(payload: &'a Value, output_id: &str) -> &'a Value {
    payload["outputs"]
        .as_array()
        .expect("outputs array")
        .iter()
        .find(|output| output["outputId"] == output_id)
        .unwrap_or_else(|| panic!("no output {output_id} in {payload}"))
}

fn adapter_named<'a>(payload: &'a Value, adapter_id: &str) -> &'a Value {
    payload["availableAdapters"]
        .as_array()
        .expect("adapter array")
        .iter()
        .find(|adapter| adapter["adapterId"] == adapter_id)
        .unwrap_or_else(|| panic!("no adapter {adapter_id}"))
}

#[tokio::test]
async fn the_output_list_says_which_adapters_are_live_and_why_one_is_unavailable() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client.request("output.list", json!({})).await;
    assert_eq!(reply["type"], "reply.outputs");
    let payload = &reply["payload"];

    // Nothing configured yet, but every adapter is still listed: an operator needs to
    // see that NDI exists and why it cannot be used, not merely that it is absent.
    assert!(payload["outputs"].as_array().unwrap().is_empty());

    let virtual_adapter = adapter_named(payload, "virtual");
    assert_eq!(virtual_adapter["live"], false);
    assert_eq!(virtual_adapter["available"], true);

    let ndi = adapter_named(payload, "ndi");
    assert_eq!(ndi["live"], true);
    // Not certified even when the SDK is linked: compiling it in is not evidence.
    assert_eq!(ndi["hardwareCertified"], false);

    let decklink = adapter_named(payload, "decklink");
    assert_eq!(decklink["live"], true);
    assert_eq!(decklink["available"], false);
    assert!(decklink["unavailableReason"]
        .as_str()
        .unwrap()
        .contains("SDK"));
}

#[tokio::test]
async fn an_adapter_the_deployment_did_not_enable_cannot_be_configured() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    // The point of the allowlist: a remote client must not be able to conjure a live
    // output the deployment never sanctioned.
    let reply = client
        .request(
            "output.configure",
            json!({ "outputId": "out_sdi", "adapterId": "decklink" }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "OUTPUT_ERROR");
    let message = reply["payload"]["message"].as_str().unwrap();
    assert!(message.contains("not enabled"));
    // The error names what *is* allowed, so the operator can act on it.
    assert!(message.contains("virtual"));
}

#[tokio::test]
async fn a_virtual_output_configures_and_starts_and_reports_that_it_is_not_live() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let configured = configure_virtual(&mut client, "out_virtual").await;
    assert_eq!(configured["type"], "reply.ack");
    let warnings = configured["payload"]["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap().contains("no frames leave this machine")),
        "the headless guarantee must be stated: {warnings:?}"
    );

    let started = client
        .request("output.start", json!({ "outputId": "out_virtual" }))
        .await;
    assert_eq!(started["type"], "reply.ack");
    // No "frames now reach an audience" warning, because they do not.
    assert!(started["payload"]["warnings"]
        .as_array()
        .unwrap()
        .is_empty());

    let listed = client.request("output.list", json!({})).await;
    let output = output_named(&listed["payload"], "out_virtual");
    assert_eq!(output["live"], false);
    assert_eq!(output["state"], "running");
    assert_eq!(output["width"], 1920);
    assert_eq!(output["colorSpace"], "rec709");
}

#[tokio::test]
async fn taking_a_scene_online_starts_the_outputs_and_taking_it_offline_stops_them() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    configure_virtual(&mut client, "out_virtual").await;

    // Configured but not started: taking the scene online is what starts it.
    let before = client.request("output.list", json!({})).await;
    assert_eq!(
        output_named(&before["payload"], "out_virtual")["state"],
        "configured"
    );

    // No GPU in these tests, so the scene cannot prepare; the override is the
    // documented operator path and is what exercises the take.
    let take = client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;
    assert_eq!(take["type"], "reply.ack");

    let warnings: Vec<String> = take["payload"]["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_string())
        .collect();

    // The reply must distinguish what is on air from what is merely rendering.
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("headlessly") && w.contains("not live")),
        "{warnings:?}"
    );
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("nothing from this take reaches air")),
        "an operator must be told no live output is running: {warnings:?}"
    );
    assert_eq!(take["payload"]["liveOutputs"], 0);
    assert_eq!(
        output_named(&take["payload"], "out_virtual")["state"],
        "running"
    );

    {
        let guard = engine.lock().await;
        assert!(
            guard.has_running_outputs(),
            "the program clock needs this true"
        );
    }

    // Off air means nothing transmits: a still-running output would keep pushing the
    // last rendered frame out.
    let offline = client
        .request("playout.takeOffline", json!({ "sceneId": "scene_1" }))
        .await;
    assert_eq!(offline["payload"]["outputsStopped"], 1);

    let after = client.request("output.list", json!({})).await;
    assert_eq!(
        output_named(&after["payload"], "out_virtual")["state"],
        "configured"
    );
    assert!(!engine.lock().await.has_running_outputs());
}

#[tokio::test]
async fn a_take_with_no_output_configured_says_it_is_rendering_nowhere() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let take = client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;

    // "On air" with no output looks identical to a healthy take in every other
    // respect, which is exactly why it has to be said out loud.
    let warnings: Vec<String> = take["payload"]["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_string())
        .collect();
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("not being rendered anywhere")),
        "{warnings:?}"
    );
    assert_eq!(take["payload"]["liveOutputs"], 0);
}

#[tokio::test]
async fn clearing_program_also_stops_the_outputs() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    configure_virtual(&mut client, "out_virtual").await;
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;

    // A clear is an operator saying "get it off air".
    client
        .request("playout.clear", json!({ "channel": "program" }))
        .await;

    assert!(!engine.lock().await.has_running_outputs());
}

#[tokio::test]
async fn reconfiguring_an_output_stops_the_running_one_first() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    configure_virtual(&mut client, "out_virtual").await;
    client
        .request("output.start", json!({ "outputId": "out_virtual" }))
        .await;

    // Same id, different format. A running output must never be reconfigured
    // underneath itself.
    client
        .request(
            "output.configure",
            json!({
                "outputId": "out_virtual",
                "adapterId": "virtual",
                "format": { "width": 1280, "height": 720 }
            }),
        )
        .await;

    let listed = client.request("output.list", json!({})).await;
    let outputs = listed["payload"]["outputs"].as_array().unwrap();
    // Replaced, not duplicated.
    assert_eq!(outputs.len(), 1);
    let output = output_named(&listed["payload"], "out_virtual");
    assert_eq!(output["state"], "configured");
    assert_eq!(output["width"], 1280);
}

#[tokio::test]
async fn an_output_larger_than_the_render_limit_is_refused_with_the_number() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    // A 50,000-wide output is exactly the case the whole tiling design exists for,
    // and a single output surface is not where it is solved.
    let reply = client
        .request(
            "output.configure",
            json!({
                "outputId": "out_wall",
                "adapterId": "virtual",
                "format": { "width": 50_000, "height": 1080 }
            }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "OUTPUT_ERROR");
    let message = reply["payload"]["message"].as_str().unwrap();
    assert!(message.contains("16384"), "{message}");
    assert!(message.contains("region mapping"), "{message}");
}

#[tokio::test]
async fn a_zero_sized_output_is_a_payload_error_not_an_output_error() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client
        .request(
            "output.configure",
            json!({
                "outputId": "out_zero",
                "adapterId": "virtual",
                "format": { "width": 0, "height": 1080 }
            }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "INVALID_PAYLOAD");
}

#[tokio::test]
async fn removing_an_unknown_output_is_an_error_and_a_stopped_one_is_removed() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let missing = client
        .request("output.remove", json!({ "outputId": "out_ghost" }))
        .await;
    assert_eq!(missing["payload"]["code"], "OUTPUT_ERROR");

    configure_virtual(&mut client, "out_virtual").await;
    client
        .request("output.start", json!({ "outputId": "out_virtual" }))
        .await;

    // A running *virtual* output can be removed: nothing is on air to drop. The
    // refusal exists for live outputs, which cannot start in this build at all.
    let removed = client
        .request("output.remove", json!({ "outputId": "out_virtual" }))
        .await;
    assert_eq!(removed["type"], "reply.ack");

    let listed = client.request("output.list", json!({})).await;
    assert!(listed["payload"]["outputs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn output_health_events_are_emitted_when_an_output_changes_state() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let before = client.seen_events;
    configure_virtual(&mut client, "out_virtual").await;
    client
        .request("output.start", json!({ "outputId": "out_virtual" }))
        .await;
    // Force one more round trip so any pending events are read.
    client.request("engine.getStatus", json!({})).await;

    // An operator UI must not have to poll to learn an output changed.
    assert!(
        client.seen_events > before,
        "expected output health events, saw {} then {}",
        before,
        client.seen_events
    );
}

// ---------------------------------------------------------------------------
// Preview streaming
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_preview_stream_registers_and_reports_its_cadence() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "stream_1",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 480, "maxHeight": 270 },
                "encoding": "jpeg",
                "targetFps": 10
            }),
        )
        .await;

    assert_eq!(reply["type"], "reply.ack");
    assert_eq!(reply["payload"]["streamId"], "stream_1");
    assert_eq!(reply["payload"]["targetFps"], 10.0);
    assert_eq!(reply["payload"]["intervalMs"], 100);
    assert!(engine.lock().await.has_preview_streams());

    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(
        status["payload"]["previewStreams"][0]["streamId"],
        "stream_1"
    );

    let stopped = client
        .request("preview.streamStop", json!({ "streamId": "stream_1" }))
        .await;
    assert_eq!(stopped["type"], "reply.ack");
    assert!(!engine.lock().await.has_preview_streams());
}

#[tokio::test]
async fn a_stream_rate_above_the_engine_ceiling_is_clamped_and_says_so() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "stream_fast",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 320, "maxHeight": 180 },
                "encoding": "jpeg",
                "targetFps": 500
            }),
        )
        .await;

    // Clamped rather than refused - but never silently, because a client's animation
    // timing may depend on the rate it asked for.
    assert_eq!(reply["payload"]["targetFps"], 30.0);
    let warnings = reply["payload"]["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap().contains("clamped")),
        "{warnings:?}"
    );
}

#[tokio::test]
async fn a_stream_encoding_this_engine_cannot_produce_is_refused_not_substituted() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "stream_raw",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 320, "maxHeight": 180 },
                "encoding": "raw-bgra",
                "targetFps": 10
            }),
        )
        .await;

    // Handing a client JPEG when it asked for raw would have it decode garbage.
    assert_eq!(reply["payload"]["code"], "CAPABILITY_UNSUPPORTED");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("jpeg only"));
}

#[tokio::test]
async fn a_stream_over_the_pixel_budget_is_refused_when_it_is_asked_for() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    // Refused at registration, not thirty times a second afterwards.
    let reply = client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "stream_huge",
                "channel": "preview",
                // The stage is 1920x1080, so a huge rect is clipped to it. Four times
                // scale is what actually breaches the 2,073,600-pixel budget: 7680x4320.
                "source": { "type": "rect", "x": 0, "y": 0, "width": 1920, "height": 1080, "renderScale": 4 },
                "encoding": "jpeg",
                "targetFps": 5
            }),
        )
        .await;

    assert_eq!(reply["payload"]["code"], "PREVIEW_TOO_LARGE");
}

#[tokio::test]
async fn there_is_a_limit_on_concurrent_streams() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    for index in 0..4 {
        let reply = client
            .request(
                "preview.streamStart",
                json!({
                    "streamId": format!("stream_{index}"),
                    "channel": "preview",
                    "source": { "type": "scaled-stage", "maxWidth": 160, "maxHeight": 90 },
                    "encoding": "jpeg",
                    "targetFps": 5
                }),
            )
            .await;
        assert_eq!(reply["type"], "reply.ack", "stream {index}: {reply}");
    }

    // The fifth is refused with the number, so a client can act on it.
    let refused = client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "stream_5",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 160, "maxHeight": 90 },
                "encoding": "jpeg",
                "targetFps": 5
            }),
        )
        .await;
    assert_eq!(refused["payload"]["code"], "CAPABILITY_UNSUPPORTED");
    assert!(refused["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("4"));
}

#[tokio::test]
async fn a_client_cannot_take_over_another_clients_preview_stream_id() {
    let (port, engine) = start(false).await;
    let mut owner = Client::connect(port, None).await.expect("owner connects");
    owner.request("connection.hello", hello_payload()).await;
    owner.load_scene(scene("scene_1", 1)).await;
    owner
        .request(
            "preview.streamStart",
            json!({
                "streamId": "shared_stream",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 160, "maxHeight": 90 },
                "encoding": "jpeg",
                "targetFps": 5
            }),
        )
        .await;

    let mut other = Client::connect(port, None).await.expect("other connects");
    other.request("connection.hello", hello_payload()).await;
    let takeover = other
        .request(
            "preview.streamStart",
            json!({
                "streamId": "shared_stream",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 160, "maxHeight": 90 },
                "encoding": "jpeg",
                "targetFps": 5
            }),
        )
        .await;

    assert_eq!(takeover["payload"]["code"], "UNAUTHORIZED");
    assert!(engine.lock().await.has_preview_streams());
    let stopped = owner
        .request("preview.streamStop", json!({ "streamId": "shared_stream" }))
        .await;
    assert_eq!(stopped["type"], "reply.ack");
}

#[tokio::test]
async fn stopping_an_unknown_stream_is_an_error_not_a_silent_success() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;

    let reply = client
        .request("preview.streamStop", json!({ "streamId": "never_started" }))
        .await;
    assert_eq!(reply["payload"]["code"], "INVALID_PAYLOAD");
}

#[tokio::test]
async fn a_stream_can_be_repointed_without_restarting_it() {
    let (port, _engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "stream_1",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 480, "maxHeight": 270 },
                "encoding": "jpeg",
                "targetFps": 10
            }),
        )
        .await;

    // Panning a viewport must not drop frames or lose the stream id the client is keyed
    // on, which is why this exists instead of stop-and-start.
    let moved = client
        .request(
            "preview.setViewport",
            json!({
                "streamId": "stream_1",
                "source": { "type": "rect", "x": 100, "y": 100, "width": 960, "height": 540, "renderScale": 0.5 }
            }),
        )
        .await;

    assert_eq!(moved["type"], "reply.ack");
    assert_eq!(moved["payload"]["width"], 480);
    assert_eq!(moved["payload"]["height"], 270);

    // A region over the budget is refused and the stream keeps its previous source: a
    // stream must never be left pointing at something it cannot render.
    let refused = client
        .request(
            "preview.setViewport",
            json!({
                "streamId": "stream_1",
                "source": { "type": "rect", "x": 0, "y": 0, "width": 1920, "height": 1080, "renderScale": 4 }
            }),
        )
        .await;
    assert_eq!(refused["payload"]["code"], "PREVIEW_TOO_LARGE");
}

#[tokio::test]
async fn streams_are_dropped_when_their_client_disconnects() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "preview.streamStart",
            json!({
                "streamId": "stream_1",
                "channel": "preview",
                "source": { "type": "scaled-stage", "maxWidth": 320, "maxHeight": 180 },
                "encoding": "jpeg",
                "targetFps": 5
            }),
        )
        .await;
    assert!(engine.lock().await.has_preview_streams());

    drop(client);

    // Otherwise a reconnecting Editor accumulates streams rendering frames nobody
    // receives.
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        if !engine.lock().await.has_preview_streams() {
            break;
        }
    }
    assert!(
        !engine.lock().await.has_preview_streams(),
        "the departed client's stream is still registered"
    );
}

// ---------------------------------------------------------------------------
// Renderer restart
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_renderer_restart_rebuilds_state_and_is_honest_about_what_it_cannot_do() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    let reply = client
        .request(
            "engine.restartRenderer",
            json!({ "reason": "pipeline cache corrupt", "preserveProgram": true }),
        )
        .await;

    assert_eq!(reply["type"], "reply.ack");
    assert_eq!(reply["payload"]["scenesReset"], 2);
    assert_eq!(reply["payload"]["rendererRestarts"], 1);

    let warnings: Vec<String> = reply["payload"]["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_string())
        .collect();
    // The important honesty: this is not a device recovery and must not be sold as one.
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("does not re-acquire the device")),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().any(|w| w.contains("prepared again")),
        "{warnings:?}"
    );

    // A scene must be prepared again before it can be taken: its GPU resources are gone.
    let status = client.request("engine.getStatus", json!({})).await;
    assert_eq!(
        status["payload"]["scenes"][0]["preparationState"],
        "loading"
    );
    assert_eq!(status["payload"]["rendererRestarts"], 1);

    let take = client
        .request("playout.takeOnline", json!({ "sceneId": "scene_1" }))
        .await;
    assert_eq!(take["payload"]["code"], "SCENE_NOT_PREPARED");

    assert_eq!(engine.lock().await.state(), EngineState::Ready);
}
// ---------------------------------------------------------------------------
// Animation playhead
// ---------------------------------------------------------------------------
//
// Program and Preview used to sample one scene frame. Program now advances its stored frame,
// while Preview derives an independent playhead from Cue time at the authored rational rate.
// The tests below protect both halves: animation advances with no output, and cueing the same
// scene never rewinds what is already on air.

/// True when a runtime scene key names this scene.
///
/// The engine reports scenes under their runtime `SceneRef` key - length-prefixed segments
/// ending in `:<id>|<revision>` - never under the bare document id. Comparing against the
/// bare id is never true, so these helpers match on the trailing segment instead.
fn scene_key_is(runtime_key: &str, scene_id: &str) -> bool {
    // Split off the trailing revision, then compare the id segment: `…|9:scene_1|3` → `scene_1`.
    let address = runtime_key.rsplit_once('|').map(|(head, _)| head).unwrap_or(runtime_key);
    address
        .rsplit_once('|')
        .map(|(_, id_segment)| id_segment.rsplit_once(':').map(|(_, id)| id).unwrap_or(id_segment) == scene_id)
        .unwrap_or(false)
}

/// Read a scene's playhead the way a diagnostic client would.
async fn playhead(client: &mut Client, scene_id: &str) -> u64 {
    let status = client.request("engine.getStatus", json!({})).await;
    let scenes = status["payload"]["scenes"]
        .as_array()
        .expect("scenes")
        .clone();
    scenes
        .iter()
        .find(|scene| {
            scene["sceneId"]
                .as_str()
                .map(|key| {
                    // Program and Preview are the published copy, which is the one these
                    // assertions are about. Both copies carry the same id, so without the
                    // domain filter this reads the authoring copy, whose frame never advances
                    // and which every take assertion then misattributes.
                    scene_key_is(key, scene_id) && key.contains("|9:published|")
                })
                .unwrap_or(false)
        })
        .and_then(|scene| scene["frame"].as_u64())
        .expect("scene reports a frame")
}

#[tokio::test]
async fn preview_and_program_have_independent_animation_playheads() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    // Preview starts where Cue asks and advances on its authored clock without touching
    // Program's frame. This remains true even when no output is configured.
    client
        .request(
            "playout.cue",
            json!({ "sceneId": "scene_1", "channel": "preview", "startFrame": 30 }),
        )
        .await;
    assert_eq!(playhead(&mut client, "scene_1").await, 0);
    assert!(
        engine
            .lock()
            .await
            .channel_frame(Channel::Preview, "scene_1")
            >= 30
    );

    // A take starts Program's "in" animation at frame zero. Preview owning a separate
    // playhead prevents this from either freezing Preview or inheriting its frame 30.
    let take = client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;
    assert_eq!(take["type"], "reply.ack", "{take}");
    assert_eq!(playhead(&mut client, "scene_1").await, 0);
}

#[tokio::test]
async fn a_cued_preview_advances_without_program_or_outputs() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "playout.cue",
            json!({ "sceneId": "scene_1", "channel": "preview" }),
        )
        .await;

    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert!(
        engine
            .lock()
            .await
            .channel_frame(Channel::Preview, "scene_1")
            >= 2,
        "the 50 fps preview clock should advance independently of stream delivery"
    );
}

#[tokio::test]
async fn the_program_playhead_advances_without_any_output() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;

    assert_eq!(playhead(&mut client, "scene_1").await, 0);
    assert!(
        !engine.lock().await.has_running_outputs(),
        "this test is only meaningful with nothing transmitting"
    );

    // Deliberately independent of outputs: an operator confirms a graphic on the monitors
    // before any SDI or NDI output exists, so the animation has to run regardless.
    engine.lock().await.advance_program_playhead(7);
    assert_eq!(playhead(&mut client, "scene_1").await, 7);

    // Elapsed frames, not an absolute frame number, so a dropped frame moves the animation
    // on by the time that really passed instead of playing it in slow motion.
    engine.lock().await.advance_program_playhead(3);
    assert_eq!(playhead(&mut client, "scene_1").await, 10);
}

#[tokio::test]
async fn cueing_a_scene_that_is_already_on_air_does_not_rewind_program() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;
    engine.lock().await.advance_program_playhead(12);
    assert_eq!(playhead(&mut client, "scene_1").await, 12);

    // Preview and Program can name the same loaded scene, but their playheads are independent.
    // Cue must restart Preview without yanking live Program back to the start.
    let cued = client
        .request(
            "playout.cue",
            json!({ "sceneId": "scene_1", "channel": "preview" }),
        )
        .await;
    assert_eq!(cued["type"], "reply.ack", "{cued}");
    assert_eq!(
        playhead(&mut client, "scene_1").await,
        12,
        "cueing the on-air scene rewound Program"
    );
}

#[tokio::test]
async fn advancing_the_playhead_with_nothing_on_air_does_nothing() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;

    // Loaded but never taken: an idle engine must not animate a scene nobody put on air.
    engine.lock().await.advance_program_playhead(25);
    assert_eq!(playhead(&mut client, "scene_1").await, 0);

    // And a zero advance is a no-op rather than a scene lookup.
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;
    engine.lock().await.advance_program_playhead(0);
    assert_eq!(playhead(&mut client, "scene_1").await, 0);
}

#[tokio::test]
async fn stopping_a_scene_returns_its_playhead_to_the_start() {
    let (port, engine) = start(false).await;
    let mut client = Client::connect(port, None).await.expect("connect");
    client.request("connection.hello", hello_payload()).await;
    client.load_scene(json!(scene("scene_1", 1))).await;
    client
        .request(
            "playout.takeOnline",
            json!({ "sceneId": "scene_1", "overrideUnprepared": true }),
        )
        .await;
    engine.lock().await.advance_program_playhead(18);
    assert_eq!(playhead(&mut client, "scene_1").await, 18);

    client
        .request("playout.stop", json!({ "sceneId": "scene_1" }))
        .await;
    assert_eq!(playhead(&mut client, "scene_1").await, 0);
}
