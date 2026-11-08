//! 5.11: the engine keeps verified asset bytes in a store beside its recovery
//! journal and restores asset-bearing scenes from it after a kill, dropping
//! by name a scene whose bytes are missing, altered or unreadable.
//!
//! In process, the asset plane's receipt is reproduced exactly: the bytes go
//! into the engine's store first, then the engine is handed them. The
//! listener's own ordering (unlocked write, then receipt) is tested in
//! `gx_asset_plane`, and the whole route against real workers in
//! conformance.

use super::*;
use gx_contracts::scene::{parse_scene_document, AssetKind, AssetLibraryItem};
use gx_control_plane::intent::{CueRequest, TakeAt};
use gx_control_plane::render::RenderRequest;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const INTER: &[u8] = include_bytes!("../../tests/fixtures/Inter-Regular.ttf");
/// Declared image assets with no image object: their bytes are never
/// decoded, only held and re-hashed.
const IMAGE_B: &[u8] = b"declared image bytes for the removed-asset scene";
const IMAGE_C: &[u8] = b"declared image bytes for the altered-asset scene";

/// A journal path in its own directory, so stores never mix across tests.
fn journal_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir()
        .join(format!("gx-restore-{name}-{}-{nonce}", std::process::id()))
        .join("recovery.json")
}

fn engine() -> Engine {
    Engine::new(Arc::new(AtomicU64::new(0)), Locality::CoLocated)
}

fn attached(path: &Path) -> (Engine, Restored) {
    let mut engine = engine();
    let restored = engine
        .attach_recovery_journal(RecoveryJournal::open_at(path.to_path_buf()).expect("journal"))
        .expect("the journal attaches");
    (engine, restored)
}

/// The asset plane's receipt, in process: the store first, then the engine.
fn deliver(engine: &mut Engine, bytes: &[u8]) -> ContentHash {
    let hash = gx_asset_plane::content_hash(bytes);
    engine
        .asset_store()
        .expect("a journal is attached")
        .promote_verified(&hash, bytes)
        .expect("the store writes");
    engine
        .accept_verified_asset(hash.clone(), bytes.to_vec())
        .expect("stored bytes are accepted");
    hash
}

/// The Inter lower third as `id`, declaring `image` as an extra asset.
fn scene(id: &str, image: Option<&[u8]>) -> SceneDocument {
    let mut scene = parse_scene_document(include_bytes!(
        "../../tests/fixtures/gpu-lower-third-50.json"
    ))
    .expect("fixture parses");
    scene.id = id.into();
    if let Some(bytes) = image {
        scene.assets.push(AssetLibraryItem {
            asset_id: format!("{id}-image"),
            name: "Declared image".into(),
            kind: AssetKind::Image,
            path: format!("images/{}.png", id.replace('/', "-")),
            checksum: Some(gx_asset_plane::content_hash(bytes)),
            mime_type: Some("image/png".into()),
            size_bytes: Some(bytes.len() as u64),
            status: None,
            provenance: Default::default(),
        });
    }
    scene
}

fn publish(engine: &mut Engine, scene: SceneDocument) -> (TakeId, Revision, ContentHash) {
    match engine.publish(scene) {
        PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } => (take_id, revision, content_hash),
        other => panic!("the scene must publish: {other:?}"),
    }
}

fn cue(engine: &mut Engine, pin: &(TakeId, Revision, ContentHash)) -> EngineReply {
    engine.handle(ClientRequest::Cue(CueRequest {
        take_id: pin.0.clone(),
        revision: pin.1,
        content_hash: Some(pin.2.clone()),
        at: TakeAt::NextOpportunity,
    }))
}

fn render(engine: &mut Engine, pin: &(TakeId, Revision, ContentHash)) -> Option<EngineReply> {
    match engine.handle_detached(ClientRequest::Render(RenderRequest {
        take_id: pin.0.clone(),
        revision: pin.1,
        content_hash: Some(pin.2.clone()),
        frame: 0,
    })) {
        Handled::Reply(reply) => Some(reply),
        Handled::Detached(_) => None,
    }
}

fn cleanup(path: &Path) {
    let _ = std::fs::remove_dir_all(path.parent().expect("journal directory"));
}

