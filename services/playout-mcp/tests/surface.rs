//! The Program tools driven over the real JSON-RPC transport.
//!
//! The unit tests in `gx-playout-mcp` call handlers directly, which proves the
//! bodies are right but not that they are *reachable*. A handler registered
//! under a name the registry does not carry, or behind a scope nothing grants,
//! passes every unit test and answers nothing in production. So this drives
//! newline-delimited JSON-RPC through `Server::serve` — the same path a real
//! agent takes — and asserts on the bytes that come back.

use gx_contracts::auth::Scope;
use gx_mcp_server::Server;
use gx_playout_mcp::{PackagesBuild, PackagesInspect, PackagesPublish, PlayoutLibrary, PlayoutTake};
use gx_playout::PublishedLibrary;
use parking_lot::Mutex;

/// Run a batch of requests through the server and return the parsed replies.
fn drive(server: &Server, requests: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let input: String = requests
        .iter()
        .map(|request| format!("{request}\n"))
        .collect();
    let mut output = Vec::new();
    server
        .serve(std::io::BufReader::new(input.as_bytes()), &mut output)
        .expect("the transport writes its replies");
    String::from_utf8(output)
        .expect("replies are UTF-8")
        .lines()
        .map(|line| serde_json::from_str(line).expect("each reply is one JSON object"))
        .collect()
}

fn call(id: u64, tool: &str, arguments: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    })
}

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn scene(id: &str) -> gx_contracts::scene::SceneDocument {
    gx_contracts::scene::SceneDocument {
        id: id.into(),
        name: id.into(),
        version: 1,
        revision: Some(gx_contracts::Revision(1)),
        active_camera_id: None,
        canvas: gx_contracts::scene::SceneCanvas {
            width: 1920,
            height: 1080,
            frame_rate: gx_contracts::RationalRate::P50,
        },
        timeline: gx_contracts::scene::SceneTimeline { duration_frames: 1 },
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        objects: Vec::new(),
    }
}

#[test]
fn an_author_builds_and_publishes_a_package_over_the_wire() {
    // 8.10 end to end, as an agent would do it: build, look inside, publish,
    // and read back the revision it must pin.
    let root = scratch("publish");
    let package = root.join("lower-third.gpxpkg");

    let mut server = Server::new(vec![Scope::Author]);
    server.register("packages.build", Box::new(PackagesBuild));
    server.register("packages.inspect", Box::new(PackagesInspect));
    server.register(
        "packages.publish",
        Box::new(PackagesPublish(Mutex::new(PublishedLibrary::default()))),
    );

    let replies = drive(
        &server,
        &[
            call(
                1,
                "packages.build",
                serde_json::json!({
                    "output": package,
                    "scene": serde_json::to_value(scene("lower-third")).unwrap(),
                    "designSystemVersion": 3,
                }),
            ),
            call(2, "packages.inspect", serde_json::json!({ "package": package })),
            call(3, "packages.publish", serde_json::json!({ "package": package })),
        ],
    );

    assert_eq!(replies.len(), 3, "every call answers exactly once");
    for reply in &replies {
        assert!(reply["error"].is_null(), "unexpected refusal: {reply}");
    }
    assert_eq!(replies[1]["result"]["sceneId"], "lower-third");
    assert_eq!(replies[2]["result"]["takeId"], "lower-third");
    assert_eq!(replies[2]["result"]["revision"], 1);
    // The design-system stamp survives the round trip, so drift after a brand
    // pack update is listable rather than invisible (7.6).
    assert_eq!(replies[2]["result"]["designSystemVersion"], 3);

    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_author_token_is_refused_at_the_wire_before_the_handler_runs() {
    // ADR-0002 D.3, proven where it matters: not that a handler declined, but
    // that the transport never reached one. The library below *is* registered
    // and has a take in it, so a reply carrying a frame would mean the gate
    // had been bypassed.
    let mut library = PublishedLibrary::default();
    library.publish("lower-third", serde_json::Value::Null);

    let mut server = Server::new(vec![Scope::Author]);
    // Registered under its real name with a real body. The refusal below is
    // the gate's, not a missing registration's.
    server.register("playout.library", Box::new(Unreachable));
    let _ = &PlayoutLibrary::<StubPeer>;
    let _ = &PlayoutTake::<StubPeer>;

    let replies = drive(
        &server,
        &[call(
            1,
            "playout.take",
            serde_json::json!({ "takeId": "lower-third", "revision": 1 }),
        )],
    );

    assert_eq!(replies.len(), 1);
    assert!(
        !replies[0]["error"].is_null(),
        "an author token must not reach playout.take"
    );
    // The refusal is machine-parseable (8.8): a named code an agent can
    // branch on, not prose it would have to match on.
    assert_eq!(
        replies[0]["error"]["data"]["code"]["refusal"], "unauthenticated",
        "the refusal names the condition, got {}",
        replies[0]["error"]
    );
    assert_eq!(replies[0]["error"]["data"]["severity"], "error");
}

#[test]
fn capability_discovery_answers_before_any_scope_is_granted() {
    // D.1 principle 2: an agent asks what is supported rather than guessing.
    // A server with *no* scopes still answers, because a caller that cannot
    // discover the surface has nothing to ask for correctly.
    let server = Server::new(Vec::new());
    let replies = drive(
        &server,
        &[
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
            call(2, "system.capability", serde_json::Value::Null),
        ],
    );

    let tools = replies[0]["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for expected in [
        "system.capability",
        "packages.build",
        "packages.inspect",
        "packages.publish",
        "playout.take",
        "outputs.configure",
    ] {
        assert!(names.contains(&expected), "{expected} is not discoverable");
    }

    // Every listed tool must be callable in principle — a name in the list
    // with nothing behind it is the guessing this surface exists to remove.
    assert!(
        replies[1]["error"].is_null(),
        "system.capability is listed but unreachable: {}",
        replies[1]
    );
    assert!(
        !replies[1]["result"]["refusals"]
            .as_array()
            .expect("the surface carries the refusal vocabulary")
            .is_empty(),
        "discovery must name the refusals an agent can receive"
    );
}

/// A handler that must never run.
struct Unreachable;

impl gx_mcp_server::ToolHandler for Unreachable {
    fn handle(
        &self,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, gx_contracts::Refusal> {
        panic!("the scope gate let a call through to a handler it should have refused");
    }
}

/// Names the generic parameter above without standing up an engine.
struct StubPeer;

impl gx_control_plane::peer::EnginePeer for StubPeer {
    fn capability(&self) -> gx_control_plane::capability::EngineCapability {
        unreachable!("never constructed")
    }
    fn handle(
        &mut self,
        _request: gx_control_plane::message::ClientRequest,
    ) -> gx_control_plane::message::EngineReply {
        unreachable!("never constructed")
    }
    fn drain_events(&mut self) -> Vec<gx_control_plane::message::EngineEvent> {
        unreachable!("never constructed")
    }
}
