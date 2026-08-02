//! Configuration precedence and the security boundary.
//!
//! Two things are being pinned down here.
//!
//! First, that one binary really does cover every deployment mode, and that the
//! documented precedence — CLI > environment > TOML > default — is what actually
//! happens. A layered configuration nobody can predict is worse than no layering.
//!
//! Second, the path-restriction rule, which is the single most important check in
//! the engine: a remote client must never be able to name an arbitrary filesystem
//! path.

use std::collections::BTreeMap;
use std::fs;

use grapix_render_engine::config::{self, CliOptions, EngineConfig, DEFAULT_PORT};
use grapix_render_engine::protocol::{SceneDomain, SceneRef};
use grapix_render_engine::security::{
    check_fetch_url, check_path_syntax, resolve_asset_path, tokens_match, AuditEntry, AuditLog,
    MessageDeduplicator, PathRejection, RateLimiter, SequenceTracker, SequenceVerdict,
};

const VALID_TOKEN: &str = "0123456789abcdef0123456789abcdef";

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

#[test]
fn built_in_defaults_are_a_safe_local_engine() {
    let mut engine_config = EngineConfig::default();
    let warnings = engine_config.validate().expect("defaults must validate");

    // Loopback, headless, and the full 50,000 logical limit.
    assert_eq!(engine_config.network.bind_address, "127.0.0.1");
    assert_eq!(engine_config.network.websocket_port, DEFAULT_PORT);
    assert!(engine_config.gpu.headless);
    assert!(!engine_config.network.is_remote_reachable());
    assert_eq!(engine_config.stage.max_logical_canvas_width, 50_000.0);
    assert_eq!(engine_config.stage.max_logical_canvas_height, 50_000.0);

    // Only adapters that need no vendor SDK and cannot reach air. `virtual` is in
    // the default set on purpose: an operator should always be able to confirm a take
    // renders, and it is headless by construction.
    assert_eq!(
        engine_config.outputs.enabled_adapters,
        vec![
            "null".to_string(),
            "virtual".to_string(),
            "recording".to_string()
        ]
    );
    assert_eq!(engine_config.outputs.ndi_frame_pool_slots, 4);
    for adapter in &engine_config.outputs.enabled_adapters {
        assert!(
            !grapix_render_engine::outputs::is_live_adapter(adapter),
            "{adapter} is live and must never be enabled by default"
        );
    }

    // Nothing alarming about a loopback default.
    assert!(warnings.is_empty(), "{warnings:?}");
}

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

#[test]
fn cli_beats_environment_beats_file_beats_default() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("engine.toml");
    fs::write(
        &path,
        r#"
[network]
websocket-port = 5100
bind-address = "127.0.0.1"

[identity]
name = "From file"

[assets]
roots = ["assets"]
"#,
    )
    .expect("write config");

    // File only.
    let (from_file, _) = config::load(
        &CliOptions {
            config_path: Some(path.clone()),
            ..Default::default()
        },
        &BTreeMap::new(),
    )
    .expect("load from file");
    assert_eq!(from_file.network.websocket_port, 5100);
    assert_eq!(from_file.identity.name, "From file");

    // Environment overrides the file.
    let (from_env, _) = config::load(
        &CliOptions {
            config_path: Some(path.clone()),
            ..Default::default()
        },
        &env(&[
            ("GRAPIX_ENGINE_PORT", "5200"),
            ("GRAPIX_ENGINE_NAME", "From environment"),
        ]),
    )
    .expect("load with env");
    assert_eq!(from_env.network.websocket_port, 5200);
    assert_eq!(from_env.identity.name, "From environment");

    // CLI overrides both.
    let (from_cli, _) = config::load(
        &CliOptions {
            config_path: Some(path),
            port: Some(5300),
            name: Some("From CLI".to_string()),
            ..Default::default()
        },
        &env(&[
            ("GRAPIX_ENGINE_PORT", "5200"),
            ("GRAPIX_ENGINE_NAME", "From environment"),
        ]),
    )
    .expect("load with cli");
    assert_eq!(from_cli.network.websocket_port, 5300);
    assert_eq!(from_cli.identity.name, "From CLI");
}

