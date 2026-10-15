//! Refusal parity across publication sockets and the newline JSON-RPC tools.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{atomic::AtomicU64, Arc};

use gx_asset_plane::{
    publish_scene, AssetPublishPeer, AssetPublishServer, PublishRefusal, PublishReply,
};
use gx_contracts::auth::Scope;
use gx_contracts::color::{ColorValue, WorkingColorSpace};
use gx_contracts::material::{AlphaMode, BlendMode, CullMode, DepthMode, FitMode, MaterialSupport};
use gx_contracts::scene::{new_scene, SceneDocument, SceneObject};
use gx_contracts::{Locality, Refusal, Revision, StructuredRefusal, TakeId};
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::{Client, Server};
use gx_editor::Projects;
use gx_mcp_server::Server as McpServer;
use gx_mock_engine::MockEngine;
use gx_playout::{OutputEnvironment, Playout, PublishedLibrary};
use gx_playout_mcp::{
    OutputsConfigure, OutputsList, PackagesBuild, PlayoutClear, PlayoutCue, PlayoutReview,
    PlayoutTake, ProgramTools,
};
use gx_render_worker::engine::Engine;
use parking_lot::Mutex;

use super::{blend_check_name, fit_check_name, material_with_blend, material_with_fit, PLANE};
use crate::{expect, Report};

pub(super) fn drive_wire_refusals(report: &mut Report) {
    publication(
        report,
        "real engine refusal wire",
        Engine::new(Arc::new(AtomicU64::new(0)), Locality::CoLocated),
    );
    publication(report, "mock engine refusal wire", MockEngine::new());
    mcp_capabilities(report);
    mcp_unknown_fields(report);
}

fn loopback() -> SocketAddr {
    (Ipv4Addr::LOCALHOST, 0).into()
}

fn connected<P: EnginePeer + Send + 'static>(peer: P) -> Client {
    let server = Server::bind(loopback(), None, peer).expect("refusal wire binds");
    let address = server.local_addr().unwrap();
    server.serve_in_background();
    Client::connect(address).expect("refusal wire capability exchange")
}

fn publication<P: EnginePeer + AssetPublishPeer>(report: &mut Report, name: &str, peer: P) {
    report.set_peer(name);
    let control = Server::bind(loopback(), None, peer).expect("publication control binds");
    let address = control.local_addr().unwrap();
    let asset =
        AssetPublishServer::bind(loopback(), control.engine()).expect("publication asset binds");
    let endpoint = asset.local_addr().unwrap();
    asset.serve_in_background();
    control.serve_in_background();
    let client = Client::connect(address).expect("capability crosses control wire");
    let support = client.capability().material;
    report.record(
        PLANE,
        "a renderer without materials declares none over the control wire",
        expect(
            support == MaterialSupport::none(),
            format!("declared {support:?}"),
        ),
    );

    for (label, scene, expected) in parity_cases() {
        let validation = gx_contracts::validate::validate_scene_document(
            &scene,
            &support,
            &Default::default(),
            true,
        );
        let reply = publish_scene(endpoint, scene.clone());
        // A refused publish must leave the next valid publish at revision 1.
        let valid = empty_scene(&scene.id);
        let next = publish_scene(endpoint, valid);
        report.record(PLANE, label, expect(
            validation.first().is_some_and(|r| r.code == expected && r.field.is_some())
                && matches!(&reply, Ok(PublishReply::Refused(PublishRefusal::PreparationRefused { cause })) if *cause == expected)
                && matches!(next, Ok(PublishReply::Published { revision: Revision(1), .. })),
            format!("expected {expected:?}; validator {validation:?}; wire {reply:?}; next {next:?}")));
    }
    for (label, scene, expected) in light_container_cases() {
        let validation = gx_contracts::validate::validate_scene_document(
            &scene,
            &support,
            &Default::default(),
            true,
        );
        let reply = publish_scene(endpoint, scene.clone());
        let next = publish_scene(endpoint, empty_scene(&scene.id));
        report.record(PLANE, label, expect(
            validation.first() == Some(&expected)
                && matches!(&reply, Ok(PublishReply::Refused(PublishRefusal::PreparationRefused { cause })) if *cause == expected.code)
                && matches!(&next, Ok(PublishReply::Published { revision: Revision(1), .. })),
            format!("expected {expected:?}; validator {validation:?}; wire {reply:?}; after refusal {next:?}")));
    }
    for (label, scene) in unpainted_container_cases() {
        let validation = gx_contracts::validate::validate_scene_document(
            &scene,
            &support,
            &Default::default(),
            true,
        );
        let reply = publish_scene(endpoint, scene);
        report.record(
            PLANE,
            label,
            expect(
                validation.is_empty()
                    && matches!(
                        reply,
                        Ok(PublishReply::Published {
                            revision: Revision(1),
                            ..
                        })
                    ),
                format!("unpainted container validation {validation:?}; publication {reply:?}"),
            ),
        );
    }
    for mode in BlendMode::ALL {
        let mut scene = empty_scene(&format!("blend-{mode:?}"));
        scene.materials.push(material_with_blend(mode));
        let reply = publish_scene(endpoint, scene);
        report.record(PLANE, blend_check_name(mode), expect(
            matches!(&reply, Ok(PublishReply::Refused(PublishRefusal::PreparationRefused { cause: Refusal::UnsupportedBlendMode { mode: actual } })) if *actual == mode),
            format!("blend {mode:?} publication: {reply:?}")));
    }
}

