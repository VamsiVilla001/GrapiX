//! Asset synchronisation.
//!
//! The properties under test, in order of how badly getting them wrong hurts:
//!
//! 1. Corrupt bytes never reach the cache. Half a JPEG decodes to *something*, so an
//!    unverified transfer puts visible garbage on air instead of failing.
//! 2. An asset a loaded scene needs cannot be released out from under it.
//! 3. A transfer resumes rather than restarting, and says exactly which chunks are missing.
//! 4. Content addressing actually saves the transfer when the bytes are already here.

use std::path::PathBuf;

use grapix_render_engine::assets::{
    content_path, is_valid_sha256, AssetFetchState, AssetRejection, AssetStore, AssetTransport,
};
use grapix_render_engine::config::AssetConfig;
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A store with its own cache directory, so tests cannot see each other's content.
fn store(name: &str) -> (AssetStore, PathBuf) {
    let directory = std::env::temp_dir().join(format!(
        "grapix-asset-test-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).expect("cache directory");

    let mut config = AssetConfig::default();
    config.cache_directory = directory.to_string_lossy().to_string();
    config.roots = vec![directory.to_string_lossy().to_string()];
    config.max_upload_bytes = 1024 * 1024;
    config.max_chunk_bytes = 64;
    config.disk_cache_budget_bytes = 4096;

    (AssetStore::new(&config), directory)
}

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

#[test]
fn a_digest_must_be_lower_case_hex_of_the_right_length() {
    assert!(is_valid_sha256(&"a".repeat(64)));
    assert!(!is_valid_sha256(&"A".repeat(64)), "upper case would break the cache path");
    assert!(!is_valid_sha256(&"a".repeat(63)));
    assert!(!is_valid_sha256("not a digest"));
}

#[test]
fn the_cache_path_is_sharded_by_the_first_two_characters() {
    let path = content_path(&PathBuf::from("cache"), &format!("ab{}", "c".repeat(62)));
    // A flat directory with a hundred thousand entries is slow to list everywhere.
    assert!(path.to_string_lossy().contains("ab"));
    assert!(path.to_string_lossy().ends_with(&format!("ab{}", "c".repeat(62))));
}

#[test]
fn a_malformed_digest_is_refused_at_registration() {
    let (mut store, _directory) = store("bad-digest");
    let error = store
        .register(
            "asset_1",
            "not-a-digest",
            "image/png",
            10,
            AssetTransport::Upload,
            "",
            0,
        )
        .expect_err("must refuse");
    assert_eq!(error, AssetRejection::MalformedDigest);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

#[test]
fn an_upload_completes_in_chunks_and_is_verified() {
    let (mut store, _directory) = store("upload");
    let bytes: Vec<u8> = (0..150u32).map(|value| (value % 251) as u8).collect();
    let sha = digest(&bytes);

    let record = store
        .register(
            "asset_1",
            &sha,
            "image/png",
            bytes.len() as u64,
            AssetTransport::Upload,
            "",
            0,
        )
        .expect("register");
    assert_eq!(record.fetch_state, AssetFetchState::Absent);

    // Three chunks of 64, 64 and 22.
    let chunks: Vec<&[u8]> = bytes.chunks(64).collect();
    assert_eq!(chunks.len(), 3);

    let first = store
        .accept_chunk("asset_1", &sha, 0, 3, bytes.len() as u64, chunks[0], 0)
        .expect("chunk 0");
    assert_eq!(first.received_chunks, 1);
    assert!(!first.complete);
    // Named explicitly so a resuming client sends exactly what is missing.
    assert_eq!(first.missing_chunks, vec![1, 2]);

    store
        .accept_chunk("asset_1", &sha, 1, 3, bytes.len() as u64, chunks[1], 0)
        .expect("chunk 1");
    let last = store
        .accept_chunk("asset_1", &sha, 2, 3, bytes.len() as u64, chunks[2], 0)
        .expect("chunk 2");

    assert!(last.complete);
    assert!(!last.checksum_mismatch);
    assert_eq!(last.received_bytes, bytes.len() as u64);

    let record = store.record("asset_1").expect("record");
    assert!(record.is_ready());
    let cached = std::fs::read(record.cache_path.as_ref().expect("path")).expect("read back");
    assert_eq!(cached, bytes);
    assert_eq!(store.uploads_completed, 1);
}

#[test]
fn chunks_can_arrive_out_of_order() {
    // A resuming client resends what is missing, which is rarely in order.
    let (mut store, _directory) = store("out-of-order");
    let bytes: Vec<u8> = (0..100u8).collect();
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "application/octet-stream", 100, AssetTransport::Upload, "", 0)
        .expect("register");

    let chunks: Vec<&[u8]> = bytes.chunks(64).collect();
    store
        .accept_chunk("asset_1", &sha, 1, 2, 100, chunks[1], 0)
        .expect("chunk 1 first");
    let done = store
        .accept_chunk("asset_1", &sha, 0, 2, 100, chunks[0], 0)
        .expect("chunk 0 second");

    assert!(done.complete);
    let record = store.record("asset_1").expect("record");
    let cached = std::fs::read(record.cache_path.as_ref().expect("path")).expect("read back");
    // Reassembled in index order, not arrival order.
    assert_eq!(cached, bytes);
}

#[test]
fn corrupt_bytes_never_reach_the_cache() {
    // The property this whole design exists for.
    let (mut store, _directory) = store("corrupt");
    let honest: Vec<u8> = vec![1, 2, 3, 4, 5];
    let sha = digest(&honest);
    store
        .register("asset_1", &sha, "image/png", 5, AssetTransport::Upload, "", 0)
        .expect("register");

    let tampered = vec![9, 9, 9, 9, 9];
    let progress = store
        .accept_chunk("asset_1", &sha, 0, 1, 5, &tampered, 0)
        .expect("the call succeeds; the transfer does not");

    assert!(progress.checksum_mismatch);
    assert!(!progress.complete);

    let record = store.record("asset_1").expect("record");
    assert_eq!(record.fetch_state, AssetFetchState::Failed);
    assert!(record.cache_path.is_none(), "the bytes must not be published");
    assert!(!content_path(&PathBuf::from(record.cache_path.clone().unwrap_or_default()), &sha).exists());
    assert_eq!(store.checksum_failures, 1);
}

#[test]
fn a_chunk_larger_than_the_limit_is_refused() {
    let (mut store, _directory) = store("chunk-limit");
    let bytes = vec![7u8; 200];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 200, AssetTransport::Upload, "", 0)
        .expect("register");

    // The chunk limit is what bounds the memory one message can consume.
    let error = store
        .accept_chunk("asset_1", &sha, 0, 1, 200, &bytes, 0)
        .expect_err("must refuse");
    assert_eq!(error, AssetRejection::ChunkTooLarge);
}

#[test]
fn an_asset_larger_than_the_limit_is_refused_at_registration() {
    let (mut store, _directory) = store("size-limit");
    let error = store
        .register(
            "asset_1",
            &"a".repeat(64),
            "video/mp4",
            10 * 1024 * 1024,
            AssetTransport::Upload,
            "",
            0,
        )
        .expect_err("must refuse");
    assert_eq!(error, AssetRejection::TooLarge);
}

#[test]
fn uploading_an_unregistered_asset_is_refused() {
    let (mut store, _directory) = store("unregistered");
    let bytes = vec![1u8, 2, 3];
    let error = store
        .accept_chunk("ghost", &digest(&bytes), 0, 1, 3, &bytes, 0)
        .expect_err("must refuse");
    // Otherwise a client could push bytes the engine has no record of and no size limit for.
    assert_eq!(error, AssetRejection::UnknownAsset);
}

#[test]
fn a_transfer_whose_shape_changes_mid_flight_is_restarted_not_reassembled() {
    let (mut store, _directory) = store("shape-change");
    let bytes = vec![3u8; 100];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 100, AssetTransport::Upload, "", 0)
        .expect("register");

    store
        .accept_chunk("asset_1", &sha, 0, 2, 100, &bytes[..50], 0)
        .expect("chunk 0");

    // A different chunk count cannot be reconciled with what has already arrived.
    let error = store
        .accept_chunk("asset_1", &sha, 1, 4, 100, &bytes[50..], 0)
        .expect_err("must refuse");
    assert_eq!(error, AssetRejection::SessionMismatch);
    assert!(store.upload_in_progress("asset_1").is_none(), "the session is discarded");
}

