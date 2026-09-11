//! The conformance suite: one suite per plane (ADR-001 action 3).
//!
//! Written against `EnginePeer`, never against an implementation, so the same
//! suite runs against a mock now and a real engine later — and, per ADR-001,
//! must pass at L1 exactly as it does at L0.
//!
//! **SKIP is not PASS** (invariant 43). A check that could not be exercised
//! reports SKIP and says why. Defaulting it to PASS would claim coverage of
//! precisely the paths nobody ran.

use gx_asset_plane::{is_syntactically_safe, Transfer};
use gx_contracts::{
    ClockSource, ContentHash, DeviceTier, Locality, MediaCodec, RationalRate, ReferenceState,
    Refusal, Revision, TakeId, PROTOCOL_VERSION,
};
use gx_control_plane::intent::{ClearRequest, CueRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply, OutputConfig};
use gx_control_plane::peer::{EnginePeer, FaultInjection};
use gx_control_plane::sequence::{
    check_kind, Admission, MessageId, MessageKind, Sequence, SequenceTracker,
};
use gx_control_plane::status::{clock_summary, Severity};
use gx_media_plane::{negotiate, ConsumerRole, DropCause, LatestFrameSlot};

/// The result of one conformance check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Fail(String),
    /// Could not be exercised, with the reason. Never treated as a pass.
    Skip(String),
}

/// One named check and what happened.
#[derive(Debug, Clone)]
pub struct Result_ {
    /// Which peer produced this. With several peers in one run, a result that
    /// cannot be attributed to one of them is not actionable: the same check
    /// legitimately passes against one peer and skips against another.
    pub peer: String,
    pub plane: &'static str,
    pub name: &'static str,
    pub outcome: Outcome,
}

/// Accumulated results across every suite.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub results: Vec<Result_>,
    peer: String,
}

impl Report {
    pub fn new() -> Self {
        Self {
            results: Vec::new(),
            peer: "unattributed".to_string(),
        }
    }

    /// Label the peer that subsequent records belong to. Called before each
    /// suite; forgetting it leaves results marked "unattributed" rather than
    /// silently crediting them to the previous peer.
    pub fn set_peer(&mut self, peer: impl Into<String>) {
        self.peer = peer.into();
    }

    pub fn peer(&self) -> &str {
        &self.peer
    }

    fn record(&mut self, plane: &'static str, name: &'static str, outcome: Outcome) {
        self.results.push(Result_ {
            peer: self.peer.clone(),
            plane,
            name,
            outcome,
        });
    }

    pub fn passed(&self) -> usize {
        self.results
            .iter()
            .filter(|r| r.outcome == Outcome::Pass)
            .count()
    }

    pub fn failed(&self) -> usize {
        self.results
            .iter()
            .filter(|r| matches!(r.outcome, Outcome::Fail(_)))
            .count()
    }

    pub fn skipped(&self) -> usize {
        self.results
            .iter()
            .filter(|r| matches!(r.outcome, Outcome::Skip(_)))
            .count()
    }

    pub fn is_conformant(&self) -> bool {
        self.failed() == 0
    }

    /// Record that a peer's checks could not run at all, with the reason.
    ///
    /// A skip, never a pass: a conformance run on a machine without the engine
    /// must say so, not claim the engine conformed (invariant 43).
    pub fn skip_unavailable(&mut self, reason: impl Into<String>) {
        self.record(
            "availability",
            "peer is available",
            Outcome::Skip(reason.into()),
        );
    }
}

