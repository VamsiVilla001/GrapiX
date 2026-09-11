//! A valid engine peer, for Editor and Playout development (ADR-003).
//!
//! The rule this file lives under: **a mock must refuse exactly where the real
//! engine refuses.** A permissive mock is worse than no mock, because it
//! teaches callers a contract that does not exist and the lesson is only
//! unlearned during integration.
//!
//! It shares the intent-resolution rule with the real engine by calling
//! `gx_control_plane::intent::resolve_intent` rather than reimplementing it
//! (invariant 27). What it does *not* share is the clock's driving: this one
//! advances when a test says so, which is the whole point of a mock.

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use gx_asset_plane::{PublishRefusal, PublishReply, PublishRequest};
use gx_contracts::scene::SceneDocument;
use gx_contracts::{
    ClockSource, ContentHash, DeviceTier, Epoch, Locality, MediaCodec, RationalRate,
    ReferenceState, Refusal, Revision, TakeId,
};
use gx_control_plane::capability::{check_protocol, live_allowed, EngineCapability};
use gx_control_plane::intent::{resolve_intent, ClockState, Lead, TakeAt, TakeCommitted};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, OutputConfig};
use gx_control_plane::peer::{EnginePeer, FaultInjection};
use gx_control_plane::status::{Degradation, EngineStatus, ProgramState, ReferenceMonitor};

/// A mock engine. Deterministic, in-process, no GPU and no transport.
#[derive(Debug, Clone)]
pub struct MockEngine {
    epoch: Epoch,
    frame: u64,
    configured_rate: RationalRate,
    source: ClockSource,
    reference: ReferenceMonitor,
    device_tier: DeviceTier,
    locality: Locality,
    platform_certified: bool,
    lead: Lead,
    /// The latest published revision for each stable take id.
    published: HashMap<TakeId, Revision>,
    /// Immutable documents keyed by their pinned publication identity.
    documents: HashMap<(TakeId, Revision), SceneDocument>,
    /// Content hashes the asset plane says this engine has verified.
    assets: HashSet<ContentHash>,
    program: Option<ProgramState>,
    cued: Option<ProgramState>,
    events: Vec<EngineEvent>,
}

impl MockEngine {
    /// The default: co-located, T0, free-running, nothing published.
    ///
    /// Free-running rather than locked, because that is the honest default for
    /// a machine with no reference input, and a mock that pretends to be
    /// genlocked would let callers skip the free-run path entirely.
    pub fn new() -> Self {
        Self {
            epoch: Epoch(1),
            frame: 0,
            configured_rate: RationalRate::P50,
            source: ClockSource::FreeRun,
            reference: ReferenceMonitor::new(ReferenceState::NotPresent, RationalRate::P50),
            device_tier: DeviceTier::T0,
            locality: Locality::CoLocated,
            platform_certified: true,
            lead: Lead::CO_LOCATED,
            published: HashMap::new(),
            documents: HashMap::new(),
            assets: HashSet::new(),
            program: None,
            cued: None,
            events: Vec::new(),
        }
    }

    /// Pretend to be reachable over a LAN, which lengthens the lead.
    pub fn over_lan(mut self) -> Self {
        self.locality = Locality::Lan;
        self.lead = Lead::for_locality(Locality::Lan);
        self
    }

    /// Pretend to be genlocked and locked.
    pub fn genlocked(mut self, rate: RationalRate) -> Self {
        self.source = ClockSource::Genlocked;
        self.configured_rate = rate;
        self.reference = ReferenceMonitor::new(ReferenceState::Locked, rate);
        self
    }

    pub fn with_device_tier(mut self, tier: DeviceTier) -> Self {
        self.device_tier = tier;
        self
    }

    pub fn uncertified_platform(mut self) -> Self {
        self.platform_certified = false;
        self
    }

    /// Publish a scene identifier, so a take of it can succeed.
    ///
    /// This compatibility helper models a preloaded scene without a document;
    /// asset-plane publication below is what Editor uses.
    pub fn publish(&mut self, take_id: TakeId, revision: Revision) {
        self.published.insert(take_id, revision);
    }

    /// Mark bytes as verified and available to a subsequently taken scene.
    ///
    /// This is intentionally separate from publishing the document: a package
    /// can be complete as authoring data while a declared asset transfer is
    /// still outstanding, and invariant 29 makes that a take blocker.
    pub fn hold_asset(&mut self, hash: ContentHash) {
        self.assets.insert(hash);
    }

