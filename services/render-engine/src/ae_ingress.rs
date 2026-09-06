//! Program ingress for After Effects frames.
//!
//! `AE-F2a`. The engine asks for one frame per due Program deadline, ahead of presentation, and this
//! module decides whether what came back is the frame it asked for. It consumes **descriptor plus slot
//! lease only** — never pixels through the protocol, never a scene document, and **not one Adobe SDK
//! call**. The adapter owns After Effects; the engine owns Program. That split is invariant 1, and this
//! module is where it would be quietest to break, so it is stated here rather than assumed.
//!
//! ## Same host, deliberately
//!
//! `AE-F1`'s ring is a Windows shared-memory mapping and the adapter's control channel is a local
//! same-user named pipe: both are same-host by construction. A separate After Effects host is L0's
//! **V2/V3**, which is conditional and research respectively, and would need a real frame transport —
//! 1080p59.94 BGRA8 is 3.98 Gbit/s, 2160p59.94 is 15.91, and compressing to fit would violate invariant
//! 7. So a non-local session is **refused by name** rather than left undefined: an unapproved topology
//! that merely happens not to work is one bug away from appearing to work.
//!
//! ## What "the frame it asked for" means
//!
//! A late render must never be presented as if it were current. The ledger records exactly one request
//! per frame; a descriptor is accepted only when it carries that frame's id, its revision, its exact
//! requested instant and the negotiated pixel tuple. Everything else is refused with a reason and
//! counted. Policy — what an operator sees, whether Program holds or blacks — belongs to `PL4`; this
//! module hands over facts and takes no decision on air.

use std::collections::BTreeMap;

use crate::protocol::{AeExactTime, AeFrameColorFormat, AeFrameDescriptor, AeFrameStatus};

/// Everything Program needs to ask After Effects for frames, in one place the engine can hold.
///
/// The composition clock is here rather than derived per request because `PL1` settled that a declared
/// rate and a composition's own scale are two clocks until proven equal: the clock is reconciled once
/// when the source is installed, and every later frame is a multiplication that cannot fall off a frame
/// boundary.
pub struct AeProgramSource {
    session: AeIngressSession,
    clock: crate::stage::AeCompositionClock,
    ledger: AeRequestLedger,
    /// The revision in force. `AE-CD2` advances this only on an accepted revision.
    data_revision: u64,
    /// `AE-F2b`'s bounded lead: how many frames ahead of presentation this source asks for.
    pipeline: crate::ae_schedule::AeFramePipeline,
    /// The Program rate, kept so a window can compute its own absolute deadlines.
    rate: crate::stage::FrameRate,
}

impl AeProgramSource {
    /// Install a source, refusing a topology or a clock that cannot carry the Program rate.
    ///
    /// Both refusals are structural: they condemn every frame, so they belong here and not in the
    /// per-frame path where they would be re-tested fifty times a second.
    pub fn new(
        session: AeIngressSession,
        clock: crate::stage::AeCompositionClock,
        program_rate: crate::stage::FrameRate,
        data_revision: u64,
    ) -> Result<Self, AeIngressRefusal> {
        if session.origin != AeSessionOrigin::LocalSharedMemory {
            return Err(AeIngressRefusal::SessionNotLocal);
        }
        clock.reconcile(program_rate).map_err(|_| AeIngressRefusal::FormatMismatch {
            detail: format!(
                "composition clock cannot carry the Program rate {}/{}",
                program_rate.numerator, program_rate.denominator
            ),
        })?;
        let pipeline = crate::ae_schedule::AeFramePipeline::new(
            program_rate,
            crate::ae_schedule::DEFAULT_RING_CAPACITY,
        );
        Ok(Self {
            session,
            clock,
            ledger: AeRequestLedger::new(),
            data_revision,
            pipeline,
            rate: program_rate,
        })
    }

    pub fn session(&self) -> &AeIngressSession {
        &self.session
    }

    pub fn counters(&self) -> AeIngressCounters {
        self.ledger.counters()
    }

    pub fn in_flight_len(&self) -> usize {
        self.ledger.in_flight_len()
    }

    /// Bound the pipeline to the ring's real slot count, once a frame source has reported it.
    pub fn set_ring_capacity(&mut self, capacity: usize) {
        self.pipeline.set_capacity(capacity);
    }

    pub fn pipeline(&self) -> crate::ae_schedule::AeFramePipeline {
        self.pipeline
    }

    /// Advance the data revision, re-pointing work already in flight at it.
    ///
    /// Returns the requests to ask After Effects for again: with a real pipeline a data change lands
    /// while several frames are outstanding, and every one of them was rendered against data that no
    /// longer applies. Their old-revision descriptors still arrive and are refused `AE_STALE_REVISION`
    /// rather than presented.
    pub fn set_data_revision(&mut self, revision: u64) -> Vec<AeFrameRequest> {
        if self.data_revision == revision {
            return Vec::new();
        }
        self.data_revision = revision;
        self.ledger.supersede_revision(revision)
    }

    /// Build the request for `frame`, or `None` when the instant is not on a composition frame.
    pub fn request_for(&self, frame: u64, deadline_nanos: u64) -> Option<AeFrameRequest> {
        Some(AeFrameRequest {
            frame,
            deadline_nanos,
            composition_item_id: self.session.composition_item_id,
            requested_time: self.clock.program_frame_to_composition_time(frame)?,
            data_revision: self.data_revision,
        })
    }

    /// Issue at most one request for `frame`. Returns the request when it is newly outstanding.
    pub fn issue(&mut self, frame: u64, deadline_nanos: u64) -> Option<AeFrameRequest> {
        let request = self.request_for(frame, deadline_nanos)?;
        if self.ledger.issue(request.clone()) { Some(request) } else { None }
    }

