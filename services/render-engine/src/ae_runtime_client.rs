//! The engine's own client for the After Effects runtime protocol, and the thing that finally makes
//! `request_ae_program_frames` do something.
//!
//! Until this module existed the schedule was a ledger nobody posted: `AE-F2b` computed exactly which
//! frames Program needed and how long each had, `program.rs` logged the answer, and the only code that
//! ever asked After Effects to render was a test harness driving the legacy file channel by hand. The
//! ring consumer (`ae_ring_source`) was therefore a consumer with no production producer.
//!
//! What this adds is the request half, on the authenticated protocol:
//!
//! * a Windows named-pipe connection to `\\.\pipe\grapix-ae-runtime-<session>`, with the `hello`
//!   handshake the adapter requires before it will accept an operation;
//! * `RENDER_FRAME` requests built from `AeFrameRequest` - the frame's own exact time in the
//!   composition's scale, its absolute deadline, and the data revision that must be in force;
//! * a single I/O thread that **pipelines**: requests are written as they arrive and replies are matched
//!   by `requestId` afterwards, never one-in-flight-at-a-time. `AE-F3` measured that difference as
//!   21.3 fps against 88.7 fps, so serialising here would give back the entire dispatch fix.
//!
//! Two deliberate shapes. The clock never blocks on this: `submit` is a channel send, because a frame
//! request that waits for After Effects to answer has already missed the deadline it was scheduling for.
//! And the thread never touches the engine mutex - ring back-pressure comes back as `feedback`, which the
//! clock drains on a tick it already holds the lock for, so `AE-F2b`'s lead-depth policy still owns the
//! decision.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::ae_ingress::AeFrameRequest;

/// Protocol major the adapter speaks. A mismatch is refused rather than negotiated down.
const PROTOCOL_MAJOR: u32 = 2;
const PROTOCOL_MINOR: u32 = 0;
/// Same ceiling the adapter enforces (`kRuntimeMaxFrameBytes`).
const MAX_FRAME_BYTES: usize = 256 * 1024;

/// What the requester could not do, reported without a lock so the clock can act on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AeRenderFeedback {
    /// The ring refused a publish. `AE-F2b`'s policy shrinks the lead depth one step.
    RingBackpressure { frame: u64 },
    /// After Effects refused or failed the frame itself, with the adapter's own code.
    Failed { frame: u64, code: String },
    /// The connection is gone. Program has no AE source until it is re-established.
    Disconnected { detail: String },
}

/// Counters a status surface can read without stopping anything.
#[derive(Debug, Default)]
pub struct AeRenderRequesterCounters {
    pub submitted: AtomicU64,
    pub written: AtomicU64,
    pub accepted: AtomicU64,
    pub refused: AtomicU64,
    pub ready: AtomicU64,
    pub failed: AtomicU64,
    pub backpressure: AtomicU64,
    /// Submissions dropped because the queue was full: the clock outran the pipe.
    pub dropped: AtomicU64,
}

impl AeRenderRequesterCounters {
    fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

/// A snapshot of the counters, for the status block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AeRenderRequesterStatus {
    pub submitted: u64,
    pub written: u64,
    pub accepted: u64,
    pub refused: u64,
    pub ready: u64,
    pub failed: u64,
    pub backpressure: u64,
    pub dropped: u64,
}

/// How the engine reaches a live adapter session.
#[derive(Debug, Clone)]
pub struct AeRuntimeClientConfig {
    pub session_id: String,
    pub token: String,
    /// Per-request deadline handed to the adapter, which refuses `DEADLINE_EXPIRED` past it.
    pub request_timeout: Duration,
    /// Bound on unwritten submissions. Full means the clock is outrunning the pipe, which is a
    /// dropped request and a counter, never an unbounded queue of stale frames.
    pub queue_capacity: usize,
    /// Scopes idempotency to one engine run.
    ///
    /// The adapter remembers every accepted idempotency key for the life of the After Effects session,
    /// so a key of just "frame N at revision R" is permanent: a restarted engine asking for the same
    /// frame is answered `DUPLICATE_REQUEST` and never rendered. Measured, not theorised - it is what
    /// this wiring did on its second live run. At-most-once *within* a run is the schedule's job and
    /// still holds, so per-run is the correct scope.
    pub run_id: String,
}