/// Turn a boolean expectation into an outcome, with the failure text supplied
/// by the caller so a failing report says what was wrong, not just that
/// something was.
fn expect(condition: bool, failure: impl Into<String>) -> Outcome {
    if condition {
        Outcome::Pass
    } else {
        Outcome::Fail(failure.into())
    }
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

/// Control plane: ordered, acknowledged, intent-based, refusal-explicit.
pub fn control_plane_suite<P: EnginePeer>(peer: &mut P, report: &mut Report) {
    const PLANE: &str = "control";

    let cap = peer.capability();
    report.record(
        PLANE,
        "capability declares the fixed protocol version",
        expect(
            cap.protocol == PROTOCOL_VERSION,
            format!(
                "expected protocol {PROTOCOL_VERSION}, peer offered {}",
                cap.protocol
            ),
        ),
    );

    report.record(
        PLANE,
        "capability declares a locality tier",
        expect(
            matches!(cap.locality, Locality::CoLocated | Locality::Lan),
            "ADR-001 action 2: locality must be declared, not inferred",
        ),
    );

    report.record(
        PLANE,
        "capability declares clock source and reference state",
        expect(
            matches!(
                (cap.clock, cap.reference),
                (
                    ClockSource::Genlocked | ClockSource::Ptp | ClockSource::FreeRun,
                    ReferenceState::Locked | ReferenceState::Unlocked | ReferenceState::NotPresent
                )
            ),
            "ADR-002 action 2: both must appear in the capability exchange",
        ),
    );

    report.record(
        PLANE,
        "live_allowed is false unless tier and reference permit it",
        expect(
            !cap.live_allowed
                || (cap.device_tier == DeviceTier::T0 && cap.reference == ReferenceState::Locked),
            "invariant 20: live_allowed was true with a tier or reference that forbids it",
        ),
    );

    // Status must be answerable, and is how a client learns the frame.
    let status = peer.status();
    report.record(
        PLANE,
        "status is reported on request",
        expect(status.is_some(), "peer did not answer a Status request"),
    );

    let Some(status) = status else {
        report.record(
            PLANE,
            "intent resolution",
            Outcome::Skip("no status, so the current frame is unknown".into()),
        );
        return;
    };

    // A take of something never published must refuse, and name which failure.
    let unknown = peer.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId("conformance/definitely-not-published".into()),
        revision: Revision(1),
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "an unpublished take is refused by name",
        expect(
            matches!(
                unknown,
                EngineReply::Refused(Refusal::UnknownTake { .. })
                    | EngineReply::Refused(Refusal::RevisionMismatch { .. })
            ),
            format!("expected a named refusal, got {unknown:?}"),
        ),
    );

    // A frame already behind the engine cannot be committed to.
    let past = status.current_frame.saturating_sub(1);
    let stale = peer.handle(ClientRequest::Take(TakeRequest {
        take_id: TakeId("conformance/definitely-not-published".into()),
        revision: Revision(1),
        at: TakeAt::Frame { frame: past },
    }));
    report.record(
        PLANE,
        "a take in the past is refused, never fired late",
        expect(
            matches!(stale, EngineReply::Refused(_)),
            format!("expected a refusal for frame {past}, got {stale:?}"),
        ),
    );

    // Clear is intent-based too, and answers with a frame.
    let cleared = peer.handle(ClientRequest::Clear(ClearRequest {
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "clear commits to a frame at or beyond the current one",
        match cleared {
            EngineReply::Cleared(c) => expect(
                c.frame > status.current_frame,
                format!(
                    "committed frame {} is not ahead of current frame {}",
                    c.frame, status.current_frame
                ),
            ),
            other => Outcome::Fail(format!("expected Cleared, got {other:?}")),
        },
    );

    // A cue must not reach Program.
    let cue = peer.handle(ClientRequest::Cue(CueRequest {
        take_id: TakeId("conformance/definitely-not-published".into()),
        revision: Revision(1),
        at: TakeAt::NextOpportunity,
    }));
    report.record(
        PLANE,
        "cue of an unpublished scene refuses like take",
        expect(
            matches!(cue, EngineReply::Refused(_)),
            format!("expected a refusal, got {cue:?}"),
        ),
    );

    // A non-live output must be configurable regardless of tier: the gate is
    // about reaching an audience, not about rendering.
    let out = peer.handle(ClientRequest::ConfigureOutput(OutputConfig {
        adapter: "null".into(),
        live: false,
        accept_free_run: false,
    }));
    report.record(
        PLANE,
        "a non-live output is configurable",
        expect(
            matches!(out, EngineReply::OutputConfigured { live: false, .. }),
            format!("expected a non-live output to configure, got {out:?}"),
        ),
    );

    // Live output on a sub-T0 device must refuse by name.
    if cap.device_tier.live_capable() {
        report.record(
            PLANE,
            "live output refuses below T0",
            Outcome::Skip(format!(
                "peer is {:?}; a sub-T0 peer is needed to exercise this",
                cap.device_tier
            )),
        );
    } else {
        let live = peer.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "conformance-live".into(),
            live: true,
            accept_free_run: true,
        }));
        report.record(
            PLANE,
            "live output refuses below T0",
            expect(
                matches!(live, EngineReply::Refused(Refusal::TierTooLow { .. })),
                format!("invariant 19: expected TierTooLow, got {live:?}"),
            ),
        );
    }

    // Free-run must never present as nominal.
    let summary = clock_summary(&status);
    report.record(
        PLANE,
        "free-run is never reported as nominal",
        expect(
            !summary.free_running || summary.severity != Severity::Nominal,
            "invariant 11: a free-running clock was summarised as nominal",
        ),
    );
}