    /// Issue every request the current lead window needs, newest frames last.
    ///
    /// This is `AE-F2b`'s scheduling entry point and the only place the depth, the ring capacity and
    /// the ledger meet. Four rules, in this order:
    ///
    /// 0. **Requests below `next` are abandoned first.** Program has moved past them, so ingress would
    ///    refuse their renders as historical anyway — and a request that can never be presented is
    ///    still holding ring capacity. This was found by running the real clock against a producer
    ///    that never delivered: the clock only abandoned frames when it *skipped* some, so with a
    ///    stalled After Effects and an otherwise punctual clock nothing was ever abandoned, the
    ///    in-flight set stayed full of dead requests, and Program never asked for another frame again
    ///    — a permanent stall that survived the producer recovering. Draining here makes saturation
    ///    mean "the ring is full of work that is still wanted", which is the only reading that should
    ///    shrink the lead depth.
    /// 1. **A frame already outstanding is skipped silently.** Steady state is a full window, so this
    ///    is the common case and it is not pressure.
    /// 2. **`next` is skipped when its deadline has already passed.** Asking for a frame that is
    ///    already historical burns the slot the frame that *is* due needs. Later frames in the window
    ///    have later deadlines by construction, so only the first can be past.
    /// 3. **Capacity stops the window and counts saturation once.** Reaching the ring's limit with a
    ///    frame still wanted means the pipeline is too deep for the ring, which shrinks the depth.
    pub fn issue_window(&mut self, next: u64, elapsed_nanos: u64) -> Vec<AeFrameRequest> {
        self.abandon_before(next);

        let capacity = self.pipeline.capacity();
        let mut issued = Vec::new();
        let mut saturated = false;

        for frame in self.pipeline.window(next).iter() {
            if self.ledger.is_in_flight(frame) {
                continue;
            }
            if self.ledger.last_presented().is_some_and(|last| frame <= last) {
                continue;
            }
            let deadline_nanos = self.rate.deadline_nanos(frame);
            if frame == next && elapsed_nanos >= deadline_nanos {
                continue;
            }
            if self.ledger.in_flight_len() >= capacity {
                saturated = true;
                break;
            }
            if let Some(request) = self.issue(frame, deadline_nanos) {
                issued.push(request);
            }
        }

        if saturated {
            self.ledger.note_saturated();
            self.note_pressure();
        }
        issued
    }

    /// Record a presented frame against the pipeline's health, restoring depth after a clean run.
    fn note_presented(&mut self, before_deadline: bool) {
        if before_deadline {
            if let crate::ae_schedule::AeDepthChange::Restored { .. } =
                self.pipeline.note_healthy_frame()
            {
                self.ledger.note_depth_restored();
            }
        } else {
            // Late is the shallow-pipeline signal, and shrinking would make it later. It only stops
            // recovery, so a reduced depth is not restored while frames are still missing deadlines.
            self.pipeline.note_unhealthy_frame();
        }
    }

    fn note_pressure(&mut self) {
        if let crate::ae_schedule::AeDepthChange::Reduced { .. } = self.pipeline.note_pressure() {
            self.ledger.note_depth_reduced();
        }
    }

    /// Abandon requests the clock has skipped past, counting each as missed.
    ///
    /// A skip is the shallow signal, so it stops recovery for the same reason lateness does.
    pub fn abandon_before(&mut self, due: u64) -> Vec<u64> {
        let abandoned = self.ledger.abandon_before(due);
        if !abandoned.is_empty() {
            self.pipeline.note_unhealthy_frame();
        }
        abandoned
    }

    /// The ring refused a publish because it was full: the pipeline is too deep for it.
    pub fn note_backpressure(&mut self) {
        self.ledger.note_backpressure();
        self.note_pressure();
    }

    /// Validate a published descriptor, and record what it says about the pipeline's health.
    ///
    /// Health is folded in here rather than left to the caller because every accepted frame is
    /// evidence about the schedule, and a caller that forgot to report it would leave a reduced depth
    /// reduced forever.
    pub fn accept(
        &mut self,
        descriptor: &AeFrameDescriptor,
        due: u64,
        now_nanos: u64,
    ) -> Result<AeAcceptedFrame, AeIngressRefusal> {
        let session = self.session.clone();
        let accepted = self.ledger.accept(&session, descriptor, due, now_nanos);
        match &accepted {
            Ok(frame) => self.note_presented(frame.presented_before_deadline),
            // The adapter reporting it could not deliver a requested frame is a miss, not pressure.
            Err(AeIngressRefusal::NotReady { .. }) => self.pipeline.note_unhealthy_frame(),
            Err(_) => {}
        }
        accepted
    }

    /// Refuse an otherwise valid descriptor before presentation when the engine's output contract
    /// cannot carry its bytes. The request is consumed and the refusal is counted, but the frame never
    /// becomes `last_presented`.
    pub fn refuse(
        &mut self,
        descriptor: &AeFrameDescriptor,
        due: u64,
        now_nanos: u64,
        refusal: AeIngressRefusal,
    ) -> AeIngressRefusal {
        self.ledger
            .refuse(&self.session, descriptor, due, now_nanos, refusal)
    }
}

/// Where the adapter that publishes into the ring is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AeSessionOrigin {
    /// Same machine, shared-memory ring and local named pipe. The only approved topology (L0 V1).
    LocalSharedMemory,
    /// Any transport that crosses a machine boundary. Refused: see the module note.
    Remote,
}

/// One evaluation request, as the Program clock issues it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeFrameRequest {
    /// Program frame number. The correlation key for everything that follows.
    pub frame: u64,
    /// Absolute presentation deadline, from the frame number by integer arithmetic — never accumulated.
    pub deadline_nanos: u64,
    pub composition_item_id: i64,
    /// The instant to evaluate, already restated in the composition's own scale by `PL1`.
    pub requested_time: AeExactTime,
    /// The data revision that must be in force for this frame to be valid.
    pub data_revision: u64,
}

/// The negotiated tuple a descriptor must match exactly. Fixed for the life of a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeNegotiatedFormat {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub color_format: AeFrameColorFormat,
    pub alpha_mode: String,
    pub color_space: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeIngressSession {
    pub origin: AeSessionOrigin,
    /// Bumped by the adapter whenever the mapping is recreated; a stale generation is a stale mapping.
    pub ring_generation: u64,
    pub composition_item_id: i64,
    pub format: AeNegotiatedFormat,
}

