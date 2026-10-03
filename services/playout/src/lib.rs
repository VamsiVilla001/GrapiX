//! Headless Playout service (build-plan phase 6).
//!
//! Playout retains immutable published revisions, sends only control-plane
//! intent, and persists its operator-owned rundown. It deliberately depends on
//! `EnginePeer` rather than renderer implementation details: Program remains
//! the engine's state, as required by invariant 3.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use gx_contracts::scene::scene_content_hash;
use gx_contracts::{ContentHash, Refusal, ReviewState, Revision, TakeId};
use gx_control_plane::capability::live_allowed;
use gx_control_plane::intent::{ClearRequest, CueRequest, TakeAt, TakeCommitted, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply, OutputConfig};
use gx_control_plane::peer::EnginePeer;
use serde::{Deserialize, Serialize};

/// One immutable scene version a take may pin.
///
/// The document is opaque here. Playout owns published scene operations, not
/// authoring or rendering, so parsing or modifying it here would violate the
/// product boundary in invariants 3 through 5.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedScene {
    pub take_id: TakeId,
    pub revision: Revision,
    pub document: serde_json::Value,
    /// The design system this revision was built against (Part G, 7.6).
    ///
    /// Carried from the package manifest so brand-pack drift is listable
    /// rather than invisible (10.5). Absent means the package predates
    /// stamping, which is a different statement from "built against no
    /// system" — hence an `Option` rather than a zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_system_version: Option<u32>,
    /// The content hash every cue and take of this revision pins (11.38,
    /// invariant 61), computed when the library receives it. Absent only in
    /// a rundown persisted before pinning existed; such an entry is refused
    /// `RevisionUnpinned` rather than sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<ContentHash>,
    /// Review state, set only by a human operator (11.38, invariant 65).
    #[serde(default)]
    pub review: ReviewState,
}

/// Immutable revisions grouped by their stable take identity.
#[derive(Debug, Default)]
pub struct PublishedLibrary {
    latest: BTreeMap<TakeId, Revision>,
    revisions: BTreeMap<(TakeId, Revision), PublishedScene>,
}

impl PublishedLibrary {
    /// Publish a new immutable revision for a scene identity.
    ///
    /// `scene_id` is intentionally the take identity, matching the asset-plane
    /// publication contract. Reusing it adds a revision instead of changing an
    /// existing one, so a rundown pin cannot drift after republish (invariant
    /// 30).
    pub fn publish(
        &mut self,
        scene_id: impl Into<String>,
        document: serde_json::Value,
        design_system_version: Option<u32>,
    ) -> PublishedScene {
        let take_id = TakeId(scene_id.into());
        let revision = self
            .latest
            .get(&take_id)
            .copied()
            .unwrap_or(Revision(0))
            .next();
        let published = PublishedScene {
            take_id: take_id.clone(),
            revision,
            content_hash: Some(scene_content_hash(&document)),
            document,
            design_system_version,
            review: ReviewState::Draft,
        };
        self.latest.insert(take_id.clone(), revision);
        self.revisions
            .insert((take_id, revision), published.clone());
        published
    }

    /// Every *latest* published revision with the version it was built
    /// against, ready for a drift report (10.5).
    ///
    /// The latest revision per identity rather than all of them: drift asks
    /// "which templates are behind", and an older revision of a template that
    /// has since been republished is not a template anyone would re-publish.
    pub fn stamped_templates(&self) -> Vec<gx_contracts::design_system::StampedTemplate> {
        self.latest
            .keys()
            .filter_map(|take_id| self.latest(take_id))
            .map(|scene| gx_contracts::design_system::StampedTemplate {
                template_id: scene.take_id.0.clone(),
                design_system_version: scene.design_system_version,
            })
            .collect()
    }

    /// Return the latest immutable revision for an identity.
    pub fn latest(&self, take_id: &TakeId) -> Option<&PublishedScene> {
        self.latest
            .get(take_id)
            .and_then(|revision| self.revisions.get(&(take_id.clone(), *revision)))
    }

