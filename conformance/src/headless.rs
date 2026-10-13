//! Headless render (11.41) against the real engine, with the mock beside it.
//!
//! One control request renders a pinned revision at a frame; the image is
//! fetched from the asset plane by its content hash. The checks here are the
//! step's done-when, run against the worker process:
//!
//! - the same revision and frame render to the same bytes;
//! - the mock engine answers every request exactly as the engine does,
//!   refusals and images alike (invariant 45);
//! - headless renders issued while Program runs cause no late and no missed
//!   Program frame, read from the engine's own frame-timing report over a
//!   timed run (invariant 14).

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use gx_asset_plane::{fetch_bytes, publish_scene, PublishReply};
use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
use gx_contracts::color::ColorValue;
use gx_contracts::scene::{new_scene, ObjectBase, RectObject, SceneDocument, SceneObject};
use gx_contracts::{ContentHash, Refusal, Revision, TakeId};
use gx_control_plane::intent::{TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::render::RenderRequest;
use gx_control_plane::status::PerformanceSummary;
use gx_mock_engine::MockEngine;

use crate::{expect, Outcome, Report};

const PLANE: &str = "headless";
/// How long Program runs alone, then with renders issued back to back.
const WINDOW: Duration = Duration::from_secs(3);

/// A 1080p scene whose card moves across the frame over 100 frames.
fn animated_scene() -> SceneDocument {
    let mut scene = new_scene("conformance-headless", "Headless", gx_contracts::color::WorkingColorSpace::NEW_PROJECT);
    scene.timeline.duration_frames = 100;
    let mut card = ObjectBase::new("card", "Card");
    (card.x, card.y, card.width, card.height) = (100.0, 400.0, 320.0, 180.0);
    card.fill = Some(ColorValue::opaque_white());
    scene.objects.push(SceneObject::Rect(RectObject { base: card, radius: 0.0 }));
    let key = |frame, value| SceneKeyframe {
        frame,
        value,
        easing: SceneEasing::Linear,
        bezier: None,
    };
    scene.timeline.channels.push(KeyframeChannel {
        object_id: "card".into(),
        property: "x".into(),
        keys: vec![key(0, 100.0), key(100, 1500.0)],
    });
    scene
}

/// A static 1080p scene for Program to hold during the timed run.
fn program_scene() -> SceneDocument {
    let mut scene = new_scene("conformance-program", "Program", gx_contracts::color::WorkingColorSpace::NEW_PROJECT);
    let mut bar = ObjectBase::new("bar", "Bar");
    (bar.x, bar.y, bar.width, bar.height) = (0.0, 900.0, 1920.0, 180.0);
    bar.fill = Some(ColorValue::opaque_white());
    scene.objects.push(SceneObject::Rect(RectObject { base: bar, radius: 0.0 }));
    scene
}

fn performance(peer: &mut impl EnginePeer) -> Option<PerformanceSummary> {
    match peer.handle(ClientRequest::Performance) {
        EngineReply::Performance(summary) => Some(summary),
        _ => None,
    }
}

/// Run the headless suite against an engine whose asset plane listens on
/// `asset_plane`. The engine must already hold `conformance/published` as an
/// identifier-only revision 1 pinned to 64 `a`s, as the worker fixture does.
pub fn headless_render_suite(engine: &mut impl EnginePeer, asset_plane: SocketAddr, report: &mut Report) {
    let scene = animated_scene();
    let (take_id, revision, pin) = match publish_scene(asset_plane, scene.clone()) {
        Ok(PublishReply::Published { take_id, revision, content_hash }) => (take_id, revision, content_hash),
        other => {
            report.record(PLANE, "a scene publishes for headless rendering", Outcome::Fail(format!("{other:?}")));
            return;
        }
    };

    let mut mock = MockEngine::new();
    mock.publish(TakeId("conformance/published".into()), Revision(1), ContentHash("a".repeat(64)));
    let _ = mock.publish_scene(scene);

    let render = |take: &TakeId, pin: Option<&ContentHash>, frame| {
        ClientRequest::Render(RenderRequest {
            take_id: take.clone(),
            revision,
            content_hash: pin.cloned(),
            frame,
        })
    };
    let identifier = TakeId("conformance/published".into());
    let wrong = ContentHash("b".repeat(64));
    let cases = [
        ("the engine and the mock render frame 0 to the same image", render(&take_id, Some(&pin), 0)),
        ("the engine and the mock render frame 50 to the same image", render(&take_id, Some(&pin), 50)),
        ("the engine and the mock render the last frame to the same image", render(&take_id, Some(&pin), 100)),
        ("the engine and the mock refuse a frame past the timeline alike", render(&take_id, Some(&pin), 101)),
        ("the engine and the mock refuse an unpinned render alike", render(&take_id, None, 0)),
        ("the engine and the mock refuse a wrongly pinned render alike", render(&take_id, Some(&wrong), 0)),
        (
            "the engine and the mock refuse a render of an unknown take alike",
            render(&TakeId("conformance/unknown".into()), Some(&pin), 0),
        ),
        (
            "the engine and the mock refuse a render of an identifier-only revision alike",
            render(&identifier, Some(&ContentHash("a".repeat(64))), 0),
        ),
    ];
    let mut images = Vec::new();
    for (name, request) in cases {
        let from_engine = engine.handle(request.clone());
        let from_mock = mock.handle(request);
        report.record(
            PLANE,
            name,
            expect(from_engine == from_mock, format!("engine {from_engine:?}, mock {from_mock:?}")),
        );
        images.push(from_engine);
    }

    let rendered = |reply: &EngineReply| match reply {
        EngineReply::Rendered(frame) => Some(frame.clone()),
        _ => None,
    };
    let (first, middle) = (rendered(&images[0]), rendered(&images[1]));
    let again = rendered(&engine.handle(render(&take_id, Some(&pin), 50)));
    report.record(
        PLANE,
        "the same revision and frame render to the same bytes",
        expect(
            middle.is_some() && middle == again,
            format!("frame 50 rendered as {middle:?}, then as {again:?}"),
        ),
    );
    report.record(
        PLANE,
        "a frame of the animation differs from its first frame",
        expect(
            matches!((&first, &middle), (Some(a), Some(b)) if a.image != b.image),
            format!("frame 0 {first:?}, frame 50 {middle:?}"),
        ),
    );
    report.record(
        PLANE,
        "out-of-range, unpinned and identifier-only renders are refused by name",
        expect(
            matches!(images[3], EngineReply::Refused(Refusal::RenderFrameOutOfRange { frame: 101, .. }))
                && matches!(images[4], EngineReply::Refused(Refusal::RevisionUnpinned { .. }))
                && matches!(images[5], EngineReply::Refused(Refusal::RevisionHashMismatch { .. }))
                && matches!(images[6], EngineReply::Refused(Refusal::UnknownTake { .. }))
                && matches!(images[7], EngineReply::Refused(Refusal::RenderSceneUnavailable { .. })),
            format!("got {:?}", &images[3..]),
        ),
    );
    let fetched = middle.as_ref().map(|frame| {
        fetch_bytes(asset_plane, &frame.image).map(|png| (png.len(), gx_render_worker::headless::decode_png(&png)))
    });
    report.record(
        PLANE,
        "the image is fetched from the asset plane by its hash and is the canvas",
        expect(
            matches!(
                &fetched,
                Some(Ok((length, Ok(pixels))))
                    if *length as u64 == middle.as_ref().map_or(0, |frame| frame.image_bytes)
                        && (pixels.width, pixels.height) == (1920, 1080)
            ),
            format!("fetched {:?}", fetched.as_ref().map(|result| result.as_ref().map(|(length, _)| *length))),
        ),
    );

    timed_run(engine, asset_plane, &take_id, revision, &pin, report);
}

/// Program holds a static scene; the engine's frame-timing report is read
/// over a window with Program alone, then over a window of headless renders
/// issued back to back. Neither may add a late or missed Program frame.
fn timed_run(
    engine: &mut impl EnginePeer,
    asset_plane: SocketAddr,
    take_id: &TakeId,
    revision: Revision,
    pin: &ContentHash,
    report: &mut Report,
) {
    const NAME: &str = "headless renders while Program runs add no late or missed Program frame";
    let Ok(PublishReply::Published { take_id: program, revision: program_revision, content_hash }) =
        publish_scene(asset_plane, program_scene())
    else {
        report.record(PLANE, NAME, Outcome::Fail("the Program scene did not publish".into()));
        return;
    };
    let taken = engine.handle(ClientRequest::Take(TakeRequest {
        take_id: program,
        revision: program_revision,
        content_hash: Some(content_hash),
        at: TakeAt::NextOpportunity,
    }));
    if !matches!(taken, EngineReply::Taken(_)) {
        report.record(PLANE, NAME, Outcome::Fail(format!("the Program take was {taken:?}")));
        return;
    }

    let Some(start) = performance(engine) else {
        report.record(PLANE, NAME, Outcome::Fail("no performance report".into()));
        return;
    };
    std::thread::sleep(WINDOW);
    let alone = performance(engine);
    let Some(alone) = alone else {
        report.record(PLANE, NAME, Outcome::Fail("no performance report".into()));
        return;
    };
    let delta = |from: &PerformanceSummary, to: &PerformanceSummary| {
        (
            to.total_rendered - from.total_rendered,
            to.total_late - from.total_late,
            to.total_missed - from.total_missed,
        )
    };
    let (alone_frames, alone_late, alone_missed) = delta(&start, &alone);
    // If Program cannot hold its cadence with nothing else running (an
    // unoptimised build renders a 1080p Program frame in seconds), a late
    // frame during renders proves nothing either way: skip, never pass.
    if alone_late > 0 || alone_missed > 0 {
        report.record(
            PLANE,
            NAME,
            Outcome::Skip(format!(
                "Program alone already misses its cadence in this build ({alone_frames} frames, \
                 {alone_late} late, {alone_missed} missed); run against an optimised worker"
            )),
        );
        return;
    }
    let mut renders = 0u64;
    let began = Instant::now();
    while began.elapsed() < WINDOW {
        let reply = engine.handle(ClientRequest::Render(RenderRequest {
            take_id: take_id.clone(),
            revision,
            content_hash: Some(pin.clone()),
            frame: renders % 101,
        }));
        if !matches!(reply, EngineReply::Rendered(_)) {
            report.record(PLANE, NAME, Outcome::Fail(format!("headless render was {reply:?}")));
            return;
        }
        renders += 1;
    }
    let Some(during) = performance(engine) else {
        report.record(PLANE, NAME, Outcome::Fail("no performance report".into()));
        return;
    };
    let (frames, late, missed) = delta(&alone, &during);
    report.record(
        PLANE,
        NAME,
        expect(
            renders > 0 && frames > 0 && late == 0 && missed == 0,
            format!(
                "Program alone: {alone_frames} frames, {alone_late} late, {alone_missed} missed; \
                 with {renders} headless renders: {frames} frames, {late} late, {missed} missed"
            ),
        ),
    );
    println!(
        "    timed run: Program alone {alone_frames} frames ({alone_late} late, {alone_missed} missed); \
         with {renders} headless 1080p renders {frames} frames ({late} late, {missed} missed)"
    );
}
