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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gx_asset_plane::package::MAX_PACKAGE_BYTES;
use gx_asset_plane::{
    AssetPublishPeer, AssetStore, PreviewImage, PreviewJob, PublishRefusal, PublishReply,
};
#[cfg(test)]
use gx_contracts::color::OutputTransform;
use gx_contracts::material::MaterialSupport;
use gx_contracts::scene::SceneDocument;
use gx_contracts::{
    ContentHash, DeviceTier, Epoch, Locality, MediaCodec, RationalRate, Refusal, Revision, TakeId,
};
use gx_control_plane::capability::{check_protocol, live_allowed, EngineCapability};
use gx_control_plane::intent::{
    check_reference, HeldRevision, Lead, PhaseCommitted, TakeAt, TakeCommitted,
};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, OutputConfig};
use gx_control_plane::peer::{EnginePeer, Handled};
use gx_control_plane::render::check_render;
use gx_control_plane::status::{Degradation, EngineStatus, ProgramState};

use crate::clock::ProgramClock;
use crate::compositor::output::{Delivered, Submitted};
use crate::compositor::scene::{GpuScene, SourceTrace};
use crate::emission::{FrameEmitter, ProgramEmission};
use crate::governor::{Level, LoadGovernor, NonLiveGate, Observation};
use crate::gpu::{self, Gpu};
use crate::headless::{answer_render, RenderedImages};
use crate::mesh::AssetBytes;
use crate::metrics::{EnginePerformance, FrameMetrics, FrameSample};
use crate::output_adapter::{OutputAdapterError, OutputAdapterRegistry};
use crate::prepared::PreparedScene;
use crate::rasterizer::{key_for_take, Frame, SoftwareRasterizer, FRAME_HEIGHT, FRAME_WIDTH};
use crate::recovery::{
    DropReport, DroppedScene, PreparedSceneRecord, RecoveryError, RecoveryJournal, RecoveryState,
    DROP_REPORT_SCHEMA_VERSION,
};
use crate::render_work::{ProgramFrameTrace, RenderWork};

/// The render engine. Owns the GPU, the clock and Program.
/// The newest GPU delivery: the pinned revision it belongs to, and its Program
/// and Preview frames (3.21).
type GpuDelivered = ((TakeId, Revision), Arc<Frame>, Arc<Frame>);

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
    /// What has been published: its revision and the content hash a cue or
    /// take must pin (invariant 61).
    published: HashMap<TakeId, HeldRevision>,
    /// The prepared scene each published revision pins (3.4). Keyed by the
    /// pinned identity, so an earlier revision keeps exactly the scene it was
    /// published with (invariant 30). Shared, so a headless render can draw
    /// it after the engine lock is released (11.41).
    prepared: HashMap<(TakeId, Revision), Arc<PreparedScene>>,
    gpu_prepared: HashMap<(TakeId, Revision), GpuScene>,
    last_render_trace: Option<ProgramFrameTrace>,
    gpu_clear_frame: Option<Arc<Frame>>,
    /// 3.21: the Program and Preview frames the GPU readback ring last
    /// delivered, with the pinned scene they belong to. Held between
    /// deliveries, so a frame whose readback has not completed repeats the
    /// last delivered picture instead of waiting.
    gpu_delivered: Option<GpuDelivered>,
    /// The frames last emitted, whatever produced them.
    last_frames: Option<(Arc<Frame>, Arc<Frame>)>,
    /// Recently emitted frames awaiting release by their consumers; once a
    /// frame has no other owner its allocation goes back to the readback
    /// ring (bounded, oldest dropped).
    recycle: std::collections::VecDeque<Arc<Frame>>,
    readback: ReadbackReport,
    /// Content hashes the asset plane has verified into the store.
    assets: HashSet<ContentHash>,
    /// Verified asset bytes bound by content hash. Mesh and font preparation
    /// receive these only after the asset plane has completed verification.
    asset_bytes: AssetBytes,
    /// The directory a co-located publisher may hand packages from by local
    /// path (5.8). `None` reads no path.
    package_directory: Option<PathBuf>,
    /// Where an accepted stop request goes (2.19): the process that owns the
    /// engine's log and exit. `None` when nothing is listening, and the engine
    /// then refuses a stop request by name instead of saying it is stopping.
    stop_signal: Option<std::sync::mpsc::Sender<StopRequest>>,
    /// Where the transport's word about the stop reply goes (2.22): set when a
    /// stop request was accepted, taken when the transport reports on the reply.
    stop_flush: Option<StopFlush>,
    /// The engine's own store of verified asset bytes beside its recovery
    /// journal (5.11). The asset plane writes every asset there before this
    /// engine is handed it. `None` until a journal is attached.
    asset_store: Option<Arc<AssetStore>>,
    /// Takes the last restore dropped, and why (5.11). Cue, Take and Render
    /// of one are refused with that reason until it is published again or
    /// the engine restarts: the reason is kept in memory only, so after the
    /// next restart the take is unknown, its revision floor and
    /// `<journal>.dropped.json` keeping the record.
    dropped: BTreeMap<TakeId, DroppedScene>,
    /// The last revision of each dropped take, journaled, so publishing it
    /// again continues from there (5.11, invariant 61).
    revision_floors: BTreeMap<TakeId, Revision>,
    program: Option<ProgramState>,
    cued: Option<ProgramState>,
    rasterizer: SoftwareRasterizer,
    preview_rasterizer: SoftwareRasterizer,
    emitter: FrameEmitter,
    metrics: FrameMetrics,
    /// The clock frame Program was last emitted for, so frames the render
    /// loop never reached are counted as missed rather than vanishing.
    last_emitted: Option<u64>,
    /// 2.12: the once-a-second record that the engine is running.
    heartbeat: crate::log::Heartbeat,
    /// Headless renders' images, served on the asset plane by content hash.
    rendered: Arc<Mutex<RenderedImages>>,
    outputs: OutputAdapterRegistry,
    selected_output: String,
    recovery: Option<RecoveryJournal>,
    output_inhibited: bool,
    events: Vec<EngineEvent>,
    /// 3.24: watches what Program's frames cost and sheds non-live work.
    governor: LoadGovernor,
    /// The gate detached renders wait at; the governor sets its level.
    gate: Arc<NonLiveGate>,
    /// Governor moves since start, and the latest in words.
    shifts: u64,
    last_shift: Option<String>,
    /// Ring-full count at the last observation, to see it rise.
    seen_ring_full: u64,
    /// 11.65: the draft scenes the preview prepared lately, newest last, so
    /// moving the playhead through the same document does not prepare it again.
    preview_cache: Arc<Mutex<PreviewCache>>,
}

/// How many prepared drafts the preview keeps.
const PREVIEW_CACHE_ENTRIES: usize = 4;

/// Prepared draft scenes by content hash, oldest first.
type PreviewCache = Vec<(ContentHash, Arc<PreparedScene>)>;

/// The highest load level anything is wired to shed at (3.24): detached renders
/// run one at a time. Higher levels are raised here as each is built, never
/// before, so the engine never reports shedding it does not do.
const WIRED_LEVEL: Level = Level::DetachedThrottled;

/// What attaching a recovery journal dropped (5.11).
#[derive(Debug, Default)]
pub struct Restored {
    /// Journaled scenes dropped because their bytes were not intact.
    pub dropped: Vec<DroppedScene>,
    /// Where the drops were written, or why they could not be. `None` when
    /// nothing was dropped.
    pub report: Option<Result<PathBuf, RecoveryError>>,
}

impl Engine {
    /// Build an engine: negotiate the device, start the clock free-running.
    ///
    /// Free-running is the honest default for a machine with no reference
    /// input (invariant 11). A genlocked adapter, when one exists, slaves the
    /// clock through `ProgramClock::slave_to`; until then the engine says it
    /// is free-running rather than implying accuracy it does not have.
    pub fn new(frame_source: Arc<AtomicU64>, locality: Locality) -> Self {
        Self::with_gpu(frame_source, locality, gpu::negotiate())
    }

