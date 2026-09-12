//! Refusal-surface conformance audit.
//!
//! A named refusal prevents a silent fallback only when an attempted operation
//! reaches it. This suite drives the available producers and maintains a
//! compile-exhaustive register for contract variants outside `EnginePeer`.
//! Those routes are printed as limitations, never hidden as permanent skips.

use gx_contracts::color::ColorValue;
use gx_contracts::color::Rgba;
use gx_contracts::font::{check_font_face_url, FontSource};
use gx_contracts::material::{
    validate_material, BlendMode, FitMode, MaterialDefinition, MaterialKind, MaterialSupport,
    MaterialTextureSlot,
};
use gx_contracts::package::{package_path_components, PackageFileEntry, PackageManifest};
use gx_contracts::scene::parse_scene_document;
use gx_contracts::{
    ClockSource, ContentHash, DeviceTier, Epoch, RationalRate, ReferenceState, Refusal, Revision,
    TakeId,
};
use gx_control_plane::capability::{check_clock_domain, check_protocol, live_allowed};
use gx_control_plane::intent::{resolve_intent, ClockState, Lead, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply, OutputConfig};
use gx_control_plane::peer::{EnginePeer, FaultInjection};
use gx_asset_plane::Transfer;
use gx_mock_engine::MockEngine;
use gx_media_plane::LocalMediaTransport;
use gx_playout::{evaluate_automation, AutomationTrigger, PublishedScene, Rundown, RundownEntry};

use crate::{expect, Report};

const PLANE: &str = "refusal audit";

struct Limitation {
    variant: &'static str,
    reason: &'static str,
}

/// Runs in the normal conformance gate, not as a one-off inventory script.
pub fn refusal_audit_suite(report: &mut Report) {
    drive_control_refusals(report);
    drive_contract_refusals(report);
    drive_material_refusals(report);
    drive_media_refusals(report);
    drive_asset_refusals(report);
    drive_playout_refusals(report);
    drive_editor_refusals(report);
    record_surface_limitations(report);
}