#[test]
fn absent_keys_take_their_documented_default() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("minimal.toml");
    // Deliberately nearly empty.
    fs::write(&path, "[identity]\nname = \"Minimal\"\n").expect("write config");

    let loaded = EngineConfig::from_file(&path).expect("load minimal config");

    assert_eq!(loaded.identity.name, "Minimal");
    assert_eq!(loaded.network.websocket_port, DEFAULT_PORT);
    assert_eq!(loaded.stage.default_tile_width, 1024);
    assert_eq!(loaded.stage.default_overscan, 32);
    assert_eq!(loaded.preview.max_pixels, 1920 * 1080);
    assert_eq!(loaded.source_path.as_deref(), Some(path.as_path()));
}

#[test]
fn the_bundled_engine_toml_loads_and_validates() {
    // The shipped example must actually work, or it is documentation rather than
    // configuration.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("engine.toml");
    let mut loaded = EngineConfig::from_file(&path).expect("bundled engine.toml must parse");

    let warnings = loaded
        .validate()
        .expect("bundled engine.toml must validate");
    assert_eq!(loaded.network.websocket_port, DEFAULT_PORT);
    assert_eq!(loaded.stage.max_logical_canvas_width, 50_000.0);
    assert!(loaded.gpu.headless);
    // A loopback development profile should raise nothing.
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn a_bad_config_file_names_the_problem() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("broken.toml");
    fs::write(&path, "[network\nwebsocket-port = ").expect("write config");

    let error = EngineConfig::from_file(&path).expect_err("must reject malformed TOML");
    assert!(error.to_string().contains("failed to parse"));
}

#[test]
fn unknown_cli_arguments_are_a_hard_error() {
    // A typo in a deployment script must not silently start an engine with the
    // wrong settings.
    let error = config::parse_cli(&["--prot".to_string(), "4300".to_string()])
        .expect_err("must reject an unknown flag");
    assert!(error.to_string().contains("unknown argument"));

    let missing =
        config::parse_cli(&["--port".to_string()]).expect_err("must reject a flag with no value");
    assert!(missing.to_string().contains("requires a value"));

    let unparseable = config::parse_cli(&["--port".to_string(), "http".to_string()])
        .expect_err("must reject a non-numeric port");
    assert!(unparseable.to_string().contains("--port"));
}

#[test]
fn cli_parses_every_documented_flag() {
    let cli = config::parse_cli(&[
        "--config".to_string(),
        "engine.toml".to_string(),
        "--bind".to_string(),
        "0.0.0.0".to_string(),
        "--port".to_string(),
        "4301".to_string(),
        "--engine-id".to_string(),
        "node_left".to_string(),
        "--name".to_string(),
        "Left node".to_string(),
        "--headless".to_string(),
        "true".to_string(),
        "--preferred-gpu".to_string(),
        "RTX".to_string(),
        "--preferred-backend".to_string(),
        "vulkan".to_string(),
        "--token-file".to_string(),
        "engine.token".to_string(),
        "--ipc".to_string(),
        "pipe".to_string(),
        "--tile-size".to_string(),
        "2048".to_string(),
        "--log-level".to_string(),
        "debug".to_string(),
        "--print-config".to_string(),
    ])
    .expect("parse");

    assert_eq!(cli.bind.as_deref(), Some("0.0.0.0"));
    assert_eq!(cli.port, Some(4301));
    assert_eq!(cli.engine_id.as_deref(), Some("node_left"));
    assert_eq!(cli.headless, Some(true));
    assert_eq!(cli.preferred_gpu.as_deref(), Some("RTX"));
    assert_eq!(cli.tile_size, Some(2048));
    assert!(cli.print_config);
}

#[test]
fn boolean_flags_and_env_accept_the_usual_spellings() {
    for value in ["true", "1", "yes", "on"] {
        let cli = config::parse_cli(&["--headless".to_string(), value.to_string()]).expect("parse");
        assert_eq!(cli.headless, Some(true), "{value} should be true");
    }
    for value in ["false", "0", "no", "off"] {
        let cli = config::parse_cli(&["--headless".to_string(), value.to_string()]).expect("parse");
        assert_eq!(cli.headless, Some(false), "{value} should be false");
    }

    assert!(config::parse_cli(&["--headless".to_string(), "maybe".to_string()]).is_err());
}

#[test]
fn env_asset_roots_are_semicolon_separated() {
    let mut engine_config = EngineConfig::default();
    engine_config
        .apply_env(&env(&[(
            "GRAPIX_ENGINE_ASSET_ROOTS",
            "primary; secondary ;;third",
        )]))
        .expect("apply env");

    assert_eq!(
        engine_config.assets.roots,
        vec![
            "primary".to_string(),
            "secondary".to_string(),
            "third".to_string()
        ]
    );
}