/// Why a descriptor was refused. Every variant is a fact, not a policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AeIngressRefusal {
    /// The publishing adapter is not on this machine. Structural, and refused before anything else.
    SessionNotLocal,
    /// The mapping was recreated since this descriptor was written.
    StaleRingGeneration { expected: u64, found: u64 },
    /// A frame for a composition this session did not negotiate.
    CompositionMismatch { expected: i64, found: i64 },
    /// No request is outstanding for this frame id.
    Unrequested { frame: u64 },
    /// A second descriptor for a frame already presented. Never presented twice.
    Duplicate { frame: u64 },
    /// The frame is older than one already presented; accepting it would run Program backwards.
    OutOfOrder { frame: u64, last_presented: u64 },
    /// The frame arrived, but a later frame is now due: presenting it would be slow motion.
    Historical { frame: u64, due: u64 },
    /// The adapter itself marked the frame late or missed.
    NotReady { status: AeFrameStatus },
    /// The evaluated instant is not the instant requested.
    TimeMismatch { requested: AeExactTime, evaluated: AeExactTime },
    /// The frame carries a revision other than the one requested.
    StaleRevision { expected: u64, found: u64 },
    /// Dimensions, stride or the pixel tuple disagree with the negotiated format.
    FormatMismatch { detail: String },
    /// The descriptor's byte length cannot hold the frame it describes.
    ImpossibleGeometry { detail: String },
}

impl AeIngressRefusal {
    /// Stable machine-readable code. `PL4` keys policy off these, so they are part of the contract.
    pub fn code(&self) -> &'static str {
        match self {
            Self::SessionNotLocal => "AE_SESSION_NOT_LOCAL",
            Self::StaleRingGeneration { .. } => "AE_STALE_RING_GENERATION",
            Self::CompositionMismatch { .. } => "AE_COMPOSITION_MISMATCH",
            Self::Unrequested { .. } => "AE_FRAME_UNREQUESTED",
            Self::Duplicate { .. } => "AE_FRAME_DUPLICATE",
            Self::OutOfOrder { .. } => "AE_FRAME_OUT_OF_ORDER",
            Self::Historical { .. } => "AE_FRAME_HISTORICAL",
            Self::NotReady { .. } => "AE_FRAME_NOT_READY",
            Self::TimeMismatch { .. } => "AE_TIME_MISMATCH",
            Self::StaleRevision { .. } => "AE_STALE_REVISION",
            Self::FormatMismatch { .. } => "AE_REJECTED_FORMAT",
            Self::ImpossibleGeometry { .. } => "AE_IMPOSSIBLE_GEOMETRY",
        }
    }
}

/// Counters the card requires, keyed by nothing: totals only, with per-frame facts logged by the caller.
///
/// `AE-F2b` added the last four. They are the scheduling policy's own facts — how often the ring was
/// the binding limit, how much work a data change invalidated, and every depth change — and they exist
/// because a pipeline that quietly settled one step shallow would otherwise be indistinguishable from
/// one running at its configured depth.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AeIngressCounters {
    pub requested: u64,
    pub ready_before_deadline: u64,
    pub late: u64,
    pub missed: u64,
    pub ring_backpressured: u64,
    pub stale_revision: u64,
    pub rejected_format: u64,
    pub refused_other: u64,
    /// A tick wanted a frame the in-flight set had no room for.
    pub in_flight_saturated: u64,
    /// Outstanding requests re-pointed at a new data revision.
    pub revision_superseded: u64,
    pub lead_depth_reduced: u64,
    pub lead_depth_restored: u64,
}

/// A descriptor that passed every check, with the slot the caller must release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeAcceptedFrame {
    pub frame: u64,
    pub slot_index: u32,
    pub data_revision: u64,
    pub presented_before_deadline: bool,
}
/// A borrowed slot from the adapter-owned frame ring.
///
/// The source retains ownership of the bytes until `AeProgramFrameSource::release_frame` is called.
/// This lets Program copy from shared memory into its fixed output staging slab without putting pixels
/// on a protocol or browser boundary.
#[derive(Debug)]
pub struct AeLeasedFrame<'a> {
    pub descriptor: &'a AeFrameDescriptor,
    pub bytes: &'a [u8],
}

/// An error while taking a ready ring slot.
///
/// A source that has already acquired a slot must report its index so the engine can return that lease
/// even though no descriptor or pixels are usable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeFrameSourceError {
    pub slot_index: Option<u32>,
    pub detail: String,
}

/// Adapter-owned boundary for obtaining and returning one shared-memory frame lease.
///
/// The engine owns Program and never calls an Adobe SDK. A real mapping consumer can implement this
/// directly; tests use a scripted producer with the same take/release contract.
pub trait AeProgramFrameSource: Send {
    fn take_ready_frame(
        &mut self,
        frame: u64,
    ) -> Result<Option<AeLeasedFrame<'_>>, AeFrameSourceError>;

    fn release_frame(&mut self, slot_index: u32);

    /// Slots the ring actually has, when the source knows.
    ///
    /// `AE-F2b` bounds frames in flight by this: asking for more frames than the ring can hold
    /// guarantees back-pressure. `None` means "not reported", which leaves the conservative default
    /// in force rather than inventing a capacity — a scripted producer has no ring at all.
    fn ring_slot_count(&self) -> Option<u32> {
        None
    }
}

/// Outstanding requests, and the guarantee that there is at most one per frame.
///
/// A timer wakeup that fires twice for the same frame — or a retry after a slow lock — must not issue a
/// second evaluation: After Effects would render the frame twice and the ring would carry two
/// descriptors that both look correct.
#[derive(Debug, Default)]
pub struct AeRequestLedger {
    in_flight: BTreeMap<u64, AeFrameRequest>,
    last_presented: Option<u64>,
    counters: AeIngressCounters,
}