    fn with_gpu(frame_source: Arc<AtomicU64>, locality: Locality, gpu: Gpu) -> Self {
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
            gpu_prepared: HashMap::new(),
            last_render_trace: None,
            gpu_clear_frame: None,
            gpu_delivered: None,
            last_frames: None,
            recycle: std::collections::VecDeque::new(),
            readback: ReadbackReport::default(),
            assets: HashSet::new(),
            asset_bytes: HashMap::new(),
            package_directory: None,
            stop_signal: None,
            stop_flush: None,
            asset_store: None,
            dropped: BTreeMap::new(),
            revision_floors: BTreeMap::new(),
            program: None,
            cued: None,
            rasterizer,
            preview_rasterizer,
            emitter: FrameEmitter::new(),
            metrics: FrameMetrics::with_window(rate, 60),
            last_emitted: None,
            heartbeat: crate::log::Heartbeat::new(),
            rendered: Arc::new(Mutex::new(RenderedImages::with_capacity(64))),
            outputs: OutputAdapterRegistry::standard(
                std::env::temp_dir().join("grapix-render-output"),
            ),
            selected_output: "null".into(),
            recovery: None,
            output_inhibited: false,
            events: Vec::new(),
            governor: LoadGovernor::new(WIRED_LEVEL),
            gate: Arc::new(NonLiveGate::default()),
            shifts: 0,
            last_shift: None,
            seen_ring_full: 0,
            preview_cache: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Accept packages by local path from `directory`, an absolute path the
    /// host has checked exists (5.8). The asset plane refuses any path that
    /// does not resolve inside it.
    pub fn set_package_directory(&mut self, directory: PathBuf) {
        self.package_directory = Some(directory);
    }

    /// Name who hears an accepted stop request (2.19). The engine does not end
    /// its own process: it tells whoever owns the log and the exit, which writes
    /// the stop records and ends the process once the reply has gone out.
    pub fn set_stop_signal(&mut self, signal: std::sync::mpsc::Sender<StopRequest>) {
        self.stop_signal = Some(signal);
    }

    /// The negotiated device tier. Read by the host to report health.
    pub fn device_tier(&self) -> DeviceTier {
        self.gpu.tier()
    }

    /// Attach the host-owned journal and restore its last complete state.
    ///
    /// A recovered Program is rebuilt but remains output-inhibited until a
    /// fresh `ConfigureOutput` request explicitly re-arms a destination.
    ///
    /// 5.11: the engine's asset store beside the journal is attached with it,
    /// and restore reads every journaled scene's assets back from it. A scene
    /// whose bytes are missing, altered or unreadable is dropped by name
    /// rather than keeping the engine down; the drops are written to the drop
    /// report before the journal that no longer lists them is written.
    pub fn attach_recovery_journal(
        &mut self,
        journal: RecoveryJournal,
    ) -> Result<Restored, RecoveryError> {
        let store = Arc::new(AssetStore::at_root(journal.asset_store_directory()));
        let mut restored = Restored::default();
        if let Some(state) = journal.load()? {
            restored.dropped = self.restore_state(state, &store)?;
            self.output_inhibited = true;
            self.rasterizer.clear();
            self.preview_rasterizer.clear();
        }
        self.asset_store = Some(store);
        if !restored.dropped.is_empty() {
            restored.report = Some(journal.record_drops(&DropReport {
                schema_version: DROP_REPORT_SCHEMA_VERSION,
                epoch: self.clock.epoch(),
                dropped: restored.dropped.clone(),
            }));
        }
        self.recovery = Some(journal);
        self.persist_recovery()?;
        Ok(restored)
    }

    /// The takes the last restore dropped, in take order (5.11).
    pub fn dropped_scenes(&self) -> impl Iterator<Item = &DroppedScene> {
        self.dropped.values()
    }

    /// Whether a recovered engine is still prevented from emitting old state.
    pub fn output_inhibited(&self) -> bool {
        self.output_inhibited
    }

    /// A deterministic point-in-time recovery snapshot.
    ///
    /// It records each published take's latest revision and any earlier
    /// revision Program or the cue still names (5.12): a take published
    /// again while an earlier revision is on air keeps that revision
    /// recoverable.
    pub fn recovery_state(&self) -> RecoveryState {
        let mut state = RecoveryState {
            schema_version: crate::recovery::RECOVERY_SCHEMA_VERSION,
            epoch: self.clock.epoch(),
            published: self
                .published
                .iter()
                .map(|(take_id, held)| (take_id.clone(), held.clone()))
                .collect(),
            prepared_scenes: Vec::new(),
            verified_assets: self.assets.iter().cloned().collect(),
            cued: self.cued.clone(),
            program: self.program.clone(),
            revision_floors: self.revision_floors.clone(),
        };
        // One rule for what the journal keeps, shared with its validation
        // (invariant 27): the latest revision and any earlier one named.
        let mut prepared_scenes: Vec<_> = self
            .prepared
            .iter()
            .filter(|((take_id, revision), _)| {
                self.published.get(take_id).is_some_and(|held| {
                    held.revision == *revision
                        || (*revision < held.revision && state.names(take_id, *revision))
                })
            })
            .map(|((take_id, revision), prepared)| PreparedSceneRecord {
                take_id: take_id.clone(),
                revision: *revision,
                document: prepared.document().clone(),
            })
            .collect();
        prepared_scenes.sort_by(|left, right| {
            (&left.take_id, left.revision).cmp(&(&right.take_id, right.revision))
        });
        state.prepared_scenes = prepared_scenes;
        state
    }

    fn persist_recovery(&self) -> Result<(), RecoveryError> {
        match &self.recovery {
            Some(journal) => journal.record(&self.recovery_state()),
            None => Ok(()),
        }
    }

    /// Rebuild a journaled state from the bytes in `store` (5.11).
    ///
    /// Every asset a journaled scene declares, whatever its kind, is read
    /// back and re-hashed before preparation; `verified_assets` is not
    /// trusted. A take with a missing, altered or unreadable asset in any of
    /// its journaled revisions (5.12: the latest and any earlier one Program
    /// or the cue names) is dropped whole, once: it leaves `published` (so no
    /// take can reach it through the identifier-only path), Program and the
    /// cue are cleared only if they name it, and its latest revision becomes
    /// the take's floor. A scene whose bytes
    /// are intact but which no longer prepares still stops the restore, as
    /// before 5.11 (user decision, 8 Nov 2026): the journal is then left as
    /// it was, so a transient fault cannot erase scenes.
    fn restore_state(
        &mut self,
        state: RecoveryState,
        store: &AssetStore,
    ) -> Result<Vec<DroppedScene>, RecoveryError> {
        state.validate()?;
        let next_epoch = state.next_epoch()?;
        let support = self.material_support();
        let mut read_back: HashMap<ContentHash, Result<(), Refusal>> = HashMap::new();
        let mut asset_bytes: AssetBytes = HashMap::new();
        let mut published = state.published;
        let mut revision_floors = state.revision_floors;
        let (mut cued, mut program) = (state.cued, state.program);
        let mut dropped = Vec::new();
        let mut prepared = HashMap::new();
        let mut gpu_prepared = HashMap::new();
        // First every record's bytes are read back, so a take with several
        // journaled revisions is judged as one: the first bad asset of any of
        // them drops the take.
        let mut failed: BTreeMap<TakeId, Refusal> = BTreeMap::new();
        for record in &state.prepared_scenes {
            if failed.contains_key(&record.take_id) {
                continue;
            }
            for hash in record
                .document
                .assets
                .iter()
                .filter_map(|asset| asset.checksum.as_ref())
            {
                let verdict = read_back.entry(hash.clone()).or_insert_with(|| {
                    match store.read_verified(hash, MAX_PACKAGE_BYTES) {
                        Ok(bytes) => {
                            asset_bytes.insert(hash.clone(), bytes);
                            Ok(())
                        }
                        Err(error) => Err(error.into_refusal(hash)),
                    }
                });
                if let Err(reason) = verdict {
                    failed.insert(record.take_id.clone(), reason.clone());
                    break;
                }
            }
        }
        for (take_id, reason) in failed {
            // `validate` guarantees every record belongs to a published take.
            let held = published
                .remove(&take_id)
                .expect("a journaled scene belongs to a published take");
            let names = |state: &Option<ProgramState>| {
                state.as_ref().is_some_and(|state| state.take_id == take_id)
            };
            let (was_program, was_cued) = (names(&program), names(&cued));
            if was_program {
                program = None;
            }
            if was_cued {
                cued = None;
            }
            revision_floors.insert(take_id.clone(), held.revision);
            dropped.push(DroppedScene {
                take_id,
                revision: held.revision,
                content_hash: held.content_hash,
                reason,
                was_program,
                was_cued,
            });
        }
        for record in state.prepared_scenes {
            if dropped.iter().any(|scene| scene.take_id == record.take_id) {
                continue;
            }
            let available: HashSet<ContentHash> = asset_bytes.keys().cloned().collect();
            let scene =
                PreparedScene::prepare_for_gpu(record.document, &available, &asset_bytes, &support)
                    .map_err(|refusal| RecoveryError::InvalidState {
                        detail: format!(
                            "prepared scene {}/{} cannot be rebuilt: {refusal}",
                            record.take_id, record.revision.0
                        ),
                    })?;
            if let Some(cause) = gx_contracts::drawability::gpu_compositor_animation_refusal(
                scene.resolved_document(),
            ) {
                return Err(RecoveryError::InvalidState {
                    detail: cause.to_string(),
                });
            }
            if self.gpu.has_hardware() {
                let gpu_scene = GpuScene::prepare(&self.gpu, &scene).map_err(|cause| {
                    RecoveryError::InvalidState {
                        detail: cause.to_string(),
                    }
                })?;
                gpu_prepared.insert((record.take_id.clone(), record.revision), gpu_scene);
            }
            prepared.insert((record.take_id, record.revision), Arc::new(scene));
        }
        self.clock = ProgramClock::free_running(
            next_epoch,
            self.clock.timebase(),
            Lead::for_locality(self.locality),
        );
        self.published = published.into_iter().collect();
        self.prepared = prepared;
        self.gpu_prepared = gpu_prepared;
        self.assets = asset_bytes.keys().cloned().collect();
        self.asset_bytes = asset_bytes;
        self.cued = cued;
        self.program = program;
        self.revision_floors = revision_floors;
        self.dropped = dropped
            .iter()
            .map(|scene| (scene.take_id.clone(), scene.clone()))
            .collect();
        Ok(dropped)
    }
    fn activate_program_base(&mut self) {
        let Some(program) = self.program.clone() else {
            self.rasterizer.clear();
            self.preview_rasterizer.clear();
            return;
        };
        let take_key = key_for_take(&program.take_id);
        if self
            .prepared
            .contains_key(&(program.take_id.clone(), program.revision))
        {
            // Authored scenes own prepared GPU resources already. Never touch
            // the CPU reference frame at Take, recovery re-arm or Phase.
            self.gpu_clear_frame = self
                .gpu_prepared
                .get(&(program.take_id.clone(), program.revision))
                .map(GpuScene::clear_frame);
        } else {
            self.gpu_clear_frame = None;
            self.rasterizer.take(take_key);
            self.preview_rasterizer.take(take_key);
        }
    }
    /// Resolve semantic scene time without rasterising or preparing any pixels.
    ///
    /// The scene frame is relative to the engine's committed take frame, never
    /// to wall time. This keeps reconnects and frame-pump catch-up deterministic.
    fn program_scene_frame(&self, engine_frame: u64) -> Option<u64> {
        let program = self.program.as_ref()?;
        let prepared = self
            .prepared
            .get(&(program.take_id.clone(), program.revision))?;
        let elapsed = engine_frame.saturating_sub(program.committed_frame);
        let current_phase = program
            .phase
            .as_deref()
            .and_then(|address| prepared.phase(address));
        let mut scene_frame = match current_phase {
            Some(phase)
                if program.playing && phase.kind == gx_contracts::phases::PhaseKind::Hold =>
            {
                let length = phase.end_frame - phase.start_frame;
                phase.start_frame + (elapsed % length)
            }
            _ if program.playing => program.scene_frame.saturating_add(elapsed),
            _ => program.scene_frame,
        };
        if let Some(stop) = program.stop_frame {
            if current_phase.map(|phase| phase.kind) != Some(gx_contracts::phases::PhaseKind::Hold)
            {
                scene_frame = scene_frame.min(stop);
            }
        }
        scene_frame = scene_frame.min(prepared.document().timeline.duration_frames);
        Some(scene_frame)
    }

    /// Publish a scene identifier so a take of it can succeed, with no
    /// content.
    ///
    /// The identifier-only path exists for the worker's own binary and the
    /// conformance suite: a take names a revision and the engine answers
    /// whether it has one, and Program is the software rasteriser's take key.
    /// It is not the authoring path — a scene reaches the engine through
    /// [`Engine::publish`], and an identifier published this way has no
    /// `PreparedScene` behind it. With no document to hash, the caller
    /// declares the content hash a take must pin.
    pub fn publish_identifier(
        &mut self,
        take_id: TakeId,
        revision: Revision,
        content_hash: ContentHash,
    ) {
        self.published.insert(
            take_id,
            HeldRevision {
                revision,
                content_hash,
            },
        );
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
        // A take a restore dropped continues from its last revision (5.11).
        let revision = self
            .published
            .get(&take_id)
            .map(|held| held.revision.next())
            .or_else(|| self.revision_floors.get(&take_id).map(|floor| floor.next()))
            .unwrap_or(Revision(1));
        let content_hash = document.content_hash();
        let prepared = match PreparedScene::prepare_for_gpu(
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
        if let Some(cause) = gx_contracts::drawability::gpu_compositor_animation_refusal(
            prepared.resolved_document(),
        ) {
            return PublishReply::Refused(PublishRefusal::PreparationRefused { cause });
        }
        // 5.11: nothing is acknowledged that the store beside the journal does
        // not hold, so the publication survives a restart.
        if let Some(store) = &self.asset_store {
            for hash in prepared
                .document()
                .assets
                .iter()
                .filter_map(|asset| asset.checksum.as_ref())
            {
                let stored = self
                    .asset_bytes
                    .get(hash)
                    .is_some_and(|bytes| store.holds_entry(hash, bytes.len() as u64));
                if !stored {
                    return PublishReply::Refused(PublishRefusal::PreparationRefused {
                        cause: Refusal::AssetMissing { hash: hash.clone() },
                    });
                }
            }
        }
        if self.gpu.has_hardware() {
            let gpu_scene = match GpuScene::prepare(&self.gpu, &prepared) {
                Ok(scene) => scene,
                Err(cause) => {
                    return PublishReply::Refused(PublishRefusal::PreparationRefused { cause })
                }
            };
            self.gpu_prepared
                .insert((take_id.clone(), revision), gpu_scene);
        }
        self.prepared
            .insert((take_id.clone(), revision), Arc::new(prepared));
        self.published.insert(
            take_id.clone(),
            HeldRevision {
                revision,
                content_hash: content_hash.clone(),
            },
        );
        self.revision_floors.remove(&take_id);
        self.dropped.remove(&take_id);
        if let Err(error) = self.persist_recovery() {
            self.output_inhibited = true;
            return PublishReply::Refused(PublishRefusal::PreparationRefused {
                cause: Refusal::TransportFailed {
                    detail: format!("recovery journal write failed: {error}"),
                },
            });
        }
        PublishReply::Published {
            take_id,
            revision,
            content_hash,
        }
    }

    /// The prepared scene a published revision pins, if this engine holds it.
    pub fn prepared_scene(&self, take_id: &TakeId, revision: Revision) -> Option<&PreparedScene> {
        self.prepared
            .get(&(take_id.clone(), revision))
            .map(Arc::as_ref)
    }

    pub fn program_frame_trace(&self) -> Option<&ProgramFrameTrace> {
        self.last_render_trace.as_ref()
    }

    pub fn gpu_description(&self) -> Option<String> {
        self.gpu.diagnostic_description()
    }

    pub fn gpu_source_trace(&self, take_id: &TakeId, revision: Revision) -> Option<&[SourceTrace]> {
        self.gpu_prepared
            .get(&(take_id.clone(), revision))
            .map(GpuScene::sources)
    }

    fn ensure_program_backend(&self, take_id: &TakeId, revision: Revision) -> Result<(), Refusal> {
        if !self.prepared.contains_key(&(take_id.clone(), revision)) {
            // Identifier-only control/conformance fixtures are explicit
            // diagnostics, not a published scene or a production fallback.
            return Ok(());
        }
        if !self.gpu.has_hardware() {
            return Err(Refusal::TierTooLow {
                actual: self.gpu.tier(),
            });
        }
        if !self.gpu_prepared.contains_key(&(take_id.clone(), revision)) {
            return Err(Refusal::TransportFailed {
                detail: "published GPU revision has no prepared compositor".into(),
            });
        }
        Ok(())
    }

    /// Record a verified asset and retain its immutable bytes for per-publish
    /// font and mesh preparation, in memory only. The asset plane verifies
    /// the content hash before this receipt; the engine never reads a mutable
    /// source path. Production receipt goes through `accept_verified_asset`,
    /// which also requires the bytes to be in the engine's store (5.11).
    pub(crate) fn record_verified_asset_bytes(&mut self, hash: ContentHash, bytes: Vec<u8>) {
        self.assets.insert(hash.clone());
        self.asset_bytes.insert(hash, bytes);
    }

    /// No material renderer is implemented: meshes and material bindings
    /// refuse at publish. Capability and validation share this declaration.
    fn material_support(&self) -> MaterialSupport {
        MaterialSupport::none()
    }

    /// Render and emit one Preview/Program pair at the engine's current frame.
    ///
    /// Authored scenes evaluate uniforms, composite cached sources and encode
    /// both outputs on the GPU. The readback is pipelined through a bounded
    /// asynchronous ring (3.21): this call queues the current frame and emits
    /// the newest frame whose readback has completed, so the live loop never
    /// waits on the GPU. Consumer delivery uses bounded latest-frame slots.
    pub fn emit_frame(&mut self) -> Result<ProgramEmission, OutputAdapterError> {
        self.emit(false)
    }

    /// As [`Engine::emit_frame`], but waits (bounded) until the current
    /// frame is read back, so the emitted frame is exactly this clock frame.
    /// For tests and synchronous callers, never for the live loop.
    pub fn emit_frame_settled(&mut self) -> Result<ProgramEmission, OutputAdapterError> {
        self.emit(true)
    }

    /// The GPU readback ring's delivery report since this engine started.
    pub fn readback_report(&self) -> &ReadbackReport {
        &self.readback
    }

    fn emit(&mut self, settled: bool) -> Result<ProgramEmission, OutputAdapterError> {
        self.sync_clock();
        let frame_number = self.clock.frame();
        let started = Instant::now();
        let work_before = RenderWork::snapshot();
        let scene_frame = self.program_scene_frame(frame_number);
        let (program, preview, backend) =
            if let (Some(scene_frame), false) = (scene_frame, self.output_inhibited) {
                let state = self.program.as_ref().expect("scene time requires Program");
                self.ensure_program_backend(&state.take_id, state.revision)
                    .map_err(|cause| OutputAdapterError::Render { cause })?;
                let key = (state.take_id.clone(), state.revision);
                let scene = self
                    .gpu_prepared
                    .get_mut(&key)
                    .expect("backend checked before rendering");
                let recycle = &mut self.recycle;
                let mut i = 0;
                while i < recycle.len() {
                    if Arc::strong_count(&recycle[i]) == 1 {
                        if let Some(Ok(frame)) = recycle.remove(i).map(Arc::try_unwrap) {
                            scene.recycle(frame.pixels);
                        }
                    } else {
                        i += 1;
                    }
                }
                if settled {
                    let (program, preview) = scene
                        .render(scene_frame)
                        .map_err(|cause| OutputAdapterError::Render { cause })?;
                    let (program, preview) = (Arc::new(program), Arc::new(preview));
                    self.gpu_delivered = Some((key, Arc::clone(&program), Arc::clone(&preview)));
                    (program, preview, "gpu-compositor")
                } else {
                    let submitted = scene
                        .submit(scene_frame, frame_number)
                        .map_err(|cause| OutputAdapterError::Render { cause })?;
                    if submitted == Submitted::RingFull {
                        self.readback.ring_full += 1;
                    }
                    if let Some(delivered) = scene
                        .collect()
                        .map_err(|cause| OutputAdapterError::Render { cause })?
                    {
                        self.readback.record(frame_number, &delivered);
                        self.gpu_delivered = Some((
                            key.clone(),
                            Arc::new(delivered.program),
                            Arc::new(delivered.preview),
                        ));
                    }
                    self.readback.superseded = scene.ring_counters().1;
                    match &self.gpu_delivered {
                        Some((held, program, preview)) if *held == key => {
                            (Arc::clone(program), Arc::clone(preview), "gpu-compositor")
                        }
                        // The new scene's first readback is still in flight: the
                        // previous picture repeats for the pipeline's latency.
                        _ => {
                            self.readback.awaiting_first += 1;
                            let fallback = self.last_frames.clone();
                            let (program, preview) = match fallback {
                                Some(frames) => frames,
                                None => {
                                    let clear = match self.gpu_clear_frame.clone() {
                                        Some(clear) => clear,
                                        None => Arc::new(self.rasterizer.render(frame_number)),
                                    };
                                    (Arc::clone(&clear), clear)
                                }
                            };
                            (program, preview, "gpu-compositor-awaiting-readback")
                        }
                    }
                }
            } else if let Some(clear) = self
                .gpu_clear_frame
                .as_ref()
                .filter(|_| self.program.is_none() || self.output_inhibited)
            {
                (clear.clone(), clear.clone(), "clear-or-inhibited")
            } else {
                (
                    Arc::new(self.rasterizer.render(frame_number)),
                    Arc::new(self.preview_rasterizer.render(frame_number)),
                    if self.program.is_some() && !self.output_inhibited {
                        "identifier-only-diagnostic"
                    } else {
                        "clear-or-inhibited"
                    },
                )
            };
        if let Some((old_program, old_preview)) = self
            .last_frames
            .replace((Arc::clone(&program), Arc::clone(&preview)))
        {
            self.recycle.push_back(old_program);
            self.recycle.push_back(old_preview);
            while self.recycle.len() > 8 {
                self.recycle.pop_front();
            }
        }
        self.last_render_trace = Some(ProgramFrameTrace {
            engine_frame: frame_number,
            scene_frame: scene_frame.unwrap_or(0),
            backend,
            work: RenderWork::snapshot().since(work_before),
        });
        let render_nanos = started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
        self.emitter
            .emit(Arc::clone(&preview), Arc::clone(&program));
        let interval_nanos = self.clock.offset_nanos(1).min(u128::from(u64::MAX)) as u64;
        // The clock may have passed frames while this loop was away; each is
        // a Program frame that was never emitted, and is counted as missed.
        let missed_before = self.last_emitted.map_or(0, |last| {
            frame_number.saturating_sub(last).saturating_sub(1)
        });
        self.last_emitted = Some(frame_number);
        let sample = FrameSample {
            frame: frame_number,
            render_nanos,
            interval_nanos,
            late: render_nanos > interval_nanos,
            drops_so_far: self.emitter.total_drops(),
            missed_before,
        };
        self.metrics.record(sample);
        self.govern(&sample);
        // 2.12: a late frame and frames the clock passed are on record, and a
        // heartbeat each second says the engine is running and how.
        let epoch = self.clock.epoch().0;
        crate::log::frame(&sample, epoch);
        let (metrics, program_state, inhibited) =
            (&self.metrics, &self.program, self.output_inhibited);
        let (clock, reference) = (self.clock.source(), self.clock.reference());
        self.heartbeat
            .beat(std::time::Instant::now(), || crate::log::Totals {
                epoch,
                frame: frame_number,
                rendered: metrics.total_rendered(),
                late: metrics.total_late(),
                missed: metrics.total_missed(),
                dropped: metrics.total_dropped(),
                program: program_state
                    .as_ref()
                    .map(|p| format!("{}@{}", p.take_id.0, p.revision.0)),
                output_inhibited: inhibited,
                clock: format!("{clock:?}"),
                reference: format!("{reference:?}"),
            });
        if !self.output_inhibited {
            self.outputs
                .emit(&self.selected_output, frame_number, Arc::clone(&program))?;
        }
        Ok(ProgramEmission {
            frame: program,
            sample,
        })
    }

    /// 3.24: feed the frame to the load governor and apply what it decides. An
    /// empty Program sheds nothing (an idle engine has nothing at risk).
    fn govern(&mut self, sample: &FrameSample) {
        let transition = if self.program.is_none() {
            self.governor.program_empty()
        } else {
            let on_ring = self.gpu.has_hardware() && self.readback.delivered > 0;
            let ring_full = self.readback.ring_full;
            let observation = Observation {
                render_nanos: sample.render_nanos,
                interval_nanos: sample.interval_nanos,
                late: sample.late,
                missed: sample.missed_before,
                frames_behind: on_ring
                    .then(|| self.readback.frames_behind.last().copied())
                    .flatten(),
                ring_full: ring_full.saturating_sub(self.seen_ring_full),
            };
            self.seen_ring_full = ring_full;
            self.governor.observe(observation)
        };
        if let Some(transition) = transition {
            self.gate.set_level(transition.to);
            self.shifts += 1;
            self.last_shift = Some(format!(
                "{} to {}: {}",
                transition.from, transition.to, transition.reason
            ));
            crate::log::load_shift(&transition, sample.frame, self.clock.epoch().0);
        }
    }

    /// The level non-live work is shed at now.
    pub fn load_level(&self) -> Level {
        self.governor.level()
    }

    /// The gate detached renders wait at (shared with the closures it hands out).
    pub fn non_live_gate(&self) -> Arc<NonLiveGate> {
        Arc::clone(&self.gate)
    }

    /// Render Program for synchronous callers and tests.
    pub fn render_program(&mut self) -> Frame {
        self.emit_frame_settled()
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
            total_missed: self.metrics.total_missed(),
            mean_budget_ratio: self.metrics.mean_budget_ratio(),
        }
    }

    /// The performance snapshot in the control-plane's own type, so the
    /// wire format does not depend on the worker crate.
    fn performance_summary(&self) -> gx_control_plane::status::PerformanceSummary {
        let perf = self.performance();
        let frames: Vec<_> = perf
            .frames
            .iter()
            .map(|f| gx_control_plane::status::FrameSampleSummary {
                frame: f.frame,
                render_nanos: f.render_nanos,
                interval_nanos: f.interval_nanos,
                late: f.late,
                drops_so_far: f.drops_so_far,
                missed_before: f.missed_before,
            })
            .collect();
        // 2.27: what the engine measured, assessed once for every surface.
        let gpu = self.gpu.diagnostic_description();
        let readback = self.gpu.has_hardware().then(|| {
            let report = &self.readback;
            gx_control_plane::telemetry::ReadbackFacts {
                delivered: report.delivered,
                ring_full: report.ring_full,
                superseded: report.superseded,
                awaiting_first: report.awaiting_first,
                frames_behind: report.frames_behind.clone(),
                latency_nanos: report.latency_nanos.clone(),
            }
        });
        let load = gx_control_plane::telemetry::LoadFacts {
            level: self.governor.level() as u8,
            max_level: self.governor.max_level() as u8,
            name: self.governor.level().to_string(),
            shed: self.governor.level().describes().into(),
            shifts: self.shifts,
            last_shift: self.last_shift.clone(),
            detached_running: u32::try_from(self.gate.running()).unwrap_or(u32::MAX),
        };
        let telemetry =
            gx_control_plane::telemetry::assess(&gx_control_plane::telemetry::TelemetryInputs {
                rate: perf.rate,
                tier: perf.device_tier,
                gpu: gpu.as_deref(),
                frames: &frames,
                readback: readback.as_ref(),
                output: &self.selected_output,
                output_inhibited: self.output_inhibited,
                reference: self.clock.reference(),
                degradations: &self.degradations(),
                load: Some(&load),
            });
        gx_control_plane::status::PerformanceSummary {
            rate: perf.rate,
            device_tier: perf.device_tier,
            frames,
            total_rendered: perf.total_rendered,
            total_late: perf.total_late,
            total_dropped: perf.total_dropped,
            total_missed: perf.total_missed,
            mean_budget_ratio: perf.mean_budget_ratio,
            components: telemetry.components,
            findings: telemetry.findings,
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

    /// Check a scene reference against what is published: the shared rule
    /// (unknown take, wrong revision, missing or wrong pin), so this engine
    /// and every mock refuse alike.
    fn check_published(
        &self,
        take_id: &TakeId,
        revision: Revision,
        pin: Option<&ContentHash>,
    ) -> Result<(), Refusal> {
        self.check_not_dropped(take_id)?;
        check_reference(take_id, revision, pin, self.published.get(take_id))
    }

    /// A take the last restore dropped is refused with why (5.11), until it
    /// is published again or the engine restarts (the reason is not
    /// journaled; the drop report and the revision floor are).
    fn check_not_dropped(&self, take_id: &TakeId) -> Result<(), Refusal> {
        match self.dropped.get(take_id) {
            Some(dropped) if !self.published.contains_key(take_id) => Err(dropped.reason.clone()),
            _ => Ok(()),
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
        if self.output_inhibited {
            if let Some(program) = &self.program {
                if let Err(cause) = self.ensure_program_backend(&program.take_id, program.revision)
                {
                    return EngineReply::Refused(cause);
                }
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
    // 5.10: the field `capability()` declares, read by a publisher that holds
    // no control client. One field, two carriers (invariants 27, 45).
    fn locality(&self) -> Locality {
        self.locality
    }

    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
        let take_id = scene.id.clone();
        let reply = self.publish(scene);
        crate::log::publish(&take_id, &reply);
        reply
    }

    /// 11.65: draw a draft scene at a frame. Built under the engine's lock from
    /// what must be read there (the assets the draft names); prepared and drawn by
    /// the returned job outside it, behind the detached gate, on the CPU reference
    /// (which draws effects, masks and clips). No revision is created and nothing
    /// on Program changes.
    fn prepare_preview(&mut self, scene: SceneDocument, frame: u64) -> Result<PreviewJob, Refusal> {
        let duration_frames = scene.timeline.duration_frames;
        if frame > duration_frames {
            return Err(Refusal::RenderFrameOutOfRange {
                take_id: TakeId(scene.id.clone()),
                revision: scene.revision.unwrap_or(Revision(0)),
                frame,
                duration_frames,
            });
        }
        let key = scene.content_hash();
        let wanted: HashSet<ContentHash> = scene
            .assets
            .iter()
            .filter_map(|asset| asset.checksum.clone())
            .collect();
        let available: HashSet<ContentHash> = self
            .assets
            .iter()
            .filter(|hash| wanted.contains(*hash))
            .cloned()
            .collect();
        let bytes: AssetBytes = self
            .asset_bytes
            .iter()
            .filter(|(hash, _)| wanted.contains(*hash))
            .map(|(hash, bytes)| (hash.clone(), bytes.clone()))
            .collect();
        let support = self.material_support();
        let gate = Arc::clone(&self.gate);
        let cache = Arc::clone(&self.preview_cache);
        Ok(Box::new(move || {
            // A preview is non-live work: it waits its turn like a headless render.
            let _slot = gate.acquire();
            let cached = {
                let mut held = cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                held.iter().position(|(hash, _)| *hash == key).map(|at| {
                    let entry = held.remove(at);
                    let prepared = Arc::clone(&entry.1);
                    held.push(entry);
                    prepared
                })
            };
            let prepared = match cached {
                Some(prepared) => prepared,
                None => {
                    let prepared =
                        Arc::new(PreparedScene::prepare(scene, &available, &bytes, &support)?);
                    let mut held = cache
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if held.len() >= PREVIEW_CACHE_ENTRIES {
                        held.remove(0);
                    }
                    held.push((key, Arc::clone(&prepared)));
                    prepared
                }
            };
            let image = crate::headless::render_png(&prepared, frame)?;
            Ok(PreviewImage {
                width: image.width,
                height: image.height,
                png: image.png.as_ref().clone(),
            })
        }))
    }

    // 5.9: the asset plane re-hashed these bytes before handing them over.
    // 5.11: held means in memory and in the store, so an entry removed from
    // the store while the engine runs is reported missing and sent again.
    fn has_verified_asset(&self, hash: &ContentHash) -> bool {
        self.asset_bytes.get(hash).is_some_and(|bytes| {
            self.asset_store
                .as_ref()
                .is_some_and(|store| store.holds_entry(hash, bytes.len() as u64))
        })
    }

    // 5.11: accepted means stored. The asset plane writes the bytes to
    // `asset_store` before this call; bytes the store does not hold are not
    // kept, so nothing is acknowledged that a restart would lose.
    fn accept_verified_asset(&mut self, hash: ContentHash, bytes: Vec<u8>) -> Result<(), Refusal> {
        let detail = match &self.asset_store {
            None => "no recovery journal is attached, so this engine keeps no asset store",
            Some(store) if !store.holds_entry(&hash, bytes.len() as u64) => {
                "the bytes were handed over before the engine's asset store held them"
            }
            Some(_) => {
                self.record_verified_asset_bytes(hash, bytes);
                return Ok(());
            }
        };
        Err(Refusal::AssetStoreFailed {
            hash,
            detail: detail.to_owned(),
        })
    }

    fn asset_store(&self) -> Option<Arc<AssetStore>> {
        self.asset_store.clone()
    }

    fn package_directory(&self) -> Option<PathBuf> {
        self.package_directory.clone()
    }

    fn fetch(&self, hash: &ContentHash) -> Option<Arc<Vec<u8>>> {
        self.rendered
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(hash)
    }
}
impl Engine {
    /// A stop request (2.19): refused by name while a scene is on Program,
    /// otherwise passed to whoever owns the process, and answered `Stopping`.
    fn stop_requested(&mut self) -> EngineReply {
        if let Some(program) = &self.program {
            return EngineReply::Refused(Refusal::StopRefusedProgramOnAir {
                take_id: program.take_id.clone(),
                revision: program.revision,
            });
        }
        let Some(signal) = &self.stop_signal else {
            return EngineReply::Refused(Refusal::NotImplemented {
                what: "this engine has no process owner to stop it: it was not started by the render worker binary".to_string(),
            });
        };
        let flushed = StopFlush::new();
        let request = StopRequest {
            correlation: gx_telemetry::corr::current(),
            flushed: flushed.clone(),
        };
        match signal.send(request) {
            Ok(()) => {
                self.stop_flush = Some(flushed);
                EngineReply::Stopping
            }
            Err(_) => EngineReply::Refused(Refusal::TransportFailed {
                detail: "the engine's process owner is gone and cannot stop it".to_string(),
            }),
        }
    }
}

impl EnginePeer for Engine {
    fn stop_reply_delivered(&mut self, delivered: bool) {
        if let Some(flush) = self.stop_flush.take() {
            flush.deliver(delivered);
        }
    }

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
        // 2.12: every request and its answer is on record. A render is
        // logged where it is answered (`handle_detached`), because the
        // control transport reaches it there without passing through here.
        let render = matches!(request, ClientRequest::Render(_));
        let note = crate::log::RequestNote::of(&request);
        let reply = self.handle_unlogged(request);
        if !render {
            crate::log::request(&note, &reply, self.clock.epoch().0);
        }
        reply
    }

    /// A headless render is validated while the engine is held and drawn
    /// after it is released: the prepared scene is shared, so Program's
    /// render loop never waits on it (invariant 14). Every other request is
    /// answered in place.
    fn handle_detached(&mut self, request: ClientRequest) -> Handled {
        let ClientRequest::Render(req) = request else {
            return Handled::Reply(self.handle(request));
        };
        // 2.12: a render and its answer are on record, refused here or drawn
        // after the engine is released.
        let note = crate::log::RequestNote::render(&req);
        let epoch = self.clock.epoch().0;
        let refused = |refusal| {
            let reply = EngineReply::Refused(refusal);
            crate::log::request(&note, &reply, epoch);
            Handled::Reply(reply)
        };
        if let Err(refusal) = self.check_not_dropped(&req.take_id) {
            return refused(refusal);
        }
        let held = self.published.get(&req.take_id).cloned();
        let scene = self
            .prepared
            .get(&(req.take_id.clone(), req.revision))
            .cloned();
        let duration = scene
            .as_ref()
            .map(|scene| scene.document().timeline.duration_frames);
        if let Err(refusal) = check_render(&req, held.as_ref(), duration) {
            return refused(refusal);
        }
        let (Some(held), Some(scene)) = (held, scene) else {
            unreachable!("check_render refuses a render with no held revision or scene");
        };
        let images = Arc::clone(&self.rendered);
        let gate = Arc::clone(&self.gate);
        Handled::Detached(Box::new(move || {
            // 3.24: a headless render waits for a slot; under load there is one.
            let _slot = gate.acquire();
            let reply = answer_render(req, held.content_hash, &scene, &images);
            crate::log::request(&note, &reply, epoch);
            reply
        }))
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        std::mem::take(&mut self.events)
    }
}

impl Engine {
    /// Answer one request; [`EnginePeer::handle`] logs it (2.12).
    fn handle_unlogged(&mut self, request: ClientRequest) -> EngineReply {
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

            // 2.20: the protocol the client says it speaks is compared with this
            // engine's. A client that does not say is served.
            ClientRequest::Capability { protocol } => {
                match protocol.map_or(Ok(()), check_protocol) {
                    Ok(()) => EngineReply::Capability(self.capability()),
                    Err(refusal) => EngineReply::Refused(refusal),
                }
            }

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
                if let Err(refusal) =
                    self.check_published(&req.take_id, req.revision, req.content_hash.as_ref())
                {
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
                if let Err(refusal) =
                    self.check_published(&req.take_id, req.revision, req.content_hash.as_ref())
                {
                    return EngineReply::Refused(refusal);
                }
                if let Err(refusal) = self.ensure_program_backend(&req.take_id, req.revision) {
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
            ClientRequest::Stop => self.stop_requested(),
            // In-process callers render in place; the control transport goes
            // through `handle_detached` and renders outside the lock.
            ClientRequest::Render(req) => self.handle_detached(ClientRequest::Render(req)).finish(),
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
}

/// An accepted stop request (2.19), as the process owner receives it.
#[derive(Debug, Clone)]
pub struct StopRequest {
    /// The correlation id the request arrived under, so the engine's own stop
    /// record can be followed back to the request and the connection that sent it.
    pub correlation: Option<String>,
    /// The control transport's word that the reply has left (2.22).
    pub flushed: StopFlush,
}

/// The control transport's word that a stop request's reply has left: written
/// and flushed to the client, or not written at all. The process owner waits on
/// it, with a limit, before it ends the process, instead of sleeping for as long
/// as a write might take (2.22).
#[derive(Debug, Clone, Default)]
pub struct StopFlush(std::sync::Arc<(std::sync::Mutex<Option<bool>>, std::sync::Condvar)>);

impl StopFlush {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the outcome: `true` when the reply was written and flushed.
    pub fn deliver(&self, delivered: bool) {
        let (slot, ready) = &*self.0;
        *slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(delivered);
        ready.notify_all();
    }

    /// The outcome, waiting at most `limit` for it. `None` when it did not come.
    pub fn wait(&self, limit: std::time::Duration) -> Option<bool> {
        let (slot, ready) = &*self.0;
        let held = slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (held, _) = ready
            .wait_timeout_while(held, limit, |outcome| outcome.is_none())
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *held
    }
}

/// How the GPU readback ring delivered Program (3.21), for the frame-timing
/// record. Latencies are submit-to-delivery wall time of each delivered
/// frame, in a bounded window; counts cover the engine's lifetime.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadbackReport {
    /// Frames delivered by the ring.
    pub delivered: u64,
    /// Frames composited but not read back because every slot was in flight.
    pub ring_full: u64,
    /// Completed frames replaced by a newer completed frame before emission.
    pub superseded: u64,
    /// Clock frames that repeated the previous picture while a newly taken
    /// scene's first readback was still in flight.
    pub awaiting_first: u64,
    /// Clock frames between a frame's submission and the emission that
    /// delivered it, most recent last (bounded).
    pub frames_behind: Vec<u64>,
    /// Submit-to-delivery latency of each delivered frame, nanoseconds,
    /// most recent last (bounded).
    pub latency_nanos: Vec<u64>,
}

impl ReadbackReport {
    const WINDOW: usize = 4096;

    fn record(&mut self, clock_frame: u64, delivered: &Delivered) {
        self.delivered += 1;
        if self.latency_nanos.len() == Self::WINDOW {
            self.latency_nanos.remove(0);
            self.frames_behind.remove(0);
        }
        self.latency_nanos
            .push(delivered.latency.as_nanos().min(u128::from(u64::MAX)) as u64);
        self.frames_behind
            .push(clock_frame.saturating_sub(delivered.tag));
    }
}

#[cfg(test)]
mod blend_tests;
#[cfg(test)]
mod effect_tests;
#[cfg(test)]
mod gpu_tests;
#[cfg(test)]
mod output_tests;
#[cfg(test)]
mod restore_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use gx_control_plane::intent::{ClearRequest, CueRequest, PhaseRequest, TakeRequest};
    use std::time::{SystemTime, UNIX_EPOCH};

    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::color::ColorValue;
    use gx_contracts::phases::{PhaseKind, TimelinePhase};
    use gx_contracts::scene::{ObjectBase, RectObject, SceneCanvas, SceneObject, SceneTimeline};
    use gx_control_plane::message::OutputConfig;

    #[test]
    fn the_asset_plane_declares_the_locality_the_capability_does() {
        // One field, two carriers (5.10).
        for locality in [Locality::CoLocated, Locality::Lan] {
            let engine = Engine::new(Arc::new(AtomicU64::new(0)), locality);
            assert_eq!(AssetPublishPeer::locality(&engine), locality);
            assert_eq!(engine.capability().locality, locality);
        }
    }

    fn engine() -> Engine {
        // A clock that does not advance on its own: the test drives the frame
        // source, so timing is deterministic.
        Engine::new(Arc::new(AtomicU64::new(0)), Locality::CoLocated)
    }

    // --- 2.27: live telemetry ---------------------------------------------------------

    fn performance_reply(e: &mut Engine) -> gx_control_plane::status::PerformanceSummary {
        match e.handle(ClientRequest::Performance) {
            EngineReply::Performance(summary) => summary,
            other => panic!("expected performance, got {other:?}"),
        }
    }

    /// The `performance` reply carries the components and findings the engine
    /// assessed, not just the frame series: an engine with no hardware GPU says
    /// so, by name, and reports the readback it does not have as not measured.
    #[test]
    fn the_performance_reply_names_a_missing_gpu_and_does_not_invent_a_readback() {
        let mut e = Engine::with_gpu(
            Arc::new(AtomicU64::new(0)),
            Locality::CoLocated,
            Gpu::without_hardware(DeviceTier::T2),
        );
        let summary = performance_reply(&mut e);
        let finding = summary
            .findings
            .iter()
            .find(|f| f.id == "gpu.no_hardware")
            .expect("a software engine reports that it has no GPU");
        assert_eq!(
            finding.severity,
            gx_control_plane::status::Severity::Critical
        );
        let readback = summary
            .components
            .iter()
            .find(|c| c.id == "readback")
            .expect("the readback component is always present");
        assert_eq!(
            readback.state,
            gx_control_plane::telemetry::ComponentState::NotMeasured
        );
        assert!(readback.series.is_empty());
        let ids: Vec<_> = summary.components.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "frame-loop",
                "gpu-adapter",
                "readback",
                "output",
                "reference",
                "load-balancer"
            ]
        );
    }

    fn on_program() -> ProgramState {
        ProgramState {
            take_id: TakeId("take/1".into()),
            revision: Revision(1),
            committed_frame: 0,
            scene_frame: 0,
            playing: true,
            phase: None,
            stop_frame: None,
        }
    }

    fn sample(frame: u64, render_ms: u64, late: bool) -> FrameSample {
        FrameSample {
            frame,
            render_nanos: render_ms * 1_000_000,
            interval_nanos: 20_000_000,
            late,
            drops_so_far: 0,
            missed_before: 0,
        }
    }

    /// 3.24: a late Program frame makes the engine shed, in the gate detached
    /// renders wait at, in what it reports and in its log; Program emptying
    /// releases it again. The same gate object the closures hold is the one set.
    #[test]
    fn a_late_program_frame_sheds_detached_work_and_says_so_everywhere() {
        let mut e = engine();
        let gate = e.non_live_gate();
        assert_eq!(gate.cap(), crate::governor::DETACHED_CAP_NORMAL);
        e.program = Some(on_program());

        let records = logged("load-shift", || {
            e.govern(&sample(1, 30, true));
        });
        assert_eq!(e.load_level(), Level::DetachedThrottled);
        assert_eq!(gate.cap(), 1, "the shared gate is throttled");
        let shift = records
            .iter()
            .find(|r| r["event"] == "load.shift")
            .expect("a shift is on record");
        assert_eq!(shift["level"], "warn");
        assert_eq!(shift["fields"]["from"], "normal");
        assert_eq!(shift["fields"]["to"], "detached-throttled");
        assert_eq!(shift["fields"]["reason"], "a Program frame was late");

        let summary = performance_reply(&mut e);
        let finding = summary
            .findings
            .iter()
            .find(|f| f.id == "load.shedding")
            .expect("telemetry reports the shedding");
        assert!(finding.what.contains("headless renders run one at a time"));
        let component = summary
            .components
            .iter()
            .find(|c| c.id == "load-balancer")
            .unwrap();
        assert_eq!(
            component.state,
            gx_control_plane::telemetry::ComponentState::Degraded
        );

        // Nothing on Program: nothing is at risk, so nothing is shed.
        e.program = None;
        let records = logged("load-release", || e.govern(&sample(2, 30, true)));
        assert_eq!(e.load_level(), Level::Normal);
        assert_eq!(gate.cap(), crate::governor::DETACHED_CAP_NORMAL);
        let released = records.iter().find(|r| r["event"] == "load.shift").unwrap();
        assert_eq!(released["level"], "info");
        assert_eq!(released["fields"]["reason"], "nothing is on Program");
    }

    /// An idle engine (no scene on Program) never sheds, however slow its frames:
    /// a debug build on a loaded machine must not throttle anyone's work.
    #[test]
    fn an_idle_engine_never_sheds_however_slow_its_frames() {
        let mut e = engine();
        for frame in 0..500 {
            e.govern(&sample(frame, 40, true));
        }
        assert_eq!(e.load_level(), Level::Normal);
        assert_eq!(
            e.non_live_gate().cap(),
            crate::governor::DETACHED_CAP_NORMAL
        );
    }

    /// 3.24: a headless render the transport runs after the engine is released
    /// waits at the gate while the throttle is on and another render holds the
    /// only slot, and is let in when that one ends: late, never lost.
    #[test]
    fn a_headless_render_waits_at_the_throttled_gate_and_is_not_lost() {
        use gx_control_plane::render::RenderRequest;
        let mut e = engine();
        let PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } = e.publish(animated_scene())
        else {
            panic!("the animated scene publishes");
        };
        let gate = e.non_live_gate();
        gate.set_level(Level::DetachedThrottled);
        let held = gate.acquire();
        let Handled::Detached(work) = e.handle_detached(ClientRequest::Render(RenderRequest {
            take_id,
            revision,
            content_hash: Some(content_hash),
            frame: 10,
        })) else {
            panic!("a render is handed back to run detached");
        };
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let runner = {
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                let reply = work();
                done.store(true, std::sync::atomic::Ordering::SeqCst);
                reply
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !done.load(std::sync::atomic::Ordering::SeqCst),
            "the render must wait while the only slot is held"
        );
        drop(held);
        assert!(matches!(runner.join().unwrap(), EngineReply::Rendered(_)));
    }

    // --- 11.65: the engine preview -----------------------------------------------------

    /// The number of pixels in a PNG that are not fully transparent.
    fn covered_pixels(png_bytes: &[u8]) -> (usize, u32, u32) {
        let mut reader = png::Decoder::new(png_bytes).read_info().unwrap();
        let mut buffer = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buffer).unwrap();
        let channels = info.color_type.samples();
        let covered = buffer[..info.buffer_size()]
            .chunks(channels)
            .filter(|pixel| pixel.last().copied().unwrap_or(0) != 0)
            .count();
        (covered, info.width, info.height)
    }

    /// A draft scene is drawn by the engine over the asset plane, the way the Editor
    /// asks: the same scene with a blur covers more pixels than without it, which
    /// is what the draft viewport cannot show. No revision is created, a second
    /// preview of the same document is served from the cache, and an out-of-range
    /// frame is refused by name.
    #[test]
    fn a_draft_with_a_blur_is_drawn_by_the_engine_over_the_asset_plane() {
        use gx_asset_plane::{preview_scene, PreviewError};
        use gx_contracts::effect::{Effect, EffectInstance, GaussianBlur};

        let engine = Arc::new(Mutex::new(engine()));
        let server = gx_asset_plane::AssetPublishServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            Arc::clone(&engine),
        )
        .unwrap();
        let address = server.local_addr().unwrap();
        let _ = server.serve_in_background();

        let plain = animated_scene();
        let mut blurred = animated_scene();
        blurred.objects[0].base_mut().effects = Some(vec![EffectInstance::new(
            "blur",
            Effect::GaussianBlur(GaussianBlur {
                blurriness: 6.0,
                ..GaussianBlur::default()
            }),
        )]);

        let plain_image = preview_scene(address, plain.clone(), 0).expect("a plain draft is drawn");
        let blurred_image =
            preview_scene(address, blurred.clone(), 0).expect("a blurred draft is drawn");
        let (plain_covered, width, height) = covered_pixels(&plain_image.png);
        let (blurred_covered, ..) = covered_pixels(&blurred_image.png);
        assert_eq!((plain_image.width, plain_image.height), (64, 32));
        assert_eq!((width, height), (64, 32));
        assert_ne!(
            plain_image.png, blurred_image.png,
            "the effect changed the picture"
        );
        assert!(
            blurred_covered > plain_covered,
            "a blur spreads the rectangle: {blurred_covered} covered, plain {plain_covered}"
        );

        {
            let held = engine.lock().unwrap();
            assert!(held.published.is_empty(), "a preview creates no revision");
            assert!(held.program.is_none(), "a preview touches nothing on air");
            assert_eq!(held.preview_cache.lock().unwrap().len(), 2);
        }
        // The same document again is served from the cache, not prepared twice.
        let again = preview_scene(address, blurred, 0).unwrap();
        assert_eq!(again.png, blurred_image.png);
        assert_eq!(
            engine.lock().unwrap().preview_cache.lock().unwrap().len(),
            2
        );

        match preview_scene(address, plain, 9_999) {
            Err(PreviewError::Refused(Refusal::RenderFrameOutOfRange {
                frame: 9_999,
                duration_frames: 100,
                ..
            })) => {}
            other => panic!("expected a named out-of-range refusal, got {other:?}"),
        }
    }

    /// 11.65: a preview is non-live work. Under load, with the throttle on and the
    /// only slot held, it waits at the same gate headless renders do and is drawn
    /// when the slot frees: late, never lost, and never competing with Program.
    #[test]
    fn a_preview_waits_at_the_throttled_gate_and_is_drawn_when_it_frees() {
        let mut e = engine();
        let gate = e.non_live_gate();
        gate.set_level(Level::DetachedThrottled);
        let held = gate.acquire();
        let job = AssetPublishPeer::prepare_preview(&mut e, animated_scene(), 0)
            .expect("the draft is accepted");
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let runner = {
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                let image = job();
                done.store(true, std::sync::atomic::Ordering::SeqCst);
                image
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !done.load(std::sync::atomic::Ordering::SeqCst),
            "the preview must wait while the only slot is held"
        );
        drop(held);
        assert!(runner.join().unwrap().is_ok());
    }

    /// The preview cache keeps only a few prepared drafts.
    #[test]
    fn the_preview_cache_is_bounded() {
        use gx_asset_plane::preview_scene;
        let engine = Arc::new(Mutex::new(engine()));
        let server = gx_asset_plane::AssetPublishServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            Arc::clone(&engine),
        )
        .unwrap();
        let address = server.local_addr().unwrap();
        let _ = server.serve_in_background();
        for n in 0..(PREVIEW_CACHE_ENTRIES + 3) {
            let mut scene = animated_scene();
            scene.name = format!("draft {n}");
            preview_scene(address, scene, 0).unwrap();
        }
        assert_eq!(
            engine.lock().unwrap().preview_cache.lock().unwrap().len(),
            PREVIEW_CACHE_ENTRIES
        );
    }