#[test]
fn an_accepted_asset_is_in_the_store_beside_the_journal() {
    let path = journal_path("stored");
    let (mut engine, _) = attached(&path);
    let hash = deliver(&mut engine, INTER);
    let entry = path.with_file_name("recovery.json.assets").join(&hash.0);
    assert_eq!(std::fs::read(&entry).expect("the entry exists"), INTER);
    assert!(engine.has_verified_asset(&hash));
    cleanup(&path);
}

#[test]
fn bytes_the_store_does_not_hold_are_refused_by_name_and_change_nothing() {
    let path = journal_path("unstored");
    let (mut engine, _) = attached(&path);
    let hash = gx_asset_plane::content_hash(INTER);
    let refused = engine.accept_verified_asset(hash.clone(), INTER.to_vec());
    assert!(
        matches!(&refused, Err(Refusal::AssetStoreFailed { hash: named, .. }) if *named == hash),
        "{refused:?}"
    );
    assert!(!engine.has_verified_asset(&hash));
    assert!(!engine.output_inhibited());
    assert!(engine.recovery_state().verified_assets.is_empty());

    // An engine with no journal keeps no store, so it keeps no bytes.
    let mut bare = self::engine();
    assert!(matches!(
        bare.accept_verified_asset(hash.clone(), INTER.to_vec()),
        Err(Refusal::AssetStoreFailed { .. })
    ));
    cleanup(&path);
}

#[test]
fn an_entry_removed_while_the_engine_runs_is_missing_and_blocks_a_publish() {
    let path = journal_path("removed-live");
    let (mut engine, _) = attached(&path);
    let hash = deliver(&mut engine, INTER);
    let entry = path.with_file_name("recovery.json.assets").join(&hash.0);
    std::fs::remove_file(&entry).unwrap();
    // Preflight reports it missing, so a publisher sends it again.
    assert!(!engine.has_verified_asset(&hash));
    // A publication the store could not survive is not acknowledged.
    assert!(matches!(
        engine.publish(scene("restore/removed-live", None)),
        PublishReply::Refused(PublishRefusal::PreparationRefused {
            cause: Refusal::AssetMissing { hash: missing }
        }) if missing == hash
    ));
    deliver(&mut engine, INTER);
    publish(&mut engine, scene("restore/removed-live", None));
    cleanup(&path);
}

#[test]
fn a_killed_engine_restores_an_asset_bearing_scene_from_its_store() {
    let path = journal_path("restores");
    let pin = {
        let (mut first, _) = attached(&path);
        deliver(&mut first, INTER);
        publish(&mut first, scene("restore/lower-third", None))
    };
    // Before 5.11 this restart failed: "prepared scene ... cannot be
    // rebuilt: asset missing", exit 1.
    let (mut restored, outcome) = attached(&path);
    assert!(outcome.dropped.is_empty(), "{:?}", outcome.dropped);
    assert!(outcome.report.is_none());
    assert!(restored.prepared_scene(&pin.0, pin.1).is_some());
    assert_eq!(restored.clock.epoch(), Epoch(2));
    assert!(restored.output_inhibited());
    // The bytes came back with it: a new scene declaring them publishes
    // without anything being sent again.
    let inter = gx_asset_plane::content_hash(INTER);
    assert!(restored.has_verified_asset(&inter));
    publish(&mut restored, scene("restore/another", None));
    assert!(!path.with_file_name("recovery.json.dropped.json").exists());
    cleanup(&path);
}