impl AeRequestLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn counters(&self) -> AeIngressCounters {
        self.counters
    }

    pub fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }

    pub fn last_presented(&self) -> Option<u64> {
        self.last_presented
    }

    /// Is `frame` already outstanding? `AE-F2b`'s window asks this before spending ring capacity on it.
    pub fn is_in_flight(&self, frame: u64) -> bool {
        self.in_flight.contains_key(&frame)
    }

    /// A tick wanted to request a frame the in-flight set had no room for.
    pub fn note_saturated(&mut self) {
        self.counters.in_flight_saturated += 1;
    }

    pub fn note_depth_reduced(&mut self) {
        self.counters.lead_depth_reduced += 1;
    }

    pub fn note_depth_restored(&mut self) {
        self.counters.lead_depth_restored += 1;
    }

    /// Re-point every outstanding request at `revision`, returning the ones to ask for again.
    ///
    /// A data revision invalidates work already in flight, and with a pipeline that is real rather
    /// than one frame deep it invalidates several frames at once. The requests are **kept** and
    /// rewritten rather than dropped, which is what preserves the diagnosis: a descriptor rendered at
    /// the old revision then arrives against a request holding the new one and refuses
    /// `AE_STALE_REVISION` — the honest answer. Dropping them instead would answer
    /// `AE_FRAME_UNREQUESTED` about a frame that was requested, which is exactly the confusion
    /// `AE-F2a` removed from the historical path.
    pub fn supersede_revision(&mut self, revision: u64) -> Vec<AeFrameRequest> {
        let mut revised = Vec::new();
        for request in self.in_flight.values_mut() {
            if request.data_revision != revision {
                request.data_revision = revision;
                revised.push(request.clone());
            }
        }
        self.counters.revision_superseded += revised.len() as u64;
        revised
    }

    /// Record an intent to request `frame`. Returns false when one is already outstanding.
    ///
    /// The caller issues the adapter request only when this returns true, which is what makes "exactly
    /// one evaluation request per due Program frame" a property of the ledger rather than of the
    /// caller's control flow.
    pub fn issue(&mut self, request: AeFrameRequest) -> bool {
        if self.in_flight.contains_key(&request.frame) {
            return false;
        }
        if self.last_presented.is_some_and(|last| request.frame <= last) {
            return false;
        }
        self.in_flight.insert(request.frame, request);
        self.counters.requested += 1;
        true
    }

    /// Abandon every outstanding request older than `due`, counting each as missed.
    ///
    /// Called when the clock skips late frames. Their renders may still arrive; they are refused as
    /// `Historical` rather than presented, because a frame nobody is waiting for is not a frame to show.
    pub fn abandon_before(&mut self, due: u64) -> Vec<u64> {
        let abandoned: Vec<u64> = self.in_flight.range(..due).map(|(frame, _)| *frame).collect();
        for frame in &abandoned {
            self.in_flight.remove(frame);
            self.counters.missed += 1;
        }
        abandoned
    }

    /// Note that the ring refused a publish because it was full. Back-pressure is a fact, not an error.
    pub fn note_backpressure(&mut self) {
        self.counters.ring_backpressured += 1;
    }

    /// Validate a descriptor against the session, the outstanding request, and what is due now.
    ///
    /// `due` is the frame the clock has decided is current. `now_nanos` is elapsed time on the same
    /// clock as `deadline_nanos`, used only to record whether the frame beat its deadline.
    pub fn accept(
        &mut self,
        session: &AeIngressSession,
        descriptor: &AeFrameDescriptor,
        due: u64,
        now_nanos: u64,
    ) -> Result<AeAcceptedFrame, AeIngressRefusal> {
        let refusal = self.evaluate(session, descriptor, due, now_nanos);
        match refusal {
            Ok(accepted) => {
                self.in_flight.remove(&accepted.frame);
                self.last_presented = Some(accepted.frame);
                if accepted.presented_before_deadline {
                    self.counters.ready_before_deadline += 1;
                } else {
                    self.counters.late += 1;
                }
                Ok(accepted)
            }
            Err(error) => {
                self.record_refusal(descriptor, &error);
                Err(error)
            }
        }
    }

    /// Consume a valid request as a refusal after an engine-side boundary check.
    ///
    /// Ingress validation still takes precedence: a malformed descriptor must retain its own precise
    /// diagnosis rather than being relabelled as an output disagreement.
    pub fn refuse(
        &mut self,
        session: &AeIngressSession,
        descriptor: &AeFrameDescriptor,
        due: u64,
        now_nanos: u64,
        refusal: AeIngressRefusal,
    ) -> AeIngressRefusal {
        let error = self
            .evaluate(session, descriptor, due, now_nanos)
            .err()
            .unwrap_or(refusal);
        self.record_refusal(descriptor, &error);
        error
    }

    fn record_refusal(&mut self, descriptor: &AeFrameDescriptor, error: &AeIngressRefusal) {
        match error {
            AeIngressRefusal::StaleRevision { .. } => self.counters.stale_revision += 1,
            AeIngressRefusal::FormatMismatch { .. } | AeIngressRefusal::ImpossibleGeometry { .. } => {
                self.counters.rejected_format += 1
            }
            // `NotReady` is the adapter telling us it could not deliver this frame: it was requested
            // and will not be presented, so it is a miss and the request is dropped below, which is
            // what stops `abandon_before` counting it a second time.
            AeIngressRefusal::NotReady { .. } => self.counters.missed += 1,
            // `Historical` deliberately does **not** touch `missed`. A frame the clock skipped was
            // already counted missed by `abandon_before` at the moment it was abandoned; counting its
            // late arrival again would report two misses for one frame.
            _ => self.counters.refused_other += 1,
        }
        // A refused descriptor still frees its request: leaving it outstanding would block the frame
        // from ever being asked for again, and the ring slot is released by the caller.
        self.in_flight.remove(&descriptor.frame_id);
    }


    fn evaluate(
        &self,
        session: &AeIngressSession,
        descriptor: &AeFrameDescriptor,
        due: u64,
        now_nanos: u64,
    ) -> Result<AeAcceptedFrame, AeIngressRefusal> {
        // Locality first. An unapproved topology is refused before its bytes are trusted at all.
        if session.origin != AeSessionOrigin::LocalSharedMemory {
            return Err(AeIngressRefusal::SessionNotLocal);
        }
        if descriptor.ring_generation != session.ring_generation {
            return Err(AeIngressRefusal::StaleRingGeneration {
                expected: session.ring_generation,
                found: descriptor.ring_generation,
            });
        }
        if descriptor.composition_item_id != session.composition_item_id {
            return Err(AeIngressRefusal::CompositionMismatch {
                expected: session.composition_item_id,
                found: descriptor.composition_item_id,
            });
        }
        if self.last_presented.is_some_and(|last| descriptor.frame_id == last) {
            return Err(AeIngressRefusal::Duplicate { frame: descriptor.frame_id });
        }
        if self.last_presented.is_some_and(|last| descriptor.frame_id < last) {
            return Err(AeIngressRefusal::OutOfOrder {
                frame: descriptor.frame_id,
                last_presented: self.last_presented.unwrap_or(0),
            });
        }
        // Historical is checked *before* the outstanding-request lookup, and the order is the whole
        // diagnosis. When the clock skips late frames it abandons their requests, so a render that
        // arrives afterwards has no request to find — reporting it `Unrequested` would say "nobody
        // asked for this", when in fact it was asked for and simply came too late to present. A frame
        // below what is due cannot be shown whatever its request status, so that is the honest answer.
        if descriptor.frame_id < due {
            return Err(AeIngressRefusal::Historical { frame: descriptor.frame_id, due });
        }
        let Some(request) = self.in_flight.get(&descriptor.frame_id) else {
            return Err(AeIngressRefusal::Unrequested { frame: descriptor.frame_id });
        };
        if descriptor.status != AeFrameStatus::Ready {
            return Err(AeIngressRefusal::NotReady { status: descriptor.status });
        }
        if !exact_times_equal(&request.requested_time, &descriptor.evaluated_time) {
            return Err(AeIngressRefusal::TimeMismatch {
                requested: request.requested_time.clone(),
                evaluated: descriptor.evaluated_time.clone(),
            });
        }
        if descriptor.data_revision != request.data_revision {
            return Err(AeIngressRefusal::StaleRevision {
                expected: request.data_revision,
                found: descriptor.data_revision,
            });
        }
        check_format(&session.format, descriptor)?;

        Ok(AeAcceptedFrame {
            frame: descriptor.frame_id,
            slot_index: descriptor.slot_index,
            data_revision: descriptor.data_revision,
            presented_before_deadline: now_nanos <= request.deadline_nanos,
        })
    }
}

