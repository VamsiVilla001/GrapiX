//! The Editor's Tauri 2 shell (build plan 11.1, 11.36).
//!
//! **This file is where invariants 4 and 5 are enforced.** The Editor owns
//! mutable authoring content and cannot change Program or outputs. That is
//! not a runtime check on a message here — it is the absence of a command:
//! the surface below has no `cue`, no `take`, no `clear` and no
//! `configure_output`, so a compromised or mistaken web layer cannot reach
//! one however it asks. A flag on a shared command would be a check that can
//! be forgotten; an absent command cannot be.
//!
//! **Every authoring mutation is one command (11.36, invariant 60).**
//! `cmd_execute` parses an `EditorCommand` and hands it to the Rust
//! `Workspace`, which owns the open documents, their histories and every
//! store write. The browser holds no document it can send back: it renders
//! the `SessionView` it is given, and nothing on this surface accepts a whole
//! scene from it.
//!
//! What else it exposes is read-only: catalogues, the rule surfaces the
//! panels are built from, and publication. Publication is the whole of the
//! Editor's authority over Program — it produces a revision Playout may later
//! take, and nothing more (invariant 7: a mutable Editor scene never replaces
//! a published one in place).
//!
//! The shell never imports renderer internals (invariant 3). It speaks the
//! asset plane's published contract and holds no GPU state.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Mutex, MutexGuard};

use gx_asset_plane::{publish_scene, PublishClientError, PublishRefusal, PublishReply};
use gx_contracts::animation::{animation_surface, validate_scene_animation, AnimationSurface};
use gx_contracts::command::{
    parse_command, CommandOutcome, EditorCommand, SaveScene, SaveTarget, OpenScene, SceneSource,
    SceneTarget, SessionKey, SessionView,
};
use gx_contracts::control::{apply_control_values, fillable_properties, ControlFieldKind, ControlValue, TakePage};
use gx_contracts::design_system::{starter_presets, MotionPreset};
use gx_contracts::platform::service_data_root;
use gx_contracts::scene::SceneDocument;
use gx_contracts::{Refusal, Revision, TakeId};
use gx_editor::{CommandError, Projects, Workspace};
use serde::{Deserialize, Serialize};

/// The asset-plane endpoint an Editor publishes to by default.
///
/// The control port plus one, matching the worker's own default. Exposed to
/// the web layer as a starting value, never as a silent fallback: a failed
/// connection is reported with the address it tried.
pub const DEFAULT_ASSET_ENDPOINT: &str = "127.0.0.1:4401";

/// The shell's one piece of state: the workspace every command runs against.
///
/// A poisoned lock is recovered rather than propagated. That is safe because
/// the workspace only ever commits a fully prepared document by a final swap,
/// so a panic mid-command cannot leave a half-applied edit behind it.
pub struct ShellState {
    workspace: Mutex<Workspace>,
}

impl ShellState {
    pub fn new(workspace: Workspace) -> Self {
        Self { workspace: Mutex::new(workspace) }
    }

