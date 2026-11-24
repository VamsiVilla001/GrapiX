//! 2.24: a transfer cut part way resumes from its last whole chunk, and the client retries with a
//! growing wait; a duplicate upload, concurrent or repeated, is answered and counted once; and a
//! reset or an end of stream is a transport error, not a protocol failure.
//!
//! Every "cut" below is a real connection killed by a proxy between a real client and a real
//! listener, not a mock of either.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

use gx_asset_plane::{
    is_transport_failure, AssetBytes, AssetStore, AssetTransferClient, AssetTransferClientError,
    AssetTransferMetrics, AssetTransferReply, AssetTransferRequest, AssetTransferServer,
    RetryPolicy, ASSET_TRANSFER_CHUNK_BYTES,
};
use gx_contracts::{ContentHash, Refusal};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "gx-asset-resume-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

struct Receiver {
    address: SocketAddr,
    metrics: AssetTransferMetrics,
    store: Arc<Mutex<AssetStore>>,
}

fn receiver() -> Receiver {
    let store = Arc::new(Mutex::new(AssetStore::at_root(directory())));
    let server = AssetTransferServer::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        Arc::clone(&store),
    )
    .unwrap();
    let address = server.local_addr().unwrap();
    let metrics = server.metrics();
    server.serve_in_background();
    Receiver {
        address,
        metrics,
        store,
    }
}

impl Receiver {
    fn holds(&self, hash: &ContentHash) -> bool {
        self.store.lock().unwrap().contains(hash).unwrap()
    }
}

/// `chunks` whole chunks and a short last one, none of them alike.
fn asset(seed: u8, chunks: usize) -> AssetBytes {
    let length = chunks * ASSET_TRANSFER_CHUNK_BYTES + 100;
    AssetBytes::from_bytes(
        (0..length)
            .map(|i| (i as u8).wrapping_mul(7).wrapping_add(seed))
            .collect(),
    )
}

fn quick(retries: u32) -> RetryPolicy {
    RetryPolicy {
        retries,
        first_delay: Duration::from_millis(5),
        longest_delay: Duration::from_millis(40),
    }
}

/// A proxy that kills the first `cuts` connections after they have sent `cut_after` bytes
/// towards the receiver, and forwards every later one whole. It counts the connections it saw.
struct Proxy {
    address: SocketAddr,
    connections: Arc<AtomicUsize>,
}

fn proxy(target: SocketAddr, cut_after: usize, cuts: usize) -> Proxy {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let connections = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&connections);
    thread::spawn(move || {
        for client in listener.incoming() {
            let Ok(mut client) = client else { return };
            let number = seen.fetch_add(1, Ordering::SeqCst);
            let Ok(mut server) = TcpStream::connect(target) else {
                return;
            };
            let (mut client_back, mut server_back) =
                (client.try_clone().unwrap(), server.try_clone().unwrap());
            // The receiver's replies go back whole.
            thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                while let Ok(n) = server_back.read(&mut buffer) {
                    if n == 0 || client_back.write_all(&buffer[..n]).is_err() {
                        break;
                    }
                }
            });
            let cut = number < cuts;
            thread::spawn(move || {
                let mut sent = 0usize;
                let mut buffer = [0u8; 8192];
                while let Ok(n) = client.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    let allowed = if cut {
                        cut_after.saturating_sub(sent)
                    } else {
                        n
                    };
                    let take = n.min(allowed);
                    if take > 0 && server.write_all(&buffer[..take]).is_err() {
                        break;
                    }
                    sent += take;
                    if cut && sent >= cut_after {
                        // The connection dies here, in the middle of whatever was in flight.
                        let _ = client.shutdown(Shutdown::Both);
                        let _ = server.shutdown(Shutdown::Both);
                        return;
                    }
                }
            });
        }
    });
    Proxy {
        address,
        connections,
    }
}

// --- the raw dialect, for the cases a client would never send ---

