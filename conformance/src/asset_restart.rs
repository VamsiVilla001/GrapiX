//! Restart after asset-bearing publishes (build plan 5.11), against real
//! workers killed outright and started again on the same journal.
//!
//! Since 5.9 an engine keeps the bytes it is published, and since 5.11 it
//! keeps them in a store beside its recovery journal, written before the
//! publication is acknowledged. Each route's Inter lower third is published,
//! the worker is killed (TerminateProcess: no shutdown code runs), the
//! package is deleted, and the worker is started again on its journal: the
//! restored revision renders the frame it rendered before and is taken. A
//! second worker has one stored asset removed and another altered before its
//! restart: it starts, names both dropped scenes and their reasons, refuses
//! them with those reasons, and still serves the scene whose bytes are
//! intact. A third, whose store cannot be written, refuses each route by
//! name and keeps nothing.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use gx_asset_plane::package::{write_package, PackageSource};
use gx_asset_plane::{
    content_hash, fetch_bytes, publish_assets, publish_package, publish_scene, AssetBytes,
    AssetHandoff, AssetTransferClientError, PackagePublication, PublishRefusal, PublishReply,
};
use gx_contracts::scene::{parse_scene_document, AssetKind, AssetLibraryItem, SceneDocument};
use gx_contracts::{ContentHash, DeviceTier, Epoch, Refusal, Revision, TakeId};
use gx_control_plane::intent::{CueRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::render::{RenderRequest, RenderedFrame};
use gx_render_worker::recovery::{DropReport, RecoveryJournal};

use crate::{expect, Outcome, Report};

const PLANE: &str = "recovery";
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../services/render-engine/worker/tests/fixtures"
);
const BASELINES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/baselines");
const FONT_PATH: &str = "fonts/Inter-Regular.ttf";
/// The frame compared before the kill and after the restart.
const FRAME: u64 = 50;