    /// The engine only claims a level something sheds at.
    #[test]
    fn the_engine_never_goes_above_the_level_it_has_wired() {
        let mut e = engine();
        e.program = Some(on_program());
        for frame in 0..500 {
            e.govern(&sample(frame, 30, true));
        }
        assert_eq!(
            e.load_level(),
            Level::DetachedThrottled,
            "only detached renders are throttled today; raise this with the next level built"
        );
    }

    // --- 2.20: the protocol a client states ------------------------------------------

    /// A client that states another protocol is refused by name, naming both; one
    /// that states this engine's is served; one that does not say is served.
    #[test]
    fn the_engine_refuses_a_client_that_states_another_protocol_by_name() {
        let mut e = engine();
        let other = gx_contracts::PROTOCOL_VERSION + 1;
        assert_eq!(
            e.handle(ClientRequest::Capability {
                protocol: Some(other)
            }),
            EngineReply::Refused(Refusal::ProtocolMismatch {
                expected: gx_contracts::PROTOCOL_VERSION,
                actual: other
            })
        );
        assert_eq!(
            e.handle(ClientRequest::Capability { protocol: Some(0) }),
            EngineReply::Refused(Refusal::ProtocolMismatch {
                expected: gx_contracts::PROTOCOL_VERSION,
                actual: 0
            })
        );
        for served in [
            ClientRequest::capability(),
            ClientRequest::Capability { protocol: None },
        ] {
            assert!(
                matches!(e.handle(served), EngineReply::Capability(_)),
                "served"
            );
        }
    }

