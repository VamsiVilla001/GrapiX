//! Editor-command conformance for invariant 60.
//!
//! The recording peer remains a real `MockEngine`: recording surrounds the
//! normal control and asset implementations instead of replacing their refusal
//! or Program behaviour. The suite proves that every authoring command leaves
//! both the control plane and the pinned Program revision untouched.

use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gx_asset_plane::{
    publish_scene, AssetPublishPeer, AssetPublishServer, PublishRefusal, PublishReply,
};
use gx_contracts::command::{
    witness, CreateObject, EditScene, EditorCommand, OpenScene, SceneEdit, SceneSource,
    SceneTarget, SessionKey,
};
use gx_contracts::scene::{new_scene, SceneDocument};
use gx_contracts::{Revision, TakeId};
use gx_control_plane::intent::{TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::status::ProgramState;
use gx_control_transport::{Client, Server};
use gx_editor::command::Workspace;
use gx_editor::Projects;
use gx_mock_engine::MockEngine;

use crate::{expect, Outcome, Report};

const PLANE: &str = "editor-command";
const ONAIR_TAKE: &str = "conformance/editor-command-onair";
const WITNESS_SESSION: SessionKey = SessionKey(1);

fn loopback() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

/// A real mock engine with observations at the two product boundaries.
///
/// `observe` reaches the wrapped mock directly, rather than issuing a new
/// control request, so inspecting Program after a command cannot itself make
/// the assertion about recorded control requests fail.
struct RecordingPeer {
    engine: MockEngine,
    control: Vec<ClientRequest>,
    publishes: Vec<(TakeId, Revision)>,
}

/// Everything an editor command could disturb on the engine side: the control
/// requests it reached, the revisions it published, what Program names, and
/// the immutable document that on-air revision pins (invariant 7).
#[derive(Debug, Clone, PartialEq)]
struct Observation {
    control: usize,
    publishes: usize,
    program: Option<ProgramState>,
    on_air: Option<SceneDocument>,
}

impl RecordingPeer {
    fn new() -> Self {
        Self {
            engine: MockEngine::new(),
            control: Vec::new(),
            publishes: Vec::new(),
        }
    }

    fn observe(&mut self) -> Observation {
        let program = self.engine.status().and_then(|status| status.program);
        let on_air = program.as_ref().and_then(|program| {
            self.engine
                .published_scene(&program.take_id, program.revision)
                .cloned()
        });
        Observation {
            control: self.control.len(),
            publishes: self.publishes.len(),
            program,
            on_air,
        }
    }
}

impl EnginePeer for RecordingPeer {
    fn capability(&self) -> gx_control_plane::capability::EngineCapability {
        self.engine.capability()
    }

    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        self.control.push(request.clone());
        self.engine.handle(request)
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        self.engine.drain_events()
    }
}

impl AssetPublishPeer for RecordingPeer {
    fn publish_scene(&mut self, scene: SceneDocument) -> PublishReply {
        let reply = self.engine.publish_scene(scene);
        if let PublishReply::Published {
            take_id, revision, ..
        } = &reply
        {
            self.publishes.push((take_id.clone(), *revision));
        }
        reply
    }
}

/// A unique fixture root, removed when dropped. The editor-command witness and
/// the refusal audit's command drivers own every authored file beneath it.
pub(crate) struct Scratch(PathBuf);

