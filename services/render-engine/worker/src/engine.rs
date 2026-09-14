//! The render engine peer: control-plane surface over a live clock.
//!
//! This is the real engine the conformance suite points at instead of the
//! mock. It shares the intent-resolution rule with the mock by calling
//! `gx_control_plane::intent::resolve_intent` (invariant 27) — there is one
//! implementation of ADR-002's rule, and both peers use it.
//!
//! What makes it *real* rather than a mock:
//! - the device tier is negotiated from actual hardware (`gpu`), not set by a
//!   test;
//! - the clock is a `ProgramClock` driven by an external tick, so time passes
//!   whether or not a request arrives — a take resolves against a clock the
//!   engine owns (ADR-002), never against the client's;
//! - a committed take drives a rasteriser, so Program is a real frame the
//!   engine produces, not a state field that pretends to be one.
//!
//! The engine deliberately does not implement `FaultInjection`: nothing can
//! make real hardware lose genlock on request, which is exactly why that
//! trait is separate and why the fault suite reports SKIP against this peer.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use gx_asset_plane::{AssetPublishPeer, PublishRefusal, PublishReply};
use gx_contracts::material::MaterialSupport;
use gx_contracts::scene::SceneDocument;
use gx_contracts::color::OutputTransform;
use gx_contracts::{
    ContentHash, DeviceTier, Epoch, Locality, MediaCodec, RationalRate, Refusal, Revision, TakeId,
};
use gx_control_plane::capability::{check_protocol, live_allowed, EngineCapability};
use gx_control_plane::intent::{Lead, PhaseCommitted, TakeAt, TakeCommitted};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, OutputConfig};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::status::{Degradation, EngineStatus, ProgramState};

use crate::clock::ProgramClock;
use crate::emission::{FrameEmitter, ProgramEmission};
use crate::gpu::{self, Gpu};
use crate::mesh::AssetBytes;
use crate::metrics::{EnginePerformance, FrameMetrics, FrameSample};
use crate::output_adapter::{OutputAdapterError, OutputAdapterRegistry};
use crate::recovery::{PreparedSceneRecord, RecoveryError, RecoveryJournal, RecoveryState};
use crate::prepared::PreparedScene;
use crate::rasterizer::{
    key_for_take, Frame, SoftwareRasterizer, FRAME_HEIGHT, FRAME_WIDTH,
};

/// The render engine. Owns the GPU, the clock and Program.
pub struct Engine {
    gpu: Gpu,
    clock: ProgramClock,
    /// Drives the clock. Shared with the host's frame pump, which ticks it;
    /// the engine reads it under the same mutex the requests serialise on.
    ///
    /// An `Arc<AtomicU64>` rather than a method call, because the pump runs on
    /// its own thread and must not take the engine lock to advance time — a
    /// take request waiting on the clock must never deadlock the pump that
    /// makes the clock advance.
    frame_source: Arc<AtomicU64>,
    locality: Locality,
    platform_certified: bool,
    /// What has been published, and at which revision.
    published: HashMap<TakeId, Revision>,
    /// The prepared scene each published revision pins (3.4). Keyed by the
    /// pinned identity, so an earlier revision keeps exactly the scene it was
    /// published with (invariant 30).
    prepared: HashMap<(TakeId, Revision), PreparedScene>,
    /// Content hashes the asset plane has verified into the store.
    assets: HashSet<ContentHash>,
    /// Verified asset bytes bound by content hash. Mesh and font preparation
    /// receive these only after the asset plane has completed verification.
    asset_bytes: AssetBytes,
    program: Option<ProgramState>,
    cued: Option<ProgramState>,
    rasterizer: SoftwareRasterizer,
    preview_rasterizer: SoftwareRasterizer,
    emitter: FrameEmitter,
    metrics: FrameMetrics,
    outputs: OutputAdapterRegistry,
    selected_output: String,
    recovery: Option<RecoveryJournal>,
    output_inhibited: bool,
    events: Vec<EngineEvent>,
}

impl Engine {
    /// Build an engine: negotiate the device, start the clock free-running.
    ///
    /// Free-running is the honest default for a machine with no reference
    /// input (invariant 11). A genlocked adapter, when one exists, slaves the
    /// clock through `ProgramClock::slave_to`; until then the engine says it
    /// is free-running rather than implying accuracy it does not have.
    pub fn new(frame_source: Arc<AtomicU64>, locality: Locality) -> Self {
        let gpu = gpu::negotiate();
        let texture_limit = gpu
            .max_texture_dimension_2d()
            .unwrap_or(FRAME_WIDTH.max(FRAME_HEIGHT));
        let rasterizer = SoftwareRasterizer::with_texture_limit(texture_limit)
            .expect("a negotiated device limit must yield a valid tile plan");
        let preview_rasterizer = SoftwareRasterizer::with_texture_limit(texture_limit)
            .expect("the Program and Preview tile plans share one valid limit");
        let rate = RationalRate::P50;
        let lead = Lead::for_locality(locality);
        Self {
            gpu,
            clock: ProgramClock::free_running(Epoch(1), rate, lead),
            frame_source,
            locality,
            platform_certified: true,
            published: HashMap::new(),
            prepared: HashMap::new(),
            assets: HashSet::new(),
            asset_bytes: HashMap::new(),
            program: None,
            cued: None,
            rasterizer,
            preview_rasterizer,
            emitter: FrameEmitter::new(),
            metrics: FrameMetrics::with_window(rate, 60),
            outputs: OutputAdapterRegistry::standard(
                std::env::temp_dir().join("grapix-render-output"),
            ),
            selected_output: "null".into(),
            recovery: None,
            output_inhibited: false,
            events: Vec::new(),
        }
    }