    /// Publish one complete document as a new immutable revision.
    ///
    /// The document is inserted only after all publication metadata is known,
    /// so a refusal or interrupted request cannot expose a partial revision.
    pub fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
        let take_id = TakeId(scene.id.clone());
        let revision = self
            .published
            .get(&take_id)
            .copied()
            .unwrap_or(Revision(0))
            .next();
        self.documents.insert((take_id.clone(), revision), scene);
        self.published.insert(take_id.clone(), revision);
        PublishReply::Published { take_id, revision }
    }

    /// Return the immutable document a published revision pins, if present.
    pub fn published_scene(&self, take_id: &TakeId, revision: Revision) -> Option<&SceneDocument> {
        self.documents.get(&(take_id.clone(), revision))
    }

    /// Model an engine restart: a new incarnation that lost its state.
    ///
    /// The epoch advances, Program and any cue are gone, and the frame counter
    /// starts again. This is what a client reconnect has to detect (ADR B.4),
    /// and the reason reconciliation compares epoch and not only revision: a
    /// rebuilt state can carry the same revision number it had before.
    pub fn restart(&mut self) {
        self.epoch = Epoch(self.epoch.0 + 1);
        self.frame = 0;
        self.program = None;
        self.cued = None;
        self.events.clear();
    }

    fn degradations(&self) -> Vec<Degradation> {
        let mut out = Vec::new();
        if let Some(d) = self.reference.degradation() {
            out.push(d);
        }
        if !self.device_tier.live_capable() {
            out.push(Degradation::DeviceBelowT0 {
                actual: self.device_tier,
            });
        }
        out
    }

    fn live_is_allowed(&self, accept_free_run: bool) -> bool {
        live_allowed(
            self.device_tier,
            self.reference.state(),
            self.platform_certified,
            accept_free_run,
        )
        .is_ok()
    }

    fn clock_state(&self) -> ClockState {
        ClockState {
            current_frame: self.frame,
            timebase: self.reference.effective_timebase(),
            clock: self.source,
            reference: self.reference.state(),
            epoch: self.epoch,
        }
    }

    /// Shared by cue, take and clear: resolve intent, or refuse by name.
    fn commit(&self, at: TakeAt) -> Result<TakeCommitted, Refusal> {
        resolve_intent(at, &self.clock_state(), self.lead)
    }

    /// Check a scene reference against what is published.
    fn check_published(&self, take_id: &TakeId, revision: Revision) -> Result<(), Refusal> {
        match self.published.get(take_id) {
            None => Err(Refusal::UnknownTake {
                take_id: take_id.clone(),
            }),
            Some(&published) if published != revision => Err(Refusal::RevisionMismatch {
                expected: published,
                actual: revision,
            }),
            Some(_) => self
                .published_scene(take_id, revision)
                .into_iter()
                .flat_map(|scene| scene.assets.iter())
                .filter_map(|asset| asset.checksum.as_ref())
                .find(|hash| !self.assets.contains(*hash))
                .cloned()
                .map_or(Ok(()), |hash| Err(Refusal::AssetMissing { hash })),
        }
    }

    fn configure_output(&mut self, config: &OutputConfig) -> EngineReply {
        if config.live {
            if let Err(refusal) = live_allowed(
                self.device_tier,
                self.reference.state(),
                self.platform_certified,
                config.accept_free_run,
            ) {
                return EngineReply::Refused(refusal);
            }
            // ADR-002: refuse new live configuration while degraded by a lost
            // reference, even if the conditions above pass.
            if let Err(refusal) = self.reference.check_live_configuration() {
                return EngineReply::Refused(refusal);
            }
        }
        EngineReply::OutputConfigured {
            adapter: config.adapter.clone(),
            live: config.live,
        }
    }
}

