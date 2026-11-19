//! The asset plane's preview request (build plan 11.65): a closed envelope, a
//! render run outside the peer's lock, named refusals, and an image the client
//! re-hashes before it hands it back.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gx_asset_plane::{
    content_hash, preview_scene, AssetPublishPeer, AssetPublishServer, PreviewError, PreviewImage,
    PreviewJob, PreviewReply, PublishClientError, PublishReply,
};
use gx_contracts::scene::SceneDocument;
use gx_contracts::{Locality, Refusal};

fn scene(name: &str) -> SceneDocument {
    serde_json::from_value(serde_json::json!({
        "version": gx_contracts::scene::SCENE_SCHEMA_VERSION,
        "id": "draft", "name": name, "workingColorSpace": "linear-srgb",
        "canvas": { "width": 4, "height": 2, "frameRate": { "num": 50, "den": 1 } },
        "timeline": { "durationFrames": 10, "channels": [] },
        "objects": []
    }))
    .expect("a minimal scene parses")
}

/// A peer that draws a tiny "image" naming the scene and frame, and records
/// whether its lock was held while the job ran.
struct Drawing {
    lock_held_during_job: Arc<Mutex<Option<bool>>>,
    shared: Arc<Mutex<Option<Arc<Mutex<Drawing>>>>>,
}

impl AssetPublishPeer for Drawing {
    fn publish_scene(&mut self, _scene: SceneDocument) -> PublishReply {
        unreachable!("a preview publishes nothing")
    }
    fn locality(&self) -> Locality {
        Locality::CoLocated
    }
    fn prepare_preview(&mut self, scene: SceneDocument, frame: u64) -> Result<PreviewJob, Refusal> {
        if frame > 10 {
            return Err(Refusal::RenderFrameOutOfRange {
                take_id: gx_contracts::TakeId(scene.id.clone()),
                revision: gx_contracts::Revision(0),
                frame,
                duration_frames: 10,
            });
        }
        let held = Arc::clone(&self.lock_held_during_job);
        let peer = Arc::clone(&self.shared);
        Ok(Box::new(move || {
            // The listener must not hold the peer while the job runs: this try_lock
            // succeeds only if the peer's mutex is free.
            let free = peer
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|peer| peer.try_lock().is_ok());
            *held.lock().unwrap() = Some(!free);
            Ok(PreviewImage {
                width: 4,
                height: 2,
                png: format!("{}@{frame}", scene.name).into_bytes(),
            })
        }))
    }
}

/// A peer that draws nothing, as the default does.
struct Mute;
impl AssetPublishPeer for Mute {
    fn publish_scene(&mut self, _scene: SceneDocument) -> PublishReply {
        unreachable!()
    }
    fn locality(&self) -> Locality {
        Locality::CoLocated
    }
}

fn serve<P: AssetPublishPeer>(peer: Arc<Mutex<P>>) -> SocketAddr {
    let server = AssetPublishServer::bind("127.0.0.1:0".parse().unwrap(), peer).unwrap();
    let address = server.local_addr().unwrap();
    let _ = server.serve_in_background();
    address
}

#[test]
fn a_draft_is_drawn_and_the_image_comes_back_whole() {
    let held = Arc::new(Mutex::new(None));
    let shared = Arc::new(Mutex::new(None));
    let peer = Arc::new(Mutex::new(Drawing {
        lock_held_during_job: Arc::clone(&held),
        shared: Arc::clone(&shared),
    }));
    *shared.lock().unwrap() = Some(Arc::clone(&peer));
    let address = serve(peer);

    let image = preview_scene(address, scene("lower third"), 7).expect("the draft is drawn");
    assert_eq!((image.width, image.height), (4, 2));
    assert_eq!(image.png, b"lower third@7");
    assert_eq!(
        *held.lock().unwrap(),
        Some(false),
        "the render ran without the peer's lock held (invariant 14)"
    );
}

#[test]
fn a_peer_that_draws_nothing_refuses_by_name() {
    let address = serve(Arc::new(Mutex::new(Mute)));
    match preview_scene(address, scene("x"), 0) {
        Err(PreviewError::Refused(Refusal::NotImplemented { what })) => {
            assert!(what.contains("renders no previews"), "{what}");
        }
        other => panic!("expected a named NotImplemented refusal, got {other:?}"),
    }
}