fn empty_scene(id: &str) -> SceneDocument {
    let mut scene = new_scene(id, id, WorkingColorSpace::Srgb);
    scene.canvas.width = 32;
    scene.canvas.height = 32;
    scene.timeline.duration_frames = 10;
    scene
}

fn light_container_cases() -> Vec<(&'static str, SceneDocument, StructuredRefusal)> {
    let mut light = empty_scene("wire-light-only");
    light.objects.push(object(serde_json::json!({
        "type": "light", "id": "key", "name": "Key", "lightKind": "directional", "intensity": 1,
        "color": {"r":1,"g":1,"b":1,"a":1,"space":"srgb"},
    })));
    let mut cases = vec![(
        "a light-only scene has the same named refusal and path everywhere",
        light,
        StructuredRefusal::error(Refusal::LightHasNoResponsiveMaterial {
            light_id: "key".into(),
        })
        .at("objects[0].type", serde_json::json!("light")),
    )];
    for (kind, id, property, label) in [
        (
            "group",
            "g",
            "fill",
            "Group fill refuses by object, path and stored value everywhere",
        ),
        (
            "group",
            "g",
            "stroke",
            "Group stroke refuses even at zero width everywhere",
        ),
        (
            "layer",
            "l",
            "fill",
            "Layer fill refuses by object, path and stored value everywhere",
        ),
        (
            "layer",
            "l",
            "stroke",
            "Layer stroke refuses even at zero width everywhere",
        ),
    ] {
        let mut scene = empty_scene(&format!("wire-container-{kind}-{property}"));
        // A preceding drawable object prevents an always-zero field path
        // from passing, and verifies that shapes can still paint.
        scene.objects.push(object(
            serde_json::json!({"type":"rect", "id":"card", "name":"Card",
            "fill":{"type":"solid", "color":{"r":0,"g":1,"b":0,"a":1,"space":"srgb"}}}),
        ));
        let paint = serde_json::json!({"type":"solid", "color":{"r":1.0,"g":0.0,"b":0.0,"a":1.0,"space":"srgb"}});
        let mut value =
            serde_json::json!({"type":kind, "id":id, "name":id, "childIds":[], "strokeWidth":0});
        if kind == "layer" {
            value["layerKind"] = serde_json::json!("object");
        }
        value[property] = paint.clone();
        scene.objects.push(object(value));
        cases.push((
            label,
            scene,
            StructuredRefusal::error(Refusal::ScenePropertyNotDrawable {
                object: id.into(),
                property: property.into(),
                owner: "3.13".into(),
            })
            .at(format!("objects[1].{property}"), paint),
        ));
    }
    cases
}