fn drive_control_refusals(report: &mut Report) {
    report.record(PLANE, "ProtocolMismatch is produced for a mismatched protocol", expect(matches!(check_protocol(0), Err(Refusal::ProtocolMismatch { expected, actual: 0 }) if expected == gx_contracts::PROTOCOL_VERSION), "a mismatched protocol was not refused as ProtocolMismatch"));
    report.record(
        PLANE,
        "TierTooLow is produced for a live sub-T0 output",
        expect(
            matches!(
                live_allowed(DeviceTier::T2, ReferenceState::Locked, true, false),
                Err(Refusal::TierTooLow {
                    actual: DeviceTier::T2
                })
            ),
            "a sub-T0 live request was not refused as TierTooLow",
        ),
    );
    report.record(
        PLANE,
        "PlatformNotCertified is produced for an uncertified live output",
        expect(
            matches!(
                live_allowed(DeviceTier::T0, ReferenceState::Locked, false, false),
                Err(Refusal::PlatformNotCertified { .. })
            ),
            "an uncertified live request was not refused as PlatformNotCertified",
        ),
    );
    report.record(
        PLANE,
        "ReferenceUnlocked is produced for a live output without accepted free-run",
        expect(
            matches!(
                live_allowed(DeviceTier::T0, ReferenceState::NotPresent, true, false),
                Err(Refusal::ReferenceUnlocked {
                    state: ReferenceState::NotPresent
                })
            ),
            "an unlocked live request was not refused as ReferenceUnlocked",
        ),
    );
    report.record(
        PLANE,
        "MultipleClockDomains is produced instead of choosing a clock",
        expect(
            matches!(
                check_clock_domain(ClockSource::Genlocked, ClockSource::Ptp),
                Err(Refusal::MultipleClockDomains {
                    existing: ClockSource::Genlocked,
                    requested: ClockSource::Ptp
                })
            ),
            "a second clock domain was not refused with both sources",
        ),
    );
    let clock = ClockState {
        current_frame: 100,
        timebase: RationalRate::P50,
        clock: ClockSource::FreeRun,
        reference: ReferenceState::NotPresent,
        epoch: Epoch(1),
    };
    report.record(
        PLANE,
        "FrameNotReachable is produced for a past take frame",
        expect(
            matches!(
                resolve_intent(TakeAt::Frame { frame: 99 }, &clock, Lead::CO_LOCATED),
                Err(Refusal::FrameNotReachable {
                    requested: 99,
                    earliest: 101
                })
            ),
            "a past take frame was not refused as FrameNotReachable with its earliest frame",
        ),
    );

    let mut peer = MockEngine::new().genlocked(RationalRate::P50);
    peer.publish(TakeId("audit/published".into()), Revision(2));
    report.record(
        PLANE,
        "RevisionMismatch is produced for a stale published take",
        expect(
            matches!(
                peer.handle(ClientRequest::Take(TakeRequest {
                    take_id: TakeId("audit/published".into()),
                    revision: Revision(1),
                    at: TakeAt::NextOpportunity
                })),
                EngineReply::Refused(Refusal::RevisionMismatch {
                    expected: Revision(2),
                    actual: Revision(1)
                })
            ),
            "a stale take was not refused as RevisionMismatch with both revisions",
        ),
    );
    report.record(
        PLANE,
        "UnknownTake is produced for an unpublished take",
        expect(
            matches!(
                peer.handle(ClientRequest::Take(TakeRequest {
                    take_id: TakeId("audit/unknown".into()),
                    revision: Revision(1),
                    at: TakeAt::NextOpportunity
                })),
                EngineReply::Refused(Refusal::UnknownTake { .. })
            ),
            "an unpublished take was not refused as UnknownTake",
        ),
    );
    peer.set_reference(ReferenceState::Unlocked);
    report.record(
        PLANE,
        "ReferenceUnlocked is produced by a peer after reference loss",
        expect(
            matches!(
                peer.handle(ClientRequest::ConfigureOutput(OutputConfig {
                    adapter: "audit-live".into(),
                    live: true,
                    accept_free_run: true
                })),
                EngineReply::Refused(Refusal::ReferenceUnlocked {
                    state: ReferenceState::Unlocked
                })
            ),
            "the peer did not refuse a live output after reference loss by name",
        ),
    );
    report.record(
        PLANE,
        "NotImplemented is produced when authentication reaches the engine peer",
        expect(
            matches!(
                peer.handle(ClientRequest::Authenticate {
                    token: "audit".into()
                }),
                EngineReply::Refused(Refusal::NotImplemented { .. })
            ),
            "an Authenticate request reaching the engine was not refused as NotImplemented",
        ),
    );
}