    fn workspace(&self) -> MutexGuard<'_, Workspace> {
        self.workspace.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Everything the Editor shell can fail at, named.
///
/// One enum for the whole surface, because the web layer shows the same
/// message box for all of them and a stringly-typed error would let a
/// refusal be presented as a crash.
#[derive(Debug, Serialize)]
#[serde(tag = "error", rename_all = "camelCase")]
pub enum EditorError {
    /// A scene file could not be read.
    ReadScene { path: String, detail: String },
    /// A scene file could not be written.
    WriteScene { path: String, detail: String },
    /// The endpoint text is not a socket address.
    InvalidEndpoint { endpoint: String },
    /// The asset plane could not be reached at all. Distinct from a refusal:
    /// nothing was decided, so nothing was published.
    Unreachable { endpoint: String, detail: String },
    /// The engine understood the document and declined it, by name.
    PublishRefused { detail: String },
    /// A reply arrived that is not a reply.
    Protocol { detail: String },
    /// The project store could not complete an operation. The machine
    /// failed; nothing about the request was decided.
    ProjectFailed { detail: String },
    /// A named refusal from the shared contract vocabulary — a command the
    /// workspace declined, a read the store declined, a take-page value of
    /// the wrong type. `cause` is the refusal itself, so the web layer can
    /// act on it rather than parse prose.
    CommandRefused { detail: String, cause: Refusal },
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadScene { path, detail } => write!(f, "cannot read {path}: {detail}"),
            Self::WriteScene { path, detail } => write!(f, "cannot write {path}: {detail}"),
            Self::InvalidEndpoint { endpoint } => write!(f, "{endpoint} is not a host:port address"),
            Self::Unreachable { endpoint, detail } => {
                write!(f, "cannot reach the asset plane at {endpoint}: {detail}")
            }
            Self::PublishRefused { detail } => write!(f, "publication refused: {detail}"),
            Self::Protocol { detail } => write!(f, "asset plane protocol failed: {detail}"),
            Self::ProjectFailed { detail } => write!(f, "project operation failed: {detail}"),
            Self::CommandRefused { detail, .. } => write!(f, "refused: {detail}"),
        }
    }
}

impl std::error::Error for EditorError {}

fn refused(cause: Refusal) -> EditorError {
    EditorError::CommandRefused {
        detail: cause.to_string(),
        cause,
    }
}

/// Carry a project-store failure onto the shell surface: a store refusal
/// keeps its name, a machine failure keeps its detail.
fn project_error(error: gx_editor::project::EditorError) -> EditorError {
    match error {
        gx_editor::project::EditorError::Refused(cause) => refused(cause),
        error => EditorError::ProjectFailed { detail: error.to_string() },
    }
}

/// Which scene file, if any, a command reads or writes. A filesystem failure
/// then reaches the author as "cannot read/write <path>", not as a project
/// failure that names no file.
#[derive(Clone, Copy)]
enum SceneFile {
    Read,
    Write,
}

fn scene_file(command: &EditorCommand) -> Option<SceneFile> {
    match command {
        EditorCommand::OpenScene(OpenScene { source: SceneSource::File { .. } }) => Some(SceneFile::Read),
        EditorCommand::SaveScene(SaveScene { to: SaveTarget::File { .. }, .. }) => Some(SceneFile::Write),
        _ => None,
    }
}

fn command_error(error: CommandError, file: Option<SceneFile>) -> EditorError {
    use gx_editor::project::EditorError as Store;
    match (error, file) {
        (CommandError::Refused(cause), _) => refused(cause),
        (CommandError::Store(Store::Io { path, source }), Some(SceneFile::Read)) => EditorError::ReadScene {
            path: path.display().to_string(),
            detail: source.to_string(),
        },
        (CommandError::Store(Store::Io { path, source }), Some(SceneFile::Write)) => EditorError::WriteScene {
            path: path.display().to_string(),
            detail: source.to_string(),
        },
        (CommandError::Store(error), _) => project_error(error),
    }
}

/// Run one parsed command against the workspace.
pub fn execute(workspace: &mut Workspace, command: EditorCommand) -> Result<CommandOutcome, EditorError> {
    let file = scene_file(&command);
    workspace.execute(command).map_err(|error| command_error(error, file))
}

/// What a successful publication produced.
///
/// The revision is the point: Playout takes an exact revision, so the Editor
/// must report the one it created rather than "published successfully".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub take_id: TakeId,
    pub revision: Revision,
}