#[test]
fn a_peers_own_refusal_reaches_the_client_by_name() {
    let held = Arc::new(Mutex::new(None));
    let shared = Arc::new(Mutex::new(None));
    let peer = Arc::new(Mutex::new(Drawing {
        lock_held_during_job: held,
        shared,
    }));
    let address = serve(peer);
    match preview_scene(address, scene("x"), 99) {
        Err(PreviewError::Refused(Refusal::RenderFrameOutOfRange {
            frame: 99,
            duration_frames: 10,
            ..
        })) => {}
        other => panic!("expected RenderFrameOutOfRange, got {other:?}"),
    }
}

/// Send one raw framed request and read the reply header.
fn raw(address: SocketAddr, body: &[u8]) -> PreviewReply {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .write_all(&(body.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(body).unwrap();
    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix).unwrap();
    let mut header = vec![0; u32::from_be_bytes(prefix) as usize];
    stream.read_exact(&mut header).unwrap();
    serde_json::from_slice(&header).expect("a preview reply")
}

#[test]
fn the_envelope_is_closed_an_unknown_field_is_not_a_side_channel() {
    let address = serve(Arc::new(Mutex::new(Mute)));
    let body = serde_json::json!({ "preview": { "scene": scene("x"), "frame": 0, "extra": true } });
    match raw(address, body.to_string().as_bytes()) {
        PreviewReply::InvalidRequest { detail } => {
            assert!(detail.contains("preview request"), "{detail}")
        }
        other => panic!("expected InvalidRequest, got {other:?}"),
    }
    // Missing the frame is refused the same way.
    let body = serde_json::json!({ "preview": { "scene": scene("x") } });
    assert!(matches!(
        raw(address, body.to_string().as_bytes()),
        PreviewReply::InvalidRequest { .. }
    ));
}

#[test]
fn a_request_with_two_members_is_refused() {
    let address = serve(Arc::new(Mutex::new(Mute)));
    let body = serde_json::json!({
        "preview": { "scene": scene("x"), "frame": 0 },
        "locality": {}
    });
    // Two members are not a request: the one-member rule holds for the new dialect too.
    let mut stream = TcpStream::connect(address).unwrap();
    let bytes = body.to_string().into_bytes();
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(&bytes).unwrap();
    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix).unwrap();
    let mut header = vec![0; u32::from_be_bytes(prefix) as usize];
    stream.read_exact(&mut header).unwrap();
    let text = String::from_utf8(header).unwrap();
    assert!(text.contains("exactly one of"), "{text}");
    assert!(
        text.contains("`preview`"),
        "the message names the new member: {text}"
    );
}

/// A fake engine that answers a preview with bytes that are not the bytes its
/// header names.
fn lying_engine() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut prefix = [0_u8; 4];
        stream.read_exact(&mut prefix).unwrap();
        let mut request = vec![0; u32::from_be_bytes(prefix) as usize];
        stream.read_exact(&mut request).unwrap();
        let header = serde_json::to_vec(&PreviewReply::Image {
            width: 4,
            height: 2,
            hash: content_hash(b"the real picture"),
            byte_len: 12,
        })
        .unwrap();
        stream
            .write_all(&(header.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(&header).unwrap();
        stream.write_all(b"not the image").unwrap();
        stream.flush().unwrap();
        std::thread::sleep(Duration::from_millis(200));
    });
    address
}

#[test]
fn bytes_that_do_not_hash_to_what_the_reply_named_are_refused_never_returned() {
    match preview_scene(lying_engine(), scene("x"), 0) {
        Err(PreviewError::Refused(Refusal::AssetHashMismatch { .. })) => {}
        other => panic!("expected AssetHashMismatch, got {other:?}"),
    }
}

#[test]
fn an_engine_that_is_not_listening_is_a_client_error_not_a_refusal() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    match preview_scene(address, scene("x"), 0) {
        Err(PreviewError::Client(PublishClientError::Connect(_))) => {}
        other => panic!("expected a connect error, got {other:?}"),
    }
}
