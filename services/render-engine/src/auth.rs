//! Access-token verification and the permission tables.
//!
//! The Rust half of a specification written once in `Shared/auth-contract`. The TypeScript
//! side mints tokens and owns accounts; this side only ever *verifies*, because the engine
//! must never be able to issue authority to itself.
//!
//! ## The format, restated so this file can be audited alone
//!
//! ```text
//! gx1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "gx1." + payload))>
//! ```
//!
//! There is no algorithm field. `gx1` *is* the algorithm, fixed here at parse time, so the
//! JWT failure modes - `alg: none`, RS/HS confusion - are structurally absent rather than
//! defended against. A future format would be a different prefix and a different verifier.
//!
//! ## Why the engine checks permissions at all
//!
//! It already checks a role at the transport boundary. A role is what a connection *is*; a
//! permission is what a request *needs*. Checking only the former means every future request
//! type silently inherits whatever its role already had. `permission_for_request` is
//! exhaustive and returns `Unknown` for anything it does not recognise, so a new protocol
//! verb is refused until somebody classifies it.

use std::collections::BTreeSet;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const TOKEN_PREFIX: &str = "gx1";

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------

/// The three account roles. Distinct from `ConnectionRole`, which is the product identity of
/// a link; a Playout Operator and an Admin both drive a Playout connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UserRole {
    Admin,
    Editor,
    PlayoutOperator,
}

impl UserRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Editor => "editor",
            Self::PlayoutOperator => "playout-operator",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "admin" => Some(Self::Admin),
            "editor" => Some(Self::Editor),
            "playout-operator" => Some(Self::PlayoutOperator),
            _ => None,
        }
    }
}

/// What a request needs. Mirrors `Permission` in `Shared/auth-contract/src/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    SceneRead,
    SceneWrite,
    ScenePublish,
    StageWrite,
    AssetWrite,
    EditorView,
    PlayoutPreview,
    PlayoutProgram,
    OutputManage,
    EngineConfigure,
    EngineDiagnose,
    UserManage,
    AuditRead,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SceneRead => "scene.read",
            Self::SceneWrite => "scene.write",
            Self::ScenePublish => "scene.publish",
            Self::StageWrite => "stage.write",
            Self::AssetWrite => "asset.write",
            Self::EditorView => "editor.view",
            Self::PlayoutPreview => "playout.preview",
            Self::PlayoutProgram => "playout.program",
            Self::OutputManage => "output.manage",
            Self::EngineConfigure => "engine.configure",
            Self::EngineDiagnose => "engine.diagnose",
            Self::UserManage => "user.manage",
            Self::AuditRead => "audit.read",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "scene.read" => Some(Self::SceneRead),
            "scene.write" => Some(Self::SceneWrite),
            "scene.publish" => Some(Self::ScenePublish),
            "stage.write" => Some(Self::StageWrite),
            "asset.write" => Some(Self::AssetWrite),
            "editor.view" => Some(Self::EditorView),
            "playout.preview" => Some(Self::PlayoutPreview),
            "playout.program" => Some(Self::PlayoutProgram),
            "output.manage" => Some(Self::OutputManage),
            "engine.configure" => Some(Self::EngineConfigure),
            "engine.diagnose" => Some(Self::EngineDiagnose),
            "user.manage" => Some(Self::UserManage),
            "audit.read" => Some(Self::AuditRead),
            _ => None,
        }
    }
}

/// What a wire verb requires.
///
/// Three answers, not two. `None` means connection housekeeping, answered before authority
/// exists. `Unknown` means this build has never heard of the verb - refused, because treating
/// an unrecognised message as unprivileged is how a protocol addition becomes an authority
/// hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredPermission {
    None,
    Needs(Permission),
    Unknown,
}