#[test]
fn removed_and_altered_stored_bytes_drop_their_scenes_by_name_and_the_engine_still_starts() {
    let path = journal_path("damaged");
    let (intact, removed, altered) = {
        let (mut first, _) = attached(&path);
        deliver(&mut first, INTER);
        deliver(&mut first, IMAGE_B);
        deliver(&mut first, IMAGE_C);
        let intact = publish(&mut first, scene("restore/a-intact", None));
        let removed = publish(&mut first, scene("restore/b-removed", Some(IMAGE_B)));
        let altered = publish(&mut first, scene("restore/c-altered", Some(IMAGE_C)));
        assert!(matches!(cue(&mut first, &altered), EngineReply::Cued(_)));
        (intact, removed, altered)
    };
    let store = path.with_file_name("recovery.json.assets");
    let (hash_b, hash_c) = (
        gx_asset_plane::content_hash(IMAGE_B),
        gx_asset_plane::content_hash(IMAGE_C),
    );
    std::fs::remove_file(store.join(&hash_b.0)).unwrap();
    let mut changed = IMAGE_C.to_vec();
    changed[0] ^= 0x01;
    std::fs::write(store.join(&hash_c.0), &changed).unwrap();

    let (mut engine, outcome) = attached(&path);
    // Started, at the next epoch, output-inhibited.
    assert_eq!(engine.clock.epoch(), Epoch(2));
    assert!(engine.output_inhibited());
    // Both drops named, with their reasons, in take order.
    let dropped: Vec<_> = outcome
        .dropped
        .iter()
        .map(|scene| (scene.take_id.clone(), scene.reason.clone(), scene.was_cued))
        .collect();
    assert_eq!(
        dropped,
        vec![
            (
                removed.0.clone(),
                Refusal::AssetMissing {
                    hash: hash_b.clone()
                },
                false
            ),
            (
                altered.0.clone(),
                Refusal::AssetHashMismatch {
                    expected: hash_c.clone(),
                    actual: gx_asset_plane::content_hash(&changed),
                },
                true
            ),
        ]
    );
    // The intact scene is served as before; the dropped ones are refused
    // with their reasons, never through the identifier-only path.
    assert!(engine.prepared_scene(&intact.0, intact.1).is_some());
    assert!(
        render(&mut engine, &intact).is_none(),
        "the intact scene renders"
    );
    assert!(matches!(cue(&mut engine, &intact), EngineReply::Cued(_)));
    assert!(matches!(
        cue(&mut engine, &removed),
        EngineReply::Refused(Refusal::AssetMissing { hash }) if hash == hash_b
    ));
    assert!(matches!(
        render(&mut engine, &altered),
        Some(EngineReply::Refused(Refusal::AssetHashMismatch { expected, .. })) if expected == hash_c
    ));
    // The rewritten journal holds only what was restored.
    let journal = RecoveryJournal::open_at(path.clone()).unwrap();
    let state = journal.load().unwrap().expect("journal");
    assert_eq!(
        state.published.keys().cloned().collect::<Vec<_>>(),
        vec![intact.0.clone()]
    );
    assert!(!state.verified_assets.contains(&hash_b));
    assert!(!state.verified_assets.contains(&hash_c));
    assert_eq!(state.revision_floors.get(&removed.0), Some(&removed.1));
    // Every drop is in the report beside the journal, written before it.
    let report: DropReport =
        serde_json::from_slice(&std::fs::read(journal.drop_report_path()).unwrap()).unwrap();
    assert_eq!(report.epoch, Epoch(2));
    assert_eq!(report.dropped, outcome.dropped);
    cleanup(&path);
}

#[test]
fn a_drop_clears_only_the_program_and_cue_that_name_the_dropped_take() {
    let path = journal_path("program");
    let (kept, lost) = {
        let (mut first, _) = attached(&path);
        deliver(&mut first, INTER);
        deliver(&mut first, IMAGE_B);
        (
            publish(&mut first, scene("restore/kept", None)),
            publish(&mut first, scene("restore/lost", Some(IMAGE_B))),
        )
    };
    let on = |pin: &(TakeId, Revision, ContentHash)| ProgramState {
        take_id: pin.0.clone(),
        revision: pin.1,
        committed_frame: 0,
        scene_frame: 0,
        playing: true,
        phase: None,
        stop_frame: None,
    };
    let journal = RecoveryJournal::open_at(path.clone()).unwrap();
    std::fs::remove_file(
        path.with_file_name("recovery.json.assets")
            .join(gx_asset_plane::content_hash(IMAGE_B).0),
    )
    .unwrap();
    for (program, cued, program_survives, cue_survives) in [
        (Some(on(&lost)), Some(on(&kept)), false, true),
        (Some(on(&kept)), Some(on(&lost)), true, false),
    ] {
        let mut state = journal.load().unwrap().expect("journal");
        // Put the dropped take back, as the first engine journaled it.
        state.revision_floors.clear();
        state.published.insert(
            lost.0.clone(),
            HeldRevision {
                revision: lost.1,
                content_hash: lost.2.clone(),
            },
        );
        if !state
            .prepared_scenes
            .iter()
            .any(|record| record.take_id == lost.0)
        {
            state.prepared_scenes.push(PreparedSceneRecord {
                take_id: lost.0.clone(),
                revision: lost.1,
                document: scene("restore/lost", Some(IMAGE_B)),
            });
        }
        state.program = program;
        state.cued = cued;
        journal.record(&state).unwrap();
        let (engine, outcome) = attached(&path);
        let lost_drop = &outcome.dropped[0];
        assert_eq!(lost_drop.take_id, lost.0);
        assert_eq!(lost_drop.was_program, !program_survives);
        assert_eq!(lost_drop.was_cued, !cue_survives);
        assert_eq!(engine.program.is_some(), program_survives);
        assert_eq!(engine.cued.is_some(), cue_survives);
        // The journal it wrote is valid: no state names a dropped take.
        assert!(journal.load().unwrap().is_some());
    }
    cleanup(&path);
}