fn send(stream: &mut TcpStream, request: &AssetTransferRequest) {
    let bytes = serde_json::to_vec(request).unwrap();
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(&bytes).unwrap();
}

fn receive(stream: &mut TcpStream) -> AssetTransferReply {
    let mut prefix = [0u8; 4];
    stream.read_exact(&mut prefix).unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(prefix) as usize];
    stream.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn ask(stream: &mut TcpStream, request: AssetTransferRequest) -> AssetTransferReply {
    send(stream, &request);
    receive(stream)
}

fn begin(hash: &ContentHash, total_chunks: u32) -> AssetTransferRequest {
    AssetTransferRequest::Begin {
        hash: hash.clone(),
        total_chunks,
    }
}

fn chunk(hash: &ContentHash, index: u32, bytes: &[u8]) -> AssetTransferRequest {
    AssetTransferRequest::Chunk {
        hash: hash.clone(),
        index,
        bytes: bytes.to_vec(),
    }
}

fn pieces(asset: &AssetBytes) -> Vec<Vec<u8>> {
    asset
        .bytes
        .chunks(ASSET_TRANSFER_CHUNK_BYTES)
        .map(<[u8]>::to_vec)
        .collect()
}

fn a_hash(n: u32) -> ContentHash {
    ContentHash(format!("{n:064x}"))
}

// --- resume ---

#[test]
fn a_transfer_cut_part_way_resumes_from_its_last_whole_chunk() {
    let receiver = receiver();
    let asset = asset(1, 6);
    // Each chunk is about 250 KB of JSON: this kills the first connection a little past its
    // second whole chunk.
    let proxy = proxy(receiver.address, 700_000, 1);
    let mut client = AssetTransferClient::connect(proxy.address)
        .unwrap()
        .with_retry(quick(3));
    let summary = client.publish(std::slice::from_ref(&asset)).unwrap();
    assert!(
        summary.transferred_bytes <= asset.bytes.len() as u64,
        "the client did not send the chunks the receiver already held again (sent {} of {})",
        summary.transferred_bytes,
        asset.bytes.len()
    );

    assert!(
        receiver.holds(&asset.hash),
        "the asset arrived and verified"
    );
    assert_eq!(
        receiver.metrics.received_asset_bytes(),
        asset.bytes.len() as u64,
        "every byte crossed once: the resume skipped the chunks already held, it did not resend them"
    );
    assert_eq!(
        proxy.connections.load(Ordering::SeqCst),
        2,
        "one connection killed, one redial"
    );
}

#[test]
fn without_a_retry_the_cut_is_a_transport_error_and_the_chunks_stay_for_the_next_connection() {
    let receiver = receiver();
    let asset = asset(2, 6);
    let proxy = proxy(receiver.address, 700_000, 1);
    let mut client = AssetTransferClient::connect(proxy.address)
        .unwrap()
        .with_retry(RetryPolicy::none());
    let error = client.publish(std::slice::from_ref(&asset)).unwrap_err();
    assert!(
        matches!(error, AssetTransferClientError::Transport(_)),
        "a killed connection is a transport error: {error:?}"
    );
    assert!(error.is_transport());
    assert!(
        !receiver.holds(&asset.hash),
        "nothing is promoted unverified"
    );

    // A new connection, asking where the transfer stands, is told: after the whole chunks.
    let mut raw = TcpStream::connect(receiver.address).unwrap();
    let AssetTransferReply::Started { resume_from, .. } = ask(&mut raw, begin(&asset.hash, 7))
    else {
        panic!("Begin is answered by Started");
    };
    assert!(
        (1..7).contains(&resume_from),
        "resumes part way, not at 0 and not at the end: {resume_from}"
    );
    // And the rest, from there, completes and verifies.
    let parts = pieces(&asset);
    let mut last = None;
    for (index, bytes) in parts.iter().enumerate().skip(resume_from as usize) {
        last = Some(ask(&mut raw, chunk(&asset.hash, index as u32, bytes)));
    }
    assert!(matches!(last, Some(AssetTransferReply::Stored { .. })));
    assert!(receiver.holds(&asset.hash));
}