    /// The negotiated device tier. Read by the host to report health.
    pub fn device_tier(&self) -> DeviceTier {
        self.gpu.tier()
    }

    /// Attach the host-owned journal and restore its last complete state.
    ///
    /// A recovered Program is rebuilt but remains output-inhibited until a
    /// fresh `ConfigureOutput` request explicitly re-arms a destination.
    pub fn attach_recovery_journal(
        &mut self,
        journal: RecoveryJournal,
    ) -> Result<(), RecoveryError> {
        if let Some(state) = journal.load()? {
            self.restore_state(state)?;
            self.output_inhibited = true;
            self.rasterizer.clear();
            self.preview_rasterizer.clear();
        }
        self.recovery = Some(journal);
        self.persist_recovery()
    }

    /// Whether a recovered engine is still prevented from emitting old state.
    pub fn output_inhibited(&self) -> bool {
        self.output_inhibited
    }

    /// A deterministic point-in-time recovery snapshot.
    pub fn recovery_state(&self) -> RecoveryState {
        let mut prepared_scenes: Vec<_> = self
            .prepared
            .iter()
            .filter(|((take_id, revision), _)| self.published.get(take_id) == Some(revision))
            .map(|((take_id, revision), prepared)| PreparedSceneRecord {
                take_id: take_id.clone(),
                revision: *revision,
                document: prepared.document().clone(),
            })
            .collect();
        prepared_scenes.sort_by(|left, right| {
            (&left.take_id, left.revision).cmp(&(&right.take_id, right.revision))
        });
        RecoveryState {
            schema_version: crate::recovery::RECOVERY_SCHEMA_VERSION,
            epoch: self.clock.epoch(),
            published: self
                .published
                .iter()
                .map(|(take_id, revision)| (take_id.clone(), *revision))
                .collect(),
            prepared_scenes,
            verified_assets: self.assets.iter().cloned().collect(),
            cued: self.cued.clone(),
            program: self.program.clone(),
        }
    }

    fn persist_recovery(&self) -> Result<(), RecoveryError> {
        match &self.recovery {
            Some(journal) => journal.record(&self.recovery_state()),
            None => Ok(()),
        }
    }