/// Publish one complete document and report the revision it became.
///
/// Publication is atomic at the far end: the engine either produces a new
/// immutable revision or refuses the whole document (invariant 30). This
/// function keeps the two outcomes distinct all the way to the web layer —
/// an unreachable engine is not a refusal, and a refusal is not a crash.
pub fn publish(endpoint: &str, scene: SceneDocument) -> Result<PublishResult, EditorError> {
    let address: SocketAddr = endpoint.parse().map_err(|_| EditorError::InvalidEndpoint {
        endpoint: endpoint.to_owned(),
    })?;
    match publish_scene(address, scene) {
        Ok(PublishReply::Published { take_id, revision }) => Ok(PublishResult { take_id, revision }),
        Ok(PublishReply::Refused(PublishRefusal::InvalidPublishRequest { detail })) => {
            Err(EditorError::PublishRefused { detail })
        }
        Ok(PublishReply::Refused(
            PublishRefusal::SceneRefused { cause } | PublishRefusal::PreparationRefused { cause },
        )) => Err(EditorError::PublishRefused { detail: cause.to_string() }),
        Err(PublishClientError::Connect(source)) => Err(EditorError::Unreachable {
            endpoint: endpoint.to_owned(),
            detail: source.to_string(),
        }),
        Err(other) => Err(EditorError::Protocol { detail: other.to_string() }),
    }
}

/// Preview operator values through Rust's one control-value application.
///
/// The returned document is a filled copy; the template the target names is
/// untouched, so operator data can never be persisted into the reusable
/// scene.
pub fn take_page_preview(
    workspace: &Workspace,
    target: &SceneTarget,
    values: &BTreeMap<String, ControlValue>,
) -> Result<SceneDocument, EditorError> {
    let template = workspace.document(target).map_err(|error| command_error(error, None))?;
    apply_control_values(&template, values).map_err(refused)
}

/// The per-user projects root. A shell that cannot name one says so rather
/// than writing into whatever directory it was launched from.
fn projects() -> Result<Projects, EditorError> {
    let root = service_data_root().map_err(refused)?;
    Ok(Projects::at_root(root.join("projects")))
}

/// A scene as the manager lists it. Ids come from the store; the rest is what
/// the panel needs to say something true about each one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedScene {
    pub scene_id: String,
    pub name: String,
    /// Set when the scene carries a revision, meaning it has been published.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_revision: Option<u64>,
    /// Why this row cannot be opened, when its file exists but will not parse.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// One complete manager refresh. The design-system version and rows are read
/// together so drift cannot be calculated against a version from an earlier
/// refresh.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSceneCatalog {
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_design_system_version: Option<u32>,
    pub scenes: Vec<ListedScene>,
}

/// A take page as the project manager lists it.
///
/// The template id is carried visibly so an operator cannot reopen values
/// against a different scene by accident.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTakePage {
    pub page_id: String,
    pub name: String,
    pub scene_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// The saved take-page instances for one project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTakePageCatalog {
    pub project: String,
    pub pages: Vec<ListedTakePage>,
}

/// The scenes in a project, each read through the closed reader.
///
/// A scene that will not parse is reported by name rather than dropped from
/// the list: an author whose file has gone bad needs to see it, not to find
/// it silently missing.
pub fn scene_catalog(store: &Projects, project: &str) -> Result<ProjectSceneCatalog, EditorError> {
    let ids = store.list_scenes(project).map_err(project_error)?;
    let mut scenes = Vec::with_capacity(ids.len());
    for scene_id in ids {
        match store.read_scene(project, &scene_id) {
            Ok(scene) => scenes.push(ListedScene {
                scene_id,
                name: scene.name,
                published_revision: scene.revision.map(|revision| revision.0),
                unavailable_reason: None,
            }),
            Err(error) => scenes.push(ListedScene {
                name: scene_id.clone(),
                scene_id,
                published_revision: None,
                unavailable_reason: Some(format!("scene file is unreadable: {error}")),
            }),
        }
    }
    let current_design_system_version = store
        .design_system(project)
        .and_then(|design_system| design_system.current_version())
        .map_err(project_error)?;
    Ok(ProjectSceneCatalog {
        project: project.to_owned(),
        current_design_system_version,
        scenes,
    })
}