    /// Return exactly the version a caller pinned.
    pub fn revision(&self, take_id: &TakeId, revision: Revision) -> Option<&PublishedScene> {
        self.revisions.get(&(take_id.clone(), revision))
    }

    /// Move a revision through review. The revision's content stays
    /// immutable; only its review state changes. This is an operator action:
    /// it is reachable from the Playout operator surface and from no agent
    /// tool (invariant 65).
    pub fn set_review(&mut self, take_id: &TakeId, revision: Revision, review: ReviewState) -> Result<&PublishedScene, Refusal> {
        let scene = self
            .revisions
            .get_mut(&(take_id.clone(), revision))
            .ok_or_else(|| Refusal::UnknownTake { take_id: take_id.clone() })?;
        scene.review = review;
        Ok(scene)
    }

    /// Every published identity with the revisions it holds, in take order.
    ///
    /// Returned as *all* revisions rather than only the latest, because an
    /// operator pins an exact one: a listing that showed only the newest
    /// would make a valid pin look unavailable.
    pub fn takes(&self) -> Vec<(TakeId, Vec<Revision>)> {
        let mut by_take: BTreeMap<TakeId, Vec<Revision>> = BTreeMap::new();
        for (take_id, revision) in self.revisions.keys() {
            by_take.entry(take_id.clone()).or_default().push(*revision);
        }
        by_take.into_iter().collect()
    }
}

/// The operator-selected conditions for one output configuration.
///
/// Device tier and reference come from the connected engine capability, never
/// from this caller. Platform certification is supplied by the adapter host,
/// whose certification evidence is the only truthful source for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputEnvironment {
    pub platform_certified: bool,
}

/// The headless Program-control surface.
///
/// The public scheduling type is [`TakeAt`]. It has no wall-clock value and
/// every successful method returns the engine's committed frame, preserving
/// invariants 8 and 9 by construction.
pub struct Playout<P> {
    peer: P,
}

impl<P> Playout<P>
where
    P: EnginePeer,
{
    pub fn new(peer: P) -> Self {
        Self { peer }
    }

    pub fn peer(&self) -> &P {
        &self.peer
    }

    pub fn peer_mut(&mut self) -> &mut P {
        &mut self.peer
    }

    /// Cue a pinned revision using engine-time intent.
    pub fn cue(&mut self, scene: &PublishedScene, at: TakeAt) -> Result<TakeCommitted, Refusal> {
        let content_hash = Some(pinned(scene)?);
        let reply = self.peer.handle(ClientRequest::Cue(CueRequest {
            take_id: scene.take_id.clone(),
            revision: scene.revision,
            content_hash,
            at,
        }));
        committed_reply(reply, "cue", |reply| match reply {
            EngineReply::Cued(committed) => Some(*committed),
            _ => None,
        })
    }

    /// Take a pinned revision using engine-time intent.
    pub fn take(&mut self, scene: &PublishedScene, at: TakeAt) -> Result<TakeCommitted, Refusal> {
        let content_hash = Some(pinned(scene)?);
        let reply = self.peer.handle(ClientRequest::Take(TakeRequest {
            take_id: scene.take_id.clone(),
            revision: scene.revision,
            content_hash,
            at,
        }));
        committed_reply(reply, "take", |reply| match reply {
            EngineReply::Taken(committed) => Some(*committed),
            _ => None,
        })
    }

    /// Clear Program using engine-time intent.
    pub fn clear(&mut self, at: TakeAt) -> Result<TakeCommitted, Refusal> {
        let reply = self.peer.handle(ClientRequest::Clear(ClearRequest { at }));
        committed_reply(reply, "clear", |reply| match reply {
            EngineReply::Cleared(committed) => Some(*committed),
            _ => None,
        })
    }

    /// Configure an output after applying the sole live-output rule.
    ///
    /// This calls `live_allowed` rather than reproducing its clauses so an
    /// output cannot become live under a service-specific interpretation
    /// (invariants 19, 20 and 27).
    pub fn configure_output(
        &mut self,
        config: OutputConfig,
        environment: OutputEnvironment,
    ) -> Result<bool, Refusal> {
        let capability = self.peer.capability();
        if config.live {
            live_allowed(
                capability.device_tier,
                capability.reference,
                environment.platform_certified,
                config.accept_free_run,
            )?;
        }
        match self.peer.handle(ClientRequest::ConfigureOutput(config)) {
            EngineReply::OutputConfigured { live, .. } => Ok(live),
            EngineReply::Refused(refusal) => Err(refusal),
            reply => Err(unexpected_reply("configure output", reply)),
        }
    }
}