#[test]
fn a_bad_env_value_is_reported_rather_than_ignored() {
    let mut engine_config = EngineConfig::default();
    let error = engine_config
        .apply_env(&env(&[("GRAPIX_ENGINE_PORT", "not-a-port")]))
        .expect_err("must reject a non-numeric port");
    assert!(error.to_string().contains("PORT"));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[test]
fn a_network_reachable_engine_without_a_token_refuses_to_start() {
    let mut engine_config = EngineConfig::default();
    engine_config.network.bind_address = "0.0.0.0".to_string();
    engine_config.auth.token = None;
    engine_config.auth.token_file = None;

    // Silently exposing an unauthenticated renderer to a venue network is the one
    // mistake no default may permit, so this is an error rather than a warning.
    let error = engine_config
        .validate()
        .expect_err("must refuse an unauthenticated remote bind");
    assert!(error.to_string().contains("no auth token is configured"));
}

#[test]
fn a_remote_bind_forces_authentication_on() {
    let mut engine_config = EngineConfig::default();
    engine_config.network.bind_address = "10.0.0.5".to_string();
    engine_config.auth.required = false;
    engine_config.auth.token = Some(VALID_TOKEN.to_string());

    let warnings = engine_config.validate().expect("validate");

    assert!(
        engine_config.auth.required,
        "a remote bind must force auth on"
    );
    // TLS and an empty allowlist are warnings: they are real risks but there are
    // legitimate deployments (a proxy in front, a trusted VLAN) where they are fine.
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("without TLS")));
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("client-allowlist is empty")));
}

#[test]
fn loopback_variants_are_all_recognised_as_local() {
    for address in ["127.0.0.1", "localhost", "::1"] {
        let mut engine_config = EngineConfig::default();
        engine_config.network.bind_address = address.to_string();
        assert!(
            !engine_config.network.is_remote_reachable(),
            "{address} should be local"
        );
        // And therefore needs no token.
        assert!(engine_config.validate().is_ok());
    }
}

#[test]
fn out_of_range_values_are_clamped_rather_than_propagated() {
    let mut engine_config = EngineConfig::default();
    engine_config.stage.max_logical_canvas_width = 500_000.0;
    engine_config.stage.default_tile_width = 99_999;
    engine_config.stage.default_tile_height = 4;
    engine_config.stage.default_overscan = 9_999;
    engine_config.preview.default_quality = 250;
    engine_config.security.max_message_bytes = 1;

    engine_config.validate().expect("validate");

    assert_eq!(engine_config.stage.max_logical_canvas_width, 50_000.0);
    assert_eq!(engine_config.stage.default_tile_width, 8192);
    assert_eq!(engine_config.stage.default_tile_height, 64);
    assert_eq!(engine_config.stage.default_overscan, 1024);
    assert_eq!(engine_config.preview.default_quality, 100);
    assert_eq!(engine_config.security.max_message_bytes, 4 * 1024);
}

#[test]
fn no_asset_roots_is_an_error_because_no_asset_could_resolve() {
    let mut engine_config = EngineConfig::default();
    engine_config.assets.roots.clear();

    let error = engine_config
        .validate()
        .expect_err("must refuse empty roots");
    assert!(error.to_string().contains("at least one directory"));
}

#[test]
fn an_upload_chunk_can_never_exceed_the_message_limit() {
    let mut engine_config = EngineConfig::default();
    engine_config.security.max_message_bytes = 64 * 1024;
    engine_config.assets.max_chunk_bytes = 16 * 1024 * 1024;

    engine_config.validate().expect("validate");
    // A chunk larger than a message could never arrive.
    assert_eq!(engine_config.assets.max_chunk_bytes, 64 * 1024);
}

#[test]
fn http_fetching_with_an_empty_allowlist_warns() {
    let mut engine_config = EngineConfig::default();
    engine_config.assets.allow_http_fetch = true;
    engine_config.assets.http_allowlist.clear();

    let warnings = engine_config.validate().expect("validate");
    assert!(warnings
        .iter()
        .any(|warning| warning.contains("fetch any URL")));
}