/// One stored scene, refused by name if publish would refuse its animation —
/// the same check `OpenScene` runs, so a read cannot preview a curve the
/// engine would reject.
pub fn scene_read(store: &Projects, project: &str, scene_id: &str) -> Result<SceneDocument, EditorError> {
    let scene = store.read_scene(project, scene_id).map_err(project_error)?;
    validate_scene_animation(&scene).map_err(refused)?;
    Ok(scene)
}

/// The saved template instances in a project, unreadable ones named.
pub fn take_page_catalog(store: &Projects, project: &str) -> Result<ProjectTakePageCatalog, EditorError> {
    let ids = store.list_take_pages(project).map_err(project_error)?;
    let mut pages = Vec::with_capacity(ids.len());
    for page_id in ids {
        match store.read_take_page(project, &page_id) {
            Ok(page) => pages.push(ListedTakePage {
                page_id,
                name: page.name,
                scene_id: page.scene_id,
                unavailable_reason: None,
            }),
            Err(error) => pages.push(ListedTakePage {
                name: page_id.clone(),
                scene_id: String::new(),
                page_id,
                unavailable_reason: Some(format!("take-page file is unreadable: {error}")),
            }),
        }
    }
    Ok(ProjectTakePageCatalog {
        project: project.to_owned(),
        pages,
    })
}

// ---------------------------------------------------------------------------
// The Tauri command surface.
//
// Every command the Editor has. Read the list: one mutator, the rest reads
// and publication, and no way to reach Program from here. That is the design.
// ---------------------------------------------------------------------------

/// The one authoring mutator. Strictly parsed: an unknown field anywhere in
/// the command refuses by its dotted path rather than being ignored.
#[tauri::command]
fn cmd_execute(state: tauri::State<'_, ShellState>, command: serde_json::Value) -> Result<CommandOutcome, EditorError> {
    let command = parse_command(command).map_err(refused)?;
    execute(&mut state.workspace(), command)
}

#[tauri::command]
fn cmd_session_view(state: tauri::State<'_, ShellState>, session: SessionKey) -> Result<SessionView, EditorError> {
    state.workspace().view(session).map_err(|error| command_error(error, None))
}

/// Publish the document a target names. The document is cloned under the
/// lock and published after it is released: no network IO under the mutex.
#[tauri::command]
fn cmd_publish(state: tauri::State<'_, ShellState>, endpoint: String, target: SceneTarget) -> Result<PublishResult, EditorError> {
    let scene = state
        .workspace()
        .document(&target)
        .map_err(|error| command_error(error, None))?
        .into_owned();
    publish(&endpoint, scene)
}

#[tauri::command]
fn cmd_take_page_preview(
    state: tauri::State<'_, ShellState>,
    target: SceneTarget,
    values: BTreeMap<String, ControlValue>,
) -> Result<SceneDocument, EditorError> {
    take_page_preview(&state.workspace(), &target, &values)
}

/// The creatable kinds, read from Rust so the menu cannot offer a kind the
/// contract would refuse (invariant 18).
#[tauri::command]
fn cmd_object_kinds() -> Vec<&'static str> {
    gx_contracts::authoring::CREATABLE_KINDS.to_vec()
}

#[tauri::command]
fn cmd_animation_surface() -> AnimationSurface {
    animation_surface()
}

#[tauri::command]
fn cmd_control_properties(kind: String) -> Vec<(String, ControlFieldKind)> {
    fillable_properties(&kind)
        .iter()
        .map(|(property, kind)| ((*property).to_owned(), *kind))
        .collect()
}

#[tauri::command]
fn cmd_starter_presets() -> Vec<MotionPreset> {
    starter_presets()
}

#[tauri::command]
fn cmd_default_endpoint() -> &'static str {
    DEFAULT_ASSET_ENDPOINT
}

#[tauri::command]
fn cmd_project_list() -> Result<Vec<String>, EditorError> {
    projects()?.list_projects().map_err(project_error)
}

#[tauri::command]
fn cmd_scene_list(project: String) -> Result<ProjectSceneCatalog, EditorError> {
    scene_catalog(&projects()?, &project)
}