    fn restore_state(&mut self, state: RecoveryState) -> Result<(), RecoveryError> {
        state.validate()?;
        let next_epoch = state.next_epoch()?;
        let assets: HashSet<_> = state.verified_assets.iter().cloned().collect();
        let mut prepared = HashMap::new();
        let support = self.material_support();
        for record in state.prepared_scenes {
            let scene = PreparedScene::prepare(
                record.document,
                &assets,
                &self.asset_bytes,
                &support,
            )
            .map_err(|refusal| RecoveryError::InvalidState {
                detail: format!(
                    "prepared scene {}/{} cannot be rebuilt: {refusal}",
                    record.take_id, record.revision.0
                ),
            })?;
            prepared.insert((record.take_id, record.revision), scene);
        }
        self.clock = ProgramClock::free_running(
            next_epoch,
            self.clock.timebase(),
            Lead::for_locality(self.locality),
        );
        self.published = state.published.into_iter().collect();
        self.prepared = prepared;
        self.assets = assets;
        self.cued = state.cued;
        self.program = state.program;
        Ok(())
    }
    fn activate_program_base(&mut self) {
        let Some(program) = self.program.clone() else {
            self.rasterizer.clear();
            self.preview_rasterizer.clear();
            return;
        };
        let take_key = key_for_take(&program.take_id);
        if let Some(prepared) = self
            .prepared
            .get(&(program.take_id.clone(), program.revision))
        {
            self.rasterizer
                .take_prepared(take_key, prepared.frame(OutputTransform::Rec709))
                .expect("a recovered non-zero canvas must yield a tile plan");
            self.preview_rasterizer
                .take_prepared(take_key, prepared.frame(OutputTransform::Srgb))
                .expect("Preview shares Program's validated tile plan");
        } else {
            self.rasterizer.take(take_key);
            self.preview_rasterizer.take(take_key);
        }
    }
    /// Rebuild Program/Preview bases for the current authored animation frame.
    ///
    /// The scene frame is relative to the engine's committed take frame, never
    /// to wall time. This keeps reconnects and frame-pump catch-up deterministic.
    fn evaluate_program_frame(&mut self, engine_frame: u64) {
        let Some(program) = self.program.as_ref() else {
            return;
        };
        let Some(prepared) = self
            .prepared
            .get(&(program.take_id.clone(), program.revision))
        else {
            return;
        };
        if !prepared.has_animation() {
            return;
        }
        let elapsed = engine_frame.saturating_sub(program.committed_frame);
        let current_phase = program
            .phase
            .as_deref()
            .and_then(|address| prepared.phase(address));
        let mut scene_frame = match current_phase {
            Some(phase)
                if program.playing
                    && phase.kind == gx_contracts::phases::PhaseKind::Hold =>
            {
                let length = phase.end_frame - phase.start_frame;
                phase.start_frame + (elapsed % length)
            }
            _ if program.playing => program.scene_frame.saturating_add(elapsed),
            _ => program.scene_frame,
        };
        if let Some(stop) = program.stop_frame {
            if current_phase.map(|phase| phase.kind)
                != Some(gx_contracts::phases::PhaseKind::Hold)
            {
                scene_frame = scene_frame.min(stop);
            }
        }
        scene_frame = scene_frame.min(prepared.document().timeline.duration_frames);
        let program_frame = prepared
            .frame_at(scene_frame, OutputTransform::Rec709)
            .expect("published animation remains valid at every evaluated frame");
        let preview_frame = prepared
            .frame_at(scene_frame, OutputTransform::Srgb)
            .expect("Preview shares Program's validated animation");
        let take_key = key_for_take(&program.take_id);
        self.rasterizer
            .take_prepared(take_key, program_frame)
            .expect("an animated non-zero canvas must retain its tile plan");
        self.preview_rasterizer
            .take_prepared(take_key, preview_frame)
            .expect("Preview shares Program's animated tile plan");
    }


    /// Publish a scene identifier so a take of it can succeed, with no
    /// content.
    ///
    /// The identifier-only path exists for the worker's own binary and the
    /// conformance suite: a take names a revision and the engine answers
    /// whether it has one, and Program is the software rasteriser's take key.
    /// It is not the authoring path — a scene reaches the engine through
    /// [`Engine::publish`], and an identifier published this way has no
    /// `PreparedScene` behind it.
    pub fn publish_identifier(&mut self, take_id: TakeId, revision: Revision) {
        self.published.insert(take_id, revision);
    }

    /// Prepare and publish one complete authored scene as a new pinned revision.
    ///
    /// The asset-plane listener is solely responsible for accepting raw bytes
    /// and strictly parsing the closed scene schema. This method deliberately
    /// accepts the resulting `SceneDocument`, so there is no identifier-only
    /// path that could put a take key on Program without scene content.
    ///
    /// Preparation happens once here rather than during rendering (invariant
    /// 35). Publication is additive: an earlier `(TakeId, Revision)` remains
    /// immutable in `prepared` when the same take id is published again.
    pub fn publish(&mut self, document: SceneDocument) -> PublishReply {
        let take_id = TakeId(document.id.clone());
        let revision = self
            .published
            .get(&take_id)
            .copied()
            .map(Revision::next)
            .unwrap_or(Revision(1));
        let prepared = match PreparedScene::prepare(
            document,
            &self.assets,
            &self.asset_bytes,
            &self.material_support(),
        ) {
            Ok(prepared) => prepared,
            Err(cause) => {
                return PublishReply::Refused(PublishRefusal::PreparationRefused { cause });
            }
        };
        self.prepared.insert((take_id.clone(), revision), prepared);
        self.published.insert(take_id.clone(), revision);
        if let Err(error) = self.persist_recovery() {
            self.output_inhibited = true;
            return PublishReply::Refused(PublishRefusal::PreparationRefused {
                cause: Refusal::TransportFailed {
                    detail: format!("recovery journal write failed: {error}"),
                },
            });
        }
        PublishReply::Published { take_id, revision }
    }

    /// The prepared scene a published revision pins, if this engine holds it.
    pub fn prepared_scene(&self, take_id: &TakeId, revision: Revision) -> Option<&PreparedScene> {
        self.prepared.get(&(take_id.clone(), revision))
    }

    /// Record that the asset plane has verified these bytes into the store.
    ///
    /// Verification is the asset plane's job (invariant 28); the engine only
    /// learns the result, and a scene declaring bytes not recorded here
    /// refuses to prepare (invariant 29).
    pub fn record_verified_asset(&mut self, hash: ContentHash) {
        self.assets.insert(hash);
    }

