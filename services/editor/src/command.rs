//! The Editor's one command executor (build plan 11.36, invariant 60).
//!
//! **Every authoring mutation is an `EditorCommand`, and this is the only
//! place one is carried out.** The Tauri shell and the Editor MCP both parse a
//! command and hand it to [`Workspace::execute`]; neither has another write
//! path. A rule enforced here is therefore enforced for a human at the
//! keyboard and an agent over MCP alike, with no second copy to drift
//! (invariant 27).
//!
//! **A workspace owns the open scenes (11.29).** Each session carries its own
//! document, undo history and unsaved marks, so an undo in one scene can never
//! restore a document belonging to another: there is no shared stack to reach.
//! Sessions are addressed by a monotonic [`SessionKey`]; view state — the
//! selection, playhead, folds — stays in the browser, because it is not the
//! scene.
//!
//! **What reaches disk, and when.**
//! - A `Session` edit changes memory only. Saving is a separate command, and a
//!   save marks the session clean only once the write succeeded.
//! - A `Stored` edit reads, applies and writes in one step. Nothing in memory
//!   advances, so a failed write leaves no torn state behind.
//! - Every batch is atomic: [`apply_edits`] works on a copy and swaps it in
//!   only when every edit succeeded, which is also why a poisoned lock over a
//!   workspace is safe to recover.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::path::PathBuf;

use gx_contracts::animation::validate_scene_animation;
use gx_contracts::command::{
    apply_edits, CommandOutcome, EditContext, EditEffect, EditorCommand, HistoryDirection,
    SaveTarget, SceneEdit, SceneOrigin, SceneSource, SceneTarget, SessionKey, SessionView,
};
use gx_contracts::control::TakePage;
use gx_contracts::design_system::{DesignSystem, DesignSystemCommit};
use gx_contracts::scene::{new_scene, parse_scene_document, SceneDocument};
use gx_contracts::Refusal;

use crate::{EditorError, Projects};

/// The ceiling on one scene's history (workspace.ts `MAX_HISTORY`). A runaway
/// stack is a memory leak in a long session, and the oldest gesture is the
/// least likely to be undone.
pub const MAX_HISTORY: usize = 200;