#[test]
fn declared_but_unimplemented_adapters_warn() {
    let mut engine_config = EngineConfig::default();
    engine_config.outputs.enabled_adapters = vec![
        "null".to_string(),
        "decklink".to_string(),
        "aja".to_string(),
    ];

    let warnings = engine_config.validate().expect("validate");
    assert!(warnings.iter().any(|w| w.contains("decklink")));
    assert!(warnings.iter().any(|w| w.contains("aja")));
    assert!(warnings
        .iter()
        .any(|w| w.contains("report itself unavailable")));
}

#[test]
fn ndi_pool_slots_stay_within_the_fixed_handoff_bound() {
    let mut engine_config = EngineConfig::default();
    engine_config.outputs.ndi_frame_pool_slots = 1;
    engine_config.validate().expect("validate");
    assert_eq!(engine_config.outputs.ndi_frame_pool_slots, 3);

    engine_config.outputs.ndi_frame_pool_slots = 9;
    engine_config.validate().expect("validate");
    assert_eq!(engine_config.outputs.ndi_frame_pool_slots, 4);
}

#[test]
fn tokens_are_validated_for_length_and_shape() {
    let mut engine_config = EngineConfig::default();

    engine_config.auth.token = Some("short".to_string());
    assert!(engine_config.resolve_token().is_err());

    engine_config.auth.token = Some("has whitespace in the middle".to_string());
    assert!(engine_config.resolve_token().is_err());

    engine_config.auth.token = Some(VALID_TOKEN.to_string());
    assert_eq!(
        engine_config.resolve_token().expect("resolve"),
        Some(VALID_TOKEN.to_string())
    );
}

#[test]
fn a_token_file_is_read_and_trimmed() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("engine.token");
    fs::write(&path, format!("{VALID_TOKEN}\n")).expect("write token");

    let mut engine_config = EngineConfig::default();
    engine_config.auth.token_file = Some(path.to_string_lossy().to_string());

    assert_eq!(
        engine_config.resolve_token().expect("resolve"),
        Some(VALID_TOKEN.to_string())
    );
}

#[test]
fn the_effective_config_round_trips_through_toml() {
    // --print-config exists so an operator can confirm what precedence produced.
    // It is only useful if the output is itself loadable.
    let mut original = EngineConfig::default();
    original.identity.name = "Round trip".to_string();
    original.stage.default_tile_width = 2048;
    original.stage.default_tile_height = 2048;

    let rendered = original.to_toml();
    let reparsed: EngineConfig = toml::from_str(&rendered).expect("printed config must reparse");

    assert_eq!(reparsed.identity.name, "Round trip");
    assert_eq!(reparsed.stage.default_tile_width, 2048);
    assert_eq!(
        reparsed.network.websocket_port,
        original.network.websocket_port
    );
}

// ---------------------------------------------------------------------------
// Path restriction
// ---------------------------------------------------------------------------

#[test]
fn a_relative_traversal_free_path_passes_the_syntax_check() {
    assert!(check_path_syntax("images/logo.png").is_ok());
    assert!(check_path_syntax("nested/deeper/file.mp4").is_ok());
    assert!(check_path_syntax("file.png").is_ok());
}

#[test]
fn a_remote_client_can_never_name_an_arbitrary_filesystem_path() {
    let cases: &[(&str, PathRejection)] = &[
        ("/etc/passwd", PathRejection::Absolute),
        ("\\Windows\\System32\\config", PathRejection::Absolute),
        ("../../etc/passwd", PathRejection::ParentTraversal),
        ("images/../../secret", PathRejection::ParentTraversal),
        ("images\\..\\..\\secret", PathRejection::ParentTraversal),
        ("file:///etc/passwd", PathRejection::UrlScheme),
        ("http://evil/payload", PathRejection::UrlScheme),
        ("C:/Windows/System32", PathRejection::UrlScheme),
        ("", PathRejection::Empty),
        ("   ", PathRejection::Empty),
        ("images/logo\0.png", PathRejection::NullByte),
    ];

    for (candidate, expected) in cases {
        let rejection =
            check_path_syntax(candidate).expect_err(&format!("{candidate:?} must be rejected"));
        assert_eq!(rejection, *expected, "wrong reason for {candidate:?}");
        // Every rejection has an operator-readable explanation.
        assert!(!rejection.message().is_empty());
    }
}

#[test]
fn a_path_inside_a_configured_root_resolves() {
    let directory = tempfile::tempdir().expect("tempdir");
    let root = directory.path().join("assets");
    fs::create_dir_all(root.join("images")).expect("create dirs");
    fs::write(root.join("images/logo.png"), b"png").expect("write asset");

    let resolved = resolve_asset_path("images/logo.png", &[root.clone()]).expect("resolve");

    assert!(resolved.ends_with("logo.png"));
    assert!(resolved.starts_with(root.canonicalize().expect("canonicalise root")));
}