    /// Record a verified asset and retain its immutable bytes for per-publish
    /// font and mesh preparation. The asset plane verifies the content hash
    /// before this receipt; the engine never reads a mutable source path.
    pub fn record_verified_asset_bytes(&mut self, hash: ContentHash, bytes: Vec<u8>) {
        self.assets.insert(hash.clone());
        self.asset_bytes.insert(hash, bytes);
    }

    /// What the current fixed-function path can reproduce exactly. The
    /// capability and publish validator share this one declaration, so an
    /// unsupported material is refused rather than approximated.
    fn material_support(&self) -> MaterialSupport {
        MaterialSupport::fixed_function()
    }

    /// Render and emit one Preview/Program pair at the engine's current frame.
    ///
    /// Both bases were built at publish/take time. Per frame this measures the
    /// raster copy, emits into bounded latest-frame slots, records the sample,
    /// and delivers Program to the configured adapter without ever waiting for
    /// a consumer.
    pub fn emit_frame(&mut self) -> Result<ProgramEmission, OutputAdapterError> {
        self.sync_clock();
        let frame_number = self.clock.frame();
        self.evaluate_program_frame(frame_number);
        let started = Instant::now();
        let program = Arc::new(self.rasterizer.render(frame_number));
        let preview = Arc::new(self.preview_rasterizer.render(frame_number));
        let render_nanos = started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
        self.emitter
            .emit(Arc::clone(&preview), Arc::clone(&program));
        let interval_nanos = self
            .clock
            .offset_nanos(1)
            .min(u128::from(u64::MAX)) as u64;
        let sample = FrameSample {
            frame: frame_number,
            render_nanos,
            interval_nanos,
            late: render_nanos > interval_nanos,
            drops_so_far: self.emitter.total_drops(),
        };
        self.metrics.record(sample);
        if !self.output_inhibited {
            self.outputs
                .emit(&self.selected_output, frame_number, Arc::clone(&program))?;
        }
        Ok(ProgramEmission {
            frame: program,
            sample,
        })
    }

    /// Render Program for synchronous callers and tests.
    pub fn render_program(&mut self) -> Frame {
        self.emit_frame()
            .expect("the configured output adapter must accept Program")
            .frame
            .as_ref()
            .clone()
    }

    /// The freshest sRGB Preview frame, if its consumer has not taken it.
    pub fn take_preview(&mut self) -> Option<Arc<Frame>> {
        self.emitter.take_preview()
    }

    /// The freshest Rec.709 Program frame, if its consumer has not taken it.
    pub fn take_program(&mut self) -> Option<Arc<Frame>> {
        self.emitter.take_program()
    }

    /// Cause-specific drops observed by the Preview consumer slot.
    pub fn preview_drops(&self) -> gx_media_plane::DropCounters {
        self.emitter.preview_drops()
    }

    /// Cause-specific drops observed by the Program consumer slot.
    pub fn program_drops(&self) -> gx_media_plane::DropCounters {
        self.emitter.program_drops()
    }

    /// Bounded, point-in-time performance data for the graph page.
    pub fn performance(&self) -> EnginePerformance {
        EnginePerformance {
            rate: self.clock.timebase(),
            device_tier: self.gpu.tier(),
            frames: self.metrics.samples().to_vec(),
            total_rendered: self.metrics.total_rendered(),
            total_late: self.metrics.total_late(),
            total_dropped: self.metrics.total_dropped(),
            mean_budget_ratio: self.metrics.mean_budget_ratio(),
        }
    }

    /// The performance snapshot in the control-plane's own type, so the
    /// wire format does not depend on the worker crate.
    fn performance_summary(&self) -> gx_control_plane::status::PerformanceSummary {
        let perf = self.performance();
        gx_control_plane::status::PerformanceSummary {
            rate: perf.rate,
            device_tier: perf.device_tier,
            frames: perf
                .frames
                .iter()
                .map(|f| gx_control_plane::status::FrameSampleSummary {
                    frame: f.frame,
                    render_nanos: f.render_nanos,
                    interval_nanos: f.interval_nanos,
                    late: f.late,
                    drops_so_far: f.drops_so_far,
                })
                .collect(),
            total_rendered: perf.total_rendered,
            total_late: perf.total_late,
            total_dropped: perf.total_dropped,
            mean_budget_ratio: perf.mean_budget_ratio,
        }
    }

    /// Pull the clock forward to the frame the pump has reached.
    ///
    /// The pump owns the passage of time; the engine observes it. This keeps
    /// ADR-002's rule that no client message can set the clock — the only
    /// writer is the pump, and it is not reachable from the control plane.
    fn sync_clock(&mut self) {
        let target = self.frame_source.load(Ordering::Relaxed);
        let current = self.clock.frame();
        if current < target {
            // Advance in one step rather than per-frame ticking: the pump
            // may have run far ahead while the engine was doing something
            // else, and a per-tick loop would hold the engine lock for an
            // unbounded time.
            self.clock.advance_to(target);
        }
    }