    #[test]
    fn an_engine_without_a_material_renderer_declares_no_material_support() {
        let mut engine = engine();
        assert_eq!(engine.material_support(), MaterialSupport::none());
        assert_eq!(engine.capability().material, MaterialSupport::none());
        let EngineReply::Capability(capability) = engine.handle(ClientRequest::capability()) else {
            panic!("capability exchange must succeed")
        };
        assert_eq!(capability.material, MaterialSupport::none());
    }

    #[test]
    fn truthful_material_support_preserves_every_drawable_reference_pixel() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap();
        let scenes = std::fs::read_dir(root.join("tests/reference-scenes")).unwrap();
        let mut checked = 0;
        for entry in scenes {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let document =
                gx_contracts::scene::parse_scene_document(&std::fs::read(&path).unwrap()).unwrap();
            let mut available = HashSet::new();
            let mut bytes = AssetBytes::new();
            for asset in &document.assets {
                let payload = std::fs::read(root.join(&asset.path)).unwrap();
                let hash = gx_asset_plane::content_hash(&payload);
                assert_eq!(Some(&hash), asset.checksum.as_ref());
                available.insert(hash.clone());
                bytes.insert(hash, payload);
            }
            let before = PreparedScene::prepare(
                document.clone(),
                &available,
                &bytes,
                &MaterialSupport::fixed_function(),
            )
            .unwrap();
            let after =
                PreparedScene::prepare(document, &available, &bytes, &engine().material_support())
                    .unwrap();
            assert_eq!(
                before.frame(OutputTransform::Srgb),
                after.frame(OutputTransform::Srgb),
                "{}",
                path.display()
            );
            checked += 1;
        }
        assert!(checked > 0, "reference scenes must actually be exercised");
    }

    /// The content hash identifier publishes in these tests declare and pin.
    fn pin() -> ContentHash {
        ContentHash("a".repeat(64))
    }

    fn published(engine: &mut Engine) -> (TakeId, Revision) {
        let take_id = TakeId("take/101".into());
        let revision = Revision(1);
        engine.publish_identifier(take_id.clone(), revision, pin());
        (take_id, revision)
    }

    // --- 2.12: what the engine writes to its log --------------------------------

    /// Run `body` with this thread's events going to a fresh sink; return the
    /// lines it wrote, parsed.
    fn logged(label: &str, body: impl FnOnce()) -> Vec<serde_json::Value> {
        use tracing_subscriber::layer::SubscriberExt;
        let dir = std::env::temp_dir().join(format!(
            "gx-engine-log-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let guard =
            gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new("engine", "worker", &dir))
                .unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        tracing::subscriber::with_default(subscriber, body);
        guard.finish().unwrap();
        let mut records = Vec::new();
        for entry in std::fs::read_dir(dir.join("engine")).unwrap().flatten() {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                records.push(serde_json::from_str(line).unwrap());
            }
        }
        let _ = std::fs::remove_dir_all(dir);
        records
    }

    fn find<'a>(
        records: &'a [serde_json::Value],
        event: &str,
        result: &str,
    ) -> &'a serde_json::Value {
        records
            .iter()
            .find(|r| r["event"] == event && r["fields"]["result"] == result)
            .unwrap_or_else(|| panic!("no {event} {result} in {records:#?}"))
    }

    #[test]
    fn every_program_request_and_its_answer_is_on_record() {
        let records = logged("requests", || {
            let mut e = engine();
            let (take_id, revision) = published(&mut e);
            let _ = e.handle(ClientRequest::Take(TakeRequest {
                take_id: take_id.clone(),
                revision,
                content_hash: Some(pin()),
                at: TakeAt::NextOpportunity,
            }));
            let _ = e.handle(ClientRequest::Take(TakeRequest {
                take_id: TakeId("nope".into()),
                revision: Revision(1),
                content_hash: Some(pin()),
                at: TakeAt::NextOpportunity,
            }));
            let _ = e.handle(ClientRequest::Status);
            let _ = e.handle(ClientRequest::Clear(ClearRequest {
                at: TakeAt::NextOpportunity,
            }));
        });
        let taken = find(&records, "program.take", "committed");
        assert_eq!(taken["level"], "info");
        assert_eq!(taken["fields"]["take_id"], "take/101");
        assert_eq!(taken["fields"]["revision"], 1);
        assert_eq!(taken["fields"]["content_hash"], "a".repeat(64));
        assert!(
            taken["frame"].as_u64().is_some(),
            "the committed frame: {taken}"
        );
        assert!(taken["epoch"].as_u64().is_some());
        let refused = find(&records, "program.take", "refused");
        assert_eq!(refused["refusal"], "unknownTake");
        assert_eq!(refused["fields"]["take_id"], "nope");
        assert!(refused["fields"]["detail"]
            .as_str()
            .is_some_and(|d| d.contains("nope")));
        let cleared = find(&records, "program.clear", "committed");
        assert!(cleared["frame"].as_u64().is_some());
        // A poll is recorded at debug, so the default info filter leaves it out.
        let status = records
            .iter()
            .find(|r| r["event"] == "engine.status")
            .expect("the poll is recorded");
        assert_eq!(status["level"], "debug");
    }

    #[test]
    fn a_publish_accepted_and_refused_is_on_record() {
        let records = logged("publish", || {
            let mut e = engine();
            let _ = AssetPublishPeer::publish_scene(&mut e, animated_scene());
            // A position that is not a number cannot be drawn: refused at publish.
            let mut broken = animated_scene();
            broken.objects[0].base_mut().x = f64::NAN;
            let _ = AssetPublishPeer::publish_scene(&mut e, broken);
        });
        let accepted = records
            .iter()
            .find(|r| r["event"] == "publish.accepted")
            .unwrap_or_else(|| panic!("no publish.accepted in {records:#?}"));
        assert!(accepted["fields"]["content_hash"]
            .as_str()
            .is_some_and(|h| h.len() == 64));
        assert!(
            records.iter().any(|r| r["event"] == "publish.refused"),
            "the refused publish is on record: {records:#?}"
        );
    }

    /// 2.17: a publish that names the edits it holds writes them on its
    /// `publish.accepted`, and one that names none writes no field.
    #[test]
    fn a_publish_names_the_edits_it_carries_and_one_that_names_none_has_no_field() {
        let records = logged("publish-carries", || {
            let mut e = engine();
            {
                let _publish = gx_telemetry::corr::enter("ed-pub-3");
                let _carry =
                    gx_telemetry::corr::carry(&["ed-edit-1".to_owned(), "ed-edit-4".to_owned()], 0);
                let _ = AssetPublishPeer::publish_scene(&mut e, animated_scene());
            }
            let _ = AssetPublishPeer::publish_scene(&mut e, animated_scene());
        });
        let accepted: Vec<&serde_json::Value> = records
            .iter()
            .filter(|r| r["event"] == "publish.accepted")
            .collect();
        assert_eq!(accepted.len(), 2, "{records:#?}");
        assert_eq!(accepted[0]["corr"], "ed-pub-3");
        assert_eq!(accepted[0]["fields"]["carries"], "ed-edit-1,ed-edit-4");
        assert!(
            accepted[1]["fields"].get("carries").is_none(),
            "no edits named, no field: {}",
            accepted[1]
        );
    }

    #[test]
    fn a_late_frame_a_missed_run_and_the_heartbeat_are_on_record() {
        let records = logged("frames", || {
            let on_time = crate::metrics::FrameSample {
                frame: 10,
                render_nanos: 5_000_000,
                interval_nanos: 20_000_000,
                late: false,
                drops_so_far: 0,
                missed_before: 0,
            };
            crate::log::frame(&on_time, 3);
            crate::log::frame(
                &crate::metrics::FrameSample {
                    frame: 11,
                    render_nanos: 23_500_000,
                    late: true,
                    ..on_time
                },
                3,
            );
            crate::log::frame(
                &crate::metrics::FrameSample {
                    frame: 15,
                    missed_before: 3,
                    ..on_time
                },
                3,
            );
            let mut heartbeat = crate::log::Heartbeat::new();
            let start = std::time::Instant::now();
            let totals = || crate::log::Totals {
                epoch: 3,
                frame: 15,
                rendered: 13,
                late: 1,
                missed: 3,
                dropped: 0,
                program: Some("take/101@1".into()),
                output_inhibited: false,
                clock: "FreeRun".into(),
                reference: "None".into(),
            };
            assert!(heartbeat.beat(start, totals));
            assert!(!heartbeat.beat(start + std::time::Duration::from_millis(400), totals));
            assert!(heartbeat.beat(start + std::time::Duration::from_millis(1_050), totals));
            // The reference locks between two heartbeats: on record as a change.
            assert!(
                heartbeat.beat(start + std::time::Duration::from_millis(2_100), || {
                    crate::log::Totals {
                        reference: "Locked".into(),
                        ..totals()
                    }
                })
            );
        });
        let frames: Vec<&serde_json::Value> = records
            .iter()
            .filter(|r| r["event"].as_str().is_some_and(|e| e.starts_with("frame.")))
            .collect();
        assert_eq!(
            frames.len(),
            2,
            "an on-time frame writes nothing: {frames:#?}"
        );
        let late = frames
            .iter()
            .find(|r| r["event"] == "frame.late")
            .expect("frame.late");
        assert_eq!(
            (late["frame"].as_u64(), late["fields"]["render_us"].as_u64()),
            (Some(11), Some(23_500))
        );
        let missed = frames
            .iter()
            .find(|r| r["event"] == "frame.missed")
            .expect("frame.missed");
        assert_eq!(
            (
                missed["level"].as_str(),
                missed["fields"]["missed"].as_u64()
            ),
            (Some("warn"), Some(3))
        );
        let beats: Vec<_> = records
            .iter()
            .filter(|r| r["event"] == "engine.heartbeat")
            .collect();
        assert_eq!(beats.len(), 3, "one a second, not one a call");
        assert_eq!(beats[0]["fields"]["program"], "take/101@1");
        assert_eq!(beats[0]["fields"]["missed"], 3);
        assert_eq!(beats[0]["fields"]["clock"], "FreeRun");
        let changed: Vec<_> = records
            .iter()
            .filter(|r| r["event"] == "clock.changed")
            .collect();
        assert_eq!(
            changed.len(),
            1,
            "only the beat that saw a change: {records:#?}"
        );
        assert_eq!(
            (
                changed[0]["fields"]["from_reference"].as_str(),
                changed[0]["fields"]["to_reference"].as_str()
            ),
            (Some("None"), Some("Locked"))
        );
    }

    #[test]
    fn emitting_frames_writes_a_heartbeat() {
        // The heartbeat comes from the live frame path itself, not only from
        // a helper a test can call.
        let started = std::time::Instant::now();
        let records = logged("emit", || {
            let mut e = engine();
            for _ in 0..3 {
                let _ = e.emit_frame_settled();
            }
        });
        let beats = records
            .iter()
            .filter(|r| r["event"] == "engine.heartbeat")
            .count();
        // Three frames inside a second are one heartbeat, not one a frame.
        if started.elapsed() < crate::log::HEARTBEAT {
            assert_eq!(beats, 1, "{records:#?}");
        } else {
            assert!(
                beats >= 1,
                "the frame path wrote no heartbeat: {records:#?}"
            );
        }
    }

    /// The clock passes frames while the render loop is away: the next frame
    /// the engine emits says how many, through the frame path itself.
    #[test]
    fn frames_the_clock_passed_are_on_record_from_the_frame_path() {
        let records = logged("missed", || {
            let source = Arc::new(AtomicU64::new(0));
            let mut e = Engine::new(Arc::clone(&source), Locality::CoLocated);
            let first = e.emit_frame_settled().expect("a frame").sample.frame;
            source.fetch_add(5, Ordering::Relaxed);
            let next = e.emit_frame_settled().expect("a frame").sample;
            assert_eq!(next.frame, first + 5);
            assert_eq!(next.missed_before, 4);
        });
        let missed: Vec<_> = records
            .iter()
            .filter(|r| r["event"] == "frame.missed")
            .collect();
        assert_eq!(missed.len(), 1, "{records:#?}");
        assert_eq!(missed[0]["level"], "warn");
        assert_eq!(missed[0]["fields"]["missed"], 4);
        assert!(missed[0]["frame"].as_u64().is_some());
    }

    /// The control transport hands a headless render to the engine by
    /// `handle_detached`, and an in-process caller by `handle`: by either
    /// way a render drawn and a render refused are each on record once.
    #[test]
    fn a_headless_render_is_on_record_once_by_either_entry() {
        use gx_control_plane::render::RenderRequest;
        let records = logged("render", || {
            let mut e = engine();
            let PublishReply::Published {
                take_id,
                revision,
                content_hash,
            } = e.publish(animated_scene())
            else {
                panic!("the animated scene publishes");
            };
            let request = |frame| {
                ClientRequest::Render(RenderRequest {
                    take_id: take_id.clone(),
                    revision,
                    content_hash: Some(content_hash.clone()),
                    frame,
                })
            };
            // As the transport does: validated while held, drawn after.
            assert!(matches!(
                e.handle_detached(request(10)).finish(),
                EngineReply::Rendered(_)
            ));
            assert!(matches!(
                e.handle_detached(request(101)).finish(),
                EngineReply::Refused(Refusal::RenderFrameOutOfRange { .. })
            ));
            // As an in-process caller does.
            assert!(matches!(e.handle(request(20)), EngineReply::Rendered(_)));
            assert!(matches!(
                e.handle(request(102)),
                EngineReply::Refused(Refusal::RenderFrameOutOfRange { .. })
            ));
        });
        let renders: Vec<_> = records
            .iter()
            .filter(|r| r["event"] == "render.request")
            .collect();
        assert_eq!(renders.len(), 4, "one record a request: {records:#?}");
        let results: Vec<_> = renders
            .iter()
            .map(|r| r["fields"]["result"].as_str().unwrap())
            .collect();
        assert_eq!(results, ["rendered", "refused", "rendered", "refused"]);
        assert_eq!(renders[1]["refusal"], "renderFrameOutOfRange");
        assert_eq!(renders[0]["fields"]["take_id"], "animated");
        assert_eq!(renders[0]["fields"]["revision"], 1);
        assert!(renders.iter().all(|r| r["level"] == "info"));
    }

    pub(super) fn animated_scene() -> SceneDocument {
        let mut shape = RectObject {
            base: ObjectBase::new("card", "card"),
            radius: 0.0,
        };
        shape.base.width = 8.0;
        shape.base.height = 8.0;
        shape.base.fill = Some(ColorValue::opaque_white());
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            id: "animated".into(),
            name: "Animated".into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
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
            content_hash: Some(pin()),
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
            content_hash: Some(pin()),
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
            content_hash: Some(pin()),
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
            content_hash: Some(pin()),
            at: TakeAt::NextOpportunity,
        }));
        match reply {
            EngineReply::Taken(c) => assert!(c.frame > 500),
            other => panic!("expected Taken, got {other:?}"),
        }
    }

    // --- 2.19: a stop request ----------------------------------------------------

    /// Off air, with someone to hear it, a stop request is answered `Stopping`
    /// and the owner is told once, with the correlation id it arrived under.
    #[test]
    fn a_stop_request_off_air_is_accepted_and_passed_to_the_process_owner() {
        let mut e = engine();
        let (signal, heard) = std::sync::mpsc::channel();
        e.set_stop_signal(signal);
        let reply = {
            let _correlation = gx_telemetry::corr::enter("stop-test-7");
            e.handle(ClientRequest::Stop)
        };
        assert_eq!(reply, EngineReply::Stopping);
        let request = heard.try_recv().expect("the owner was told");
        assert_eq!(request.correlation.as_deref(), Some("stop-test-7"));
        assert!(heard.try_recv().is_err(), "told once");

        // 2.22: the transport's word that the reply left reaches the owner, once.
        assert_eq!(
            request.flushed.wait(std::time::Duration::from_millis(20)),
            None,
            "nothing has been said about the reply yet"
        );
        e.stop_reply_delivered(true);
        assert_eq!(
            request.flushed.wait(std::time::Duration::ZERO),
            Some(true),
            "the owner hears that the reply left"
        );
        e.stop_reply_delivered(false);
        assert_eq!(
            request.flushed.wait(std::time::Duration::ZERO),
            Some(true),
            "a second word is not heard: there is one reply"
        );
    }

    /// A reply the transport could not write is told as that.
    #[test]
    fn a_stop_reply_that_could_not_be_written_is_told_as_not_delivered() {
        let mut e = engine();
        let (signal, heard) = std::sync::mpsc::channel();
        e.set_stop_signal(signal);
        assert_eq!(e.handle(ClientRequest::Stop), EngineReply::Stopping);
        let request = heard.try_recv().expect("the owner was told");
        e.stop_reply_delivered(false);
        assert_eq!(request.flushed.wait(std::time::Duration::ZERO), Some(false));
    }

    /// While a scene is on Program a stop request is refused by name, names the
    /// scene, and the owner is not told: Program stays on air.
    #[test]
    fn a_stop_request_while_a_scene_is_on_program_is_refused_by_name() {
        let mut e = engine();
        let (signal, heard) = std::sync::mpsc::channel();
        e.set_stop_signal(signal);
        let (take_id, revision) = published(&mut e);
        let _ = e.handle(ClientRequest::Take(TakeRequest {
            take_id: take_id.clone(),
            revision,
            content_hash: Some(pin()),
            at: TakeAt::NextOpportunity,
        }));
        assert!(e.status().unwrap().program.is_some());
        assert_eq!(
            e.handle(ClientRequest::Stop),
            EngineReply::Refused(Refusal::StopRefusedProgramOnAir { take_id, revision })
        );
        assert!(heard.try_recv().is_err(), "a refused stop tells nobody");
        // After Program is cleared it is accepted.
        let _ = e.handle(ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
        }));
        assert!(e.status().unwrap().program.is_none());
        assert_eq!(e.handle(ClientRequest::Stop), EngineReply::Stopping);
        assert!(heard.try_recv().is_ok());
    }

    /// An engine nobody owns (a library user's) does not claim to be stopping.
    #[test]
    fn a_stop_request_with_nobody_to_stop_the_engine_is_refused() {
        let mut e = engine();
        assert!(matches!(
            e.handle(ClientRequest::Stop),
            EngineReply::Refused(Refusal::NotImplemented { .. })
        ));
    }

    /// An owner that is gone cannot stop the engine, and the client is told so.
    #[test]
    fn a_stop_request_whose_owner_is_gone_is_refused() {
        let mut e = engine();
        let (signal, heard) = std::sync::mpsc::channel();
        e.set_stop_signal(signal);
        drop(heard);
        assert!(matches!(
            e.handle(ClientRequest::Stop),
            EngineReply::Refused(Refusal::TransportFailed { .. })
        ));
    }

    #[test]
    fn a_cue_does_not_reach_program() {
        let mut e = engine();
        let (take_id, revision) = published(&mut e);
        let _ = e.handle(ClientRequest::Cue(CueRequest {
            take_id,
            revision,
            content_hash: Some(pin()),
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
        e.emit_frame_settled().expect("first frame emits");
        e.take_program().expect("Program consumer takes frame zero");

        frames.store(1, Ordering::Relaxed);
        let emission = e.emit_frame_settled().expect("second frame emits");
        assert_eq!(emission.sample.frame, 1);
        assert_eq!(e.preview_drops().consumer_busy, 1);
        assert_eq!(e.program_drops().consumer_busy, 0);
        assert_eq!(
            e.take_program()
                .expect("fresh Program remains available")
                .checksum(),
            emission.frame.checksum()
        );
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
            first.publish_identifier(take_id.clone(), Revision(1), pin());
            first
                .attach_recovery_journal(
                    RecoveryJournal::open_at(path.clone()).expect("journal opens"),
                )
                .expect("empty journal attaches");
            assert!(matches!(
                first.handle(ClientRequest::Take(TakeRequest {
                    take_id: take_id.clone(),
                    revision: Revision(1),
                    content_hash: Some(pin()),
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
        if !e.gpu.has_hardware() {
            assert!(matches!(
                e.handle(ClientRequest::Take(TakeRequest {
                    take_id: TakeId("animated".into()),
                    revision: Revision(1),
                    content_hash: Some(animated_scene().content_hash()),
                    at: TakeAt::NextOpportunity,
                })),
                EngineReply::Refused(Refusal::TierTooLow { .. })
            ));
            return;
        }
        assert!(matches!(
            e.handle(ClientRequest::Take(TakeRequest {
                take_id: TakeId("animated".into()),
                revision: Revision(1),
                content_hash: Some(animated_scene().content_hash()),
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
        let start = e.emit_frame_settled().unwrap().frame;
        frames.store(21, Ordering::Relaxed);
        let end = e.emit_frame_settled().unwrap().frame;
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
        let held_a = e.emit_frame_settled().unwrap().frame;
        frames.store(70, Ordering::Relaxed);
        let held_b = e.emit_frame_settled().unwrap().frame;
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

    /// 11.41: one request renders a pinned revision at a frame. The same
    /// request twice gives the same bytes, another frame of an animation
    /// different ones, the image is served by its hash, and Program is not
    /// touched.
    #[test]
    fn a_headless_render_is_byte_identical_served_by_hash_and_leaves_program_alone() {
        use gx_control_plane::render::RenderRequest;
        let mut e = engine();
        let PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } = e.publish(animated_scene())
        else {
            panic!("the animated scene publishes");
        };
        let request = |frame, pin: Option<ContentHash>| {
            ClientRequest::Render(RenderRequest {
                take_id: take_id.clone(),
                revision,
                content_hash: pin,
                frame,
            })
        };
        let rendered = |reply| match reply {
            EngineReply::Rendered(frame) => frame,
            other => panic!("expected a rendered frame, got {other:?}"),
        };
        let first = rendered(e.handle(request(50, Some(content_hash.clone()))));
        let again = rendered(e.handle(request(50, Some(content_hash.clone()))));
        let start = rendered(e.handle(request(0, Some(content_hash.clone()))));
        assert_eq!(
            first, again,
            "the same revision and frame render to the same bytes"
        );
        assert_ne!(
            first.image, start.image,
            "frame 50 of the animation differs from frame 0"
        );
        assert_eq!((first.width, first.height), (64, 32));
        let png = e
            .fetch(&first.image)
            .expect("the image is served by its hash");
        assert_eq!(gx_asset_plane::content_hash(&png), first.image);
        let pixels = crate::headless::decode_png(&png).expect("the image decodes");
        assert_eq!(
            pixels,
            e.prepared_scene(&take_id, revision)
                .unwrap()
                .frame_at(50, OutputTransform::Srgb)
                .unwrap()
        );
        assert!(
            e.program.is_none(),
            "a headless render never reaches Program"
        );

        assert!(matches!(
            e.handle(request(101, Some(content_hash.clone()))),
            EngineReply::Refused(Refusal::RenderFrameOutOfRange {
                frame: 101,
                duration_frames: 100,
                ..
            })
        ));
        assert!(matches!(
            e.handle(request(0, None)),
            EngineReply::Refused(Refusal::RevisionUnpinned { .. })
        ));
        let (identifier, identifier_revision) = published(&mut e);
        assert!(matches!(
            e.handle(ClientRequest::Render(RenderRequest {
                take_id: identifier,
                revision: identifier_revision,
                content_hash: Some(pin()),
                frame: 0,
            })),
            EngineReply::Refused(Refusal::RenderSceneUnavailable { .. })
        ));
    }
}