#[tauri::command]
fn cmd_scene_read(project: String, scene_id: String) -> Result<SceneDocument, EditorError> {
    scene_read(&projects()?, &project, &scene_id)
}

#[tauri::command]
fn cmd_take_page_list(project: String) -> Result<ProjectTakePageCatalog, EditorError> {
    take_page_catalog(&projects()?, &project)
}

/// Reopen one saved instance exactly as its operator values were saved.
#[tauri::command]
fn cmd_take_page_read(project: String, page_id: String) -> Result<TakePage, EditorError> {
    projects()?.read_take_page(&project, &page_id).map_err(project_error)
}

/// Build and run the Editor window.
pub fn run() {
    let workspace = Workspace::new(projects().ok());
    tauri::Builder::default()
        .manage(ShellState::new(workspace))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            cmd_execute,
            cmd_session_view,
            cmd_publish,
            cmd_take_page_preview,
            cmd_object_kinds,
            cmd_animation_surface,
            cmd_control_properties,
            cmd_starter_presets,
            cmd_default_endpoint,
            cmd_project_list,
            cmd_scene_list,
            cmd_scene_read,
            cmd_take_page_list,
            cmd_take_page_read,
        ])
        .run(tauri::generate_context!())
        .expect("the Editor shell failed to start");
}

#[cfg(test)]
mod tests {
    use gx_contracts::command::{CreateObject, DeclareControl, EditScene, SceneEdit};
    use gx_contracts::control::ControlField;

    use super::*;

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("gx-editor-shell-{label}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).expect("scratch directory");
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Parse and run a command exactly as `cmd_execute` does.
    fn invoke(workspace: &mut Workspace, command: serde_json::Value) -> Result<CommandOutcome, EditorError> {
        execute(workspace, parse_command(command).map_err(refused)?)
    }

    fn open_new(workspace: &mut Workspace) -> SessionKey {
        invoke(workspace, serde_json::json!({ "command": "openScene", "source": { "source": "new", "id": "probe", "name": "Probe" } }))
            .expect("a new scene opens")
            .session
            .expect("an open reports its session")
            .session
    }

    #[test]
    fn an_unknown_command_field_is_refused_by_its_path_before_anything_runs() {
        let mut workspace = Workspace::new(None);
        let error = invoke(
            &mut workspace,
            serde_json::json!({
                "command": "openScene",
                "source": { "source": "new", "id": "probe", "name": "Probe", "scene": {} }
            }),
        )
        .expect_err("a smuggled field must refuse");
        assert!(
            matches!(&error, EditorError::CommandRefused { cause: Refusal::CommandUnknownField { path }, .. } if path == "source.scene"),
            "got {error:?}"
        );
        assert!(workspace.view(SessionKey(1)).is_err(), "nothing was opened");
    }

    #[test]
    fn a_workspace_refusal_reaches_the_web_layer_with_its_cause() {
        let mut workspace = Workspace::new(None);
        let error = invoke(&mut workspace, serde_json::json!({ "command": "undo", "session": 9 }))
            .expect_err("no such session");
        assert!(
            matches!(error, EditorError::CommandRefused { cause: Refusal::SessionUnknown { session: SessionKey(9) }, .. }),
            "got {error:?}"
        );
    }

    #[test]
    fn a_scene_file_failure_names_the_file_and_the_direction() {
        let scratch = Scratch::new("files");
        let missing = scratch.0.join("absent.json").display().to_string();
        let mut workspace = Workspace::new(None);
        let error = invoke(
            &mut workspace,
            serde_json::json!({ "command": "openScene", "source": { "source": "file", "path": missing } }),
        )
        .expect_err("a missing file cannot open");
        assert!(matches!(&error, EditorError::ReadScene { path, .. } if path == &missing), "got {error:?}");

        let session = open_new(&mut workspace);
        let unwritable = scratch.0.join("no-such-dir").join("scene.json").display().to_string();
        let error = invoke(
            &mut workspace,
            serde_json::json!({ "command": "saveScene", "session": session.0, "to": { "to": "file", "path": unwritable } }),
        )
        .expect_err("a file in a missing directory cannot be written");
        assert!(matches!(&error, EditorError::WriteScene { path, .. } if path == &unwritable), "got {error:?}");
        assert!(workspace.view(session).unwrap().path.is_none(), "a failed save records no path");
    }

    #[test]
    fn the_object_menu_only_offers_kinds_the_contract_will_create() {
        // The menu is read from Rust so it cannot drift from what the create
        // edit accepts — a kind that appears and then refuses is the silent
        // gap invariant 18 exists to prevent.
        let kinds = cmd_object_kinds();
        assert!(!kinds.is_empty());
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace);
        for kind in kinds {
            let outcome = execute(
                &mut workspace,
                EditorCommand::EditScene(EditScene {
                    target: SceneTarget::Session { session },
                    edits: vec![SceneEdit::CreateObject(CreateObject { kind: kind.into(), name: "X".into() })],
                }),
            );
            // `text` is the one creatable kind with a scene-level
            // prerequisite; a blank scene carries no fonts.
            if kind == "text" {
                assert!(matches!(outcome, Err(EditorError::CommandRefused { .. })), "text needs a font");
            } else {
                assert!(outcome.is_ok(), "menu offers {kind} but the contract refuses it: {outcome:?}");
            }
        }
    }