/// A real worker the suite can kill outright and start again with the same
/// journal and arguments.
pub trait RestartableWorker {
    type Control: EnginePeer;
    fn control(&mut self) -> &mut Self::Control;
    fn assets(&self) -> SocketAddr;
    /// The worker's recovery journal file.
    fn journal(&self) -> PathBuf;
    /// What the current incarnation has written to stderr.
    fn stderr(&self) -> String;
    /// Kill the process, run `between` while it is down, and start it again
    /// on the same journal and arguments. The same binary has already started
    /// once, so a failure to come back is the defect, never an unavailable
    /// peer: the error is a FAIL.
    fn kill_and_restart(
        &mut self,
        between: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String>;
}

/// A published revision and the pin a take needs.
type Pin = (TakeId, Revision, ContentHash);

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

/// The GPU reference lower third (text in Inter) as `id`, pinned at
/// revision 1 for packaging, declaring each `(name, bytes)` as an image asset
/// with no image object.
fn lower_third(id: &str, images: &[(&str, &[u8])]) -> Result<SceneDocument, String> {
    let json = read(&format!("{FIXTURES}/gpu-lower-third-50.json"))?;
    let mut scene = parse_scene_document(&json).map_err(|e| e.to_string())?;
    scene.id = id.to_owned();
    scene.revision = Some(Revision(1));
    for (name, bytes) in images {
        scene.assets.push(AssetLibraryItem {
            asset_id: format!("conformance-{name}"),
            name: (*name).into(),
            kind: AssetKind::Image,
            path: format!("images/{name}"),
            checksum: Some(content_hash(bytes)),
            mime_type: Some("image/png".into()),
            size_bytes: Some(bytes.len() as u64),
            status: None,
            provenance: Default::default(),
        });
    }
    Ok(scene)
}

/// Write `scene` as a package, its font and each image from the fixtures.
fn package(output: &Path, scene: &SceneDocument, images: &[&str]) -> Result<(), String> {
    let mut sources = vec![PackageSource {
        path: FONT_PATH.into(),
        source: PathBuf::from(format!("{FIXTURES}/Inter-Regular.ttf")),
    }];
    for name in images {
        sources.push(PackageSource {
            path: format!("images/{name}"),
            source: PathBuf::from(format!("{BASELINES}/{name}")),
        });
    }
    write_package(output, scene, &sources, None)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn pinned(reply: &PublishReply) -> Option<Pin> {
    match reply {
        PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } => Some((take_id.clone(), *revision, content_hash.clone())),
        PublishReply::Refused(_) => None,
    }
}

fn render(peer: &mut impl EnginePeer, pin: &Pin) -> EngineReply {
    peer.handle(ClientRequest::Render(RenderRequest {
        take_id: pin.0.clone(),
        revision: pin.1,
        content_hash: Some(pin.2.clone()),
        frame: FRAME,
    }))
}

/// A rendered frame and its image's bytes, fetched from the engine.
fn rendered(
    peer: &mut impl EnginePeer,
    assets: SocketAddr,
    pin: &Pin,
) -> Option<(RenderedFrame, Vec<u8>)> {
    match render(peer, pin) {
        EngineReply::Rendered(frame) => {
            let bytes = fetch_bytes(assets, &frame.image).ok()?;
            Some((frame, bytes))
        }
        _ => None,
    }
}

/// [`rendered`] on a worker's own control client and asset plane.
fn seen<W: RestartableWorker>(worker: &mut W, pin: &Pin) -> Option<(RenderedFrame, Vec<u8>)> {
    let assets = worker.assets();
    rendered(worker.control(), assets, pin)
}

fn cue(peer: &mut impl EnginePeer, pin: &Pin) -> EngineReply {
    peer.handle(ClientRequest::Cue(CueRequest {
        take_id: pin.0.clone(),
        revision: pin.1,
        content_hash: Some(pin.2.clone()),
        at: TakeAt::NextOpportunity,
    }))
}

fn take(peer: &mut impl EnginePeer, pin: &Pin) -> EngineReply {
    peer.handle(ClientRequest::Take(TakeRequest {
        take_id: pin.0.clone(),
        revision: pin.1,
        content_hash: Some(pin.2.clone()),
        at: TakeAt::NextOpportunity,
    }))
}

/// A restored revision's take, judged by the engine's tier. On T0 only
/// Taken passes. Below T0 a prepared revision is refused TierTooLow, a named
/// skip; Taken there could only come through the identifier-only path,
/// which means the scene was not restored, so it fails.
fn take_outcome(peer: &mut impl EnginePeer, pin: &Pin) -> Outcome {
    let tier = peer.capability().device_tier;
    match (tier, take(peer, pin)) {
        (DeviceTier::T0, EngineReply::Taken(_)) => Outcome::Pass,
        (_, EngineReply::Refused(Refusal::TierTooLow { actual })) if tier != DeviceTier::T0 => {
            Outcome::Skip(format!(
                "restored and rendered; the engine is {actual:?}, below T0, so it refuses the take"
            ))
        }
        (_, other) => Outcome::Fail(format!("5.11: take of {pin:?} on {tier:?}: {other:?}")),
    }
}

/// Where the engine keeps a stored asset, found from the journal's file
/// name by this suite, not by the engine's own derivation.
fn store_entry(journal: &Path, hash: &ContentHash) -> PathBuf {
    let mut name = journal.file_name().unwrap_or_default().to_os_string();
    name.push(".assets");
    journal.with_file_name(name).join(&hash.0)
}

fn rehashes_to(path: &Path, hash: &ContentHash) -> bool {
    std::fs::read(path).is_ok_and(|bytes| content_hash(&bytes) == *hash)
}

/// Retry briefly: a scanner may still hold a file the engine just wrote.
fn retrying(mut act: impl FnMut() -> std::io::Result<()>) -> Result<(), String> {
    let mut last = None;
    for _ in 0..20 {
        match act() {
            Ok(()) => return Ok(()),
            Err(error) => last = Some(error),
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err(last.map(|e| e.to_string()).unwrap_or_default())
}

/// 5.11 against four real workers, each started once already:
/// `by_path` co-located with `--package-dir dirs.0`, `chunked` with `--lan`,
/// `damaged` co-located with `--package-dir dirs.1`, and `unwritable`
/// co-located with `--package-dir dirs.2` whose store path is a file.
pub fn asset_restart_suite<W: RestartableWorker>(
    by_path: &mut W,
    chunked: &mut W,
    damaged: &mut W,
    unwritable: &mut W,
    dirs: (&Path, &Path, &Path),
    report: &mut Report,
) {
    let font = match read(&format!("{FIXTURES}/Inter-Regular.ttf")) {
        Ok(font) => font,
        Err(e) => {
            report.record(PLANE, "each route keeps the Inter lower third's bytes in the store beside the journal before the publication is acknowledged", Outcome::Fail(e));
            return;
        }
    };
    let font_hash = content_hash(&font);
    both_routes_restore(by_path, chunked, dirs.0, &font, &font_hash, report);
    damaged_store_drops_by_name(damaged, dirs.1, &font, &font_hash, report);
    unwritable_store_refuses(unwritable, dirs.2, &font_hash, report);
}

fn both_routes_restore<W: RestartableWorker>(
    by_path: &mut W,
    chunked: &mut W,
    dir: &Path,
    font: &[u8],
    font_hash: &ContentHash,
    report: &mut Report,
) {
    // Each route is the one its worker's declared locality negotiates.
    let mut publications = Vec::new();
    for (worker, id) in [
        (&mut *by_path, "conformance/restart-by-path"),
        (&mut *chunked, "conformance/restart-chunked"),
    ] {
        let locality = worker.control().capability().locality;
        let path = dir.join(format!("{}.gpxpkg", id.replace('/', "-")));
        let published = lower_third(id, &[])
            .and_then(|scene| package(&path, &scene, &[]))
            .and_then(|()| {
                publish_package(worker.assets(), locality, &path).map_err(|e| e.to_string())
            });
        let stored = store_entry(&worker.journal(), font_hash);
        let journaled = RecoveryJournal::open_at(worker.journal())
            .ok()
            .and_then(|journal| journal.load().ok().flatten())
            .is_some_and(|state| state.published.contains_key(&TakeId(id.into())));
        publications.push((published, stored, journaled, path));
    }
    let routes_ok = matches!(
        (&publications[0].0, &publications[1].0),
        (
            Ok(PackagePublication { handoff: AssetHandoff::LocalPath, transferred_bytes: 0, reply: PublishReply::Published { .. } }),
            Ok(PackagePublication { handoff: AssetHandoff::ChunkedUpload, transferred_bytes, reply: PublishReply::Published { .. } }),
        ) if *transferred_bytes == font.len() as u64
    );
    let stored_ok = publications
        .iter()
        .all(|(_, stored, journaled, _)| *journaled && rehashes_to(stored, font_hash));
    report.record(
        PLANE,
        "each route keeps the Inter lower third's bytes in the store beside the journal before the publication is acknowledged",
        expect(
            routes_ok && stored_ok,
            format!(
                "5.11: by path {:?}, chunked {:?}; store entries {:?}",
                publications[0].0,
                publications[1].0,
                publications
                    .iter()
                    .map(|(_, stored, journaled, _)| (stored.display().to_string(), stored.exists(), *journaled))
                    .collect::<Vec<_>>()
            ),
        ),
    );
    let pins: Vec<Option<Pin>> = publications
        .iter()
        .map(|(published, ..)| published.as_ref().ok().and_then(|p| pinned(&p.reply)))
        .collect();
    let (Some(path_pin), Some(chunked_pin)) = (pins[0].clone(), pins[1].clone()) else {
        return;
    };

    let before = [seen(by_path, &path_pin), seen(chunked, &chunked_pin)];
    // The packages are gone before the restart: nothing may be re-read.
    for (.., path) in &publications {
        let _ = std::fs::remove_file(path);
    }
    let mut restarted = Vec::new();
    for worker in [&mut *by_path, &mut *chunked] {
        let back = worker.kill_and_restart(&mut || Ok(()));
        let epoch = back.is_ok().then(|| worker.control().capability().epoch);
        restarted.push((back, epoch, worker.stderr()));
    }
    for ((back, epoch, stderr), name) in restarted.iter().zip([
        "a worker killed after a by-path publish restarts on its journal at the next epoch",
        "a worker killed after a chunked publish restarts on its journal at the next epoch",
    ]) {
        report.record(
            PLANE,
            name,
            expect(
                back.is_ok() && *epoch == Some(Epoch(2)) && !stderr.contains("recovery: dropped"),
                format!("5.11: restart {back:?}, epoch {epoch:?}, stderr {stderr:?}"),
            ),
        );
    }
    if restarted.iter().any(|(back, ..)| back.is_err()) {
        return;
    }
    let after = [seen(by_path, &path_pin), seen(chunked, &chunked_pin)];
    let same = before
        .iter()
        .zip(&after)
        .all(|(b, a)| b.is_some() && a.is_some() && b == a);
    report.record(
        PLANE,
        "the restored revisions render the frame they rendered before the kill",
        expect(
            same,
            format!(
                "5.11: before {:?}, after {:?}",
                before
                    .iter()
                    .map(|f| f.as_ref().map(|f| f.0.image.clone()))
                    .collect::<Vec<_>>(),
                after
                    .iter()
                    .map(|f| f.as_ref().map(|f| f.0.image.clone()))
                    .collect::<Vec<_>>()
            ),
        ),
    );
    let outcome = take_outcome(by_path.control(), &path_pin);
    report.record(PLANE, "the restored by-path revision is taken", outcome);
    let outcome = take_outcome(chunked.control(), &chunked_pin);
    report.record(PLANE, "the restored chunked revision is taken", outcome);
    // The bytes came back with the scene: nothing is sent again.
    let again = publish_assets(
        chunked.assets(),
        &[AssetBytes {
            hash: font_hash.clone(),
            bytes: font.to_vec(),
        }],
    );
    report.record(
        PLANE,
        "a restored engine holds its restored bytes, so a publisher sends none again",
        expect(
            matches!(&again, Ok(summary) if summary.transferred_bytes == 0 && summary.missing.is_empty()),
            format!("5.11: preflight after restart {again:?}"),
        ),
    );
}

fn damaged_store_drops_by_name<W: RestartableWorker>(
    worker: &mut W,
    dir: &Path,
    font: &[u8],
    font_hash: &ContentHash,
    report: &mut Report,
) {
    const STARTS: &str = "a worker whose stored assets were removed and altered still starts";
    let images = read(&format!("{BASELINES}/rate-25.png"))
        .and_then(|removed| Ok((removed, read(&format!("{BASELINES}/rate-30.png"))?)));
    let (png_removed, png_altered) = match images {
        Ok(images) => images,
        Err(e) => {
            report.record(PLANE, STARTS, Outcome::Fail(format!("fixtures: {e}")));
            return;
        }
    };
    let (hash_removed, hash_altered) = (content_hash(&png_removed), content_hash(&png_altered));
    let locality = worker.control().capability().locality;
    let addr = worker.assets();

    // A by path, B by path with a PNG to remove, C chunked with a PNG to alter.
    let by_path = |id: &str, images: &[(&str, &[u8])], names: &[&str]| -> Result<Pin, String> {
        let path = dir.join(format!("{}.gpxpkg", id.replace('/', "-")));
        let scene = lower_third(id, images)?;
        package(&path, &scene, names)?;
        let published = publish_package(addr, locality, &path).map_err(|e| e.to_string())?;
        pinned(&published.reply).ok_or_else(|| format!("{id}: {:?}", published.reply))
    };
    let intact = by_path("conformance/restart-intact", &[], &[]);
    let removed = by_path(
        "conformance/restart-removed",
        &[("rate-25.png", &png_removed)],
        &["rate-25.png"],
    );
    let altered = lower_third(
        "conformance/restart-altered",
        &[("rate-30.png", &png_altered)],
    )
    .and_then(|scene| {
        let sent = publish_assets(
            addr,
            &[
                AssetBytes {
                    hash: font_hash.clone(),
                    bytes: font.to_vec(),
                },
                AssetBytes {
                    hash: hash_altered.clone(),
                    bytes: png_altered.clone(),
                },
            ],
        )
        .map_err(|e| e.to_string())?;
        if sent.transferred_bytes != png_altered.len() as u64 {
            return Err(format!(
                "the chunked publish sent {} bytes, not the image's {}",
                sent.transferred_bytes,
                png_altered.len()
            ));
        }
        let reply = publish_scene(addr, scene).map_err(|e| e.to_string())?;
        pinned(&reply).ok_or_else(|| format!("{reply:?}"))
    });
    let (Ok(intact), Ok(removed), Ok(altered)) = (intact.clone(), removed.clone(), altered.clone())
    else {
        report.record(
            PLANE,
            STARTS,
            Outcome::Fail(format!(
                "5.11: publications intact {intact:?}, removed {removed:?}, altered {altered:?}"
            )),
        );
        return;
    };
    let cued = cue(worker.control(), &altered);
    let before = rendered(worker.control(), addr, &intact);
    let journal = worker.journal();
    let (removed_entry, altered_entry) = (
        store_entry(&journal, &hash_removed),
        store_entry(&journal, &hash_altered),
    );
    let mut changed = png_altered.clone();
    changed[1000] ^= 0x01;
    let back = worker.kill_and_restart(&mut || {
        retrying(|| std::fs::remove_file(&removed_entry))?;
        retrying(|| std::fs::write(&altered_entry, &changed))
    });
    let epoch = back.is_ok().then(|| worker.control().capability().epoch);
    report.record(
        PLANE,
        STARTS,
        expect(
            matches!(cued, EngineReply::Cued(_)) && back.is_ok() && epoch == Some(Epoch(2)),
            format!(
                "5.11: cue before {cued:?}; restart {back:?}, epoch {epoch:?}, stderr {:?}",
                worker.stderr()
            ),
        ),
    );
    if back.is_err() {
        return;
    }
    let addr = worker.assets();

    // Named on stderr and, every one, in the drop report beside the journal.
    let stderr = worker.stderr();
    let line = |take: &str| {
        stderr
            .lines()
            .find(|line| line.contains(&format!("dropped scene {take}/1")))
            .unwrap_or_default()
            .to_owned()
    };
    let (removed_line, altered_line) = (
        line("conformance/restart-removed"),
        line("conformance/restart-altered"),
    );
    let actual = content_hash(&changed);
    let mut report_name = journal.file_name().unwrap_or_default().to_os_string();
    report_name.push(".dropped.json");
    let written: Option<DropReport> = std::fs::read(journal.with_file_name(report_name))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let reported: Vec<(String, Refusal, bool)> = written
        .iter()
        .flat_map(|report| report.dropped.iter())
        .map(|scene| {
            (
                scene.take_id.0.clone(),
                scene.reason.clone(),
                scene.was_cued,
            )
        })
        .collect();
    report.record(
        PLANE,
        "the restart names both dropped scenes and their reasons",
        expect(
            removed_line.contains("assetMissing")
                && removed_line.contains(&hash_removed.0)
                && altered_line.contains("assetHashMismatch")
                && altered_line.contains(&hash_altered.0)
                && altered_line.contains(&actual.0)
                && altered_line.contains("it was cued")
                && !stderr.contains("restart-intact")
                && reported
                    == vec![
                        (
                            "conformance/restart-altered".to_owned(),
                            Refusal::AssetHashMismatch {
                                expected: hash_altered.clone(),
                                actual: actual.clone(),
                            },
                            true,
                        ),
                        (
                            "conformance/restart-removed".to_owned(),
                            Refusal::AssetMissing {
                                hash: hash_removed.clone(),
                            },
                            false,
                        ),
                    ],
            format!("5.11: stderr {stderr:?}; report {reported:?}"),
        ),
    );
    let refusals = (
        render(worker.control(), &removed),
        cue(worker.control(), &altered),
        take(worker.control(), &removed),
    );
    report.record(
        PLANE,
        "a dropped scene cannot be rendered, cued or taken, and the refusal is its reason",
        expect(
            matches!(&refusals.0, EngineReply::Refused(Refusal::AssetMissing { hash }) if *hash == hash_removed)
                && matches!(&refusals.1, EngineReply::Refused(Refusal::AssetHashMismatch { expected, .. }) if *expected == hash_altered)
                && matches!(&refusals.2, EngineReply::Refused(Refusal::AssetMissing { hash }) if *hash == hash_removed),
            format!("5.11: render, cue, take of dropped scenes {refusals:?}"),
        ),
    );
    let after = rendered(worker.control(), addr, &intact);
    report.record(
        PLANE,
        "the scene whose bytes are intact renders as before",
        expect(
            before.is_some() && before == after,
            format!(
                "5.11: before {:?}, after {:?}",
                before.as_ref().map(|f| &f.0.image),
                after.as_ref().map(|f| &f.0.image)
            ),
        ),
    );
    let outcome = take_outcome(worker.control(), &intact);
    report.record(PLANE, "the scene whose bytes are intact is taken", outcome);
    let state = RecoveryJournal::open_at(journal.clone())
        .ok()
        .and_then(|journal| journal.load().ok().flatten());
    report.record(
        PLANE,
        "the rewritten journal holds only what was restored, and the dropped takes' revisions",
        expect(
            state.as_ref().is_some_and(|state| {
                state.published.keys().cloned().collect::<Vec<_>>() == vec![intact.0.clone()]
                    && state.cued.is_none()
                    && !state.verified_assets.contains(&hash_removed)
                    && !state.verified_assets.contains(&hash_altered)
                    && state.revision_floors.get(&removed.0) == Some(&removed.1)
                    && state.revision_floors.get(&altered.0) == Some(&altered.1)
            }),
            format!("5.11: journal {state:?}"),
        ),
    );
    // Sending the bytes again repairs the store, and the take continues
    // from its last revision, never reusing it.
    let resent = publish_assets(
        addr,
        &[
            AssetBytes {
                hash: font_hash.clone(),
                bytes: font.to_vec(),
            },
            AssetBytes {
                hash: hash_altered.clone(),
                bytes: png_altered.clone(),
            },
        ],
    );
    let republished = lower_third(
        "conformance/restart-altered",
        &[("rate-30.png", &png_altered)],
    )
    .map_err(|e| e.to_string())
    .and_then(|scene| publish_scene(addr, scene).map_err(|e| e.to_string()));
    let repaired = republished.as_ref().ok().and_then(pinned);
    let renders = repaired.as_ref().map(|pin| render(worker.control(), pin));
    report.record(
        PLANE,
        "a re-sent asset repairs its store entry, and the take continues its revisions",
        expect(
            matches!(&resent, Ok(summary) if summary.transferred_bytes == png_altered.len() as u64)
                && repaired
                    .as_ref()
                    .is_some_and(|pin| pin.1 == Revision(altered.1 .0 + 1))
                && rehashes_to(&store_entry(&journal, &hash_altered), &hash_altered)
                && matches!(renders, Some(EngineReply::Rendered(_))),
            format!("5.11: resent {resent:?}; republished {republished:?}; render {renders:?}"),
        ),
    );
}

fn unwritable_store_refuses<W: RestartableWorker>(
    worker: &mut W,
    dir: &Path,
    font_hash: &ContentHash,
    report: &mut Report,
) {
    let locality = worker.control().capability().locality;
    let addr = worker.assets();
    let path = dir.join("restart-unwritable.gpxpkg");
    let scene = lower_third("conformance/restart-unwritable", &[]);
    let by_path = scene
        .clone()
        .and_then(|scene| package(&path, &scene, &[]))
        .and_then(|()| publish_package(addr, locality, &path).map_err(|e| e.to_string()));
    let font = read(&format!("{FIXTURES}/Inter-Regular.ttf")).unwrap_or_default();
    let chunked = publish_assets(
        addr,
        &[AssetBytes {
            hash: font_hash.clone(),
            bytes: font,
        }],
    );
    let afterwards = scene.and_then(|scene| publish_scene(addr, scene).map_err(|e| e.to_string()));
    let journal = worker.journal();
    let pathless = |detail: &str| {
        !detail.contains(&journal.display().to_string()) && !detail.contains("recovery.json.assets")
    };
    report.record(
        PLANE,
        "an engine that cannot write its asset store refuses each route by name and keeps nothing",
        expect(
            matches!(&by_path, Ok(PackagePublication { reply: PublishReply::Refused(PublishRefusal::PackageRefused { cause: Refusal::AssetStoreFailed { hash, detail } }), .. }) if hash == font_hash && pathless(detail))
                && matches!(&chunked, Err(AssetTransferClientError::Refused(Refusal::AssetStoreFailed { hash, detail })) if hash == font_hash && pathless(detail))
                && matches!(&afterwards, Ok(PublishReply::Refused(PublishRefusal::PreparationRefused { cause: Refusal::AssetMissing { hash } })) if hash == font_hash),
            format!("5.11: by path {by_path:?}; chunked {chunked:?}; scene afterwards {afterwards:?}"),
        ),
    );
}
