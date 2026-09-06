//! The request half of the AE frame path, against a real named pipe.
//!
//! `AE-F2b` computed which frames Program needed and `program.rs` logged the answer; nothing asked After
//! Effects for anything. These tests stand a named-pipe server where the adapter would be and prove the
//! engine now posts that ledger as `RENDER_FRAME` — the handshake, the payload a scheduled frame turns
//! into, pipelining, and the back-pressure loop that feeds `AE-F2b`'s lead-depth policy.
//!
//! A fake server rather than After Effects on purpose: the live gate needs a licensed host and proves
//! pixels, while these need to fail deterministically on a wrong field.

#![cfg(windows)]

use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use grapix_render_engine::ae_ingress::AeFrameRequest;
use grapix_render_engine::ae_runtime_client::{
    connect, AeRenderFeedback, AeRuntimeClientConfig,
};
use grapix_render_engine::protocol::AeExactTime;

use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A pipe standing exactly where the adapter's would, speaking the same framing.
struct FakeAdapter {
    session: String,
    requests: mpsc::Receiver<String>,
    replies: mpsc::Sender<String>,
}

impl FakeAdapter {
    /// Create the pipe *before* returning, so a client can connect the moment this call finishes.
    fn start(session: &str) -> Self {
        let path = format!("\\\\.\\pipe\\grapix-ae-runtime-{session}");
        let handle = unsafe {
            CreateNamedPipeW(
                wide(&path).as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                256 * 1024,
                256 * 1024,
                0,
                std::ptr::null(),
            )
        };
        assert!(handle != INVALID_HANDLE_VALUE, "could not create {path}");

        let (request_out, requests) = mpsc::channel::<String>();
        let (replies, reply_in) = mpsc::channel::<String>();
        let session_id = session.to_string();
        // A raw HANDLE is not `Send`, so it crosses as an integer and is rebuilt on the far side.
        let raw = handle as usize;

        std::thread::spawn(move || {
            let handle = raw as windows_sys::Win32::Foundation::HANDLE;
            let mut pipe = unsafe { std::fs::File::from_raw_handle(handle as *mut _) };
            // Blocking connect: the server has one client, the engine.
            unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };

            // The handshake the adapter requires before any operation.
            let hello = read_frame(&mut pipe).expect("hello");
            assert!(hello.contains("\"kind\":\"hello\""), "{hello}");
            let ack = format!(
                "{{\"kind\":\"hello-ack\",\"protocolMajor\":2,\"protocolMinor\":0,\
                 \"sessionId\":\"{session_id}\",\"capabilities\":[\"render.readiness\"],\
                 \"fingerprint\":{{\"faultInjection\":null}},\"hostPid\":1}}"
            );
            write_frame(&mut pipe, &ack);

            loop {
                // Replies first, so a test can answer a request it has already observed.
                while let Ok(reply) = reply_in.try_recv() {
                    write_frame(&mut pipe, &reply);
                }
                match read_frame_nonblocking(&mut pipe) {
                    Some(request) => {
                        if request_out.send(request).is_err() {
                            return;
                        }
                    }
                    None => std::thread::sleep(Duration::from_millis(1)),
                }
            }
        });

        Self {
            session: session.to_string(),
            requests,
            replies,
        }
    }

    fn config(&self) -> AeRuntimeClientConfig {
        AeRuntimeClientConfig::new(self.session.clone(), TOKEN)
    }

    fn next_request(&self) -> String {
        self.requests
            .recv_timeout(Duration::from_secs(10))
            .expect("a request reached the adapter")
    }

    fn reply(&self, envelope: String) {
        self.replies.send(envelope).expect("reply queued");
    }
}

fn write_frame(pipe: &mut std::fs::File, json: &str) {
    let size = json.len() as u32;
    let mut framed = Vec::with_capacity(json.len() + 4);
    framed.extend_from_slice(&size.to_be_bytes());
    framed.extend_from_slice(json.as_bytes());
    pipe.write_all(&framed).expect("frame written");
    pipe.flush().ok();
}