    fn degradations(&self) -> Vec<Degradation> {
        let mut out = Vec::new();
        if let Some(d) = self.clock.degradation() {
            out.push(d);
        }
        if !self.gpu.tier().live_capable() {
            out.push(Degradation::DeviceBelowT0 {
                actual: self.gpu.tier(),
            });
        }
        out
    }

    fn live_is_allowed(&self, accept_free_run: bool) -> bool {
        live_allowed(
            self.gpu.tier(),
            self.clock.reference(),
            self.platform_certified,
            accept_free_run,
        )
        .is_ok()
    }

    /// Resolve intent against the live clock.
    fn commit(&mut self, at: TakeAt) -> Result<TakeCommitted, Refusal> {
        self.sync_clock();
        self.clock.commit(at)
    }

    /// Check a scene reference against what is published.
    ///
    /// Two distinct refusals, because an operator needs to tell "wrong
    /// version" from "no such scene".
    fn check_published(&self, take_id: &TakeId, revision: Revision) -> Result<(), Refusal> {
        match self.published.get(take_id) {
            None => Err(Refusal::UnknownTake {
                take_id: take_id.clone(),
            }),
            Some(&published) if published != revision => Err(Refusal::RevisionMismatch {
                expected: published,
                actual: revision,
            }),
            Some(_) => Ok(()),
        }
    }

    fn configure_output(&mut self, config: &OutputConfig) -> EngineReply {
        if let Err(refusal) = self.outputs.ensure_known(&config.adapter) {
            return EngineReply::Refused(refusal);
        }
        if config.live {
            if let Err(refusal) = live_allowed(
                self.gpu.tier(),
                self.clock.reference(),
                self.platform_certified,
                config.accept_free_run,
            ) {
                return EngineReply::Refused(refusal);
            }
            // ADR-002: refuse new live configuration while degraded by a lost
            // reference, even if the conditions above pass.
            if self
                .clock
                .degradation()
                .map(|d| d.blocks_live_configuration())
                .unwrap_or(false)
            {
                return EngineReply::Refused(Refusal::ReferenceUnlocked {
                    state: self.clock.reference(),
                });
            }
        }
        self.selected_output.clone_from(&config.adapter);
        if self.output_inhibited {
            self.activate_program_base();
            self.output_inhibited = false;
        }
        EngineReply::OutputConfigured {
            adapter: config.adapter.clone(),
            live: config.live,
        }
    }
}