#[test]
fn a_retry_gives_up_after_its_retries_and_says_transport() {
    let receiver = receiver();
    let asset = asset(3, 3);
    // Every connection dies almost at once.
    let proxy = proxy(receiver.address, 60, 100);
    let mut client = AssetTransferClient::connect(proxy.address)
        .unwrap()
        .with_retry(quick(2));
    let error = client.publish(std::slice::from_ref(&asset)).unwrap_err();
    assert!(error.is_transport(), "{error:?}");
    assert_eq!(
        proxy.connections.load(Ordering::SeqCst),
        3,
        "the first try and two redials, then it stops"
    );
}

#[test]
fn a_retry_waits_longer_each_time_up_to_the_longest() {
    let policy = RetryPolicy {
        retries: 8,
        first_delay: Duration::from_millis(10),
        longest_delay: Duration::from_millis(50),
    };
    let waits: Vec<u128> = (0..6).map(|n| policy.delay_before(n).as_millis()).collect();
    assert_eq!(waits, [10, 20, 40, 50, 50, 50]);
    // A very large retry number does not overflow into a short wait.
    assert_eq!(policy.delay_before(200).as_millis(), 50);
    assert_eq!(RetryPolicy::none().retries, 0);
}

#[test]
fn the_wait_between_tries_is_really_taken() {
    let receiver = receiver();
    let asset = asset(4, 4);
    let proxy = proxy(receiver.address, 400_000, 1);
    let mut client = AssetTransferClient::connect(proxy.address)
        .unwrap()
        .with_retry(RetryPolicy {
            retries: 2,
            first_delay: Duration::from_millis(300),
            longest_delay: Duration::from_secs(1),
        });
    let started = std::time::Instant::now();
    client.publish(std::slice::from_ref(&asset)).unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "one redial, after the first delay: {:?}",
        started.elapsed()
    );
}

// --- duplicates ---

#[test]
fn a_chunk_delivered_twice_is_acknowledged_and_counted_once() {
    let receiver = receiver();
    let asset = asset(5, 3);
    let parts = pieces(&asset);
    let mut raw = TcpStream::connect(receiver.address).unwrap();
    ask(&mut raw, begin(&asset.hash, 4));
    assert!(matches!(
        ask(&mut raw, chunk(&asset.hash, 0, &parts[0])),
        AssetTransferReply::ChunkAccepted { next_chunk: 1, .. }
    ));
    let before = receiver.metrics.received_asset_bytes();
    // The same chunk again: a retry whose reply was lost.
    assert!(matches!(
        ask(&mut raw, chunk(&asset.hash, 0, &parts[0])),
        AssetTransferReply::ChunkAccepted { next_chunk: 1, .. }
    ));
    assert_eq!(
        receiver.metrics.received_asset_bytes(),
        before,
        "a duplicate adds no bytes"
    );
    // Different bytes under an index already delivered are refused, never taken.
    let mut other = parts[0].clone();
    other[10] ^= 0xFF;
    assert!(matches!(
        ask(&mut raw, chunk(&asset.hash, 0, &other)),
        AssetTransferReply::Refused {
            cause: Refusal::AssetChunkOutOfOrder {
                expected: 1,
                received: 0,
                ..
            }
        }
    ));
    // A shorter repeat is a different chunk too.
    assert!(matches!(
        ask(&mut raw, chunk(&asset.hash, 0, &parts[0][..100])),
        AssetTransferReply::Refused {
            cause: Refusal::AssetChunkOutOfOrder { .. }
        }
    ));
}