    #[test]
    fn take_page_preview_refuses_wrong_values_without_mutating_the_template() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace);
        execute(
            &mut workspace,
            EditorCommand::EditScene(EditScene {
                target: SceneTarget::Session { session },
                edits: vec![
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
            }),
        )
        .expect("the template is authored");
        let target = SceneTarget::Session { session };
        let original = workspace.view(session).unwrap();

        let error = take_page_preview(
            &workspace,
            &target,
            &BTreeMap::from([("offset".into(), ControlValue::Text("not a number".into()))]),
        )
        .expect_err("text must not be coerced into a numeric control");
        assert!(
            error.to_string().contains("offset requires number, not text"),
            "the operator needs Rust's named type mismatch: {error}"
        );

        let filled = take_page_preview(&workspace, &target, &BTreeMap::from([("offset".into(), ControlValue::Number(42.0))]))
            .expect("a matching value fills a copy");
        assert_ne!(filled, original.document, "the returned preview is the filled copy");
        assert_eq!(workspace.view(session).unwrap(), original, "a preview cannot edit the template or its history");
    }

    #[test]
    fn the_scene_catalog_names_unreadable_files_and_refuses_paths() {
        let scratch = Scratch::new("catalog");
        let store = Projects::at_root(&scratch.0);
        store.create_project("news").expect("create project");
        std::fs::write(scratch.0.join("news/scenes/bad.json"), b"{ not-json").expect("write corrupt scene");

        let catalog = scene_catalog(&store, "news").expect("list scene catalog");
        assert_eq!(catalog.scenes.len(), 1);
        assert_eq!(catalog.scenes[0].scene_id, "bad");
        assert!(catalog.scenes[0]
            .unavailable_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("unreadable")));

        assert!(matches!(
            scene_catalog(&store, "../news"),
            Err(EditorError::CommandRefused { cause: Refusal::ProjectNameInvalid { .. }, .. })
        ));
        assert!(matches!(
            scene_read(&store, "news", "../escape"),
            Err(EditorError::CommandRefused { cause: Refusal::SceneIdInvalid { .. }, .. })
        ));
    }

    #[test]
    fn an_unparseable_endpoint_is_refused_before_any_socket_opens() {
        let error = publish("not-an-address", gx_contracts::scene::new_scene("demo", "Demo"))
            .expect_err("a malformed endpoint cannot be dialled");
        assert!(matches!(error, EditorError::InvalidEndpoint { .. }));
    }
}