fn unpainted_container_cases() -> Vec<(&'static str, SceneDocument)> {
    [
        (
            "group",
            "an unpainted Group with strokeWidth remains publishable",
        ),
        (
            "layer",
            "an unpainted Layer with strokeWidth remains publishable",
        ),
    ]
    .into_iter()
    .map(|(kind, label)| {
        let mut scene = empty_scene(&format!("wire-unpainted-{kind}"));
        let mut value = serde_json::json!({"type":kind, "id":kind, "name":kind, "childIds":[],
                "fill":{"type":"none"}, "stroke":{"type":"none"}, "strokeWidth":12});
        if kind == "layer" {
            value["layerKind"] = serde_json::json!("object");
        }
        scene.objects.push(object(value));
        (label, scene)
    })
    .collect()
}

fn object(value: serde_json::Value) -> SceneObject {
    serde_json::from_value(value).expect("parity object parses")
}

fn parity_cases() -> Vec<(&'static str, SceneDocument, Refusal)> {
    let gradient = || ColorValue::LinearGradient {
        angle: 0.0,
        start_x: 0.0,
        start_y: 0.0,
        end_x: 1.0,
        end_y: 0.0,
        stops: Vec::new(),
        spread: Default::default(),
        coordinate_mode: Default::default(),
    };
    let property = |id: &str, property: &str, owner: &str| Refusal::ScenePropertyNotDrawable {
        object: id.into(),
        property: property.into(),
        owner: owner.into(),
    };
    let mut fill = empty_scene("wire-gradient");
    let mut rect =
        object(serde_json::json!({ "type": "rect", "id": "gradient", "name": "gradient" }));
    rect.base_mut().fill = Some(gradient());
    fill.objects.push(rect);
    let mut hidden = fill.clone();
    hidden.id = "wire-hidden-gradient".into();
    hidden.objects[0].base_mut().visible = false;
    let mut stroke_gradient = fill.clone();
    stroke_gradient.id = "wire-stroke-gradient".into();
    stroke_gradient.objects[0].base_mut().fill = None;
    stroke_gradient.objects[0].base_mut().stroke = Some(gradient());
    let mut shear = empty_scene("wire-shear");
    shear.objects = vec![
        object(
            serde_json::json!({ "type": "group", "id": "parent", "name": "parent", "scaleX": 2, "childIds": ["sheared"] }),
        ),
        object(
            serde_json::json!({ "type": "rect", "id": "sheared", "name": "sheared", "rotation": 30 }),
        ),
    ];
    let mut text = empty_scene("wire-decoration");
    text.objects.push(object(serde_json::json!({ "type": "text", "id": "title", "name": "title", "text": "Hello", "fontId": "font_inter", "size": 40, "decoration": { "underline": true, "strikethrough": false } })));
    text.fonts.push(gx_contracts::font::FontDefinition {
        font_id: "font_inter".into(),
        family: "Inter".into(),
        display_name: "Inter".into(),
        faces: Vec::new(),
        fallback_families: Vec::new(),
        embedding_policy: gx_contracts::font::EmbeddingPolicy::Package,
        license: None,
        enabled: true,
        source_label: None,
        status: gx_contracts::font::FontLoadStatus::Ready,
        error_message: None,
    });
    let mut opacity = empty_scene("wire-opacity");
    opacity.objects.push(object(
        serde_json::json!({ "type": "rect", "id": "faded", "name": "faded", "opacity": 1.5 }),
    ));
    let mut stroke = empty_scene("wire-scaled-stroke");
    stroke.objects.push(object(serde_json::json!({ "type": "rect", "id": "stroked", "name": "stroked", "scaleX": 2, "strokeWidth": 4,
        "stroke": { "type": "solid", "color": { "r": 1, "g": 1, "b": 1, "a": 1, "space": "srgb" } } })));
    let mut tangents = empty_scene("wire-tangents");
    tangents.objects.push(object(serde_json::json!({ "type": "shape", "id": "path", "name": "path",
        "path": { "closed": false, "vertices": [{"x":0,"y":0},{"x":1,"y":1}], "inTangents": [{"x":0,"y":0}], "outTangents": [{"x":0,"y":0}] } })));
    vec![
        (
            "gradient fill refuses identically in validator and publication wire",
            fill,
            Refusal::UnsupportedPathGradient {
                object: "gradient".into(),
                paint: "fill".into(),
            },
        ),
        (
            "hidden gradient refuses identically in validator and publication wire",
            hidden,
            Refusal::UnsupportedPathGradient {
                object: "gradient".into(),
                paint: "fill".into(),
            },
        ),
        (
            "gradient stroke refuses identically in validator and publication wire",
            stroke_gradient,
            Refusal::UnsupportedPathGradient {
                object: "gradient".into(),
                paint: "stroke".into(),
            },
        ),
        (
            "sheared rotation refuses identically in validator and publication wire",
            shear,
            property(
                "sheared",
                "rotation under a non-uniformly scaled parent",
                "3.16",
            ),
        ),
        (
            "text decoration refuses identically in validator and publication wire",
            text,
            property("title", "decoration", "3.18"),
        ),
        (
            "opacity range refuses identically in validator and publication wire",
            opacity,
            property("faded", "opacity", "3.13"),
        ),
        (
            "scaled stroke refuses identically in validator and publication wire",
            stroke,
            property("stroked", "scaled strokeWidth", "3.17"),
        ),
        (
            "mismatched tangents refuse identically in validator and publication wire",
            tangents,
            Refusal::VectorTessellationFailed {
                object: "path".into(),
                detail: "Bezier vertices and tangent arrays differ in length".into(),
            },
        ),
    ]
}

