//! Starting work (build plan 11.43): the Editor opens with no project, and nothing can be stored
//! until one is created at a path the user chose or opened from its `.gpx`, as in XPression, Viz
//! and After Effects.
//!
//! This is the logic behind New Project, Open Project, Close Project and Open Recent, apart from
//! the window: each function takes the workspace and the open-project cell it changes, so it is
//! tested without a window. Rules held here:
//! - **Nothing is half done.** A scene with unsaved changes refuses a switch by name *before*
//!   anything is created or opened, so choosing another project never loses work and never
//!   leaves a new project behind that was not switched to.
//! - **The Editor has one open project.** It is the store the shell's reads and writes use; with
//!   none open they refuse by name instead of falling back to some default folder.
//! - **The recent list is a convenience.** A failure to write it is logged and does not stop a
//!   project from opening.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use gx_contracts::color::{ColorDepth, WorkingColorSpace};
use gx_contracts::command::SessionKey;
use gx_contracts::project::ProjectSettings;
use gx_contracts::Refusal;
use gx_editor::project::EditorError as StoreError;
use gx_editor::recent::{RecentProject, RecentProjects};
use gx_editor::{CommandError, Projects, Workspace};
use serde::Serialize;

/// The project the Editor has open: the store it lives in and its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenProject {
    pub root: PathBuf,
    pub name: String,
}

/// Where the open project is kept. One Editor window has one open project.
#[derive(Debug, Default)]
pub struct OpenProjectCell(Mutex<Option<OpenProject>>);

impl OpenProjectCell {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn lock(&self) -> MutexGuard<'_, Option<OpenProject>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self) -> Option<OpenProject> {
        self.lock().clone()
    }

    fn set(&self, project: Option<OpenProject>) {
        *self.lock() = project;
    }

    /// The store of the open project, if there is one.
    pub fn projects(&self) -> Option<Projects> {
        self.get().map(|p| Projects::at_root(p.root))
    }
}

/// What the web layer is told after a project opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub name: String,
    pub gpx: String,
    pub root: String,
    /// The space the project composites in, so the page can say so.
    pub working_color_space: WorkingColorSpace,
    /// The bits per channel the project renders at (8, 16 or 32).
    pub color_depth: ColorDepth,
    /// The scenes that were open in the project just left, closed with it.
    pub closed_sessions: Vec<SessionKey>,
}

/// A remembered project and whether its `.gpx` is still where it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedRecent {
    #[serde(flatten)]
    pub project: RecentProject,
    pub exists: bool,
}

/// Why starting work failed.
#[derive(Debug)]
pub enum StartError {
    Store(StoreError),
    Command(CommandError),
}

impl From<StoreError> for StartError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}

impl From<CommandError> for StartError {
    fn from(value: CommandError) -> Self {
        Self::Command(value)
    }
}

fn activate(
    workspace: &mut Workspace,
    cell: &OpenProjectCell,
    recent: &RecentProjects,
    projects: Projects,
    name: &str,
    now_ms: u64,
) -> Result<OpenedProject, StartError> {
    // Read before the switch, so a project whose settings cannot be read is refused by name and
    // the one already open stays open.
    let settings = projects.settings(name)?;
    let closed_sessions = workspace.switch_project(Some(projects.clone()))?;
    // Scenes made from now on are born in what this project declares.
    workspace.set_new_scene_settings(settings);
    Ok(opened(
        cell,
        recent,
        &projects,
        name,
        settings,
        closed_sessions,
        now_ms,
    ))
}

/// The project is open in the workspace: remember it, note it, and tell the web layer.
/// Nothing in here can fail the open, which is already done.
fn opened(
    cell: &OpenProjectCell,
    recent: &RecentProjects,
    projects: &Projects,
    name: &str,
    settings: ProjectSettings,
    closed_sessions: Vec<SessionKey>,
    now_ms: u64,
) -> OpenedProject {
    let gpx = projects.gpx_path(name);
    let root = projects.root().to_path_buf();
    cell.set(Some(OpenProject {
        root: root.clone(),
        name: name.to_owned(),
    }));
    if let Err(error) = recent.record(&gpx, name, now_ms) {
        tracing::warn!(event = "editor.recent.write_failed", detail = %error);
    }
    tracing::info!(event = "editor.project.open", project = name);
    OpenedProject {
        name: name.to_owned(),
        gpx: gpx.display().to_string(),
        root: root.display().to_string(),
        working_color_space: settings.working_color_space,
        color_depth: settings.color_depth,
        closed_sessions,
    }
}

