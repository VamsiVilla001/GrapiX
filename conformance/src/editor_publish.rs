//! The Editor's publish reaches an engine by the route the engine itself
//! declares (build plan 5.10), against real workers.
//!
//! The Editor holds no control-plane client (boundary rule R6) and names no
//! locality (R9). It asks the engine, on the asset-plane address it is about
//! to publish to, and `gx_editor::publish::publish_document` (the function the
//! shell's `cmd_publish` calls) writes one verified package into its folder,
//! hands it over through the negotiated route and removes it.
//!
//! This suite shows that on three real workers: one with `--package-dir D`,
//! one with `--lan`, and one co-located with no package directory. It also
//! shows the one declaration held equal on both planes, and that every
//! negative is a named refusal rather than a failed connection.

use std::net::SocketAddr;
use std::path::Path;

use gx_asset_plane::{
    declared_locality, publish_package, AssetHandoff, AssetPublishServer, AssetStore,
    LocalityReply, PackagePublication, PublishRefusal, PublishReply,
};
use gx_contracts::scene::{parse_scene_document, SceneDocument};
use gx_contracts::{Locality, Refusal, Revision};
use gx_control_plane::peer::EnginePeer;
use gx_editor::publish::{package_sources, publish_document, PublishFailure, Published};

use crate::asset_restart::take_outcome;
use crate::{expect, Outcome, Report};

const PLANE: &str = "asset";
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../services/render-engine/worker/tests/fixtures"
);

/// The one declaration, read on both planes: the engine's answer on its asset
/// plane equals the locality in its capability exchange (invariants 27, 45).
pub fn asset_locality_agrees(
    assets: SocketAddr,
    over_control: Locality,
    name: &'static str,
    report: &mut Report,
) {
    let on_asset_plane = declared_locality(assets);
    report.record(
        PLANE,
        name,
        expect(
            matches!(
                &on_asset_plane,
                Ok(LocalityReply::Declared { locality }) if *locality == over_control
            ),
            format!("5.10: asset plane {on_asset_plane:?}; control plane {over_control:?}"),
        ),
    );
}

/// The Inter lower third, re-identified, with its font promoted into an
/// Editor asset store under `scratch`.
fn lower_third(id: &str, scratch: &Path) -> Result<(SceneDocument, AssetStore, u64), String> {
    let json = std::fs::read(format!("{FIXTURES}/gpu-lower-third-50.json"))
        .map_err(|e| format!("fixture scene: {e}"))?;
    let mut scene = parse_scene_document(&json).map_err(|e| e.to_string())?;
    scene.id = id.to_owned();
    let font = std::fs::read(format!("{FIXTURES}/Inter-Regular.ttf"))
        .map_err(|e| format!("fixture font: {e}"))?;
    let store = AssetStore::at_root(scratch.join("editor-assets"));
    store
        .promote_verified(&gx_asset_plane::content_hash(&font), &font)
        .map_err(|e| e.to_string())?;
    Ok((scene, store, font.len() as u64))
}