fn check_format(
    format: &AeNegotiatedFormat,
    descriptor: &AeFrameDescriptor,
) -> Result<(), AeIngressRefusal> {
    if descriptor.width != format.width || descriptor.height != format.height {
        return Err(AeIngressRefusal::FormatMismatch {
            detail: format!(
                "negotiated {}x{}, descriptor {}x{}",
                format.width, format.height, descriptor.width, descriptor.height
            ),
        });
    }
    if descriptor.stride != format.stride {
        return Err(AeIngressRefusal::FormatMismatch {
            detail: format!("negotiated stride {}, descriptor {}", format.stride, descriptor.stride),
        });
    }
    if descriptor.color_format != format.color_format {
        return Err(AeIngressRefusal::FormatMismatch {
            detail: format!(
                "negotiated {:?}, descriptor {:?}",
                format.color_format, descriptor.color_format
            ),
        });
    }
    // Alpha and colour space are compared as the adapter reported them. `AE-F0` finding C4 is why the
    // *observed* layout is trusted and a requested one is not: with BGRA requested, repeat checkouts
    // alternated BGRA and ARGB following the call count, so believing the request would swap channels
    // on every other frame.
    if descriptor.alpha_mode != format.alpha_mode {
        return Err(AeIngressRefusal::FormatMismatch {
            detail: format!(
                "negotiated alpha {}, descriptor {}",
                format.alpha_mode, descriptor.alpha_mode
            ),
        });
    }
    if descriptor.color_space != format.color_space {
        return Err(AeIngressRefusal::FormatMismatch {
            detail: format!(
                "negotiated colour space {}, descriptor {}",
                format.color_space, descriptor.color_space
            ),
        });
    }
    // Stride must actually hold a row. `AE-F0` finding C3: a hardcoded 4 bytes reported a correct
    // 16-bit row as half padding, so geometry is checked rather than assumed.
    let minimum = descriptor.width.checked_mul(4).ok_or_else(|| {
        AeIngressRefusal::ImpossibleGeometry { detail: "width overflows a row".to_string() }
    })?;
    if descriptor.stride < minimum {
        return Err(AeIngressRefusal::ImpossibleGeometry {
            detail: format!(
                "stride {} cannot hold {} pixels at 4 bytes",
                descriptor.stride, descriptor.width
            ),
        });
    }
    if descriptor
        .stride
        .checked_mul(descriptor.height)
        .is_none()
    {
        return Err(AeIngressRefusal::ImpossibleGeometry {
            detail: "stride times height overflows".to_string(),
        });
    }
    Ok(())
}

/// Cross-multiplied equality, so `800/23976` and `100/2997` are one instant.
fn exact_times_equal(left: &AeExactTime, right: &AeExactTime) -> bool {
    let parse = |value: &str| value.parse::<u128>().ok();
    match (
        parse(&left.value),
        parse(&left.scale),
        parse(&right.value),
        parse(&right.scale),
    ) {
        (Some(lv), Some(ls), Some(rv), Some(rs)) if ls != 0 && rs != 0 => {
            lv.checked_mul(rs) == rv.checked_mul(ls)
        }
        _ => false,
    }
}


#[cfg(test)]
mod tests {
    use super::{
        AeFrameRequest, AeIngressCounters, AeIngressRefusal, AeIngressSession, AeNegotiatedFormat,
        AeProgramSource, AeRequestLedger, AeSessionOrigin,
    };
    use crate::{
        protocol::{AeExactTime, AeFrameColorFormat, AeFrameDescriptor, AeFrameStatus},
        stage::{AeCompositionClock, FrameRate},
    };

    const RING_GENERATION: u64 = 7;
    const COMPOSITION_ITEM_ID: i64 = 41;
    const DATA_REVISION: u64 = 23;
    const DEADLINE_NANOS: u64 = 1_000;