#[test]
fn two_uploads_of_the_same_asset_at_once_both_succeed_and_store_it_once() {
    for round in 0..4u8 {
        let receiver = receiver();
        let asset = asset(10 + round, 8);
        let barrier = Arc::new(Barrier::new(2));
        let uploads: Vec<_> = (0..2)
            .map(|_| {
                let (asset, barrier, address) =
                    (asset.clone(), Arc::clone(&barrier), receiver.address);
                thread::spawn(move || {
                    let mut client = AssetTransferClient::connect(address).unwrap();
                    barrier.wait();
                    client.transfer(&asset)
                })
            })
            .collect();
        for upload in uploads {
            upload
                .join()
                .unwrap()
                .expect("a concurrent duplicate is answered, not refused");
        }
        assert!(receiver.holds(&asset.hash));
        assert_eq!(
            receiver.metrics.received_asset_bytes(),
            asset.bytes.len() as u64,
            "round {round}: the bytes were taken once between the two"
        );
    }
}

#[test]
fn an_asset_already_held_is_answered_as_done() {
    let receiver = receiver();
    let asset = asset(6, 2);
    AssetTransferClient::connect(receiver.address)
        .unwrap()
        .transfer(&asset)
        .unwrap();
    let held = receiver.metrics.received_asset_bytes();

    // Begin again: nothing is left to send.
    let mut raw = TcpStream::connect(receiver.address).unwrap();
    assert!(matches!(
        ask(&mut raw, begin(&asset.hash, 3)),
        AssetTransferReply::Started { resume_from: 3, .. }
    ));
    // The last chunk again, from an uploader that did not know: the finisher's answer.
    let parts = pieces(&asset);
    assert!(matches!(
        ask(&mut raw, chunk(&asset.hash, 2, &parts[2])),
        AssetTransferReply::Stored { .. }
    ));
    // And a whole second upload sends nothing.
    let mut client = AssetTransferClient::connect(receiver.address).unwrap();
    client.transfer(&asset).unwrap();
    assert_eq!(receiver.metrics.received_asset_bytes(), held);
}

// --- what a connection leaves behind ---

#[test]
fn a_transfer_of_a_different_length_under_the_same_name_starts_over() {
    let receiver = receiver();
    let hash = a_hash(1);
    let mut raw = TcpStream::connect(receiver.address).unwrap();
    ask(&mut raw, begin(&hash, 4));
    ask(&mut raw, chunk(&hash, 0, &[1; 16]));
    assert!(matches!(
        ask(&mut raw, begin(&hash, 4)),
        AssetTransferReply::Started { resume_from: 1, .. }
    ));
    assert!(matches!(
        ask(&mut raw, begin(&hash, 5)),
        AssetTransferReply::Started { resume_from: 0, .. }
    ));
}

#[test]
fn a_transfer_that_fails_verification_leaves_nothing_to_resume() {
    let receiver = receiver();
    let mut forged = asset(7, 1);
    forged.hash = a_hash(99);
    let mut raw = TcpStream::connect(receiver.address).unwrap();
    ask(&mut raw, begin(&forged.hash, 2));
    let parts = pieces(&forged);
    ask(&mut raw, chunk(&forged.hash, 0, &parts[0]));
    assert!(matches!(
        ask(&mut raw, chunk(&forged.hash, 1, &parts[1])),
        AssetTransferReply::Refused {
            cause: Refusal::AssetHashMismatch { .. }
        }
    ));
    assert!(!receiver.holds(&forged.hash), "invariant 28");
    assert!(matches!(
        ask(&mut raw, begin(&forged.hash, 2)),
        AssetTransferReply::Started { resume_from: 0, .. }
    ));
}