impl AssetPublishPeer for Engine {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
        self.publish(scene)
    }
}
impl EnginePeer for Engine {
    fn capability(&self) -> EngineCapability {

        EngineCapability {
            protocol: gx_contracts::PROTOCOL_VERSION,
            epoch: self.clock.epoch(),
            locality: self.locality,
            device_tier: self.gpu.tier(),
            clock: self.clock.source(),
            reference: self.clock.reference(),
            live_allowed: !self.output_inhibited && self.live_is_allowed(false),
            media: match self.locality {
                Locality::CoLocated => vec![MediaCodec::RawShared, MediaCodec::Jpeg],
                Locality::Lan => vec![MediaCodec::H264, MediaCodec::Jpeg],
            },
            material: self.material_support(),
        }
    }

    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        let persists = matches!(
            &request,
            ClientRequest::Cue(_)
                | ClientRequest::Take(_)
                | ClientRequest::Clear(_)
                | ClientRequest::Phase(_)
        );
        let reply = match request {
            // Authentication is a transport concern; reaching here means the
            // transport failed to intercept, so refuse rather than approve.
            ClientRequest::Authenticate { .. } => EngineReply::Refused(Refusal::NotImplemented {
                what: "authentication is a transport concern, not an engine one".to_string(),
            }),

            ClientRequest::Capability => match check_protocol(gx_contracts::PROTOCOL_VERSION) {
                Ok(()) => EngineReply::Capability(self.capability()),
                Err(refusal) => EngineReply::Refused(refusal),
            },

            ClientRequest::Status => {
                self.sync_clock();
                EngineReply::Status(EngineStatus {
                    epoch: self.clock.epoch(),
                    current_frame: self.clock.frame(),
                    timebase: self.clock.timebase(),
                    clock: self.clock.source(),
                    reference: self.clock.reference(),
                    device_tier: self.gpu.tier(),
                    live_allowed: !self.output_inhibited && self.live_is_allowed(false),
                    program: self.program.clone(),
                    degradations: self.degradations(),
                })
            }

            ClientRequest::Cue(req) => {
                if let Err(refusal) = self.check_published(&req.take_id, req.revision) {
                    return EngineReply::Refused(refusal);
                }
                match self.commit(req.at) {
                    Ok(committed) => {
                        self.cued = Some(ProgramState {
                            take_id: req.take_id,
                            revision: req.revision,
                            committed_frame: committed.frame,
                            scene_frame: 0,
                            playing: true,
                            phase: None,
                            stop_frame: None,
                        });
                        EngineReply::Cued(committed)
                    }
                    Err(refusal) => EngineReply::Refused(refusal),
                }
            }

            ClientRequest::Take(req) => {
                if let Err(refusal) = self.check_published(&req.take_id, req.revision) {
                    return EngineReply::Refused(refusal);
                }
                let in_phase = self
                    .prepared
                    .get(&(req.take_id.clone(), req.revision))
                    .and_then(|prepared| {
                        prepared
                            .phases_of(gx_contracts::phases::PhaseKind::In)
                            .next()
                    })
                    .cloned();
                match self.commit(req.at) {
                    Ok(committed) => {
                        self.program = Some(ProgramState {
                            take_id: req.take_id.clone(),
                            revision: req.revision,
                            committed_frame: committed.frame,
                            scene_frame: in_phase
                                .as_ref()
                                .map(|phase| phase.start_frame)
                                .unwrap_or(0),
                            playing: true,
                            phase: in_phase.as_ref().map(|phase| phase.address()),
                            stop_frame: in_phase
                                .as_ref()
                                .map(|phase| phase.end_frame.saturating_sub(1)),
                        });
                        self.cued = None;
                        if !self.output_inhibited {
                            self.activate_program_base();
                        }
                        self.events.push(EngineEvent::Committed(committed));
                        EngineReply::Taken(committed)
                    }
                    Err(refusal) => EngineReply::Refused(refusal),
                }
            }

            ClientRequest::Clear(req) => match self.commit(req.at) {
                Ok(committed) => {
                    self.program = None;
                    self.rasterizer.clear();
                    self.preview_rasterizer.clear();
                    EngineReply::Cleared(committed)
                }
                Err(refusal) => EngineReply::Refused(refusal),
            },

            ClientRequest::Phase(req) => {
                let Some(program) = self.program.clone() else {
                    return EngineReply::Refused(Refusal::TimelinePhaseUnknown {
                        phase: req.phase,
                    });
                };
                let phase = self
                    .prepared
                    .get(&(program.take_id.clone(), program.revision))
                    .and_then(|prepared| prepared.phase(&req.phase))
                    .cloned();
                let Some(phase) = phase else {
                    return EngineReply::Refused(Refusal::TimelinePhaseUnknown {
                        phase: req.phase,
                    });
                };
                match self.commit(req.at) {
                    Ok(committed) => {
                        let playing = true;
                        self.program = Some(ProgramState {
                            take_id: program.take_id,
                            revision: program.revision,
                            committed_frame: committed.frame,
                            scene_frame: phase.start_frame,
                            playing,
                            phase: Some(phase.address()),
                            stop_frame: Some(phase.end_frame.saturating_sub(1)),
                        });
                        if !self.output_inhibited {
                            self.activate_program_base();
                        }
                        self.events.push(EngineEvent::Committed(committed));
                        EngineReply::PhaseCommitted(PhaseCommitted {
                            phase: phase.address(),
                            scene_frame: phase.start_frame,
                            playing,
                            committed,
                        })
                    }
                    Err(refusal) => EngineReply::Refused(refusal),
                }
            }

            ClientRequest::ConfigureOutput(config) => self.configure_output(&config),
            ClientRequest::Performance => EngineReply::Performance(self.performance_summary()),
        };
        if persists && !matches!(reply, EngineReply::Refused(_)) {
            if let Err(error) = self.persist_recovery() {
                self.output_inhibited = true;
                self.rasterizer.clear();
                self.preview_rasterizer.clear();
                return EngineReply::Refused(Refusal::TransportFailed {
                    detail: format!("recovery journal write failed: {error}"),
                });
            }
        }
        reply
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        std::mem::take(&mut self.events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_control_plane::intent::{ClearRequest, CueRequest, PhaseRequest, TakeRequest};
    use std::time::{SystemTime, UNIX_EPOCH};

    use gx_control_plane::message::OutputConfig;
    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::color::ColorValue;
    use gx_contracts::phases::{PhaseKind, TimelinePhase};
    use gx_contracts::scene::{
        ObjectBase, RectObject, SceneCanvas, SceneObject, SceneTimeline,
    };

    fn engine() -> Engine {
        // A clock that does not advance on its own: the test drives the frame
        // source, so timing is deterministic.
        Engine::new(Arc::new(AtomicU64::new(0)), Locality::CoLocated)
    }

    fn published(engine: &mut Engine) -> (TakeId, Revision) {
        let take_id = TakeId("take/101".into());
        let revision = Revision(1);
        engine.publish_identifier(take_id.clone(), revision);
        (take_id, revision)
    }

    fn animated_scene() -> SceneDocument {
        let mut shape = RectObject {
            base: ObjectBase::new("card", "card"),
            radius: 0.0,
        };
        shape.base.width = 8.0;
        shape.base.height = 8.0;
        shape.base.fill = Some(ColorValue::opaque_white());
        SceneDocument {
            id: "animated".into(),
            name: "Animated".into(),
            version: 1,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 64,
                height: 32,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 100,
                channels: vec![KeyframeChannel {
                    object_id: "card".into(),
                    property: "x".into(),
                    keys: vec![
                        SceneKeyframe {
                            frame: 0,
                            value: 0.0,
                            easing: SceneEasing::Linear,
                            bezier: None,
                        },
                        SceneKeyframe {
                            frame: 100,
                            value: 50.0,
                            easing: SceneEasing::Linear,
                            bezier: None,
                        },
                    ],
                }],
                phases: vec![
                    TimelinePhase {
                        kind: PhaseKind::In,
                        name: None,
                        start_frame: 0,
                        end_frame: 20,
                    },
                    TimelinePhase {
                        kind: PhaseKind::Hold,
                        name: None,
                        start_frame: 20,
                        end_frame: 40,
                    },
                    TimelinePhase {
                        kind: PhaseKind::Out,
                        name: None,
                        start_frame: 80,
                        end_frame: 100,
                    },
                ],
            },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects: vec![SceneObject::Rect(shape)],
        }
    }