fn packages_in(directory: &Path) -> Vec<String> {
    std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn refused_package(failure: &Result<Published, PublishFailure>) -> Option<&Refusal> {
    match failure {
        Err(PublishFailure::EngineRefused(PublishRefusal::PackageRefused { cause })) => Some(cause),
        _ => None,
    }
}

/// 5.10 against three real workers.
///
/// - `co_located`: started with `--package-dir directory`.
/// - `lan`: started with `--lan`.
/// - `bare`: co-located, started with no package directory.
///
/// `directory` is the Editor's package folder: the one the co-located worker
/// reads from. `scratch` holds the Editor's asset store and other files.
pub fn editor_publish_suite<C: EnginePeer, L: EnginePeer, B: EnginePeer>(
    co_located: (&mut C, SocketAddr),
    lan: (&mut L, SocketAddr),
    bare: (&mut B, SocketAddr),
    directory: &Path,
    scratch: &Path,
    report: &mut Report,
) {
    let (local, local_assets) = co_located;
    let (remote, remote_assets) = lan;
    let (unconfigured, unconfigured_assets) = bare;

    for (assets, over_control, what) in [
        (
            local_assets,
            local.capability().locality,
            "the asset-plane locality equals the capability's on the worker started with a package directory",
        ),
        (
            remote_assets,
            remote.capability().locality,
            "the asset-plane locality equals the capability's on the worker started with --lan",
        ),
        (
            unconfigured_assets,
            unconfigured.capability().locality,
            "the asset-plane locality equals the capability's on the worker started with no package directory",
        ),
    ] {
        asset_locality_agrees(assets, over_control, what, report);
    }

    let (scene, store, font_bytes) = match lower_third("conformance/editor-publish", scratch) {
        Ok(prepared) => prepared,
        Err(e) => {
            report.record(
                PLANE,
                "the Editor publishes the Inter lower third to a co-located engine by path and to a LAN engine chunked",
                Outcome::Fail(format!("5.10: {e}")),
            );
            return;
        }
    };
    let sources = match package_sources(&scene, &store) {
        Ok(sources) => sources,
        Err(e) => {
            report.record(
                PLANE,
                "the Editor publishes the Inter lower third to a co-located engine by path and to a LAN engine chunked",
                Outcome::Fail(format!("5.10: package sources: {e}")),
            );
            return;
        }
    };

    // The same call, two engines: the route is the engine's declaration.
    let endpoint = |address: SocketAddr| address.to_string();
    let by_path = publish_document(&endpoint(local_assets), scene.clone(), &sources, directory);
    let chunked = publish_document(&endpoint(remote_assets), scene.clone(), &sources, directory);
    report.record(
        PLANE,
        "the Editor publishes the Inter lower third to a co-located engine by path and to a LAN engine chunked",
        expect(
            matches!(
                (&by_path, &chunked),
                (
                    Ok(Published { handoff: AssetHandoff::LocalPath, transferred_bytes: 0, .. }),
                    Ok(Published { handoff: AssetHandoff::ChunkedUpload, transferred_bytes, .. }),
                ) if *transferred_bytes == font_bytes && font_bytes > 0
            ),
            format!("5.10: by path {by_path:?}; chunked {chunked:?}; the font is {font_bytes} bytes"),
        ),
    );
    let leftover = packages_in(directory);
    report.record(
        PLANE,
        "both publications are the document's content hash and leave the Editor's package folder empty",
        expect(
            matches!((&by_path, &chunked), (Ok(a), Ok(b))
                if a.content_hash == b.content_hash
                    && a.revision == Revision(1)
                    && b.revision == Revision(1))
                && leftover.is_empty(),
            format!("5.10: by path {by_path:?}; chunked {chunked:?}; left in the folder {leftover:?}"),
        ),
    );
    if let (Ok(a), Ok(b)) = (&by_path, &chunked) {
        let pin = |p: &Published| (p.take_id.clone(), p.revision, p.content_hash.clone());
        report.record(
            PLANE,
            "the co-located publication is taken with its pinned hash",
            take_outcome(local, &pin(a)),
        );
        report.record(
            PLANE,
            "the LAN publication is taken with its pinned hash",
            take_outcome(remote, &pin(b)),
        );
    }

    // Publishing again is additive: the next revision, by the same route.
    let again = publish_document(&endpoint(local_assets), scene.clone(), &sources, directory);
    report.record(
        PLANE,
        "publishing the same document again issues the next revision by the same route",
        expect(
            matches!(
                &again,
                Ok(Published {
                    revision: Revision(2),
                    handoff: AssetHandoff::LocalPath,
                    ..
                })
            ),
            format!("5.10: republished {again:?}"),
        ),
    );

    // Named negatives. Each is a refusal by name, never a failed connection.
    let elsewhere = scratch.join("an-editor-folder-the-engine-was-not-given");
    let outside = publish_document(&endpoint(local_assets), scene.clone(), &sources, &elsewhere);
    report.record(
        PLANE,
        "a package folder the co-located engine was not started with is refused by name",
        expect(
            matches!(
                refused_package(&outside),
                Some(Refusal::PackagePathOutsideDirectory { .. })
            ) && packages_in(&elsewhere).is_empty(),
            format!("5.10: another folder {outside:?}"),
        ),
    );
    let unconfigured_publish = publish_document(
        &endpoint(unconfigured_assets),
        scene.clone(),
        &sources,
        directory,
    );
    report.record(
        PLANE,
        "a co-located engine started without a package directory refuses by name, with no fallback to the chunked route",
        expect(
            matches!(
                refused_package(&unconfigured_publish),
                Some(Refusal::PackageDirectoryNotConfigured { .. })
            ) && packages_in(directory).is_empty(),
            format!("5.10: no package directory {unconfigured_publish:?}"),
        ),
    );

    // A LAN-declared engine that holds a directory still reads no path: the
    // same worker engine, in process, declared LAN, offered a path by force.
    let lan_with_directory = lan_engine_holding(directory, scratch);
    report.record(
        PLANE,
        "a LAN-declared engine that holds a package directory still refuses a path by name",
        expect(
            matches!(
                lan_with_directory,
                Ok((
                    Locality::Lan,
                    Some(Refusal::PackageDirectoryNotConfigured { .. })
                ))
            ),
            format!("5.10: LAN-declared engine holding a directory: {lan_with_directory:?}"),
        ),
    );

    // Before any socket opens: an asset with no content hash yet.
    let mut pending = scene.clone();
    if let Some(asset) = pending.assets.first_mut() {
        asset.checksum = None;
    }
    let not_hashed = package_sources(&pending, &store);
    report.record(
        PLANE,
        "an asset with no content hash is refused before any socket opens",
        expect(
            matches!(
                not_hashed,
                Err(PublishFailure::NotSent(
                    Refusal::PackageAssetNotPackaged { .. }
                ))
            ),
            format!("5.10: {not_hashed:?}"),
        ),
    );

    // An engine nothing listens for is unreachable, not refused.
    let port = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0));
        listener.and_then(|l| l.local_addr()).map(|a| a.port())
    };
    let unreachable = port.map(|port| {
        publish_document(
            &format!("127.0.0.1:{port}"),
            scene.clone(),
            &sources,
            &scratch.join("never-written"),
        )
    });
    report.record(
        PLANE,
        "an engine nothing listens for is unreachable, not refused, and no package is written",
        expect(
            matches!(&unreachable, Ok(Err(PublishFailure::Unreachable { .. })))
                && !scratch.join("never-written").exists(),
            format!("5.10: {unreachable:?}"),
        ),
    );
}

