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
//! **History is the command log (11.37).** A session keeps a base document
//! and the `EditScene` batches applied since, each tagged with the module that
//! issued it. The document is always the base with the active batches
//! replayed in order; undo deactivates a batch and replays. So undoing every
//! batch gives back the base byte for byte, and a module's undo removes only
//! that module's batch. When removing (or restoring) one batch would make a
//! later batch refuse, the replay is discarded and the undo refuses
//! `HistoryConflict` by name; nothing changes.
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
use std::path::PathBuf;

use gx_contracts::animation::validate_scene_animation;
use gx_contracts::animation::{capture_motion_phase, KeyRef};
use gx_contracts::command::{
    apply_edits, CommandOutcome, EditContext, EditEffect, EditorCommand, EditorModule,
    HistoryDirection, HistoryStep, HistoryView, PresetPhase, SaveTarget, SceneEdit, SceneOrigin,
    SceneSource, SceneTarget, SessionKey, SessionView,
};
use gx_contracts::control::TakePage;
use gx_contracts::design_system::{
    starter_preset, DesignSystem, DesignSystemCommit, DurationSpec, MotionPhase, MotionPhases,
    MotionPreset, PresetParam,
};
use gx_contracts::scene::{new_scene, parse_scene_document, SceneDocument};
use gx_contracts::{Refusal, Revision};
use gx_write_semantics::guarded;

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

/// One `EditScene` batch in a session's history, with everything needed to
/// replay it exactly: the context it was applied under is kept, so binding the
/// session to a project later, or a newer design-system version, cannot change
/// what replaying it produces.
#[derive(Debug)]
struct LogEntry {
    seq: u64,
    edits: Vec<SceneEdit>,
    module: EditorModule,
    origin: Option<SceneOrigin>,
    design_system: Option<DesignSystem>,
    /// The project's saved presets, snapshotted like the design system so a
    /// replay applies the preset the gesture applied.
    presets: Option<Vec<MotionPreset>>,
    /// False once undone. An inactive entry is replayed again only by redo.
    active: bool,
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
    /// The document replay starts from: as opened, with the oldest batches
    /// folded in once history passes `MAX_HISTORY`.
    base: SceneDocument,
    /// Batches since `base`, in the order they were first applied.
    log: Vec<LogEntry>,
    /// Undone batches by `seq`, most recently undone last.
    redo: Vec<u64>,
    next_seq: u64,
    /// Batches folded into `base` past `MAX_HISTORY`: the history list says how many steps it
    /// no longer shows (11.82).
    folded: u32,
    /// Edited since the last successful save, to a project or to a file. What
    /// a close refuses on.
    dirty: bool,
    /// Edited since the last save to the project origin. Always false for an
    /// unbound scene. A file save does not clear it: the project copy is still
    /// the old graphic, and publishing a stored scene reads the project copy.
    project_dirty: bool,
}

impl Session {
    fn open(
        key: SessionKey,
        document: SceneDocument,
        origin: Option<SceneOrigin>,
        path: Option<String>,
    ) -> Self {
        Self {
            key,
            base: document.clone(),
            document,
            origin,
            path,
            log: Vec::new(),
            redo: Vec::new(),
            next_seq: 1,
            folded: 0,
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
            undo_depth: self.log.iter().filter(|entry| entry.active).count() as u32,
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

    /// Record a batch that has just been applied to `document`. A new batch
    /// forks history: whatever could have been redone is gone.
    fn record(
        &mut self,
        edits: &[SceneEdit],
        module: EditorModule,
        design_system: Option<DesignSystem>,
        presets: Option<Vec<MotionPreset>>,
    ) {
        self.log.retain(|entry| entry.active);
        self.redo.clear();
        self.log.push(LogEntry {
            seq: self.next_seq,
            edits: edits.to_vec(),
            module,
            origin: self.origin.clone(),
            design_system,
            presets,
            active: true,
        });
        self.next_seq += 1;
        // Fold the oldest batches into the base. Every entry is active here,
        // and replay is deterministic, so the fold reproduces the state they
        // first produced; if it ever did not, the entry stays in the log.
        while self.log.len() > MAX_HISTORY {
            let mut folded = self.base.clone();
            let oldest = &self.log[0];
            if apply_entry(&mut folded, oldest).is_err() {
                break;
            }
            self.base = folded;
            self.log.remove(0);
            self.folded = self.folded.saturating_add(1);
        }
        self.mark_edited();
    }

    /// The change history as the list shows it (11.82), oldest step first.
    fn history(&self) -> HistoryView {
        HistoryView {
            session: self.key,
            steps: self
                .log
                .iter()
                .map(|entry| HistoryStep {
                    id: step_id(entry.seq),
                    module: entry.module,
                    edits: entry
                        .edits
                        .iter()
                        .map(|edit| edit.name().to_owned())
                        .collect(),
                    about: entry.edits.first().and_then(about),
                    applied: entry.active,
                })
                .collect(),
            folded: self.folded,
            limit: MAX_HISTORY as u32,
        }
    }

    /// Take the session to the state just after `step`, or to the scene as opened when it is
    /// absent (11.82): every entry up to the step applied and every later one undone, in one
    /// replay. Returns whether anything changed. A replay that refuses puts every flag back.
    fn go_to(&mut self, step: Option<u32>) -> Result<bool, Refusal> {
        let applied = match step {
            None => 0,
            Some(step) => {
                let index = self
                    .log
                    .iter()
                    .position(|entry| step_id(entry.seq) == step)
                    .ok_or(Refusal::HistoryStepUnknown {
                        session: self.key,
                        step,
                    })?;
                index + 1
            }
        };
        let before: Vec<bool> = self.log.iter().map(|entry| entry.active).collect();
        if before
            .iter()
            .enumerate()
            .all(|(index, active)| *active == (index < applied))
        {
            return Ok(false);
        }
        // Named for what the author sees: it is a way back when any applied step is undone.
        let direction = if before
            .iter()
            .enumerate()
            .any(|(index, active)| *active && index >= applied)
        {
            HistoryDirection::Undo
        } else {
            HistoryDirection::Redo
        };
        for (index, entry) in self.log.iter_mut().enumerate() {
            entry.active = index < applied;
        }
        match self.replay() {
            Ok(document) => {
                self.document = document;
                // Redo takes the last seq first, so the step right after the target comes
                // back first and the rest follow in the order they were made.
                self.redo = self.log[applied..]
                    .iter()
                    .rev()
                    .map(|entry| entry.seq)
                    .collect();
                Ok(true)
            }
            Err(refusal) => {
                for (entry, active) in self.log.iter_mut().zip(before) {
                    entry.active = active;
                }
                Err(Refusal::HistoryConflict {
                    session: self.key,
                    direction,
                    detail: format!("[{}] {refusal}", refusal.code_name()),
                })
            }
        }
    }

    /// The document with the active batches replayed over the base.
    fn replay(&self) -> Result<SceneDocument, Refusal> {
        let mut document = self.base.clone();
        for entry in self.log.iter().filter(|entry| entry.active) {
            apply_entry(&mut document, entry)?;
        }
        Ok(document)
    }

    /// Flip one entry and replay; on a refusal, flip it back and refuse.
    fn toggle_and_replay(
        &mut self,
        index: usize,
        direction: HistoryDirection,
    ) -> Result<(), Refusal> {
        self.log[index].active = !self.log[index].active;
        match self.replay() {
            Ok(document) => {
                self.document = document;
                Ok(())
            }
            Err(refusal) => {
                self.log[index].active = !self.log[index].active;
                Err(Refusal::HistoryConflict {
                    session: self.key,
                    direction,
                    detail: format!("[{}] {refusal}", refusal.code_name()),
                })
            }
        }
    }
}

/// A step's id on the wire. A session never reaches four thousand million batches.
fn step_id(seq: u64) -> u32 {
    u32::try_from(seq).unwrap_or(u32::MAX)
}

/// What a step's first edit was about, for the history list (11.82): only something a reader
/// recognises, a name the author typed or the property that changed. Everything else is told
/// by the edit's own kind.
fn about(edit: &SceneEdit) -> Option<String> {
    let text = match edit {
        SceneEdit::CreateObject(p) => &p.name,
        SceneEdit::CreateShape(p) => &p.name,
        SceneEdit::RenameObject(p) => &p.name,
        SceneEdit::SetSceneName(p) => &p.name,
        SceneEdit::SetObjectField(p) => return Some(p.field.name().to_owned()),
        SceneEdit::EditProperty(p) => &p.property,
        SceneEdit::CreateKeyframe(p) => &p.property,
        SceneEdit::UpdateKeyframe(p) => &p.property,
        SceneEdit::MoveKeyframe(p) => &p.property,
        SceneEdit::RemoveKeyframe(p) => &p.property,
        SceneEdit::SetBinding(p) => &p.property,
        SceneEdit::ApplyPreset(p) => &p.preset_id,
        SceneEdit::ApplyTextStyle(p) => &p.style_id,
        _ => return None,
    };
    (!text.is_empty()).then(|| text.clone())
}

fn apply_entry(document: &mut SceneDocument, entry: &LogEntry) -> Result<(), Refusal> {
    let context = EditContext {
        design_system: entry.design_system.as_ref(),
        origin: entry.origin.as_ref(),
        presets: entry.presets.as_deref(),
    };
    apply_edits(document, &entry.edits, &context).map(|_| ())
}

/// What [`Workspace::save_project_as`] leaves behind: the store the copy lives in, what the copy
/// declares, and the scenes that were closed with the project it was made from.
#[derive(Debug)]
pub struct SavedProjectAs {
    pub projects: Projects,
    pub settings: gx_contracts::project::ProjectSettings,
    pub closed_sessions: Vec<SessionKey>,
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
    /// What a scene made here is born with: the space and bits per channel the open project
    /// declares, so saving it into that project is not refused for a mismatch the author never
    /// chose. The shell sets it when a project opens; with none open it is the new-project default.
    new_scene_settings: gx_contracts::project::ProjectSettings,
}

impl Workspace {
    /// A workspace with nothing open. With no store, project commands refuse
    /// `PlatformDirectoryUnavailable` rather than the shell failing to start.
    pub fn new(projects: Option<Projects>) -> Self {
        Self {
            projects,
            sessions: Vec::new(),
            next_key: 1,
            new_scene_settings: gx_contracts::project::ProjectSettings::new_project(),
        }
    }

    /// Declare what the open project declares, for the scenes made from now on (a blank scene,
    /// an imported SVG's depth). Called by the shell when a project opens.
    pub fn set_new_scene_settings(&mut self, settings: gx_contracts::project::ProjectSettings) {
        self.new_scene_settings = settings;
    }

    /// Switch to another project's store, or to none, the way closing one project and opening
    /// another does in XPression, Viz or After Effects. Open scenes are closed with the project;
    /// a scene with unsaved changes refuses by name and nothing is switched, so no work is lost
    /// by choosing another project. Returns the sessions that were closed.
    pub fn switch_project(
        &mut self,
        projects: Option<Projects>,
    ) -> Result<Vec<SessionKey>, CommandError> {
        self.require_no_unsaved()?;
        let closed = self.sessions.iter().map(|s| s.key).collect();
        self.sessions.clear();
        self.projects = projects;
        // Whatever the last project declared does not carry to the next; the shell declares it.
        self.new_scene_settings = gx_contracts::project::ProjectSettings::new_project();
        Ok(closed)
    }

    /// Refuse, by name, while any open scene has unsaved changes. Asked before a project is
    /// created or opened, so a refused switch leaves nothing behind.
    pub fn require_no_unsaved(&self) -> Result<(), CommandError> {
        match self.sessions.iter().find(|s| s.dirty) {
            Some(session) => Err(Refusal::SessionHasUnsavedChanges {
                session: session.key,
                name: session.document.name.clone(),
            }
            .into()),
            None => Ok(()),
        }
    }

    /// File > Save As (11.43): copy the open project `from` to `<parent>/<to>/<to>.gpx` and
    /// switch to the copy, closing the open scenes the way a project switch does.
    ///
    /// The unsaved work of every scene that belongs to `from` is written into the copy and not
    /// into `from`, which stays as it was last saved (the way Save As keeps the original file
    /// untouched). Each of those scenes is held to the same revision check a save is: one whose
    /// stored copy moved on since it was read refuses by name, so another writer's change is
    /// never overwritten. A scene with unsaved work that is *not* stored in `from` (a new scene
    /// never saved to a project, or one stored in another project) would be lost by the switch,
    /// so it refuses by name instead. Everything is checked before anything is copied, and the
    /// copy is made whole or not at all ([`Projects::save_copy`]).
    pub fn save_project_as(
        &mut self,
        from: &str,
        parent: &std::path::Path,
        to: &str,
    ) -> Result<SavedProjectAs, CommandError> {
        let projects = self.projects()?.clone();
        for session in &self.sessions {
            let stored_in_from = session
                .origin
                .as_ref()
                .is_some_and(|origin| origin.project == from);
            if session.dirty && !stored_in_from {
                return Err(Refusal::SessionHasUnsavedChanges {
                    session: session.key,
                    name: session.document.name.clone(),
                }
                .into());
            }
        }
        // Held across the checks and the copy, so no writer lands between them.
        let write_lock = projects.lock_scenes(from)?;
        let settings = projects.settings(from)?;
        let mut changed = Vec::new();
        for session in self.sessions.iter().filter(|s| s.dirty) {
            let Some(origin) = session.origin.as_ref() else {
                continue;
            };
            require_scene_name(&session.document)?;
            if !scene_exists(&projects, from, &origin.scene_id)? {
                return Err(Refusal::SceneNotStored {
                    project: origin.project.clone(),
                    scene_id: origin.scene_id.clone(),
                }
                .into());
            }
            let read = session.document.revision.unwrap_or(Revision(0));
            let current = projects
                .stored_revision(from, &origin.scene_id)?
                .unwrap_or(read);
            let next = guarded(current, read)?;
            let mut document = session.document.clone();
            document.revision = Some(next);
            changed.push(document);
        }
        let saved = projects.save_copy(from, parent, to, &changed)?;
        drop(write_lock);
        let closed_sessions = self.sessions.iter().map(|s| s.key).collect();
        self.sessions.clear();
        // The copy declares what the original declared, so the settings new scenes are born in
        // are already the copy's.
        self.projects = Some(saved.clone());
        Ok(SavedProjectAs {
            projects: saved,
            settings,
            closed_sessions,
        })
    }

    /// Whether a project is open: with none, nothing can be stored.
    pub fn has_project(&self) -> bool {
        self.projects.is_some()
    }

    /// Carry out one command.
    pub fn execute(&mut self, command: EditorCommand) -> Result<CommandOutcome, CommandError> {
        match command {
            EditorCommand::OpenScene(p) => self.open(p.source),
            EditorCommand::CloseScene(p) => self.close(p.session, p.force),
            EditorCommand::EditScene(p) => self.edit(
                p.target,
                &p.edits,
                p.module.unwrap_or(EditorModule::Scene),
                p.if_revision,
            ),
            EditorCommand::Undo(p) => {
                self.step_history(p.session, HistoryDirection::Undo, p.module)
            }
            EditorCommand::Redo(p) => {
                self.step_history(p.session, HistoryDirection::Redo, p.module)
            }
            EditorCommand::GoToHistoryStep(p) => self.go_to_history_step(p.session, p.step),
            EditorCommand::SaveScene(p) => self.save(p.session, p.to),
            EditorCommand::CreateProject(p) => self.create_project(p.project),
            EditorCommand::CreateScene(p) => self.create_scene(p.project, p.scene_id, p.name),
            EditorCommand::DuplicateScene(p) => {
                self.duplicate_scene(p.project, p.source_scene_id, p.scene_id, p.name)
            }
            EditorCommand::DeleteScene(p) => {
                self.delete_scene(p.project, p.scene_id, p.if_revision)
            }
            EditorCommand::SaveTakePage(p) => self.save_take_page(p.project, p.page),
            EditorCommand::ConfirmDesignSystem(p) => {
                self.confirm_design_system(p.project, p.commit)
            }
            EditorCommand::SaveMotionPreset(p) => self.save_motion_preset(
                p.project,
                p.target,
                p.object_id,
                p.preset_id,
                p.phase,
                p.keys,
            ),
            EditorCommand::ImportScene(p) => {
                let outcome = import_into_project(
                    self.projects()?,
                    &p.project,
                    &p.scene_id,
                    p.name.as_deref(),
                    &p.source_name,
                    &p.svg,
                )?;
                Ok(CommandOutcome {
                    session: None,
                    effects: vec![
                        EditEffect::Stored {
                            scene_label: outcome.scene.scene_label,
                            origin: SceneOrigin {
                                project: p.project,
                                scene_id: p.scene_id,
                            },
                        },
                        EditEffect::Imported {
                            report: outcome.report,
                        },
                    ],
                    revision: Some(Revision(0)),
                })
            }
            EditorCommand::ImportAsset(p) => {
                let from = std::path::Path::new(&p.from);
                if !from.is_absolute() {
                    return Err(Refusal::AssetFormatUnrecognised { file: p.from }.into());
                }
                let filed = self.projects()?.import_asset(
                    &p.project,
                    &p.folder,
                    from,
                    p.name.as_deref(),
                    p.source.as_deref(),
                )?;
                use gx_contracts::import::{ImportEntry, ImportReport, ImportTier};
                let path = filed.item.path.clone();
                let report = ImportReport {
                    // The format, in its own name: `png`, `mp4`, `glb`, `woff2`.
                    source_format: path.rsplit('.').next().unwrap_or("").to_ascii_lowercase(),
                    source_name: path.clone(),
                    source_hash: filed.item.checksum.clone(),
                    entries: vec![ImportEntry {
                        source_id: path.clone(),
                        source_name: path,
                        tier: ImportTier::Native,
                        object_id: None,
                        substitutions: Vec::new(),
                    }],
                };
                Ok(CommandOutcome {
                    session: None,
                    effects: vec![EditEffect::Imported { report }],
                    revision: None,
                })
            }
            EditorCommand::ImportFigma(p) => {
                let outcome = import_figma_into_project(
                    self.projects()?,
                    &p.project,
                    &p.scene_id,
                    p.name.as_deref(),
                    &p.source_name,
                    FigmaSource {
                        frame: p.frame.as_deref(),
                        image_folder: p.image_folder.as_deref(),
                        metadata: p.metadata.as_deref(),
                    },
                )?;
                Ok(CommandOutcome {
                    session: None,
                    effects: vec![
                        EditEffect::Stored {
                            scene_label: outcome.scene.scene_label,
                            origin: SceneOrigin {
                                project: p.project,
                                scene_id: p.scene_id,
                            },
                        },
                        EditEffect::Imported {
                            report: outcome.report,
                        },
                    ],
                    revision: Some(Revision(0)),
                })
            }
        }
    }

    /// The document a target names: an open session's, or the stored copy.
    /// What publish and take-page preview read.
    pub fn document(&self, target: &SceneTarget) -> Result<Cow<'_, SceneDocument>, CommandError> {
        match target {
            SceneTarget::Session { session } => {
                Ok(Cow::Borrowed(&self.session(*session)?.document))
            }
            SceneTarget::Stored { project, scene_id } => {
                Ok(Cow::Owned(self.projects()?.read_scene(project, scene_id)?))
            }
        }
    }

    /// One open session as the browser renders it.
    pub fn view(&self, session: SessionKey) -> Result<SessionView, CommandError> {
        Ok(self.session(session)?.view())
    }

    /// One open session's change history, oldest step first (11.82). A read: it changes
    /// nothing.
    pub fn history(&self, session: SessionKey) -> Result<HistoryView, CommandError> {
        Ok(self.session(session)?.history())
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
            SceneSource::New { id, name } => {
                // Born in what the open project declares (the way `create_scene` does), so
                // saving it into that project is not refused for a space or depth nobody chose.
                let settings = self.new_scene_settings;
                let mut document = new_scene(&id, &name, settings.working_color_space);
                document.color_depth = settings.color_depth;
                (document, None, None)
            }
            SceneSource::File { path } => (read_scene_file(&path)?, None, Some(path)),
            SceneSource::ImportSvg {
                id,
                source_name,
                svg,
            } => {
                let mut outcome = import_svg_document(&source_name, svg.as_bytes(), &id)?;
                // The depth is the project's, as a stored import's is; the space is not changed
                // here, because the import converted its colours into the space it chose.
                outcome.scene.color_depth = self.new_scene_settings.color_depth;
                let key = self.open_document(outcome.scene, None, None);
                return Ok(CommandOutcome {
                    session: Some(
                        self.sessions
                            .last()
                            .expect("the session was just opened")
                            .view(),
                    ),
                    effects: vec![
                        EditEffect::SessionOpened { session: key },
                        EditEffect::Imported {
                            report: outcome.report,
                        },
                    ],
                    revision: None,
                });
            }
            SceneSource::Project { project, scene_id } => {
                let origin = SceneOrigin { project, scene_id };
                if let Some(existing) = self
                    .sessions
                    .iter()
                    .find(|session| session.origin.as_ref() == Some(&origin))
                {
                    return Ok(CommandOutcome {
                        session: Some(existing.view()),
                        effects: vec![EditEffect::SessionOpened {
                            session: existing.key,
                        }],
                        revision: None,
                    });
                }
                let document = self
                    .projects()?
                    .read_scene(&origin.project, &origin.scene_id)?;
                // Parsing checks shape; publish also checks animation, and a
                // key it would refuse is refused here by name rather than
                // previewed as some other curve.
                validate_scene_animation(&document)?;
                (document, Some(origin), None)
            }
        };
        let key = self.open_document(document, origin, path);
        Ok(CommandOutcome {
            session: Some(
                self.sessions
                    .last()
                    .expect("the session was just opened")
                    .view(),
            ),
            effects: vec![EditEffect::SessionOpened { session: key }],
            revision: None,
        })
    }