    #[test]
    fn an_unpublished_take_is_refused_by_name() {
        let mut e = engine();
        let reply = e.handle(ClientRequest::Take(TakeRequest {
            take_id: TakeId("nope".into()),
            revision: Revision(1),
            at: TakeAt::NextOpportunity,
        }));
        assert!(matches!(
            reply,
            EngineReply::Refused(Refusal::UnknownTake { .. })
        ));
    }

    #[test]
    fn a_take_commits_a_frame_and_changes_program() {
        let mut e = engine();
        let (take_id, revision) = published(&mut e);
        assert!(e.render_program().is_black());

        let reply = e.handle(ClientRequest::Take(TakeRequest {
            take_id,
            revision,
            at: TakeAt::NextOpportunity,
        }));
        let committed = match reply {
            EngineReply::Taken(c) => c,
            other => panic!("expected Taken, got {other:?}"),
        };
        assert!(
            committed.frame >= 1,
            "next opportunity is at or past the lead"
        );

        let frame = e.render_program();
        assert!(!frame.is_black(), "a taken scene must reach Program");
    }

    #[test]
    fn a_clear_returns_program_to_black() {
        let mut e = engine();
        let (take_id, revision) = published(&mut e);
        let _ = e.handle(ClientRequest::Take(TakeRequest {
            take_id,
            revision,
            at: TakeAt::NextOpportunity,
        }));
        let _ = e.handle(ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
        }));
        assert!(e.render_program().is_black());
    }

    #[test]
    fn the_clock_advances_regardless_of_requests() {
        // ADR-002: time passes because the pump ticks, not because a client
        // asked. A take resolves against a later frame once time has moved.
        let frames = Arc::new(AtomicU64::new(0));
        let mut e = Engine::new(Arc::clone(&frames), Locality::CoLocated);
        let (take_id, revision) = published(&mut e);

        frames.store(500, Ordering::Relaxed);
        let status = match e.handle(ClientRequest::Status) {
            EngineReply::Status(s) => s,
            other => panic!("expected Status, got {other:?}"),
        };
        assert_eq!(
            status.current_frame, 500,
            "the engine must observe the pump"
        );

        let reply = e.handle(ClientRequest::Take(TakeRequest {
            take_id,
            revision,
            at: TakeAt::NextOpportunity,
        }));
        match reply {
            EngineReply::Taken(c) => assert!(c.frame > 500),
            other => panic!("expected Taken, got {other:?}"),
        }
    }

    #[test]
    fn a_cue_does_not_reach_program() {
        let mut e = engine();
        let (take_id, revision) = published(&mut e);
        let _ = e.handle(ClientRequest::Cue(CueRequest {
            take_id,
            revision,
            at: TakeAt::NextOpportunity,
        }));
        assert!(
            e.render_program().is_black(),
            "a cue prepares, it does not air"
        );
    }

    #[test]
    fn unknown_output_is_refused_with_the_sorted_offered_set() {
        let mut e = engine();
        let reply = e.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "decklink".into(),
            live: false,
            accept_free_run: false,
        }));
        assert!(matches!(
            reply,
            EngineReply::Refused(Refusal::UnknownOutputAdapter { requested, offered })
                if requested == "decklink"
                    && offered == ["null", "recording", "virtual"]
        ));
    }

    #[test]
    fn a_stalled_preview_consumer_never_blocks_program() {
        let frames = Arc::new(AtomicU64::new(0));
        let mut e = Engine::new(Arc::clone(&frames), Locality::CoLocated);
        e.emit_frame().expect("first frame emits");
        e.take_program().expect("Program consumer takes frame zero");

        frames.store(1, Ordering::Relaxed);
        let emission = e.emit_frame().expect("second frame emits");
        assert_eq!(emission.sample.frame, 1);
        assert_eq!(e.preview_drops().consumer_busy, 1);
        assert_eq!(e.program_drops().consumer_busy, 0);
        assert_eq!(e.take_program().expect("fresh Program remains available").checksum(), emission.frame.checksum());
    }

    #[test]
    fn recovery_restores_program_at_a_new_epoch_but_requires_output_rearming() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "gx-engine-recovery-{}-{nonce}.json",
            std::process::id()
        ));
        let take_id = TakeId("recovered/take".into());
        {
            let mut first = engine();
            first.publish_identifier(take_id.clone(), Revision(1));
            first
                .attach_recovery_journal(
                    RecoveryJournal::open_at(path.clone()).expect("journal opens"),
                )
                .expect("empty journal attaches");
            assert!(matches!(
                first.handle(ClientRequest::Take(TakeRequest {
                    take_id: take_id.clone(),
                    revision: Revision(1),
                    at: TakeAt::NextOpportunity,
                })),
                EngineReply::Taken(_)
            ));
        }

        let mut recovered = engine();
        recovered
            .attach_recovery_journal(
                RecoveryJournal::open_at(path.clone()).expect("journal reopens"),
            )
            .expect("complete state restores");
        assert!(recovered.output_inhibited());
        assert_eq!(recovered.clock.epoch(), Epoch(2));
        assert!(recovered.render_program().is_black());
        assert!(matches!(
            recovered.handle(ClientRequest::Status),
            EngineReply::Status(EngineStatus {
                program: Some(ProgramState { take_id: restored, .. }),
                live_allowed: false,
                ..
            }) if restored == take_id
        ));

        assert!(matches!(
            recovered.handle(ClientRequest::ConfigureOutput(OutputConfig {
                adapter: "virtual".into(),
                live: false,
                accept_free_run: false,
            })),
            EngineReply::OutputConfigured { .. }
        ));
        assert!(!recovered.output_inhibited());
        assert!(!recovered.render_program().is_black());
        std::fs::remove_file(path).expect("remove recovery fixture");
    }
    #[test]
    fn program_phases_resolve_on_the_engine_clock_and_hold_authored_time() {
        let frames = Arc::new(AtomicU64::new(0));
        let mut e = Engine::new(Arc::clone(&frames), Locality::CoLocated);
        assert!(matches!(
            e.publish(animated_scene()),
            PublishReply::Published { .. }
        ));
        assert!(matches!(
            e.handle(ClientRequest::Take(TakeRequest {
                take_id: TakeId("animated".into()),
                revision: Revision(1),
                at: TakeAt::NextOpportunity,
            })),
            EngineReply::Taken(_)
        ));
        assert!(matches!(
            e.handle(ClientRequest::Status),
            EngineReply::Status(EngineStatus {
                program: Some(ProgramState {
                    phase: Some(phase),
                    scene_frame: 0,
                    ..
                }),
                ..
            }) if phase == "in"
        ));

        frames.store(1, Ordering::Relaxed);
        let start = e.emit_frame().unwrap().frame;
        frames.store(21, Ordering::Relaxed);
        let end = e.emit_frame().unwrap().frame;
        assert_ne!(
            &start.pixels[32..],
            &end.pixels[32..],
            "the engine must evaluate the authored animation as its clock advances"
        );

        let reply = e.handle(ClientRequest::Phase(PhaseRequest {
            phase: "hold".into(),
            at: TakeAt::NextOpportunity,
        }));
        assert!(matches!(
            reply,
            EngineReply::PhaseCommitted(PhaseCommitted {
                phase,
                scene_frame: 20,
                playing: true,
                ..
            }) if phase == "hold"
        ));

        frames.store(50, Ordering::Relaxed);
        let held_a = e.emit_frame().unwrap().frame;
        frames.store(70, Ordering::Relaxed);
        let held_b = e.emit_frame().unwrap().frame;
        assert_eq!(
            &held_a.pixels[32..],
            &held_b.pixels[32..],
            "a hold phase loops its authored range until another command"
        );
        assert!(matches!(
            e.handle(ClientRequest::Status),
            EngineReply::Status(EngineStatus {
                program: Some(ProgramState {
                    scene_frame: 20,
                    playing: true,
                    phase: Some(phase),
                    ..
                }),
                ..
            }) if phase == "hold"
        ));
    }

    #[test]
    fn an_unknown_program_phase_refuses_by_address() {
        let mut e = engine();
        assert!(matches!(
            e.handle(ClientRequest::Phase(PhaseRequest {
                phase: "continue:score".into(),
                at: TakeAt::NextOpportunity,
            })),
            EngineReply::Refused(Refusal::TimelinePhaseUnknown { phase })
                if phase == "continue:score"
        ));
    }

}