    fn measured_bo0a_pair(frame: u64) -> (AeIngressSession, AeFrameDescriptor) {
        let time = AeExactTime {
            value: (frame * 800).to_string(),
            scale: "23976".to_string(),
        };
        let session = AeIngressSession {
            origin: AeSessionOrigin::LocalSharedMemory,
            ring_generation: RING_GENERATION,
            composition_item_id: COMPOSITION_ITEM_ID,
            format: AeNegotiatedFormat {
                width: 1_920,
                height: 1_080,
                stride: 7_680,
                color_format: AeFrameColorFormat::Bgra8,
                alpha_mode: "premultiplied".to_string(),
                color_space: "sRGB".to_string(),
            },
        };
        let descriptor = AeFrameDescriptor {
            ring_generation: RING_GENERATION,
            slot_index: 3,
            frame_id: frame,
            data_revision: DATA_REVISION,
            composition_item_id: COMPOSITION_ITEM_ID,
            requested_time: time.clone(),
            evaluated_time: time,
            presentation_deadline_nanos: DEADLINE_NANOS,
            width: 1_920,
            height: 1_080,
            stride: 7_680,
            color_format: AeFrameColorFormat::Bgra8,
            alpha_mode: "premultiplied".to_string(),
            color_space: "sRGB".to_string(),
            status: AeFrameStatus::Ready,
        };
        (session, descriptor)
    }

    fn request_for(descriptor: &AeFrameDescriptor) -> AeFrameRequest {
        AeFrameRequest {
            frame: descriptor.frame_id,
            deadline_nanos: descriptor.presentation_deadline_nanos,
            composition_item_id: descriptor.composition_item_id,
            requested_time: descriptor.requested_time.clone(),
            data_revision: descriptor.data_revision,
        }
    }

    fn measured_bo0a_clock() -> AeCompositionClock {
        AeCompositionClock::from_decimal_strings("800", "23976")
            .expect("measured BO0a clock must be valid")
    }

    fn measured_bo0a_program_rate() -> FrameRate {
        FrameRate {
            numerator: 2_997,
            denominator: 100,
        }
    }