/// The worker's own engine, declared LAN and holding `directory`, served on
/// the asset plane, offered a package by path with the co-located handoff
/// forced. Returns the locality it answered and the refusal it gave.
fn lan_engine_holding(
    directory: &Path,
    scratch: &Path,
) -> Result<(Locality, Option<Refusal>), String> {
    use gx_render_worker::Engine;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex};

    let mut engine = Engine::new(Arc::new(AtomicU64::new(0)), Locality::Lan);
    engine.set_package_directory(directory.to_path_buf());
    let server = AssetPublishServer::bind(
        "127.0.0.1:0".parse().map_err(|e| format!("{e}"))?,
        Arc::new(Mutex::new(engine)),
    )
    .map_err(|e| e.to_string())?;
    let address = server.local_addr().map_err(|e| e.to_string())?;
    server.serve_in_background();
    let declared = match declared_locality(address).map_err(|e| e.to_string())? {
        LocalityReply::Declared { locality } => locality,
        LocalityReply::Refused(refusal) => return Err(format!("{refusal:?}")),
    };
    // A package inside the directory the engine holds.
    let (scene, store, _) = lower_third("conformance/editor-publish-lan-holding", scratch)?;
    let sources = package_sources(&scene, &store).map_err(|e| e.to_string())?;
    let mut pinned = scene;
    pinned.revision = Some(Revision(1));
    let path = directory.join("a-package-offered-to-a-lan-engine.gpxpkg");
    gx_asset_plane::package::write_package(&path, &pinned, &sources, None)
        .map_err(|e| e.to_string())?;
    let offered = publish_package(address, Locality::CoLocated, &path);
    let _ = std::fs::remove_file(&path);
    let refusal = match offered {
        Ok(PackagePublication {
            reply: PublishReply::Refused(PublishRefusal::PackageRefused { cause }),
            ..
        }) => Some(cause),
        Ok(_) => None,
        Err(e) => return Err(e.to_string()),
    };
    Ok((declared, refusal))
}

/// 5.10: a worker cannot be both LAN-declared and handed a package directory.
pub fn lan_with_a_package_directory_is_a_usage_error(
    worker: &std::path::Path,
    folder: &std::path::Path,
    report: &mut Report,
) {
    let ran = std::process::Command::new(worker)
        // 2.12: a test process logs to a scratch folder, not the operator's log root.
        .env("GX_LOG_DIR", std::env::temp_dir().join("gx-test-logs"))
        .args(["--lan", "--package-dir"])
        .arg(folder)
        .stdin(std::process::Stdio::null())
        .output();
    let outcome = match ran {
        Ok(output) => {
            let said = String::from_utf8_lossy(&output.stderr).into_owned();
            if output.status.code() == Some(2) && said.contains("--package-dir") {
                Outcome::Pass
            } else {
                Outcome::Fail(format!(
                    "5.10: --lan --package-dir exited {:?}: {}",
                    output.status.code(),
                    said.trim()
                ))
            }
        }
        Err(e) => Outcome::Skip(format!("could not run the worker: {e}")),
    };
    report.record(
        "asset",
        "a worker started with both --lan and --package-dir exits with a usage error that names --package-dir",
        outcome,
    );
}