/// The hash a revision pins, or the refusal for a revision that has none.
/// Playout never sends an unpinned cue or take (invariant 61).
fn pinned(scene: &PublishedScene) -> Result<ContentHash, Refusal> {
    scene.content_hash.clone().ok_or_else(|| Refusal::RevisionUnpinned {
        take_id: scene.take_id.clone(),
        revision: scene.revision,
    })
}

fn committed_reply<F>(reply: EngineReply, operation: &str, committed: F) -> Result<TakeCommitted, Refusal>
where
    F: FnOnce(&EngineReply) -> Option<TakeCommitted>,
{
    match reply {
        EngineReply::Refused(refusal) => Err(refusal),
        reply => committed(&reply).ok_or_else(|| unexpected_reply(operation, reply)),
    }
}

fn unexpected_reply(operation: &str, reply: EngineReply) -> Refusal {
    Refusal::TransportFailed {
        detail: format!("expected a committed {operation} reply, got {reply:?}"),
    }
}

/// One persisted entry in an operator rundown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RundownEntry {
    pub id: String,
    pub scene: PublishedScene,
}

/// The ordered, operator-owned sequence state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rundown {
    entries: Vec<RundownEntry>,
    cursor: usize,
}

impl Rundown {
    pub fn new(entries: Vec<RundownEntry>) -> Self {
        Self { entries, cursor: 0 }
    }

    pub fn entries(&self) -> &[RundownEntry] {
        &self.entries
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// Resolve a cursor before changing state so a malformed rundown is refused
    /// by its actual condition instead of selecting an adjacent entry.
    pub fn at(&self, cursor: usize) -> Result<&RundownEntry, Refusal> {
        self.entries
            .get(cursor)
            .ok_or(Refusal::RundownCursorOutOfRange {
                cursor,
                len: self.entries.len(),
            })
    }

    /// Resolve a persisted entry identity without treating an unknown id as a
    /// cursor position, because repair actions differ for those two failures.
    pub fn entry(&self, entry_id: &str) -> Result<&RundownEntry, Refusal> {
        self.entries
            .iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| Refusal::RundownEntryUnknown {
                entry_id: entry_id.to_owned(),
            })
    }

    pub fn current(&self) -> Result<&RundownEntry, Refusal> {
        self.at(self.cursor)
    }

    /// Select the next entry and move the cursor only after it has resolved.
    pub fn advance(&mut self) -> Result<RundownEntry, Refusal> {
        let entry = self.current()?.clone();
        self.cursor += 1;
        Ok(entry)
    }
}

/// Errors while reading or durably replacing a rundown file.
#[derive(Debug)]
pub enum RundownStoreError {
    Refused { refusal: Refusal },
    Read { path: PathBuf, source: std::io::Error },
    Decode { path: PathBuf, source: serde_json::Error },
    Encode { source: serde_json::Error },
    Write { path: PathBuf, source: gx_fs::AtomicWriteError },
}

impl fmt::Display for RundownStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused { refusal } => write!(f, "rundown sequence refused: {refusal}"),
            Self::Read { path, source } => write!(f, "cannot read rundown {}: {source}", path.display()),
            Self::Decode { path, source } => write!(f, "cannot decode rundown {}: {source}", path.display()),
            Self::Encode { source } => write!(f, "cannot encode rundown: {source}"),
            Self::Write { path, source } => write!(f, "cannot save rundown {}: {source}", path.display()),
    }
        }
}