impl AeRuntimeClientConfig {
    pub fn new(session_id: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            token: token.into(),
            request_timeout: Duration::from_secs(5),
            queue_capacity: 256,
            run_id: default_run_id(),
        }
    }

    pub fn pipe_path(&self) -> String {
        format!("\\\\.\\pipe\\grapix-ae-runtime-{}", self.session_id)
    }

    fn validate(&self) -> Result<(), String> {
        if self.session_id.is_empty()
            || !self
                .session_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            || self.session_id.len() > 64
        {
            return Err("session id must be 1-64 characters of [A-Za-z0-9-]".to_string());
        }
        if self.token.len() < 32 {
            return Err("runtime launch token must contain at least 32 characters".to_string());
        }
        if self.queue_capacity == 0 {
            return Err("queue capacity must admit at least one request".to_string());
        }
        if self.run_id.is_empty() {
            return Err("a run id is required to scope idempotency to this engine run".to_string());
        }
        Ok(())
    }
}

/// Unique per engine run: the process, and when within it this connection was made.
fn default_run_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    format!("r{}-{}", std::process::id(), nanos)
}

/// The `RENDER_FRAME` payload, exactly as the adapter parses it.
///
/// The field types are asymmetric and that is the adapter's contract, not a choice made here:
/// `presentationDeadlineNanos` is read with `runtime_payload_string` and `frameId` with
/// `runtime_payload_integer`, so the deadline crosses quoted and the frame id crosses bare. Sending the
/// frame id quoted is refused `INVALID_PAYLOAD` - measured, on the first live run of this wiring.
pub fn render_frame_payload(run_id: &str, request: &AeFrameRequest) -> String {
    format!(
        concat!(
            "{{\"compositionItemId\":{},\"time\":{{\"value\":\"{}\",\"scale\":\"{}\"}},",
            "\"dataRevision\":{},\"frameId\":{},\"renderRequestId\":\"{}\",",
            "\"presentationDeadlineNanos\":\"{}\"}}"
        ),
        request.composition_item_id,
        escape_json(&request.requested_time.value),
        escape_json(&request.requested_time.scale),
        request.data_revision,
        request.frame,
        escape_json(&render_request_id(run_id, request)),
        request.deadline_nanos,
    )
}

/// Stable identity for one frame at one revision, within one engine run.
///
/// The same frame at the same revision in the same run is the same work, so this doubles as the
/// idempotency key: a retry after a dropped reply is deduplicated by the adapter instead of rendering
/// twice. A new run gets a new prefix, because the adapter's memory of accepted keys outlives us.
pub fn render_request_id(run_id: &str, request: &AeFrameRequest) -> String {
    format!("{run_id}-frame-{}-rev-{}", request.frame, request.data_revision)
}

fn escape_json(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Frame the protocol's 4-byte big-endian length prefix around a JSON body.
pub fn encode_frame(json: &str) -> Result<Vec<u8>, String> {
    let bytes = json.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(format!("frame of {} bytes is outside the protocol", bytes.len()));
    }
    let size = bytes.len() as u32;
    let mut framed = Vec::with_capacity(bytes.len() + 4);
    framed.extend_from_slice(&size.to_be_bytes());
    framed.extend_from_slice(bytes);
    Ok(framed)
}

/// Build the `hello` the adapter requires before any operation.
pub fn hello_frame(config: &AeRuntimeClientConfig) -> String {
    format!(
        concat!(
            "{{\"kind\":\"hello\",\"protocolMajor\":{},\"protocolMinor\":{},\"sessionId\":\"{}\",",
            "\"token\":\"{}\",\"capabilities\":[\"render.readiness\",\"project.discovery\"]}}"
        ),
        PROTOCOL_MAJOR,
        PROTOCOL_MINOR,
        escape_json(&config.session_id),
        escape_json(&config.token),
    )
}

/// Build one `RENDER_FRAME` request envelope.
pub fn render_frame_envelope(
    config: &AeRuntimeClientConfig,
    request: &AeFrameRequest,
    sequence: u64,
    now: SystemTime,
) -> String {
    let deadline_unix_ms = now
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .saturating_add(config.request_timeout)
        .as_millis();
    let identity = render_request_id(&config.run_id, request);
    format!(
        concat!(
            "{{\"kind\":\"request\",\"protocolMajor\":{},\"protocolMinor\":{},\"sessionId\":\"{}\",",
            "\"requestId\":\"{}\",\"sequence\":{},\"idempotencyKey\":\"{}\",\"deadlineUnixMs\":{},",
            "\"expectedProjectDigest\":null,\"operation\":\"RENDER_FRAME\",\"payload\":{}}}"
        ),
        PROTOCOL_MAJOR,
        PROTOCOL_MINOR,
        escape_json(&config.session_id),
        escape_json(&identity),
        sequence,
        escape_json(&identity),
        deadline_unix_ms,
        render_frame_payload(&config.run_id, request),
    )
}