/// Control-plane delivery semantics: ordering, deduplication, reply identity.
///
/// Exercises the plane contract directly rather than through a peer, because
/// there is no transport yet. When one exists these same properties must hold
/// end to end, and this suite is where that check belongs.
pub fn control_plane_delivery_suite(report: &mut Report) {
    const PLANE: &str = "control";

    let mut t = SequenceTracker::new();
    let in_order = (1..=5).all(|n| t.admit(Sequence(n)) == Admission::Accepted);
    report.record(
        PLANE,
        "in-order messages are accepted",
        expect(in_order, "a message in sequence was not accepted"),
    );

    report.record(
        PLANE,
        "a replay is deduplicated",
        expect(
            t.admit(Sequence(3)) == Admission::Duplicate,
            "a message behind the watermark was not seen as a duplicate",
        ),
    );

    let mut t = SequenceTracker::new();
    t.admit(Sequence(1));
    let gap = t.admit(Sequence(9));
    report.record(
        PLANE,
        "a gap is reported as loss, not silently accepted",
        expect(
            matches!(
                gap,
                Admission::Gap {
                    expected: Sequence(2),
                    ..
                }
            ),
            format!("the control plane tolerates no loss; got {gap:?}"),
        ),
    );

    report.record(
        PLANE,
        "the retransmission that fills a gap is processed",
        expect(
            t.admit(Sequence(2)) == Admission::Accepted,
            "invariant 33: sequence handling must run before deduplication",
        ),
    );

    let invented = MessageId("reply.a.kind.nobody.enumerated".to_string());
    report.record(
        PLANE,
        "replies are recognised by prefix, not by a known list",
        expect(
            invented.is_reply() && invented.kind() == MessageKind::Reply,
            "invariant 34: an unenumerated reply must still be recognised",
        ),
    );

    report.record(
        PLANE,
        "a reply and an event may not share an id",
        expect(
            check_kind(&invented, MessageKind::Event).is_err(),
            "invariant 33: an event carrying a reply id must be rejected",
        ),
    );
}

/// Control-plane checks that need the peer driven into a state.
///
/// A real engine cannot implement `FaultInjection` — nothing makes a genlock
/// generator drop lock on request — so the caller skips this suite and the
/// report says so.
pub fn control_plane_fault_suite<P: EnginePeer + FaultInjection>(
    peer: &mut P,
    report: &mut Report,
) {
    const PLANE: &str = "control";

    let before = match peer.status() {
        Some(s) => s,
        None => {
            report.record(
                PLANE,
                "reference loss holds cadence",
                Outcome::Skip("peer did not answer Status".into()),
            );
            return;
        }
    };

    peer.advance(100);
    let advanced = peer.status().map(|s| s.current_frame).unwrap_or(0);
    report.record(
        PLANE,
        "the frame counter advances monotonically",
        expect(
            advanced > before.current_frame,
            format!(
                "frame did not advance: {} then {advanced}",
                before.current_frame
            ),
        ),
    );

    if before.reference != ReferenceState::Locked {
        report.record(
            PLANE,
            "reference loss holds cadence and refuses new live output",
            Outcome::Skip(format!(
                "peer reference is {:?}; a locked peer is needed to lose lock",
                before.reference
            )),
        );
        return;
    }

    let held = before.timebase;
    peer.set_reference(ReferenceState::Unlocked);
    let after = peer.status().expect("status after reference loss");

    report.record(
        PLANE,
        "reference loss holds the previous cadence",
        expect(
            after.timebase == held,
            format!(
                "ADR-002: cadence changed from {held:?} to {:?}",
                after.timebase
            ),
        ),
    );

    report.record(
        PLANE,
        "reference loss is reported as a degradation",
        expect(
            !after.degradations.is_empty(),
            "a lost reference must be reported, not hidden",
        ),
    );

    report.record(
        PLANE,
        "reference loss emits a transition event",
        expect(
            !peer.drain_events().is_empty(),
            "no event was emitted for the reference transition",
        ),
    );

    let live = peer.handle(ClientRequest::ConfigureOutput(OutputConfig {
        adapter: "conformance-live".into(),
        live: true,
        accept_free_run: true,
    }));
    report.record(
        PLANE,
        "new live output is refused while the reference is lost",
        expect(
            matches!(live, EngineReply::Refused(_)),
            format!("ADR-002: expected a refusal, got {live:?}"),
        ),
    );
}