#[test]
fn resolution_refuses_paths_outside_every_root() {
    let directory = tempfile::tempdir().expect("tempdir");
    let root = directory.path().join("assets");
    fs::create_dir_all(&root).expect("create root");

    assert_eq!(
        resolve_asset_path("../outside.png", &[root.clone()]),
        Err(PathRejection::ParentTraversal)
    );
    assert_eq!(
        resolve_asset_path("does-not-exist.png", &[root]),
        Err(PathRejection::NotFound)
    );
    assert_eq!(
        resolve_asset_path("anything.png", &[]),
        Err(PathRejection::NoRootsConfigured)
    );
}

#[test]
fn resolution_searches_every_configured_root() {
    let directory = tempfile::tempdir().expect("tempdir");
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    fs::create_dir_all(&first).expect("create first");
    fs::create_dir_all(&second).expect("create second");
    fs::write(second.join("only-here.png"), b"png").expect("write asset");

    let resolved = resolve_asset_path("only-here.png", &[first, second.clone()]).expect("resolve");
    assert!(resolved.starts_with(second.canonicalize().expect("canonicalise")));
}

#[test]
fn http_fetching_is_off_unless_enabled_and_allowlisted() {
    let mut engine_config = EngineConfig::default();

    // Off by default: an engine that fetches arbitrary URLs is a proxy.
    assert!(check_fetch_url("https://cdn.example.com/logo.png", &engine_config).is_err());

    engine_config.assets.allow_http_fetch = true;
    let error = check_fetch_url("https://cdn.example.com/logo.png", &engine_config)
        .expect_err("empty allowlist must refuse");
    assert!(error.contains("allowlisted"));

    engine_config.assets.http_allowlist = vec!["cdn.example.com".to_string()];
    assert!(check_fetch_url("https://cdn.example.com/logo.png", &engine_config).is_ok());
    // A different host is still refused.
    assert!(check_fetch_url("https://evil.example.com/x.png", &engine_config).is_err());
    // And so is a non-HTTP scheme.
    assert!(check_fetch_url("ftp://cdn.example.com/x.png", &engine_config).is_err());
}

// ---------------------------------------------------------------------------
// Rate limiting, dedupe, ordering
// ---------------------------------------------------------------------------

#[test]
fn the_rate_limiter_allows_a_burst_and_then_throttles() {
    let mut limiter = RateLimiter::new(3, 1, 0);

    assert!(limiter.try_consume(0, 1.0));
    assert!(limiter.try_consume(0, 1.0));
    assert!(limiter.try_consume(0, 1.0));
    // Burst exhausted.
    assert!(!limiter.try_consume(0, 1.0));
    assert_eq!(limiter.retry_after_ms(0, 1.0), 1_000);

    // One token back after a second.
    assert!(limiter.try_consume(1_000, 1.0));
    assert!(!limiter.try_consume(1_000, 1.0));
}

#[test]
fn the_rate_limiter_never_exceeds_its_capacity() {
    let mut limiter = RateLimiter::new(2, 10, 0);
    limiter.try_consume(0, 2.0);
    // A minute of refill still cannot exceed the bucket.
    limiter.try_consume(60_000, 0.0);
    assert!(limiter.available() <= 2.0);
}

#[test]
fn duplicate_message_ids_are_recognised_and_bounded() {
    let mut dedupe = MessageDeduplicator::new(3, 0);

    assert!(!dedupe.check("m-1", 0));
    assert!(dedupe.check("m-1", 10));
    assert!(!dedupe.check("m-2", 10));

    // Capacity is a hard ceiling, so memory is predictable regardless of traffic.
    for index in 3u64..=6 {
        dedupe.check(&format!("m-{index}"), index);
    }
    assert!(dedupe.len() <= 3);
    // The oldest was forgotten.
    assert!(!dedupe.check("m-1", 100));
}

#[test]
fn the_dedupe_window_expires_by_time() {
    let mut dedupe = MessageDeduplicator::new(100, 1_000);

    dedupe.check("m-1", 0);
    assert!(dedupe.check("m-1", 500));
    // Past the TTL the id is forgotten.
    assert!(!dedupe.check("m-1", 2_000));
}