impl std::error::Error for RundownStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused { refusal } => Some(refusal),
            Self::Read { source, .. } => Some(source),
            Self::Decode { source, .. } => Some(source),
            Self::Encode { source } => Some(source),
            Self::Write { source, .. } => Some(source),
        }
    }
}

/// Durable owner of a rundown and its sequence cursor.
#[derive(Debug)]
pub struct RundownStore {
    path: PathBuf,
    rundown: Rundown,
}

impl RundownStore {
    pub fn create(path: impl Into<PathBuf>, rundown: Rundown) -> Result<Self, RundownStoreError> {
        let store = Self {
            path: path.into(),
            rundown,
        };
        store.save()?;
        Ok(store)
    }

    pub fn load(path: impl Into<PathBuf>) -> Result<Self, RundownStoreError> {
        let path = path.into();
        let bytes = std::fs::read(&path).map_err(|source| RundownStoreError::Read {
            path: path.clone(),
            source,
        })?;
        let rundown = serde_json::from_slice(&bytes).map_err(|source| RundownStoreError::Decode {
            path: path.clone(),
            source,
        })?;
        Ok(Self { path, rundown })
    }

    pub fn rundown(&self) -> &Rundown {
        &self.rundown
    }

    /// Advance and replace the durable document before reporting success, so a
    /// restart cannot replay the entry an operator has already continued past.
    pub fn advance(&mut self) -> Result<RundownEntry, RundownStoreError> {
        let mut proposed = self.rundown.clone();
        let entry = proposed
            .advance()
            .map_err(|refusal| RundownStoreError::Refused { refusal })?;
        self.persist(&proposed)?;
        self.rundown = proposed;
        Ok(entry)
    }

    pub fn save(&self) -> Result<(), RundownStoreError> {
        self.persist(&self.rundown)
    }

    fn persist(&self, rundown: &Rundown) -> Result<(), RundownStoreError> {
        let bytes =
            serde_json::to_vec_pretty(rundown).map_err(|source| RundownStoreError::Encode { source })?;
        gx_fs::write_atomic(&self.path, &bytes).map_err(|source| RundownStoreError::Write {
            path: self.path.clone(),
            source,
        })
    }
}

/// A deferred automation condition. The only supported condition today is a
/// current rundown entry because it is deterministic and carries no wall clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrigger {
    pub name: String,
    pub entry_id: String,
}