#[test]
fn only_the_most_recent_unfinished_transfers_are_kept() {
    let receiver = receiver();
    let mut raw = TcpStream::connect(receiver.address).unwrap();
    let first = a_hash(1000);
    ask(&mut raw, begin(&first, 4));
    ask(&mut raw, chunk(&first, 0, &[7; 8]));
    for n in 0..16 {
        ask(&mut raw, begin(&a_hash(2000 + n), 4));
    }
    assert!(
        matches!(
            ask(&mut raw, begin(&first, 4)),
            AssetTransferReply::Started { resume_from: 0, .. }
        ),
        "the oldest unfinished transfer was dropped to bound what the receiver holds"
    );
}

// --- a reset or an end of stream is the transport's error ---

#[test]
fn an_end_of_stream_is_a_transport_error_and_is_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&accepted);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            counted.fetch_add(1, Ordering::SeqCst);
            let mut prefix = [0u8; 4];
            let _ = stream.read_exact(&mut prefix);
            // Read the request, then close without a reply.
            let mut body = vec![0u8; u32::from_be_bytes(prefix) as usize];
            let _ = stream.read_exact(&mut body);
        }
    });
    let mut client = AssetTransferClient::connect(address)
        .unwrap()
        .with_retry(quick(2));
    let error = client
        .preflight(gx_asset_plane::PreflightRequest {
            hashes: vec![a_hash(5)],
        })
        .unwrap_err();
    assert!(
        matches!(&error, AssetTransferClientError::Transport(e) if e.kind() == std::io::ErrorKind::UnexpectedEof),
        "{error:?}"
    );
    assert_eq!(accepted.load(Ordering::SeqCst), 3, "retried, then gave up");
}

#[test]
fn a_reply_that_is_not_the_dialect_is_a_protocol_failure_and_is_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&accepted);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            counted.fetch_add(1, Ordering::SeqCst);
            let mut prefix = [0u8; 4];
            let _ = stream.read_exact(&mut prefix);
            let mut body = vec![0u8; u32::from_be_bytes(prefix) as usize];
            let _ = stream.read_exact(&mut body);
            let junk = b"this is not json";
            let _ = stream.write_all(&(junk.len() as u32).to_be_bytes());
            let _ = stream.write_all(junk);
        }
    });
    let mut client = AssetTransferClient::connect(address)
        .unwrap()
        .with_retry(quick(3));
    let error = client
        .preflight(gx_asset_plane::PreflightRequest {
            hashes: vec![a_hash(6)],
        })
        .unwrap_err();
    assert!(
        matches!(error, AssetTransferClientError::Protocol(_)),
        "{error:?}"
    );
    assert!(!error.is_transport());
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        1,
        "the same answer would come again: no retry"
    );
}

#[test]
fn a_refusal_is_never_retried() {
    let receiver = receiver();
    let mut forged = asset(8, 1);
    forged.hash = a_hash(77);
    let mut client = AssetTransferClient::connect(receiver.address)
        .unwrap()
        .with_retry(quick(3));
    let error = client.transfer(&forged).unwrap_err();
    assert!(
        matches!(
            error,
            AssetTransferClientError::Refused(Refusal::AssetHashMismatch { .. })
        ),
        "{error:?}"
    );
}

#[test]
fn which_io_errors_are_the_connection_failing() {
    use std::io::{Error, ErrorKind::*};
    for kind in [
        ConnectionReset,
        ConnectionAborted,
        ConnectionRefused,
        BrokenPipe,
        NotConnected,
        UnexpectedEof,
        TimedOut,
        WouldBlock,
    ] {
        assert!(is_transport_failure(&Error::from(kind)), "{kind:?}");
    }
    for kind in [InvalidData, InvalidInput, Other, PermissionDenied] {
        assert!(!is_transport_failure(&Error::from(kind)), "{kind:?}");
    }
}

// --- the engine's own receiver, and a receiver that lies ---

use std::collections::HashMap;

use gx_asset_plane::auth::enter;
use gx_asset_plane::{AssetPublishPeer, AssetPublishServer, PublishReply};
use gx_contracts::auth::{Role, Scope};
use gx_contracts::scene::SceneDocument;
use gx_contracts::{Locality, Revision, TakeId};
use gx_credential::Token;

