//! The asset plane's fit request (build plan 11.153): a closed envelope carrying a scene and records, a check run outside the peer's lock,
//! the report in one header, and named answers for a peer that checks nothing, a request that is not one, and a fault in the scene.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};

use gx_asset_plane::{fit_scene, AssetPublishPeer, AssetPublishServer, FitError, FitJob, PublishReply};
use gx_contracts::fit_report::{ElementFit, FitFailure, FitRecord, FitReport, FitRequest, FitResult, RecordFit};
use gx_contracts::scene::SceneDocument;
use gx_contracts::{Locality, Refusal};

fn scene() -> SceneDocument {
    serde_json::from_value(serde_json::json!({
        "version": gx_contracts::scene::SCENE_SCHEMA_VERSION,
        "id": "draft", "name": "Draft", "workingColorSpace": "linear-srgb", "colorDepth": "32",
        "canvas": { "width": 4, "height": 2, "frameRate": { "num": 50, "den": 1 } },
        "timeline": { "durationFrames": 10, "channels": [] },
        "objects": []
    }))
    .expect("a minimal scene parses")
}

fn record(id: &str) -> FitRecord {
    FitRecord { id: id.into(), values: serde_json::from_value(serde_json::json!({ "p": { "name": id } })).unwrap() }
}

fn request(ids: &[&str]) -> FitRequest {
    FitRequest { scene: scene(), records: ids.iter().map(|id| record(id)).collect() }
}

/// A peer that answers every record with Fits, except that "long" overflows, "boom" is a scene fault and "dup" is an invalid request;
/// it records whether its lock was held while the check ran.
struct Checking {
    lock_held_during_job: Arc<Mutex<Option<bool>>>,
    shared: Arc<Mutex<Option<Arc<Mutex<Checking>>>>>,
}

impl AssetPublishPeer for Checking {
    fn publish_scene(&mut self, _scene: SceneDocument) -> PublishReply {
        unreachable!("a fit check publishes nothing")
    }
    fn locality(&self) -> Locality {
        Locality::CoLocated
    }
    fn prepare_fit(&mut self, request: FitRequest) -> Result<FitJob, FitFailure> {
        let held = Arc::clone(&self.lock_held_during_job);
        let peer = Arc::clone(&self.shared);
        Ok(Box::new(move || {
            // The listener must not hold the peer while the job runs: this try_lock succeeds only if the peer's mutex is free.
            let free = peer.lock().unwrap().as_ref().is_some_and(|peer| peer.try_lock().is_ok());
            *held.lock().unwrap() = Some(!free);
            if request.records.iter().any(|record| record.id == "dup") {
                return Err(FitFailure::Invalid("record dup is named twice".into()));
            }
            if request.records.iter().any(|record| record.id == "boom") {
                return Err(FitFailure::Refused(Refusal::FontMissing { font_id: "font_x".into() }));
            }
            Ok(FitReport {
                records: request
                    .records
                    .iter()
                    .map(|record| RecordFit {
                        id: record.id.clone(),
                        elements: vec![ElementFit {
                            object_id: "name".into(),
                            fit: if record.id == "long" { FitResult::Overflows { by_px: 64.0, axis: gx_contracts::fit_report::FitAxis::Width, lines: 1 } } else { FitResult::Fits },
                        }],
                    })
                    .collect(),
            })
        }))
    }
}

/// A peer that checks nothing, as the default does.
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

fn checking() -> (SocketAddr, Arc<Mutex<Option<bool>>>) {
    let held = Arc::new(Mutex::new(None));
    let shared = Arc::new(Mutex::new(None));
    let peer = Arc::new(Mutex::new(Checking { lock_held_during_job: Arc::clone(&held), shared: Arc::clone(&shared) }));
    *shared.lock().unwrap() = Some(Arc::clone(&peer));
    (serve(peer), held)
}

#[test]
fn the_report_comes_back_whole_and_the_check_runs_without_the_peers_lock() {
    let (address, held) = checking();
    let report = fit_scene(address, request(&["1", "long", "3"])).expect("the check is made");
    assert_eq!(report.records.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), ["1", "long", "3"], "in the order asked");
    assert_eq!(report.tally(), (2, 1));
    assert!(matches!(report.records[1].elements[0].fit, FitResult::Overflows { by_px, .. } if by_px == 64.0));
    assert_eq!(*held.lock().unwrap(), Some(false), "the check ran without the peer's lock held (invariant 14)");
}

#[test]
fn a_peer_that_checks_nothing_refuses_by_name() {
    let address = serve(Arc::new(Mutex::new(Mute)));
    match fit_scene(address, request(&["1"])) {
        Err(FitError::Refused(Refusal::NotImplemented { what })) => assert!(what.contains("checks no records"), "{what}"),
        other => panic!("expected a named NotImplemented refusal, got {other:?}"),
    }
}

#[test]
fn a_scene_fault_and_a_request_that_is_not_one_are_kept_apart() {
    let (address, _) = checking();
    assert!(matches!(fit_scene(address, request(&["boom"])), Err(FitError::Refused(Refusal::FontMissing { .. }))));
    match fit_scene(address, request(&["dup"])) {
        Err(FitError::Invalid(detail)) => assert!(detail.contains("named twice"), "{detail}"),
        other => panic!("expected an invalid request, got {other:?}"),
    }
}

/// Send a raw frame and read the reply header as text.
fn raw(address: SocketAddr, body: serde_json::Value) -> String {
    let mut stream = TcpStream::connect(address).unwrap();
    let bytes = body.to_string().into_bytes();
    stream.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
    stream.write_all(&bytes).unwrap();
    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix).unwrap();
    let mut header = vec![0; u32::from_be_bytes(prefix) as usize];
    stream.read_exact(&mut header).unwrap();
    String::from_utf8(header).unwrap()
}

#[test]
fn the_envelope_is_closed() {
    let (address, _) = checking();
    // A member that is not a fit request, an unknown field in a record, and two members at once are each refused by name.
    let bad_record = raw(address, serde_json::json!({ "fit": { "scene": scene(), "records": [{ "id": "1", "values": {}, "extra": 1 }] } }));
    assert!(bad_record.contains("invalidRequest") && bad_record.contains("fit request"), "{bad_record}");
    let missing = raw(address, serde_json::json!({ "fit": { "scene": scene() } }));
    assert!(missing.contains("invalidRequest"), "{missing}");
    let two = raw(address, serde_json::json!({ "fit": { "scene": scene(), "records": [] }, "locality": {} }));
    assert!(two.contains("exactly one of") && two.contains("`fit`"), "{two}");
}