#[test]
fn a_retransmitted_chunk_is_not_counted_twice() {
    let (mut store, _directory) = store("retransmit");
    let bytes = vec![5u8; 100];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 100, AssetTransport::Upload, "", 0)
        .expect("register");

    store
        .accept_chunk("asset_1", &sha, 0, 2, 100, &bytes[..50], 0)
        .expect("chunk 0");
    let again = store
        .accept_chunk("asset_1", &sha, 0, 2, 100, &bytes[..50], 0)
        .expect("chunk 0 again");

    assert_eq!(again.received_chunks, 1);
    assert_eq!(again.received_bytes, 50);
}

#[test]
fn identical_content_is_not_transferred_twice() {
    // What content addressing buys: a logo shared by twenty scenes crosses once.
    let (mut store, _directory) = store("dedupe");
    let bytes = vec![42u8; 30];
    let sha = digest(&bytes);

    store
        .register("asset_1", &sha, "image/png", 30, AssetTransport::Upload, "", 0)
        .expect("register");
    store
        .accept_chunk("asset_1", &sha, 0, 1, 30, &bytes, 0)
        .expect("upload");

    // A different asset id, the same bytes.
    let second = store
        .register("asset_2", &sha, "image/png", 30, AssetTransport::Upload, "", 0)
        .expect("register");
    assert!(second.is_ready(), "already cached, so nothing to transfer");
    assert_eq!(store.deduplicated_uploads, 1);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[test]
fn validation_detects_content_that_changed_after_it_was_cached() {
    let (mut store, _directory) = store("validate");
    let bytes = vec![8u8; 40];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 40, AssetTransport::Upload, "", 0)
        .expect("register");
    store
        .accept_chunk("asset_1", &sha, 0, 1, 40, &bytes, 0)
        .expect("upload");

    let good = store.validate("asset_1").expect("validate");
    assert!(good.present && good.digest_matches);

    // Something replaced the file. A content-addressed cache's whole promise is that the
    // name matches the bytes, so this must be caught rather than rendered.
    let path = store.record("asset_1").unwrap().cache_path.clone().unwrap();
    std::fs::write(&path, vec![0u8; 40]).expect("tamper");

    let bad = store.validate("asset_1").expect("validate");
    assert!(bad.present);
    assert!(!bad.digest_matches);
    assert_eq!(
        store.record("asset_1").unwrap().fetch_state,
        AssetFetchState::Failed
    );
}