/// Why a command did not complete.
///
/// A named authoring refusal and a store or filesystem failure stay distinct
/// (invariant 59): the first is a decision about the request, the second is
/// the machine failing to carry out a decision nobody made.
#[derive(Debug)]
pub enum CommandError {
    Refused(Refusal),
    Store(EditorError),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::Store(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for CommandError {}

impl From<Refusal> for CommandError {
    fn from(value: Refusal) -> Self {
        Self::Refused(value)
    }
}

impl From<EditorError> for CommandError {
    /// A store refusal (`ProjectNotFound`, `SceneIdInvalid`, …) is still a
    /// refusal; only the machine's failures become `Store`.
    fn from(value: EditorError) -> Self {
        match value {
            EditorError::Refused(refusal) => Self::Refused(refusal),
            error => Self::Store(error),
        }
    }
}

/// One open scene.
#[derive(Debug)]
struct Session {
    key: SessionKey,
    document: SceneDocument,
    /// Where saving to the project sends it. Absent for a scene that is not
    /// bound to a project, which must not pretend to be.
    origin: Option<SceneOrigin>,
    /// A file path, when the scene was opened from or saved to one.
    path: Option<String>,
    /// Whole-document snapshots. One command is one entry, so one undo
    /// reverses exactly one gesture.
    undo: VecDeque<SceneDocument>,
    redo: Vec<SceneDocument>,
    /// Edited since the last successful save, to a project or to a file. What
    /// a close refuses on.
    dirty: bool,
    /// Edited since the last save to the project origin. Always false for an
    /// unbound scene. A file save does not clear it: the project copy is still
    /// the old graphic, and publishing a stored scene reads the project copy.
    project_dirty: bool,
}

impl Session {
    fn open(key: SessionKey, document: SceneDocument, origin: Option<SceneOrigin>, path: Option<String>) -> Self {
        Self {
            key,
            document,
            origin,
            path,
            undo: VecDeque::new(),
            redo: Vec::new(),
            dirty: false,
            project_dirty: false,
        }
    }

    fn view(&self) -> SessionView {
        SessionView {
            session: self.key,
            document: self.document.clone(),
            origin: self.origin.clone(),
            path: self.path.clone(),
            undo_depth: self.undo.len() as u32,
            redo_depth: self.redo.len() as u32,
            dirty: self.dirty,
            project_dirty: self.project_dirty,
        }
    }

    /// Every edit, undo and redo lands here, so the close refusal can never
    /// miss one.
    fn mark_edited(&mut self) {
        self.dirty = true;
        if self.origin.is_some() {
            self.project_dirty = true;
        }
    }

    fn push_undo(&mut self, snapshot: SceneDocument) {
        if self.undo.len() == MAX_HISTORY {
            self.undo.pop_front();
        }
        self.undo.push_back(snapshot);
    }

    /// Record a completed edit whose before-image is `before`. A new edit
    /// forks history, so whatever could have been redone is gone.
    fn record(&mut self, before: SceneDocument) {
        self.push_undo(before);
        self.redo.clear();
        self.mark_edited();
    }
}

/// The open scenes, plus the project store when one is available.
///
/// The shell holds one for its lifetime; MCP builds a fresh one per call and
/// addresses `Stored` targets only, so a `Session` target over MCP refuses
/// `SessionUnknown`.
#[derive(Debug)]
pub struct Workspace {
    projects: Option<Projects>,
    sessions: Vec<Session>,
    next_key: u32,
}

impl Workspace {
    /// A workspace with nothing open. With no store, project commands refuse
    /// `PlatformDirectoryUnavailable` rather than the shell failing to start.
    pub fn new(projects: Option<Projects>) -> Self {
        Self {
            projects,
            sessions: Vec::new(),
            next_key: 1,
        }
    }

    /// Carry out one command.
    pub fn execute(&mut self, command: EditorCommand) -> Result<CommandOutcome, CommandError> {
        match command {
            EditorCommand::OpenScene(p) => self.open(p.source),
            EditorCommand::CloseScene(p) => self.close(p.session, p.force),
            EditorCommand::EditScene(p) => self.edit(p.target, &p.edits),
            EditorCommand::Undo(p) => self.step_history(p.session, HistoryDirection::Undo),
            EditorCommand::Redo(p) => self.step_history(p.session, HistoryDirection::Redo),
            EditorCommand::SaveScene(p) => self.save(p.session, p.to),
            EditorCommand::CreateProject(p) => self.create_project(p.project),
            EditorCommand::CreateScene(p) => self.create_scene(p.project, p.scene_id, p.name),
            EditorCommand::DuplicateScene(p) => {
                self.duplicate_scene(p.project, p.source_scene_id, p.scene_id, p.name)
            }
            EditorCommand::DeleteScene(p) => self.delete_scene(p.project, p.scene_id),
            EditorCommand::SaveTakePage(p) => self.save_take_page(p.project, p.page),
            EditorCommand::ConfirmDesignSystem(p) => self.confirm_design_system(p.project, p.commit),
        }
    }

    /// The document a target names: an open session's, or the stored copy.
    /// What publish and take-page preview read.
    pub fn document(&self, target: &SceneTarget) -> Result<Cow<'_, SceneDocument>, CommandError> {
        match target {
            SceneTarget::Session { session } => Ok(Cow::Borrowed(&self.session(*session)?.document)),
            SceneTarget::Stored { project, scene_id } => {
                Ok(Cow::Owned(self.projects()?.read_scene(project, scene_id)?))
            }
        }
    }

    /// One open session as the browser renders it.
    pub fn view(&self, session: SessionKey) -> Result<SessionView, CommandError> {
        Ok(self.session(session)?.view())
    }

    fn projects(&self) -> Result<&Projects, CommandError> {
        self.projects.as_ref().ok_or_else(|| {
            Refusal::PlatformDirectoryUnavailable {
                detail: "the Editor has no project store: the platform data directory could not be resolved".to_owned(),
            }
            .into()
        })
    }

    fn index(&self, key: SessionKey) -> Result<usize, CommandError> {
        self.sessions
            .iter()
            .position(|session| session.key == key)
            .ok_or_else(|| Refusal::SessionUnknown { session: key }.into())
    }

    fn session(&self, key: SessionKey) -> Result<&Session, CommandError> {
        Ok(&self.sessions[self.index(key)?])
    }

    fn session_mut(&mut self, key: SessionKey) -> Result<&mut Session, CommandError> {
        let index = self.index(key)?;
        Ok(&mut self.sessions[index])
    }

    /// Open a document as a new session, or reveal the one already showing
    /// it. Two sessions over one stored scene would give one graphic two
    /// divergent histories and no answer to which wins on save.
    fn open(&mut self, source: SceneSource) -> Result<CommandOutcome, CommandError> {
        let (document, origin, path) = match source {
            SceneSource::New { id, name } => (new_scene(&id, &name), None, None),
            SceneSource::File { path } => (read_scene_file(&path)?, None, Some(path)),
            SceneSource::Project { project, scene_id } => {
                let origin = SceneOrigin { project, scene_id };
                if let Some(existing) = self
                    .sessions
                    .iter()
                    .find(|session| session.origin.as_ref() == Some(&origin))
                {
                    return Ok(CommandOutcome {
                        session: Some(existing.view()),
                        effects: vec![EditEffect::SessionOpened { session: existing.key }],
                    });
                }
                let document = self.projects()?.read_scene(&origin.project, &origin.scene_id)?;
                // Parsing checks shape; publish also checks animation, and a
                // key it would refuse is refused here by name rather than
                // previewed as some other curve.
                validate_scene_animation(&document)?;
                (document, Some(origin), None)
            }
        };
        let key = SessionKey(self.next_key);
        self.next_key = self
            .next_key
            .checked_add(1)
            .expect("fewer than u32::MAX sessions are opened in one Editor run");
        let session = Session::open(key, document, origin, path);
        let view = session.view();
        self.sessions.push(session);
        Ok(CommandOutcome {
            session: Some(view),
            effects: vec![EditEffect::SessionOpened { session: key }],
        })
    }

    /// Unsaved work blocks a close by name; `force` is the explicit
    /// confirmation. Discarding an author's edits because they clicked the
    /// wrong tab is the silent loss invariant 18 forbids.
    fn close(&mut self, key: SessionKey, force: bool) -> Result<CommandOutcome, CommandError> {
        let index = self.index(key)?;
        let session = &self.sessions[index];
        if session.dirty && !force {
            return Err(Refusal::SessionHasUnsavedChanges {
                session: key,
                name: session.document.name.clone(),
            }
            .into());
        }
        self.sessions.remove(index);
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::SessionClosed { session: key }],
        })
    }

    fn edit(&mut self, target: SceneTarget, edits: &[SceneEdit]) -> Result<CommandOutcome, CommandError> {
        match target {
            SceneTarget::Session { session: key } => {
                let index = self.index(key)?;
                let origin = self.sessions[index].origin.clone();
                let design_system = self.design_system_for(origin.as_ref(), edits)?;
                let context = EditContext {
                    design_system: design_system.as_ref(),
                    origin: origin.as_ref(),
                };
                let session = &mut self.sessions[index];
                let (before, effects) = apply_edits(&mut session.document, edits, &context)?;
                // A batch that changed nothing is not a gesture: no history
                // entry, no unsaved mark.
                if session.document != before {
                    session.record(before);
                }
                Ok(CommandOutcome {
                    session: Some(session.view()),
                    effects,
                })
            }
            SceneTarget::Stored { project, scene_id } => {
                let origin = SceneOrigin { project, scene_id };
                let mut document = self.projects()?.read_scene(&origin.project, &origin.scene_id)?;
                let design_system = self.design_system_for(Some(&origin), edits)?;
                let context = EditContext {
                    design_system: design_system.as_ref(),
                    origin: Some(&origin),
                };
                let (before, mut effects) = apply_edits(&mut document, edits, &context)?;
                if document != before {
                    self.projects()?.write_scene(&origin.project, &document)?;
                    effects.push(EditEffect::Stored { origin });
                }
                Ok(CommandOutcome { session: None, effects })
            }
        }
    }

    /// The confirmed design system a batch resolves tokens against: the
    /// current version of the scene's own project, read only when the batch
    /// applies a text style. An unbound scene has none, and a token-backed
    /// style then refuses in the shared resolver rather than receiving a
    /// made-up brand pack.
    fn design_system_for(
        &self,
        origin: Option<&SceneOrigin>,
        edits: &[SceneEdit],
    ) -> Result<Option<DesignSystem>, CommandError> {
        let Some(origin) = origin else {
            return Ok(None);
        };
        if !edits.iter().any(|edit| matches!(edit, SceneEdit::ApplyTextStyle(_))) {
            return Ok(None);
        }
        let store = self.projects()?.design_system(&origin.project)?;
        match store.current_version()? {
            Some(version) => Ok(Some(store.load(version)?)),
            None => Ok(None),
        }
    }

    fn step_history(&mut self, key: SessionKey, direction: HistoryDirection) -> Result<CommandOutcome, CommandError> {
        let session = self.session_mut(key)?;
        let restored = match direction {
            HistoryDirection::Undo => session.undo.pop_back(),
            HistoryDirection::Redo => session.redo.pop(),
        }
        .ok_or(Refusal::HistoryEmpty { session: key, direction })?;
        let current = std::mem::replace(&mut session.document, restored);
        match direction {
            HistoryDirection::Undo => session.redo.push(current),
            HistoryDirection::Redo => session.push_undo(current),
        }
        session.mark_edited();
        Ok(CommandOutcome {
            session: Some(session.view()),
            effects: vec![EditEffect::None],
        })
    }

    fn save(&mut self, key: SessionKey, to: SaveTarget) -> Result<CommandOutcome, CommandError> {
        let index = self.index(key)?;
        let effect = match to {
            SaveTarget::Origin => {
                let session = &self.sessions[index];
                let origin = session
                    .origin
                    .clone()
                    .ok_or(Refusal::SessionUnbound { session: key })?;
                require_scene_name(&session.document)?;
                let projects = self.projects()?;
                // Update, never create: a bound scene whose stored copy has
                // gone is reported, not silently recreated.
                if !scene_exists(projects, &origin.project, &origin.scene_id)? {
                    return Err(Refusal::SceneNotStored {
                        project: origin.project,
                        scene_id: origin.scene_id,
                    }
                    .into());
                }
                projects.write_scene(&origin.project, &session.document)?;
                let session = &mut self.sessions[index];
                session.dirty = false;
                session.project_dirty = false;
                EditEffect::Stored { origin }
            }
            SaveTarget::Project { project } => {
                let session = &self.sessions[index];
                require_scene_name(&session.document)?;
                let projects = self.projects()?;
                let scene_id = session.document.id.clone();
                // Create, never overwrite: a scene already stored under this
                // id is another graphic, and replacing it would lose it.
                if scene_exists(projects, &project, &scene_id)? {
                    return Err(Refusal::SceneAlreadyExists { project, scene_id }.into());
                }
                projects.write_scene(&project, &session.document)?;
                let origin = SceneOrigin { project, scene_id };
                let session = &mut self.sessions[index];
                session.origin = Some(origin.clone());
                session.dirty = false;
                session.project_dirty = false;
                EditEffect::Stored { origin }
            }
            SaveTarget::File { path } => {
                write_scene_file(&path, &self.sessions[index].document)?;
                // The work is safe, so the close refusal clears; the project
                // copy, if there is one, is still stale.
                let session = &mut self.sessions[index];
                session.path = Some(path);
                session.dirty = false;
                EditEffect::None
            }
        };
        Ok(CommandOutcome {
            session: Some(self.sessions[index].view()),
            effects: vec![effect],
        })
    }

    /// Refusing an existing project rather than succeeding again is 7.1's
    /// rule: a second create that "succeeded" would tell the caller nothing
    /// about the project that was already there.
    fn create_project(&self, project: String) -> Result<CommandOutcome, CommandError> {
        let projects = self.projects()?;
        if projects.exists(&project) {
            return Err(Refusal::ProjectAlreadyExists { project }.into());
        }
        projects.create_project(&project)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::ProjectCreated { project }],
        })
    }

    fn create_scene(&self, project: String, scene_id: String, name: String) -> Result<CommandOutcome, CommandError> {
        let projects = self.projects()?;
        let document = new_scene(&scene_id, name.trim());
        require_scene_name(&document)?;
        if scene_exists(projects, &project, &scene_id)? {
            return Err(Refusal::SceneAlreadyExists { project, scene_id }.into());
        }
        projects.write_scene(&project, &document)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::Stored {
                origin: SceneOrigin { project, scene_id },
            }],
        })
    }

    /// A copy under a new id and name. The copy is unpublished: the source's
    /// revision belongs to the source, and a copy carrying it would claim a
    /// publication that never happened.
    fn duplicate_scene(
        &self,
        project: String,
        source_scene_id: String,
        scene_id: String,
        name: String,
    ) -> Result<CommandOutcome, CommandError> {
        let projects = self.projects()?;
        if !scene_exists(projects, &project, &source_scene_id)? {
            return Err(Refusal::SceneNotStored {
                project,
                scene_id: source_scene_id,
            }
            .into());
        }
        let mut duplicate = projects.read_scene(&project, &source_scene_id)?;
        duplicate.id = scene_id.clone();
        duplicate.name = name.trim().to_owned();
        duplicate.revision = None;
        require_scene_name(&duplicate)?;
        if scene_exists(projects, &project, &scene_id)? {
            return Err(Refusal::SceneAlreadyExists { project, scene_id }.into());
        }
        projects.write_scene(&project, &duplicate)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::Stored {
                origin: SceneOrigin { project, scene_id },
            }],
        })
    }

    /// Delete a stored scene.
    ///
    /// An open session bound to it with unsaved project changes blocks the
    /// delete by name, as main.ts did: deleting would destroy the only copy
    /// those changes could have been saved over. Otherwise the session stays
    /// open, unbound — the document remains, outside the project — and the
    /// outcome carries its new view.
    fn delete_scene(&mut self, project: String, scene_id: String) -> Result<CommandOutcome, CommandError> {
        let origin = SceneOrigin { project, scene_id };
        let bound = self
            .sessions
            .iter()
            .position(|session| session.origin.as_ref() == Some(&origin));
        if let Some(index) = bound {
            let session = &self.sessions[index];
            if session.project_dirty {
                return Err(Refusal::SessionHasUnsavedChanges {
                    session: session.key,
                    name: session.document.name.clone(),
                }
                .into());
            }
        }
        let projects = self.projects()?;
        if !scene_exists(projects, &origin.project, &origin.scene_id)? {
            return Err(Refusal::SceneNotStored {
                project: origin.project,
                scene_id: origin.scene_id,
            }
            .into());
        }
        projects.delete_scene(&origin.project, &origin.scene_id)?;
        let session = bound.map(|index| {
            let session = &mut self.sessions[index];
            session.origin = None;
            session.project_dirty = false;
            session.view()
        });
        Ok(CommandOutcome {
            session,
            effects: vec![EditEffect::Stored { origin }],
        })
    }

    /// Save a filled take page beside, never inside, its template: filling
    /// one must not rewrite the authored scene it references.
    fn save_take_page(&self, project: String, page: TakePage) -> Result<CommandOutcome, CommandError> {
        let projects = self.projects()?;
        if !scene_exists(projects, &project, &page.scene_id)? {
            return Err(Refusal::SceneNotStored {
                project,
                scene_id: page.scene_id,
            }
            .into());
        }
        projects.write_take_page(&project, &page)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::TakePageSaved {
                project,
                page_id: page.page_id,
            }],
        })
    }

    /// Confirm a draft as the next immutable version. `confirmed_by` is
    /// passed straight through: a confirmation invented here would satisfy
    /// the store's check while defeating its point.
    fn confirm_design_system(&self, project: String, commit: DesignSystemCommit) -> Result<CommandOutcome, CommandError> {
        let store = self.projects()?.design_system(&project)?;
        let system = store.confirm(&commit.draft, &commit.confirmed_by)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::DesignSystemConfirmed {
                project,
                version: system.version,
            }],
        })
    }
}