impl Default for MockEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePeer for MockEngine {
    fn capability(&self) -> EngineCapability {
        EngineCapability {
            protocol: gx_contracts::PROTOCOL_VERSION,
            epoch: self.epoch,
            locality: self.locality,
            device_tier: self.device_tier,
            clock: self.source,
            reference: self.reference.state(),
            // Without an operator's explicit free-run acceptance.
            live_allowed: self.live_is_allowed(false),
            media: match self.locality {
                Locality::CoLocated => vec![MediaCodec::RawShared, MediaCodec::Jpeg],
                Locality::Lan => vec![MediaCodec::H264, MediaCodec::Jpeg],
            },
            // A mock refuses exactly where the real engine refuses
            // (invariant 45). The real engine has no rasteriser yet, so it
            // can reproduce no blend or fit mode at all, and declaring a set
            // here would teach callers a contract that does not exist.
            material: gx_contracts::material::MaterialSupport::none(),
        }
    }

    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        match request {
            // Authentication belongs to the connection, and the transport
            // answers it before an engine ever sees it. Reaching here means
            // the transport failed to intercept, so this refuses rather than
            // approving something it has no basis to approve.
            ClientRequest::Authenticate { .. } => EngineReply::Refused(Refusal::NotImplemented {
                what: "authentication is a transport concern, not an engine one".to_string(),
            }),

            ClientRequest::Capability => {
                // A real engine checks the client's protocol on connect; the
                // mock checks its own constant so the refusal path is reachable
                // in a test rather than dead code.
                match check_protocol(gx_contracts::PROTOCOL_VERSION) {
                    Ok(()) => EngineReply::Capability(self.capability()),
                    Err(refusal) => EngineReply::Refused(refusal),
                }
            }

            ClientRequest::Status => EngineReply::Status(EngineStatus {
                epoch: self.epoch,
                current_frame: self.frame,
                timebase: self.reference.effective_timebase(),
                clock: self.source,
                reference: self.reference.state(),
                device_tier: self.device_tier,
                live_allowed: self.live_is_allowed(false),
                program: self.program.clone(),
                degradations: self.degradations(),
            }),

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
                match self.commit(req.at) {
                    Ok(committed) => {
                        self.program = Some(ProgramState {
                            take_id: req.take_id,
                            revision: req.revision,
                            committed_frame: committed.frame,
                        });
                        self.cued = None;
                        self.events.push(EngineEvent::Committed(committed));
                        EngineReply::Taken(committed)
                    }
                    Err(refusal) => EngineReply::Refused(refusal),
                }
            }

            ClientRequest::Clear(req) => match self.commit(req.at) {
                Ok(committed) => {
                    self.program = None;
                    EngineReply::Cleared(committed)
                }
                Err(refusal) => EngineReply::Refused(refusal),
            },

            ClientRequest::ConfigureOutput(config) => self.configure_output(&config),
        }
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        std::mem::take(&mut self.events)
    }
}

impl FaultInjection for MockEngine {
    fn advance(&mut self, frames: u64) {
        self.frame = self.frame.saturating_add(frames);
    }

    fn set_reference(&mut self, state: ReferenceState) {
        if let Some(transition) = self.reference.observe(state, self.frame) {
            self.events.push(EngineEvent::ReferenceChanged(transition));
        }
    }
}

/// Describes the mock for a human, without claiming it is an engine.
pub fn describe(engine: &MockEngine) -> String {
    let cap = engine.capability();
    format!(
        "mock-engine: protocol {} epoch {} {:?} {:?} clock {:?} reference {:?} live_allowed {}",
        cap.protocol,
        cap.epoch.0,
        cap.locality,
        cap.device_tier,
        cap.clock,
        cap.reference,
        cap.live_allowed
    )
}

/// A loopback asset-plane endpoint for a mock Editor.
///
/// Control continues to carry only cue/take/clear intent. This listener
/// accepts bounded JSON publish frames because scene content is restartable
/// asset-plane work, and it updates the same engine instance the control
/// listener serves.
pub struct AssetPublishServer {
    listener: TcpListener,
    engine: Arc<Mutex<MockEngine>>,
}

impl AssetPublishServer {
    pub fn bind(addr: SocketAddr, engine: Arc<Mutex<MockEngine>>) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(addr)?,
            engine,
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    pub fn serve_in_background(self) -> JoinHandle<()> {
        thread::spawn(move || {
            for stream in self.listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let engine = Arc::clone(&self.engine);
                        thread::spawn(move || {
                            let _ = handle_publish(stream, engine);
                        });
                    }
                    Err(error) => {
                        eprintln!("mock asset listener stopping: {error}");
                        return;
                    }
                }
            }
        })
    }
}