#[test]
fn validating_an_asset_with_no_bytes_says_so_rather_than_failing() {
    let (mut store, _directory) = store("validate-absent");
    let bytes = vec![1u8; 10];
    store
        .register("asset_1", &digest(&bytes), "image/png", 10, AssetTransport::Upload, "", 0)
        .expect("register");

    let validation = store.validate("asset_1").expect("validate");
    assert!(!validation.present);
    assert!(validation.message.contains("no bytes"));
}

// ---------------------------------------------------------------------------
// References and release
// ---------------------------------------------------------------------------

#[test]
fn an_asset_a_scene_needs_cannot_be_released() {
    let (mut store, _directory) = store("references");
    let bytes = vec![2u8; 20];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 20, AssetTransport::Upload, "", 0)
        .expect("register");
    store
        .accept_chunk("asset_1", &sha, 0, 1, 20, &bytes, 0)
        .expect("upload");

    let missing = store.reference("scene_1", &["asset_1".to_string()], 0);
    assert!(missing.is_empty(), "it is cached, so nothing is missing");
    assert_eq!(store.record("asset_1").unwrap().reference_count(), 1);

    let (released, refused) = store.release(&["asset_1".to_string()], false);
    assert!(released.is_empty());
    assert_eq!(refused.len(), 1);
    // Evicting it would leave a hole in a loaded scene.
    assert!(matches!(refused[0].1, AssetRejection::StillReferenced(_)));
    assert!(refused[0].1.message().contains("scene_1"));

    // Forcing it is an operator decision the store allows but does not take on itself.
    let (forced, still_refused) = store.release(&["asset_1".to_string()], true);
    assert_eq!(forced, vec!["asset_1".to_string()]);
    assert!(still_refused.is_empty());
    assert!(store.record("asset_1").is_none());
}

