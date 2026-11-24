//! 2.24: the asset plane verifies the control plane's gx1 credential on every connection's first
//! frame, and refuses by name, in the reply each request expects, one that has none, does not
//! verify, or lacks the scope the request needs.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use gx_asset_plane::auth::{enter, AssetAuth};
use gx_asset_plane::publish::{fetch_bytes, FetchError};
use gx_asset_plane::{
    content_hash, declared_locality, preview_scene, publish_scene, AssetBytes, AssetPublishPeer,
    AssetPublishServer, AssetTransferClient, AssetTransferClientError, LocalityReply, PreviewError,
    PreviewImage, PreviewJob, PublishRefusal, PublishReply,
};
use gx_contracts::auth::{Role, Scope};
use gx_contracts::scene::SceneDocument;
use gx_contracts::{ContentHash, Locality, Refusal, Revision, TakeId};
use gx_credential::Token;

const SECRET: &str = "asset-plane-auth-test-secret-0123456789";

fn credential(role: Role, scopes: Vec<Scope>) -> String {
    Token::mint("editor-1", role, scopes, SECRET)
        .unwrap()
        .as_str()
        .to_owned()
}

fn author() -> String {
    credential(Role::Editor, vec![Scope::Author])
}

fn scene() -> SceneDocument {
    serde_json::from_value(serde_json::json!({
        "version": gx_contracts::scene::SCENE_SCHEMA_VERSION,
        "id": "draft", "name": "draft", "workingColorSpace": "linear-srgb", "colorDepth": "32",
        "canvas": { "width": 4, "height": 2, "frameRate": { "num": 50, "den": 1 } },
        "timeline": { "durationFrames": 10, "channels": [] },
        "objects": []
    }))
    .expect("a minimal scene parses")
}

/// A peer that counts every request that reaches it, so a refusal can be shown to have stopped
/// before it.
struct Counting {
    reached: Arc<AtomicUsize>,
    held: ContentHash,
}

impl AssetPublishPeer for Counting {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
        self.reached.fetch_add(1, Ordering::SeqCst);
        PublishReply::Published {
            take_id: TakeId(scene.id),
            revision: Revision(1),
            content_hash: ContentHash("a".repeat(64)),
        }
    }
    fn locality(&self) -> Locality {
        self.reached.fetch_add(1, Ordering::SeqCst);
        Locality::CoLocated
    }
    fn fetch(&self, hash: &ContentHash) -> Option<Arc<Vec<u8>>> {
        self.reached.fetch_add(1, Ordering::SeqCst);
        (*hash == self.held).then(|| Arc::new(b"held bytes".to_vec()))
    }
    fn prepare_preview(
        &mut self,
        _scene: SceneDocument,
        _frame: u64,
    ) -> Result<PreviewJob, Refusal> {
        self.reached.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(|| {
            Ok(PreviewImage {
                width: 4,
                height: 2,
                png: b"png".to_vec(),
            })
        }))
    }
    fn has_verified_asset(&self, _hash: &ContentHash) -> bool {
        self.reached.fetch_add(1, Ordering::SeqCst);
        false
    }
}

fn peer() -> (Arc<Mutex<Counting>>, Arc<AtomicUsize>) {
    let reached = Arc::new(AtomicUsize::new(0));
    let peer = Arc::new(Mutex::new(Counting {
        reached: Arc::clone(&reached),
        held: content_hash(b"held bytes"),
    }));
    (peer, reached)
}

fn loopback() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

fn serve_protected() -> (SocketAddr, Arc<AtomicUsize>) {
    let (peer, reached) = peer();
    let server = AssetPublishServer::bind_authenticating(loopback(), peer, SECRET).unwrap();
    let address = server.local_addr().unwrap();
    let _ = server.serve_in_background();
    (address, reached)
}

fn refusal_of(reply: &PublishReply) -> Option<&Refusal> {
    match reply {
        PublishReply::Refused(PublishRefusal::AuthRefused { cause }) => Some(cause),
        _ => None,
    }
}

/// Every client function, called as it would be with no credential in scope.
/// With `locality` false, the engine's locality read is left out: a credential with no scope may make it.
fn requests_refused_as(address: SocketAddr, locality: bool, expect: impl Fn(&Refusal) -> bool) {
    let published = publish_scene(address, scene()).expect("a reply arrives");
    assert!(
        refusal_of(&published).is_some_and(&expect),
        "publish: {published:?}"
    );
    if locality {
        let locality = declared_locality(address).expect("a reply arrives");
        assert!(
            matches!(&locality, LocalityReply::Refused(PublishRefusal::AuthRefused { cause }) if expect(cause)),
            "locality: {locality:?}"
        );
    }
    match preview_scene(address, scene(), 0) {
        Err(PreviewError::Refused(cause)) => assert!(expect(&cause), "preview: {cause:?}"),
        other => panic!("preview: {other:?}"),
    }
    match fetch_bytes(address, &content_hash(b"held bytes")) {
        Err(FetchError::Refused(cause)) => assert!(expect(&cause), "fetch: {cause:?}"),
        other => panic!("fetch: {other:?}"),
    }
    let mut transfer = AssetTransferClient::connect(address).expect("connects");
    match transfer.preflight(gx_asset_plane::PreflightRequest {
        hashes: vec![content_hash(b"x")],
    }) {
        Err(AssetTransferClientError::Refused(cause)) => {
            assert!(expect(&cause), "transfer: {cause:?}")
        }
        other => panic!("transfer: {other:?}"),
    }
}