fn drive_contract_refusals(report: &mut Report) {
    report.record(
        PLANE,
        "InvalidRate is produced for a zero denominator",
        expect(
            matches!(
                RationalRate::new(50, 0),
                Err(Refusal::InvalidRate { num: 50, den: 0 })
            ),
            "a zero rate denominator was not refused as InvalidRate",
        ),
    );
    report.record(
        PLANE,
        "InvalidColor is produced instead of defaulting an invalid CSS colour",
        expect(
            matches!(
                Rgba::from_css_hex("#zzzzzz"),
                Err(Refusal::InvalidColor { .. })
            ),
            "an invalid CSS colour was accepted or defaulted",
        ),
    );
    report.record(
        PLANE,
        "FontUrlNotHttps is produced for an HTTP font source",
        expect(
            matches!(
                check_font_face_url(&FontSource::CssUrl {
                    url: "http://fonts.googleapis.com/css2".into(),
                    integrity: None
                }),
                Err(Refusal::FontUrlNotHttps { .. })
            ),
            "an HTTP font URL was not refused as FontUrlNotHttps",
        ),
    );
    report.record(
        PLANE,
        "FontUrlHasCredentials is produced for credentialed font URLs",
        expect(
            matches!(
                check_font_face_url(&FontSource::CssUrl {
                    url: "https://user:secret@fonts.googleapis.com/css2".into(),
                    integrity: None
                }),
                Err(Refusal::FontUrlHasCredentials { .. })
            ),
            "a credentialed font URL was not refused as FontUrlHasCredentials",
        ),
    );
    report.record(
        PLANE,
        "InvalidFontUrl is produced for malformed font URLs",
        expect(
            matches!(
                check_font_face_url(&FontSource::CssUrl {
                    url: "not a URL".into(),
                    integrity: None
                }),
                Err(Refusal::InvalidFontUrl { .. })
            ),
            "a malformed font URL was not refused as InvalidFontUrl",
        ),
    );
    report.record(
        PLANE,
        "SceneParseFailed is produced for malformed scene JSON",
        expect(
            matches!(
                parse_scene_document(b"{this is not json"),
                Err(Refusal::SceneParseFailed { .. })
            ),
            "malformed scene JSON was not refused as SceneParseFailed",
        ),
    );
    report.record(PLANE, "SceneUnknownField is produced with the unknown JSON path", expect(matches!(parse_scene_document(br#"{"id":"audit","name":"audit","version":1,"canvas":{"width":1,"height":1,"frameRate":{"num":50,"den":1}},"timeline":{"durationFrames":1},"dataContext":{},"assets":[],"fonts":[],"materials":[],"objects":[],"unexpected":true}"#), Err(Refusal::SceneUnknownField { path }) if path == "unexpected"), "an unknown scene field was not refused with its JSON path"));
    report.record(
        PLANE,
        "UnsafePackagePath is produced for a traversal member",
        expect(
            matches!(
                package_path_components("../outside"),
                Err(Refusal::UnsafePackagePath { .. })
            ),
            "a traversal package member was not refused as UnsafePackagePath",
        ),
    );
    let manifest = PackageManifest {
        format_version: 0,
        scene_id: "audit".into(),
        scene_revision: Revision(1),
        files: Vec::<PackageFileEntry>::new(),
        design_system_version: None,
    };
    report.record(
        PLANE,
        "UnknownPackageFormatVersion is produced for an unknown manifest version",
        expect(
            matches!(
                manifest.validate(),
                Err(Refusal::UnknownPackageFormatVersion { received: 0 })
            ),
            "an unknown package format was not refused by name",
        ),
    );
}

fn drive_editor_refusals(report: &mut Report) {
    // 7.1: a write must refuse a project that does not exist rather than
    // creating one. Driven against a root that is deliberately empty, so the
    // refusal is the real one the service produces.
    let root = std::env::temp_dir().join(format!(
        "gx-conformance-editor-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let projects = gx_editor::Projects::at_root(&root);
    let scene = gx_contracts::scene::SceneDocument {
        id: "audit".into(),
        name: "audit".into(),
        version: 1,
        revision: Some(Revision(1)),
        active_camera_id: None,
        canvas: gx_contracts::scene::SceneCanvas {
            width: 16,
            height: 16,
            frame_rate: RationalRate::P50,
        },
        timeline: gx_contracts::scene::SceneTimeline { duration_frames: 1 },
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        objects: Vec::new(),
    };

    let outcome = projects.write_scene("no-such-project", &scene);
    report.record(
        PLANE,
        "ProjectNotFound is produced for a write into a project that does not exist",
        expect(
            matches!(
                outcome,
                Err(gx_editor::EditorError::Refused(Refusal::ProjectNotFound { .. }))
            ) && !root.join("no-such-project").exists(),
            "a write into a missing project was not refused by name, or created one anyway",
        ),
    );
}

fn drive_playout_refusals(report: &mut Report) {
    let scene = PublishedScene {
        take_id: TakeId("audit/rundown".into()),
        revision: Revision(1),
        document: serde_json::Value::Null,
    };
    let rundown = Rundown::new(vec![RundownEntry {
        id: "opening".into(),
        scene,
    }]);

    report.record(
        PLANE,
        "RundownCursorOutOfRange is produced for a cursor beyond the sequence",
        expect(
            matches!(
                rundown.at(1),
                Err(Refusal::RundownCursorOutOfRange { cursor: 1, len: 1 })
            ),
            "a cursor beyond the rundown was not refused with its cursor and sequence length",
        ),
    );
    report.record(
        PLANE,
        "RundownEntryUnknown is produced for a missing entry identity",
        expect(
            matches!(
                rundown.entry("missing"),
                Err(Refusal::RundownEntryUnknown { entry_id }) if entry_id == "missing"
            ),
            "a missing rundown entry was not refused with its identity",
        ),
    );
    report.record(
        PLANE,
        "AutomationExecutionDeferred is produced when an automation trigger matches",
        expect(
            matches!(
                evaluate_automation(
                    &rundown,
                    &[AutomationTrigger {
                        name: "open-sting".into(),
                        entry_id: "opening".into(),
                    }]
                ),
                Err(Refusal::AutomationExecutionDeferred { trigger, matched })
                    if trigger == "open-sting" && matched == "opening"
            ),
            "a matching automation trigger was silent instead of explicitly deferred",
        ),
    );
}

fn drive_media_refusals(report: &mut Report) {
    report.record(
        PLANE,
        "MediaTransportUnavailable is produced when a local mapping cannot be established",
        expect(
            matches!(
                LocalMediaTransport::establish(0),
                Err(Refusal::MediaTransportUnavailable { detail }) if detail.contains("capacity")
            ),
            "an unavailable local media mapping was not refused as MediaTransportUnavailable",
        ),
    );
}


fn drive_asset_refusals(report: &mut Report) {
    let hash = ContentHash("audit-asset".into());
    let mut out_of_order = Transfer::new(hash.clone(), 2).expect("non-empty transfer must start");
    report.record(
        PLANE,
        "AssetChunkOutOfOrder is produced for a skipped asset chunk",
        expect(
            matches!(
                out_of_order.accept_chunk(1),
                Err(Refusal::AssetChunkOutOfOrder {
                    expected: 0,
                    received: 1,
                    ..
                })
            ),
            "a skipped asset chunk was not refused as AssetChunkOutOfOrder",
        ),
    );
    report.record(
        PLANE,
        "EmptyAssetTransfer is produced for a zero-chunk asset",
        expect(
            matches!(
                Transfer::new(hash.clone(), 0),
                Err(Refusal::EmptyAssetTransfer { .. })
            ),
            "a zero-chunk asset was not refused as EmptyAssetTransfer",
        ),
    );
    let mut complete = Transfer::new(hash.clone(), 1).expect("one-chunk transfer must start");
    complete.accept_chunk(0).expect("the first chunk must arrive");
    report.record(
        PLANE,
        "AssetTransferAlreadyComplete is produced for a post-completion chunk",
        expect(
            matches!(
                complete.accept_chunk(1),
                Err(Refusal::AssetTransferAlreadyComplete { .. })
            ),
            "a post-completion asset chunk was not refused as AssetTransferAlreadyComplete",
        ),
    );
    let mut mismatch = Transfer::new(hash.clone(), 1).expect("one-chunk transfer must start");
    mismatch.accept_chunk(0).expect("the first chunk must arrive");
    report.record(
        PLANE,
        "AssetHashMismatch is produced for bytes under the wrong content address",
        expect(
            matches!(
                mismatch.verify(&ContentHash("other-asset".into())),
                Err(Refusal::AssetHashMismatch { .. })
            ),
            "mismatched asset bytes were not refused as AssetHashMismatch",
        ),
    );
}
fn drive_material_refusals(report: &mut Report) {
    for mode in BlendMode::ALL {
        let refusal = validate_material(&material_with_blend(mode), &MaterialSupport::none())
            .expect_err("an engine declaring no blend support must refuse every blend mode");
        report.record(PLANE, blend_check_name(mode), expect(matches!(refusal.code, Refusal::UnsupportedBlendMode { mode: refused } if refused == mode) && refusal.allowed.as_ref().is_none_or(|allowed| allowed.is_empty()), format!("blend mode {mode:?} was not refused as itself with the empty declared allowed list")));
    }
    // Fit modes are checked after blend/cull/alpha/depth, so a support that
    // accepts all of those but no fit modes isolates the fit refusal.
    let fit_refusing_support = MaterialSupport {
        blend_modes: BlendMode::ALL.to_vec(),
        fit_modes: Vec::new(),
        cull_modes: gx_contracts::material::CullMode::ALL.to_vec(),
        alpha_modes: gx_contracts::material::AlphaMode::ALL.to_vec(),
        depth_modes: gx_contracts::material::DepthMode::ALL.to_vec(),
    };
    for mode in FitMode::ALL {
        let refusal = validate_material(&material_with_fit(mode), &fit_refusing_support)
            .expect_err("an engine declaring no fit support must refuse every fit mode");
        report.record(PLANE, fit_check_name(mode), expect(matches!(refusal.code, Refusal::UnsupportedFitMode { mode: refused } if refused == mode) && refusal.allowed.as_ref().is_none_or(|allowed| allowed.is_empty()), format!("fit mode {mode:?} was not refused as itself with the empty declared allowed list")));
    }
}

fn material_with_blend(blend_mode: BlendMode) -> MaterialDefinition {
    MaterialDefinition {
        material_id: "audit-material".into(),
        name: "audit material".into(),
        kind: MaterialKind::SolidColor,
        color: ColorValue::opaque_white(),
        opacity: 1.0,
        blend_mode,
        alpha_mode: Default::default(),
        cull_mode: Default::default(),
        depth_mode: Default::default(),
        double_sided: false,
        textures: Vec::new(),
        shader_id: None,
    }
}

fn material_with_fit(fit: FitMode) -> MaterialDefinition {
    // The blend mode must be one `MaterialSupport::none()` would not refuse,
    // because validate_material checks blend before fit.  We use a support
    // set that accepts everything so the fit check is the one that fires.
    let mut material = material_with_blend(BlendMode::Normal);
    material.blend_mode = BlendMode::Normal;
    material.textures.push(MaterialTextureSlot {
        slot: "baseColor".into(),
        asset_id: "audit-asset".into(),
        fit,
        wrap: Default::default(),
        filtering: Default::default(),
        color_space: gx_contracts::color::SourceColorSpace::Srgb,
    });
    material
}

fn blend_check_name(mode: BlendMode) -> &'static str {
    match mode {
        BlendMode::Normal => "blend Normal is refused with its allowed list",
        BlendMode::Add => "blend Add is refused with its allowed list",
        BlendMode::Multiply => "blend Multiply is refused with its allowed list",
        BlendMode::Screen => "blend Screen is refused with its allowed list",
        BlendMode::Overlay => "blend Overlay is refused with its allowed list",
        BlendMode::Darken => "blend Darken is refused with its allowed list",
        BlendMode::Lighten => "blend Lighten is refused with its allowed list",
        BlendMode::Subtract => "blend Subtract is refused with its allowed list",
        BlendMode::AlphaMask => "blend AlphaMask is refused with its allowed list",
        BlendMode::InverseAlphaMask => "blend InverseAlphaMask is refused with its allowed list",
    }
}
fn fit_check_name(mode: FitMode) -> &'static str {
    match mode {
        FitMode::Stretch => "fit Stretch is refused with its allowed list",
        FitMode::Contain => "fit Contain is refused with its allowed list",
        FitMode::Cover => "fit Cover is refused with its allowed list",
        FitMode::Crop => "fit Crop is refused with its allowed list",
        FitMode::Tile => "fit Tile is refused with its allowed list",
        FitMode::Original => "fit Original is refused with its allowed list",
        FitMode::PixelPerfect => "fit PixelPerfect is refused with its allowed list",
        FitMode::NineSlice => "fit NineSlice is refused with its allowed list",
    }
}

fn record_surface_limitations(report: &mut Report) {
    for limitation in limitations() {
        report.record_limitation(limitation.variant, limitation.reason);
    }
    let registered: Vec<_> = limitations().iter().map(|item| item.variant).collect();
    let all: Vec<_> = all_refusal_variants()
        .iter()
        .map(refusal_variant_name)
        .collect();
    report.record(
        PLANE,
        "every declared refusal is driven or has a named limitation",
        expect(
            all.iter()
                .all(|name| is_driven(name) || registered.contains(&name.as_str()))
                && registered
                    .iter()
                    .all(|name| all.iter().any(|found| found == name)),
            "the refusal register has a missing or stale variant; add a driver or named limitation",
        ),
    );
}

fn is_driven(variant: &str) -> bool {
    matches!(
        variant,
        "RevisionMismatch"
            | "TierTooLow"
            | "ReferenceUnlocked"
            | "UnsupportedBlendMode"
            | "UnsupportedFitMode"
            | "ProtocolMismatch"
            | "InvalidRate"
            | "PlatformNotCertified"
            | "UnknownTake"
            | "FrameNotReachable"
            | "MultipleClockDomains"
            | "NotImplemented"
            | "FontUrlNotHttps"
            | "FontUrlHasCredentials"
            | "InvalidFontUrl"
            | "InvalidColor"
            | "SceneParseFailed"
            | "SceneUnknownField"
            | "UnknownPackageFormatVersion"
            | "UnsafePackagePath"
            | "MediaTransportUnavailable"
            | "AssetChunkOutOfOrder"
            | "AssetTransferAlreadyComplete"
            | "EmptyAssetTransfer"
            | "AssetHashMismatch"
            | "RundownCursorOutOfRange"
            | "RundownEntryUnknown"
            | "AutomationExecutionDeferred"
            | "ProjectNotFound"
    )
}

fn limitations() -> &'static [Limitation] {
    &[
        Limitation {
            variant: "AssetMissing",
            reason: "asset publication has no EnginePeer request",
        },
        Limitation {
            variant: "Unauthenticated",
            reason: "the transport refuses it before EnginePeer",
        },
        Limitation {
            variant: "TransportFailed",
            reason: "it is a client-side transport failure, not an engine decision",
        },
        Limitation {
            variant: "FontMissing",
            reason: "font definition validation is not an EnginePeer route",
        },
        Limitation {
            variant: "FontEmbeddingRefused",
            reason: "font definition validation is not an EnginePeer route",
        },
        Limitation {
            variant: "FontPathUnsafe",
            reason: "the local font resolver is not an EnginePeer surface",
        },
        Limitation {
            variant: "FontPathOutsideRoot",
            reason: "the local font resolver is not an EnginePeer surface",
        },
        Limitation {
            variant: "FontFetchHostNotTrusted",
            reason: "remote font fetching is not implemented by the peer",
        },
        Limitation {
            variant: "FontFetchAddressDenied",
            reason: "remote font fetching is not implemented by the peer",
        },
        Limitation {
            variant: "FontStylesheetImportDepthExceeded",
            reason: "remote stylesheet fetching is not implemented by the peer",
        },
        Limitation {
            variant: "FontFetchTooLarge",
            reason: "remote font fetching is not implemented by the peer",
        },
        Limitation {
            variant: "FontFetchFailed",
            reason: "remote font fetching is not implemented by the peer",
        },
        Limitation {
            variant: "FontStylesheetImportCycle",
            reason: "remote stylesheet fetching is not implemented by the peer",
        },
        Limitation {
            variant: "FontFileReadFailed",
            reason: "the local font resolver is not an EnginePeer surface",
        },
        Limitation {
            variant: "FontCacheWriteFailed",
            reason: "the remote font cache is not an EnginePeer surface",
        },
        Limitation {
            variant: "AdobeFontLicenceRestricted",
            reason: "the Adobe retrieval policy is not an EnginePeer surface",
        },
        Limitation {
            variant: "InvalidFontData",
            reason: "font byte inspection is not an EnginePeer route",
        },
        Limitation {
            variant: "PlatformDirectoryUnavailable",
            reason: "platform-directory failure cannot be forced without replacing OS discovery",
        },
        Limitation {
            variant: "SceneFontUnknown",
            reason: "scene publication is not a control-plane EnginePeer request",
        },
        Limitation {
            variant: "SceneAssetUnknown",
            reason: "scene publication is not a control-plane EnginePeer request",
        },
        Limitation {
            variant: "InvalidPackageHash",
            reason: "package manifest validation is not an EnginePeer request",
        },
        Limitation {
            variant: "DuplicatePackagePath",
            reason: "package manifest validation is not an EnginePeer request",
        },
        Limitation {
            variant: "PackageEntryMissing",
            reason: "archive read is not an EnginePeer request",
        },
        Limitation {
            variant: "PackageEntryUnreadable",
            reason: "archive read is not an EnginePeer request",
        },
        Limitation {
            variant: "PackageFileLengthMismatch",
            reason: "archive read is not an EnginePeer request",
        },
        Limitation {
            variant: "PackageFileHashMismatch",
            reason: "archive read is not an EnginePeer request",
        },
        Limitation {
            variant: "PackageScenePinMismatch",
            reason: "package assembly is not an EnginePeer request",
        },
        Limitation {
            variant: "PackageAssetNotPackaged",
            reason: "package assembly is not an EnginePeer request",
        },
        Limitation {
            variant: "ProjectJsonCorrupt",
            reason: "project-store loading is not an EnginePeer request",
        },
        Limitation {
            variant: "UnknownProjectSchema",
            reason: "project-store loading is not an EnginePeer request",
        },
        Limitation {
            variant: "ProjectIdLocationMismatch",
            reason: "project-store loading is not an EnginePeer request",
        },
    ]
}

/// Constructs every variant once. The exhaustive match makes a new variant a
/// compiler error until it has a driver or a named limitation.
fn all_refusal_variants() -> Vec<Refusal> {
    vec![
        Refusal::RevisionMismatch {
            expected: Revision(1),
            actual: Revision(0),
        },
        Refusal::TierTooLow {
            actual: DeviceTier::T3,
        },
        Refusal::ReferenceUnlocked {
            state: ReferenceState::Unlocked,
        },
        Refusal::UnsupportedBlendMode {
            mode: BlendMode::Overlay,
        },
        Refusal::UnsupportedFitMode {
            mode: FitMode::NineSlice,
        },
        Refusal::AssetMissing {
            hash: ContentHash("audit".into()),
        },
        Refusal::ProtocolMismatch {
            expected: 1,
            actual: 0,
        },
        Refusal::InvalidRate { num: 0, den: 1 },
        Refusal::PlatformNotCertified {
            platform: "audit".into(),
        },
        Refusal::UnknownTake {
            take_id: TakeId("audit".into()),
        },
        Refusal::FrameNotReachable {
            requested: 0,
            earliest: 1,
        },
        Refusal::MultipleClockDomains {
            existing: ClockSource::Genlocked,
            requested: ClockSource::Ptp,
        },
        Refusal::Unauthenticated,
        Refusal::TransportFailed {
            detail: "audit".into(),
        },
        Refusal::NotImplemented {
            what: "audit".into(),
        },
        Refusal::FontMissing {
            font_id: "audit".into(),
        },
        Refusal::FontUrlNotHttps {
            url: "audit".into(),
        },
        Refusal::FontUrlHasCredentials {
            url: "audit".into(),
        },
        Refusal::InvalidFontUrl {
            url: "audit".into(),
        },
        Refusal::ProjectNotFound {
            project: "audit".into(),
        },
        Refusal::FontEmbeddingRefused {
            font_id: "audit".into(),
        },
        Refusal::FontPathUnsafe {
            path: "audit".into(),
        },
        Refusal::FontPathOutsideRoot {
            path: "audit".into(),
        },
        Refusal::FontFetchHostNotTrusted {
            url: "audit".into(),
        },
        Refusal::FontFetchAddressDenied {
            url: "audit".into(),
        },
        Refusal::FontStylesheetImportDepthExceeded {
            url: "audit".into(),
            max_depth: 1,
        },
        Refusal::FontFetchTooLarge {
            url: "audit".into(),
            limit_bytes: 1,
        },
        Refusal::FontFetchFailed {
            url: "audit".into(),
            detail: "audit".into(),
        },
        Refusal::FontStylesheetImportCycle {
            url: "audit".into(),
        },
        Refusal::FontFileReadFailed {
            path: "audit".into(),
            detail: "audit".into(),
        },
        Refusal::FontCacheWriteFailed {
            path: "audit".into(),
            detail: "audit".into(),
        },
        Refusal::AdobeFontLicenceRestricted {
            url: "audit".into(),
        },
        Refusal::InvalidFontData {
            detail: "audit".into(),
        },
        Refusal::InvalidColor {
            given: "audit".into(),
        },
        Refusal::PlatformDirectoryUnavailable {
            detail: "audit".into(),
        },
        Refusal::SceneParseFailed {
            detail: "audit".into(),
        },
        Refusal::SceneUnknownField {
            path: "audit".into(),
        },
        Refusal::SceneFontUnknown {
            font_id: "audit".into(),
            object: "audit".into(),
        },
        Refusal::SceneAssetUnknown {
            asset_id: "audit".into(),
            object: "audit".into(),
        },
        Refusal::UnknownPackageFormatVersion { received: 0 },
        Refusal::UnsafePackagePath {
            path: "audit".into(),
        },
        Refusal::DuplicatePackagePath {
            path: "audit".into(),
        },
        Refusal::InvalidPackageHash {
            path: "audit".into(),
        },
        Refusal::PackageEntryMissing {
            path: "audit".into(),
        },
        Refusal::PackageEntryUnreadable {
            path: "audit".into(),
            detail: "audit".into(),
        },
        Refusal::PackageFileLengthMismatch {
            path: "audit".into(),
            expected: 1,
            actual: 0,
        },
        Refusal::PackageFileHashMismatch {
            path: "audit".into(),
            expected: ContentHash("expected".into()),
            actual: ContentHash("actual".into()),
        },
        Refusal::PackageScenePinMismatch {
            detail: "audit".into(),
        },
        Refusal::PackageAssetNotPackaged {
            asset_id: "audit".into(),
            path: "audit".into(),
        },
        Refusal::ProjectJsonCorrupt {
            project: "audit".into(),
            detail: "audit".into(),
        },
        Refusal::UnknownProjectSchema {
            project: "audit".into(),
            actual: 0,
            supported: 1,
        },
        Refusal::ProjectIdLocationMismatch {
            project_id: "audit".into(),
            location: "audit".into(),
        },
        Refusal::AssetChunkOutOfOrder {
            hash: ContentHash("audit".into()),
            expected: 1,
            received: 3,
        },
        Refusal::AssetTransferAlreadyComplete {
            hash: ContentHash("audit".into()),
        },
        Refusal::EmptyAssetTransfer {
            hash: ContentHash("audit".into()),
        },
        Refusal::AssetHashMismatch {
            expected: ContentHash("expected".into()),
            actual: ContentHash("actual".into()),
        },
        Refusal::MediaTransportUnavailable {
            detail: "audit".into(),
        },
        Refusal::RundownCursorOutOfRange { cursor: 9, len: 2 },
        Refusal::RundownEntryUnknown {
            entry_id: "audit".into(),
        },
        Refusal::AutomationExecutionDeferred {
            trigger: "audit".into(),
            matched: "audit".into(),
        },
    ]
}

/// The variant's audit name.
///
/// The audit reports PascalCase variant names while the wire carries camelCase
/// codes, so this converts rather than keeping a second table: the contract's
/// `code_name` is the one exhaustive list, and a variant added there appears
/// here without anyone maintaining a parallel register (invariant 27).
fn refusal_variant_name(refusal: &Refusal) -> String {
    let code = refusal.code_name();
    let mut name = String::with_capacity(code.len());
    let mut capitalise = true;
    for character in code.chars() {
        if capitalise {
            name.extend(character.to_uppercase());
            capitalise = false;
        } else {
            name.push(character);
        }
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_declared_refusal_is_driven_or_has_a_named_limitation() {
        let all: Vec<_> = all_refusal_variants()
            .iter()
            .map(refusal_variant_name)
            .collect();
        let limitations: Vec<_> = limitations().iter().map(|item| item.variant).collect();
        assert!(all
            .iter()
            .all(|name| is_driven(name) || limitations.contains(&name.as_str())));
        assert!(limitations
            .iter()
            .all(|name| all.iter().any(|found| found == name)));
    }
}