    /// Install a document as a new session and return its key.
    fn open_document(
        &mut self,
        document: SceneDocument,
        origin: Option<SceneOrigin>,
        path: Option<String>,
    ) -> SessionKey {
        let key = SessionKey(self.next_key);
        self.next_key = self
            .next_key
            .checked_add(1)
            .expect("fewer than u32::MAX sessions are opened in one Editor run");
        self.sessions
            .push(Session::open(key, document, origin, path));
        key
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
            revision: None,
        })
    }

    fn edit(
        &mut self,
        target: SceneTarget,
        edits: &[SceneEdit],
        module: EditorModule,
        if_revision: Option<Revision>,
    ) -> Result<CommandOutcome, CommandError> {
        match target {
            SceneTarget::Session { session: key } => {
                // An open session has no stored revision to compare. Taking
                // the field and ignoring it would let a caller believe a
                // concurrency check ran that did not (invariant 18).
                if if_revision.is_some() {
                    return Err(Refusal::CommandUnknownField {
                        path: "ifRevision".into(),
                    }
                    .into());
                }
                let index = self.index(key)?;
                let origin = self.sessions[index].origin.clone();
                let design_system = self.design_system_for(origin.as_ref(), edits)?;
                let presets = self.presets_for(origin.as_ref(), edits)?;
                let context = EditContext {
                    design_system: design_system.as_ref(),
                    origin: origin.as_ref(),
                    presets: presets.as_deref(),
                };
                let session = &mut self.sessions[index];
                let (before, effects) = apply_edits(&mut session.document, edits, &context)?;
                // A batch that changed nothing is not a gesture: no history
                // entry, no unsaved mark.
                if session.document != before {
                    session.record(edits, module, design_system, presets);
                }
                Ok(CommandOutcome {
                    session: Some(session.view()),
                    effects,
                    revision: None,
                })
            }
            SceneTarget::Stored { project, scene_id } => {
                let origin = SceneOrigin { project, scene_id };
                // 8.12: the read, the revision check and the write are one
                // step, so a stale batch cannot land between them.
                let _write = self.projects()?.lock_scenes(&origin.project)?;
                let mut document = self
                    .projects()?
                    .read_scene(&origin.project, &origin.scene_id)?;
                let current = document.revision.unwrap_or(Revision(0));
                let next = match if_revision {
                    Some(expected) => guarded(current, expected)?,
                    None => current.next(),
                };
                let design_system = self.design_system_for(Some(&origin), edits)?;
                let presets = self.presets_for(Some(&origin), edits)?;
                let context = EditContext {
                    design_system: design_system.as_ref(),
                    origin: Some(&origin),
                    presets: presets.as_deref(),
                };
                let (before, mut effects) = apply_edits(&mut document, edits, &context)?;
                // A batch that changed nothing writes nothing and answers the
                // revision it found; the revision moves only with the content.
                let revision = if document != before {
                    document.revision = Some(next);
                    self.projects()?.write_scene(&origin.project, &document)?;
                    effects.push(EditEffect::Stored {
                        origin,
                        scene_label: None,
                    });
                    next
                } else {
                    current
                };
                Ok(CommandOutcome {
                    session: None,
                    effects,
                    revision: Some(revision),
                })
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
        if !edits
            .iter()
            .any(|edit| matches!(edit, SceneEdit::ApplyTextStyle(_)))
        {
            return Ok(None);
        }
        let store = self.projects()?.design_system(&origin.project)?;
        match store.current_version()? {
            Some(version) => Ok(Some(store.load(version)?)),
            None => Ok(None),
        }
    }

    /// The project's saved motion presets, loaded only when an edit applies a
    /// preset: a scene with no origin has no project library to consult, and
    /// an edit that applies none never reads the disk.
    fn presets_for(
        &self,
        origin: Option<&SceneOrigin>,
        edits: &[SceneEdit],
    ) -> Result<Option<Vec<MotionPreset>>, CommandError> {
        let Some(origin) = origin else {
            return Ok(None);
        };
        if !edits
            .iter()
            .any(|edit| matches!(edit, SceneEdit::ApplyPreset(_)))
        {
            return Ok(None);
        }
        Ok(Some(self.projects()?.motion_presets(&origin.project)?))
    }

    fn step_history(
        &mut self,
        key: SessionKey,
        direction: HistoryDirection,
        module: Option<EditorModule>,
    ) -> Result<CommandOutcome, CommandError> {
        let session = self.session_mut(key)?;
        let in_scope = |entry: &LogEntry| module.is_none_or(|module| entry.module == module);
        let empty = || match module {
            Some(module) => Refusal::ModuleHistoryEmpty {
                session: key,
                direction,
                module,
            },
            None => Refusal::HistoryEmpty {
                session: key,
                direction,
            },
        };
        match direction {
            HistoryDirection::Undo => {
                let index = session
                    .log
                    .iter()
                    .rposition(|entry| entry.active && in_scope(entry))
                    .ok_or_else(empty)?;
                session.toggle_and_replay(index, direction)?;
                session.redo.push(session.log[index].seq);
            }
            HistoryDirection::Redo => {
                let position = session
                    .redo
                    .iter()
                    .rposition(|seq| {
                        session
                            .log
                            .iter()
                            .any(|entry| entry.seq == *seq && in_scope(entry))
                    })
                    .ok_or_else(empty)?;
                let seq = session.redo[position];
                let index = session
                    .log
                    .iter()
                    .position(|entry| entry.seq == seq)
                    .expect("every redo seq names a logged entry");
                session.toggle_and_replay(index, direction)?;
                session.redo.remove(position);
            }
        }
        session.mark_edited();
        Ok(CommandOutcome {
            session: Some(session.view()),
            effects: vec![EditEffect::None],
            revision: None,
        })
    }

    /// A click in the history list (11.82). Going to where the session already is answers the
    /// session as it is and does not mark it edited.
    fn go_to_history_step(
        &mut self,
        key: SessionKey,
        step: Option<u32>,
    ) -> Result<CommandOutcome, CommandError> {
        let session = self.session_mut(key)?;
        if session.go_to(step)? {
            session.mark_edited();
        }
        Ok(CommandOutcome {
            session: Some(session.view()),
            effects: vec![EditEffect::None],
            revision: None,
        })
    }

    fn save(&mut self, key: SessionKey, to: SaveTarget) -> Result<CommandOutcome, CommandError> {
        let index = self.index(key)?;
        let mut saved_revision = None;
        let effect = match to {
            SaveTarget::Origin => {
                let session = &self.sessions[index];
                let origin = session
                    .origin
                    .clone()
                    .ok_or(Refusal::SessionUnbound { session: key })?;
                require_scene_name(&session.document)?;
                let projects = self.projects()?;
                // 8.12: a save is a write like any other. It is refused when
                // the stored scene moved on since this session read it, so an
                // agent's edit is never overwritten blind. The session keeps
                // its work, which still saves to a file.
                let _write = projects.lock_scenes(&origin.project)?;
                // Update, never create: a bound scene whose stored copy has
                // gone is reported, not silently recreated.
                if !scene_exists(projects, &origin.project, &origin.scene_id)? {
                    return Err(Refusal::SceneNotStored {
                        project: origin.project,
                        scene_id: origin.scene_id,
                    }
                    .into());
                }
                let read = session.document.revision.unwrap_or(Revision(0));
                let current = projects
                    .stored_revision(&origin.project, &origin.scene_id)?
                    .unwrap_or(read);
                let next = guarded(current, read)?;
                let mut document = session.document.clone();
                document.revision = Some(next);
                projects.write_scene(&origin.project, &document)?;
                let session = &mut self.sessions[index];
                // Replay rebuilds the document from the base, so both carry
                // the revision this save produced.
                session.document.revision = Some(next);
                session.base.revision = Some(next);
                session.dirty = false;
                session.project_dirty = false;
                saved_revision = Some(next);
                EditEffect::Stored {
                    origin,
                    scene_label: None,
                }
            }
            SaveTarget::Project { project } => {
                let session = &self.sessions[index];
                require_scene_name(&session.document)?;
                let projects = self.projects()?;
                let scene_id = session.document.id.clone();
                // Create, never overwrite: a scene already stored under this
                // id is another graphic, and replacing it would lose it.
                let _write = projects.lock_scenes(&project)?;
                if scene_exists(projects, &project, &scene_id)? {
                    return Err(Refusal::SceneAlreadyExists { project, scene_id }.into());
                }
                projects.write_scene(&project, &session.document)?;
                saved_revision = Some(session.document.revision.unwrap_or(Revision(0)));
                let origin = SceneOrigin { project, scene_id };
                let session = &mut self.sessions[index];
                session.origin = Some(origin.clone());
                session.dirty = false;
                session.project_dirty = false;
                EditEffect::Stored {
                    origin,
                    scene_label: None,
                }
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
            SaveTarget::NextVersion => {
                let session = &self.sessions[index];
                if let Some(origin) = session.origin.clone() {
                    require_scene_name(&session.document)?;
                    let projects = self.projects()?;
                    // The scene list is read and the new scene written under one lock, so two
                    // versions saved at once cannot be given the same number.
                    let _write = projects.lock_scenes(&origin.project)?;
                    let taken = projects.list_scenes(&origin.project)?;
                    let (scene_id, number) = next_version_id(&origin.scene_id, |id| {
                        taken.iter().any(|taken| taken == id)
                    })
                    .ok_or_else(|| Refusal::SceneAlreadyExists {
                        project: origin.project.clone(),
                        scene_id: origin.scene_id.clone(),
                    })?;
                    let mut document = session.document.clone();
                    document.id = scene_id.clone();
                    document.name = versioned_name(&document.name, number);
                    // A new scene is unpublished: the revision belongs to the version it came from.
                    document.revision = None;
                    projects.write_scene(&origin.project, &document)?;
                    // Only now does the session change, so a failed write leaves it as it was.
                    let origin = SceneOrigin {
                        project: origin.project,
                        scene_id,
                    };
                    let session = &mut self.sessions[index];
                    session.base = document.clone();
                    session.document = document;
                    session.log.clear();
                    session.redo.clear();
                    session.folded = 0;
                    session.origin = Some(origin.clone());
                    // The file the old version was saved to is not this version's.
                    session.path = None;
                    session.dirty = false;
                    session.project_dirty = false;
                    saved_revision = Some(Revision(0));
                    EditEffect::Stored {
                        origin,
                        scene_label: None,
                    }
                } else if let Some(path) = session.path.clone() {
                    let next = next_version_path(&path).ok_or_else(|| {
                        CommandError::Store(EditorError::Io {
                            path: PathBuf::from(&path),
                            source: std::io::Error::new(
                                std::io::ErrorKind::AlreadyExists,
                                "every numbered version of this file is taken",
                            ),
                        })
                    })?;
                    write_scene_file(&next, &session.document)?;
                    let session = &mut self.sessions[index];
                    session.path = Some(next);
                    session.dirty = false;
                    EditEffect::None
                } else {
                    return Err(Refusal::SessionUnbound { session: key }.into());
                }
            }
        };
        Ok(CommandOutcome {
            session: Some(self.sessions[index].view()),
            effects: vec![effect],
            revision: saved_revision,
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
            revision: None,
        })
    }

    fn create_scene(
        &self,
        project: String,
        scene_id: String,
        name: String,
    ) -> Result<CommandOutcome, CommandError> {
        let projects = self.projects()?;
        // 3.15: a scene composites in its project's declared space.
        let settings = projects.settings(&project)?;
        let mut document = new_scene(&scene_id, name.trim(), settings.working_color_space);
        document.color_depth = settings.color_depth;
        require_scene_name(&document)?;
        let _write = projects.lock_scenes(&project)?;
        if scene_exists(projects, &project, &scene_id)? {
            return Err(Refusal::SceneAlreadyExists { project, scene_id }.into());
        }
        document.scene_label = Some(projects.next_scene_label(&project)?);
        projects.write_scene(&project, &document)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::Stored {
                origin: SceneOrigin { project, scene_id },
                scene_label: document.scene_label,
            }],
            // A new scene is at revision 0; its first edit names that.
            revision: Some(Revision(0)),
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
        let _write = projects.lock_scenes(&project)?;
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
        duplicate.scene_label = Some(projects.next_scene_label(&project)?);
        projects.write_scene(&project, &duplicate)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::Stored {
                origin: SceneOrigin { project, scene_id },
                scene_label: duplicate.scene_label,
            }],
            revision: Some(Revision(0)),
        })
    }

    /// Delete a stored scene.
    ///
    /// An open session bound to it with unsaved project changes blocks the
    /// delete by name, as main.ts did: deleting would destroy the only copy
    /// those changes could have been saved over. Otherwise the session stays
    /// open, unbound — the document remains, outside the project — and the
    /// outcome carries its new view.
    fn delete_scene(
        &mut self,
        project: String,
        scene_id: String,
        if_revision: Option<Revision>,
    ) -> Result<CommandOutcome, CommandError> {
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
        // 8.12: with `ifRevision` the delete is a compare-and-swap too, so a
        // scene is never deleted by a caller that has not seen its latest edit.
        let _write = projects.lock_scenes(&origin.project)?;
        if !scene_exists(projects, &origin.project, &origin.scene_id)? {
            return Err(Refusal::SceneNotStored {
                project: origin.project,
                scene_id: origin.scene_id,
            }
            .into());
        }
        if let Some(expected) = if_revision {
            let current = projects
                .stored_revision(&origin.project, &origin.scene_id)?
                .unwrap_or(expected);
            guarded(current, expected)?;
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
            effects: vec![EditEffect::Stored {
                origin,
                scene_label: None,
            }],
            revision: None,
        })
    }

    /// Save a filled take page beside, never inside, its template: filling
    /// one must not rewrite the authored scene it references.
    fn save_take_page(
        &self,
        project: String,
        page: TakePage,
    ) -> Result<CommandOutcome, CommandError> {
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
            revision: None,
        })
    }

    /// Capture selected keys as one phase of a saved preset (11.15).
    ///
    /// The document is read and never changed. A starter id is refused rather
    /// than shadowed, so "fade" always means the starter's fade. Saving the
    /// other phase of an existing id keeps what the library already holds; a
    /// first save leaves the other phase empty, which `presetBlocker` and
    /// `MotionPreset::validate` name as unusable until it is saved too.
    fn save_motion_preset(
        &self,
        project: String,
        target: SceneTarget,
        object_id: String,
        preset_id: String,
        phase: PresetPhase,
        keys: Vec<KeyRef>,
    ) -> Result<CommandOutcome, CommandError> {
        let projects = self.projects()?;
        if starter_preset(&preset_id).is_some()
            || !gx_contracts::platform::is_canonical_filename(&preset_id)
        {
            return Err(Refusal::MotionPresetIdInvalid { preset_id }.into());
        }
        let document = self.document(&target)?;
        let captured = capture_motion_phase(&document, &object_id, &keys)?;
        let kind = document
            .objects
            .iter()
            .find(|object| object.base().id == object_id)
            .map(|object| object.kind().to_owned())
            .ok_or_else(|| Refusal::SceneObjectUnknown {
                object_id: object_id.clone(),
            })?;

        let empty = || MotionPhase {
            duration: DurationSpec::Ms(0.0),
            channels: Vec::new(),
        };
        let mut preset = projects
            .read_motion_preset(&project, &preset_id)?
            .unwrap_or_else(|| MotionPreset {
                id: preset_id.clone(),
                applies_to: Vec::new(),
                phases: MotionPhases {
                    r#in: empty(),
                    out: empty(),
                    hold: None,
                    r#continue: Vec::new(),
                    update: None,
                },
                params: Vec::new(),
                stagger: None,
            });
        match phase {
            PresetPhase::In => preset.phases.r#in = captured,
            PresetPhase::Out => preset.phases.out = captured,
        }
        if !preset.applies_to.contains(&kind) {
            preset.applies_to.push(kind);
        }
        // The `in` phase's own length is the default once it exists, and the
        // declared range is a quarter to four times it, so a retime stays
        // recognisably the motion that was saved.
        if let DurationSpec::Ms(default) = preset.phases.r#in.duration {
            if default > 0.0 {
                preset.params = vec![PresetParam::Duration {
                    name: "duration".into(),
                    min: (default / 4.0).max(1.0).floor(),
                    max: (default * 4.0).ceil(),
                    default: DurationSpec::Ms(default),
                }];
            }
        }
        projects.write_motion_preset(&project, &preset)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::MotionPresetSaved {
                project,
                preset_id,
                phase,
            }],
            revision: None,
        })
    }

    /// Confirm a draft as the next immutable version. `confirmed_by` is
    /// passed straight through: a confirmation invented here would satisfy
    /// the store's check while defeating its point.
    fn confirm_design_system(
        &self,
        project: String,
        commit: DesignSystemCommit,
    ) -> Result<CommandOutcome, CommandError> {
        let store = self.projects()?.design_system(&project)?;
        let system = store.confirm(&commit.draft, &commit.confirmed_by)?;
        Ok(CommandOutcome {
            session: None,
            effects: vec![EditEffect::DesignSystemConfirmed {
                project,
                version: system.version,
            }],
            revision: None,
        })
    }
}