/// Wire verb to required permission. Exhaustive over `RequestType`'s wire strings.
pub fn permission_for_request(request: &str) -> RequiredPermission {
    use Permission::*;
    match request {
        "connection.hello"
        | "connection.authenticate"
        | "connection.heartbeat"
        | "connection.capabilities"
        | "connection.disconnect" => RequiredPermission::None,

        "stage.load" | "stage.unload" => RequiredPermission::Needs(StageWrite),

        "scene.load" | "scene.unload" | "scene.validate" | "scene.prepare" => {
            RequiredPermission::Needs(SceneRead)
        }
        "scene.fullSync" | "scene.applyPatch" => RequiredPermission::Needs(SceneWrite),

        "asset.register" | "asset.upload" | "asset.validate" | "asset.preload"
        | "asset.release" => RequiredPermission::Needs(AssetWrite),

        "playout.cue" => RequiredPermission::Needs(PlayoutPreview),
        "playout.takeOnline"
        | "playout.takeOffline"
        | "playout.continue"
        | "playout.update"
        | "playout.stop"
        | "playout.clear"
        | "playout.replace"
        | "playout.transition" => RequiredPermission::Needs(PlayoutProgram),

        "preview.request" | "preview.streamStart" | "preview.streamStop"
        | "preview.setViewport" => RequiredPermission::Needs(PlayoutPreview),

        "editor.view.request" => RequiredPermission::Needs(EditorView),

        "engine.getStatus" | "engine.getDiagnostics" | "engine.getCapabilities"
        | "output.list" => RequiredPermission::Needs(EngineDiagnose),
        "engine.setConfiguration" | "engine.restartRenderer" => {
            RequiredPermission::Needs(EngineConfigure)
        }
        "output.configure" | "output.start" | "output.stop" | "output.remove" => {
            RequiredPermission::Needs(OutputManage)
        }

        // Attaching a live After Effects container puts a frame source behind Program, so it is an
        // output-management act rather than a diagnostic one. `PlayoutProgram` would be wrong: this
        // does not put anything on air, it decides what Program's pixels can come from.
        "ae.container.load" | "ae.container.unload" => RequiredPermission::Needs(OutputManage),

        _ => RequiredPermission::Unknown,
    }
}

/// The permissions a role carries, when a token does not narrow them further.
pub fn permissions_for_role(role: UserRole) -> BTreeSet<Permission> {
    use Permission::*;
    let list: &[Permission] = match role {
        UserRole::Admin => &[
            SceneRead,
            SceneWrite,
            ScenePublish,
            StageWrite,
            AssetWrite,
            EditorView,
            PlayoutPreview,
            PlayoutProgram,
            OutputManage,
            EngineConfigure,
            EngineDiagnose,
            UserManage,
            AuditRead,
        ],
        UserRole::Editor => &[
            SceneRead,
            SceneWrite,
            ScenePublish,
            StageWrite,
            AssetWrite,
            EditorView,
            EngineDiagnose,
        ],
        UserRole::PlayoutOperator => &[
            SceneRead,
            AssetWrite,
            PlayoutPreview,
            PlayoutProgram,
            OutputManage,
            EngineDiagnose,
        ],
    };
    list.iter().copied().collect()
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/// The claims an access token carries. Field names are the wire names, kept short because
/// this travels on every connection.
#[derive(Debug, Clone, Deserialize)]
pub struct AccessClaims {
    pub sub: String,
    pub usr: String,
    pub role: String,
    #[serde(default)]
    pub perms: Vec<String>,
    pub sid: String,
    pub typ: String,
    pub exp: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    UnsupportedVersion,
    BadSignature,
    Expired,
    WrongType,
    UnknownRole,
}

impl TokenError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "token is malformed",
            Self::UnsupportedVersion => "token version is not supported by this engine",
            Self::BadSignature => "token signature does not verify",
            Self::Expired => "token has expired",
            Self::WrongType => "a refresh token cannot open a connection; use an access token",
            Self::UnknownRole => "token names a role this engine does not implement",
        }
    }
}