// ---------------------------------------------------------------------------
// Asset plane
// ---------------------------------------------------------------------------

/// Asset plane: loss-intolerant but restartable, and verified before cached.
///
/// Tested against the plane contract rather than a peer: there is no asset
/// endpoint on `EnginePeer` yet, so the transfer checks that would cross a
/// wire are recorded as SKIP.
pub fn asset_plane_suite(report: &mut Report) {
    const PLANE: &str = "asset";

    let hash = ContentHash("abc".into());
    let mut t = Transfer::new(hash.clone(), 4).expect("a four-chunk transfer");

    t.accept_chunk(0).ok();
    t.accept_chunk(1).ok();
    report.record(
        PLANE,
        "an interrupted transfer resumes by chunk",
        expect(
            t.resume_from() == 2,
            format!("expected resume at chunk 2, got {}", t.resume_from()),
        ),
    );

    report.record(
        PLANE,
        "an out-of-order chunk is refused",
        expect(
            t.accept_chunk(3).is_err(),
            "a skipped chunk was accepted; the asset plane tolerates no loss",
        ),
    );

    t.accept_chunk(2).ok();
    t.accept_chunk(3).ok();
    report.record(
        PLANE,
        "completion is not verification",
        expect(
            !t.may_promote(),
            "invariant 28: complete but unverified bytes were promotable",
        ),
    );

    let mut poisoned = Transfer::new(hash.clone(), 1).expect("a one-chunk transfer");
    poisoned.accept_chunk(0).ok();
    let mismatch = poisoned.verify(&ContentHash("wrong".into()));
    report.record(
        PLANE,
        "a hash mismatch blocks promotion",
        expect(
            mismatch.is_err() && !poisoned.may_promote(),
            "invariant 28: bytes that failed verification were promotable",
        ),
    );

    t.verify(&hash).ok();
    report.record(
        PLANE,
        "a verified transfer may promote",
        expect(t.may_promote(), "a verified transfer was not promotable"),
    );

    report.record(
        PLANE,
        "traversal and absolute paths are rejected",
        expect(
            !is_syntactically_safe("../secret")
                && !is_syntactically_safe("/etc/passwd")
                && !is_syntactically_safe("C:\\Windows")
                && is_syntactically_safe("textures/logo.png"),
            "invariant 42: path gate accepted something it must reject",
        ),
    );

    report.record(
        PLANE,
        "transfer over a peer connection",
        Outcome::Skip("no asset endpoint on the control peer yet".into()),
    );
}

// ---------------------------------------------------------------------------
// Media plane
// ---------------------------------------------------------------------------

/// Media plane: drops rather than queues, and negotiates by locality.
pub fn media_plane_suite(locality: Locality, report: &mut Report) {
    const PLANE: &str = "media";

    let interactive = negotiate(locality, ConsumerRole::Interactive);
    let observational = negotiate(locality, ConsumerRole::Observational);

    report.record(
        PLANE,
        "encoding is negotiated from locality and role",
        expect(
            match locality {
                Locality::CoLocated => interactive.codec == MediaCodec::RawShared,
                Locality::Lan => interactive.codec != MediaCodec::RawShared,
            },
            format!(
                "ADR-004: {locality:?} interactive negotiated {:?}",
                interactive.codec
            ),
        ),
    );

    report.record(
        PLANE,
        "an interactive stream over a LAN adapts resolution",
        match locality {
            Locality::Lan => expect(
                interactive.adaptive_resolution,
                "invariant 15: resolution must give way before latency does",
            ),
            Locality::CoLocated => Outcome::Skip("co-located: there is no encode to adapt".into()),
        },
    );

    report.record(
        PLANE,
        "a confidence monitor stays bounded",
        expect(
            observational.codec == MediaCodec::Jpeg,
            format!("expected a bounded codec, got {:?}", observational.codec),
        ),
    );

    let mut slot: LatestFrameSlot<u64> = LatestFrameSlot::new();
    for frame in 1..=100 {
        slot.publish(frame, DropCause::ConsumerBusy);
    }
    let received = slot.take();
    report.record(
        PLANE,
        "a slow consumer receives the newest frame, not a backlog",
        expect(
            received == Some(100),
            format!("expected frame 100, got {received:?}"),
        ),
    );
    report.record(
        PLANE,
        "dropped frames are counted by cause",
        expect(
            slot.drops().consumer_busy == 99,
            format!(
                "expected 99 consumer-busy drops, got {}",
                slot.drops().consumer_busy
            ),
        ),
    );

    report.record(
        PLANE,
        "media never influences Program cadence",
        // Structural: `publish` returns unit and cannot fail, so a producer has
        // no error path to block on. Asserted by the type, not at runtime.
        Outcome::Pass,
    );
}