fn scene_exists(projects: &Projects, project: &str, scene_id: &str) -> Result<bool, CommandError> {
    Ok(projects
        .list_scenes(project)?
        .iter()
        .any(|id| id == scene_id))
}

/// A stored scene needs a name an author can find it by.
/// Run the 7.2 pipeline for a command. A failure is a refusal naming the
/// source, never an empty scene: the import is all or nothing.
pub(crate) fn import_svg_document(
    source_name: &str,
    bytes: &[u8],
    scene_id: &str,
) -> Result<crate::import::ImportOutcome, CommandError> {
    let mut outcome = crate::import::import_svg(source_name, bytes, scene_id).map_err(|error| {
        CommandError::Refused(Refusal::SceneParseFailed {
            detail: format!("import of {source_name}: {error}"),
        })
    })?;
    // The scene is named after its source, as the author will look for it.
    outcome.scene.name = std::path::Path::new(source_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or(source_name)
        .to_owned();
    require_scene_name(&outcome.scene)?;
    // What the pipeline built must be a scene the Editor would accept from
    // disk: the same strict reader, so no import can produce a document the
    // engine later refuses.
    let bytes = serde_json::to_vec(&outcome.scene).map_err(|error| {
        CommandError::Refused(Refusal::SceneParseFailed {
            detail: error.to_string(),
        })
    })?;
    parse_scene_document(&bytes).map_err(CommandError::Refused)?;
    Ok(outcome)
}

/// Import an SVG straight into a stored project scene (7.2, `importScene`).
/// The scene is written and its source adopted into the project's assets by
/// content hash, so the report's `source_hash` resolves inside the project.
/// An existing scene id refuses: an import never overwrites.
pub fn import_into_project(
    projects: &Projects,
    project: &str,
    scene_id: &str,
    name: Option<&str>,
    source_name: &str,
    svg: &str,
) -> Result<crate::import::ImportOutcome, CommandError> {
    let declared = projects.settings(project)?.working_color_space;
    if scene_exists(projects, project, scene_id)? {
        return Err(Refusal::SceneAlreadyExists {
            project: project.to_owned(),
            scene_id: scene_id.to_owned(),
        }
        .into());
    }
    let outcome = import_svg_document(source_name, svg.as_bytes(), scene_id)?;
    store_import(
        projects,
        project,
        scene_id,
        name,
        declared,
        outcome,
        svg.as_bytes(),
    )
}

/// Ingest one Figma frame, as an agent read it through Figma's MCP, into a stored project
/// scene (18.2, `importFigma`). The same all-or-nothing rules as the SVG import: an existing
/// id refuses, every refusal comes before the first write, and the retained source is the
/// metadata text, adopted by content hash.
/// What an agent handed to `scenes.ingest_figma`: exactly one of a full-fidelity frame and a
/// structure-only `get_metadata` reply, and the folder its pictures are filed in.
#[derive(Clone, Copy)]
pub struct FigmaSource<'a> {
    pub frame: Option<&'a gx_contracts::figma_frame::FigmaNode>,
    pub image_folder: Option<&'a str>,
    pub metadata: Option<&'a str>,
}

pub fn import_figma_into_project(
    projects: &Projects,
    project: &str,
    scene_id: &str,
    name: Option<&str>,
    source_name: &str,
    source: FigmaSource<'_>,
) -> Result<crate::import::ImportOutcome, CommandError> {
    let FigmaSource {
        frame,
        image_folder,
        metadata,
    } = source;
    let declared = projects.settings(project)?.working_color_space;
    if scene_exists(projects, project, scene_id)? {
        return Err(Refusal::SceneAlreadyExists {
            project: project.to_owned(),
            scene_id: scene_id.to_owned(),
        }
        .into());
    }
    let refused = |detail: String| {
        CommandError::Refused(Refusal::SceneParseFailed {
            detail: format!("ingest of {source_name}: {detail}"),
        })
    };
    // Exactly one source, and the bytes retained are the ones that were read.
    let (outcome, retained) =
        match (frame, metadata) {
            (Some(frame), None) => {
                // Pictures are looked up in Images/<folder>/ of the project: the folder named by
                // the caller, else the root frame's own name made into one file-system name.
                let folder = image_folder.map(str::to_owned).unwrap_or_else(|| {
                    gx_contracts::platform::sanitize_filename(if frame.name.trim().is_empty() {
                        &frame.id
                    } else {
                        &frame.name
                    })
                });
                let find = |stem: &str| projects.find_image(project, &folder, stem).ok().flatten();
                let find_font = |family: &str, style: &str| {
                    projects.find_font(project, family, style).ok().flatten()
                };
                let lookup = crate::figma_rich::PictureLookup {
                    folder: folder.clone(),
                    find: &find,
                    font: &find_font,
                };
                (
                    crate::figma_rich::import_figma_frame_with(
                        source_name,
                        frame,
                        scene_id,
                        Some(&lookup),
                    )
                    .map_err(|e| refused(e.to_string()))?,
                    crate::figma_rich::canonical_source(frame),
                )
            }
            (None, Some(text)) => (
                crate::figma::import_figma_metadata(source_name, text, scene_id)
                    .map_err(|e| refused(e.to_string()))?,
                text.to_owned(),
            ),
            _ => return Err(refused(
                "give exactly one of frame (the full-fidelity route) and metadata (structure only)"
                    .into(),
            )),
        };
    let metadata = retained.as_str();
    // The same strict reader the Editor opens a stored scene with: no ingest can produce a
    // document the engine later refuses.
    let bytes = serde_json::to_vec(&outcome.scene).map_err(|error| {
        CommandError::Refused(Refusal::SceneParseFailed {
            detail: error.to_string(),
        })
    })?;
    parse_scene_document(&bytes).map_err(CommandError::Refused)?;
    store_import(
        projects,
        project,
        scene_id,
        name,
        declared,
        outcome,
        metadata.as_bytes(),
    )
}

