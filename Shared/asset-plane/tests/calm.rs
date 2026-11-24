//! 3.24: while the engine sheds load, preparing a scene (a publication, a preview) waits at the
//! peer's calm gate, outside the peer's lock, so Program's cues and the locality read are never
//! queued behind it; a wait that runs out lets the work go on to be answered by the peer.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gx_asset_plane::{
    declared_locality, publish_scene, AssetPublishPeer, AssetPublishServer, CalmGate,
    LocalityReply, PublishReply,
};
use gx_contracts::scene::SceneDocument;
use gx_contracts::{ContentHash, Locality, Revision, TakeId};

/// A gate that is calm only after it is released, and records how long it was asked to wait.
struct Gate {
    released: AtomicBool,
    asked: AtomicUsize,
    longest_ask: Mutex<Duration>,
}

impl CalmGate for Gate {
    fn wait_until_calm(&self, most: Duration) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst);
        *self.longest_ask.lock().unwrap() = most;
        let until = Instant::now() + Duration::from_millis(400);
        while Instant::now() < until {
            if self.released.load(Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }
}

struct Peer {
    gate: Arc<Gate>,
    published: Arc<AtomicUsize>,
}

impl AssetPublishPeer for Peer {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
        self.published.fetch_add(1, Ordering::SeqCst);
        PublishReply::Published {
            take_id: TakeId(scene.id),
            revision: Revision(1),
            content_hash: ContentHash("a".repeat(64)),
        }
    }
    fn locality(&self) -> Locality {
        Locality::CoLocated
    }
    fn calm_gate(&self) -> Option<Arc<dyn CalmGate>> {
        Some(Arc::clone(&self.gate) as Arc<dyn CalmGate>)
    }
}

fn scene() -> SceneDocument {
    serde_json::from_value(serde_json::json!({
        "version": gx_contracts::scene::SCENE_SCHEMA_VERSION,
        "id": "draft", "name": "draft", "workingColorSpace": "linear-srgb", "colorDepth": "32",
        "canvas": { "width": 4, "height": 2, "frameRate": { "num": 50, "den": 1 } },
        "timeline": { "durationFrames": 10, "channels": [] },
        "objects": []
    }))
    .unwrap()
}

fn serve() -> (SocketAddr, Arc<Gate>, Arc<AtomicUsize>) {
    let gate = Arc::new(Gate {
        released: AtomicBool::new(false),
        asked: AtomicUsize::new(0),
        longest_ask: Mutex::new(Duration::ZERO),
    });
    let published = Arc::new(AtomicUsize::new(0));
    let peer = Arc::new(Mutex::new(Peer {
        gate: Arc::clone(&gate),
        published: Arc::clone(&published),
    }));
    let server =
        AssetPublishServer::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0), peer)
            .unwrap();
    let address = server.local_addr().unwrap();
    let _ = server.serve_in_background();
    (address, gate, published)
}

#[test]
fn a_publication_waits_at_the_gate_and_the_engine_is_free_meanwhile() {
    let (address, gate, published) = serve();
    let waiting = std::thread::spawn(move || publish_scene(address, scene()).unwrap());
    // While it waits, nothing reached the peer yet, and the locality read is answered at once:
    // the peer's lock is not held by the wait.
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(published.load(Ordering::SeqCst), 0, "still waiting");
    let started = Instant::now();
    assert!(matches!(
        declared_locality(address).unwrap(),
        LocalityReply::Declared { .. }
    ));
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "the locality read waited {:?}: the peer was held",
        started.elapsed()
    );
    // Released: the publication goes on and is answered.
    gate.released.store(true, Ordering::SeqCst);
    assert!(matches!(
        waiting.join().unwrap(),
        PublishReply::Published { .. }
    ));
    assert_eq!(published.load(Ordering::SeqCst), 1);
    assert_eq!(
        gate.asked.load(Ordering::SeqCst),
        1,
        "asked once, for the publication"
    );
    assert_eq!(
        *gate.longest_ask.lock().unwrap(),
        gx_asset_plane::MAX_CALM_WAIT,
        "the wait is bounded"
    );
}

#[test]
fn a_wait_that_runs_out_lets_the_work_go_on_and_the_locality_read_never_waits() {
    let (address, gate, published) = serve();
    // Never released: the gate gives up after 400 ms and the publication still goes through.
    let started = Instant::now();
    assert!(matches!(
        publish_scene(address, scene()).unwrap(),
        PublishReply::Published { .. }
    ));
    assert!(started.elapsed() >= Duration::from_millis(350));
    assert_eq!(published.load(Ordering::SeqCst), 1);
    // The locality read is not preparation: it never asks the gate.
    let asked = gate.asked.load(Ordering::SeqCst);
    declared_locality(address).unwrap();
    assert_eq!(gate.asked.load(Ordering::SeqCst), asked);
}