/// A capability probe, not a renderer. Deliberately unusual declarations
/// detect either hard-coded fixed-function support or an always-empty list.
struct DeclaredPeer(MaterialSupport);
impl EnginePeer for DeclaredPeer {
    fn capability(&self) -> EngineCapability {
        EngineCapability {
            material: self.0.clone(),
            ..MockEngine::new().capability()
        }
    }
    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        match request {
            ClientRequest::Capability => EngineReply::Capability(self.capability()),
            _ => EngineReply::Refused(Refusal::NotImplemented {
                what: "capability probe only".into(),
            }),
        }
    }
    fn drain_events(&mut self) -> Vec<EngineEvent> {
        Vec::new()
    }
}

fn rpc(server: &McpServer, tool: &str, args: serde_json::Value) -> serde_json::Value {
    let line = format!(
        "{}\n",
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } })
    );
    let mut output = Vec::new();
    server
        .serve(std::io::Cursor::new(line), &mut output)
        .expect("JSON-RPC round trip");
    serde_json::from_slice(&output).expect("JSON-RPC response parses")
}

struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn mcp_capabilities(report: &mut Report) {
    report.set_peer("MCP JSON-RPC with control-wire capability exchange");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = Scratch(root.join(format!(
        "agent/tmp/mission2-refusal-mcp-{}",
        std::process::id()
    )));
    let projects = Projects::at_root(&scratch.0);
    projects
        .create_project("audit")
        .expect("scratch project creates");
    let supports = [
        MaterialSupport::none(),
        MaterialSupport {
            blend_modes: vec![BlendMode::Overlay],
            fit_modes: vec![FitMode::Tile],
            cull_modes: vec![CullMode::Back],
            alpha_modes: vec![AlphaMode::Straight],
            depth_modes: vec![DepthMode::ReadWrite],
        },
        MaterialSupport {
            blend_modes: BlendMode::ALL.to_vec(),
            fit_modes: Vec::new(),
            cull_modes: CullMode::ALL.to_vec(),
            alpha_modes: AlphaMode::ALL.to_vec(),
            depth_modes: DepthMode::ALL.to_vec(),
        },
    ];
    for support in supports {
        let client = connected(DeclaredPeer(support.clone()));
        let declared = client.capability().material;
        let playout = Playout::new(client);
        let forwarded = playout.material_support();
        let tools = Arc::new(ProgramTools {
            playout: Mutex::new(playout),
            library: Mutex::new(PublishedLibrary::default()),
            environment: OutputEnvironment {
                platform_certified: false,
            },
        });
        let mut server = McpServer::new(vec![Scope::Author]);
        server.register("outputs.list", Box::new(OutputsList(tools)));
        server.register(
            "validate.preflight",
            Box::new(gx_editor_mcp::ValidatePreflight {
                projects: projects.clone(),
                material_support: declared.clone(),
            }),
        );
        let outputs = rpc(&server, "outputs.list", serde_json::Value::Null);
        report.record(
            PLANE,
            "Playout MCP forwards every peer-declared material mode unchanged",
            expect(
                forwarded == support
                    && declared == support
                    && outputs["result"]["material"] == serde_json::json!(support),
                format!("expected {support:?}, received {outputs}"),
            ),
        );

        // Each blend is exercised over JSON-RPC with the peer's empty list.
        if support.blend_modes.is_empty() {
            for (label, scene, expected) in light_container_cases() {
                projects
                    .write_scene("audit", &scene)
                    .expect("A/B preflight witness writes");
                let reply = rpc(
                    &server,
                    "validate.preflight",
                    serde_json::json!({"project":"audit", "scene_id":scene.id}),
                );
                let found =
                    serde_json::from_value::<Vec<StructuredRefusal>>(reply["result"].clone());
                report.record(
                    PLANE,
                    label,
                    expect(
                        found.as_ref().is_ok_and(|r| r.first() == Some(&expected)),
                        format!("expected {expected:?}; MCP JSON-RPC {reply}"),
                    ),
                );
            }
            for (label, scene) in unpainted_container_cases() {
                projects
                    .write_scene("audit", &scene)
                    .expect("unpainted preflight witness writes");
                let reply = rpc(
                    &server,
                    "validate.preflight",
                    serde_json::json!({"project":"audit", "scene_id":scene.id}),
                );
                report.record(
                    PLANE,
                    label,
                    expect(reply["result"] == serde_json::json!([]), format!("{reply}")),
                );
            }
            for mode in BlendMode::ALL {
                let mut scene = empty_scene("blend");
                scene.materials.push(material_with_blend(mode));
                check_preflight(
                    report,
                    &server,
                    &projects,
                    scene,
                    Refusal::UnsupportedBlendMode { mode },
                    &[],
                    blend_check_name(mode),
                );
            }
            let reply = rpc(
                &server,
                "validate.preflight",
                serde_json::json!({
                    "project": "audit", "scene_id": "blend", "ignored": true,
                }),
            );
            let refusal =
                serde_json::from_value::<StructuredRefusal>(reply["error"]["data"].clone());
            report.record(PLANE, "Editor MCP refuses unknown preflight arguments", expect(
                refusal.is_ok_and(|r| matches!(r.code, Refusal::SceneParseFailed { detail } if detail.contains("ignored"))),
                format!("{reply}")));
        } else if support.fit_modes.is_empty() {
            // Earlier material checks explicitly accept every value, so the
            // fit refusal is observed rather than masked by a blend refusal.
            for mode in FitMode::ALL {
                let mut scene = empty_scene("fit");
                scene.materials.push(material_with_fit(mode));
                check_preflight(
                    report,
                    &server,
                    &projects,
                    scene,
                    Refusal::UnsupportedFitMode { mode },
                    &[],
                    fit_check_name(mode),
                );
            }
        } else {
            let mut scene = empty_scene("sparse");
            scene.materials.push(material_with_blend(BlendMode::Normal));
            check_preflight(report, &server, &projects, scene,
                Refusal::UnsupportedBlendMode { mode: BlendMode::Normal }, &[serde_json::json!(BlendMode::Overlay)],
                "Editor MCP uses a sparse peer declaration rather than fixed-function or empty support");
            let mut scene = empty_scene("sparse-fit");
            let mut material = material_with_fit(FitMode::Cover);
            material.blend_mode = BlendMode::Overlay;
            scene.materials.push(material);
            check_preflight(
                report,
                &server,
                &projects,
                scene,
                Refusal::UnsupportedFitMode {
                    mode: FitMode::Cover,
                },
                &[serde_json::json!(FitMode::Tile)],
                "Editor MCP preserves a peer's non-empty allowed fit list",
            );
        }
    }
}