/// Name, check and write an imported scene, adopting its retained source (7.2).
fn store_import(
    projects: &Projects,
    project: &str,
    scene_id: &str,
    name: Option<&str>,
    declared: gx_contracts::color::WorkingColorSpace,
    mut outcome: crate::import::ImportOutcome,
    source_bytes: &[u8],
) -> Result<crate::import::ImportOutcome, CommandError> {
    if let Some(name) = name {
        outcome.scene.name = name.trim().to_owned();
        require_scene_name(&outcome.scene)?;
    }
    // Depth is a rounding setting, not an authoring difference, so an
    // imported scene takes its project's; a colour space it must match.
    outcome.scene.color_depth = projects.settings(project)?.color_depth;
    // Every refusal comes before the first write: a project in another
    // working space refuses here, so no source is adopted for a scene that
    // will never be stored (3.15).
    if outcome.scene.working_color_space != declared {
        return Err(Refusal::SceneWorkingSpaceMismatch {
            project: project.to_owned(),
            scene_id: scene_id.to_owned(),
            scene: outcome.scene.working_color_space,
            project_space: declared,
        }
        .into());
    }
    let _write = projects.lock_scenes(project)?;
    if scene_exists(projects, project, scene_id)? {
        return Err(Refusal::SceneAlreadyExists {
            project: project.to_owned(),
            scene_id: scene_id.to_owned(),
        }
        .into());
    }
    outcome.scene.scene_label = Some(projects.next_scene_label(project)?);
    let source = outcome
        .scene
        .assets
        .iter()
        .find(|item| item.checksum.is_some() && item.checksum == outcome.report.source_hash)
        .cloned()
        .expect("an import carries its source as an asset");
    projects.adopt_asset(project, &source, source_bytes)?;
    projects.write_scene(project, &outcome.scene)?;
    Ok(outcome)
}

/// The number a name carries at its end: `strap_v003` is `("strap", Some(3))` and `strap` is
/// `("strap", None)`. `separator` is what stands before the `v` (`_` in an id, a space in a name).
fn split_version(text: &str, separator: char) -> (&str, Option<u32>) {
    if let Some(at) = text.rfind(separator) {
        let rest = &text[at + separator.len_utf8()..];
        if let Some(digits) = rest.strip_prefix('v') {
            if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                if let Ok(number) = digits.parse::<u32>() {
                    if number >= 1 && at > 0 {
                        return (&text[..at], Some(number));
                    }
                }
            }
        }
    }
    (text, None)
}

/// The most numbered versions one scene or file can have.
const MAX_VERSION: u32 = 9999;

/// The id of the next version of `scene_id`, and its number (11.30): the number after the one it
/// carries (2 when it carries none), moving on past any that `taken` names. `None` when every
/// number up to [`MAX_VERSION`] is taken.
fn next_version_id(scene_id: &str, taken: impl Fn(&str) -> bool) -> Option<(String, u32)> {
    let (base, number) = split_version(scene_id, '_');
    (number.map_or(2, |number| number + 1)..=MAX_VERSION)
        .map(|number| (format!("{base}_v{number:03}"), number))
        .find(|(id, _)| !taken(id))
}

/// A name numbered like its version: `Strap` and `Strap v007` become `Strap v008`.
fn versioned_name(name: &str, number: u32) -> String {
    let name = name.trim();
    let (base, _) = split_version(name, ' ');
    format!("{base} v{number:03}")
}

