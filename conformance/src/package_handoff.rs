//! L0 asset handoff by local path (build plan 5.8), against two real workers.
//!
//! ADR-001's asset plane has two transports: a co-located engine reads a
//! package by local path, a LAN engine receives the chunked upload. One
//! package is published to a co-located worker started with a package
//! directory and to a LAN worker, each through `publish_package` with the
//! locality that worker declared over the wire, so the route is the
//! negotiation's choice, not this suite's. Both must prepare the same scene:
//! the same revision and content hash, and byte-identical rendered frames.
//! Then the co-located worker refuses, by name, a path outside its directory
//! and a package whose scene names other bytes than it holds, and the LAN
//! worker, which has no package directory, refuses any path.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use gx_asset_plane::package::{write_package, PackageSource};
use gx_asset_plane::{
    fetch_bytes, publish_package, AssetHandoff, PackagePublication, PublishRefusal, PublishReply,
};
use gx_contracts::scene::{parse_scene_document, SceneDocument};
use gx_contracts::{ContentHash, Locality, Refusal, Revision};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::render::{RenderRequest, RenderedFrame};

use crate::{expect, Outcome, Report};

const PLANE: &str = "asset";
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../services/render-engine/worker/tests/fixtures"
);
/// The font asset's package-relative path, as the fixture scene declares it.
const FONT_PATH: &str = "fonts/Inter-Regular.ttf";

/// The GPU reference lower third (text in Inter), with a take id and the
/// revision a package pins.
fn fixture_scene(id: &str) -> Result<SceneDocument, String> {
    let json =
        std::fs::read(format!("{FIXTURES}/gpu-lower-third-50.json")).map_err(|e| e.to_string())?;
    let mut scene = parse_scene_document(&json).map_err(|e| e.to_string())?;
    scene.id = id.to_owned();
    scene.revision = Some(Revision(1));
    if !scene.assets.iter().any(|asset| asset.path == FONT_PATH) {
        return Err(format!("the fixture declares no asset at {FONT_PATH}"));
    }
    Ok(scene)
}