fn scene_exists(projects: &Projects, project: &str, scene_id: &str) -> Result<bool, CommandError> {
    Ok(projects.list_scenes(project)?.iter().any(|id| id == scene_id))
}

/// A stored scene needs a name an author can find it by.
fn require_scene_name(document: &SceneDocument) -> Result<(), CommandError> {
    if document.name.trim().is_empty() {
        return Err(Refusal::SceneNameEmpty.into());
    }
    Ok(())
}

/// Read an authored document from a file, refusing anything publish would.
///
/// Parsing goes through `parse_scene_document`, the reader the engine and
/// every mock use (invariant 45), so a document the Editor accepts is one the
/// engine also parses; the animation check is publish's own.
fn read_scene_file(path: &str) -> Result<SceneDocument, CommandError> {
    let bytes = std::fs::read(path).map_err(|source| {
        CommandError::Store(EditorError::Io {
            path: PathBuf::from(path),
            source,
        })
    })?;
    let document = parse_scene_document(&bytes)?;
    validate_scene_animation(&document)?;
    Ok(document)
}

/// Write an authored document to a file. Pretty-printed because people edit
/// and diff these; the wire form is produced fresh at publish.
fn write_scene_file(path: &str, document: &SceneDocument) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec_pretty(document).map_err(|error| CommandError::Store(EditorError::Serialize(error)))?;
    std::fs::write(path, bytes).map_err(|source| {
        CommandError::Store(EditorError::Io {
            path: PathBuf::from(path),
            source,
        })
    })
}