/// The scene file beside `path` for the next numbered version: `strap.json` gives
/// `strap_v002.json`, `strap_v003.json` gives `strap_v004.json`, and a file that is there is passed
/// over. `None` when the path has no file name or every number is taken.
fn next_version_path(path: &str) -> Option<String> {
    let path = std::path::Path::new(path);
    let stem = path.file_stem()?.to_str()?;
    let (base, number) = split_version(stem, '_');
    (number.map_or(2, |number| number + 1)..=MAX_VERSION).find_map(|number| {
        let mut name = format!("{base}_v{number:03}");
        if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
            name.push('.');
            name.push_str(extension);
        }
        let candidate = path.with_file_name(name);
        (!candidate.exists()).then(|| candidate.display().to_string())
    })
}

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
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| CommandError::Store(EditorError::Serialize(error)))?;
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
        CloseScene, ConfirmDesignSystem, CreateKeyframe, CreateObject, CreateProject, CreateScene,
        DeclareControl, DeleteScene, DuplicateScene, EditScene, GoToHistoryStep, OpenScene, Redo,
        RenameObject, SaveMotionPreset, SaveScene, SaveTakePage, SetBinding, SetObjectField,
        SetObjectLocked, SetObjectVisible, SetSceneId, SetSceneName, Undo,
    };
    use gx_contracts::control::{ControlField, ControlFieldKind, ControlValue};
    use gx_contracts::object_edit::ObjectField;
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
        run(
            &mut workspace,
            EditorCommand::CreateProject(CreateProject {
                project: "news".into(),
            }),
        );
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
        open(
            workspace,
            SceneSource::New {
                id: id.into(),
                name: name.into(),
            },
        )
    }

    fn open_stored(workspace: &mut Workspace, scene_id: &str) -> SessionKey {
        open(
            workspace,
            SceneSource::Project {
                project: "news".into(),
                scene_id: scene_id.into(),
            },
        )
    }

    fn edit(session: SessionKey, edits: Vec<SceneEdit>) -> EditorCommand {
        EditorCommand::EditScene(EditScene {
            target: SceneTarget::Session { session },
            edits,
            module: None,
            if_revision: None,
        })
    }

    fn stored_edit(scene_id: &str, edits: Vec<SceneEdit>) -> EditorCommand {
        EditorCommand::EditScene(EditScene {
            target: SceneTarget::Stored {
                project: "news".into(),
                scene_id: scene_id.into(),
            },
            edits,
            module: None,
            if_revision: None,
        })
    }

    fn rename_scene(name: &str) -> SceneEdit {
        SceneEdit::SetSceneName(SetSceneName { name: name.into() })
    }

    fn undo(session: SessionKey) -> EditorCommand {
        EditorCommand::Undo(Undo {
            session,
            module: None,
        })
    }

    fn redo(session: SessionKey) -> EditorCommand {
        EditorCommand::Redo(Redo {
            session,
            module: None,
        })
    }

    fn close(session: SessionKey, force: bool) -> EditorCommand {
        EditorCommand::CloseScene(CloseScene { session, force })
    }

    fn save(session: SessionKey, to: SaveTarget) -> EditorCommand {
        EditorCommand::SaveScene(SaveScene { session, to })
    }

    fn name_of(workspace: &Workspace, session: SessionKey) -> String {
        workspace
            .view(session)
            .expect("the session is open")
            .document
            .name
    }

    fn stored_scene(workspace: &Workspace, scene_id: &str) -> SceneDocument {
        workspace
            .document(&SceneTarget::Stored {
                project: "news".into(),
                scene_id: scene_id.into(),
            })
            .expect("the stored scene reads")
            .into_owned()
    }

    fn card_scene(id: &str) -> SceneDocument {
        let mut scene = new_scene(id, id, gx_contracts::color::WorkingColorSpace::NEW_PROJECT);
        scene.timeline.duration_frames = 100;
        scene.objects.push(SceneObject::Rect(RectObject {
            base: ObjectBase::new("card", "Card"),
            radius: 0.0,
        }));
        scene
    }

    // --- import (7.2, 11.17) -------------------------------------------------

    #[test]
    fn an_svg_import_opens_an_unbound_session_with_its_report() {
        let svg =
            r#"<svg><rect id="bar" x="1" y="2" width="30" height="40"/><g id="group"/></svg>"#;
        let mut workspace = Workspace::new(None);
        let outcome = run(
            &mut workspace,
            EditorCommand::OpenScene(OpenScene {
                source: SceneSource::ImportSvg {
                    id: "brand".into(),
                    source_name: "Brand Pack.svg".into(),
                    svg: svg.into(),
                },
            }),
        );
        let view = outcome.session.expect("an import opens a session");
        assert_eq!(view.document.name, "Brand Pack", "named after the file");
        assert_eq!(view.origin, None, "an import is unbound until saved");
        let report = outcome
            .effects
            .iter()
            .find_map(|effect| match effect {
                EditEffect::Imported { report } => Some(report),
                _ => None,
            })
            .expect("the report travels with the session");
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.source_name, "Brand Pack.svg");
        assert!(
            view.document
                .assets
                .iter()
                .any(|item| item.checksum == report.source_hash),
            "source retained"
        );
    }

    #[test]
    fn a_broken_svg_import_refuses_and_opens_nothing() {
        let mut workspace = Workspace::new(None);
        let error = workspace
            .execute(EditorCommand::OpenScene(OpenScene {
                source: SceneSource::ImportSvg {
                    id: "cut".into(),
                    source_name: "cut.svg".into(),
                    svg: "<svg><rect".into(),
                },
            }))
            .expect_err("a truncated SVG refuses");
        match error {
            CommandError::Refused(Refusal::SceneParseFailed { detail }) => {
                assert!(
                    detail.contains("cut.svg") && detail.contains("never closed"),
                    "{detail}"
                );
            }
            other => panic!("expected a parse refusal, got {other:?}"),
        }
        assert_eq!(
            open_new(&mut workspace, "next", "Next"),
            SessionKey(1),
            "no session was opened"
        );
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
        run(
            &mut workspace,
            edit(b, vec![rename_scene("B edited twice")]),
        );

        // Undoing in B must not reach A, and reverses exactly one gesture.
        run(&mut workspace, undo(b));
        assert_eq!(name_of(&workspace, b), "B edited");
        assert_eq!(name_of(&workspace, a), "A edited");

        run(&mut workspace, undo(a));
        assert_eq!(name_of(&workspace, a), "a");
        assert_eq!(
            name_of(&workspace, b),
            "B edited",
            "B is untouched by A's undo"
        );

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
        assert_eq!(
            workspace.view(b).unwrap(),
            before,
            "document, history and marks all unchanged"
        );
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
            Refusal::HistoryEmpty {
                direction: HistoryDirection::Redo,
                ..
            }
        ));
        assert_eq!(workspace.view(session).unwrap(), before);
    }

    #[test]
    fn one_scenes_history_is_bounded_without_bounding_the_workspace() {
        let mut workspace = Workspace::new(None);
        let busy = open_new(&mut workspace, "a", "a");
        let quiet = open_new(&mut workspace, "b", "b");
        for index in 0..MAX_HISTORY + 50 {
            run(
                &mut workspace,
                edit(busy, vec![rename_scene(&format!("edit {index}"))]),
            );
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
        assert!(matches!(
            refusal(&mut workspace, undo(busy)),
            Refusal::HistoryEmpty { .. }
        ));
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
            Refusal::HistoryEmpty {
                direction: HistoryDirection::Redo,
                ..
            }
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
                    SceneEdit::CreateObject(CreateObject {
                        kind: "rect".into(),
                        name: "Bar".into(),
                    }),
                    SceneEdit::RenameObject(RenameObject {
                        object_id: "missing".into(),
                        name: "Nope".into(),
                    }),
                ],
            ),
        );
        assert!(matches!(refused, Refusal::SceneObjectUnknown { .. }));
        assert_eq!(
            workspace.view(session).unwrap(),
            before,
            "the created rect did not land either"
        );
    }

    // --- history on the command log (11.37) ---------------------------------

    fn tagged(session: SessionKey, module: EditorModule, edits: Vec<SceneEdit>) -> EditorCommand {
        EditorCommand::EditScene(EditScene {
            target: SceneTarget::Session { session },
            edits,
            module: Some(module),
            if_revision: None,
        })
    }

    fn content_hash(workspace: &Workspace, session: SessionKey) -> String {
        use sha2::{Digest, Sha256};
        let document = workspace
            .view(session)
            .expect("the session is open")
            .document;
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&document).expect("a document serialises"))
        )
    }

    fn create_rect(name: &str) -> SceneEdit {
        SceneEdit::CreateObject(CreateObject {
            kind: "rect".into(),
            name: name.into(),
        })
    }

    fn set_field(object: &str, field: ObjectField) -> SceneEdit {
        SceneEdit::SetObjectField(SetObjectField {
            object_ids: vec![object.into()],
            field,
        })
    }

    #[test]
    fn undoing_every_command_restores_the_content_hash_and_redoing_reaches_the_edited_one() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        let original = content_hash(&workspace, session);
        let commands = vec![
            tagged(
                session,
                EditorModule::ObjectManager,
                vec![create_rect("Card")],
            ),
            tagged(
                session,
                EditorModule::Inspector,
                vec![set_field("rect-1", ObjectField::X(120.0))],
            ),
            tagged(
                session,
                EditorModule::Timeline,
                vec![SceneEdit::CreateKeyframe(CreateKeyframe {
                    object_id: "rect-1".into(),
                    property: "x".into(),
                    keyframe: SceneKeyframe {
                        frame: 0,
                        value: 120.0,
                        easing: SceneEasing::Linear,
                        bezier: None,
                    },
                })],
            ),
            tagged(session, EditorModule::Scene, vec![rename_scene("Edited")]),
            tagged(
                session,
                EditorModule::ObjectManager,
                vec![SceneEdit::SetObjectVisible(SetObjectVisible {
                    object_id: "rect-1".into(),
                    visible: false,
                })],
            ),
        ];
        let count = commands.len();
        for command in commands {
            run(&mut workspace, command);
        }
        let edited = content_hash(&workspace, session);
        assert_ne!(edited, original);

        for _ in 0..count {
            run(&mut workspace, undo(session));
        }
        assert_eq!(
            content_hash(&workspace, session),
            original,
            "every undo replays back to the base"
        );
        for _ in 0..count {
            run(&mut workspace, redo(session));
        }
        assert_eq!(
            content_hash(&workspace, session),
            edited,
            "every redo replays forward to the edit"
        );
    }

    #[test]
    fn a_module_undo_reverses_only_that_modules_commands_in_an_interleaved_history() {
        let setup = vec![create_rect("Card")];
        let inspector_x = vec![set_field("rect-1", ObjectField::X(100.0))];
        let hide = vec![SceneEdit::SetObjectVisible(SetObjectVisible {
            object_id: "rect-1".into(),
            visible: false,
        })];
        let inspector_y = vec![set_field("rect-1", ObjectField::Y(50.0))];
        let lock = vec![SceneEdit::SetObjectLocked(SetObjectLocked {
            object_id: "rect-1".into(),
            locked: true,
        })];

        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        for (module, edits) in [
            (EditorModule::Scene, setup.clone()),
            (EditorModule::Inspector, inspector_x),
            (EditorModule::ObjectManager, hide.clone()),
            (EditorModule::Inspector, inspector_y),
            (EditorModule::ObjectManager, lock.clone()),
        ] {
            run(&mut workspace, tagged(session, module, edits));
        }
        let module_undo = |session| {
            EditorCommand::Undo(Undo {
                session,
                module: Some(EditorModule::Inspector),
            })
        };
        run(&mut workspace, module_undo(session));
        run(&mut workspace, module_undo(session));

        // The same document built from only the other module's commands.
        let mut expected = Workspace::new(None);
        let other = open_new(&mut expected, "a", "a");
        for edits in [setup, hide, lock] {
            run(&mut expected, edit(other, edits));
        }
        assert_eq!(
            content_hash(&workspace, session),
            content_hash(&expected, other)
        );

        // Nothing of the inspector's is left to undo, and the object
        // manager's two commands are still the project-level history.
        assert!(matches!(
            refusal(&mut workspace, module_undo(session)),
            Refusal::ModuleHistoryEmpty {
                module: EditorModule::Inspector,
                direction: HistoryDirection::Undo,
                ..
            }
        ));
        assert_eq!(workspace.view(session).unwrap().undo_depth, 3);

        // A module redo brings back that module's latest undone command.
        run(
            &mut workspace,
            EditorCommand::Redo(Redo {
                session,
                module: Some(EditorModule::Inspector),
            }),
        );
        let document = workspace.view(session).unwrap().document;
        let card = document
            .objects
            .iter()
            .find(|object| object.base().id == "rect-1")
            .unwrap()
            .base();
        assert_eq!((card.x, card.visible, card.locked), (100.0, false, true));
    }

    #[test]
    fn an_undo_that_would_break_a_later_command_refuses_and_changes_nothing() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(
            &mut workspace,
            tagged(
                session,
                EditorModule::ObjectManager,
                vec![create_rect("Card")],
            ),
        );
        run(
            &mut workspace,
            tagged(
                session,
                EditorModule::Timeline,
                vec![SceneEdit::CreateKeyframe(CreateKeyframe {
                    object_id: "rect-1".into(),
                    property: "x".into(),
                    keyframe: SceneKeyframe {
                        frame: 0,
                        value: 10.0,
                        easing: SceneEasing::Linear,
                        bezier: None,
                    },
                })],
            ),
        );
        let before = workspace.view(session).unwrap();
        let refused = refusal(
            &mut workspace,
            EditorCommand::Undo(Undo {
                session,
                module: Some(EditorModule::ObjectManager),
            }),
        );
        assert!(
            matches!(&refused, Refusal::HistoryConflict { direction: HistoryDirection::Undo, detail, .. } if detail.starts_with("[sceneObjectUnknown]")),
            "{refused:?}"
        );
        assert_eq!(workspace.view(session).unwrap(), before);
        // Undoing in order still works: the key first, then the object.
        run(&mut workspace, undo(session));
        run(&mut workspace, undo(session));
        assert!(workspace.view(session).unwrap().document.objects.is_empty());
    }

    // --- the change history list (11.82) -----------------------------------

    fn go_to(session: SessionKey, step: Option<u32>) -> EditorCommand {
        EditorCommand::GoToHistoryStep(GoToHistoryStep { session, step })
    }

    fn applied(workspace: &Workspace, session: SessionKey) -> Vec<(u32, bool)> {
        workspace
            .history(session)
            .expect("the session is open")
            .steps
            .iter()
            .map(|step| (step.id, step.applied))
            .collect()
    }

    /// Four batches from three parts of the app, and the document's hash before any of them and
    /// after each one.
    fn four_steps(workspace: &mut Workspace, session: SessionKey) -> Vec<String> {
        let batches = vec![
            tagged(
                session,
                EditorModule::ObjectManager,
                vec![create_rect("Card")],
            ),
            tagged(
                session,
                EditorModule::Inspector,
                vec![set_field("rect-1", ObjectField::X(100.0))],
            ),
            tagged(
                session,
                EditorModule::ObjectManager,
                vec![SceneEdit::SetObjectVisible(SetObjectVisible {
                    object_id: "rect-1".into(),
                    visible: false,
                })],
            ),
            tagged(
                session,
                EditorModule::Inspector,
                vec![set_field("rect-1", ObjectField::Y(50.0))],
            ),
        ];
        let mut hashes = vec![content_hash(workspace, session)];
        for batch in batches {
            run(workspace, batch);
            hashes.push(content_hash(workspace, session));
        }
        hashes
    }

    #[test]
    fn the_history_lists_every_step_with_its_part_of_the_app_its_edits_and_what_it_was_about() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        assert_eq!(
            workspace.history(session).unwrap(),
            HistoryView {
                session,
                steps: Vec::new(),
                folded: 0,
                limit: MAX_HISTORY as u32,
            },
            "a scene just opened has no steps"
        );
        run(
            &mut workspace,
            tagged(
                session,
                EditorModule::ObjectManager,
                vec![
                    create_rect("Card"),
                    set_field("rect-1", ObjectField::X(10.0)),
                ],
            ),
        );
        run(
            &mut workspace,
            tagged(
                session,
                EditorModule::Inspector,
                vec![set_field("rect-1", ObjectField::Y(5.0))],
            ),
        );
        run(
            &mut workspace,
            tagged(
                session,
                EditorModule::Timeline,
                vec![SceneEdit::SetObjectLocked(SetObjectLocked {
                    object_id: "rect-1".into(),
                    locked: true,
                })],
            ),
        );
        run(&mut workspace, undo(session));
        let step = |id, module, edits: &[&str], about: Option<&str>, applied| HistoryStep {
            id,
            module,
            edits: edits.iter().map(|edit| (*edit).to_owned()).collect(),
            about: about.map(str::to_owned),
            applied,
        };
        assert_eq!(
            workspace.history(session).unwrap().steps,
            vec![
                // A batch of two edits lists both, and is about its first.
                step(
                    1,
                    EditorModule::ObjectManager,
                    &["createObject", "setObjectField"],
                    Some("Card"),
                    true
                ),
                step(
                    2,
                    EditorModule::Inspector,
                    &["setObjectField"],
                    Some("y"),
                    true
                ),
                // An edit that names nothing a reader knows says nothing, and an undone step
                // stays listed.
                step(3, EditorModule::Timeline, &["setObjectLocked"], None, false),
            ]
        );
        assert!(matches!(
            workspace.history(SessionKey(99)),
            Err(CommandError::Refused(Refusal::SessionUnknown { .. }))
        ));
    }

    #[test]
    fn going_to_a_step_gives_what_that_many_undos_give_and_redo_comes_forward_in_order() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        let hashes = four_steps(&mut workspace, session);

        // Back two steps in one move.
        let view = run(&mut workspace, go_to(session, Some(2)))
            .session
            .expect("a jump answers its session");
        assert_eq!((view.undo_depth, view.redo_depth), (2, 2));
        assert_eq!(content_hash(&workspace, session), hashes[2]);
        assert_eq!(
            applied(&workspace, session),
            vec![(1, true), (2, true), (3, false), (4, false)],
            "the later steps stay listed, undone"
        );
        // Redo comes forward one step at a time, in the order the steps were made.
        run(&mut workspace, redo(session));
        assert_eq!(content_hash(&workspace, session), hashes[3]);
        run(&mut workspace, redo(session));
        assert_eq!(content_hash(&workspace, session), hashes[4]);
        assert!(matches!(
            refusal(&mut workspace, redo(session)),
            Refusal::HistoryEmpty { .. }
        ));

        // To the scene as opened: nothing is left to undo, and every step can be redone.
        let view = run(&mut workspace, go_to(session, None)).session.unwrap();
        assert_eq!((view.undo_depth, view.redo_depth), (0, 4));
        assert_eq!(content_hash(&workspace, session), hashes[0]);
        assert!(matches!(
            refusal(&mut workspace, undo(session)),
            Refusal::HistoryEmpty { .. }
        ));
        // Undo after a jump goes one further back, as it does after an undo.
        run(&mut workspace, go_to(session, Some(3)));
        assert_eq!(content_hash(&workspace, session), hashes[3]);
        run(&mut workspace, undo(session));
        assert_eq!(content_hash(&workspace, session), hashes[2]);
        // Forward in one move, past a step Undo just took back.
        run(&mut workspace, go_to(session, Some(4)));
        assert_eq!(content_hash(&workspace, session), hashes[4]);
        assert_eq!(workspace.view(session).unwrap().redo_depth, 0);
    }

    #[test]
    fn going_to_a_step_applies_one_a_module_undo_had_skipped() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        let hashes = four_steps(&mut workspace, session);
        let inspector_undo = || {
            EditorCommand::Undo(Undo {
                session,
                module: Some(EditorModule::Inspector),
            })
        };
        run(&mut workspace, inspector_undo());
        run(&mut workspace, inspector_undo());
        assert_eq!(
            applied(&workspace, session),
            vec![(1, true), (2, false), (3, true), (4, false)],
            "the Inspector's two steps are undone around the Object Manager's"
        );

        run(&mut workspace, go_to(session, Some(3)));
        assert_eq!(
            applied(&workspace, session),
            vec![(1, true), (2, true), (3, true), (4, false)],
            "every step up to the one clicked is applied"
        );
        assert_eq!(content_hash(&workspace, session), hashes[3]);
        run(&mut workspace, redo(session));
        assert_eq!(content_hash(&workspace, session), hashes[4]);
    }

    #[test]
    fn going_where_the_session_already_is_changes_nothing_and_does_not_mark_it_edited() {
        let scratch = Scratch::new("history-noop");
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(&mut workspace, edit(session, vec![rename_scene("one")]));
        run(&mut workspace, edit(session, vec![rename_scene("two")]));
        run(
            &mut workspace,
            save(
                session,
                SaveTarget::File {
                    path: scratch.file("a.json"),
                },
            ),
        );
        let saved = workspace.view(session).unwrap();
        assert!(!saved.dirty);

        let view = run(&mut workspace, go_to(session, Some(2)))
            .session
            .unwrap();
        assert_eq!(
            view, saved,
            "the latest step is where the session already is"
        );

        let view = run(&mut workspace, go_to(session, Some(1)))
            .session
            .unwrap();
        assert!(view.dirty, "a jump that changed the scene is unsaved work");
        assert_eq!(view.document.name, "one");
    }

    #[test]
    fn a_step_that_is_no_longer_listed_refuses_by_name_and_changes_nothing() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(&mut workspace, edit(session, vec![rename_scene("one")]));
        run(&mut workspace, edit(session, vec![rename_scene("two")]));
        run(&mut workspace, go_to(session, Some(1)));
        // A new edit after going back forks the history: step 2 is gone for good.
        run(&mut workspace, edit(session, vec![rename_scene("three")]));
        assert_eq!(applied(&workspace, session), vec![(1, true), (3, true)]);
        assert!(matches!(
            refusal(&mut workspace, redo(session)),
            Refusal::HistoryEmpty { .. }
        ));

        let before = workspace.view(session).unwrap();
        assert_eq!(
            refusal(&mut workspace, go_to(session, Some(2))),
            Refusal::HistoryStepUnknown { session, step: 2 }
        );
        assert_eq!(
            refusal(&mut workspace, go_to(session, Some(0))),
            Refusal::HistoryStepUnknown { session, step: 0 }
        );
        assert_eq!(workspace.view(session).unwrap(), before);
        assert!(matches!(
            refusal(&mut workspace, go_to(SessionKey(99), None)),
            Refusal::SessionUnknown { .. }
        ));
    }

    #[test]
    fn steps_past_the_limit_are_counted_and_can_no_longer_be_reached() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        for index in 0..MAX_HISTORY + 3 {
            run(
                &mut workspace,
                edit(session, vec![rename_scene(&format!("edit {index}"))]),
            );
        }
        let history = workspace.history(session).unwrap();
        assert_eq!(history.steps.len(), MAX_HISTORY);
        assert_eq!(
            history.folded, 3,
            "the three oldest are part of the scene as opened"
        );
        assert_eq!(history.steps[0].id, 4);
        assert_eq!(
            refusal(&mut workspace, go_to(session, Some(3))),
            Refusal::HistoryStepUnknown { session, step: 3 }
        );
        // The scene as opened is now the scene after the folded steps.
        run(&mut workspace, go_to(session, None));
        assert_eq!(name_of(&workspace, session), "edit 2");
    }

    /// A replay that refuses is all or nothing. No command leaves a history whose first steps
    /// cannot be replayed, so this breaks one by hand.
    #[test]
    fn a_jump_whose_replay_refuses_puts_every_step_back_and_names_the_direction() {
        let broken = vec![SceneEdit::RenameObject(RenameObject {
            object_id: "missing".into(),
            name: "Nope".into(),
        })];

        // Forward: both steps undone, the first now impossible.
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(&mut workspace, edit(session, vec![rename_scene("one")]));
        run(&mut workspace, edit(session, vec![rename_scene("two")]));
        run(&mut workspace, go_to(session, None));
        workspace.sessions[0].log[0].edits = broken.clone();
        let before = workspace.view(session).unwrap();
        let refused = refusal(&mut workspace, go_to(session, Some(2)));
        assert!(
            matches!(&refused, Refusal::HistoryConflict { session: key, direction: HistoryDirection::Redo, detail } if *key == session && detail.starts_with("[sceneObjectUnknown]")),
            "{refused:?}"
        );
        assert_eq!(workspace.view(session).unwrap(), before);
        assert_eq!(applied(&workspace, session), vec![(1, false), (2, false)]);
        assert_eq!(workspace.sessions[0].redo, vec![2, 1]);

        // Back: both steps applied, the first now impossible.
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(&mut workspace, edit(session, vec![rename_scene("one")]));
        run(&mut workspace, edit(session, vec![rename_scene("two")]));
        workspace.sessions[0].log[0].edits = broken;
        let before = workspace.view(session).unwrap();
        let refused = refusal(&mut workspace, go_to(session, Some(1)));
        assert!(
            matches!(
                &refused,
                Refusal::HistoryConflict {
                    direction: HistoryDirection::Undo,
                    ..
                }
            ),
            "{refused:?}"
        );
        assert_eq!(workspace.view(session).unwrap(), before);
        assert_eq!(applied(&workspace, session), vec![(1, true), (2, true)]);
        assert!(workspace.sessions[0].redo.is_empty());
    }

    // --- save as next version (11.30) ----------------------------------------

    fn next_version(session: SessionKey) -> EditorCommand {
        EditorCommand::SaveScene(SaveScene {
            session,
            to: SaveTarget::NextVersion,
        })
    }

    fn stored_bytes(scratch: &Scratch, scene_id: &str) -> Vec<u8> {
        std::fs::read(
            scratch
                .0
                .join("projects")
                .join("news")
                .join("scenes")
                .join(format!("{scene_id}.json")),
        )
        .unwrap_or_else(|error| panic!("scene {scene_id} is not stored: {error}"))
    }

    fn stored_ids(workspace: &Workspace) -> Vec<String> {
        workspace
            .projects()
            .expect("a store")
            .list_scenes("news")
            .expect("the scenes list")
    }

    #[test]
    fn splitting_a_number_off_an_id_a_name_and_a_file() {
        assert_eq!(split_version("strap", '_'), ("strap", None));
        assert_eq!(split_version("strap_v003", '_'), ("strap", Some(3)));
        assert_eq!(split_version("strap_v2", '_'), ("strap", Some(2)));
        assert_eq!(split_version("a_b_v010", '_'), ("a_b", Some(10)));
        assert_eq!(split_version("Strap v007", ' '), ("Strap", Some(7)));
        // Not numbers: no digits, a word, zero, a name that is only the number.
        assert_eq!(split_version("strap_v", '_'), ("strap_v", None));
        assert_eq!(split_version("strap_vx1", '_'), ("strap_vx1", None));
        // `parse` would accept a sign; a version number is digits and nothing else.
        assert_eq!(split_version("strap_v+3", '_'), ("strap_v+3", None));
        assert_eq!(split_version("strap_v000", '_'), ("strap_v000", None));
        assert_eq!(split_version("_v002", '_'), ("_v002", None));
        assert_eq!(
            split_version("Version v2 final", ' '),
            ("Version v2 final", None)
        );
        assert_eq!(versioned_name("Strap", 2), "Strap v002");
        assert_eq!(versioned_name("  Strap v007 ", 8), "Strap v008");
        assert_eq!(versioned_name("Lower third", 12), "Lower third v012");
    }

    #[test]
    fn the_next_version_id_follows_the_current_number_and_passes_over_those_taken() {
        let none = |_: &str| false;
        assert_eq!(
            next_version_id("strap", none),
            Some(("strap_v002".into(), 2))
        );
        assert_eq!(
            next_version_id("strap_v003", none),
            Some(("strap_v004".into(), 4))
        );
        // A number already taken is passed over, and a gap below the current one is not filled.
        let taken = |id: &str| id == "strap_v002" || id == "strap_v004";
        assert_eq!(
            next_version_id("strap", taken),
            Some(("strap_v003".into(), 3))
        );
        assert_eq!(
            next_version_id("strap_v003", taken),
            Some(("strap_v005".into(), 5))
        );
        // Past three digits the number simply grows; at the last number there is none left.
        assert_eq!(
            next_version_id("s_v999", none),
            Some(("s_v1000".into(), 1000))
        );
        assert_eq!(next_version_id("s_v9999", none), None);
        assert_eq!(next_version_id("s", |_| true), None);
    }

    #[test]
    fn a_next_version_of_a_stored_scene_holds_the_unsaved_edits_and_leaves_the_old_one_untouched() {
        let (scratch, mut workspace) = with_store("version-project");
        let session = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(session, vec![create_rect("Card")]));
        let before = stored_bytes(&scratch, "b");

        let outcome = run(&mut workspace, next_version(session));
        let view = outcome.session.expect("a save reports its session");
        assert_eq!(view.document.id, "b_v002");
        assert_eq!(view.document.name, "B v002");
        assert_eq!(
            view.origin,
            Some(SceneOrigin {
                project: "news".into(),
                scene_id: "b_v002".into()
            })
        );
        assert_eq!((view.dirty, view.project_dirty), (false, false));
        assert_eq!(view.path, None);
        assert_eq!(outcome.revision, Some(Revision(0)));
        assert!(matches!(
            outcome.effects.as_slice(),
            [EditEffect::Stored { origin, .. }] if origin.scene_id == "b_v002"
        ));

        // The old version is byte for byte what it was last saved as; the new one has the edit.
        assert_eq!(stored_bytes(&scratch, "b"), before);
        assert_eq!(stored_ids(&workspace), vec!["b", "b_v002"]);
        let stored = stored_scene(&workspace, "b_v002");
        assert_eq!(
            (stored.id.as_str(), stored.name.as_str()),
            ("b_v002", "B v002")
        );
        assert_eq!(stored.objects.len(), 1);
        assert_eq!(stored.revision, None);
        assert!(stored_scene(&workspace, "b").objects.is_empty());
        assert_eq!(workspace.sessions[0].base, stored);
    }

    #[test]
    fn the_new_version_starts_a_fresh_history_and_goes_on_from_its_own_number() {
        let (scratch, mut workspace) = with_store("version-history");
        let session = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(session, vec![create_rect("One")]));
        run(&mut workspace, edit(session, vec![create_rect("Two")]));
        run(&mut workspace, undo(session));
        run(&mut workspace, next_version(session));
        let view = workspace.view(session).unwrap();
        assert_eq!((view.undo_depth, view.redo_depth), (0, 0));
        assert!(workspace.history(session).unwrap().steps.is_empty());
        assert!(matches!(
            refusal(&mut workspace, undo(session)),
            Refusal::HistoryEmpty { .. }
        ));
        // The scene is what was on screen when the version was saved, one rect, and can be edited on.
        assert_eq!(view.document.objects.len(), 1);
        run(
            &mut workspace,
            edit(session, vec![rename_scene("Third try")]),
        );
        assert!(workspace.view(session).unwrap().dirty);

        // A save in place goes to the version, never back to the scene it came from, and it gives
        // the version a revision of its own.
        run(&mut workspace, save(session, SaveTarget::Origin));
        assert_eq!(stored_scene(&workspace, "b_v002").name, "Third try");
        assert_eq!(stored_scene(&workspace, "b").name, "B");
        assert!(stored_scene(&workspace, "b_v002").revision.is_some());

        // The next one numbers from this one, and its base is `b`, not `b_v002`.
        run(&mut workspace, next_version(session));
        assert_eq!(stored_ids(&workspace), vec!["b", "b_v002", "b_v003"]);
        assert_eq!(stored_scene(&workspace, "b_v003").name, "Third try v003");
        // A new version is unpublished: it does not carry the revision of the one it came from.
        assert_eq!(stored_scene(&workspace, "b_v003").revision, None);
        let _ = scratch;
    }

    #[test]
    fn a_stored_scene_that_was_also_saved_to_a_file_does_not_keep_pointing_at_the_old_versions_file(
    ) {
        let (scratch, mut workspace) = with_store("version-path");
        let session = open_stored(&mut workspace, "b");
        let path = scratch.file("b.json");
        run(
            &mut workspace,
            save(session, SaveTarget::File { path: path.clone() }),
        );
        assert_eq!(
            workspace.view(session).unwrap().path.as_deref(),
            Some(path.as_str())
        );
        let view = run(&mut workspace, next_version(session)).session.unwrap();
        assert_eq!(
            view.path, None,
            "the new version was not saved to the old version's file"
        );
        assert!(std::path::Path::new(&path).exists());
    }

    #[test]
    fn a_number_already_stored_is_passed_over_by_the_next_version() {
        let (_scratch, mut workspace) = with_store("version-taken");
        for id in ["b_v002", "b_v003"] {
            run(
                &mut workspace,
                EditorCommand::DuplicateScene(gx_contracts::command::DuplicateScene {
                    project: "news".into(),
                    source_scene_id: "b".into(),
                    scene_id: id.into(),
                    name: id.into(),
                }),
            );
        }
        let session = open_stored(&mut workspace, "b");
        run(&mut workspace, next_version(session));
        assert_eq!(workspace.view(session).unwrap().document.id, "b_v004");
        assert_eq!(
            stored_ids(&workspace),
            vec!["b", "b_v002", "b_v003", "b_v004"]
        );
    }

    #[test]
    fn a_next_version_of_a_scene_saved_to_a_file_is_the_next_numbered_file_and_keeps_the_history() {
        let scratch = Scratch::new("version-file");
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "A");
        run(&mut workspace, edit(session, vec![rename_scene("One")]));
        let path = scratch.file("strap.json");
        run(
            &mut workspace,
            save(session, SaveTarget::File { path: path.clone() }),
        );
        let first = std::fs::read(&path).unwrap();
        run(&mut workspace, edit(session, vec![rename_scene("Two")]));

        let view = run(&mut workspace, next_version(session))
            .session
            .expect("a save reports its session");
        let second = scratch.file("strap_v002.json");
        assert_eq!(view.path.as_deref(), Some(second.as_str()));
        assert!(!view.dirty);
        // The first file is as it was saved; the new one holds the later edit; the history stays.
        assert_eq!(std::fs::read(&path).unwrap(), first);
        assert_eq!(read_scene_file(&second).unwrap().name, "Two");
        assert_eq!(view.undo_depth, 2);
        run(&mut workspace, undo(session));
        assert_eq!(name_of(&workspace, session), "One");

        // Again: the number after this one. A file in the way is passed over.
        std::fs::write(scratch.file("strap_v003.json"), b"{}").unwrap();
        run(&mut workspace, next_version(session));
        assert_eq!(
            workspace.view(session).unwrap().path.as_deref(),
            Some(scratch.file("strap_v004.json").as_str())
        );
        assert_eq!(
            std::fs::read(scratch.file("strap_v003.json")).unwrap(),
            b"{}"
        );
    }

    #[test]
    fn a_scene_never_saved_has_no_version_to_number_and_a_failed_write_changes_nothing() {
        let (scratch, mut workspace) = with_store("version-refused");
        let unsaved = open_new(&mut workspace, "fresh", "Fresh");
        run(&mut workspace, edit(unsaved, vec![rename_scene("Edited")]));
        let before = workspace.view(unsaved).unwrap();
        assert_eq!(
            refusal(&mut workspace, next_version(unsaved)),
            Refusal::SessionUnbound { session: unsaved }
        );
        assert_eq!(workspace.view(unsaved).unwrap(), before);

        // The project is gone from under a bound scene: the write fails and the session is as it was.
        let bound = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(bound, vec![create_rect("Card")]));
        let before = workspace.view(bound).unwrap();
        std::fs::remove_dir_all(scratch.0.join("projects").join("news")).unwrap();
        assert!(workspace.execute(next_version(bound)).is_err());
        assert_eq!(workspace.view(bound).unwrap(), before);
        assert_eq!(workspace.history(bound).unwrap().steps.len(), 1);
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
        assert_eq!(
            name_of(&workspace, again),
            "B edited",
            "the open edits were not replaced by the stored copy"
        );
    }

    #[test]
    fn closing_a_scene_with_unsaved_changes_is_refused_by_name_until_forced_or_saved() {
        let scratch = Scratch::new("close");
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "lower-third", "Lower third");
        run(
            &mut workspace,
            edit(session, vec![rename_scene("Lower third v2")]),
        );

        match refusal(&mut workspace, close(session, false)) {
            Refusal::SessionHasUnsavedChanges { session: key, name } => {
                assert_eq!((key, name.as_str()), (session, "Lower third v2"));
            }
            other => panic!("expected SessionHasUnsavedChanges, got {other:?}"),
        }
        assert!(
            workspace.view(session).is_ok(),
            "the refused close kept the scene open"
        );

        // Saving clears the block.
        run(
            &mut workspace,
            save(
                session,
                SaveTarget::File {
                    path: scratch.file("lower-third.json"),
                },
            ),
        );
        run(&mut workspace, close(session, false));

        // So does explicit confirmation.
        let other = open_new(&mut workspace, "other", "Other");
        run(&mut workspace, edit(other, vec![rename_scene("Other v2")]));
        run(&mut workspace, close(other, true));
        assert!(matches!(
            workspace.view(other),
            Err(CommandError::Refused(Refusal::SessionUnknown { .. }))
        ));
        assert!(matches!(
            refusal(&mut workspace, close(other, true)),
            Refusal::SessionUnknown { .. }
        ));
    }

    #[test]
    fn a_session_target_that_is_not_open_is_refused() {
        // The MCP case: a fresh workspace has no sessions.
        let mut workspace = Workspace::new(None);
        assert!(matches!(
            refusal(&mut workspace, edit(SessionKey(7), vec![rename_scene("x")])),
            Refusal::SessionUnknown {
                session: SessionKey(7)
            }
        ));
        assert!(matches!(
            workspace.document(&SceneTarget::Session {
                session: SessionKey(7)
            }),
            Err(CommandError::Refused(Refusal::SessionUnknown { .. }))
        ));
    }

    // --- unsaved marks (workspace-dirty.test.ts) ---------------------------

    #[test]
    fn an_edit_marks_project_unsaved_only_for_a_bound_scene() {
        let (_scratch, mut workspace) = with_store("marks");
        let unbound = open_new(&mut workspace, "a", "A");
        let bound = open_stored(&mut workspace, "b");
        run(
            &mut workspace,
            edit(unbound, vec![rename_scene("A edited")]),
        );
        run(&mut workspace, edit(bound, vec![rename_scene("B edited")]));
        let (unbound, bound) = (
            workspace.view(unbound).unwrap(),
            workspace.view(bound).unwrap(),
        );
        assert_eq!((unbound.dirty, unbound.project_dirty), (true, false));
        assert_eq!((bound.dirty, bound.project_dirty), (true, true));
    }

    #[test]
    fn undo_and_redo_are_edits_for_the_unsaved_mark() {
        let scratch = Scratch::new("undo-dirty");
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace, "a", "a");
        run(&mut workspace, edit(session, vec![rename_scene("edited")]));
        run(
            &mut workspace,
            save(
                session,
                SaveTarget::File {
                    path: scratch.file("a.json"),
                },
            ),
        );
        run(&mut workspace, undo(session));
        assert!(
            workspace.view(session).unwrap().dirty,
            "an undo after a save is unsaved work"
        );
        assert!(matches!(
            refusal(&mut workspace, close(session, false)),
            Refusal::SessionHasUnsavedChanges { .. }
        ));
    }

    #[test]
    fn saving_to_a_file_clears_the_unsaved_mark_and_leaves_the_project_copy_stale() {
        let (scratch, mut workspace) = with_store("file-save");
        let bound = open_stored(&mut workspace, "b");
        run(&mut workspace, edit(bound, vec![rename_scene("B edited")]));
        let path = scratch.file("b.json");
        let view = run(
            &mut workspace,
            save(bound, SaveTarget::File { path: path.clone() }),
        )
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

        let outcome = run(
            &mut workspace,
            save(
                session,
                SaveTarget::Project {
                    project: "news".into(),
                },
            ),
        );
        let view = outcome.session.expect("a save reports its session");
        let origin = SceneOrigin {
            project: "news".into(),
            scene_id: "untitled".into(),
        };
        assert_eq!(view.origin.as_ref(), Some(&origin));
        assert_eq!((view.dirty, view.project_dirty), (false, false));
        assert_eq!(
            outcome.effects,
            vec![EditEffect::Stored {
                origin,
                scene_label: None
            }]
        );
        assert_eq!(stored_scene(&workspace, "untitled").name, "Strap");

        // Create never overwrites; a bound scene's id is stable.
        assert!(matches!(
            refusal(
                &mut workspace,
                save(
                    session,
                    SaveTarget::Project {
                        project: "news".into()
                    }
                )
            ),
            Refusal::SceneAlreadyExists { .. }
        ));
        assert!(matches!(
            refusal(
                &mut workspace,
                edit(
                    session,
                    vec![SceneEdit::SetSceneId(SetSceneId {
                        id: "renamed".into()
                    })]
                )
            ),
            Refusal::SceneIdBound { .. }
        ));

        // Update writes the bound copy.
        run(
            &mut workspace,
            edit(session, vec![rename_scene("Strap v2")]),
        );
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
        run(
            &mut workspace,
            save(authored, SaveTarget::File { path: path.clone() }),
        );
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
        let mut document = serde_json::to_value(new_scene(
            "demo",
            "Demo",
            gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
        ))
        .unwrap();
        document["notAField"] = serde_json::json!(true);
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();

        let mut workspace = Workspace::new(None);
        let refused = refusal(
            &mut workspace,
            EditorCommand::OpenScene(OpenScene {
                source: SceneSource::File { path },
            }),
        );
        assert!(
            refused.to_string().contains("notAField"),
            "the refusal names the field: {refused}"
        );
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
                SceneKeyframe {
                    frame: 0,
                    value: 0.0,
                    easing: SceneEasing::CustomBezier,
                    bezier: None,
                },
                SceneKeyframe {
                    frame: 50,
                    value: 100.0,
                    easing: SceneEasing::Linear,
                    bezier: None,
                },
            ],
        });
        std::fs::write(&path, serde_json::to_vec(&scene).unwrap()).unwrap();

        let mut workspace = Workspace::new(None);
        let refused = refusal(
            &mut workspace,
            EditorCommand::OpenScene(OpenScene {
                source: SceneSource::File { path },
            }),
        );
        let text = refused.to_string();
        assert!(
            text.contains("card") && text.contains("custom-bezier"),
            "names the object and easing: {text}"
        );
    }

    #[test]
    fn an_unreadable_file_is_a_store_failure_not_a_refusal() {
        let scratch = Scratch::new("unreadable");
        let mut workspace = Workspace::new(None);
        let error = workspace
            .execute(EditorCommand::OpenScene(OpenScene {
                source: SceneSource::File {
                    path: scratch.file("absent.json"),
                },
            }))
            .expect_err("a missing file cannot open");
        assert!(
            matches!(error, CommandError::Store(EditorError::Io { .. })),
            "{error:?}"
        );
    }

    // --- projects and scenes (shell project tests) --------------------------

    /// 3.15: `CreateScene` gives the scene its project's declared space,
    /// sRGB for a new project and linear for one created before 3.15.
    #[test]
    fn a_created_scene_composites_in_its_projects_space() {
        let (scratch, mut workspace) = with_store("working-space");
        let projects = scratch.projects();
        assert_eq!(
            projects
                .read_scene("news", "b")
                .unwrap()
                .working_color_space,
            gx_contracts::color::WorkingColorSpace::Srgb
        );
        std::fs::remove_file(projects.gpx_path("news")).unwrap();
        run(
            &mut workspace,
            EditorCommand::CreateScene(CreateScene {
                project: "news".into(),
                scene_id: "legacy".into(),
                name: "Legacy".into(),
            }),
        );
        assert_eq!(
            projects
                .read_scene("news", "legacy")
                .unwrap()
                .working_color_space,
            gx_contracts::color::WorkingColorSpace::LinearSrgb
        );
    }

    #[test]
    fn project_and_scene_commands_refuse_duplicates_and_paths_by_name() {
        let (_scratch, mut workspace) = with_store("crud");
        assert!(matches!(
            refusal(&mut workspace, EditorCommand::CreateProject(CreateProject { project: "news".into() })),
            Refusal::ProjectAlreadyExists { project } if project == "news"
        ));
        assert!(matches!(
            refusal(
                &mut workspace,
                EditorCommand::CreateProject(CreateProject {
                    project: "../escape".into()
                })
            ),
            Refusal::ProjectNameInvalid { .. }
        ));
        let create = |scene_id: &str, name: &str| {
            EditorCommand::CreateScene(CreateScene {
                project: "news".into(),
                scene_id: scene_id.into(),
                name: name.into(),
            })
        };
        assert!(matches!(
            refusal(&mut workspace, create("b", "Again")),
            Refusal::SceneAlreadyExists { .. }
        ));
        assert!(matches!(
            refusal(&mut workspace, create("../escape", "Escape")),
            Refusal::SceneIdInvalid { .. }
        ));
        assert!(matches!(
            refusal(&mut workspace, create("c", "   ")),
            Refusal::SceneNameEmpty
        ));
        assert!(matches!(
            refusal(
                &mut workspace,
                EditorCommand::CreateScene(CreateScene {
                    project: "nope".into(),
                    scene_id: "c".into(),
                    name: "C".into()
                })
            ),
            Refusal::ProjectNotFound { .. }
        ));

        let delete = || {
            EditorCommand::DeleteScene(DeleteScene {
                project: "news".into(),
                scene_id: "b".into(),
                if_revision: None,
            })
        };
        run(&mut workspace, delete());
        assert!(matches!(
            refusal(&mut workspace, delete()),
            Refusal::SceneNotStored { .. }
        ));
    }

    #[test]
    fn project_commands_without_a_store_refuse_by_name() {
        let mut workspace = Workspace::new(None);
        assert!(matches!(
            refusal(
                &mut workspace,
                EditorCommand::CreateProject(CreateProject {
                    project: "news".into()
                })
            ),
            Refusal::PlatformDirectoryUnavailable { .. }
        ));
    }

    #[test]
    fn scene_creation_fills_the_first_free_label_without_changing_existing_scenes() {
        let (scratch, mut workspace) = with_store("scene-labels");
        let label = |workspace: &Workspace, id| stored_scene(workspace, id).scene_label;
        assert_eq!(label(&workspace, "b").as_deref(), Some("1"));
        let original = stored_bytes(&scratch, "b");
        for (id, expected) in [("second", "2"), ("third", "3")] {
            let outcome = run(
                &mut workspace,
                EditorCommand::CreateScene(CreateScene {
                    project: "news".into(),
                    scene_id: id.into(),
                    name: id.into(),
                }),
            );
            assert_eq!(label(&workspace, id).as_deref(), Some(expected));
            assert!(matches!(
                outcome.effects.as_slice(),
                [EditEffect::Stored { scene_label: Some(label), .. }] if label == expected
            ));
        }
        run(
            &mut workspace,
            EditorCommand::DeleteScene(DeleteScene {
                project: "news".into(),
                scene_id: "second".into(),
                if_revision: None,
            }),
        );
        run(
            &mut workspace,
            EditorCommand::DuplicateScene(DuplicateScene {
                project: "news".into(),
                source_scene_id: "b".into(),
                scene_id: "copy".into(),
                name: "Copy".into(),
            }),
        );
        assert_eq!(label(&workspace, "copy").as_deref(), Some("2"));
        let imported = import_into_project(
            &scratch.projects(), "news", "svg", Some("SVG"), "fixture.svg",
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>"#,
        ).unwrap();
        assert_eq!(imported.scene.scene_label.as_deref(), Some("4"));
        assert_eq!(label(&workspace, "svg").as_deref(), Some("4"));
        assert_eq!(label(&workspace, "third").as_deref(), Some("3"));
        assert_eq!(stored_bytes(&scratch, "b"), original);
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
        assert_eq!(
            (copy.id.as_str(), copy.name.as_str(), copy.revision),
            ("lower-third-copy", "Lower third copy", None)
        );
        assert_eq!(copy.objects, published.objects);
        assert_eq!(
            stored_scene(&workspace, "lower-third"),
            published,
            "the source is untouched"
        );

        assert!(matches!(
            refusal(&mut workspace, duplicate("b")),
            Refusal::SceneAlreadyExists { .. }
        ));
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
        run(
            &mut workspace,
            edit(session, vec![rename_scene("B edited")]),
        );
        let delete = || {
            EditorCommand::DeleteScene(DeleteScene {
                project: "news".into(),
                scene_id: "b".into(),
                if_revision: None,
            })
        };
        assert!(matches!(
            refusal(&mut workspace, delete()),
            Refusal::SessionHasUnsavedChanges { session: key, .. } if key == session
        ));
        assert_eq!(scratch.projects().list_scenes("news").unwrap(), vec!["b"]);

        run(&mut workspace, save(session, SaveTarget::Origin));
        let outcome = run(&mut workspace, delete());
        let view = outcome.session.expect("the bound session is reported");
        assert_eq!(
            (view.session, view.origin, view.project_dirty),
            (session, None, false)
        );
        assert_eq!(
            view.document.name, "B edited",
            "the document remains open outside the project"
        );
        assert!(scratch.projects().list_scenes("news").unwrap().is_empty());
    }

    #[test]
    fn a_stored_edit_writes_the_store_atomically_and_opens_nothing() {
        let (_scratch, mut workspace) = with_store("stored-edit");
        let outcome = run(
            &mut workspace,
            stored_edit("b", vec![rename_scene("B via MCP")]),
        );
        assert_eq!(outcome.session, None);
        assert!(outcome.effects.contains(&EditEffect::Stored {
            scene_label: None,
            origin: SceneOrigin {
                project: "news".into(),
                scene_id: "b".into()
            }
        }));
        assert_eq!(stored_scene(&workspace, "b").name, "B via MCP");
        assert!(workspace.sessions.is_empty());

        let refused = refusal(
            &mut workspace,
            stored_edit(
                "b",
                vec![
                    rename_scene("never lands"),
                    SceneEdit::RenameObject(RenameObject {
                        object_id: "missing".into(),
                        name: "x".into(),
                    }),
                ],
            ),
        );
        assert!(matches!(refused, Refusal::SceneObjectUnknown { .. }));
        assert_eq!(stored_scene(&workspace, "b").name, "B via MCP");
        assert!(matches!(
            refusal(
                &mut workspace,
                stored_edit(
                    "b",
                    vec![SceneEdit::SetSceneId(SetSceneId { id: "c".into() })]
                )
            ),
            Refusal::SceneIdBound { .. }
        ));
    }

    /// The bindings of every object, by id.
    fn bindings_by_object(
        scene: &SceneDocument,
    ) -> BTreeMap<String, Option<serde_json::Map<String, serde_json::Value>>> {
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
        let mut scene = new_scene(
            "scorebug",
            "Scorebug",
            gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
        );
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
            provenance: Default::default(),
            color_space: None,
        });
        let mut bar = ObjectBase::new("bar", "Bar");
        bar.width = 640.0;
        bar.height = 72.0;
        bar.bindings = Some(binding_map(&[
            ("x", "match.home.x"),
            ("visible", "flags.0"),
        ]));
        scene.objects.push(SceneObject::Rect(RectObject {
            base: bar,
            radius: 4.0,
        }));
        let mut logo = ObjectBase::new("logo", "Logo");
        logo.width = 64.0;
        logo.height = 64.0;
        logo.bindings = Some(binding_map(&[("assetId", "match.home.logo")]));
        scene.objects.push(SceneObject::Image(ImageObject {
            base: logo,
            asset_id: "home-logo".into(),
            fit: Default::default(),
            slice: None,
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
        run(
            &mut workspace,
            save(
                session,
                SaveTarget::Project {
                    project: "news".into(),
                },
            ),
        );

        let reopen = || {
            let mut fresh = Workspace::new(Some(scratch.projects()));
            let key = open_stored(&mut fresh, "scorebug");
            fresh.view(key).unwrap().document
        };
        let reopened = reopen();
        assert_eq!(
            reopened, authored,
            "the whole bound document survives save/reopen"
        );
        assert_eq!(
            reopened.data_context["match"]["alpha"]
                .as_f64()
                .map(f64::to_bits),
            Some((48.0_f64 / 255.0).to_bits()),
            "a non-dyadic data-context float reopens bit for bit"
        );

        // Re-point one binding and remove another, as one gesture.
        run(
            &mut workspace,
            edit(
                session,
                vec![
                    bind("bar", "x", Some("match.away.x")),
                    bind("bar", "visible", None),
                ],
            ),
        );
        run(&mut workspace, save(session, SaveTarget::Origin));
        assert_eq!(
            bindings_by_object(&reopen()),
            BTreeMap::from([
                (
                    "bar".to_owned(),
                    Some(binding_map(&[("x", "match.away.x")]))
                ),
                (
                    "logo".to_owned(),
                    Some(binding_map(&[("assetId", "match.home.logo")]))
                ),
            ])
        );

        // Remove every binding. Absent means absent: not `null`, not `{}`.
        run(
            &mut workspace,
            edit(
                session,
                vec![bind("bar", "x", None), bind("logo", "assetId", None)],
            ),
        );
        run(&mut workspace, save(session, SaveTarget::Origin));
        assert!(bindings_by_object(&reopen()).values().all(Option::is_none));
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(scratch.0.join("projects/news/scenes/scorebug.json")).unwrap(),
        )
        .unwrap();
        for object in raw["objects"].as_array().expect("objects on disk") {
            assert!(
                object.get("bindings").is_none(),
                "an unbound object carries no bindings key: {object}"
            );
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
                    SceneEdit::CreateObject(CreateObject {
                        kind: "rect".into(),
                        name: "Background".into(),
                    }),
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
        let save_page = |page: TakePage| {
            EditorCommand::SaveTakePage(SaveTakePage {
                project: "news".into(),
                page,
            })
        };

        assert!(matches!(
            refusal(&mut workspace, save_page(page("absent"))),
            Refusal::SceneNotStored { .. }
        ));
        let outcome = run(&mut workspace, save_page(page("b")));
        assert_eq!(
            outcome.effects,
            vec![EditEffect::TakePageSaved {
                project: "news".into(),
                page_id: "headlines-at-six".into()
            }]
        );
        assert_eq!(
            scratch
                .projects()
                .read_take_page("news", "headlines-at-six")
                .unwrap(),
            page("b")
        );
        assert_eq!(
            stored_scene(&workspace, "b"),
            template,
            "saving a page must not overwrite its template"
        );
    }

    // --- motion presets (11.15) ---------------------------------------------

    #[test]
    fn saving_selected_keys_grows_the_project_library_and_the_preset_applies_and_undoes() {
        use gx_contracts::animation::KeyRef;

        let (scratch, mut workspace) = with_store("motion-preset");
        let apply = |object: &str, preset: &str, phase: PresetPhase, at_frame: u64| {
            SceneEdit::ApplyPreset(gx_contracts::command::ApplyPreset {
                object_id: object.into(),
                preset_id: preset.into(),
                phase,
                at_frame,
                duration_ms: None,
            })
        };
        run(
            &mut workspace,
            stored_edit(
                "b",
                vec![
                    SceneEdit::CreateObject(CreateObject {
                        kind: "rect".into(),
                        name: "One".into(),
                    }),
                    SceneEdit::CreateObject(CreateObject {
                        kind: "rect".into(),
                        name: "Two".into(),
                    }),
                    apply("rect-1", "slide", PresetPhase::In, 10),
                    apply("rect-1", "slide", PresetPhase::Out, 80),
                ],
            ),
        );
        let keys = |frames: [u64; 2]| -> Vec<KeyRef> {
            frames
                .iter()
                .map(|frame| KeyRef {
                    property: "x".into(),
                    frame: *frame,
                })
                .collect()
        };
        let save = |phase: PresetPhase, frames: [u64; 2], id: &str| {
            EditorCommand::SaveMotionPreset(SaveMotionPreset {
                project: "news".into(),
                target: SceneTarget::Stored {
                    project: "news".into(),
                    scene_id: "b".into(),
                },
                object_id: "rect-1".into(),
                preset_id: id.into(),
                phase,
                keys: keys(frames),
            })
        };
        let before = stored_scene(&workspace, "b");

        // A starter id is refused, never shadowed.
        assert_eq!(
            refusal(&mut workspace, save(PresetPhase::In, [10, 30], "slide")),
            Refusal::MotionPresetIdInvalid {
                preset_id: "slide".into()
            }
        );
        assert!(matches!(
            refusal(&mut workspace, save(PresetPhase::In, [10, 30], "../escape")),
            Refusal::MotionPresetIdInvalid { .. }
        ));
        assert!(scratch
            .projects()
            .motion_presets("news")
            .unwrap()
            .is_empty());

        // The first phase saved leaves the preset unusable by name; saving the
        // out phase completes it.
        let outcome = run(&mut workspace, save(PresetPhase::In, [10, 30], "my-slide"));
        assert_eq!(
            outcome.effects,
            vec![EditEffect::MotionPresetSaved {
                project: "news".into(),
                preset_id: "my-slide".into(),
                phase: PresetPhase::In,
            }]
        );
        let first = scratch
            .projects()
            .read_motion_preset("news", "my-slide")
            .unwrap()
            .unwrap();
        assert!(first.validate().is_err(), "no out phase yet");
        assert_eq!(first.applies_to, vec!["rect".to_owned()]);
        run(&mut workspace, save(PresetPhase::Out, [80, 96], "my-slide"));
        let saved = scratch
            .projects()
            .read_motion_preset("news", "my-slide")
            .unwrap()
            .unwrap();
        assert!(saved.validate().is_ok());
        assert_eq!(saved.phases.out.channels.len(), 1);
        assert_eq!(
            stored_scene(&workspace, "b"),
            before,
            "saving a preset only reads the scene"
        );

        // The saved preset applies from a session bound to the project, as
        // one undoable gesture, and survives redo (the replay keeps its library).
        let session = open(
            &mut workspace,
            SceneSource::Project {
                project: "news".into(),
                scene_id: "b".into(),
            },
        );
        let applied = run(
            &mut workspace,
            edit(
                session,
                vec![apply("rect-2", "my-slide", PresetPhase::In, 0)],
            ),
        );
        assert!(
            matches!(applied.effects[0], EditEffect::PresetApplied { duration_frames } if duration_frames > 0)
        );
        let keyed = |workspace: &Workspace| {
            workspace
                .document(&SceneTarget::Session { session })
                .unwrap()
                .timeline
                .channels
                .iter()
                .filter(|channel| channel.object_id == "rect-2")
                .map(|channel| channel.keys.len())
                .sum::<usize>()
        };
        assert_eq!(keyed(&workspace), 2);
        run(&mut workspace, undo(session));
        assert_eq!(keyed(&workspace), 0);
        run(&mut workspace, redo(session));
        assert_eq!(keyed(&workspace), 2);

        // An unsaved project id is still unknown.
        assert!(matches!(
            refusal(
                &mut workspace,
                edit(
                    session,
                    vec![apply("rect-2", "nobody-saved-this", PresetPhase::In, 0)]
                )
            ),
            Refusal::MotionPresetUnknown { .. }
        ));
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
                commit: DesignSystemCommit {
                    draft: draft.clone(),
                    confirmed_by: confirmed_by.into(),
                },
            })
        };
        assert!(
            workspace.execute(confirm("   ")).is_err(),
            "nobody confirmed it, so it is not confirmed"
        );
        for version in [1, 2] {
            assert_eq!(
                run(&mut workspace, confirm("head-of-design")).effects,
                vec![EditEffect::DesignSystemConfirmed {
                    project: "news".into(),
                    version
                }]
            );
        }
    }

    // --- write semantics (8.12) ---------------------------------------------

    fn guarded_edit(scene_id: &str, read: u64, edits: Vec<SceneEdit>) -> EditorCommand {
        EditorCommand::EditScene(EditScene {
            target: SceneTarget::Stored {
                project: "news".into(),
                scene_id: scene_id.into(),
            },
            edits,
            module: None,
            if_revision: Some(Revision(read)),
        })
    }

    fn stored_revision(workspace: &Workspace, scene_id: &str) -> Option<Revision> {
        stored_scene(workspace, scene_id).revision
    }

    #[test]
    fn a_stored_batch_is_one_revision_and_a_stale_one_lands_nothing() {
        let (_scratch, mut workspace) = with_store("revision-batch");
        // A batch of three edits moves the revision by one, not three.
        let outcome = run(
            &mut workspace,
            guarded_edit(
                "b",
                0,
                vec![
                    rename_scene("One"),
                    SceneEdit::CreateObject(CreateObject {
                        kind: "rect".into(),
                        name: "Card".into(),
                    }),
                    rename_scene("Two"),
                ],
            ),
        );
        assert_eq!(outcome.revision, Some(Revision(1)));
        assert_eq!(stored_revision(&workspace, "b"), Some(Revision(1)));
        let after = stored_scene(&workspace, "b");

        // The writer that read 0 has lost; it learns 1 is current.
        let stale = refusal(
            &mut workspace,
            guarded_edit("b", 0, vec![rename_scene("Late")]),
        );
        assert_eq!(
            stale,
            Refusal::RevisionMismatch {
                expected: Revision(0),
                actual: Revision(1),
            }
        );
        assert_eq!(stored_scene(&workspace, "b"), after, "nothing landed");

        // A batch that changes nothing writes nothing and answers the
        // revision it found.
        let unchanged = run(
            &mut workspace,
            guarded_edit("b", 1, vec![rename_scene("Two")]),
        );
        assert_eq!(unchanged.revision, Some(Revision(1)));
        assert_eq!(stored_scene(&workspace, "b"), after);

        // The Editor's own unconditional write still moves the revision, so
        // an agent holding 1 cannot overwrite it blind afterwards.
        run(
            &mut workspace,
            stored_edit("b", vec![rename_scene("Three")]),
        );
        assert_eq!(stored_revision(&workspace, "b"), Some(Revision(2)));
        assert!(matches!(
            refusal(
                &mut workspace,
                guarded_edit("b", 1, vec![rename_scene("Four")])
            ),
            Refusal::RevisionMismatch {
                actual: Revision(2),
                ..
            }
        ));
    }

    #[test]
    fn a_session_target_names_no_revision() {
        let (_scratch, mut workspace) = with_store("revision-session");
        let session = open(
            &mut workspace,
            SceneSource::Project {
                project: "news".into(),
                scene_id: "b".into(),
            },
        );
        let refused = refusal(
            &mut workspace,
            EditorCommand::EditScene(EditScene {
                target: SceneTarget::Session { session },
                edits: vec![rename_scene("X")],
                module: None,
                if_revision: Some(Revision(0)),
            }),
        );
        assert_eq!(
            refused,
            Refusal::CommandUnknownField {
                path: "ifRevision".into()
            }
        );
        assert_eq!(name_of(&workspace, session), "B", "nothing was applied");
    }

    #[test]
    fn saving_over_a_scene_an_agent_changed_is_refused_and_the_work_still_saves_to_a_file() {
        let (_scratch, mut workspace) = with_store("revision-save");
        let session = open(
            &mut workspace,
            SceneSource::Project {
                project: "news".into(),
                scene_id: "b".into(),
            },
        );
        run(&mut workspace, edit(session, vec![rename_scene("Mine")]));

        // An agent edits the stored scene while the session is open.
        run(
            &mut workspace,
            guarded_edit("b", 0, vec![rename_scene("Agent")]),
        );
        let refused = refusal(&mut workspace, save(session, SaveTarget::Origin));
        assert_eq!(
            refused,
            Refusal::RevisionMismatch {
                expected: Revision(0),
                actual: Revision(1),
            }
        );
        assert_eq!(
            stored_scene(&workspace, "b").name,
            "Agent",
            "not overwritten"
        );

        // The session's work is not lost: it still saves to a file, and the
        // stored scene is left as the agent made it.
        let file = std::env::temp_dir().join(format!("gx-812-save-{}.gpx", std::process::id()));
        run(
            &mut workspace,
            save(
                session,
                SaveTarget::File {
                    path: file.display().to_string(),
                },
            ),
        );
        assert!(std::fs::read_to_string(&file).unwrap().contains("\"Mine\""));
        let _ = std::fs::remove_file(&file);
        // A new scene saved into the project starts at revision 0.
        let copy = open(
            &mut workspace,
            SceneSource::New {
                id: "b-mine".into(),
                name: "Mine".into(),
            },
        );
        let saved = run(
            &mut workspace,
            save(
                copy,
                SaveTarget::Project {
                    project: "news".into(),
                },
            ),
        );
        assert_eq!(saved.revision, Some(Revision(0)));

        // A session that read the current revision saves, and the save moves
        // it on, both on disk and in the session (so a second save works).
        let fresh = open(
            &mut workspace,
            SceneSource::Project {
                project: "news".into(),
                scene_id: "b-mine".into(),
            },
        );
        run(&mut workspace, edit(fresh, vec![rename_scene("Mine 2")]));
        let first = run(&mut workspace, save(fresh, SaveTarget::Origin));
        assert_eq!(first.revision, Some(Revision(1)));
        run(&mut workspace, edit(fresh, vec![rename_scene("Mine 3")]));
        // Undo and redo replay from the session's base; the base carries the
        // saved revision too, so the replayed document still saves.
        run(
            &mut workspace,
            EditorCommand::Undo(gx_contracts::command::Undo {
                session: fresh,
                module: None,
            }),
        );
        run(
            &mut workspace,
            EditorCommand::Redo(gx_contracts::command::Redo {
                session: fresh,
                module: None,
            }),
        );
        let second = run(&mut workspace, save(fresh, SaveTarget::Origin));
        assert_eq!(second.revision, Some(Revision(2)));
        assert_eq!(stored_scene(&workspace, "b-mine").name, "Mine 3");
    }

    #[test]
    fn a_delete_naming_a_stale_revision_keeps_the_scene() {
        let (_scratch, mut workspace) = with_store("revision-delete");
        run(
            &mut workspace,
            guarded_edit("b", 0, vec![rename_scene("Edited")]),
        );
        let delete = |read: u64| {
            EditorCommand::DeleteScene(DeleteScene {
                project: "news".into(),
                scene_id: "b".into(),
                if_revision: Some(Revision(read)),
            })
        };
        assert!(matches!(
            refusal(&mut workspace, delete(0)),
            Refusal::RevisionMismatch {
                actual: Revision(1),
                ..
            }
        ));
        assert_eq!(stored_scene(&workspace, "b").name, "Edited");
        run(&mut workspace, delete(1));
        assert!(workspace
            .document(&SceneTarget::Stored {
                project: "news".into(),
                scene_id: "b".into(),
            })
            .is_err());
    }

    #[test]
    fn writers_released_together_on_one_revision_land_exactly_once_per_round() {
        // Eight writers, each with its own workspace over the one store, are
        // released at once against the same revision, fifty times. The lock
        // makes each read-check-write one step, so every round lands exactly
        // one write and moves the revision by one. Without it two writers can
        // read the same revision and both "land", the second silently undoing
        // the first.
        let (scratch, _workspace) = with_store("revision-race");
        let root = scratch.projects().root().to_path_buf();
        for round in 0..50u64 {
            let barrier = std::sync::Barrier::new(8);
            let landed: usize = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..8)
                    .map(|writer| {
                        let (root, barrier) = (root.clone(), &barrier);
                        scope.spawn(move || {
                            let mut workspace = Workspace::new(Some(Projects::at_root(root)));
                            barrier.wait();
                            workspace
                                .execute(guarded_edit(
                                    "b",
                                    round,
                                    vec![rename_scene(&format!("Round {round} writer {writer}"))],
                                ))
                                .is_ok() as usize
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().unwrap())
                    .sum()
            });
            assert_eq!(landed, 1, "round {round}: exactly one writer lands");
        }
        let workspace = Workspace::new(Some(Projects::at_root(&root)));
        assert_eq!(stored_revision(&workspace, "b"), Some(Revision(50)));
    }
}