fn read_frame(pipe: &mut std::fs::File) -> Option<String> {
    let mut prefix = [0u8; 4];
    pipe.read_exact(&mut prefix).ok()?;
    let size = u32::from_be_bytes(prefix) as usize;
    let mut body = vec![0u8; size];
    pipe.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

/// Poll for a request without blocking.
///
/// The first version of this blocked in `read_exact`, which starved the reply branch above it: the
/// server sat waiting for the next request while a queued reply was never written. That is the same
/// synchronous-handle hazard the production client avoids, and it belongs here too.
fn read_frame_nonblocking(pipe: &mut std::fs::File) -> Option<String> {
    let handle = pipe.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    let mut available: u32 = 0;
    let mut prefix = [0u8; 4];
    let mut peeked: u32 = 0;
    let ok = unsafe {
        windows_sys::Win32::System::Pipes::PeekNamedPipe(
            handle,
            prefix.as_mut_ptr().cast(),
            prefix.len() as u32,
            &mut peeked,
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || peeked < 4 {
        return None;
    }
    let size = u32::from_be_bytes(prefix) as usize;
    if size == 0 || (available as usize) < size + 4 {
        return None;
    }
    read_frame(pipe)
}

fn scheduled(frame: u64, revision: u64) -> AeFrameRequest {
    AeFrameRequest {
        frame,
        deadline_nanos: 33_366_700u64 * frame,
        composition_item_id: 1,
        requested_time: AeExactTime {
            value: (frame * 800).to_string(),
            scale: "23976".to_string(),
        },
        data_revision: revision,
    }
}

fn result_for(request_id: &str, sequence: u64, ok: bool) -> String {
    if ok {
        format!(
            "{{\"kind\":\"result\",\"protocolMajor\":2,\"protocolMinor\":0,\"sessionId\":\"s\",\
             \"requestId\":\"{request_id}\",\"sequence\":{sequence},\"operation\":\"RENDER_FRAME\",\
             \"ok\":true,\"result\":{{\"accepted\":true}}}}"
        )
    } else {
        format!(
            "{{\"kind\":\"result\",\"protocolMajor\":2,\"protocolMinor\":0,\"sessionId\":\"s\",\
             \"requestId\":\"{request_id}\",\"sequence\":{sequence},\"operation\":\"RENDER_FRAME\",\
             \"ok\":false,\"error\":{{\"code\":\"TIME_NOT_REPRESENTABLE\",\"message\":\"off frame\"}}}}"
        )
    }
}

fn field(envelope: &str, name: &str) -> String {
    let needle = format!("\"{name}\":\"");
    let start = envelope.find(&needle).unwrap_or_else(|| panic!("{name} missing from {envelope}"))
        + needle.len();
    let rest = &envelope[start..];
    rest[..rest.find('"').expect("closing quote")].to_string()
}

#[test]
fn a_scheduled_frame_becomes_a_render_frame_request_carrying_its_own_exact_time() {
    let adapter = FakeAdapter::start("ae-wire-basic");
    let requester = connect(adapter.config()).expect("handshake completes");

    requester.submit(scheduled(3, 5));
    let envelope = adapter.next_request();

    assert!(envelope.contains("\"operation\":\"RENDER_FRAME\""), "{envelope}");
    // The composition's own scale, not a frame number the adapter would have to re-derive, and not a
    // float. This is the PL1 contract crossing the wire for the first time.
    assert!(
        envelope.contains("\"time\":{\"value\":\"2400\",\"scale\":\"23976\"}"),
        "{envelope}"
    );
    assert!(envelope.contains("\"compositionItemId\":1"), "{envelope}");
    assert!(envelope.contains("\"dataRevision\":5"), "{envelope}");
    // Asymmetric on purpose, because the adapter's parsers are: `frameId` is read as an integer and the
    // deadline as a string. Quoting the frame id is refused `INVALID_PAYLOAD` - the live run found this.
    assert!(envelope.contains("\"frameId\":3"), "{envelope}");
    assert_eq!(field(&envelope, "presentationDeadlineNanos"), "100100100");
}

#[test]
fn requests_are_pipelined_rather_than_waiting_for_each_reply() {
    // The whole dispatch fix: AE-F3 measured one-in-flight at 21.3 fps against 88.7 pipelined. If this
    // regresses to request/reply the frame path silently loses 4x.
    let adapter = FakeAdapter::start("ae-wire-pipeline");
    let requester = connect(adapter.config()).expect("handshake completes");

    for frame in 1..=8 {
        requester.submit(scheduled(frame, 1));
    }

    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while seen.len() < 8 && Instant::now() < deadline {
        seen.push(adapter.next_request());
    }
    assert_eq!(seen.len(), 8, "every submitted frame reached the pipe without a reply first");

    // Sequence numbers are monotonic across the pipeline, which is how the adapter orders work.
    let sequences: Vec<u64> = seen
        .iter()
        .map(|envelope| {
            let start = envelope.find("\"sequence\":").expect("sequence") + "\"sequence\":".len();
            let rest = &envelope[start..];
            let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            rest[..end].parse().expect("numeric sequence")
        })
        .collect();
    assert_eq!(sequences, vec![1, 2, 3, 4, 5, 6, 7, 8], "{sequences:?}");
}

#[test]
fn an_accepted_reply_and_a_refusal_are_counted_apart() {
    let adapter = FakeAdapter::start("ae-wire-counts");
    let requester = connect(adapter.config()).expect("handshake completes");

    requester.submit(scheduled(1, 1));
    let first = adapter.next_request();
    adapter.reply(result_for(&field(&first, "requestId"), 1, true));

    requester.submit(scheduled(2, 1));
    let second = adapter.next_request();
    adapter.reply(result_for(&field(&second, "requestId"), 2, false));

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = requester.status();
        if status.accepted == 1 && status.refused == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "counters never settled: {:?}", requester.status());
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(requester.status().written, 2);
}

#[test]
fn a_ring_refusal_is_reported_as_backpressure_and_not_as_a_render_failure() {
    // AE-F2b's policy shrinks the lead depth on ring back-pressure and must not confuse it with After
    // Effects failing the frame: one means "slow down", the other means "this frame is broken".
    let adapter = FakeAdapter::start("ae-wire-backpressure");
    let requester = connect(adapter.config()).expect("handshake completes");

    requester.submit(scheduled(4, 1));
    let envelope = adapter.next_request();
    let request_id = field(&envelope, "requestId");
    adapter.reply(format!(
        "{{\"kind\":\"event\",\"protocolMajor\":2,\"protocolMinor\":0,\"sessionId\":\"s\",\
         \"sequence\":1,\"event\":\"RENDER_FAILED\",\"detail\":{{\"renderRequestId\":\"{request_id}\",\
         \"error\":{{\"code\":\"FRAME_RING_BACKPRESSURE\",\"retryable\":true}}}}}}"
    ));

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut backpressure = Vec::new();
    while Instant::now() < deadline && backpressure.is_empty() {
        backpressure = requester
            .drain_feedback()
            .into_iter()
            .filter(|event| matches!(event, AeRenderFeedback::RingBackpressure { .. }))
            .collect();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        backpressure,
        vec![AeRenderFeedback::RingBackpressure { frame: 4 }],
        "the refusal is attributed to the frame that was asked for"
    );
    assert_eq!(requester.status().backpressure, 1);
    assert_eq!(requester.status().failed, 1);
}

#[test]
fn a_render_ready_event_is_counted_without_being_mistaken_for_a_reply() {
    let adapter = FakeAdapter::start("ae-wire-ready");
    let requester = connect(adapter.config()).expect("handshake completes");

    requester.submit(scheduled(6, 2));
    let envelope = adapter.next_request();
    adapter.reply(format!(
        "{{\"kind\":\"event\",\"protocolMajor\":2,\"protocolMinor\":0,\"sessionId\":\"s\",\
         \"sequence\":1,\"event\":\"RENDER_READY\",\"detail\":{{\"renderRequestId\":\"{}\",\
         \"frameId\":\"6\"}}}}",
        field(&envelope, "requestId")
    ));

    let deadline = Instant::now() + Duration::from_secs(10);
    while requester.status().ready == 0 {
        assert!(Instant::now() < deadline, "RENDER_READY never counted");
        std::thread::sleep(Duration::from_millis(10));
    }
    let status = requester.status();
    assert_eq!(status.ready, 1);
    // An event is not a reply: nothing was accepted or refused by it.
    assert_eq!(status.accepted, 0);
    assert_eq!(status.refused, 0);
}

#[test]
fn a_full_queue_drops_rather_than_hoarding_frames_whose_deadlines_have_passed() {
    let adapter = FakeAdapter::start("ae-wire-bound");
    let mut config = adapter.config();
    config.queue_capacity = 1;
    let requester = connect(config).expect("handshake completes");

    for frame in 1..=64 {
        requester.submit(scheduled(frame, 1));
    }

    let status = requester.status();
    assert!(
        status.dropped > 0,
        "a bounded queue must drop rather than queue stale frames: {status:?}"
    );
    assert_eq!(
        status.submitted + status.dropped,
        64,
        "every submission is either queued or counted as dropped: {status:?}"
    );
}

#[test]
fn a_missing_adapter_is_a_refusal_and_never_a_half_live_requester() {
    // Program believing it has an AE source while silently never asking is the exact failure this
    // module removes, so a connect that cannot happen must fail loudly.
    let config = AeRuntimeClientConfig::new("ae-wire-absent", TOKEN);
    let error = match connect(config) {
        Ok(_) => panic!("a requester was returned with no adapter listening"),
        Err(error) => error,
    };
    assert!(error.contains("could not open"), "{error}");
}
