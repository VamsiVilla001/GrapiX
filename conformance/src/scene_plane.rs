//! Scene-plane conformance: publication, refusal and take-blocking (1.12).
//!
//! 1.11 produced three mocks; this is the suite that holds them to the scene
//! contract. Four rules, each one a thing a permissive peer would let through:
//!
//!   - **A published scene round-trips.** What the Editor authored is what the
//!     engine holds. A publication that quietly dropped a field would make the
//!     document on air a different document from the one approved.
//!   - **An unknown kind is refused by name.** Not skipped, not rendered as
//!     nothing. A scene authored against a newer schema must fail loudly here
//!     rather than reach air missing whatever the new kind was for.
//!   - **A missing asset blocks the take.** Declared bytes that have not
//!     arrived are a take blocker (invariant 29), not a best-effort render.
//!   - **A stale revision cannot go to air.** Exact-match pinning
//!     (invariant 17): the refusal names the revision that is actually current
//!     so the caller can re-read rather than guess.
//!   - **A revision loads only by its pinned content hash** (11.38, invariant
//!     61): the same content publishes to the same hash, one changed property
//!     changes it, and an unpinned or wrongly pinned take is refused by name.
//!
//! Everything here runs over real sockets against the mock engine, because the
//! rules being checked are the wire's, not a struct's. `mock_product_suite`
//! then runs all three mock binaries end to end — editor publishes, engine
//! holds, playout takes — which is what 1.12 means by "green against all three
//! mocks".

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use gx_asset_plane::{publish_scene, AssetPublishServer, PublishRefusal, PublishReply};
use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
use gx_contracts::scene::{
    AssetKind, AssetLibraryItem, ObjectBase, RectObject, SceneCanvas, SceneDocument, SceneObject,
    SceneTimeline,
};
use gx_contracts::{ContentHash, RationalRate, Refusal, Revision, TakeId};
use gx_control_plane::intent::{TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::{Client, Server};
use gx_mock_engine::MockEngine;

use crate::{expect, Outcome, Report};

const PLANE: &str = "scene";

fn loopback(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

/// A document with something in every part a publication could lose: a
/// non-default transform, an asset with a checksum, a data context, and an
/// animation channel. A round-trip over an empty scene proves very little.
fn populated_scene(id: &str, asset: Option<ContentHash>) -> SceneDocument {
    let mut base = ObjectBase::new("card", "Card");
    base.x = 18.5;
    base.y = 42.25;
    base.rotation = 12.5;
    base.opacity = 0.85;
    base.locked = true;
    base.width = 640.0;
    base.height = 180.0;

    let mut data_context = serde_json::Map::new();
    data_context.insert("headline".into(), serde_json::json!("LIVE SCORE"));

    SceneDocument {
        working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
        id: id.to_owned(),
        name: "Conformance scene".to_owned(),
        version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas {
            width: 1920,
            height: 1080,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline {
            duration_frames: 100,
            channels: vec![KeyframeChannel {
                object_id: "card".to_owned(),
                property: "x".to_owned(),
                keys: vec![SceneKeyframe {
                    frame: 20,
                    value: 200.0,
                    easing: SceneEasing::EaseInOut,
                    bezier: None,
                }],
            }],
            ..Default::default()
        },
        data_context,
        assets: asset
            .map(|hash| AssetLibraryItem {
                asset_id: "logo".to_owned(),
                name: "Logo".to_owned(),
                kind: AssetKind::Image,
                path: "images/logo.png".to_owned(),
                checksum: Some(hash),
                mime_type: Some("image/png".to_owned()),
                size_bytes: Some(2048),
                status: None,
                provenance: Default::default(),
            })
            .into_iter()
            .collect(),
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        objects: vec![SceneObject::Rect(RectObject { base, radius: 4.0 })],
    }
}

/// The content hash a successful publication reported, which a take must pin.
fn pin_of<E>(published: &Result<PublishReply, E>) -> Option<ContentHash> {
    match published {
        Ok(PublishReply::Published { content_hash, .. }) => Some(content_hash.clone()),
        _ => None,
    }
}

/// Publish raw bytes over the asset plane.
///
/// The typed client cannot express a document the schema rejects — which is
/// the point of the typed client — so the hostile cases frame their own
/// request. The framing is the plane's: a 4-byte big-endian length, then JSON.
fn publish_raw(engine: SocketAddr, body: &[u8]) -> std::io::Result<PublishReply> {
    let mut stream = TcpStream::connect(engine)?;
    stream.write_all(&(body.len() as u32).to_be_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix)?;
    let mut bytes = vec![0; u32::from_be_bytes(prefix) as usize];
    stream.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}

/// A publish request carrying one authored object, verbatim.
fn request_with_object(id: &str, object: &str) -> Vec<u8> {
    format!(
        r#"{{"scene":{{"id":"{id}","name":"Hostile","version":1,
           "canvas":{{"width":1920,"height":1080,"frameRate":{{"num":50,"den":1}}}},
           "timeline":{{"durationFrames":100}},
           "objects":[{object}]}}}}"#
    )
    .into_bytes()
}