#[test]
fn unloading_a_scene_releases_its_hold_on_assets() {
    let (mut store, _directory) = store("dereference");
    let bytes = vec![4u8; 20];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 20, AssetTransport::Upload, "", 0)
        .expect("register");
    store
        .accept_chunk("asset_1", &sha, 0, 1, 20, &bytes, 0)
        .expect("upload");
    store.reference("scene_1", &["asset_1".to_string()], 0);

    store.dereference_scene("scene_1");
    assert_eq!(store.record("asset_1").unwrap().reference_count(), 0);

    let (released, refused) = store.release(&["asset_1".to_string()], false);
    assert_eq!(released, vec!["asset_1".to_string()]);
    assert!(refused.is_empty());
}

#[test]
fn shared_content_survives_releasing_one_of_its_holders() {
    let (mut store, _directory) = store("shared-content");
    let bytes = vec![6u8; 25];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 25, AssetTransport::Upload, "", 0)
        .expect("register");
    store
        .accept_chunk("asset_1", &sha, 0, 1, 25, &bytes, 0)
        .expect("upload");
    store
        .register("asset_2", &sha, "image/png", 25, AssetTransport::Upload, "", 0)
        .expect("register the same content under a second id");

    let path = store.record("asset_2").unwrap().cache_path.clone().unwrap();
    store.release(&["asset_1".to_string()], false);

    // The bytes stay: another asset is the same content. Deleting them would break the
    // second asset for a reason no one could see.
    assert!(std::path::Path::new(&path).exists());
    assert!(store.record("asset_2").unwrap().is_ready());
}

#[test]
fn a_scene_reports_the_assets_it_declares_but_does_not_have() {
    let (mut store, _directory) = store("missing-refs");
    let missing = store.reference(
        "scene_1",
        &["absent_1".to_string(), "absent_2".to_string()],
        0,
    );
    // This is what gates preparation.
    assert_eq!(missing.len(), 2);
}

#[test]
fn declared_asset_ids_are_read_from_the_scene_document() {
    let scene = serde_json::json!({
        "id": "scene_1",
        "assets": [
            { "assetId": "asset_b", "name": "B" },
            { "assetId": "asset_a", "name": "A" },
            { "assetId": "asset_a", "name": "A again" },
            { "name": "no id at all" }
        ]
    });

    // Sorted and deduplicated, so a document listing an asset twice does not double-count.
    assert_eq!(
        AssetStore::declared_asset_ids(&scene),
        vec!["asset_a".to_string(), "asset_b".to_string()]
    );
}

// ---------------------------------------------------------------------------
// Paths and fetching
// ---------------------------------------------------------------------------

#[test]
fn an_engine_local_asset_outside_every_root_is_refused() {
    let (mut store, _directory) = store("path-escape");
    // The boundary that stops a remote client naming /etc/passwd.
    for candidate in ["../secrets.png", "/etc/passwd", "C:\\Windows\\win.ini"] {
        let error = store
            .register(
                "asset_1",
                &"b".repeat(64),
                "image/png",
                10,
                AssetTransport::EngineLocal,
                candidate,
                0,
            )
            .expect_err("must refuse");
        assert!(
            matches!(error, AssetRejection::PathRefused(_)),
            "{candidate} produced {error:?}"
        );
    }
}