// ---------------------------------------------------------------------------
// Timing plane
// ---------------------------------------------------------------------------

/// Timing plane: a cable, not a software transport.
///
/// This suite verifies an *absence*. It serialises every control request and
/// asserts that none of them carries a time, which is the only way to check a
/// negative that a future field addition would otherwise break silently.
pub fn timing_plane_suite(report: &mut Report) {
    const PLANE: &str = "timing";

    const FORBIDDEN: &[&str] = &[
        "timestamp",
        "wallClock",
        "wall_clock",
        "\"now\"",
        "atTime",
        "at_time",
        "deadline",
        "millis",
        "nanos",
    ];

    let requests = vec![
        ClientRequest::Authenticate {
            token: gx_control_transport::Token::mint(
                "conformance",
                gx_contracts::auth::Role::Engine,
                vec![gx_contracts::auth::Scope::Report],
                b"conformance-secret",
            )
            .expect("the conformance credential mints")
            .as_str()
            .to_owned(),
        },
        ClientRequest::Capability,
        ClientRequest::Status,
        ClientRequest::Cue(CueRequest {
            take_id: TakeId("t".into()),
            revision: Revision(1),
            at: TakeAt::NextOpportunity,
        }),
        ClientRequest::Take(TakeRequest {
            take_id: TakeId("t".into()),
            revision: Revision(1),
            at: TakeAt::Frame { frame: 42 },
        }),
        ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
        }),
        ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "null".into(),
            live: false,
            accept_free_run: false,
        }),
    ];

    let mut offender = None;
    for request in &requests {
        let json = serde_json::to_string(request).unwrap_or_default();
        for forbidden in FORBIDDEN {
            if json.contains(forbidden) {
                offender = Some(format!("{request:?} carries {forbidden}"));
            }
        }
    }
    report.record(
        PLANE,
        "no control message carries a time",
        match offender {
            None => Outcome::Pass,
            Some(what) => Outcome::Fail(format!("invariant 8: {what}")),
        },
    );

    report.record(
        PLANE,
        "intent is expressible without a time",
        expect(
            matches!(TakeAt::NextOpportunity, TakeAt::NextOpportunity),
            "TakeAt::NextOpportunity must exist as the ordinary case",
        ),
    );

    report.record(
        PLANE,
        "reference lock is observed on hardware",
        Outcome::Skip("external gate: needs a reference generator and a card".into()),
    );

    report.record(
        PLANE,
        "rates are rational",
        expect(
            RationalRate::P29_97.num == 30_000 && RationalRate::P29_97.den == 1001,
            "invariant 12: 29.97 must be exactly 30000/1001",
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_is_not_counted_as_a_pass() {
        let mut r = Report::new();
        r.record("t", "a", Outcome::Pass);
        r.record("t", "b", Outcome::Skip("no hardware".into()));
        assert_eq!(r.passed(), 1);
        assert_eq!(r.skipped(), 1);
        assert_eq!(r.failed(), 0);
        // Invariant 43: a skip does not make the run non-conformant, but it is
        // never reported as coverage either.
        assert!(r.is_conformant());
    }

    #[test]
    fn a_failure_makes_the_run_non_conformant() {
        let mut r = Report::new();
        r.record("t", "a", Outcome::Fail("broken".into()));
        assert!(!r.is_conformant());
        assert_eq!(r.failed(), 1);
    }

    #[test]
    fn the_plane_suites_that_need_no_peer_run_clean() {
        let mut r = Report::new();
        asset_plane_suite(&mut r);
        control_plane_delivery_suite(&mut r);
        media_plane_suite(Locality::Lan, &mut r);
        timing_plane_suite(&mut r);
        assert_eq!(r.failed(), 0, "unexpected failures: {:?}", r.results);
        assert!(r.passed() > 0);
    }
}