#[cfg(test)]
mod tests {
    //! Rust ports of 11.29's workspace(-dirty).test.ts lifecycle rules and of
    //! the shell's project/file tests, driven through `execute` exactly as
    //! the shell and MCP drive it.

    use std::collections::BTreeMap;

    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::command::{
        CloseScene, ConfirmDesignSystem, CreateObject, CreateProject, CreateScene, DeclareControl,
        DeleteScene, DuplicateScene, EditScene, OpenScene, Redo, RenameObject, SaveScene,
        SaveTakePage, SetBinding, SetSceneId, SetSceneName, Undo,
    };
    use gx_contracts::control::{ControlField, ControlFieldKind, ControlValue};
    use gx_contracts::scene::{
        AssetKind, AssetLibraryItem, ImageObject, ObjectBase, RectObject, SceneObject,
    };
    use gx_contracts::Revision;

    use super::*;

    /// A per-test directory, removed when the test ends however it ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "gx-editor-command-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("scratch directory");
            Self(path)
        }

        fn file(&self, name: &str) -> String {
            self.0.join(name).display().to_string()
        }

        fn projects(&self) -> Projects {
            Projects::at_root(self.0.join("projects"))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A workspace over a scratch store holding project `news` with one empty
    /// scene `b`.
    fn with_store(label: &str) -> (Scratch, Workspace) {
        let scratch = Scratch::new(label);
        let mut workspace = Workspace::new(Some(scratch.projects()));
        run(&mut workspace, EditorCommand::CreateProject(CreateProject { project: "news".into() }));
        run(
            &mut workspace,
            EditorCommand::CreateScene(CreateScene {
                project: "news".into(),
                scene_id: "b".into(),
                name: "B".into(),
            }),
        );
        (scratch, workspace)
    }

    fn run(workspace: &mut Workspace, command: EditorCommand) -> CommandOutcome {
        let name = command.name();
        workspace
            .execute(command)
            .unwrap_or_else(|error| panic!("{name} failed: {error}"))
    }

    fn refusal(workspace: &mut Workspace, command: EditorCommand) -> Refusal {
        match workspace.execute(command) {
            Err(CommandError::Refused(refusal)) => refusal,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn open(workspace: &mut Workspace, source: SceneSource) -> SessionKey {
        run(workspace, EditorCommand::OpenScene(OpenScene { source }))
            .session
            .expect("an open reports its session")
            .session
    }

    fn open_new(workspace: &mut Workspace, id: &str, name: &str) -> SessionKey {
        open(workspace, SceneSource::New { id: id.into(), name: name.into() })
    }

    fn open_stored(workspace: &mut Workspace, scene_id: &str) -> SessionKey {
        open(workspace, SceneSource::Project { project: "news".into(), scene_id: scene_id.into() })
    }

    fn edit(session: SessionKey, edits: Vec<SceneEdit>) -> EditorCommand {
        EditorCommand::EditScene(EditScene { target: SceneTarget::Session { session }, edits })
    }

    fn stored_edit(scene_id: &str, edits: Vec<SceneEdit>) -> EditorCommand {
        EditorCommand::EditScene(EditScene {
            target: SceneTarget::Stored { project: "news".into(), scene_id: scene_id.into() },
            edits,
        })
    }

    fn rename_scene(name: &str) -> SceneEdit {
        SceneEdit::SetSceneName(SetSceneName { name: name.into() })
    }

    fn undo(session: SessionKey) -> EditorCommand {
        EditorCommand::Undo(Undo { session })
    }

    fn redo(session: SessionKey) -> EditorCommand {
        EditorCommand::Redo(Redo { session })
    }

    fn close(session: SessionKey, force: bool) -> EditorCommand {
        EditorCommand::CloseScene(CloseScene { session, force })
    }

    fn save(session: SessionKey, to: SaveTarget) -> EditorCommand {
        EditorCommand::SaveScene(SaveScene { session, to })
    }

    fn name_of(workspace: &Workspace, session: SessionKey) -> String {
        workspace.view(session).expect("the session is open").document.name
    }

    fn stored_scene(workspace: &Workspace, scene_id: &str) -> SceneDocument {
        workspace
            .document(&SceneTarget::Stored { project: "news".into(), scene_id: scene_id.into() })
            .expect("the stored scene reads")
            .into_owned()
    }

    fn card_scene(id: &str) -> SceneDocument {
        let mut scene = new_scene(id, id);
        scene.timeline.duration_frames = 100;
        scene.objects.push(SceneObject::Rect(RectObject {
            base: ObjectBase::new("card", "Card"),
            radius: 0.0,
        }));
        scene
    }

    // --- sessions (workspace.test.ts) -------------------------------------

    #[test]
    fn session_keys_are_monotonic_from_one_and_never_reused() {
        let mut workspace = Workspace::new(None);
        let keys = [
            open_new(&mut workspace, "a", "A"),
            open_new(&mut workspace, "b", "B"),
            open_new(&mut workspace, "c", "C"),
        ];
        assert_eq!(keys, [SessionKey(1), SessionKey(2), SessionKey(3)]);
        run(&mut workspace, close(SessionKey(3), false));
        assert_eq!(open_new(&mut workspace, "d", "D"), SessionKey(4));
    }

    #[test]
    fn each_scene_has_its_own_undo_history() {
        let mut workspace = Workspace::new(None);
        let a = open_new(&mut workspace, "a", "a");
        let b = open_new(&mut workspace, "b", "b");
        run(&mut workspace, edit(a, vec![rename_scene("A edited")]));
        run(&mut workspace, edit(b, vec![rename_scene("B edited")]));
        run(&mut workspace, edit(b, vec![rename_scene("B edited twice")]));

        // Undoing in B must not reach A, and reverses exactly one gesture.
        run(&mut workspace, undo(b));
        assert_eq!(name_of(&workspace, b), "B edited");
        assert_eq!(name_of(&workspace, a), "A edited");

        run(&mut workspace, undo(a));
        assert_eq!(name_of(&workspace, a), "a");
        assert_eq!(name_of(&workspace, b), "B edited", "B is untouched by A's undo");

        run(&mut workspace, redo(a));
        assert_eq!(name_of(&workspace, a), "A edited");
    }

    #[test]
    fn an_edit_in_one_scene_cannot_alter_another() {
        let mut workspace = Workspace::new(None);
        let a = open_new(&mut workspace, "a", "a");
        let b = open_new(&mut workspace, "b", "b");
        let before = workspace.view(b).unwrap();
        run(&mut workspace, edit(a, vec![rename_scene("changed")]));
        assert_eq!(workspace.view(b).unwrap(), before, "document, history and marks all unchanged");
    }

    #[test]
    fn undo_and_redo_with_no_history_refuse_by_direction_and_change_nothing() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        let before = workspace.view(session).unwrap();
        assert!(matches!(
            refusal(&mut workspace, undo(session)),
            Refusal::HistoryEmpty { session: key, direction: HistoryDirection::Undo } if key == session
        ));
        assert!(matches!(
            refusal(&mut workspace, redo(session)),
            Refusal::HistoryEmpty { direction: HistoryDirection::Redo, .. }
        ));
        assert_eq!(workspace.view(session).unwrap(), before);
    }

    #[test]
    fn one_scenes_history_is_bounded_without_bounding_the_workspace() {
        let mut workspace = Workspace::new(None);
        let busy = open_new(&mut workspace, "a", "a");
        let quiet = open_new(&mut workspace, "b", "b");
        for index in 0..MAX_HISTORY + 50 {
            run(&mut workspace, edit(busy, vec![rename_scene(&format!("edit {index}"))]));
        }
        run(&mut workspace, edit(quiet, vec![rename_scene("one")]));
        assert_eq!(workspace.view(busy).unwrap().undo_depth, MAX_HISTORY as u32);
        assert_eq!(workspace.view(quiet).unwrap().undo_depth, 1);

        for _ in 0..MAX_HISTORY {
            run(&mut workspace, undo(busy));
        }
        // The oldest 50 gestures fell off; the oldest kept before-image is
        // the document after edit 49.
        assert_eq!(name_of(&workspace, busy), "edit 49");
        assert!(matches!(refusal(&mut workspace, undo(busy)), Refusal::HistoryEmpty { .. }));
    }

    #[test]
    fn a_new_edit_clears_redo() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(&mut workspace, edit(session, vec![rename_scene("one")]));
        run(&mut workspace, undo(session));
        assert_eq!(workspace.view(session).unwrap().redo_depth, 1);
        run(&mut workspace, edit(session, vec![rename_scene("two")]));
        assert_eq!(workspace.view(session).unwrap().redo_depth, 0);
        assert!(matches!(
            refusal(&mut workspace, redo(session)),
            Refusal::HistoryEmpty { direction: HistoryDirection::Redo, .. }
        ));
    }

    #[test]
    fn a_batch_that_changes_nothing_records_no_history_and_no_unsaved_mark() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "Same");
        run(&mut workspace, edit(session, vec![rename_scene("Same")]));
        let view = workspace.view(session).unwrap();
        assert_eq!((view.undo_depth, view.dirty), (0, false));
    }

    #[test]
    fn a_refused_batch_leaves_the_session_and_its_history_unchanged() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        let before = workspace.view(session).unwrap();
        let refused = refusal(
            &mut workspace,
            edit(
                session,
                vec![
                    SceneEdit::CreateObject(CreateObject { kind: "rect".into(), name: "Bar".into() }),
                    SceneEdit::RenameObject(RenameObject { object_id: "missing".into(), name: "Nope".into() }),
                ],
            ),
        );
        assert!(matches!(refused, Refusal::SceneObjectUnknown { .. }));
        assert_eq!(workspace.view(session).unwrap(), before, "the created rect did not land either");
    }

    // --- opening and closing ----------------------------------------------

    #[test]
    fn opening_a_stored_scene_twice_reveals_the_existing_session() {
        let (_scratch, mut workspace) = with_store("dedupe");
        let first = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(first, vec![rename_scene("B edited")]));
        open_new(&mut workspace, "other", "Other");

        let again = open_stored(&mut workspace, "b");
        assert_eq!(again, first);
        assert_eq!(workspace.sessions.len(), 2);
        assert_eq!(name_of(&workspace, again), "B edited", "the open edits were not replaced by the stored copy");
    }

    #[test]
    fn closing_a_scene_with_unsaved_changes_is_refused_by_name_until_forced_or_saved() {
        let scratch = Scratch::new("close");
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "lower-third", "Lower third");
        run(&mut workspace, edit(session, vec![rename_scene("Lower third v2")]));

        match refusal(&mut workspace, close(session, false)) {
            Refusal::SessionHasUnsavedChanges { session: key, name } => {
                assert_eq!((key, name.as_str()), (session, "Lower third v2"));
            }
            other => panic!("expected SessionHasUnsavedChanges, got {other:?}"),
        }
        assert!(workspace.view(session).is_ok(), "the refused close kept the scene open");

        // Saving clears the block.
        run(&mut workspace, save(session, SaveTarget::File { path: scratch.file("lower-third.json") }));
        run(&mut workspace, close(session, false));

        // So does explicit confirmation.
        let other = open_new(&mut workspace, "other", "Other");
        run(&mut workspace, edit(other, vec![rename_scene("Other v2")]));
        run(&mut workspace, close(other, true));
        assert!(matches!(
            workspace.view(other),
            Err(CommandError::Refused(Refusal::SessionUnknown { .. }))
        ));
        assert!(matches!(refusal(&mut workspace, close(other, true)), Refusal::SessionUnknown { .. }));
    }

    #[test]
    fn a_session_target_that_is_not_open_is_refused() {
        // The MCP case: a fresh workspace has no sessions.
        let mut workspace = Workspace::new(None);
        assert!(matches!(
            refusal(&mut workspace, edit(SessionKey(7), vec![rename_scene("x")])),
            Refusal::SessionUnknown { session: SessionKey(7) }
        ));
        assert!(matches!(
            workspace.document(&SceneTarget::Session { session: SessionKey(7) }),
            Err(CommandError::Refused(Refusal::SessionUnknown { .. }))
        ));
    }

    // --- unsaved marks (workspace-dirty.test.ts) ---------------------------

    #[test]
    fn an_edit_marks_project_unsaved_only_for_a_bound_scene() {
        let (_scratch, mut workspace) = with_store("marks");
        let unbound = open_new(&mut workspace, "a", "A");
        let bound = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(unbound, vec![rename_scene("A edited")]));
        run(&mut workspace, edit(bound, vec![rename_scene("B edited")]));
        let (unbound, bound) = (workspace.view(unbound).unwrap(), workspace.view(bound).unwrap());
        assert_eq!((unbound.dirty, unbound.project_dirty), (true, false));
        assert_eq!((bound.dirty, bound.project_dirty), (true, true));
    }

    #[test]
    fn undo_and_redo_are_edits_for_the_unsaved_mark() {
        let scratch = Scratch::new("undo-dirty");
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(&mut workspace, edit(session, vec![rename_scene("edited")]));
        run(&mut workspace, save(session, SaveTarget::File { path: scratch.file("a.json") }));
        run(&mut workspace, undo(session));
        assert!(workspace.view(session).unwrap().dirty, "an undo after a save is unsaved work");
        assert!(matches!(refusal(&mut workspace, close(session, false)), Refusal::SessionHasUnsavedChanges { .. }));
    }

    #[test]
    fn saving_to_a_file_clears_the_unsaved_mark_and_leaves_the_project_copy_stale() {
        let (scratch, mut workspace) = with_store("file-save");
        let bound = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(bound, vec![rename_scene("B edited")]));
        let path = scratch.file("b.json");
        let view = run(&mut workspace, save(bound, SaveTarget::File { path: path.clone() }))
            .session
            .expect("a save reports its session");
        assert_eq!(view.path.as_deref(), Some(path.as_str()));
        assert_eq!((view.dirty, view.project_dirty), (false, true));
        // The project still holds the old graphic.
        assert_eq!(stored_scene(&workspace, "b").name, "B");
    }

    #[test]
    fn saving_to_the_project_clears_both_marks_and_binds_the_origin() {
        let (_scratch, mut workspace) = with_store("project-save");
        let session = open_new(&mut workspace, "untitled", "Untitled");
        run(&mut workspace, edit(session, vec![rename_scene("Strap")]));
        assert!(matches!(
            refusal(&mut workspace, save(session, SaveTarget::Origin)),
            Refusal::SessionUnbound { session: key } if key == session
        ));

        let outcome = run(&mut workspace, save(session, SaveTarget::Project { project: "news".into() }));
        let view = outcome.session.expect("a save reports its session");
        let origin = SceneOrigin { project: "news".into(), scene_id: "untitled".into() };
        assert_eq!(view.origin.as_ref(), Some(&origin));
        assert_eq!((view.dirty, view.project_dirty), (false, false));
        assert_eq!(outcome.effects, vec![EditEffect::Stored { origin }]);
        assert_eq!(stored_scene(&workspace, "untitled").name, "Strap");

        // Create never overwrites; a bound scene's id is stable.
        assert!(matches!(
            refusal(&mut workspace, save(session, SaveTarget::Project { project: "news".into() })),
            Refusal::SceneAlreadyExists { .. }
        ));
        assert!(matches!(
            refusal(&mut workspace, edit(session, vec![SceneEdit::SetSceneId(SetSceneId { id: "renamed".into() })])),
            Refusal::SceneIdBound { .. }
        ));

        // Update writes the bound copy.
        run(&mut workspace, edit(session, vec![rename_scene("Strap v2")]));
        run(&mut workspace, save(session, SaveTarget::Origin));
        assert_eq!(stored_scene(&workspace, "untitled").name, "Strap v2");
        assert!(!workspace.view(session).unwrap().project_dirty);
    }

    #[test]
    fn saving_a_bound_scene_whose_stored_copy_is_gone_refuses_rather_than_recreating_it() {
        let (scratch, mut workspace) = with_store("gone");
        let session = open_stored(&mut workspace, "b");
        // Deleted behind the workspace's back, as another process might.
        scratch.projects().delete_scene("news", "b").unwrap();
        assert!(matches!(
            refusal(&mut workspace, save(session, SaveTarget::Origin)),
            Refusal::SceneNotStored { .. }
        ));
        assert!(scratch.projects().list_scenes("news").unwrap().is_empty());
    }

    // --- files (shell load/save) -------------------------------------------

    #[test]
    fn a_scene_round_trips_through_a_file_and_the_shared_reader() {
        let scratch = Scratch::new("file-round-trip");
        let mut workspace = Workspace::new(None);
        let authored = open_new(&mut workspace, "demo", "Demo");
        let path = scratch.file("scene.json");
        run(&mut workspace, save(authored, SaveTarget::File { path: path.clone() }));
        let reopened = open(&mut workspace, SceneSource::File { path: path.clone() });
        let view = workspace.view(reopened).unwrap();
        assert_eq!(view.document, workspace.view(authored).unwrap().document);
        assert_eq!(view.path.as_deref(), Some(path.as_str()));
        assert_eq!(view.origin, None);
    }

    #[test]
    fn a_file_with_an_unknown_field_refuses_by_name_rather_than_opening() {
        let scratch = Scratch::new("unknown-field");
        let path = scratch.file("scene.json");
        let mut document = serde_json::to_value(new_scene("demo", "Demo")).unwrap();
        document["notAField"] = serde_json::json!(true);
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();

        let mut workspace = Workspace::new(None);
        let refused = refusal(&mut workspace, EditorCommand::OpenScene(OpenScene { source: SceneSource::File { path } }));
        assert!(refused.to_string().contains("notAField"), "the refusal names the field: {refused}");
        assert!(workspace.sessions.is_empty());
    }

    #[test]
    fn a_custom_bezier_key_with_no_points_refuses_at_open_as_it_does_at_publish() {
        let scratch = Scratch::new("bezier");
        let path = scratch.file("scene.json");
        let mut scene = card_scene("demo");
        scene.timeline.channels.push(KeyframeChannel {
            object_id: "card".into(),
            property: "x".into(),
            keys: vec![
                SceneKeyframe { frame: 0, value: 0.0, easing: SceneEasing::CustomBezier, bezier: None },
                SceneKeyframe { frame: 50, value: 100.0, easing: SceneEasing::Linear, bezier: None },
            ],
        });
        std::fs::write(&path, serde_json::to_vec(&scene).unwrap()).unwrap();

        let mut workspace = Workspace::new(None);
        let refused = refusal(&mut workspace, EditorCommand::OpenScene(OpenScene { source: SceneSource::File { path } }));
        let text = refused.to_string();
        assert!(text.contains("card") && text.contains("custom-bezier"), "names the object and easing: {text}");
    }

    #[test]
    fn an_unreadable_file_is_a_store_failure_not_a_refusal() {
        let scratch = Scratch::new("unreadable");
        let mut workspace = Workspace::new(None);
        let error = workspace
            .execute(EditorCommand::OpenScene(OpenScene { source: SceneSource::File { path: scratch.file("absent.json") } }))
            .expect_err("a missing file cannot open");
        assert!(matches!(error, CommandError::Store(EditorError::Io { .. })), "{error:?}");
    }

    // --- projects and scenes (shell project tests) --------------------------

    #[test]
    fn project_and_scene_commands_refuse_duplicates_and_paths_by_name() {
        let (_scratch, mut workspace) = with_store("crud");
        assert!(matches!(
            refusal(&mut workspace, EditorCommand::CreateProject(CreateProject { project: "news".into() })),
            Refusal::ProjectAlreadyExists { project } if project == "news"
        ));
        assert!(matches!(
            refusal(&mut workspace, EditorCommand::CreateProject(CreateProject { project: "../escape".into() })),
            Refusal::ProjectNameInvalid { .. }
        ));
        let create = |scene_id: &str, name: &str| {
            EditorCommand::CreateScene(CreateScene {
                project: "news".into(),
                scene_id: scene_id.into(),
                name: name.into(),
            })
        };
        assert!(matches!(refusal(&mut workspace, create("b", "Again")), Refusal::SceneAlreadyExists { .. }));
        assert!(matches!(refusal(&mut workspace, create("../escape", "Escape")), Refusal::SceneIdInvalid { .. }));
        assert!(matches!(refusal(&mut workspace, create("c", "   ")), Refusal::SceneNameEmpty));
        assert!(matches!(
            refusal(
                &mut workspace,
                EditorCommand::CreateScene(CreateScene { project: "nope".into(), scene_id: "c".into(), name: "C".into() })
            ),
            Refusal::ProjectNotFound { .. }
        ));

        let delete = || EditorCommand::DeleteScene(DeleteScene { project: "news".into(), scene_id: "b".into() });
        run(&mut workspace, delete());
        assert!(matches!(refusal(&mut workspace, delete()), Refusal::SceneNotStored { .. }));
    }

    #[test]
    fn project_commands_without_a_store_refuse_by_name() {
        let mut workspace = Workspace::new(None);
        assert!(matches!(
            refusal(&mut workspace, EditorCommand::CreateProject(CreateProject { project: "news".into() })),
            Refusal::PlatformDirectoryUnavailable { .. }
        ));
    }

    #[test]
    fn a_duplicate_is_an_unpublished_copy_under_a_new_id() {
        let (scratch, mut workspace) = with_store("duplicate");
        let mut published = card_scene("lower-third");
        published.revision = Some(Revision(3));
        scratch.projects().write_scene("news", &published).unwrap();

        let duplicate = |scene_id: &str| {
            EditorCommand::DuplicateScene(DuplicateScene {
                project: "news".into(),
                source_scene_id: "lower-third".into(),
                scene_id: scene_id.into(),
                name: "  Lower third copy ".into(),
            })
        };
        run(&mut workspace, duplicate("lower-third-copy"));
        let copy = stored_scene(&workspace, "lower-third-copy");
        assert_eq!((copy.id.as_str(), copy.name.as_str(), copy.revision), ("lower-third-copy", "Lower third copy", None));
        assert_eq!(copy.objects, published.objects);
        assert_eq!(stored_scene(&workspace, "lower-third"), published, "the source is untouched");

        assert!(matches!(refusal(&mut workspace, duplicate("b")), Refusal::SceneAlreadyExists { .. }));
        assert!(matches!(
            refusal(
                &mut workspace,
                EditorCommand::DuplicateScene(DuplicateScene {
                    project: "news".into(),
                    source_scene_id: "absent".into(),
                    scene_id: "x".into(),
                    name: "X".into(),
                })
            ),
            Refusal::SceneNotStored { .. }
        ));
    }

    #[test]
    fn deleting_a_scene_open_with_unsaved_project_changes_is_refused_then_unbinds_it() {
        let (scratch, mut workspace) = with_store("delete-open");
        let session = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(session, vec![rename_scene("B edited")]));
        let delete = || EditorCommand::DeleteScene(DeleteScene { project: "news".into(), scene_id: "b".into() });
        assert!(matches!(
            refusal(&mut workspace, delete()),
            Refusal::SessionHasUnsavedChanges { session: key, .. } if key == session
        ));
        assert_eq!(scratch.projects().list_scenes("news").unwrap(), vec!["b"]);

        run(&mut workspace, save(session, SaveTarget::Origin));
        let outcome = run(&mut workspace, delete());
        let view = outcome.session.expect("the bound session is reported");
        assert_eq!((view.session, view.origin, view.project_dirty), (session, None, false));
        assert_eq!(view.document.name, "B edited", "the document remains open outside the project");
        assert!(scratch.projects().list_scenes("news").unwrap().is_empty());
    }

    #[test]
    fn a_stored_edit_writes_the_store_atomically_and_opens_nothing() {
        let (_scratch, mut workspace) = with_store("stored-edit");
        let outcome = run(&mut workspace, stored_edit("b", vec![rename_scene("B via MCP")]));
        assert_eq!(outcome.session, None);
        assert!(outcome.effects.contains(&EditEffect::Stored {
            origin: SceneOrigin { project: "news".into(), scene_id: "b".into() }
        }));
        assert_eq!(stored_scene(&workspace, "b").name, "B via MCP");
        assert!(workspace.sessions.is_empty());

        let refused = refusal(
            &mut workspace,
            stored_edit(
                "b",
                vec![
                    rename_scene("never lands"),
                    SceneEdit::RenameObject(RenameObject { object_id: "missing".into(), name: "x".into() }),
                ],
            ),
        );
        assert!(matches!(refused, Refusal::SceneObjectUnknown { .. }));
        assert_eq!(stored_scene(&workspace, "b").name, "B via MCP");
        assert!(matches!(
            refusal(&mut workspace, stored_edit("b", vec![SceneEdit::SetSceneId(SetSceneId { id: "c".into() })])),
            Refusal::SceneIdBound { .. }
        ));
    }

    /// The bindings of every object, by id.
    fn bindings_by_object(scene: &SceneDocument) -> BTreeMap<String, Option<serde_json::Map<String, serde_json::Value>>> {
        scene
            .objects
            .iter()
            .map(|object| (object.base().id.clone(), object.base().bindings.clone()))
            .collect()
    }

    fn binding_map(pairs: &[(&str, &str)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .map(|(property, path)| ((*property).to_owned(), serde_json::json!(path)))
            .collect()
    }

    fn bound_scene() -> SceneDocument {
        let mut scene = new_scene("scorebug", "Scorebug");
        // A non-dyadic float: 48/255 has no exact binary representation, so a
        // reader that is merely ULP-accurate returns a different number.
        scene.data_context = serde_json::json!({
            "match": {
                "home": { "x": 120.5, "name": "Rovers", "logo": "home-logo" },
                "away": { "x": 1480.25, "name": "United" },
                "alpha": 48.0_f64 / 255.0,
            },
            "flags": [true, false],
            "live": true,
        })
        .as_object()
        .expect("the data context is an object")
        .clone();
        scene.assets.push(AssetLibraryItem {
            asset_id: "home-logo".into(),
            name: "Home logo".into(),
            kind: AssetKind::Image,
            path: "assets/home-logo.png".into(),
            checksum: None,
            mime_type: Some("image/png".into()),
            size_bytes: None,
            status: None,
        });
        let mut bar = ObjectBase::new("bar", "Bar");
        bar.width = 640.0;
        bar.height = 72.0;
        bar.bindings = Some(binding_map(&[("x", "match.home.x"), ("visible", "flags.0")]));
        scene.objects.push(SceneObject::Rect(RectObject { base: bar, radius: 4.0 }));
        let mut logo = ObjectBase::new("logo", "Logo");
        logo.width = 64.0;
        logo.height = 64.0;
        logo.bindings = Some(binding_map(&[("assetId", "match.home.logo")]));
        scene.objects.push(SceneObject::Image(ImageObject {
            base: logo,
            asset_id: "home-logo".into(),
            fit: Default::default(),
        }));
        scene
    }

    fn bind(object_id: &str, property: &str, path: Option<&str>) -> SceneEdit {
        SceneEdit::SetBinding(SetBinding {
            object_id: object_id.into(),
            property: property.into(),
            path: path.map(str::to_owned),
        })
    }

    #[test]
    fn bindings_and_the_data_context_survive_save_and_reopen() {
        // 11.19: "preserve bindings through save/reopen", now through the
        // command path. Every reopen goes through the closed reader.
        let (scratch, mut workspace) = with_store("bindings");
        let authored = bound_scene();
        let file = scratch.file("scorebug.json");
        std::fs::write(&file, serde_json::to_vec(&authored).unwrap()).unwrap();
        let session = open(&mut workspace, SceneSource::File { path: file });
        run(&mut workspace, save(session, SaveTarget::Project { project: "news".into() }));

        let reopen = || {
            let mut fresh = Workspace::new(Some(scratch.projects()));
            let key = open_stored(&mut fresh, "scorebug");
            fresh.view(key).unwrap().document
        };
        let reopened = reopen();
        assert_eq!(reopened, authored, "the whole bound document survives save/reopen");
        assert_eq!(
            reopened.data_context["match"]["alpha"].as_f64().map(f64::to_bits),
            Some((48.0_f64 / 255.0).to_bits()),
            "a non-dyadic data-context float reopens bit for bit"
        );

        // Re-point one binding and remove another, as one gesture.
        run(&mut workspace, edit(session, vec![bind("bar", "x", Some("match.away.x")), bind("bar", "visible", None)]));
        run(&mut workspace, save(session, SaveTarget::Origin));
        assert_eq!(
            bindings_by_object(&reopen()),
            BTreeMap::from([
                ("bar".to_owned(), Some(binding_map(&[("x", "match.away.x")]))),
                ("logo".to_owned(), Some(binding_map(&[("assetId", "match.home.logo")]))),
            ])
        );

        // Remove every binding. Absent means absent: not `null`, not `{}`.
        run(&mut workspace, edit(session, vec![bind("bar", "x", None), bind("logo", "assetId", None)]));
        run(&mut workspace, save(session, SaveTarget::Origin));
        assert!(bindings_by_object(&reopen()).values().all(Option::is_none));
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(scratch.0.join("projects/news/scenes/scorebug.json")).unwrap(),
        )
        .unwrap();
        for object in raw["objects"].as_array().expect("objects on disk") {
            assert!(object.get("bindings").is_none(), "an unbound object carries no bindings key: {object}");
        }
    }

    // --- take pages and the design system -----------------------------------

    #[test]
    fn a_saved_take_page_reopens_with_its_values_and_leaves_its_template_unchanged() {
        let (scratch, mut workspace) = with_store("take-page");
        run(
            &mut workspace,
            stored_edit(
                "b",
                vec![
                    SceneEdit::CreateObject(CreateObject { kind: "rect".into(), name: "Background".into() }),
                    SceneEdit::DeclareControl(DeclareControl {
                        field: ControlField {
                            field_id: "offset".into(),
                            label: "Horizontal offset".into(),
                            object_id: "rect-1".into(),
                            property: "x".into(),
                            kind: ControlFieldKind::Number,
                            default: Some(ControlValue::Number(0.0)),
                        },
                    }),
                ],
            ),
        );
        let template = stored_scene(&workspace, "b");
        let page = |scene_id: &str| TakePage {
            page_id: "headlines-at-six".into(),
            name: "Headlines at six".into(),
            scene_id: scene_id.into(),
            values: BTreeMap::from([("offset".into(), ControlValue::Number(6.0))]),
        };
        let save_page = |page: TakePage| EditorCommand::SaveTakePage(SaveTakePage { project: "news".into(), page });

        assert!(matches!(refusal(&mut workspace, save_page(page("absent"))), Refusal::SceneNotStored { .. }));
        let outcome = run(&mut workspace, save_page(page("b")));
        assert_eq!(
            outcome.effects,
            vec![EditEffect::TakePageSaved { project: "news".into(), page_id: "headlines-at-six".into() }]
        );
        assert_eq!(scratch.projects().read_take_page("news", "headlines-at-six").unwrap(), page("b"));
        assert_eq!(stored_scene(&workspace, "b"), template, "saving a page must not overwrite its template");
    }

    #[test]
    fn confirming_a_design_system_creates_the_next_version_by_name() {
        let (_scratch, mut workspace) = with_store("design-system");
        let source = serde_json::json!({
            "brand": { "$type": "color", "primary": { "$value": "#1e88e5" } },
            "type": { "$type": "fontSize", "caption": { "$value": "18px" } }
        })
        .to_string();
        let draft = crate::ingest_w3c("Brand", source.as_bytes()).expect("the source ingests");
        let confirm = |confirmed_by: &str| {
            EditorCommand::ConfirmDesignSystem(ConfirmDesignSystem {
                project: "news".into(),
                commit: DesignSystemCommit { draft: draft.clone(), confirmed_by: confirmed_by.into() },
            })
        };
        assert!(workspace.execute(confirm("   ")).is_err(), "nobody confirmed it, so it is not confirmed");
        for version in [1, 2] {
            assert_eq!(
                run(&mut workspace, confirm("head-of-design")).effects,
                vec![EditEffect::DesignSystemConfirmed { project: "news".into(), version }]
            );
        }
    }
}