impl Scratch {
    pub(crate) fn create(label: &str) -> std::io::Result<Self> {
        let unique = format!(
            "gx-conformance-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is after the Unix epoch")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn observe(peer: &Arc<Mutex<RecordingPeer>>) -> Result<Observation, String> {
    peer.lock()
        .map(|mut peer| peer.observe())
        .map_err(|_| "recording peer mutex was poisoned".to_owned())
}

/// Exercise every command witness against a real loopback control and asset
/// server. Editor mutations are allowed to change only the workspace and its
/// project store; they may not request control operations, publish, or
/// replace Program.
pub fn editor_command_suite(report: &mut Report) {
    let server = match Server::bind(loopback(), None, RecordingPeer::new()) {
        Ok(server) => server,
        Err(error) => {
            report.skip_unavailable(format!("cannot bind a control plane: {error}"));
            return;
        }
    };
    let control_address = match server.local_addr() {
        Ok(address) => address,
        Err(error) => {
            report.skip_unavailable(format!("control plane has no address: {error}"));
            return;
        }
    };
    let peer = server.engine();
    let asset_server = match AssetPublishServer::bind(loopback(), Arc::clone(&peer)) {
        Ok(server) => server,
        Err(error) => {
            report.skip_unavailable(format!("cannot bind an asset plane: {error}"));
            return;
        }
    };
    let asset_address = match asset_server.local_addr() {
        Ok(address) => address,
        Err(error) => {
            report.skip_unavailable(format!("asset plane has no address: {error}"));
            return;
        }
    };
    asset_server.serve_in_background();
    server.serve_in_background();

    let mut control = match Client::connect(control_address) {
        Ok(client) => client,
        Err(error) => {
            report.skip_unavailable(format!("cannot connect to the control plane: {error}"));
            return;
        }
    };

    let fixture = new_scene(
        ONAIR_TAKE,
        "Editor command conformance on-air fixture",
        gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
    );
    let (take_id, revision, content_hash) = match publish_scene(asset_address, fixture.clone()) {
        Ok(PublishReply::Published {
            take_id,
            revision,
            content_hash,
        }) if take_id == TakeId(ONAIR_TAKE.to_owned()) && revision == Revision(1) => {
            report.record(
                PLANE,
                "baseline fixture publishes as revision 1",
                Outcome::Pass,
            );
            (take_id, revision, content_hash)
        }
        other => {
            report.record(
                PLANE,
                "baseline fixture publishes as revision 1",
                Outcome::Fail(format!("expected revision 1 publication, got {other:?}")),
            );
            return;
        }
    };
    let taken = control.handle(ClientRequest::Take(TakeRequest {
        take_id: take_id.clone(),
        revision,
        content_hash: Some(content_hash),
        at: TakeAt::NextOpportunity,
    }));
    let committed = matches!(&taken, EngineReply::Taken(_));
    report.record(
        PLANE,
        "baseline fixture is on Program before editor commands",
        expect(
            committed,
            format!("expected the baseline take to commit, got {taken:?}"),
        ),
    );
    if !committed {
        return;
    }

    let program = control.status().and_then(|status| status.program);
    let pinned = matches!(&program, Some(program) if program.take_id == take_id && program.revision == revision);
    report.record(
        PLANE,
        "baseline Program pins the fixture revision",
        expect(
            pinned,
            format!("expected Program to pin {take_id:?} revision {revision:?}, got {program:?}"),
        ),
    );
    if !pinned {
        return;
    }
    let baseline = match observe(&peer) {
        Ok(observation) => observation,
        Err(error) => {
            report.record(
                PLANE,
                "recording peer remains observable",
                Outcome::Fail(error),
            );
            return;
        }
    };
    report.record(
        PLANE,
        "baseline on-air revision pins the published fixture document",
        expect(
            baseline.program == program && baseline.on_air.as_ref() == Some(&fixture),
            format!(
                "expected the engine to pin the fixture for {program:?}, observed {baseline:?}"
            ),
        ),
    );

    let scratch = match Scratch::create("editor-commands") {
        Ok(scratch) => scratch,
        Err(error) => {
            report.record(
                PLANE,
                "editor witness root is writable",
                Outcome::Fail(format!("cannot create editor witness root: {error}")),
            );
            return;
        }
    };
    let projects = Projects::at_root(scratch.path().join("Projects"));
    let mut workspace = Workspace::new(Some(projects));
    let commands = witness::every_command(scratch.path());
    let mut command_indexes = BTreeSet::new();
    let mut edit_indexes = BTreeSet::new();

    // Assert after every command, not only at the end, so a failure names the
    // guilty variant. "Untouched" is the whole observation: any control
    // request at all (not a deny-list), any publication, any Program change.
    for (step, command) in commands.into_iter().enumerate() {
        let name = command.name();
        let command_index = witness::variant_index(&command);
        let edits = match &command {
            EditorCommand::EditScene(edit_scene) => {
                edit_scene.edits.iter().map(witness::edit_index).collect()
            }
            _ => Vec::new(),
        };
        let result = workspace.execute(command);
        let outcome = match (result, observe(&peer)) {
            (Ok(_), Ok(observed)) if observed == baseline => {
                command_indexes.insert(command_index);
                edit_indexes.extend(edits);
                Outcome::Pass
            }
            (Ok(_), Ok(observed)) => Outcome::Fail(format!(
                "step {step}: command completed but the engine changed from {baseline:?} to {observed:?}"
            )),
            (Err(error), Ok(observed)) => Outcome::Fail(format!(
                "step {step}: witness command returned {error:?}; engine observation {observed:?} (baseline {baseline:?})"
            )),
            (Ok(_), Err(error)) => {
                Outcome::Fail(format!("step {step}: command completed but {error}"))
            }
            (Err(command_error), Err(observation_error)) => Outcome::Fail(format!(
                "step {step}: command returned {command_error:?} and {observation_error}"
            )),
        };
        report.record(PLANE, name, outcome);
    }

    let expected_commands = (0..EditorCommand::NAMES.len()).collect::<BTreeSet<_>>();
    report.record(
        PLANE,
        "every EditorCommand variant executed without reaching the engine",
        expect(
            command_indexes == expected_commands,
            format!("covered variant indexes {command_indexes:?}, expected {expected_commands:?}"),
        ),
    );
    let expected_edits = (0..SceneEdit::NAMES.len()).collect::<BTreeSet<_>>();
    report.record(
        PLANE,
        "every SceneEdit variant executed without reaching the engine",
        expect(
            edit_indexes == expected_edits,
            format!("covered edit indexes {edit_indexes:?}, expected {expected_edits:?}"),
        ),
    );

    // The authoring witness deliberately contains unsupported materials.
    // A truthful mock must refuse it without changing the published state.
    let witness_target = SceneTarget::Session {
        session: WITNESS_SESSION,
    };
    let refused = publish_scene(
        asset_address,
        workspace.document(&witness_target).unwrap().into_owned(),
    );
    report.record(
        PLANE,
        "unsupported authoring content refuses publication without changing Program",
        expect(
            matches!(&refused, Ok(PublishReply::Refused(PublishRefusal::PreparationRefused {
            cause: gx_contracts::Refusal::ScenePropertyNotDrawable { property, .. }
        })) if property == "materialSlots")
                && observe(&peer).is_ok_and(|observed| observed == baseline),
            format!("expected materialSlots refusal and unchanged engine, got {refused:?}"),
        ),
    );

    // The successful-publication witness is a drawable session, also authored
    // through commands. Publishing adds one revision and leaves Program pinned.
    let session = workspace
        .execute(EditorCommand::OpenScene(OpenScene {
            source: SceneSource::New {
                id: "conformance/drawable-session".into(),
                name: "Drawable session".into(),
            },
        }))
        .expect("drawable session opens")
        .session
        .unwrap()
        .session;
    let target = SceneTarget::Session { session };
    workspace
        .execute(EditorCommand::EditScene(EditScene {
            target: target.clone(),
            module: None,
            edits: vec![SceneEdit::CreateObject(CreateObject {
                kind: "rect".into(),
                name: "Card".into(),
            })],
        }))
        .expect("drawable session authoring succeeds");
    let published = match workspace.document(&target) {
        Ok(document) => publish_scene(asset_address, document.into_owned())
            .map_err(|error| format!("could not publish the witness session: {error}")),
        Err(error) => Err(format!("could not read the witness session: {error:?}")),
    };
    let outcome = match (published, observe(&peer)) {
        (
            Ok(PublishReply::Published {
                take_id: published_take,
                revision: published_revision,
                ..
            }),
            Ok(observed),
        ) => {
            let expected = Observation {
                publishes: baseline.publishes + 1,
                ..baseline.clone()
            };
            expect(
                observed == expected,
                format!(
                    "published {published_take:?} revision {published_revision:?}; expected engine {expected:?}, observed {observed:?}"
                ),
            )
        }
        (Ok(other), Ok(observed)) => Outcome::Fail(format!(
            "expected session publication, got {other:?}; engine observation {observed:?}"
        )),
        (Err(error), Ok(observed)) => {
            Outcome::Fail(format!("{error}; engine observation {observed:?}"))
        }
        (Ok(other), Err(error)) => {
            Outcome::Fail(format!("publish reply was {other:?}, then {error}"))
        }
        (Err(publish_error), Err(observation_error)) => {
            Outcome::Fail(format!("{publish_error}; {observation_error}"))
        }
    };
    report.record(
        PLANE,
        "session publication adds exactly one revision and leaves Program pinned",
        outcome,
    );
}