fn check_preflight(
    report: &mut Report,
    server: &McpServer,
    projects: &Projects,
    scene: SceneDocument,
    expected: Refusal,
    allowed: &[serde_json::Value],
    label: &'static str,
) {
    projects
        .write_scene("audit", &scene)
        .expect("preflight witness writes");
    let reply = rpc(
        server,
        "validate.preflight",
        serde_json::json!({ "project": "audit", "scene_id": scene.id }),
    );
    let refusals = serde_json::from_value::<Vec<StructuredRefusal>>(reply["result"].clone());
    report.record(
        PLANE,
        label,
        expect(
            refusals.as_ref().is_ok_and(|found| {
                found.iter().any(|refusal| {
                    refusal.code == expected
                        && refusal.allowed.as_deref() == Some(allowed)
                        && refusal.field.is_some()
                        && !refusal.given.is_null()
                })
            }),
            format!("expected {expected:?}, allowed {allowed:?}; JSON-RPC {reply}"),
        ),
    );
}

fn mcp_unknown_fields(report: &mut Report) {
    report.set_peer("MCP JSON-RPC argument refusal wire");
    let document = empty_scene("argument-audit");
    let mut engine = MockEngine::new();
    assert!(matches!(
        engine.publish_scene(document.clone()),
        PublishReply::Published { .. }
    ));
    let mut library = PublishedLibrary::default();
    let published = library.publish(
        document.id.clone(),
        serde_json::to_value(&document).unwrap(),
        None,
    );
    let tools = Arc::new(ProgramTools {
        playout: Mutex::new(Playout::new(connected(engine))),
        library: Mutex::new(library),
        environment: OutputEnvironment {
            platform_certified: false,
        },
    });
    let mut server = McpServer::new(vec![
        Scope::Author,
        Scope::Take,
        Scope::Cue,
        Scope::Clear,
        Scope::ConfigureOutput,
    ]);
    server.register("playout.take", Box::new(PlayoutTake(tools.clone())));
    server.register("playout.cue", Box::new(PlayoutCue(tools.clone())));
    server.register("playout.clear", Box::new(PlayoutClear(tools.clone())));
    server.register("playout.review", Box::new(PlayoutReview(tools.clone())));
    server.register(
        "outputs.configure",
        Box::new(OutputsConfigure(tools.clone())),
    );
    server.register("packages.build", Box::new(PackagesBuild));
    let mut program = serde_json::json!({ "takeId": published.take_id, "revision": published.revision, "contentHash": published.content_hash });
    program["atFrame"] = serde_json::json!(500);
    for (tool, args, label, key) in [
        (
            "playout.take",
            program.clone(),
            "a misspelt take frame refuses before reaching Program",
            "atFrame",
        ),
        (
            "playout.cue",
            program.clone(),
            "a misspelt cue frame refuses before cueing",
            "atFrame",
        ),
        (
            "playout.clear",
            serde_json::json!({"atFrame":500}),
            "a misspelt clear frame refuses before clearing Program",
            "atFrame",
        ),
        (
            "playout.review",
            serde_json::json!({"takeId": published.take_id, "revision": published.revision, "review":"approved", "ignored":true}),
            "review refuses unknown shared-contract arguments",
            "ignored",
        ),
        (
            "outputs.configure",
            serde_json::json!({"adapter":"recording", "live":false, "acceptFreeRun":false, "ignored":true}),
            "output configuration refuses unknown shared-contract arguments",
            "ignored",
        ),
        (
            "packages.build",
            serde_json::json!({"output":"unused.gpxpkg", "scene":document, "sources":[{"path":"x", "source":"unused", "ignored":true}]}),
            "package build refuses unknown nested source arguments before writing",
            "ignored",
        ),
    ] {
        let reply = rpc(&server, tool, args);
        let refusal = serde_json::from_value::<StructuredRefusal>(reply["error"]["data"].clone());
        report.record(PLANE, label, expect(refusal.is_ok_and(|r|
            matches!(r.code, Refusal::SceneParseFailed { detail } if detail.contains(key))), format!("{tool}: {reply}")));
    }
    let status = tools.playout.lock().peer_mut().status().unwrap();
    report.record(
        PLANE,
        "malformed MCP scheduling leaves Program untouched",
        expect(status.program.is_none(), format!("{status:?}")),
    );
    let reply = rpc(
        &server,
        "playout.take",
        serde_json::json!({ "takeId": TakeId(document.id), "revision": published.revision, "contentHash": published.content_hash, "frame":500 }),
    );
    report.record(
        PLANE,
        "a valid explicit MCP frame is preserved after rejected typos",
        expect(reply["result"]["frame"] == 500, format!("{reply}")),
    );
}