pub fn scene_plane_suite(report: &mut Report) {
    let server = match Server::bind(loopback(0), None, MockEngine::new().genlocked(RationalRate::P50))
    {
        Ok(server) => server,
        Err(error) => {
            report.skip_unavailable(format!("cannot bind a control plane: {error}"));
            return;
        }
    };
    let control = match server.local_addr() {
        Ok(address) => address,
        Err(error) => {
            report.skip_unavailable(format!("control plane has no address: {error}"));
            return;
        }
    };
    // Taken before `serve_in_background` consumes the server. The asset plane
    // and the control plane share one peer, which is the arrangement being
    // tested: a scene published on one is takeable on the other.
    let peer = server.engine();
    let asset_server = match AssetPublishServer::bind(loopback(0), peer.clone()) {
        Ok(server) => server,
        Err(error) => {
            report.skip_unavailable(format!("cannot bind an asset plane: {error}"));
            return;
        }
    };
    let asset = match asset_server.local_addr() {
        Ok(address) => address,
        Err(error) => {
            report.skip_unavailable(format!("asset plane has no address: {error}"));
            return;
        }
    };
    asset_server.serve_in_background();
    server.serve_in_background();

    let mut client = match Client::connect(control) {
        Ok(client) => client,
        Err(error) => {
            report.skip_unavailable(format!("cannot connect to the control plane: {error}"));
            return;
        }
    };

    // --- 1. a scene round-trips through a peer -----------------------------

    let authored = populated_scene("conformance/round-trip", None);
    let published = publish_scene(asset, authored.clone());
    let stored = match &published {
        Ok(PublishReply::Published { take_id, revision, .. }) => peer
            .lock()
            .ok()
            .and_then(|engine| engine.published_scene(take_id, *revision).cloned()),
        _ => None,
    };
    report.record(
        PLANE,
        "a published scene round-trips through the peer unchanged",
        expect(
            stored.as_ref() == Some(&authored),
            format!("published {published:?}; the peer holds {stored:?}"),
        ),
    );
    report.record(
        PLANE,
        "publication issues revision 1 for a new take id",
        expect(
            matches!(&published, Ok(PublishReply::Published { revision, .. }) if *revision == Revision(1)),
            format!("expected revision 1, got {published:?}"),
        ),
    );

    // --- 2. an unknown kind is refused by name -----------------------------

    let unknown_kind = publish_raw(
        asset,
        &request_with_object(
            "conformance/unknown-kind",
            r#"{"type":"hologram","id":"h","name":"H"}"#,
        ),
    );
    report.record(
        PLANE,
        "an unknown object kind is refused by name, never dropped",
        expect(
            matches!(
                &unknown_kind,
                Ok(PublishReply::Refused(PublishRefusal::SceneRefused {
                    cause: Refusal::SceneParseFailed { .. }
                }))
            ),
            format!("expected SceneRefused/sceneParseFailed, got {unknown_kind:?}"),
        ),
    );

    // The neighbouring case, kept distinct: a known kind carrying a field the
    // schema does not have. A reader that collapsed these two into one
    // "invalid scene" would leave an author unable to tell a typo from a
    // version mismatch.
    let unknown_field = publish_raw(
        asset,
        &request_with_object(
            "conformance/unknown-field",
            r#"{"type":"rect","id":"r","name":"R","radius":0,"hologramDensity":3}"#,
        ),
    );
    report.record(
        PLANE,
        "an unknown field on a known kind names the path it refused",
        expect(
            matches!(
                &unknown_field,
                Ok(PublishReply::Refused(PublishRefusal::SceneRefused {
                    cause: Refusal::SceneUnknownField { path }
                })) if path.contains("hologramDensity")
            ),
            format!("expected SceneUnknownField naming the path, got {unknown_field:?}"),
        ),
    );

    // A refused publication must not have created anything.
    // Unpinned on purpose: an unknown take is refused before any pin is read.
    let refused_take = client.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId("conformance/unknown-kind".into()),
        revision: Revision(1),
        content_hash: None,
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "a refused publication leaves no revision behind",
        expect(
            matches!(
                refused_take,
                EngineReply::Refused(Refusal::UnknownTake { .. })
            ),
            format!("expected UnknownTake after a refusal, got {refused_take:?}"),
        ),
    );

    // --- 3. a missing asset blocks the take --------------------------------

    let hash = ContentHash("sha256:conformance-asset-not-arrived".into());
    let with_asset = populated_scene("conformance/asset-blocked", Some(hash.clone()));
    let asset_published = publish_scene(asset, with_asset);
    let blocked = client.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId("conformance/asset-blocked".into()),
        revision: Revision(1),
        content_hash: pin_of(&asset_published),
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "a declared asset that has not arrived blocks the take",
        expect(
            matches!(&blocked, EngineReply::Refused(Refusal::AssetMissing { hash: missing }) if *missing == hash),
            format!("expected AssetMissing naming the hash, got {blocked:?} (publish: {asset_published:?})"),
        ),
    );

    // The same take, once the bytes are held. This is what makes the check
    // above a blocker rather than a permanent refusal: nothing else about the
    // request changed.
    let held = peer
        .lock()
        .map(|mut engine| {
            engine.hold_asset(hash.clone());
        })
        .is_ok();
    let unblocked = client.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId("conformance/asset-blocked".into()),
        revision: Revision(1),
        content_hash: pin_of(&asset_published),
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "the same take succeeds once the asset has arrived",
        expect(
            held && matches!(unblocked, EngineReply::Taken(_)),
            format!("expected the take to commit once held, got {unblocked:?}"),
        ),
    );

    // --- 4. revision pinning -----------------------------------------------

    let pinned = "conformance/revision-pinning";
    let first = publish_scene(asset, populated_scene(pinned, None));
    let second = publish_scene(asset, populated_scene(pinned, None));
    report.record(
        PLANE,
        "republishing one take id issues the next revision, never edits the old",
        expect(
            matches!(&first, Ok(PublishReply::Published { revision, .. }) if *revision == Revision(1))
                && matches!(&second, Ok(PublishReply::Published { revision, .. }) if *revision == Revision(2)),
            format!("expected revisions 1 then 2, got {first:?} then {second:?}"),
        ),
    );

    // --- 5. content-hash pinning (11.38, invariant 61) ----------------------

    let pin = pin_of(&second);
    report.record(
        PLANE,
        "publishing the same content twice gives the same content hash",
        expect(
            pin.is_some() && pin_of(&first) == pin,
            format!("expected one hash for identical content, got {first:?} then {second:?}"),
        ),
    );
    let mut changed = populated_scene(pinned, None);
    changed.canvas.width = 1280;
    let changed_pin = Some(changed.content_hash());
    report.record(
        PLANE,
        "changing one property changes the content hash",
        expect(
            changed_pin != pin,
            format!("expected a different hash after changing the canvas width, both were {pin:?}"),
        ),
    );

    let program_before = client.status().and_then(|status| status.program);
    let unpinned = client.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId(pinned.into()),
        revision: Revision(2),
        content_hash: None,
        at: TakeAt::NextOpportunity,
    }));
    let wrong = client.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId(pinned.into()),
        revision: Revision(2),
        content_hash: changed_pin.clone(),
        at: TakeAt::NextOpportunity,
    }));
    let program_after = client.status().and_then(|status| status.program);
    report.record(
        PLANE,
        "an unpinned take is refused by name and leaves Program unchanged",
        expect(
            matches!(&unpinned, EngineReply::Refused(Refusal::RevisionUnpinned { revision: Revision(2), .. }))
                && program_before == program_after,
            format!("expected RevisionUnpinned, got {unpinned:?}"),
        ),
    );
    report.record(
        PLANE,
        "a take pinning other content is refused by name and leaves Program unchanged",
        expect(
            matches!(&wrong, EngineReply::Refused(Refusal::RevisionHashMismatch { expected, actual, .. })
                if Some(expected) == pin.as_ref() && Some(actual) == changed_pin.as_ref())
                && program_before == program_after,
            format!("expected RevisionHashMismatch naming both hashes, got {wrong:?}"),
        ),
    );

    let stale = client.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId(pinned.into()),
        revision: Revision(1),
        content_hash: pin.clone(),
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "a stale revision cannot go to air, and the refusal names the current one",
        expect(
            matches!(
                stale,
                EngineReply::Refused(Refusal::RevisionMismatch {
                    expected: Revision(2),
                    actual: Revision(1)
                })
            ),
            format!("expected RevisionMismatch expected=2 actual=1, got {stale:?}"),
        ),
    );

    let current = client.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId(pinned.into()),
        revision: Revision(2),
        content_hash: pin,
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "the current revision takes",
        expect(
            matches!(current, EngineReply::Taken(_)),
            format!("expected the current revision to commit, got {current:?}"),
        ),
    );
}