#[test]
fn in_sequence_commands_are_accepted_in_order() {
    let mut tracker = SequenceTracker::new(8);

    assert_eq!(tracker.offer(1), (SequenceVerdict::Accept, vec![1]));
    assert_eq!(tracker.offer(2), (SequenceVerdict::Accept, vec![2]));
    assert_eq!(tracker.expected(), 3);
}

#[test]
fn out_of_order_commands_park_and_release_together() {
    let mut tracker = SequenceTracker::new(8);

    assert_eq!(tracker.offer(3).0, SequenceVerdict::Future);
    assert_eq!(tracker.offer(2).0, SequenceVerdict::Future);
    assert_eq!(tracker.parked_count(), 2);

    // Command 1 arrives and unblocks 2 and 3 in one pass. Applying Take before the
    // Cue it depends on would put the wrong thing on air.
    let (verdict, released) = tracker.offer(1);
    assert_eq!(verdict, SequenceVerdict::Accept);
    assert_eq!(released, vec![1, 2, 3]);
    assert_eq!(tracker.expected(), 4);
    assert_eq!(tracker.parked_count(), 0);
}

#[test]
fn a_replayed_sequence_is_a_duplicate() {
    let mut tracker = SequenceTracker::new(8);
    tracker.offer(1);
    tracker.offer(2);

    assert_eq!(tracker.offer(1).0, SequenceVerdict::Duplicate);
    assert_eq!(tracker.offer(2).0, SequenceVerdict::Duplicate);
}

#[test]
fn too_many_parked_commands_is_a_gap_not_an_unbounded_buffer() {
    let mut tracker = SequenceTracker::new(2);

    tracker.offer(5);
    tracker.offer(6);
    let (verdict, released) = tracker.offer(7);

    assert_eq!(verdict, SequenceVerdict::Gap);
    assert!(released.is_empty());
    assert_eq!(tracker.gaps(), 1);
    // The parked set is dropped: guessing is never an option.
    assert_eq!(tracker.parked_count(), 0);
}

#[test]
fn sequence_zero_is_always_a_gap() {
    let tracker = SequenceTracker::new(8);
    assert_eq!(tracker.classify(0), SequenceVerdict::Gap);
}

// ---------------------------------------------------------------------------
// Token comparison and audit
// ---------------------------------------------------------------------------

#[test]
fn token_comparison_is_length_independent_and_correct() {
    assert!(tokens_match(VALID_TOKEN, VALID_TOKEN));
    assert!(!tokens_match(VALID_TOKEN, "wrong"));
    assert!(!tokens_match(VALID_TOKEN, ""));
    assert!(!tokens_match("", VALID_TOKEN));
    assert!(tokens_match("", ""));

    // A correct prefix must not compare equal, and must not leak how much matched.
    assert!(!tokens_match(
        VALID_TOKEN,
        &VALID_TOKEN[..VALID_TOKEN.len() - 1]
    ));
    assert!(!tokens_match(VALID_TOKEN, &format!("{VALID_TOKEN}x")));
}

#[test]
fn the_audit_log_records_overrides_attributably() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("audit.jsonl");
    let mut log = AuditLog::new(Some(path.clone()), 16);

    log.record(AuditEntry {
        at_ms: 1_700_000_000_000,
        client_id: "playout-1".to_string(),
        message_type: "playout.takeOnline".to_string(),
        scene_ref: Some(SceneRef {
            project_id: "project_x".to_string(),
            domain: SceneDomain::Published,
            scene_id: "scene_1".to_string(),
            revision: 1,
        }),
        outcome: "accepted".to_string(),
        // An operator taking an unprepared scene online is a legitimate decision,
        // but it has to be an attributable one.
        override_reason: Some("operator overrode 2 take blockers".to_string()),
    });

    assert_eq!(log.len(), 1);

    let written = fs::read_to_string(&path).expect("audit file must exist");
    assert!(written.contains("playout.takeOnline"));
    assert!(written.contains("operator overrode"));
    assert!(written.contains("playout-1"));
}

#[test]
fn the_audit_log_is_bounded_in_memory() {
    let mut log = AuditLog::new(None, 4);

    for index in 0..20 {
        log.record(AuditEntry {
            at_ms: index,
            client_id: "c".to_string(),
            message_type: "playout.cue".to_string(),
            scene_ref: None,
            outcome: "accepted".to_string(),
            override_reason: None,
        });
    }

    assert_eq!(log.len(), 4);
    assert_eq!(log.recent(10).len(), 4);
}