/// A verified identity, ready to become a `ConnectionPrincipal`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIdentity {
    pub user_id: String,
    pub username: String,
    pub role: UserRole,
    pub session_id: String,
    pub permissions: BTreeSet<Permission>,
}

impl VerifiedIdentity {
    pub fn allows(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }
}

/// Verify a token against the signing key and return the identity it carries.
///
/// `now_seconds` is passed in rather than read here so the expiry rule is testable without
/// sleeping, and so a single request cannot observe two different clocks.
pub fn verify_access_token(
    token: &str,
    key: &[u8],
    now_seconds: u64,
) -> Result<VerifiedIdentity, TokenError> {
    let mut parts = token.split('.');
    let version = parts.next().ok_or(TokenError::Malformed)?;
    let payload = parts.next().ok_or(TokenError::Malformed)?;
    let signature = parts.next().ok_or(TokenError::Malformed)?;
    if parts.next().is_some() {
        return Err(TokenError::Malformed);
    }
    if version != TOKEN_PREFIX {
        return Err(TokenError::UnsupportedVersion);
    }
    if payload.is_empty() || signature.is_empty() {
        return Err(TokenError::Malformed);
    }

    // Signature before parsing: a forged token must never reach the JSON parser carrying a
    // structure of the attacker's choosing.
    let signing_input = format!("{version}.{payload}");
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| TokenError::BadSignature)?;
    mac.update(signing_input.as_bytes());
    let presented = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| TokenError::Malformed)?;
    // `verify_slice` is constant time and length-checked.
    mac.verify_slice(&presented)
        .map_err(|_| TokenError::BadSignature)?;

    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| TokenError::Malformed)?;
    let claims: AccessClaims =
        serde_json::from_slice(&decoded).map_err(|_| TokenError::Malformed)?;

    if claims.typ != "access" {
        return Err(TokenError::WrongType);
    }
    if claims.exp <= now_seconds {
        return Err(TokenError::Expired);
    }
    let role = UserRole::parse(&claims.role).ok_or(TokenError::UnknownRole)?;

    // A token may narrow what its role carries, never widen it. The intersection is taken
    // here so a tampered-but-somehow-valid permission list still cannot exceed the role, and
    // so an engine running ahead of the issuer never honours a permission it does not know.
    let role_permissions = permissions_for_role(role);
    let permissions: BTreeSet<Permission> = claims
        .perms
        .iter()
        .filter_map(|name| Permission::parse(name))
        .filter(|permission| role_permissions.contains(permission))
        .collect();

    Ok(VerifiedIdentity {
        user_id: claims.sub,
        username: claims.usr,
        role,
        session_id: claims.sid,
        permissions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built with the TypeScript signer; see `Shared/auth-contract/tests/conformance.test.mjs`,
    /// which regenerates and checks these exact bytes. Two implementations, one specification.
    const FIXTURE_KEY: &str = "grapix-conformance-signing-secret-0123456789";

    fn sign_for_test(payload_json: &str, key: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
        let signing_input = format!("{TOKEN_PREFIX}.{payload}");
        let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("key");
        mac.update(signing_input.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{signing_input}.{signature}")
    }

    #[test]
    fn a_valid_token_yields_its_identity() {
        let token = sign_for_test(
            r#"{"sub":"usr_1","usr":"ada","role":"editor","perms":["scene.write","editor.view"],"sid":"sess_1","typ":"access","iat":1000,"exp":9999999999}"#,
            FIXTURE_KEY,
        );
        let identity =
            verify_access_token(&token, FIXTURE_KEY.as_bytes(), 1_000).expect("verifies");
        assert_eq!(identity.user_id, "usr_1");
        assert_eq!(identity.username, "ada");
        assert_eq!(identity.role, UserRole::Editor);
        assert!(identity.allows(Permission::SceneWrite));
        assert!(!identity.allows(Permission::PlayoutProgram));
    }

    #[test]
    fn a_tampered_payload_is_refused() {
        let token = sign_for_test(
            r#"{"sub":"usr_1","usr":"ada","role":"editor","perms":[],"sid":"s","typ":"access","iat":1,"exp":9999999999}"#,
            FIXTURE_KEY,
        );
        // Re-encode a payload claiming admin, keeping the original signature.
        let forged_payload = URL_SAFE_NO_PAD.encode(
            r#"{"sub":"usr_1","usr":"ada","role":"admin","perms":["playout.program"],"sid":"s","typ":"access","iat":1,"exp":9999999999}"#,
        );
        let signature = token.rsplit('.').next().expect("signature");
        let forged = format!("{TOKEN_PREFIX}.{forged_payload}.{signature}");
        assert_eq!(
            verify_access_token(&forged, FIXTURE_KEY.as_bytes(), 1_000),
            Err(TokenError::BadSignature)
        );
    }

    #[test]
    fn a_token_cannot_grant_more_than_its_role() {
        // The issuer would never mint this, so the only way it exists is tampering with a key
        // that was also stolen - but defence in depth costs one `filter` here.
        let token = sign_for_test(
            r#"{"sub":"u","usr":"n","role":"editor","perms":["scene.write","playout.program","user.manage"],"sid":"s","typ":"access","iat":1,"exp":9999999999}"#,
            FIXTURE_KEY,
        );
        let identity =
            verify_access_token(&token, FIXTURE_KEY.as_bytes(), 1_000).expect("verifies");
        assert!(identity.allows(Permission::SceneWrite));
        assert!(!identity.allows(Permission::PlayoutProgram));
        assert!(!identity.allows(Permission::UserManage));
    }

    #[test]
    fn an_expired_token_is_refused() {
        let token = sign_for_test(
            r#"{"sub":"u","usr":"n","role":"admin","perms":[],"sid":"s","typ":"access","iat":1,"exp":100}"#,
            FIXTURE_KEY,
        );
        assert_eq!(
            verify_access_token(&token, FIXTURE_KEY.as_bytes(), 101),
            Err(TokenError::Expired)
        );
    }

    #[test]
    fn a_refresh_token_cannot_open_a_connection() {
        let token = sign_for_test(
            r#"{"sub":"u","sid":"s","typ":"refresh","usr":"n","role":"admin","iat":1,"exp":9999999999}"#,
            FIXTURE_KEY,
        );
        assert_eq!(
            verify_access_token(&token, FIXTURE_KEY.as_bytes(), 1_000),
            Err(TokenError::WrongType)
        );
    }

    #[test]
    fn an_unknown_verb_is_never_unprivileged() {
        assert_eq!(
            permission_for_request("evil.newVerb"),
            RequiredPermission::Unknown
        );
        assert_eq!(
            permission_for_request("connection.hello"),
            RequiredPermission::None
        );
        assert_eq!(
            permission_for_request("playout.takeOnline"),
            RequiredPermission::Needs(Permission::PlayoutProgram)
        );
    }

    #[test]
    fn the_role_tables_match_the_documented_split() {
        let editor = permissions_for_role(UserRole::Editor);
        assert!(editor.contains(&Permission::SceneWrite));
        assert!(!editor.contains(&Permission::PlayoutProgram));

        let operator = permissions_for_role(UserRole::PlayoutOperator);
        assert!(operator.contains(&Permission::PlayoutProgram));
        assert!(!operator.contains(&Permission::SceneWrite));

        // Admin is the union: every permission any other role has, plus the administrative
        // ones. A hand-maintained list would drift; this asserts the superset property.
        let admin = permissions_for_role(UserRole::Admin);
        for permission in editor.iter().chain(operator.iter()) {
            assert!(admin.contains(permission), "admin must include {permission:?}");
        }
        assert!(admin.contains(&Permission::UserManage));
    }
}
