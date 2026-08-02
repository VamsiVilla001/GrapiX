use grapix_render_engine::capabilities::ConnectionPrincipal;
use grapix_render_engine::protocol::{decode, ErrorCode, RequestType, SceneDomain, SceneRef};

#[test]
fn hello_role_claim_cannot_grant_editor_playout_authority() {
    let editor = ConnectionPrincipal::loopback_editor("editor-session");
    assert!(!editor.allows(RequestType::Cue));
    assert!(!editor.allows(RequestType::TakeOnline));
    assert!(!editor.allows(RequestType::Continue));
    assert!(!editor.allows(RequestType::Clear));
    assert!(!editor.allows(RequestType::OutputConfigure));
    assert!(!editor.allows(RequestType::OutputStart));
    assert!(!editor.allows(RequestType::OutputStop));
    assert!(!editor.allows(RequestType::OutputRemove));
    assert!(editor.allows(RequestType::OutputList));

    let playout = ConnectionPrincipal::authenticated_playout("verified-token-session");
    assert!(playout.allows(RequestType::Cue));
    assert!(playout.allows(RequestType::TakeOnline));
    assert!(playout.allows(RequestType::OutputConfigure));
}

#[test]
fn scene_commands_refuse_legacy_bare_scene_addressing() {
    let error = decode(
        r#"{
            "protocolVersion":3,"messageId":"m1","requestId":"r1","engineId":null,
            "timestampMs":0,"type":"playout.cue","requiresAck":true,"sequence":1,
            "direction":"client-to-engine","payload":{"sceneId":"collision-prone","sceneRevision":7}
        }"#,
        4096,
    )
    .expect_err("scene commands require canonical sceneRef");
    assert_eq!(error.code.as_str(), "INVALID_ENVELOPE");
}

#[test]
fn program_accepts_only_published_scene_refs() {
    let authoring = SceneRef {
        project_id: "project-a".to_string(),
        domain: SceneDomain::Authoring,
        scene_id: "lower-third".to_string(),
        revision: 7,
    };
    assert_eq!(
        authoring
            .require_published_for_program()
            .expect_err("authoring documents never reach Program")
            .code,
        ErrorCode::InvalidPayload
    );

    let published = SceneRef {
        domain: SceneDomain::Published,
        ..authoring
    };
    assert!(published.require_published_for_program().is_ok());
    assert_eq!(published.cache_key(), "9:project-a|9:published|11:lower-third|7");
    let same_id_elsewhere = SceneRef {
        project_id: "project-b".to_string(),
        revision: 8,
        ..published.clone()
    };
    assert_ne!(published.cache_key(), same_id_elsewhere.cache_key());
}