/// An engine's receiver in miniature: verified bytes kept in memory behind the publish port.
struct Memory {
    held: Arc<Mutex<HashMap<ContentHash, Vec<u8>>>>,
}

impl AssetPublishPeer for Memory {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
        PublishReply::Published {
            take_id: TakeId(scene.id),
            revision: Revision(1),
            content_hash: a_hash(0),
        }
    }
    fn locality(&self) -> Locality {
        Locality::CoLocated
    }
    fn has_verified_asset(&self, hash: &ContentHash) -> bool {
        self.held.lock().unwrap().contains_key(hash)
    }
    fn accept_verified_asset(&mut self, hash: ContentHash, bytes: Vec<u8>) -> Result<(), Refusal> {
        self.held.lock().unwrap().insert(hash, bytes);
        Ok(())
    }
}

#[test]
fn the_engines_receiver_resumes_and_the_credential_rides_every_redial() {
    const SECRET: &str = "asset-plane-resume-test-secret-0123456789";
    let held = Arc::new(Mutex::new(HashMap::new()));
    let peer = Arc::new(Mutex::new(Memory {
        held: Arc::clone(&held),
    }));
    let server = AssetPublishServer::bind_authenticating(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        peer,
        SECRET,
    )
    .unwrap();
    let address = server.local_addr().unwrap();
    let _ = server.serve_in_background();

    // The first connection dies after a few hundred bytes (inside its first frame, credential
    // and all); the second after about two chunks.
    let first = proxy(address, 40, 1);
    let credential = Token::mint("editor-1", Role::Editor, vec![Scope::Author], SECRET)
        .unwrap()
        .as_str()
        .to_owned();
    let _credential = enter(credential);
    let asset = asset(9, 4);
    let mut client = AssetTransferClient::connect(first.address)
        .unwrap()
        .with_retry(quick(3));
    client
        .publish(std::slice::from_ref(&asset))
        .expect("the redial carries the credential again, so it is not refused as unauthenticated");
    assert_eq!(
        held.lock().unwrap().get(&asset.hash),
        Some(&asset.bytes),
        "the engine's receiver holds the verified bytes"
    );
    assert_eq!(first.connections.load(Ordering::SeqCst), 2);

    // A transfer cut part way through the engine's receiver resumes there too.
    let second = proxy(address, 700_000, 1);
    let other = asset_with(10, 6);
    let mut client = AssetTransferClient::connect(second.address)
        .unwrap()
        .with_retry(quick(3));
    client.publish(std::slice::from_ref(&other)).unwrap();
    assert_eq!(held.lock().unwrap().get(&other.hash), Some(&other.bytes));
    assert_eq!(second.connections.load(Ordering::SeqCst), 2);
}

fn asset_with(seed: u8, chunks: usize) -> AssetBytes {
    asset(seed, chunks)
}

#[test]
fn a_receiver_that_resumes_past_the_end_is_a_protocol_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut prefix = [0u8; 4];
            while stream.read_exact(&mut prefix).is_ok() {
                let mut body = vec![0u8; u32::from_be_bytes(prefix) as usize];
                if stream.read_exact(&mut body).is_err() {
                    break;
                }
                let reply = serde_json::to_vec(&AssetTransferReply::Started {
                    hash: a_hash(1),
                    resume_from: 99,
                })
                .unwrap();
                let _ = stream.write_all(&(reply.len() as u32).to_be_bytes());
                let _ = stream.write_all(&reply);
            }
        }
    });
    let mut client = AssetTransferClient::connect(address)
        .unwrap()
        .with_retry(quick(2));
    let error = client.transfer(&asset(11, 2)).unwrap_err();
    assert!(
        matches!(error, AssetTransferClientError::Protocol(_)),
        "{error:?}"
    );
}