/// Handle to the requester thread. Dropping it closes the pipe and ends the thread.
pub struct AeRenderRequester {
    submissions: Sender<AeFrameRequest>,
    feedback: Receiver<AeRenderFeedback>,
    counters: Arc<AeRenderRequesterCounters>,
    capacity: usize,
    queued: Arc<AtomicU64>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl AeRenderRequester {
    /// Hand one scheduled frame to After Effects. Never blocks, never waits for the render.
    pub fn submit(&self, request: AeFrameRequest) {
        // A bound, checked before the send: the alternative is a queue of frames whose deadlines have
        // all passed, which is a slow-motion Program rather than a dropped frame.
        if self.queued.load(Ordering::Relaxed) >= self.capacity as u64 {
            AeRenderRequesterCounters::bump(&self.counters.dropped);
            return;
        }
        self.queued.fetch_add(1, Ordering::Relaxed);
        if self.submissions.send(request).is_err() {
            self.queued.fetch_sub(1, Ordering::Relaxed);
            AeRenderRequesterCounters::bump(&self.counters.dropped);
        } else {
            AeRenderRequesterCounters::bump(&self.counters.submitted);
        }
    }

    /// Drain what the pipe learned since the last tick. Called by the clock, which owns the policy.
    pub fn drain_feedback(&self) -> Vec<AeRenderFeedback> {
        let mut drained = Vec::new();
        loop {
            match self.feedback.try_recv() {
                Ok(event) => drained.push(event),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        drained
    }

    pub fn status(&self) -> AeRenderRequesterStatus {
        AeRenderRequesterStatus {
            submitted: self.counters.submitted.load(Ordering::Relaxed),
            written: self.counters.written.load(Ordering::Relaxed),
            accepted: self.counters.accepted.load(Ordering::Relaxed),
            refused: self.counters.refused.load(Ordering::Relaxed),
            ready: self.counters.ready.load(Ordering::Relaxed),
            failed: self.counters.failed.load(Ordering::Relaxed),
            backpressure: self.counters.backpressure.load(Ordering::Relaxed),
            dropped: self.counters.dropped.load(Ordering::Relaxed),
        }
    }
}

impl Drop for AeRenderRequester {
    fn drop(&mut self) {
        // Dropping the sender ends the worker's loop; joining it closes the pipe before we return, so a
        // restarted requester never races the old one for the adapter's single client slot.
        if let Some(worker) = self.worker.take() {
            drop(std::mem::replace(&mut self.submissions, mpsc::channel().0));
            let _ = worker.join();
        }
    }
}

#[cfg(windows)]
pub use windows_impl::connect;

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::fs::OpenOptions;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    /// Open the adapter's pipe, complete the handshake, and start the I/O thread.
    ///
    /// Returns an error rather than a half-live requester: a Program that believes it has an AE source
    /// and silently never asks for a frame is the failure this whole module exists to remove.
    pub fn connect(config: AeRuntimeClientConfig) -> Result<AeRenderRequester, String> {
        config.validate()?;
        let mut pipe = OpenOptions::new()
            .read(true)
            .write(true)
            .open(config.pipe_path())
            .map_err(|error| format!("could not open {}: {error}", config.pipe_path()))?;

        let hello = encode_frame(&hello_frame(&config))?;
        pipe.write_all(&hello)
            .map_err(|error| format!("hello write failed: {error}"))?;
        pipe.flush().ok();

        let ack = read_frame_blocking(&mut pipe, Duration::from_secs(10))
            .map_err(|error| format!("hello was not answered: {error}"))?;
        if !ack.contains("\"hello-ack\"") {
            return Err(format!("adapter did not answer hello: {ack}"));
        }
        if !ack.contains(&format!("\"protocolMajor\":{PROTOCOL_MAJOR}")) {
            return Err(format!("adapter speaks a different protocol major: {ack}"));
        }
        if !ack.contains(&format!("\"sessionId\":\"{}\"", config.session_id)) {
            return Err(format!("adapter answered for another session: {ack}"));
        }

        let (submissions, inbox) = mpsc::channel::<AeFrameRequest>();
        let (feedback_out, feedback) = mpsc::channel::<AeRenderFeedback>();
        let counters = Arc::new(AeRenderRequesterCounters::default());
        let queued = Arc::new(AtomicU64::new(0));
        let capacity = config.queue_capacity;

        let worker = {
            let counters = Arc::clone(&counters);
            let queued = Arc::clone(&queued);
            std::thread::Builder::new()
                .name("ae-render-requester".to_string())
                .spawn(move || {
                    run_io_loop(pipe, config, inbox, feedback_out, counters, queued);
                })
                .map_err(|error| format!("could not start the requester thread: {error}"))?
        };

        Ok(AeRenderRequester {
            submissions,
            feedback,
            counters,
            capacity,
            queued,
            worker: Some(worker),
        })
    }

    /// One thread owns the handle. Windows serialises I/O on a synchronous file object, so a blocking
    /// read here would stall every queued write - the exact fault that froze After Effects for 900
    /// seconds on the adapter side. Reads are therefore polled, never blocked on.
    fn run_io_loop(
        mut pipe: std::fs::File,
        config: AeRuntimeClientConfig,
        inbox: Receiver<AeFrameRequest>,
        feedback: Sender<AeRenderFeedback>,
        counters: Arc<AeRenderRequesterCounters>,
        queued: Arc<AtomicU64>,
    ) {
        let mut sequence: u64 = 0;
        let mut outstanding: HashMap<String, u64> = HashMap::new();
        loop {
            let mut worked = false;

            // Write everything queued before reading anything: a request that waits behind a reply has
            // lost the lead time it was scheduled with.
            loop {
                match inbox.try_recv() {
                    Ok(request) => {
                        queued.fetch_sub(1, Ordering::Relaxed);
                        sequence += 1;
                        let envelope =
                            render_frame_envelope(&config, &request, sequence, SystemTime::now());
                        match encode_frame(&envelope) {
                            Ok(framed) => {
                                if pipe.write_all(&framed).is_err() {
                                    let _ = feedback.send(AeRenderFeedback::Disconnected {
                                        detail: "request write failed".to_string(),
                                    });
                                    return;
                                }
                                outstanding.insert(render_request_id(&config.run_id, &request), request.frame);
                                AeRenderRequesterCounters::bump(&counters.written);
                                worked = true;
                            }
                            Err(detail) => {
                                let _ = feedback.send(AeRenderFeedback::Failed {
                                    frame: request.frame,
                                    code: detail,
                                });
                            }
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    // The handle is dropped: close the pipe by returning, which ends the session.
                    Err(TryRecvError::Disconnected) => return,
                }
            }
            pipe.flush().ok();

            while let Some(frame) = poll_frame(&mut pipe) {
                worked = true;
                dispatch(&frame, &mut outstanding, &counters, &feedback);
            }

            if !worked {
                std::thread::sleep(Duration::from_micros(500));
            }
        }
    }

    /// Account for one inbound envelope. Replies and events share the pipe, and only `requestId`
    /// distinguishes which frame a reply belongs to.
    fn dispatch(
        frame: &str,
        outstanding: &mut HashMap<String, u64>,
        counters: &AeRenderRequesterCounters,
        feedback: &Sender<AeRenderFeedback>,
    ) {
        let identity = string_field(frame, "requestId").or_else(|| string_field(frame, "renderRequestId"));
        let frame_number = identity
            .as_deref()
            .and_then(|id| outstanding.get(id).copied());

        if frame.contains("\"kind\":\"result\"") {
            if let Some(id) = identity.as_deref() {
                outstanding.remove(id);
            }
            if frame.contains("\"ok\":true") {
                AeRenderRequesterCounters::bump(&counters.accepted);
            } else {
                AeRenderRequesterCounters::bump(&counters.refused);
                let _ = feedback.send(AeRenderFeedback::Failed {
                    frame: frame_number.unwrap_or_default(),
                    code: string_field(frame, "code").unwrap_or_else(|| "UNKNOWN".to_string()),
                });
            }
            return;
        }

        if frame.contains("\"event\":\"RENDER_READY\"") {
            AeRenderRequesterCounters::bump(&counters.ready);
            return;
        }

        if frame.contains("\"event\":\"RENDER_FAILED\"") {
            AeRenderRequesterCounters::bump(&counters.failed);
            let code = string_field(frame, "code").unwrap_or_else(|| "UNKNOWN".to_string());
            let target = frame_number.unwrap_or_default();
            if code == "FRAME_RING_BACKPRESSURE" {
                AeRenderRequesterCounters::bump(&counters.backpressure);
                let _ = feedback.send(AeRenderFeedback::RingBackpressure { frame: target });
            } else {
                let _ = feedback.send(AeRenderFeedback::Failed { frame: target, code });
            }
        }
    }

    /// The first `"field":"value"` in an envelope. Enough to route a reply without a JSON parser on the
    /// frame path, and deliberately not a parser: nothing here interprets pixels or nested objects.
    fn string_field(frame: &str, field: &str) -> Option<String> {
        let needle = format!("\"{field}\":\"");
        let start = frame.find(&needle)? + needle.len();
        let rest = &frame[start..];
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    }

    /// Poll one complete frame, or nothing. Never consumes a partial frame.
    fn poll_frame(pipe: &mut std::fs::File) -> Option<String> {
        let handle = pipe.as_raw_handle() as HANDLE;
        let mut available: u32 = 0;
        let mut prefix = [0u8; 4];
        let mut peeked: u32 = 0;
        // Peek rather than read: the size has to be known before we can tell whether the whole frame
        // has arrived, and consuming a prefix we cannot follow would desynchronise the stream.
        let ok = unsafe {
            PeekNamedPipe(
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
        if size == 0 || size > MAX_FRAME_BYTES || (available as usize) < size + 4 {
            return None;
        }
        let mut discard = [0u8; 4];
        pipe.read_exact(&mut discard).ok()?;
        let mut body = vec![0u8; size];
        pipe.read_exact(&mut body).ok()?;
        String::from_utf8(body).ok()
    }

    /// Blocking read with a deadline, used only for the handshake where there is nothing to pipeline.
    fn read_frame_blocking(pipe: &mut std::fs::File, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(frame) = poll_frame(pipe) {
                return Ok(frame);
            }
            if Instant::now() >= deadline {
                return Err("no frame arrived before the deadline".to_string());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AeExactTime;

    fn request(frame: u64, revision: u64) -> AeFrameRequest {
        AeFrameRequest {
            frame,
            deadline_nanos: 33_366_700 * frame,
            composition_item_id: 1,
            requested_time: AeExactTime {
                value: (frame * 800).to_string(),
                scale: "23976".to_string(),
            },
            data_revision: revision,
        }
    }

    #[test]
    fn a_render_payload_states_the_frames_own_exact_time_in_the_compositions_scale() {
        let payload = render_frame_payload("run7", &request(3, 7));
        assert!(payload.contains("\"compositionItemId\":1"), "{payload}");
        // PL1's whole point: the instant crosses in the composition's scale, not a float or a frame
        // number the adapter would have to re-derive.
        assert!(payload.contains("\"time\":{\"value\":\"2400\",\"scale\":\"23976\"}"), "{payload}");
        assert!(payload.contains("\"dataRevision\":7"), "{payload}");
    }

    #[test]
    fn the_deadline_crosses_quoted_and_the_frame_id_bare_because_the_adapter_parses_them_so() {
        let mut asked = request(4, 1);
        asked.deadline_nanos = 9_007_199_254_740_993; // 2^53 + 1: the first integer a double loses.
        asked.frame = 9_007_199_254_740_993;
        let payload = render_frame_payload("run7", &asked);
        // `runtime_payload_integer` on the adapter side: quoting this is `INVALID_PAYLOAD`.
        assert!(payload.contains("\"frameId\":9007199254740993"), "{payload}");
        // `runtime_payload_string`: the deadline is quoted, which is what keeps a u64 exact.
        assert!(
            payload.contains("\"presentationDeadlineNanos\":\"9007199254740993\""),
            "{payload}"
        );
    }

    #[test]
    fn identity_is_the_frame_the_revision_and_the_run() {
        // Idempotency is what makes a retry after a lost reply safe: the adapter deduplicates it
        // instead of rendering the frame twice.
        assert_eq!(
            render_request_id("run7", &request(12, 3)),
            render_request_id("run7", &request(12, 3))
        );
        assert_ne!(
            render_request_id("run7", &request(12, 3)),
            render_request_id("run7", &request(12, 4))
        );
        assert_ne!(
            render_request_id("run7", &request(13, 3)),
            render_request_id("run7", &request(12, 3))
        );
        // The adapter remembers accepted keys for the whole After Effects session, so a *new engine
        // run* must not collide with the old one: without this, a restarted engine asking for frame 1
        // again is answered `DUPLICATE_REQUEST` and the frame is never rendered. This happened live.
        assert_ne!(
            render_request_id("run7", &request(12, 3)),
            render_request_id("run8", &request(12, 3))
        );
        // And two runs in the same process, a moment apart, are still distinct.
        let first = AeRuntimeClientConfig::new("ae-1", "t".repeat(32)).run_id;
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = AeRuntimeClientConfig::new("ae-1", "t".repeat(32)).run_id;
        assert_ne!(first, second);
    }

    #[test]
    fn an_envelope_carries_the_operation_session_and_a_monotonic_sequence() {
        let config = AeRuntimeClientConfig::new("ae-wire-1", "t".repeat(32));
        let envelope = render_frame_envelope(&config, &request(2, 1), 41, SystemTime::now());
        assert!(envelope.contains("\"operation\":\"RENDER_FRAME\""), "{envelope}");
        assert!(envelope.contains("\"sessionId\":\"ae-wire-1\""), "{envelope}");
        assert!(envelope.contains("\"sequence\":41"), "{envelope}");
        assert!(envelope.contains("\"kind\":\"request\""), "{envelope}");
        // The idempotency key and the request id are the frame's identity, so a duplicate is visible
        // to the adapter rather than to nobody.
        assert!(
            envelope.contains(&format!("\"idempotencyKey\":\"{}-frame-2-rev-1\"", config.run_id)),
            "{envelope}"
        );
    }

    #[test]
    fn a_deadline_is_absolute_wall_clock_so_the_adapter_can_refuse_a_stale_request() {
        let config = AeRuntimeClientConfig::new("ae-wire-1", "t".repeat(32));
        let epoch = UNIX_EPOCH + Duration::from_millis(1_700_000_000_000);
        let envelope = render_frame_envelope(&config, &request(1, 1), 1, epoch);
        assert!(envelope.contains("\"deadlineUnixMs\":1700000005000"), "{envelope}");
    }

    #[test]
    fn a_frame_is_length_prefixed_big_endian() {
        let framed = encode_frame("{\"a\":1}").expect("frame");
        assert_eq!(&framed[..4], &[0, 0, 0, 7]);
        assert_eq!(&framed[4..], b"{\"a\":1}");
    }

    #[test]
    fn an_oversized_or_empty_frame_is_refused_rather_than_truncated() {
        assert!(encode_frame("").is_err());
        assert!(encode_frame(&"x".repeat(MAX_FRAME_BYTES + 1)).is_err());
    }

    #[test]
    fn the_pipe_path_is_derived_from_the_session_and_credentials_are_validated() {
        let config = AeRuntimeClientConfig::new("ae-accept-20260818", "t".repeat(32));
        assert_eq!(config.pipe_path(), "\\\\.\\pipe\\grapix-ae-runtime-ae-accept-20260818");
        assert!(config.validate().is_ok());
        assert!(AeRuntimeClientConfig::new("bad session", "t".repeat(32)).validate().is_err());
        assert!(AeRuntimeClientConfig::new("ae-1", "short").validate().is_err());
    }

    #[test]
    fn a_hello_names_the_protocol_major_the_adapter_requires() {
        let config = AeRuntimeClientConfig::new("ae-1", "t".repeat(32));
        let hello = hello_frame(&config);
        assert!(hello.contains("\"kind\":\"hello\""), "{hello}");
        assert!(hello.contains("\"protocolMajor\":2"), "{hello}");
        assert!(hello.contains("\"token\":\"tttttttttttttttttttttttttttttttt\""), "{hello}");
    }

    #[test]
    fn a_quote_in_a_field_cannot_break_out_of_the_envelope() {
        let mut asked = request(1, 1);
        asked.requested_time.scale = "23\"976".to_string();
        assert!(render_frame_payload("run7", &asked).contains("23\\\"976"));
    }
}