#[test]
fn every_scene_dropped_still_advances_the_epoch_and_inhibits_output() {
    let path = journal_path("all");
    {
        let (mut first, _) = attached(&path);
        deliver(&mut first, INTER);
        publish(&mut first, scene("restore/one", None));
        publish(&mut first, scene("restore/two", None));
    }
    // One altered font: both scenes declare it, both drop with one reason.
    let inter = gx_asset_plane::content_hash(INTER);
    let entry = path.with_file_name("recovery.json.assets").join(&inter.0);
    let mut changed = INTER.to_vec();
    changed[100] ^= 0x01;
    std::fs::write(&entry, &changed).unwrap();
    let (engine, outcome) = attached(&path);
    assert_eq!(outcome.dropped.len(), 2);
    assert!(outcome
        .dropped
        .iter()
        .all(|scene| scene.reason == outcome.dropped[0].reason));
    assert_eq!(engine.clock.epoch(), Epoch(2));
    assert!(engine.output_inhibited());
    assert!(engine.published.is_empty());
    cleanup(&path);
}

#[test]
fn a_journal_written_before_5_11_starts_with_its_asset_scenes_dropped() {
    let path = journal_path("pre-5-11");
    {
        let (mut first, _) = attached(&path);
        deliver(&mut first, INTER);
        publish(&mut first, scene("restore/legacy", None));
    }
    // A 5.9-era engine journaled the scene but kept the bytes in memory
    // only: the same journal with no store beside it.
    std::fs::remove_dir_all(path.with_file_name("recovery.json.assets")).unwrap();
    let (engine, outcome) = attached(&path);
    assert!(matches!(
        &outcome.dropped[..],
        [scene] if matches!(scene.reason, Refusal::AssetMissing { .. })
    ));
    assert!(engine.output_inhibited());
    cleanup(&path);
}

#[test]
fn a_dropped_take_is_refused_with_its_reason_and_continues_its_revisions_when_republished() {
    let path = journal_path("floor");
    let last = {
        let (mut first, _) = attached(&path);
        deliver(&mut first, INTER);
        deliver(&mut first, IMAGE_B);
        publish(&mut first, scene("restore/floor", Some(IMAGE_B)));
        publish(&mut first, scene("restore/floor", Some(IMAGE_B)))
    };
    assert_eq!(last.1, Revision(2));
    let hash_b = gx_asset_plane::content_hash(IMAGE_B);
    std::fs::remove_file(path.with_file_name("recovery.json.assets").join(&hash_b.0)).unwrap();
    {
        let (mut engine, outcome) = attached(&path);
        assert_eq!(outcome.dropped.len(), 1);
        assert!(matches!(
            cue(&mut engine, &last),
            EngineReply::Refused(Refusal::AssetMissing { hash }) if hash == hash_b
        ));
        // Its bytes are not available to anything published later.
        assert!(matches!(
            engine.publish(scene("restore/other", Some(IMAGE_B))),
            PublishReply::Refused(PublishRefusal::PreparationRefused {
                cause: Refusal::AssetMissing { .. }
            })
        ));
    }
    // The floor is journaled: it survives another restart, and publishing
    // the take again continues from revision 2, never reusing 1 or 2.
    let (mut engine, outcome) = attached(&path);
    assert!(outcome.dropped.is_empty());
    // No journaled scene declares any bytes now, so none were read back: a
    // publisher's preflight finds both missing and sends them.
    assert!(!engine.has_verified_asset(&gx_asset_plane::content_hash(INTER)));
    deliver(&mut engine, INTER);
    deliver(&mut engine, IMAGE_B);
    let again = publish(&mut engine, scene("restore/floor", Some(IMAGE_B)));
    assert_eq!(again.1, Revision(3));
    assert!(matches!(cue(&mut engine, &again), EngineReply::Cued(_)));
    let state = engine.recovery_state();
    assert!(state.revision_floors.is_empty());
    cleanup(&path);
}