#[test]
fn an_engine_local_asset_inside_a_root_resolves() {
    let (mut store, directory) = store("path-inside");
    let bytes = vec![11u8; 12];
    std::fs::write(directory.join("logo.png"), &bytes).expect("write");

    let record = store
        .register(
            "asset_1",
            &digest(&bytes),
            "image/png",
            12,
            AssetTransport::EngineLocal,
            "logo.png",
            0,
        )
        .expect("register");
    assert!(record.is_ready());
    assert!(record.cache_path.is_some());
}

#[test]
fn http_fetching_is_refused_when_it_is_switched_off() {
    let (mut store, _directory) = store("http-off");
    let error = store
        .register(
            "asset_1",
            &"c".repeat(64),
            "image/png",
            10,
            AssetTransport::Http,
            "https://cdn.example.com/logo.png",
            0,
        )
        .expect_err("must refuse");

    match error {
        // An engine that fetches arbitrary URLs is a proxy.
        AssetRejection::FetchRefused(message) => {
            assert!(message.contains("allow-http-fetch"), "{message}");
        }
        other => panic!("expected a fetch refusal, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

#[test]
fn eviction_candidates_are_unreferenced_and_coldest_first() {
    let (mut store, _directory) = store("eviction");

    // The budget in this store is 4096 bytes; three 2000-byte assets exceed it.
    for (index, id) in ["asset_cold", "asset_warm", "asset_hot"].iter().enumerate() {
        let bytes = vec![index as u8; 2000];
        let sha = digest(&bytes);
        store
            .register(id, &sha, "image/png", 2000, AssetTransport::Upload, "", 0)
            .expect("register");
        for (chunk_index, chunk) in bytes.chunks(64).enumerate() {
            store
                .accept_chunk(
                    id,
                    &sha,
                    chunk_index as u32,
                    32,
                    2000,
                    chunk,
                    // Ascending timestamps, so "cold" really is the least recently used.
                    (index as u64 + 1) * 1000,
                )
                .expect("chunk");
        }
    }

    // The hot one is in use, so it must never be offered for eviction however cold the
    // budget pressure is.
    store.reference("scene_1", &["asset_hot".to_string()], 4000);

    let candidates = store.eviction_candidates();
    assert!(!candidates.contains(&"asset_hot".to_string()), "{candidates:?}");
    assert_eq!(candidates.first(), Some(&"asset_cold".to_string()), "{candidates:?}");
}

#[test]
fn nothing_is_offered_for_eviction_while_under_budget() {
    let (mut store, _directory) = store("under-budget");
    let bytes = vec![1u8; 60];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 60, AssetTransport::Upload, "", 0)
        .expect("register");
    store
        .accept_chunk("asset_1", &sha, 0, 1, 60, &bytes, 0)
        .expect("upload");

    assert!(store.eviction_candidates().is_empty());
}

#[test]
fn the_summary_reports_transfers_in_flight() {
    let (mut store, _directory) = store("summary");
    let bytes = vec![3u8; 100];
    let sha = digest(&bytes);
    store
        .register("asset_1", &sha, "image/png", 100, AssetTransport::Upload, "", 0)
        .expect("register");
    store
        .accept_chunk("asset_1", &sha, 0, 2, 100, &bytes[..50], 0)
        .expect("chunk 0");

    let summary = store.summary();
    // A stalled transfer has to be visible in status, or it looks like a hung engine.
    assert_eq!(summary["uploadsInProgress"][0]["assetId"], "asset_1");
    assert_eq!(summary["uploadsInProgress"][0]["receivedChunks"], 1);
    assert_eq!(summary["uploadsInProgress"][0]["chunkCount"], 2);
    assert_eq!(summary["registeredAssets"], 1);
    assert_eq!(summary["readyAssets"], 0);
}