const MAX_PUBLISH_FRAME_BYTES: usize = 64 * 1024 * 1024;

fn handle_publish(mut stream: TcpStream, engine: Arc<Mutex<MockEngine>>) -> io::Result<()> {
    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix)?;
    let length = u32::from_be_bytes(prefix) as usize;
    let reply = if length > MAX_PUBLISH_FRAME_BYTES {
        PublishReply::Refused(PublishRefusal::InvalidSceneDocument {
            detail: format!(
                "publish frame is {length} bytes; maximum is {MAX_PUBLISH_FRAME_BYTES}"
            ),
        })
    } else {
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes)?;
        match serde_json::from_slice::<PublishRequest>(&bytes) {
            Ok(request) => engine
                .lock()
                .expect("mock engine mutex poisoned")
                .publish_scene(request.scene),
            Err(error) => PublishReply::Refused(PublishRefusal::InvalidSceneDocument {
                detail: error.to_string(),
            }),
        }
    };
    let bytes = serde_json::to_vec(&reply).map_err(io::Error::other)?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_control_plane::intent::{ClearRequest, CueRequest, TakeRequest};
    use gx_control_plane::status::ReferenceTransition;

    fn published_engine() -> MockEngine {
        let mut e = MockEngine::new();
        e.publish(TakeId("lower-third".into()), Revision(4));
        e
    }

    fn take(id: &str, rev: u64, at: TakeAt) -> ClientRequest {
        ClientRequest::Take(TakeRequest {
            take_id: TakeId(id.into()),
            revision: Revision(rev),
            at,
        })
    }

    #[test]
    fn capability_declares_locality_and_clock() {
        let e = MockEngine::new();
        let cap = e.capability();
        assert_eq!(cap.protocol, 3);
        assert_eq!(cap.locality, Locality::CoLocated);
        assert_eq!(cap.clock, ClockSource::FreeRun);
        assert_eq!(cap.reference, ReferenceState::NotPresent);
        assert!(
            !cap.live_allowed,
            "no reference and no operator acceptance means live is not allowed"
        );
    }

    #[test]
    fn a_lan_engine_offers_compressed_media_and_a_longer_lead() {
        let mut e = MockEngine::new().over_lan();
        assert_eq!(e.capability().media[0], MediaCodec::H264);
        e.publish(TakeId("t".into()), Revision(1));
        let reply = e.handle(take("t", 1, TakeAt::NextOpportunity));
        // Lead::LAN is 3, so the first committable frame is 3, not 1.
        assert!(matches!(reply, EngineReply::Taken(c) if c.frame == 3));
    }

    #[test]
    fn a_take_of_a_published_scene_returns_a_committed_frame() {
        let mut e = published_engine();
        let reply = e.handle(take("lower-third", 4, TakeAt::NextOpportunity));
        match reply {
            EngineReply::Taken(c) => {
                assert_eq!(c.frame, 1);
                assert_eq!(c.timebase, RationalRate::P50);
                assert_eq!(c.clock, ClockSource::FreeRun);
            }
            other => panic!("expected Taken, got {other:?}"),
        }
        let status = e.status().unwrap();
        assert_eq!(status.program.unwrap().committed_frame, 1);
    }

    #[test]
    fn an_unpublished_scene_and_a_wrong_revision_refuse_differently() {
        let mut e = published_engine();

        let unknown = e.handle(take("no-such-scene", 1, TakeAt::NextOpportunity));
        assert!(
            matches!(unknown, EngineReply::Refused(Refusal::UnknownTake { .. })),
            "got {unknown:?}"
        );

        let stale = e.handle(take("lower-third", 3, TakeAt::NextOpportunity));
        assert!(
            matches!(
                stale,
                EngineReply::Refused(Refusal::RevisionMismatch {
                    expected: Revision(4),
                    actual: Revision(3)
                })
            ),
            "got {stale:?}"
        );
    }

    #[test]
    fn a_take_at_a_past_frame_is_refused_not_fired_late() {
        let mut e = published_engine();
        e.advance(1000);
        let reply = e.handle(take("lower-third", 4, TakeAt::Frame { frame: 500 }));
        assert!(
            matches!(
                reply,
                EngineReply::Refused(Refusal::FrameNotReachable { requested: 500, .. })
            ),
            "got {reply:?}"
        );
        assert!(
            e.status().unwrap().program.is_none(),
            "a refused take must not reach Program"
        );
    }

    #[test]
    fn a_cue_does_not_reach_program() {
        let mut e = published_engine();
        let reply = e.handle(ClientRequest::Cue(CueRequest {
            take_id: TakeId("lower-third".into()),
            revision: Revision(4),
            at: TakeAt::NextOpportunity,
        }));
        assert!(matches!(reply, EngineReply::Cued(_)));
        assert!(
            e.status().unwrap().program.is_none(),
            "cue prepares; only take puts a scene on Program"
        );
    }

    #[test]
    fn clear_empties_program_at_a_committed_frame() {
        let mut e = published_engine();
        e.handle(take("lower-third", 4, TakeAt::NextOpportunity));
        assert!(e.status().unwrap().program.is_some());
        let reply = e.handle(ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
        }));
        assert!(matches!(reply, EngineReply::Cleared(_)));
        assert!(e.status().unwrap().program.is_none());
    }

    #[test]
    fn a_live_output_is_refused_below_t0() {
        let mut e = MockEngine::new()
            .genlocked(RationalRate::P50)
            .with_device_tier(DeviceTier::T2);
        let reply = e.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "decklink".into(),
            live: true,
            accept_free_run: false,
        }));
        assert!(
            matches!(reply, EngineReply::Refused(Refusal::TierTooLow { .. })),
            "got {reply:?}"
        );
    }

    #[test]
    fn a_non_live_output_is_configured_on_a_degraded_machine() {
        // The refusal is about reaching an audience, not about rendering.
        let mut e = MockEngine::new().with_device_tier(DeviceTier::T2);
        let reply = e.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "null".into(),
            live: false,
            accept_free_run: false,
        }));
        assert!(matches!(
            reply,
            EngineReply::OutputConfigured { live: false, .. }
        ));
    }

    #[test]
    fn losing_the_reference_emits_an_event_and_refuses_new_live_output() {
        let mut e = MockEngine::new().genlocked(RationalRate::P29_97);
        e.advance(300);
        e.set_reference(ReferenceState::Unlocked);

        let events = e.drain_events();
        assert!(
            matches!(
                events.as_slice(),
                [EngineEvent::ReferenceChanged(ReferenceTransition {
                    to: ReferenceState::Unlocked,
                    at_frame: 300,
                    ..
                })]
            ),
            "got {events:?}"
        );

        let status = e.status().unwrap();
        assert!(status.degradations.iter().any(|d| matches!(
            d,
            Degradation::ReferenceLost {
                was: RationalRate::P29_97
            }
        )));
        assert_eq!(
            status.timebase,
            RationalRate::P29_97,
            "cadence is held through the loss"
        );

        let reply = e.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "decklink".into(),
            live: true,
            accept_free_run: true,
        }));
        assert!(
            matches!(
                reply,
                EngineReply::Refused(Refusal::ReferenceUnlocked { .. })
            ),
            "ADR-002: no new live configuration while the reference is lost, got {reply:?}"
        );
    }

    #[test]
    fn program_survives_a_lost_reference() {
        let mut e = MockEngine::new().genlocked(RationalRate::P50);
        e.publish(TakeId("t".into()), Revision(1));
        e.handle(take("t", 1, TakeAt::NextOpportunity));
        e.set_reference(ReferenceState::Unlocked);
        assert!(
            e.status().unwrap().program.is_some(),
            "a degraded clock must not take the show off air"
        );
    }

    #[test]
    fn an_uncertified_platform_refuses_live_by_name() {
        let mut e = MockEngine::new()
            .genlocked(RationalRate::P50)
            .uncertified_platform();
        let reply = e.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "decklink".into(),
            live: true,
            accept_free_run: false,
        }));
        assert!(
            matches!(
                reply,
                EngineReply::Refused(Refusal::PlatformNotCertified { .. })
            ),
            "got {reply:?}"
        );
    }

    #[test]
    fn events_drain_once() {
        let mut e = MockEngine::new().genlocked(RationalRate::P50);
        e.set_reference(ReferenceState::Unlocked);
        assert_eq!(e.drain_events().len(), 1);
        assert!(
            e.drain_events().is_empty(),
            "a drained event does not repeat"
        );
    }
}
