//! The asset plane's credential (build plan 2.24).
//!
//! The control plane's gx1 credential (`gx-credential`), reused: one secret to configure on the
//! engine (`--token`), one kind of credential to hold. The asset plane has no long-lived
//! connection to authenticate, so a request's first frame carries the credential, the way it
//! carries its correlation id (2.13): an `auth` member the listener reads and removes before it
//! checks the request has exactly one member. A transfer's later frames ride the same connection
//! and carry nothing: the credential is verified once per connection.
//!
//! Who may do what: every request but the engine's locality read needs the **Author** scope
//! (publishing, packages, transfers, previews and the bytes of a preview are the Editor's
//! authoring path); the locality read, which a publisher makes before it knows anything, needs
//! any credential that verifies. A request with none, or one that does not verify, is refused
//! `Unauthenticated`; one that verifies without the scope it needs is refused `ScopeNotGranted`,
//! each in the reply type its request expects, so the client reads the refusal by name.
//!
//! A listener with no secret verifies nothing and listens on loopback only (the bind policy,
//! 2.21); a client holding a credential still sends it, and that listener ignores it.

use std::cell::RefCell;
use std::sync::Arc;

use gx_contracts::auth::{Role, Scope};
use gx_contracts::Refusal;
use gx_credential::Token;

/// The request-header member a credential travels in. Must match what the listener removes.
pub(crate) const CREDENTIAL_KEY: &str = "auth";

/// Where a process that holds a credential for the engine it publishes to keeps it
/// (the credential itself, made with the engine's secret, not the secret).
pub const CREDENTIAL_ENV: &str = "GX_ASSET_CREDENTIAL";