fn every_request_refused_as(address: SocketAddr, expect: impl Fn(&Refusal) -> bool) {
    requests_refused_as(address, true, expect);
}

#[test]
fn a_protected_listener_refuses_every_request_with_no_credential_by_name_and_reaches_no_peer() {
    let (address, reached) = serve_protected();
    every_request_refused_as(address, |cause| matches!(cause, Refusal::Unauthenticated));
    assert_eq!(
        reached.load(Ordering::SeqCst),
        0,
        "no refused request reached the peer"
    );
}

#[test]
fn a_credential_that_does_not_verify_is_refused_as_unauthenticated_and_never_echoed() {
    let (address, reached) = serve_protected();
    let other = Token::mint(
        "intruder",
        Role::Editor,
        vec![Scope::Author],
        "another-secret-0123456789abcdefghij",
    )
    .unwrap();
    let mut altered = author();
    altered.push('0');
    for bad in [
        other.as_str().to_owned(),
        altered,
        "not-a-credential".to_owned(),
    ] {
        let _credential = enter(bad.clone());
        every_request_refused_as(address, |cause| matches!(cause, Refusal::Unauthenticated));
        let reply = publish_scene(address, scene()).unwrap();
        assert!(
            !format!("{reply:?}").contains(&bad),
            "the credential was echoed"
        );
    }
    assert_eq!(reached.load(Ordering::SeqCst), 0);
}

#[test]
fn an_author_credential_makes_each_request_and_a_transfers_later_frames_need_none() {
    let (address, reached) = serve_protected();
    let _credential = enter(author());
    assert!(matches!(
        publish_scene(address, scene()).unwrap(),
        PublishReply::Published { .. }
    ));
    assert!(matches!(
        declared_locality(address).unwrap(),
        LocalityReply::Declared { .. }
    ));
    assert_eq!(preview_scene(address, scene(), 0).unwrap().png, b"png");
    assert_eq!(
        fetch_bytes(address, &content_hash(b"held bytes")).unwrap(),
        b"held bytes"
    );
    // One connection: the first frame carries the credential and was verified; the frames after
    // it (here the chunks, answered by the peer's own refusal) carry none and are not turned away.
    let mut transfer = AssetTransferClient::connect(address).unwrap();
    let asset = AssetBytes {
        hash: content_hash(b"asset"),
        bytes: b"asset".to_vec(),
    };
    match transfer.publish(&[asset]) {
        Err(AssetTransferClientError::Refused(Refusal::NotImplemented { .. })) => {}
        other => panic!("the peer's own answer, not an authentication one: {other:?}"),
    }
    assert!(
        reached.load(Ordering::SeqCst) >= 5,
        "each request reached the peer"
    );
}

#[test]
fn a_credential_without_the_author_scope_may_read_locality_and_nothing_else() {
    let (address, reached) = serve_protected();
    let _credential = enter(credential(Role::Editor, vec![]));
    assert!(matches!(
        declared_locality(address).unwrap(),
        LocalityReply::Declared { .. }
    ));
    assert_eq!(
        reached.load(Ordering::SeqCst),
        1,
        "only the locality read reached the peer"
    );
    requests_refused_as(address, false, |cause| {
        matches!(
            cause,
            Refusal::ScopeNotGranted {
                required: Some(Scope::Author),
                role: Role::Editor,
                ..
            }
        )
    });
}

#[test]
fn an_unprotected_listener_verifies_nothing_and_ignores_a_credential_it_is_sent() {
    let (peer, reached) = peer();
    let server = AssetPublishServer::bind(loopback(), peer).unwrap();
    let address = server.local_addr().unwrap();
    let _ = server.serve_in_background();
    assert!(matches!(
        publish_scene(address, scene()).unwrap(),
        PublishReply::Published { .. }
    ));
    let _credential = enter("gx1.whatever.not-checked");
    assert!(matches!(
        declared_locality(address).unwrap(),
        LocalityReply::Declared { .. }
    ));
    assert_eq!(reached.load(Ordering::SeqCst), 2);
}

#[test]
fn the_bind_policy_lets_only_an_authenticating_listener_leave_loopback() {
    let any = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
    let (peer, _) = peer();
    assert!(
        AssetPublishServer::bind(any, Arc::clone(&peer)).is_err(),
        "no secret, no network"
    );
    assert!(
        AssetPublishServer::bind_authenticating(any, Arc::clone(&peer), SECRET).is_ok(),
        "a secret lets it leave loopback"
    );
    let weak = AssetPublishServer::bind_authenticating(any, Arc::clone(&peer), "short")
        .err()
        .expect("a weak secret is refused");
    assert_eq!(weak.kind(), std::io::ErrorKind::PermissionDenied, "{weak}");
    assert!(AssetAuth::new("").is_err());
}