/// Evaluate the current rundown entry against declarative automation triggers.
///
/// Execution is intentionally absent. Returning the matching refusal makes the
/// unimplemented action visible to its author rather than silently ignoring a
/// trigger that fired (invariants 17 and 18).
pub fn evaluate_automation(
    rundown: &Rundown,
    triggers: &[AutomationTrigger],
) -> Result<(), Refusal> {
    let current = rundown.current()?;
    if let Some(trigger) = triggers
        .iter()
        .find(|trigger| trigger.entry_id == current.id)
    {
        return Err(Refusal::AutomationExecutionDeferred {
            trigger: trigger.name.clone(),
            matched: current.id.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use gx_contracts::material::MaterialSupport;
    use gx_contracts::{
        ClockSource, DeviceTier, Epoch, Locality, RationalRate, ReferenceState, PROTOCOL_VERSION,
    };
    use gx_control_plane::capability::EngineCapability;
    use gx_control_plane::message::EngineEvent;
    use gx_control_plane::status::{EngineStatus, ProgramState};
    use gx_control_plane::intent::{check_reference, HeldRevision};

    #[derive(Debug)]
    struct TestPeer {
        capability: EngineCapability,
        published: BTreeMap<TakeId, HeldRevision>,
        program: Option<ProgramState>,
        requests: Vec<ClientRequest>,
    }

    impl TestPeer {
        fn new(tier: DeviceTier) -> Self {
            Self {
                capability: EngineCapability {
                    protocol: PROTOCOL_VERSION,
                    epoch: Epoch(1),
                    locality: Locality::CoLocated,
                    device_tier: tier,
                    clock: ClockSource::FreeRun,
                    reference: ReferenceState::Locked,
                    live_allowed: tier.live_capable(),
                    media: Vec::new(),
                    material: MaterialSupport::none(),
                },
                published: BTreeMap::new(),
                program: None,
                requests: Vec::new(),
            }
        }

        fn publish(&mut self, scene: &PublishedScene) {
            self.published.insert(
                scene.take_id.clone(),
                HeldRevision {
                    revision: scene.revision,
                    content_hash: scene.content_hash.clone().expect("a library revision carries its hash"),
                },
            );
        }

        fn committed() -> TakeCommitted {
            TakeCommitted {
                frame: 73,
                timebase: RationalRate::P50,
                clock: ClockSource::FreeRun,
            }
        }

        /// The shared rule, as every real peer applies it.
        fn check(&self, take_id: &TakeId, revision: Revision, pin: Option<&ContentHash>) -> Result<(), Refusal> {
            check_reference(take_id, revision, pin, self.published.get(take_id))
        }
    }

    impl EnginePeer for TestPeer {
        fn capability(&self) -> EngineCapability {
            self.capability.clone()
        }

        fn handle(&mut self, request: ClientRequest) -> EngineReply {
            self.requests.push(request.clone());
            match request {
                ClientRequest::Status => EngineReply::Status(EngineStatus {
                    epoch: Epoch(1),
                    current_frame: 72,
                    timebase: RationalRate::P50,
                    clock: ClockSource::FreeRun,
                    reference: ReferenceState::Locked,
                    device_tier: self.capability.device_tier,
                    live_allowed: self.capability.live_allowed,
                    program: self.program.clone(),
                    degradations: Vec::new(),
                }),
                ClientRequest::Cue(request) => match self.check(&request.take_id, request.revision, request.content_hash.as_ref()) {
                    Ok(()) => EngineReply::Cued(Self::committed()),
                    Err(refusal) => EngineReply::Refused(refusal),
                },
                ClientRequest::Take(request) => match self.check(&request.take_id, request.revision, request.content_hash.as_ref()) {
                    Ok(()) => {
                        let committed = Self::committed();
                        self.program = Some(ProgramState {
                            take_id: request.take_id,
                            revision: request.revision,
                            committed_frame: committed.frame,
                            scene_frame: 0,
                            playing: true,
                            phase: None,
                            stop_frame: None,
                        });
                        EngineReply::Taken(committed)
                    }
                    Err(refusal) => EngineReply::Refused(refusal),
                },
                ClientRequest::Clear(_) => {
                    self.program = None;
                    EngineReply::Cleared(Self::committed())
                }
                ClientRequest::ConfigureOutput(config) => EngineReply::OutputConfigured {
                    adapter: config.adapter,
                    live: config.live,
                },
                other => EngineReply::Refused(Refusal::TransportFailed {
                    detail: format!("test peer does not handle {other:?}"),
                }),
            }
        }

        fn drain_events(&mut self) -> Vec<EngineEvent> {
            Vec::new()
        }
    }

    fn scene(id: &str, revision: u64) -> PublishedScene {
        let document = serde_json::json!({"id": id, "revision": revision});
        PublishedScene {
            design_system_version: None,
            take_id: TakeId(id.into()),
            revision: Revision(revision),
            content_hash: Some(scene_content_hash(&document)),
            document,
            review: ReviewState::Draft,
        }
    }

    #[test]
    fn the_library_hashes_content_not_the_revision_it_assigns() {
        let mut library = PublishedLibrary::default();
        let document = serde_json::json!({"id": "lt", "name": "Lower third"});
        let first = library.publish("lt", document.clone(), None);
        let second = library.publish("lt", document, None);
        let changed = library.publish("lt", serde_json::json!({"id": "lt", "name": "Lower third 2"}), None);
        assert_eq!((first.revision, second.revision), (Revision(1), Revision(2)));
        assert_eq!(first.content_hash, second.content_hash);
        assert_ne!(first.content_hash, changed.content_hash);
        assert_eq!(first.review, ReviewState::Draft);
    }

    #[test]
    fn an_unpinned_rundown_entry_is_refused_before_anything_is_sent() {
        let mut unpinned = scene("scene/old", 1);
        unpinned.content_hash = None;
        let mut playout = Playout::new(TestPeer::new(DeviceTier::T0));
        playout.peer_mut().publish(&scene("scene/old", 1));
        assert!(matches!(
            playout.take(&unpinned, TakeAt::NextOpportunity),
            Err(Refusal::RevisionUnpinned { revision: Revision(1), .. })
        ));
        assert!(playout.peer().requests.is_empty(), "nothing unpinned reaches the engine");
    }

    #[test]
    fn review_moves_without_touching_the_revision_content() {
        let mut library = PublishedLibrary::default();
        let published = library.publish("lt", serde_json::json!({"id": "lt"}), None);
        let reviewed = library
            .set_review(&published.take_id, published.revision, ReviewState::Approved)
            .unwrap()
            .clone();
        assert_eq!(reviewed.review, ReviewState::Approved);
        assert_eq!((reviewed.document, reviewed.content_hash), (published.document, published.content_hash));
        assert!(matches!(
            library.set_review(&TakeId("missing".into()), Revision(1), ReviewState::Proposed),
            Err(Refusal::UnknownTake { .. })
        ));
    }

    fn entry(id: &str) -> RundownEntry {
        RundownEntry {
            id: id.into(),
            scene: scene(&format!("scene/{id}"), 1),
        }
    }

    #[test]
    fn republishing_preserves_take_id_and_creates_a_new_immutable_revision() {
        let mut library = PublishedLibrary::default();
        let first = library.publish("lower-third", serde_json::json!({"text": "first"}), None);
        let second = library.publish("lower-third", serde_json::json!({"text": "second"}), None);

        assert_eq!(first.take_id, second.take_id);
        assert_eq!(first.revision, Revision(1));
        assert_eq!(second.revision, Revision(2));
        assert_eq!(library.revision(&first.take_id, first.revision), Some(&first));
    }

    #[test]
    fn the_drift_report_lists_published_templates_behind_the_current_version() {
        // 10.5's done-when, over the real published library rather than a
        // hand-assembled fixture. The stamp travels from the package manifest
        // into the revision, which is what makes "which templates predate v4"
        // a query instead of an investigation.
        let mut library = PublishedLibrary::default();
        library.publish("lower-third", serde_json::Value::Null, Some(3));
        library.publish("bug", serde_json::Value::Null, Some(4));
        library.publish("astons", serde_json::Value::Null, Some(1));
        library.publish("legacy-ticker", serde_json::Value::Null, None);

        // Republishing an old template onto the current version takes it off
        // the list: drift asks what is behind *now*, and a superseded
        // revision is not something anyone would re-publish.
        library.publish("astons", serde_json::Value::Null, Some(4));

        let report = gx_contracts::design_system::drift_report(4, &library.stamped_templates());

        let behind: Vec<(&str, Option<u32>)> = report
            .behind
            .iter()
            .map(|entry| (entry.template_id.as_str(), entry.versions_behind))
            .collect();
        assert_eq!(
            behind,
            vec![("lower-third", Some(1))],
            "every template behind the current version, and how far"
        );

        // An unstamped package predates stamping. Reporting it as "behind"
        // would claim a conformance fact nobody can verify, so it is listed
        // separately.
        assert_eq!(report.unstamped.len(), 1);
        assert_eq!(report.unstamped[0].template_id, "legacy-ticker");
    }

    #[test]
    fn intent_methods_return_engine_committed_frames_without_a_wall_clock_field() {
        let published = scene("opening", 1);
        let mut peer = TestPeer::new(DeviceTier::T0);
        peer.publish(&published);
        let mut playout = Playout::new(peer);

        let cued = playout.cue(&published, TakeAt::Frame { frame: 12 }).unwrap();
        let taken = playout.take(&published, TakeAt::NextOpportunity).unwrap();
        let cleared = playout.clear(TakeAt::NextOpportunity).unwrap();

        assert_eq!([cued.frame, taken.frame, cleared.frame], [73, 73, 73]);
        assert!(matches!(
            playout.peer().requests.as_slice(),
            [
                ClientRequest::Cue(CueRequest { at: TakeAt::Frame { frame: 12 }, .. }),
                ClientRequest::Take(TakeRequest { at: TakeAt::NextOpportunity, .. }),
                ClientRequest::Clear(ClearRequest { at: TakeAt::NextOpportunity }),
            ]
        ));
        let wire = serde_json::to_string(&playout.peer().requests).unwrap();
        assert!(!wire.contains("now") && !wire.contains("wallClock"));
    }

    #[test]
    fn stale_take_refuses_and_preserves_program() {
        let stale = scene("opening", 1);
        let current = scene("opening", 2);
        let mut peer = TestPeer::new(DeviceTier::T0);
        peer.publish(&current);
        let mut playout = Playout::new(peer);
        playout.take(&current, TakeAt::NextOpportunity).unwrap();

        let refusal = playout.take(&stale, TakeAt::NextOpportunity).unwrap_err();

        assert!(matches!(
            refusal,
            Refusal::RevisionMismatch { expected: Revision(2), actual: Revision(1) }
        ));
        assert_eq!(
            playout.peer().program,
            Some(ProgramState {
                take_id: current.take_id,
                revision: current.revision,
                committed_frame: 73,
                scene_frame: 0,
                playing: true,
                phase: None,
                stop_frame: None,
            })
        );
    }

    #[test]
    fn rundown_cursor_is_written_atomically_and_survives_reload() {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "gx-playout-rundown-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rundown.json");
        let rundown = Rundown::new(vec![entry("opening"), entry("weather")]);
        let mut store = RundownStore::create(&path, rundown).unwrap();

        assert_eq!(store.advance().unwrap().id, "opening");
        drop(store);
        let reloaded = RundownStore::load(&path).unwrap();

        assert_eq!(reloaded.rundown().cursor(), 1);
        assert_eq!(reloaded.rundown().current().unwrap().id, "weather");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rundown_refuses_unknown_cursor_and_entry_by_name() {
        let rundown = Rundown::new(vec![entry("opening")]);

        assert!(matches!(
            rundown.at(4),
            Err(Refusal::RundownCursorOutOfRange { cursor: 4, len: 1 })
        ));
        assert!(matches!(
            rundown.entry("missing"),
            Err(Refusal::RundownEntryUnknown { entry_id }) if entry_id == "missing"
        ));
    }

    #[test]
    fn live_configuration_refuses_the_actual_sub_t0_tier_before_contacting_engine() {
        let mut playout = Playout::new(TestPeer::new(DeviceTier::T2));
        let refusal = playout
            .configure_output(
                OutputConfig {
                    adapter: "certified-output".into(),
                    live: true,
                    accept_free_run: false,
                },
                OutputEnvironment {
                    platform_certified: true,
                },
            )
            .unwrap_err();

        assert!(matches!(
            refusal,
            Refusal::TierTooLow { actual: DeviceTier::T2 }
        ));
        assert!(playout.peer().requests.is_empty());
    }

    #[test]
    fn matched_automation_is_refused_as_explicitly_deferred() {
        let rundown = Rundown::new(vec![entry("opening")]);
        let triggers = [AutomationTrigger {
            name: "open-sting".into(),
            entry_id: "opening".into(),
        }];

        assert!(matches!(
            evaluate_automation(&rundown, &triggers),
            Err(Refusal::AutomationExecutionDeferred { trigger, matched })
                if trigger == "open-sting" && matched == "opening"
        ));
    }
}