// ---------------------------------------------------------------------------
// All three mocks, as processes
// ---------------------------------------------------------------------------

/// A mock binary beside the conformance executable.
fn mock_binary(name: &str) -> Option<std::path::PathBuf> {
    let current = std::env::current_exe().ok()?;
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let dir = current.parent()?;
    for candidate in [dir.join(&file), dir.parent()?.join(&file)] {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    Some(port)
}

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// What a mock product run produced.
struct Run {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn run_mock(binary: &std::path::Path, args: &[&str]) -> Option<Run> {
    let output = Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    Some(Run {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// The three mocks, interoperating: the Editor publishes a document it
/// authored, the engine holds it, and Playout takes it — with no real peer
/// anywhere (1.11's done-when) and every refusal named (1.12's).
///
/// A missing binary records a skip, never a pass (invariant 43).
pub fn mock_product_suite(report: &mut Report) {
    report.set_peer("all three mocks, as processes");

    let (Some(engine_binary), Some(editor_binary), Some(playout_binary)) = (
        mock_binary("gx-mock-engine"),
        mock_binary("gx-mock-editor"),
        mock_binary("gx-mock-playout"),
    ) else {
        report.skip_unavailable("the mock binaries are not built");
        return;
    };
    let (Some(control), Some(asset)) = (free_port(), free_port()) else {
        report.skip_unavailable("no free loopback port");
        return;
    };

    let spawned = Command::new(&engine_binary)
        .args([
            "--port",
            &control.to_string(),
            "--asset-port",
            &asset.to_string(),
            "--genlocked",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = spawned else {
        report.skip_unavailable("could not spawn the mock engine");
        return;
    };
    let _guard = KillOnDrop(child);

    // Wait for both planes: the editor talks to one and playout to the other,
    // and a race here would report a contract failure that is really a
    // start-up timing artefact.
    let deadline = Instant::now() + Duration::from_secs(15);
    let ready = loop {
        let control_up = TcpStream::connect(loopback(control)).is_ok();
        let asset_up = TcpStream::connect(loopback(asset)).is_ok();
        if control_up && asset_up {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if !ready {
        report.skip_unavailable("the mock engine did not open both planes");
        return;
    }

    let asset_endpoint = format!("127.0.0.1:{asset}");
    let control_endpoint = format!("127.0.0.1:{control}");

    // The Editor authors and publishes. It has no take command at all, which
    // is the invariant-4 half of this check: the product that can author
    // cannot put anything on air.
    let published = run_mock(
        &editor_binary,
        &[
            "--asset-engine",
            &asset_endpoint,
            "--new",
            "conformance/interop:Interop",
        ],
    );
    report.record(
        PLANE,
        "the mock Editor publishes an authored document with no real peer",
        match &published {
            Some(run) => expect(
                run.ok && run.stdout.contains("published conformance/interop revision 1"),
                format!("editor exited ok={} out={:?} err={:?}", run.ok, run.stdout, run.stderr),
            ),
            None => Outcome::Skip("the mock editor could not be run".into()),
        },
    );

    // The hash the Editor's publication reported; Playout pins it (11.38).
    let hash = published
        .as_ref()
        .and_then(|run| run.stdout.split(" hash ").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_default()
        .to_owned();
    let pinned = format!("conformance/interop:1:{hash}");

    // The Playout mock refuses to load a revision it has not pinned, or has
    // pinned to other content, by name and with a non-zero exit (invariant
    // 61). Neither reaches Program; the pinned take below is the first one.
    let unpinned = run_mock(&playout_binary, &["--engine", &control_endpoint, "--take", "conformance/interop:1"]);
    report.record(
        PLANE,
        "the mock Playout's unpinned take is refused by name",
        match &unpinned {
            Some(run) => expect(
                !run.ok && run.stderr.contains("[revisionUnpinned]"),
                format!("expected revisionUnpinned and a non-zero exit, got ok={} err={:?}", run.ok, run.stderr),
            ),
            None => Outcome::Skip("the mock playout could not be run".into()),
        },
    );
    let other_content = format!("conformance/interop:1:{}", "0".repeat(64));
    let wrong = run_mock(&playout_binary, &["--engine", &control_endpoint, "--take", &other_content]);
    report.record(
        PLANE,
        "the mock Playout's take of an unknown hash is refused by name",
        match &wrong {
            Some(run) => expect(
                !run.ok && run.stderr.contains("[revisionHashMismatch]"),
                format!("expected revisionHashMismatch and a non-zero exit, got ok={} err={:?}", run.ok, run.stderr),
            ),
            None => Outcome::Skip("the mock playout could not be run".into()),
        },
    );

    // Playout takes the revision the Editor just created, by its hash. Two
    // products, one engine, and neither knows about the other.
    let taken = run_mock(&playout_binary, &["--engine", &control_endpoint, "--take", &pinned]);
    report.record(
        PLANE,
        "the mock Playout takes the revision the mock Editor published",
        match &taken {
            Some(run) => expect(
                hash.len() == 64 && run.ok && run.stdout.contains("take committed at frame"),
                format!("playout exited ok={} out={:?} err={:?} (hash {hash:?})", run.ok, run.stdout, run.stderr),
            ),
            None => Outcome::Skip("the mock playout could not be run".into()),
        },
    );

    // And the revision rule holds across the process boundary too: a
    // revision that was never published is refused by name, with a non-zero
    // exit so a script cannot mistake it for success.
    let stale_pin = format!("conformance/interop:2:{hash}");
    let stale = run_mock(&playout_binary, &["--engine", &control_endpoint, "--take", &stale_pin]);
    report.record(
        PLANE,
        "a take of an unpublished revision refuses across the process boundary",
        match &stale {
            Some(run) => expect(
                !run.ok && run.stderr.contains("[revisionMismatch]"),
                format!("expected a named refusal and non-zero exit, got ok={} err={:?}", run.ok, run.stderr),
            ),
            None => Outcome::Skip("the mock playout could not be run".into()),
        },
    );
}