thread_local! {
    static CURRENT: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Puts the credential back as it was when it is dropped.
pub struct CredentialGuard {
    previous: Option<String>,
}

impl Drop for CredentialGuard {
    fn drop(&mut self) {
        CURRENT.with(|current| *current.borrow_mut() = self.previous.take());
    }
}

/// Work done while the guard lives sends `credential` on every asset-plane request this thread
/// makes. Scoped like a correlation id, so no public client function needs another argument.
pub fn enter(credential: impl Into<String>) -> CredentialGuard {
    let credential = credential.into();
    CredentialGuard {
        previous: CURRENT.with(|current| current.borrow_mut().replace(credential)),
    }
}

/// [`enter`] with the credential in [`CREDENTIAL_ENV`], if one is set and not empty.
pub fn enter_from_environment() -> Option<CredentialGuard> {
    std::env::var(CREDENTIAL_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(enter)
}

/// The credential this thread is working under.
pub fn current() -> Option<String> {
    CURRENT.with(|current| current.borrow().clone())
}

/// A gx1 credential is `gx1.<base64url>.<hex>`: letters, digits, `_`, `-` and `.`. Anything else
/// is not written, so the member never needs escaping and a bad value cannot break the frame.
fn is_writable(credential: &str) -> bool {
    !credential.is_empty()
        && credential
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// `request`, a JSON object, with `"auth":"<credential>"` added as its first member when there is
/// a credential to send.
pub(crate) fn with_credential(request: &[u8], credential: Option<&str>) -> Vec<u8> {
    match (credential, request.first(), request.get(1)) {
        (Some(credential), Some(b'{'), Some(next)) if is_writable(credential) => {
            let mut out = Vec::with_capacity(request.len() + credential.len() + 10);
            out.extend_from_slice(b"{\"");
            out.extend_from_slice(CREDENTIAL_KEY.as_bytes());
            out.extend_from_slice(b"\":\"");
            out.extend_from_slice(credential.as_bytes());
            out.push(b'"');
            if *next != b'}' {
                out.push(b',');
            }
            out.extend_from_slice(&request[1..]);
            out
        }
        _ => request.to_vec(),
    }
}

/// What a request needs from a credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Needs {
    /// Any credential that verifies: the locality read.
    AnyCredential,
    /// The Author scope: everything else.
    Author,
}

/// Who a verified credential says is calling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Caller {
    pub subject: String,
    pub role: Role,
}

/// The secret the asset plane verifies credentials against. Held by the listener, never logged,
/// and a listener cannot be built with an empty one.
#[derive(Clone)]
pub struct AssetAuth {
    secret: Arc<str>,
}

impl AssetAuth {
    pub fn new(secret: impl Into<String>) -> std::io::Result<Self> {
        let secret = secret.into();
        if secret.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "the asset plane needs a non-empty secret to verify credentials against",
            ));
        }
        Ok(Self {
            secret: Arc::from(secret),
        })
    }

    /// Whether `credential` lets its holder make a request that `needs` it, as a refusal if not.
    /// `request` names the request in a scope refusal.
    pub(crate) fn authorise(
        &self,
        credential: Option<&str>,
        needs: Needs,
        request: &'static str,
    ) -> Result<Caller, (Refusal, &'static str)> {
        let credential = credential.ok_or((Refusal::Unauthenticated, "noCredential"))?;
        let claims = Token::parse(credential)
            .and_then(|token| token.verify(self.secret.as_bytes()))
            .map_err(|error| (Refusal::Unauthenticated, error.fault_name()))?;
        if needs == Needs::Author && !claims.scopes.contains(&Scope::Author) {
            return Err((
                Refusal::ScopeNotGranted {
                    request: request.to_owned(),
                    required: Some(Scope::Author),
                    role: claims.role,
                },
                "scopeNotGranted",
            ));
        }
        Ok(Caller {
            subject: claims.subject,
            role: claims.role,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "asset-plane-test-secret-0123456789ab";

    fn credential(role: Role, scopes: Vec<Scope>) -> String {
        Token::mint("editor-1", role, scopes, SECRET)
            .unwrap()
            .as_str()
            .to_owned()
    }

    #[test]
    fn a_credential_rides_as_the_first_member_and_only_when_it_can_be_written_plainly() {
        let with = with_credential(br#"{"locality":{}}"#, Some("gx1.abc_-.def"));
        assert_eq!(with, br#"{"auth":"gx1.abc_-.def","locality":{}}"#.to_vec());
        let empty = with_credential(b"{}", Some("gx1.abc"));
        assert_eq!(empty, br#"{"auth":"gx1.abc"}"#.to_vec());
        for bad in ["", "has space", "quote\"inside", "new\nline", "back\\slash"] {
            assert_eq!(
                with_credential(b"{\"a\":1}", Some(bad)),
                b"{\"a\":1}".to_vec(),
                "{bad:?}"
            );
        }
        assert_eq!(with_credential(b"{\"a\":1}", None), b"{\"a\":1}".to_vec());
    }

    #[test]
    fn the_credential_a_thread_works_under_is_scoped_and_restored() {
        assert_eq!(current(), None);
        {
            let _outer = enter("gx1.outer");
            assert_eq!(current().as_deref(), Some("gx1.outer"));
            {
                let _inner = enter("gx1.inner");
                assert_eq!(current().as_deref(), Some("gx1.inner"));
            }
            assert_eq!(current().as_deref(), Some("gx1.outer"));
        }
        assert_eq!(current(), None);
    }

    #[test]
    fn authorise_names_what_is_wrong_and_who_is_calling() {
        let auth = AssetAuth::new(SECRET).unwrap();
        let author = credential(Role::Editor, vec![Scope::Author]);
        let nobody = credential(Role::Editor, vec![]);
        // Nothing, garbage, or made with another secret: unauthenticated.
        for bad in [None, Some("not-a-credential")] {
            let (refusal, _) = auth.authorise(bad, Needs::Author, "publish").unwrap_err();
            assert_eq!(refusal, Refusal::Unauthenticated);
        }
        let other = Token::mint(
            "x",
            Role::Editor,
            vec![Scope::Author],
            "another-secret-0123456789abcdefgh",
        )
        .unwrap();
        let (refusal, fault) = auth
            .authorise(Some(other.as_str()), Needs::Author, "publish")
            .unwrap_err();
        assert_eq!((refusal, fault), (Refusal::Unauthenticated, "macMismatch"));
        // A credential with no Author scope may read locality and nothing else.
        assert_eq!(
            auth.authorise(Some(&nobody), Needs::AnyCredential, "locality")
                .unwrap()
                .subject,
            "editor-1"
        );
        let (refusal, _) = auth
            .authorise(Some(&nobody), Needs::Author, "publish")
            .unwrap_err();
        assert_eq!(
            refusal,
            Refusal::ScopeNotGranted {
                request: "publish".into(),
                required: Some(Scope::Author),
                role: Role::Editor
            }
        );
        let caller = auth
            .authorise(Some(&author), Needs::Author, "publish")
            .unwrap();
        assert_eq!(
            caller,
            Caller {
                subject: "editor-1".into(),
                role: Role::Editor
            }
        );
    }

    #[test]
    fn the_listener_cannot_be_given_an_empty_secret() {
        assert!(AssetAuth::new("").is_err());
        assert!(AssetAuth::new("s").is_ok());
    }
}