/// File > Save As: copy the open project to `<parent>/<name>/<name>.gpx` and open the copy.
///
/// The project left behind is untouched. The unsaved work of its scenes goes into the copy, and
/// the scenes are closed as a project switch closes them (the page starts afresh on the copy).
/// A scene with unsaved work that is not stored in this project refuses by name before anything
/// is copied. With no project open there is nothing to copy and it refuses.
pub fn save_project_as(
    workspace: &mut Workspace,
    cell: &OpenProjectCell,
    recent: &RecentProjects,
    parent: &Path,
    name: &str,
    now_ms: u64,
) -> Result<OpenedProject, StartError> {
    let Some(open) = cell.get() else {
        return Err(StartError::Store(StoreError::Refused(
            Refusal::ProjectNotFound {
                project: "no project is open: there is nothing to save as".into(),
            },
        )));
    };
    let saved = workspace.save_project_as(&open.name, parent, name)?;
    tracing::info!(event = "editor.project.save_as", from = %open.name, to = name);
    Ok(opened(
        cell,
        recent,
        &saved.projects,
        name,
        saved.settings,
        saved.closed_sessions,
        now_ms,
    ))
}

/// File > New Project: create `<parent>/<name>/<name>.gpx` and open it.
pub fn new_project(
    workspace: &mut Workspace,
    cell: &OpenProjectCell,
    recent: &RecentProjects,
    parent: &Path,
    name: &str,
    now_ms: u64,
) -> Result<OpenedProject, StartError> {
    new_project_with(
        workspace,
        cell,
        recent,
        parent,
        name,
        gx_contracts::project::ProjectSettings::new_project(),
        now_ms,
    )
}

/// File > New Project with the project's declarations chosen (the colour depth the dialog
/// offers; the working space stays the new-project default).
pub fn new_project_with(
    workspace: &mut Workspace,
    cell: &OpenProjectCell,
    recent: &RecentProjects,
    parent: &Path,
    name: &str,
    settings: gx_contracts::project::ProjectSettings,
    now_ms: u64,
) -> Result<OpenedProject, StartError> {
    workspace.require_no_unsaved()?;
    let projects = Projects::create_in_with(parent, name, settings)?;
    activate(workspace, cell, recent, projects, name, now_ms)
}

/// File > Open Project: open the project a `.gpx` file is.
pub fn open_project(
    workspace: &mut Workspace,
    cell: &OpenProjectCell,
    recent: &RecentProjects,
    gpx: &Path,
    now_ms: u64,
) -> Result<OpenedProject, StartError> {
    workspace.require_no_unsaved()?;
    let (projects, name) = Projects::open_gpx(gpx)?;
    activate(workspace, cell, recent, projects, &name, now_ms)
}

/// Open a project folder made before the `.gpx`, upgrading it first (losslessly, once).
pub fn open_folder(
    workspace: &mut Workspace,
    cell: &OpenProjectCell,
    recent: &RecentProjects,
    folder: &Path,
    now_ms: u64,
) -> Result<OpenedProject, StartError> {
    workspace.require_no_unsaved()?;
    let (projects, name) = Projects::open_folder(folder)?;
    activate(workspace, cell, recent, projects, &name, now_ms)
}

/// File > Exit: refuse by name while any scene has unsaved work, so choosing Exit never loses it.
pub fn require_can_exit(workspace: &Workspace) -> Result<(), StartError> {
    workspace.require_no_unsaved().map_err(StartError::Command)
}

/// File > Close Project: close its scenes and leave the Editor with none open.
pub fn close_project(
    workspace: &mut Workspace,
    cell: &OpenProjectCell,
) -> Result<Vec<SessionKey>, StartError> {
    let closed = workspace.switch_project(None)?;
    cell.set(None);
    Ok(closed)
}

/// File > Open Recent: the remembered projects, newest first, each marked missing when its
/// `.gpx` is gone.
pub fn list_recent(recent: &RecentProjects) -> Vec<ListedRecent> {
    recent
        .list()
        .into_iter()
        .map(|project| {
            let exists = Path::new(&project.gpx).is_file();
            ListedRecent { project, exists }
        })
        .collect()
}

/// Projects found in a folder, for a first launch that has no recent list yet: the folder's
/// projects, as `(name, folder)`, where a project is a folder holding `<name>.gpx` or the
/// settings of a project made before the `.gpx`.
pub fn discover(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(projects) = Projects::at_root(root).list_projects() else {
        return Vec::new();
    };
    projects
        .into_iter()
        .map(|name| {
            let folder = root.join(&name);
            (name, folder)
        })
        .collect()
}

#[cfg(test)]
mod tests;
