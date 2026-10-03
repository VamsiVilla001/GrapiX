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
use gx_contracts::control::{
    apply_control_values, apply_take_page, declare_control_field, remove_control_field,
    ControlField, ControlFieldKind, ControlValue, TakePage,
};
use gx_contracts::text_style::{
    apply_text_style, validate_text_styles, StyleColor, StyleNumber, TextStyle,
};
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

mod command;

const PLANE: &str = "refusal audit";

struct Limitation {
    variant: &'static str,
    reason: &'static str,
}

/// Runs in the normal conformance gate, not as a one-off inventory script.
pub fn refusal_audit_suite(report: &mut Report) {
    drive_control_refusals(report);
    drive_control_contract_refusals(report);
    drive_contract_refusals(report);
    drive_text_style_refusals(report);
    drive_material_refusals(report);
    drive_media_refusals(report);
    drive_asset_refusals(report);
    drive_playout_refusals(report);
    drive_editor_refusals(report);
    command::drive_command_refusals(report);
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

/// Named text styles are contract-owned edits, so every refusal must be driven
/// against the real resolver rather than represented only in the shell.
fn drive_text_style_refusals(report: &mut Report) {
    use gx_contracts::scene::TextCase;

    let scene = || {
        parse_scene_document(
            br#"{"id":"audit","name":"audit","version":1,"canvas":{"width":16,"height":16,"frameRate":{"num":50,"den":1}},"fonts":[{"fontId":"inter","family":"Inter","displayName":"Inter","faces":[],"fallbackFamilies":[],"embeddingPolicy":"package","status":"Ready"}],"objects":[{"type":"text","id":"title","name":"title","text":"Score","fontId":"inter","size":24}]}"#,
        )
        .expect("the text-style audit scene is valid")
    };
    let style = |font_id: &str| TextStyle {
        style_id: "headline".into(),
        name: "Headline".into(),
        font_id: font_id.into(),
        size: StyleNumber::Literal(48.0),
        line_height: None,
        letter_spacing: None,
        text_case: TextCase::Upper,
        fill: None,
        stroke: None,
        stroke_width: None,
    };

    let mut unknown_font = scene();
    unknown_font.text_styles.push(style("missing"));
    report.record(
        PLANE,
        "TextStyleFontUnknown is produced for a style whose scene lacks its font",
        expect(
            matches!(
                apply_text_style(&mut unknown_font, "title", "headline", None),
                Err(Refusal::TextStyleFontUnknown { style_id, font_id })
                    if style_id == "headline" && font_id == "missing"
            ),
            "a style with an unavailable font was not refused as TextStyleFontUnknown",
        ),
    );

    let mut unknown_style = scene();
    report.record(
        PLANE,
        "TextStyleUnknown is produced for a missing named style",
        expect(
            matches!(
                apply_text_style(&mut unknown_style, "title", "missing", None),
                Err(Refusal::TextStyleUnknown { style_id }) if style_id == "missing"
            ),
            "an absent style was not refused as TextStyleUnknown",
        ),
    );

    let mut unresolved_token = scene();
    let mut token_style = style("inter");
    token_style.fill = Some(StyleColor::Token(gx_contracts::design_system::TokenRef(
        "palette.brand".into(),
    )));
    unresolved_token.text_styles.push(token_style);
    report.record(
        PLANE,
        "TextStyleTokenUnresolved is produced without a confirmed design system",
        expect(
            matches!(
                apply_text_style(&mut unresolved_token, "title", "headline", None),
                Err(Refusal::TextStyleTokenUnresolved { style_id, token })
                    if style_id == "headline" && token == "{palette.brand}"
            ),
            "a style with no supplied token set was not refused as TextStyleTokenUnresolved",
        ),
    );

    // A style library that reached the engine without going through the
    // Editor's own operations is held to the same rule at publication.
    let mut ambiguous = scene();
    ambiguous.text_styles = vec![style("inter"), style("inter")];
    report.record(
        PLANE,
        "TextStyleDuplicate is produced for two styles sharing a stable id",
        expect(
            matches!(
                validate_text_styles(&ambiguous),
                Err(Refusal::TextStyleDuplicate { style_id }) if style_id == "headline"
            ),
            "two styles sharing one id were not refused by name",
        ),
    );
}

/// Drives the template-control contract at the same public functions the
/// Editor shell calls. A declaration or fill that cannot be applied is named,
/// never retained as an operator field that does nothing.
fn drive_control_contract_refusals(report: &mut Report) {
    use gx_contracts::scene::{ObjectBase, RectObject, SceneCanvas, SceneDocument, SceneObject, SceneTimeline};

    let scene = || SceneDocument {
        id: "audit".into(),
        name: "audit".into(),
        version: 1,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas { width: 16, height: 16, frame_rate: RationalRate::P50 },
        timeline: SceneTimeline { duration_frames: 1, channels: Vec::new(), phases: Vec::new() },
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        objects: vec![SceneObject::Rect(RectObject {
            base: ObjectBase::new("card", "Card"),
            radius: 0.0,
        })],
    };
    let field = || ControlField {
        field_id: "position".into(),
        label: "Position".into(),
        object_id: "card".into(),
        property: "x".into(),
        kind: ControlFieldKind::Number,
        default: None,
    };

    let mut unknown_target = scene();
    report.record(
        PLANE,
        "ControlFieldTargetUnknown is produced for a non-fillable target",
        expect(
            matches!(
                declare_control_field(
                    &mut unknown_target,
                    ControlField { property: "fontId".into(), ..field() },
                ),
                Err(Refusal::ControlFieldTargetUnknown { object_id, property })
                    if object_id == "card" && property == "fontId"
            ),
            "a non-fillable control target was not refused by name",
        ),
    );

    let mut duplicate = scene();
    declare_control_field(&mut duplicate, field()).expect("audit field is fillable");
    report.record(
        PLANE,
        "ControlFieldDuplicate is produced for a repeated field id",
        expect(
            matches!(
                declare_control_field(&mut duplicate, field()),
                Err(Refusal::ControlFieldDuplicate { field_id }) if field_id == "position"
            ),
            "a duplicate template control id was not refused by name",
        ),
    );
    report.record(
        PLANE,
        "ControlFieldUnknown is produced when removing an absent field",
        expect(
            matches!(
                remove_control_field(&mut duplicate, "missing"),
                Err(Refusal::ControlFieldUnknown { field_id }) if field_id == "missing"
            ),
            "an absent template control was not refused by name",
        ),
    );
    report.record(
        PLANE,
        "ControlValueTypeMismatch is produced for a wrong page value type",
        expect(
            matches!(
                apply_control_values(
                    &duplicate,
                    &std::collections::BTreeMap::from([(
                        "position".into(),
                        ControlValue::Boolean(true),
                    )]),
                ),
                Err(Refusal::ControlValueTypeMismatch { field_id, expected, actual })
                    if field_id == "position" && expected == "number" && actual == "boolean"
            ),
            "a wrong template control value type was not refused with both types",
        ),
    );
    report.record(
        PLANE,
        "TakePageSceneMismatch is produced for a page saved against another template",
        expect(
            matches!(
                apply_take_page(
                    &duplicate,
                    &TakePage {
                        page_id: "page_1".into(),
                        name: "Page 1".into(),
                        scene_id: "another-template".into(),
                        values: Default::default(),
                    },
                ),
                Err(Refusal::TakePageSceneMismatch { page_id, expected, actual })
                    if page_id == "page_1" && expected == "audit" && actual == "another-template"
            ),
            "a page belonging to another template was not refused by name",
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
        timeline: gx_contracts::scene::SceneTimeline { duration_frames: 1, ..Default::default() },
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
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

    drive_animation_refusals(report);
}

/// The editable-animation edit operations live in `gx_contracts` and are the
/// Editor service's producers (11.20). Each refusal is driven against the real
/// function, so a variant that stopped being produced fails here rather than
/// drifting into an unreachable name.
fn drive_animation_refusals(report: &mut Report) {
    use gx_contracts::animation::{
        create_keyframe, move_keyframe, set_keyframe, validate_scene_animation, SceneEasing,
        SceneKeyframe,
    };
    use gx_contracts::scene::{ObjectBase, RectObject, SceneCanvas, SceneDocument, SceneObject, SceneTimeline};

    let scene_with = |objects: Vec<SceneObject>| SceneDocument {
        id: "audit".into(),
        name: "audit".into(),
        version: 1,
        revision: Some(Revision(1)),
        active_camera_id: None,
        canvas: SceneCanvas {
            width: 16,
            height: 16,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline {
            duration_frames: 100,
            ..Default::default()
        },
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        objects,
    };
    let rect = |id: &str| {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    };
    let key = |frame: u64, value: f64| SceneKeyframe {
        frame,
        value,
        easing: SceneEasing::Linear,
        bezier: None,
    };

    let mut duplicate = scene_with(vec![rect("card"), rect("card")]);
    report.record(
        PLANE,
        "SceneDuplicateObjectId is produced for two objects sharing an id",
        expect(
            matches!(
                set_keyframe(&mut duplicate, "card", "x", key(0, 0.0)),
                Err(Refusal::SceneDuplicateObjectId { .. })
            ),
            "a duplicate object id was not refused by name",
        ),
    );

    let mut missing = scene_with(vec![rect("card")]);
    report.record(
        PLANE,
        "SceneObjectUnknown is produced for an edit naming an absent object",
        expect(
            matches!(
                set_keyframe(&mut missing, "ghost", "x", key(0, 0.0)),
                Err(Refusal::SceneObjectUnknown { .. })
            ),
            "an unknown object id was not refused by name",
        ),
    );

    let mut unsupported = scene_with(vec![rect("card")]);
    report.record(
        PLANE,
        "AnimationPropertyUnsupported is produced for a non-animatable property",
        expect(
            matches!(
                set_keyframe(&mut unsupported, "card", "text", key(0, 0.0)),
                Err(Refusal::AnimationPropertyUnsupported { .. })
            ),
            "a non-animatable property was not refused by name",
        ),
    );

    let mut out_of_range = scene_with(vec![rect("card")]);
    report.record(
        PLANE,
        "KeyframeOutOfRange is produced for a frame past the timeline",
        expect(
            matches!(
                set_keyframe(&mut out_of_range, "card", "x", key(200, 0.0)),
                Err(Refusal::KeyframeOutOfRange { .. })
            ),
            "a frame past the timeline was not refused by name",
        ),
    );

    let mut bad_easing = scene_with(vec![rect("card")]);
    report.record(
        PLANE,
        "InvalidKeyframeEasing is produced for custom-bezier with no controls",
        expect(
            matches!(
                set_keyframe(
                    &mut bad_easing,
                    "card",
                    "x",
                    SceneKeyframe {
                        frame: 0,
                        value: 0.0,
                        easing: SceneEasing::CustomBezier,
                        bezier: None,
                    },
                ),
                Err(Refusal::InvalidKeyframeEasing { .. })
            ),
            "a custom-bezier key with no controls was not refused by name",
        ),
    );

    let mut duplicate_frame = scene_with(vec![rect("card")]);
    set_keyframe(&mut duplicate_frame, "card", "x", key(20, 0.0)).expect("first key lands");
    report.record(
        PLANE,
        "DuplicateKeyframeFrame is produced for a second key at one frame",
        expect(
            matches!(
                create_keyframe(&mut duplicate_frame, "card", "x", key(20, 1.0)),
                Err(Refusal::DuplicateKeyframeFrame { .. })
            ),
            "a duplicate frame was not refused by name",
        ),
    );

    // Preset application follows the same collision rule and is atomic: the
    // authored key survives and nothing of the preset is written.
    let slide = gx_contracts::design_system::starter_presets()
        .into_iter()
        .find(|preset| preset.id == "slide")
        .expect("slide is a starter preset");
    let mut preset_collision = scene_with(vec![rect("card")]);
    set_keyframe(&mut preset_collision, "card", "x", key(20, 999.0)).expect("authored key lands");
    let before = preset_collision.clone();
    let refused = gx_contracts::animation::apply_preset_phase(
        &mut preset_collision,
        "card",
        &slide.phases.r#in,
        0,
    );
    report.record(
        PLANE,
        "DuplicateKeyframeFrame is produced for a preset landing on an authored key",
        expect(
            matches!(refused, Err(Refusal::DuplicateKeyframeFrame { frame: 20, .. }))
                && preset_collision == before,
            "a preset overwrote an authored key or mutated the scene before refusing",
        ),
    );

    // The evaluator refuses a custom-bezier with no controls rather than
    // easing it as linear (invariant 18).
    let pointless = gx_contracts::animation::KeyframeChannel {
        object_id: "card".into(),
        property: "x".into(),
        keys: vec![
            SceneKeyframe {
                frame: 0,
                value: 0.0,
                easing: SceneEasing::CustomBezier,
                bezier: None,
            },
            key(10, 1.0),
        ],
    };
    report.record(
        PLANE,
        "InvalidKeyframeEasing is produced by the evaluator for custom-bezier with no controls",
        expect(
            matches!(
                gx_contracts::animation::evaluate_channel(&pointless, 5),
                Err(Refusal::InvalidKeyframeEasing { .. })
            ),
            "the evaluator substituted a curve for a custom-bezier with no controls",
        ),
    );

    let mut no_channel = scene_with(vec![rect("card")]);
    report.record(
        PLANE,
        "AnimationChannelUnknown is produced for a move on an absent channel",
        expect(
            matches!(
                move_keyframe(&mut no_channel, "card", "x", 0, 10),
                Err(Refusal::AnimationChannelUnknown { .. })
            ),
            "a move on an absent channel was not refused by name",
        ),
    );

    let mut no_key = scene_with(vec![rect("card")]);
    set_keyframe(&mut no_key, "card", "x", key(10, 0.0)).expect("seed key lands");
    report.record(
        PLANE,
        "KeyframeUnknown is produced for a move of a key that is not there",
        expect(
            matches!(
                move_keyframe(&mut no_key, "card", "x", 40, 60),
                Err(Refusal::KeyframeUnknown { .. })
            ),
            "a move of an absent key was not refused by name",
        ),
    );

    // The edit operations above keep a loaded document well-formed as it is
    // authored. `validate_scene_animation` is the publication-side check for a
    // document that reached the engine by any other route, and it must refuse
    // by the same named conditions rather than repairing them.
    let mut two_channels = scene_with(vec![rect("card")]);
    set_keyframe(&mut two_channels, "card", "x", key(0, 0.0)).expect("seed key lands");
    let authored = two_channels.timeline.channels[0].clone();
    two_channels.timeline.channels.push(authored);
    report.record(
        PLANE,
        "DuplicateAnimationChannel is produced for two channels on one property",
        expect(
            matches!(
                validate_scene_animation(&two_channels),
                Err(Refusal::DuplicateAnimationChannel { object, property })
                    if object == "card" && property == "x"
            ),
            "two channels on one object property were not refused by name",
        ),
    );

    let mut unordered = scene_with(vec![rect("card")]);
    set_keyframe(&mut unordered, "card", "x", key(0, 0.0)).expect("seed key lands");
    set_keyframe(&mut unordered, "card", "x", key(20, 1.0)).expect("second key lands");
    unordered.timeline.channels[0].keys.reverse();
    report.record(
        PLANE,
        "AnimationKeyOrderInvalid is produced for keys that move backwards",
        expect(
            matches!(
                validate_scene_animation(&unordered),
                Err(Refusal::AnimationKeyOrderInvalid { previous: 20, frame: 0, .. })
            ),
            "a channel whose keys move backwards was not refused by name",
        ),
    );

    drive_authoring_refusals(report);
    drive_timeline_phase_refusals(report);
}

/// Named timeline phases (11.25). The scene timeline finally speaks the same
/// operator vocabulary presets have always used, and each way of getting a
/// phase wrong is refused by its own name — an author who inverted a span is
/// told that, not that the span is out of range.
fn drive_timeline_phase_refusals(report: &mut Report) {
    use gx_contracts::phases::{remove_phase, set_phase, validate_phases, PhaseKind, TimelinePhase};
    use gx_contracts::scene::SceneTimeline;

    let span = |kind: PhaseKind, start_frame: u64, end_frame: u64| TimelinePhase {
        kind,
        name: None,
        start_frame,
        end_frame,
    };
    let timeline = || SceneTimeline {
        duration_frames: 100,
        ..Default::default()
    };

    let mut overlapping = timeline();
    set_phase(&mut overlapping, span(PhaseKind::In, 0, 50)).expect("in lands");
    report.record(
        PLANE,
        "TimelinePhaseOverlap is produced for two phases claiming one frame",
        expect(
            matches!(
                set_phase(&mut overlapping, span(PhaseKind::Out, 49, 90)),
                Err(Refusal::TimelinePhaseOverlap { .. })
            ) && overlapping.phases.len() == 1,
            "overlapping phases were not refused by name, or the refused call still wrote",
        ),
    );

    let mut past_end = timeline();
    report.record(
        PLANE,
        "TimelinePhaseOutOfRange is produced for a phase past the scene duration",
        expect(
            matches!(
                set_phase(&mut past_end, span(PhaseKind::In, 90, 101)),
                Err(Refusal::TimelinePhaseOutOfRange { .. })
            ),
            "a phase running past the timeline was not refused by name",
        ),
    );

    let mut empty_span = timeline();
    report.record(
        PLANE,
        "TimelinePhaseInvalidSpan is produced for a phase containing no frames",
        expect(
            matches!(
                set_phase(&mut empty_span, span(PhaseKind::Out, 60, 60)),
                Err(Refusal::TimelinePhaseInvalidSpan { .. })
            ),
            "an empty phase span was not refused by name",
        ),
    );

    let mut absent = timeline();
    report.record(
        PLANE,
        "TimelinePhaseUnknown is produced for removing a phase that is not there",
        expect(
            matches!(
                remove_phase(&mut absent, "in"),
                Err(Refusal::TimelinePhaseUnknown { .. })
            ),
            "removing an absent phase was not refused by name",
        ),
    );

    // The phase did not change; the scene shortened underneath it. Re-checked
    // separately because nothing about the phase itself is wrong.
    let mut shortened = timeline();
    set_phase(&mut shortened, span(PhaseKind::Out, 80, 100)).expect("out lands at full duration");
    shortened.duration_frames = 60;
    report.record(
        PLANE,
        "TimelinePhaseOutOfRange is produced when the duration shortens under a phase",
        expect(
            matches!(
                validate_phases(&shortened),
                Err(Refusal::TimelinePhaseOutOfRange { .. })
            ),
            "a phase left past the end by a shortened scene was not reported",
        ),
    );
}

/// The object-lifecycle authoring operations (11.18) are also Editor-service
/// producers in `gx_contracts`. A kind that needs data the caller has not
/// supplied, and an empty name, are refused by name rather than making a
/// broken or nameless object — driven here against the real constructor so a
/// producer that stopped refusing fails the gate.
fn drive_authoring_refusals(report: &mut Report) {
    use gx_contracts::authoring::create_object;
    use gx_contracts::scene::{SceneCanvas, SceneDocument, SceneTimeline};

    let empty_scene = || SceneDocument {
        id: "audit".into(),
        name: "audit".into(),
        version: 1,
        revision: Some(Revision(1)),
        active_camera_id: None,
        canvas: SceneCanvas {
            width: 16,
            height: 16,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline {
            duration_frames: 100,
            ..Default::default()
        },
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        objects: Vec::new(),
    };

    let mut needs_asset = empty_scene();
    report.record(
        PLANE,
        "SceneObjectKindNotCreatable is produced for a kind that needs data the caller has not supplied",
        expect(
            matches!(
                create_object(&mut needs_asset, "image", "Logo"),
                Err(Refusal::SceneObjectKindNotCreatable { .. })
            ) && needs_asset.objects.is_empty(),
            "a kind that cannot be created was not refused by name, or wrote an object anyway",
        ),
    );

    let mut empty_name = empty_scene();
    report.record(
        PLANE,
        "SceneObjectNameEmpty is produced for a create with no name",
        expect(
            matches!(
                create_object(&mut empty_name, "rect", "   "),
                Err(Refusal::SceneObjectNameEmpty)
            ) && empty_name.objects.is_empty(),
            "an empty object name was not refused by name, or wrote an object anyway",
        ),
    );
}

fn drive_playout_refusals(report: &mut Report) {
    let scene = PublishedScene {
        take_id: TakeId("audit/rundown".into()),
        revision: Revision(1),
        document: serde_json::Value::Null,
        design_system_version: None,
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

    // Cull, alpha and depth are checked in that order after blend, so each
    // support below accepts every earlier mode and none of the one under test.
    use gx_contracts::material::{AlphaMode, CullMode, DepthMode};
    let support = |cull: bool, alpha: bool| MaterialSupport {
        blend_modes: BlendMode::ALL.to_vec(),
        fit_modes: FitMode::ALL.to_vec(),
        cull_modes: if cull { CullMode::ALL.to_vec() } else { Vec::new() },
        alpha_modes: if alpha { AlphaMode::ALL.to_vec() } else { Vec::new() },
        depth_modes: Vec::new(),
    };
    let cull_refused = CullMode::ALL.iter().all(|&mode| {
        let mut material = material_with_blend(BlendMode::Normal);
        material.cull_mode = mode;
        matches!(validate_material(&material, &support(false, false)), Err(refusal) if matches!(refusal.code, Refusal::UnsupportedCullMode { mode: refused } if refused == mode))
    });
    report.record(PLANE, "UnsupportedCullMode is produced for every cull mode a peer does not declare", expect(cull_refused, "a cull mode the peer does not declare was not refused as itself"));
    let alpha_refused = AlphaMode::ALL.iter().all(|&mode| {
        let mut material = material_with_blend(BlendMode::Normal);
        material.alpha_mode = mode;
        matches!(validate_material(&material, &support(true, false)), Err(refusal) if matches!(refusal.code, Refusal::UnsupportedAlphaMode { mode: refused } if refused == mode))
    });
    report.record(PLANE, "UnsupportedAlphaMode is produced for every alpha mode a peer does not declare", expect(alpha_refused, "an alpha mode the peer does not declare was not refused as itself"));
    let depth_refused = DepthMode::ALL.iter().all(|&mode| {
        let mut material = material_with_blend(BlendMode::Normal);
        material.depth_mode = mode;
        matches!(validate_material(&material, &support(true, true)), Err(refusal) if matches!(refusal.code, Refusal::UnsupportedDepthMode { mode: refused } if refused == mode))
    });
    report.record(PLANE, "UnsupportedDepthMode is produced for every depth mode a peer does not declare", expect(depth_refused, "a depth mode the peer does not declare was not refused as itself"));

    // The software path fills glyphs with a solid colour only; a gradient text
    // fill is refused at validation rather than flattened at frame time.
    let mut scene = gx_contracts::command::witness::fixture_scene();
    for object in &mut scene.objects {
        if object.base().id == "text" {
            object.base_mut().fill = Some(ColorValue::LinearGradient {
                angle: 0.0,
                start_x: 0.0,
                start_y: 0.0,
                end_x: 1.0,
                end_y: 0.0,
                stops: Vec::new(),
                spread: Default::default(),
                coordinate_mode: Default::default(),
            });
        }
    }
    let draws_everything = MaterialSupport { depth_modes: DepthMode::ALL.to_vec(), ..support(true, true) };
    let found = gx_contracts::validate::validate_scene_document(&scene, &draws_everything, &Default::default(), false);
    report.record(PLANE, "UnsupportedPathGradient is produced for a gradient text fill", expect(found.iter().any(|refusal| matches!(&refusal.code, Refusal::UnsupportedPathGradient { object, .. } if object == "text")), format!("a gradient text fill was not refused as UnsupportedPathGradient: {found:?}")));
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
    let missing: Vec<_> = all
        .iter()
        .filter(|name| !is_driven(name) && !registered.contains(&name.as_str()))
        .collect();
    let stale: Vec<_> = registered
        .iter()
        .filter(|name| !all.iter().any(|found| found == *name))
        .collect();
    report.record(
        PLANE,
        "every declared refusal is driven or has a named limitation",
        expect(
            missing.is_empty() && stale.is_empty(),
            format!(
                "the refusal register is out of date; undriven and unregistered: {missing:?}; limitations naming no variant: {stale:?}"
            ),
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
            | "TextStyleDuplicate"
            | "TakePageSceneMismatch"
            | "DuplicateAnimationChannel"
            | "AnimationKeyOrderInvalid"
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
            | "SceneDuplicateObjectId"
            | "SceneObjectUnknown"
            | "ControlFieldTargetUnknown"
            | "ControlFieldDuplicate"
            | "ControlFieldUnknown"
            | "ControlValueTypeMismatch"
            | "TextStyleFontUnknown"
            | "TextStyleUnknown"
            | "TextStyleTokenUnresolved"
            | "AnimationPropertyUnsupported"
            | "KeyframeOutOfRange"
            | "InvalidKeyframeEasing"
            | "DuplicateKeyframeFrame"
            | "AnimationChannelUnknown"
            | "KeyframeUnknown"
            | "SceneObjectKindNotCreatable"
            | "SceneObjectNameEmpty"
            | "TimelinePhaseOverlap"
            | "TimelinePhaseOutOfRange"
            | "TimelinePhaseInvalidSpan"
            | "TimelinePhaseUnknown"
            | "UnsupportedCullMode"
            | "UnsupportedAlphaMode"
            | "UnsupportedDepthMode"
            | "UnsupportedPathGradient"
            | "CommandUnknownField"
            | "SessionUnknown"
            | "HistoryEmpty"
            | "EditBatchEmpty"
            | "SessionUnbound"
            | "EditTargetsEmpty"
            | "ObjectFieldNotApplicable"
            | "ObjectFieldValueInvalid"
            | "ObjectFieldUnchanged"
            | "ObjectHiddenByParent"
            | "ObjectLocked"
            | "BindingPropertyUnsupported"
            | "BindingPathInvalid"
            | "BindingTypeMismatch"
            | "BindingValueOutOfRange"
            | "BindingAssetUnknown"
            | "BindingNotBound"
            | "DataContextUnchanged"
            | "BindingUnchanged"
            | "SessionHasUnsavedChanges"
            | "MaterialInUse"
            | "MaterialUnknown"
            | "MaterialRelinkSameMaterial"
            | "MaterialRelinkNoUsers"
            | "MotionPresetUnknown"
            | "FontBatchEmpty"
            | "FontDuplicate"
            | "SceneAssetDuplicate"
            | "FontUnknown"
            | "FontInUse"
            | "SceneNameEmpty"
            | "SceneIdInvalid"
            | "ProjectNameInvalid"
            | "ProjectAlreadyExists"
            | "SceneAlreadyExists"
            | "SceneNotStored"
            | "TakePageIdInvalid"
            | "SceneIdBound"
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
        Limitation {
            variant: "DesignSourceUnreadable",
            reason: "design-system ingest is not an EnginePeer request",
        },
        Limitation {
            variant: "VectorTessellationFailed",
            reason: "only the render worker's rasteriser tessellates; the mock engine draws nothing to tessellate",
        },
        Limitation {
            variant: "UnknownOutputAdapter",
            reason: "output adapters exist only in the render worker; the mock engine has no adapter registry",
        },
        Limitation {
            variant: "SceneMaterialUnknown",
            reason: "mesh preparation runs only in the render worker; the mock engine does not prepare meshes",
        },
        Limitation {
            variant: "MeshMaterialUnassigned",
            reason: "mesh preparation runs only in the render worker; the mock engine does not prepare meshes",
        },
        Limitation {
            variant: "MeshModelAssetWrongKind",
            reason: "mesh preparation runs only in the render worker; the mock engine does not prepare meshes",
        },
        Limitation {
            variant: "MeshModelInvalid",
            reason: "mesh preparation runs only in the render worker; the mock engine does not prepare meshes",
        },
        Limitation {
            variant: "MeshMaterialElementsMismatch",
            reason: "mesh preparation runs only in the render worker; the mock engine does not prepare meshes",
        },
        Limitation {
            variant: "MeshMaterialRequiresLight",
            reason: "mesh preparation runs only in the render worker; the mock engine does not prepare meshes",
        },
        Limitation {
            variant: "LightHasNoResponsiveMaterial",
            reason: "mesh preparation runs only in the render worker; the mock engine does not prepare meshes",
        },
        Limitation {
            variant: "SceneActiveCameraUnknown",
            reason: "camera resolution runs only in the render worker; the mock engine does not prepare 3D scenes",
        },
    ]
}

/// Constructs every variant once. The exhaustive match makes a new variant a
/// compiler error until it has a driver or a named limitation.
/// Every refusal variant, from the crate that owns the enum.
///
/// This list used to live here, where only the audit could see it — and the
/// MCP capability surface needed the same enumeration to tell an agent which
/// refusals it might receive. It moved to `Refusal::all_variants` so there is
/// one list (invariant 27); the pairing test below still guards it.
fn all_refusal_variants() -> Vec<Refusal> {
    Refusal::all_variants()
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