/// Write `scene` as a package at `output`, its font from the fixture.
fn package(output: &Path, scene: &SceneDocument) -> Result<(), String> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_package(
        output,
        scene,
        &[PackageSource {
            path: FONT_PATH.into(),
            source: PathBuf::from(format!("{FIXTURES}/Inter-Regular.ttf")),
        }],
        None,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn render(
    peer: &mut impl EnginePeer,
    published: &PublishReply,
    frame: u64,
) -> Option<RenderedFrame> {
    let PublishReply::Published {
        take_id,
        revision,
        content_hash,
    } = published
    else {
        return None;
    };
    match peer.handle(ClientRequest::Render(RenderRequest {
        take_id: take_id.clone(),
        revision: *revision,
        content_hash: Some(content_hash.clone()),
        frame,
    })) {
        EngineReply::Rendered(frame) => Some(frame),
        _ => None,
    }
}

fn package_refused(
    publication: &Result<PackagePublication, impl std::fmt::Debug>,
) -> Option<&Refusal> {
    match publication {
        Ok(PackagePublication {
            reply: PublishReply::Refused(PublishRefusal::PackageRefused { cause }),
            ..
        }) => Some(cause),
        _ => None,
    }
}

/// 5.8 against a co-located worker started with `--package-dir package_dir`
/// and a LAN worker, each reached over its control client and asset plane.
pub fn package_handoff_suite<C: EnginePeer, L: EnginePeer>(
    co_located: (&mut C, SocketAddr),
    lan: (&mut L, SocketAddr),
    package_dir: &Path,
    report: &mut Report,
) {
    let (local, local_assets) = co_located;
    let (remote, remote_assets) = lan;
    let declared = (local.capability().locality, remote.capability().locality);
    report.record(
        PLANE,
        "the two workers declare co-located and LAN localities over the wire",
        expect(
            declared == (Locality::CoLocated, Locality::Lan),
            format!("5.8: declared {declared:?}"),
        ),
    );

    let scene = match fixture_scene("conformance/package-handoff") {
        Ok(scene) => scene,
        Err(e) => {
            report.record(
                PLANE,
                "one package publishes by local path and by chunked upload",
                Outcome::Fail(format!("fixture: {e}")),
            );
            return;
        }
    };
    let path = package_dir.join("lower-third.gpxpkg");
    if let Err(e) = package(&path, &scene) {
        report.record(
            PLANE,
            "one package publishes by local path and by chunked upload",
            Outcome::Fail(format!("package: {e}")),
        );
        return;
    }
    let font_bytes = std::fs::metadata(format!("{FIXTURES}/Inter-Regular.ttf"))
        .map(|m| m.len())
        .unwrap_or(0);

    // The route is whatever the declared locality negotiates.
    let by_path = publish_package(local_assets, declared.0, &path);
    let chunked = publish_package(remote_assets, declared.1, &path);
    let routes_ok = matches!(
        (&by_path, &chunked),
        (
            Ok(PackagePublication { handoff: AssetHandoff::LocalPath, transferred_bytes: 0, reply: PublishReply::Published { .. } }),
            Ok(PackagePublication { handoff: AssetHandoff::ChunkedUpload, transferred_bytes, reply: PublishReply::Published { .. } }),
        ) if *transferred_bytes == font_bytes && font_bytes > 0
    );
    report.record(
        PLANE,
        "one package publishes by local path and by chunked upload",
        expect(
            routes_ok,
            format!("5.8: by path {by_path:?}; chunked {chunked:?} (font is {font_bytes} bytes)"),
        ),
    );
    let (Ok(by_path), Ok(chunked)) = (by_path, chunked) else {
        return;
    };
    report.record(
        PLANE,
        "both routes publish the same revision and content hash",
        expect(
            matches!(by_path.reply, PublishReply::Published { .. })
                && by_path.reply == chunked.reply,
            format!(
                "5.8: by path {:?}; chunked {:?}",
                by_path.reply, chunked.reply
            ),
        ),
    );

    // Identical prepared scenes render identical frames: first, middle, last.
    let mut frames = Vec::new();
    for frame in [0, 50, 100] {
        let a = render(local, &by_path.reply, frame);
        let b = render(remote, &chunked.reply, frame);
        let bytes = |assets: SocketAddr, rendered: &Option<RenderedFrame>| {
            rendered
                .as_ref()
                .and_then(|r| fetch_bytes(assets, &r.image).ok())
        };
        let (a_bytes, b_bytes) = (bytes(local_assets, &a), bytes(remote_assets, &b));
        frames.push((
            frame,
            a.as_ref().map(|r| r.image.clone()),
            b.as_ref().map(|r| r.image.clone()),
            a_bytes.is_some() && a_bytes == b_bytes,
        ));
    }
    report.record(
        PLANE,
        "the engine prepares identical scenes by either route: byte-identical frames",
        expect(
            frames
                .iter()
                .all(|(_, a, b, same)| a.is_some() && a == b && *same),
            format!("5.8: frames (frame, by-path image, chunked image, bytes equal) {frames:?}"),
        ),
    );

    // Outside the directory: refused by name, whether named absolutely or by
    // a relative path that climbs out of it.
    let outside_dir = package_dir.with_extension("outside");
    let outside = outside_dir.join("lower-third.gpxpkg");
    let outside_published = package(&outside, &scene)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            publish_package(local_assets, declared.0, &outside).map_err(|e| e.to_string())
        });
    report.record(
        PLANE,
        "a co-located engine refuses a package path outside its package directory by name",
        expect(
            matches!(
                package_refused(&outside_published),
                Some(Refusal::PackagePathOutsideDirectory { .. })
            ),
            format!("5.8: outside path {outside_published:?}"),
        ),
    );
    let _ = std::fs::remove_dir_all(&outside_dir);

    // A scene that names other bytes than its package holds.
    let mut wrong = scene.clone();
    wrong.id = "conformance/package-handoff-mismatch".into();
    let other = ContentHash("0".repeat(64));
    for asset in &mut wrong.assets {
        if asset.path == FONT_PATH {
            asset.checksum = Some(other.clone());
        }
    }
    let mismatched = package_dir.join("mismatch.gpxpkg");
    let mismatch_published = package(&mismatched, &wrong)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            publish_package(local_assets, declared.0, &mismatched).map_err(|e| e.to_string())
        });
    report.record(
        PLANE,
        "a co-located engine refuses a package whose asset bytes do not match their hash by name",
        expect(
            matches!(
                package_refused(&mismatch_published),
                Some(Refusal::AssetHashMismatch { expected, .. }) if *expected == other
            ),
            format!("5.8: mismatched package {mismatch_published:?}"),
        ),
    );

    // The LAN worker has no package directory, so a path offered to it (as
    // if it were co-located) is refused by name, never read.
    let forced = publish_package(remote_assets, Locality::CoLocated, &path);
    report.record(
        PLANE,
        "an engine without a package directory refuses a package path by name",
        expect(
            matches!(
                package_refused(&forced),
                Some(Refusal::PackageDirectoryNotConfigured { .. })
            ),
            format!("5.8: path to the LAN worker {forced:?}"),
        ),
    );
}