    fn assert_format_refusal(descriptor: AeFrameDescriptor) {
        let (session, _) = measured_bo0a_pair(descriptor.frame_id);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));
        assert_eq!(
            ledger
                .accept(&session, &descriptor, descriptor.frame_id, 0)
                .expect_err("mismatched negotiated tuple must be refused")
                .code(),
            "AE_REJECTED_FORMAT"
        );
    }

    #[test]
    fn non_local_sessions_are_refused_by_their_stable_code() {
        let (mut session, descriptor) = measured_bo0a_pair(1);
        session.origin = AeSessionOrigin::Remote;
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("remote session must be refused")
                .code(),
            "AE_SESSION_NOT_LOCAL"
        );
    }

    #[test]
    fn stale_ring_generations_are_refused_by_their_stable_code() {
        let (session, mut descriptor) = measured_bo0a_pair(1);
        descriptor.ring_generation += 1;
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("stale ring generation must be refused")
                .code(),
            "AE_STALE_RING_GENERATION"
        );
    }

    #[test]
    fn composition_mismatches_are_refused_by_their_stable_code() {
        let (session, mut descriptor) = measured_bo0a_pair(1);
        descriptor.composition_item_id += 1;
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("wrong composition must be refused")
                .code(),
            "AE_COMPOSITION_MISMATCH"
        );
    }

    #[test]
    fn unrequested_frames_are_refused_by_their_stable_code() {
        let (session, descriptor) = measured_bo0a_pair(1);
        let mut ledger = AeRequestLedger::new();

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("unrequested frame must be refused")
                .code(),
            "AE_FRAME_UNREQUESTED"
        );
    }

    #[test]
    fn duplicate_frames_are_refused_by_their_stable_code() {
        let (session, descriptor) = measured_bo0a_pair(1);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));
        ledger
            .accept(&session, &descriptor, 1, 0)
            .expect("first descriptor must be accepted");

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("second descriptor must be refused")
                .code(),
            "AE_FRAME_DUPLICATE"
        );
    }

    #[test]
    fn out_of_order_frames_are_refused_by_their_stable_code() {
        let (session, earlier) = measured_bo0a_pair(1);
        let (_, later) = measured_bo0a_pair(2);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&earlier)));
        assert!(ledger.issue(request_for(&later)));
        ledger
            .accept(&session, &later, 2, 0)
            .expect("later descriptor must be accepted first");

        assert_eq!(
            ledger
                .accept(&session, &earlier, 2, 0)
                .expect_err("older descriptor must be refused")
                .code(),
            "AE_FRAME_OUT_OF_ORDER"
        );
    }

    #[test]
    fn historical_frames_are_refused_by_their_stable_code() {
        let (session, descriptor) = measured_bo0a_pair(1);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 2, 0)
                .expect_err("a frame behind the due frame must be refused")
                .code(),
            "AE_FRAME_HISTORICAL"
        );
    }

    #[test]
    fn late_and_missed_frames_are_refused_by_their_stable_code() {
        for status in [AeFrameStatus::Late, AeFrameStatus::Missed] {
            let (session, mut descriptor) = measured_bo0a_pair(1);
            descriptor.status = status;
            let mut ledger = AeRequestLedger::new();
            assert!(ledger.issue(request_for(&descriptor)));

            assert_eq!(
                ledger
                    .accept(&session, &descriptor, 1, 0)
                    .expect_err("non-ready frame must be refused")
                    .code(),
                "AE_FRAME_NOT_READY"
            );
        }
    }

    #[test]
    fn time_mismatches_and_invalid_times_are_refused_without_panicking() {
        let (session, mut descriptor) = measured_bo0a_pair(1);
        descriptor.evaluated_time.value = "801".to_string();
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));
        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("different instant must be refused")
                .code(),
            "AE_TIME_MISMATCH"
        );

        for (frame, value, scale) in [(2, "not-a-number", "23976"), (3, "800", "0")] {
            let (session, mut descriptor) = measured_bo0a_pair(frame);
            descriptor.evaluated_time = AeExactTime {
                value: value.to_string(),
                scale: scale.to_string(),
            };
            let mut ledger = AeRequestLedger::new();
            assert!(ledger.issue(request_for(&descriptor)));
            assert_eq!(
                ledger
                    .accept(&session, &descriptor, frame, 0)
                    .expect_err("invalid exact time must be refused")
                    .code(),
                "AE_TIME_MISMATCH"
            );
        }
    }

    #[test]
    fn stale_revisions_are_refused_by_their_stable_code() {
        let (session, mut descriptor) = measured_bo0a_pair(1);
        descriptor.data_revision += 1;
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(AeFrameRequest {
            data_revision: DATA_REVISION,
            ..request_for(&descriptor)
        }));

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("stale revision must be refused")
                .code(),
            "AE_STALE_REVISION"
        );
    }

    #[test]
    fn width_mismatches_are_refused_by_their_stable_code() {
        let (_, mut descriptor) = measured_bo0a_pair(1);
        descriptor.width -= 1;
        assert_format_refusal(descriptor);
    }

    #[test]
    fn height_mismatches_are_refused_by_their_stable_code() {
        let (_, mut descriptor) = measured_bo0a_pair(1);
        descriptor.height -= 1;
        assert_format_refusal(descriptor);
    }

    #[test]
    fn stride_mismatches_are_refused_by_their_stable_code() {
        let (_, mut descriptor) = measured_bo0a_pair(1);
        descriptor.stride += 4;
        assert_format_refusal(descriptor);
    }

    #[test]
    fn colour_format_mismatches_are_refused_by_their_stable_code() {
        let (_, mut descriptor) = measured_bo0a_pair(1);
        descriptor.color_format = AeFrameColorFormat::Rgba8;
        assert_format_refusal(descriptor);
    }

    #[test]
    fn alpha_mode_mismatches_are_refused_by_their_stable_code() {
        let (_, mut descriptor) = measured_bo0a_pair(1);
        descriptor.alpha_mode = "straight".to_string();
        assert_format_refusal(descriptor);
    }

    #[test]
    fn colour_space_mismatches_are_refused_by_their_stable_code() {
        let (_, mut descriptor) = measured_bo0a_pair(1);
        descriptor.color_space = "Rec.709".to_string();
        assert_format_refusal(descriptor);
    }

    #[test]
    fn strides_that_cannot_hold_a_row_are_refused_by_their_stable_code() {
        let (mut session, mut descriptor) = measured_bo0a_pair(1);
        session.format.stride = 7_679;
        descriptor.stride = 7_679;
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("a stride below width times four must be refused")
                .code(),
            "AE_IMPOSSIBLE_GEOMETRY"
        );
    }

    #[test]
    fn valid_descriptors_report_their_slot_frame_revision_and_deadline_result() {
        let (session, descriptor) = measured_bo0a_pair(1);
        let mut before_deadline = AeRequestLedger::new();
        assert!(before_deadline.issue(request_for(&descriptor)));
        assert_eq!(
            before_deadline
                .accept(&session, &descriptor, 1, DEADLINE_NANOS)
                .expect("descriptor at deadline must be accepted"),
            super::AeAcceptedFrame {
                frame: 1,
                slot_index: 3,
                data_revision: DATA_REVISION,
                presented_before_deadline: true,
            }
        );

        let (_, later_descriptor) = measured_bo0a_pair(2);
        let mut after_deadline = AeRequestLedger::new();
        assert!(after_deadline.issue(request_for(&later_descriptor)));
        assert!(!after_deadline
            .accept(&session, &later_descriptor, 2, DEADLINE_NANOS + 1)
            .expect("descriptor after deadline must still be accepted")
            .presented_before_deadline);
    }

    #[test]
    fn locality_is_checked_before_untrusted_descriptor_fields() {
        let (mut session, mut descriptor) = measured_bo0a_pair(1);
        session.origin = AeSessionOrigin::Remote;
        descriptor.ring_generation += 1;
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));

        assert_eq!(
            ledger
                .accept(&session, &descriptor, 1, 0)
                .expect_err("remote session must be refused before ring generation")
                .code(),
            "AE_SESSION_NOT_LOCAL"
        );
    }

    #[test]
    fn exactly_one_request_is_recorded_for_each_frame() {
        let (_, descriptor) = measured_bo0a_pair(1);
        let request = request_for(&descriptor);
        let mut ledger = AeRequestLedger::new();

        assert!(ledger.issue(request.clone()));
        assert!(!ledger.issue(request));
        assert_eq!(ledger.in_flight_len(), 1);
        assert_eq!(ledger.counters().requested, 1);
    }

    #[test]
    fn frames_at_or_below_the_last_presented_frame_cannot_be_requested_again() {
        let (session, descriptor) = measured_bo0a_pair(2);
        let request = request_for(&descriptor);
        let (_, earlier_descriptor) = measured_bo0a_pair(1);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request.clone()));
        ledger
            .accept(&session, &descriptor, 2, 0)
            .expect("valid descriptor must be accepted");

        assert_eq!(ledger.last_presented(), Some(2));
        assert!(!ledger.issue(request));
        assert!(!ledger.issue(request_for(&earlier_descriptor)));
    }

    #[test]
    fn exact_times_are_compared_by_cross_multiplied_value_not_string_form() {
        let (session, mut descriptor) = measured_bo0a_pair(1);
        descriptor.evaluated_time = AeExactTime {
            value: "100".to_string(),
            scale: "2997".to_string(),
        };
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&descriptor)));
        ledger
            .accept(&session, &descriptor, 1, 0)
            .expect("equal rational instant in different terms must be accepted");

        let (session, mut different_descriptor) = measured_bo0a_pair(1);
        different_descriptor.evaluated_time.value = "801".to_string();
        let mut different_ledger = AeRequestLedger::new();
        assert!(different_ledger.issue(request_for(&different_descriptor)));
        assert_eq!(
            different_ledger
                .accept(&session, &different_descriptor, 1, 0)
                .expect_err("different rational instant must be refused")
                .code(),
            "AE_TIME_MISMATCH"
        );
    }

    #[test]
    fn counter_accounting_reports_each_scripted_outcome_exactly_once() {
        let (session, accepted) = measured_bo0a_pair(1);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&accepted)));
        ledger
            .accept(&session, &accepted, 1, 0)
            .expect("first descriptor must be accepted");

        let (_, mut stale_revision) = measured_bo0a_pair(2);
        stale_revision.data_revision += 1;
        assert!(ledger.issue(AeFrameRequest {
            data_revision: DATA_REVISION,
            ..request_for(&stale_revision)
        }));
        assert!(matches!(
            ledger.accept(&session, &stale_revision, 2, 0),
            Err(AeIngressRefusal::StaleRevision { .. })
        ));

        let (_, mut bad_format) = measured_bo0a_pair(3);
        bad_format.width -= 1;
        assert!(ledger.issue(request_for(&bad_format)));
        assert!(matches!(
            ledger.accept(&session, &bad_format, 3, 0),
            Err(AeIngressRefusal::FormatMismatch { .. })
        ));

        // A frame that was never abandoned but is already behind `due`: refused as historical, and
        // counted under `refused_other` rather than `missed`, because no abandonment counted it.
        let (_, historical) = measured_bo0a_pair(4);
        assert!(ledger.issue(request_for(&historical)));
        assert!(matches!(
            ledger.accept(&session, &historical, 5, 0),
            Err(AeIngressRefusal::Historical { .. })
        ));

        let (_, abandoned) = measured_bo0a_pair(5);
        assert!(ledger.issue(request_for(&abandoned)));
        assert_eq!(ledger.abandon_before(6), vec![5]);

        assert_eq!(
            ledger.counters(),
            AeIngressCounters {
                requested: 5,
                ready_before_deadline: 1,
                late: 0,
                // One only: the abandoned frame 5. The historical frame 4 is *not* a miss, because
                // nothing abandoned it — see the double-count guard below for the case that is.
                missed: 1,
                ring_backpressured: 0,
                stale_revision: 1,
                rejected_format: 1,
                refused_other: 1,
                // `AE-F2b`'s policy counters: this ledger was driven directly, so nothing saturated
                // the in-flight set, superseded a revision, or moved the lead depth.
                in_flight_saturated: 0,
                revision_superseded: 0,
                lead_depth_reduced: 0,
                lead_depth_restored: 0,
            }
        );
    }

    /// A frame abandoned by the clock and then delivered late must count as **one** miss, not two.
    ///
    /// `abandon_before` owns the miss. If the late arrival counted again, the totals would claim more
    /// dropped frames than the clock actually dropped, and every downstream figure built on them —
    /// `CB4`'s classification, `PL4`'s policy — would inherit the inflation.
    #[test]
    fn a_frame_abandoned_then_delivered_late_is_counted_missed_exactly_once() {
        let (session, late_arrival) = measured_bo0a_pair(7);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&late_arrival)));

        assert_eq!(ledger.abandon_before(8), vec![7]);
        assert_eq!(ledger.counters().missed, 1, "abandonment counts the miss");
        assert_eq!(ledger.in_flight_len(), 0);

        // The render turns up anyway. It is refused as historical — the honest diagnosis, because it
        // *was* requested — and the miss total does not move.
        let refusal = ledger
            .accept(&session, &late_arrival, 8, 0)
            .expect_err("a frame below due cannot be presented");
        assert_eq!(refusal.code(), "AE_FRAME_HISTORICAL");
        assert_eq!(ledger.counters().missed, 1, "the late arrival must not count a second miss");
    }

    #[test]
    fn abandoning_requests_before_due_counts_misses_and_keeps_current_requests() {
        let (_, first) = measured_bo0a_pair(1);
        let (_, second) = measured_bo0a_pair(2);
        let (_, third) = measured_bo0a_pair(3);
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(request_for(&first)));
        assert!(ledger.issue(request_for(&second)));
        assert!(ledger.issue(request_for(&third)));

        assert_eq!(ledger.abandon_before(3), vec![1, 2]);
        assert_eq!(ledger.in_flight_len(), 1);
        assert_eq!(ledger.abandon_before(3), Vec::<u64>::new());
        assert_eq!(ledger.counters().missed, 2);
    }

    #[test]
    fn refused_descriptors_free_their_request_for_later_frames() {
        let (session, mut descriptor) = measured_bo0a_pair(1);
        descriptor.data_revision += 1;
        let mut ledger = AeRequestLedger::new();
        assert!(ledger.issue(AeFrameRequest {
            data_revision: DATA_REVISION,
            ..request_for(&descriptor)
        }));
        assert!(ledger.accept(&session, &descriptor, 1, 0).is_err());
        assert_eq!(ledger.in_flight_len(), 0);

        let (_, higher_descriptor) = measured_bo0a_pair(2);
        assert!(ledger.issue(request_for(&higher_descriptor)));
    }

    #[test]
    fn program_source_refuses_remote_sessions_and_unreconcilable_program_rates() {
        let (mut remote_session, _) = measured_bo0a_pair(1);
        remote_session.origin = AeSessionOrigin::Remote;
        let remote_refusal = match AeProgramSource::new(
            remote_session,
            measured_bo0a_clock(),
            measured_bo0a_program_rate(),
            DATA_REVISION,
        ) {
            Err(refusal) => refusal,
            Ok(_) => panic!("remote source must be refused"),
        };
        assert_eq!(remote_refusal.code(), "AE_SESSION_NOT_LOCAL");

        let (session, _) = measured_bo0a_pair(1);
        let declared_ntsc_rate = FrameRate {
            numerator: 30_000,
            denominator: 1_001,
        };
        match AeProgramSource::new(
            session,
            measured_bo0a_clock(),
            declared_ntsc_rate,
            DATA_REVISION,
        ) {
            Err(AeIngressRefusal::FormatMismatch { detail }) => {
                assert!(detail.contains("30000/1001"));
            }
            Err(refusal) => panic!("expected format mismatch, got {}", refusal.code()),
            Ok(_) => panic!("measured BO0a clock cannot carry declared NTSC rate"),
        }
    }

    #[test]
    fn program_source_requests_use_the_composition_clock_time_scale() {
        let (session, _) = measured_bo0a_pair(1);
        let source = AeProgramSource::new(
            session,
            measured_bo0a_clock(),
            measured_bo0a_program_rate(),
            DATA_REVISION,
        )
        .expect("measured BO0a source must install");

        for (frame, value) in [(0, "0"), (1, "800"), (6, "4800")] {
            assert_eq!(
                source
                    .request_for(frame, DEADLINE_NANOS)
                    .expect("composition frame must be representable")
                    .requested_time,
                AeExactTime {
                    value: value.to_string(),
                    scale: "23976".to_string(),
                }
            );
        }
    }
}