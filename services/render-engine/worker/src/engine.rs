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

use gx_contracts::material::MaterialSupport;
use gx_contracts::{
    ContentHash, DeviceTier, Epoch, Locality, MediaCodec, RationalRate, Refusal, Revision, TakeId,
};
use gx_control_plane::capability::{check_protocol, live_allowed, EngineCapability};
use gx_control_plane::intent::{Lead, TakeAt, TakeCommitted};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, OutputConfig};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::status::{Degradation, EngineStatus, ProgramState};

use crate::clock::ProgramClock;
use crate::gpu::{self, Gpu};
use crate::prepared::PreparedScene;
use crate::rasterizer::{key_for_take, Frame, SoftwareRasterizer};

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
    program: Option<ProgramState>,
    cued: Option<ProgramState>,
    rasterizer: SoftwareRasterizer,
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
            program: None,
            cued: None,
            rasterizer: SoftwareRasterizer::new(),
            events: Vec::new(),
        }
    }

    /// The negotiated device tier. Read by the host to report health.
    pub fn device_tier(&self) -> DeviceTier {
        self.gpu.tier()
    }

    /// Publish a scene identifier so a take of it can succeed.
    ///
    /// This is the identifier-only path the control plane and the conformance
    /// suite use: a take names a revision, and the engine answers whether it
    /// has one. It carries no content, which is why [`Engine::publish_scene`]
    /// exists beside it — a take against an id published this way commits,
    /// and Program is the deterministic take key the software rasteriser
    /// draws, not scene content.
    pub fn publish(&mut self, take_id: TakeId, revision: Revision) {
        self.published.insert(take_id, revision);
    }

    /// Publish an authored scene, parsed strictly and prepared once (3.4).
    ///
    /// The bytes go through `parse_scene_document`, so a field this schema
    /// does not know refuses here rather than being dropped — and through the
    /// *same* function every mock uses, because a mock that accepts what the
    /// engine refuses teaches a contract that does not exist (invariant 45).
    ///
    /// Preparation happens now, not per frame (invariant 35), and every
    /// reason a scene cannot be rendered is produced now: a missing asset, an
    /// unresolvable font, a material this device cannot draw. A take can then
    /// only fail for reasons about *timing*, which is the separation ADR-002
    /// depends on.
    ///
    /// Publishing is additive and pins a revision (invariant 30): the same id
    /// published twice is two revisions, and the earlier prepared scene stays
    /// exactly as it was for anything already cued against it.
    pub fn publish_scene(&mut self, bytes: &[u8]) -> Result<(TakeId, Revision), Refusal> {
        let document = gx_contracts::scene::parse_scene_document(bytes)?;
        let take_id = TakeId(document.id.clone());
        let revision = Revision(
            self.published
                .get(&take_id)
                .map(|current| current.0 + 1)
                .unwrap_or(1),
        );
        let prepared = PreparedScene::prepare(document, &self.assets, &self.material_support())?;
        self.prepared.insert((take_id.clone(), revision), prepared);
        self.published.insert(take_id.clone(), revision);
        Ok((take_id, revision))
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

    /// What this engine can actually draw. `rasterizer_status()` is
    /// `NotImplemented`, so it declares nothing and every material refuses by
    /// name — the correct answer for a renderer that does not exist yet, and
    /// never a set inferred from a build flag (invariant 21).
    fn material_support(&self) -> MaterialSupport {
        MaterialSupport::none()
    }

    /// Render the current Program frame.
    ///
    /// The frame is a function of the committed take and the clock, produced
    /// on demand rather than cached per frame (invariant 35 cuts the other
    /// way here: the *base* is cached per take, the counter stamp is cheap).
    pub fn render_program(&mut self) -> Frame {
        self.sync_clock();
        self.rasterizer.render(self.clock.frame())
    }

    /// Pull the clock forward to the frame the pump has reached.
    ///
    /// The pump owns the passage of time; the engine observes it. This keeps
    /// ADR-002's rule that no client message can set the clock — the only
    /// writer is the pump, and it is not reachable from the control plane.
    fn sync_clock(&mut self) {
        let target = self.frame_source.load(Ordering::Relaxed);
        while self.clock.frame() < target {
            self.clock.tick();
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
        EngineReply::OutputConfigured {
            adapter: config.adapter.clone(),
            live: config.live,
        }
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
            live_allowed: self.live_is_allowed(false),
            media: match self.locality {
                Locality::CoLocated => vec![MediaCodec::RawShared, MediaCodec::Jpeg],
                Locality::Lan => vec![MediaCodec::H264, MediaCodec::Jpeg],
            },
            // What this engine can actually draw. `rasterizer_status()`
            // returns `NotImplemented`, so the honest declaration is that it
            // reproduces no blend or fit mode: every material then refuses
            // by name rather than being drawn approximately (invariants 18
            // and 21). This becomes a measured set when 3.5 and 3.7 land.
            material: gx_contracts::material::MaterialSupport::none(),
        }
    }

    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        match request {
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
                    live_allowed: self.live_is_allowed(false),
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
                            take_id: req.take_id.clone(),
                            revision: req.revision,
                            committed_frame: committed.frame,
                        });
                        self.cued = None;
                        self.rasterizer.take(key_for_take(&req.take_id));
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

#[cfg(test)]
mod tests {
    use super::*;
    use gx_control_plane::intent::{ClearRequest, CueRequest, TakeRequest};

    fn engine() -> Engine {
        // A clock that does not advance on its own: the test drives the frame
        // source, so timing is deterministic.
        Engine::new(Arc::new(AtomicU64::new(0)), Locality::CoLocated)
    }

    fn published(engine: &mut Engine) -> (TakeId, Revision) {
        let take_id = TakeId("take/101".into());
        engine.publish(take_id.clone(), Revision(1));
        (take_id, Revision(1))
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
}
