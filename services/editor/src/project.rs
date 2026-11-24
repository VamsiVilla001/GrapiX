//! Project and scene CRUD (build plan 7.1).
//!
//! The rule this module exists to hold is 7.1's done-when: **a write refuses
//! until a project folder exists.** Creating one implicitly is the tempting
//! convenience and the expensive mistake — a typo in a project name becomes a
//! second, near-identical project, the author's work splits across both, and
//! neither looks wrong from the inside. So `create_project` is the only thing
//! that brings a project into being, and every write into one refuses by name
//! if it is not already there (invariant 18).
//!
//! Scenes are stored as individual documents beneath the project rather than
//! inside the project document, because a scene is the unit that gets
//! published and a project that had to be rewritten to save one scene would
//! put every other scene at risk on every save.

use std::path::{Path, PathBuf};

use gx_contracts::color::{ColorDepth, WorkingColorSpace};
use gx_contracts::control::TakePage;
use gx_contracts::design_system::MotionPreset;
use gx_contracts::project::{
    project_file_name, ProjectDocument, ProjectSettings, ASSETS_FOLDER, AUDIO_FOLDER, FONTS_FOLDER,
    IMAGES_FOLDER, MODELS_FOLDER, PROJECT_SETTINGS_FILE, SOURCES_FOLDER, VIDEOS_FOLDER,
};
use gx_contracts::scene::{parse_scene_document, AssetLibraryItem, SceneDocument};
use gx_contracts::ContentHash;
use gx_contracts::Refusal;
use gx_contracts::Revision;

mod assets;
pub use assets::{detect, AssetClass, Detected, ImportedAsset, MAX_IMAGE_SIDE};

/// The write lock on one project's scenes, held until it drops
/// ([`Projects::lock_scenes`]).
#[derive(Debug)]
pub struct SceneLock {
    _held: gx_fs::FileLock,
}

/// What the Editor service can fail at.
#[derive(Debug)]
pub enum EditorError {
    /// A named refusal from the contract vocabulary.
    Refused(Refusal),
    /// The filesystem did not cooperate. Distinct from a refusal: nothing was
    /// decided, the operation simply could not be carried out.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A durable write did not complete.
    Write(gx_fs::AtomicWriteError),
    /// A document could not be serialised.
    Serialize(serde_json::Error),
    /// A file on disk did not parse. Carries the file, so a library listing
    /// with one bad record says which one.
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Parse { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Write(source) => write!(f, "{source}"),
            Self::Serialize(source) => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for EditorError {}

impl From<Refusal> for EditorError {
    fn from(value: Refusal) -> Self {
        Self::Refused(value)
    }
}

impl From<EditorError> for Refusal {
    /// Flatten an Editor failure into the shared refusal vocabulary.
    ///
    /// A refusal passes through unchanged: it was already the named condition
    /// and re-wrapping it would bury the name a caller is meant to act on. The
    /// rest are failures of the machine rather than decisions about the
    /// request — a disk that would not write is not a judgement on the scene —
    /// so they become `TransportFailed`, which is the variant that means
    /// exactly "nothing was decided" (invariant 17).
    fn from(value: EditorError) -> Self {
        match value {
            EditorError::Refused(refusal) => refusal,
            other => Refusal::TransportFailed {
                detail: other.to_string(),
            },
        }
    }
}

/// Projects on disk, and the scenes inside them.
///
/// Rooted explicitly rather than at the platform data root, so a test and a
/// second instance can each have their own without one of them being a special
/// case of the other.
#[derive(Debug, Clone)]
pub struct Projects {
    root: PathBuf,
}

impl Projects {
    pub fn at_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn project_directory(&self, project: &str) -> PathBuf {
        self.root.join(project)
    }

    fn scenes_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join("scenes")
    }

    /// The settings file projects kept before the `.gpx`; read only to upgrade one.
    fn legacy_settings_path(&self, project: &str) -> PathBuf {
        self.project_directory(project).join(PROJECT_SETTINGS_FILE)
    }

    /// The project's document: `<Project>/<Project>.gpx`.
    pub fn gpx_path(&self, project: &str) -> PathBuf {
        self.project_directory(project)
            .join(project_file_name(project))
    }

    /// `Assets`, which holds the project's pictures, videos, audio and 3D models.
    pub fn assets_root_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join(ASSETS_FOLDER)
    }

    /// `Assets/Images`: png, webp, jpg, jpeg and svg.
    pub fn images_directory(&self, project: &str) -> PathBuf {
        self.assets_root_directory(project).join(IMAGES_FOLDER)
    }

    /// `Assets/Videos`: mp4, mov, avi and webm.
    pub fn videos_directory(&self, project: &str) -> PathBuf {
        self.assets_root_directory(project).join(VIDEOS_FOLDER)
    }

    /// `Assets/Audio`: wav and mp3.
    pub fn audio_directory(&self, project: &str) -> PathBuf {
        self.assets_root_directory(project).join(AUDIO_FOLDER)
    }

    /// `Assets/Models`: gltf, glb, obj, fbx, stl, ply, dae, usd and usdz.
    pub fn models_directory(&self, project: &str) -> PathBuf {
        self.assets_root_directory(project).join(MODELS_FOLDER)
    }

    /// `Fonts`: otf, ttf, woff and woff2.
    pub fn fonts_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join(FONTS_FOLDER)
    }

    fn class_directories(&self, project: &str) -> [PathBuf; 5] {
        [
            self.images_directory(project),
            self.videos_directory(project),
            self.audio_directory(project),
            self.models_directory(project),
            self.fonts_directory(project),
        ]
    }

    /// Whether the project folder holds a child with exactly this name. Case is compared as the
    /// folder lists it, so the old lower-case `assets` is told apart from `Assets` even where the
    /// file system would treat them as one.
    fn has_child(&self, project: &str, name: &str) -> bool {
        std::fs::read_dir(self.project_directory(project))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .any(|e| e.file_name().to_string_lossy() == name)
            })
            .unwrap_or(false)
    }

    /// Move the folders earlier layouts used to where they live now: the hash store `assets`
    /// to `Sources` (so it is not mistaken for the user's `Assets`), and the top-level `Images`
    /// and `Footage` of the first `.gpx` layout into `Assets/Images` and `Assets/Videos`. A move
    /// that would land on something already there is not made.
    fn migrate_folders(&self, project: &str) -> Result<(), EditorError> {
        let base = self.project_directory(project);
        let sources = base.join(SOURCES_FOLDER);
        if self.has_child(project, "assets") && !sources.exists() {
            // Before `Assets` exists: on Windows `assets` and `Assets` are one folder.
            let from = base.join("assets");
            std::fs::rename(&from, &sources)
                .map_err(|source| EditorError::Io { path: from, source })?;
        }
        for (old, new) in [
            ("Images", self.images_directory(project)),
            ("Footage", self.videos_directory(project)),
        ] {
            if self.has_child(project, old) && !new.exists() {
                if let Some(parent) = new.parent() {
                    std::fs::create_dir_all(parent).map_err(|source| EditorError::Io {
                        path: parent.to_path_buf(),
                        source,
                    })?;
                }
                let from = base.join(old);
                std::fs::rename(&from, &new)
                    .map_err(|source| EditorError::Io { path: from, source })?;
            }
        }
        Ok(())
    }

    fn make_folders(&self, project: &str) -> Result<(), EditorError> {
        let mut directories = vec![self.scenes_directory(project)];
        directories.extend(self.class_directories(project));
        for directory in directories {
            std::fs::create_dir_all(&directory).map_err(|source| EditorError::Io {
                path: directory,
                source,
            })?;
        }
        Ok(())
    }

    fn write_document(&self, project: &str, settings: ProjectSettings) -> Result<(), EditorError> {
        let bytes = serde_json::to_vec_pretty(&ProjectDocument::new(project, settings))
            .map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&self.gpx_path(project), &bytes).map_err(EditorError::Write)
    }

    fn take_pages_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join("take-pages")
    }

    fn take_page_path(&self, project: &str, page_id: &str) -> PathBuf {
        self.take_pages_directory(project)
            .join(format!("{page_id}.json"))
    }

    /// Where what a scene retains lives: import sources and assets adopted by content address.
    /// `Sources`, not `assets`: the user's pictures, videos and the rest are in `Assets`.
    fn assets_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join(SOURCES_FOLDER)
    }

    fn motion_presets_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join("motion-presets")
    }

    fn motion_preset_path(&self, project: &str, preset_id: &str) -> PathBuf {
        self.motion_presets_directory(project)
            .join(format!("{preset_id}.json"))
    }

    fn scene_path(&self, project: &str, scene_id: &str) -> PathBuf {
        self.scenes_directory(project)
            .join(format!("{scene_id}.json"))
    }

    /// Create a new project in a folder the user chose, the way File > New does in XPression,
    /// Viz or After Effects: the project is `<parent>/<name>/<name>.gpx`, and the store it
    /// belongs to is `parent`. The folder must already exist (it was picked, not typed), and a
    /// project that is already there is never overwritten.
    pub fn create_in(parent: &Path, name: &str) -> Result<Self, EditorError> {
        Self::create_in_with(parent, name, ProjectSettings::new_project())
    }

    /// [`Projects::create_in`] with the project's declarations chosen, such as the colour
    /// depth the New Project dialog offers.
    pub fn create_in_with(
        parent: &Path,
        name: &str,
        settings: ProjectSettings,
    ) -> Result<Self, EditorError> {
        if !parent.is_absolute() || !parent.is_dir() {
            return Err(Refusal::PlatformDirectoryUnavailable {
                detail: format!(
                    "{} is not a folder that exists; choose where to save the project",
                    parent.display()
                ),
            }
            .into());
        }
        let projects = Self::at_root(parent);
        projects.create_project_with(name, settings)?;
        Ok(projects)
    }

    /// Open a project folder made before the `.gpx`: upgrade it (losslessly, once) and open it
    /// the way [`Projects::open_gpx`] does.
    pub fn open_folder(folder: &Path) -> Result<(Self, String), EditorError> {
        let name = folder
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
            .ok_or_else(|| {
                EditorError::Refused(Refusal::ProjectNameInvalid {
                    project: folder.display().to_string(),
                })
            })?;
        let root = folder.parent().ok_or_else(|| {
            EditorError::Refused(Refusal::ProjectNameInvalid {
                project: folder.display().to_string(),
            })
        })?;
        let projects = Self::at_root(root);
        projects.upgrade_project(&name)?;
        Self::open_gpx(&projects.gpx_path(&name))
    }

    /// Open a project from its `.gpx` file, the way File > Open does in XPression, Viz or After
    /// Effects: the file is `<folder>/<Name>/<Name>.gpx`, and the store it belongs to is the
    /// folder that holds `<Name>`. Returns that store and the project's name.
    ///
    /// The file must be a project document that names the folder it sits in; anything else (a
    /// scene file that also ends in `.gpx`, a renamed copy, a document from a newer build)
    /// refuses by name instead of opening as something it is not.
    pub fn open_gpx(path: &Path) -> Result<(Self, String), EditorError> {
        let invalid = |detail: String| -> EditorError {
            Refusal::ProjectSettingsInvalid {
                project: path.display().to_string(),
                detail,
            }
            .into()
        };
        let folder = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| invalid("a project file sits inside its project folder".into()))?;
        let name = folder
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| invalid("the project folder has no name".into()))?
            .to_owned();
        if path.file_name().and_then(|n| n.to_str()) != Some(project_file_name(&name).as_str()) {
            return Err(invalid(format!(
                "a project file is named after its folder: expected {}",
                project_file_name(&name)
            )));
        }
        let root = folder
            .parent()
            .ok_or_else(|| invalid("the project folder has no parent".into()))?;
        let projects = Self::at_root(root);
        // Read through the same path every read takes, so a bad document refuses the same way.
        projects.settings(&name)?;
        Ok((projects, name))
    }

    /// Save As (11.43): copy a project to `<parent>/<to>/<to>.gpx` and return the store the copy
    /// belongs to, the way File > Save As does in XPression, Viz or After Effects. The source is
    /// left exactly as it was last saved. `changed` are scenes whose newer state replaces their
    /// stored copy in the new project only, which is how work not yet saved moves to the copy.
    ///
    /// Nothing is half made: the copy is built in a staging folder beside its destination and
    /// moved into place as the last step, and a failure removes the staging folder it made. It
    /// never overwrites a project, and it refuses a folder inside the project being copied, which
    /// would copy itself without end. Links and special files in the project are refused by name
    /// rather than followed or dropped.
    ///
    /// The caller holds [`Projects::lock_scenes`] for `from` across the call, so no scene changes
    /// between the check and the copy.
    pub fn save_copy(
        &self,
        from: &str,
        parent: &Path,
        to: &str,
        changed: &[SceneDocument],
    ) -> Result<Self, EditorError> {
        self.require_project(from)?;
        require_component(to, |project| Refusal::ProjectNameInvalid { project })?;
        if !parent.is_absolute() || !parent.is_dir() {
            return Err(Refusal::PlatformDirectoryUnavailable {
                detail: format!(
                    "{} is not a folder that exists; choose where to save the project",
                    parent.display()
                ),
            }
            .into());
        }
        let settings = self.settings(from)?;
        for scene in changed {
            require_component(&scene.id, |id| Refusal::SceneIdInvalid { id })?;
            self.require_working_space(from, scene)?;
        }
        let io = |path: &Path| {
            let path = path.to_path_buf();
            move |source| EditorError::Io { path, source }
        };
        let source = self.project_directory(from);
        let source_real = std::fs::canonicalize(&source).map_err(io(&source))?;
        let parent_real = std::fs::canonicalize(parent).map_err(io(parent))?;
        if parent_real.starts_with(&source_real) {
            return Err(Refusal::PlatformDirectoryUnavailable {
                detail: format!(
                    "{} is inside the project being copied; choose a folder outside it",
                    parent.display()
                ),
            }
            .into());
        }
        let destination = parent.join(to);
        if destination.symlink_metadata().is_ok() {
            return Err(Refusal::ProjectAlreadyExists {
                project: to.to_owned(),
            }
            .into());
        }
        let staging_name = format!("{to}.saving");
        let staging = parent.join(&staging_name);
        // A staging folder left by an earlier attempt is in the way; it is named, not deleted.
        std::fs::create_dir(&staging).map_err(io(&staging))?;
        let build = || -> Result<(), EditorError> {
            copy_project_tree(&source, &staging, true, &project_file_name(from))?;
            let document = serde_json::to_vec_pretty(&ProjectDocument::new(to, settings))
                .map_err(EditorError::Serialize)?;
            let document_path = staging.join(project_file_name(to));
            gx_fs::write_atomic(&document_path, &document).map_err(EditorError::Write)?;
            Self::at_root(parent).make_folders(&staging_name)?;
            for scene in changed {
                let bytes = serde_json::to_vec_pretty(scene).map_err(EditorError::Serialize)?;
                let path = staging.join("scenes").join(format!("{}.json", scene.id));
                gx_fs::write_atomic(&path, &bytes).map_err(EditorError::Write)?;
            }
            std::fs::rename(&staging, &destination).map_err(io(&destination))
        };
        match build() {
            Ok(()) => Ok(Self::at_root(parent)),
            Err(error) => {
                // Only the folder this call made.
                let _ = std::fs::remove_dir_all(&staging);
                Err(error)
            }
        }
    }

    /// Whether a project exists. The question every write asks first. A name
    /// that is not one canonical filename names no project, whatever
    /// directory it would resolve to.
    pub fn exists(&self, project: &str) -> bool {
        gx_contracts::platform::is_canonical_filename(project)
            && self.project_directory(project).is_dir()
    }

    /// The design-system store inside an existing project (G.3, 10.4).
    ///
    /// Goes through the same `require_project` guard every other write uses,
    /// so confirming a brand pack cannot conjure a project directory any more
    /// than saving a scene can.
    pub fn design_system(
        &self,
        project: &str,
    ) -> Result<crate::design_system::DesignSystemStore, EditorError> {
        self.require_project(project)?;
        Ok(crate::design_system::DesignSystemStore::at(
            self.project_directory(project),
        ))
    }

    /// Bring a project into being. The only thing that does.
    ///
    /// A new project declares [`ProjectSettings::new_project`]: it composites
    /// in sRGB, like the design tools its scenes come from (3.15).
    pub fn create_project(&self, project: &str) -> Result<(), EditorError> {
        self.create_project_with(project, ProjectSettings::new_project())
    }

    /// Bring a project into being with explicit settings.
    ///
    /// An existing project refuses rather than being created again: doing so
    /// would rewrite what it declared, and a project that composited in one
    /// space would silently start compositing in another.
    pub fn create_project_with(
        &self,
        project: &str,
        settings: ProjectSettings,
    ) -> Result<(), EditorError> {
        require_component(project, |project| Refusal::ProjectNameInvalid { project })?;
        if self.exists(project) {
            return Err(Refusal::ProjectAlreadyExists {
                project: project.to_owned(),
            }
            .into());
        }
        self.make_folders(project)?;
        self.write_document(project, settings)
    }

    /// Bring a project made before the `.gpx` up to date: write its document with the settings
    /// it declared (a project with no settings file keeps the linear light it was made in),
    /// make its supporting folders, then remove the old settings file. Returns whether it
    /// changed anything. Safe to call again, and safe after a crash half-way: the document is
    /// written before the old file is removed, and a document always wins over the old file.
    pub fn upgrade_project(&self, project: &str) -> Result<bool, EditorError> {
        self.require_project(project)?;
        let legacy = self.legacy_settings_path(project);
        let has_document = self.gpx_path(project).is_file();
        let has_legacy = legacy.is_file();
        let old_layout = self.has_child(project, "assets")
            || self.has_child(project, "Footage")
            || (self.has_child(project, "Images") && !self.images_directory(project).exists());
        let folders_missing = self.class_directories(project).iter().any(|d| !d.is_dir());
        if has_document && !has_legacy && !old_layout && !folders_missing {
            return Ok(false);
        }
        if !has_document {
            let settings = self.settings(project)?;
            self.write_document(project, settings)?;
        }
        self.migrate_folders(project)?;
        self.make_folders(project)?;
        if has_legacy {
            std::fs::remove_file(&legacy).map_err(|source| EditorError::Io {
                path: legacy,
                source,
            })?;
        }
        Ok(true)
    }

    /// What a project declares (3.15).
    ///
    /// A project created before 3.15 has no settings file and reads as
    /// [`ProjectSettings::before_3_15`]: its scenes were authored and rendered
    /// in linear light, so that is what it meant. A file that is present but
    /// unreadable refuses by name instead of reading as absent, because that
    /// would compose every scene in it in the wrong space.
    pub fn settings(&self, project: &str) -> Result<ProjectSettings, EditorError> {
        self.require_project(project)?;
        let invalid = |detail: String| -> EditorError {
            Refusal::ProjectSettingsInvalid {
                project: project.to_owned(),
                detail,
            }
            .into()
        };
        // The document wins; the old settings file is only for a project not yet upgraded.
        let path = self.gpx_path(project);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let document: ProjectDocument =
                    serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
                document.check(project).map_err(invalid)?;
                return Ok(document.settings);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(EditorError::Io { path, source }),
        }
        let legacy = self.legacy_settings_path(project);
        match std::fs::read(&legacy) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(ProjectSettings::before_3_15())
            }
            Err(source) => Err(EditorError::Io {
                path: legacy,
                source,
            }),
        }
    }

    /// A scene composites in its project's space or not at all (3.15).
    fn require_working_space(
        &self,
        project: &str,
        scene: &SceneDocument,
    ) -> Result<(), EditorError> {
        let settings = self.settings(project)?;
        let declared: WorkingColorSpace = settings.working_color_space;
        if scene.working_color_space != declared {
            return Err(Refusal::SceneWorkingSpaceMismatch {
                project: project.to_owned(),
                scene_id: scene.id.clone(),
                scene: scene.working_color_space,
                project_space: declared,
            }
            .into());
        }
        let depth: ColorDepth = settings.color_depth;
        if scene.color_depth != depth {
            return Err(Refusal::SceneColorDepthMismatch {
                project: project.to_owned(),
                scene_id: scene.id.clone(),
                scene: scene.color_depth,
                project_depth: depth,
            }
            .into());
        }
        Ok(())
    }

    /// Write a filled take-page instance into an existing project.
    ///
    /// Pages live beside, rather than inside, their templates: filling one must
    /// never rewrite the authored scene it references.
    pub fn write_take_page(&self, project: &str, page: &TakePage) -> Result<(), EditorError> {
        self.require_project(project)?;
        require_component(&page.page_id, |page_id| Refusal::TakePageIdInvalid {
            page_id,
        })?;
        let directory = self.take_pages_directory(project);
        std::fs::create_dir_all(&directory).map_err(|source| EditorError::Io {
            path: directory,
            source,
        })?;
        let bytes = serde_json::to_vec_pretty(page).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&self.take_page_path(project, &page.page_id), &bytes)
            .map_err(EditorError::Write)
    }

    /// Read a filled take-page without opening or changing its template.
    pub fn read_take_page(&self, project: &str, page_id: &str) -> Result<TakePage, EditorError> {
        self.require_project(project)?;
        require_component(page_id, |page_id| Refusal::TakePageIdInvalid { page_id })?;
        let path = self.take_page_path(project, page_id);
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io { path, source })?;
        serde_json::from_slice(&bytes).map_err(EditorError::Serialize)
    }

    /// Take-page ids in a project, sorted as scene ids are.
    pub fn list_take_pages(&self, project: &str) -> Result<Vec<String>, EditorError> {
        self.require_project(project)?;
        let directory = self.take_pages_directory(project);
        let mut ids = match std::fs::read_dir(&directory) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let path = entry.path();
                    (path.extension().and_then(|extension| extension.to_str()) == Some("json"))
                        .then(|| path.file_stem()?.to_str().map(str::to_owned))
                        .flatten()
                })
                .collect::<Vec<_>>(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(source) => {
                return Err(EditorError::Io {
                    path: directory,
                    source,
                })
            }
        };
        ids.sort();
        Ok(ids)
    }

    /// Save one motion preset into the project's library, replacing the file
    /// of the same id (11.15). Saved in place, never versioned: a design-system
    /// version stays immutable and this is the working library beside it.
    pub fn write_motion_preset(
        &self,
        project: &str,
        preset: &MotionPreset,
    ) -> Result<(), EditorError> {
        self.require_project(project)?;
        require_component(&preset.id, |preset_id| Refusal::MotionPresetIdInvalid {
            preset_id,
        })?;
        let directory = self.motion_presets_directory(project);
        std::fs::create_dir_all(&directory).map_err(|source| EditorError::Io {
            path: directory,
            source,
        })?;
        let bytes = serde_json::to_vec_pretty(preset).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&self.motion_preset_path(project, &preset.id), &bytes)
            .map_err(EditorError::Write)
    }

    /// One saved preset, or `None` when the library has no such id.
    pub fn read_motion_preset(
        &self,
        project: &str,
        preset_id: &str,
    ) -> Result<Option<MotionPreset>, EditorError> {
        self.require_project(project)?;
        require_component(preset_id, |preset_id| Refusal::MotionPresetIdInvalid {
            preset_id,
        })?;
        let path = self.motion_preset_path(project, preset_id);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(EditorError::Serialize),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(EditorError::Io { path, source }),
        }
    }

    /// Every saved preset in a project, sorted by id. A file that does not
    /// parse is an error naming it, never a preset silently left out.
    pub fn motion_presets(&self, project: &str) -> Result<Vec<MotionPreset>, EditorError> {
        self.require_project(project)?;
        let mut paths = directory_paths(&self.motion_presets_directory(project))?
            .into_iter()
            .filter(|path| {
                path.extension().and_then(|extension| extension.to_str()) == Some("json")
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths.iter().map(|path| read_json(path)).collect()
    }

    /// Take an asset into the project: its bytes under `assets/<hash>.<ext>`
    /// and its library record beside them as `assets/<hash>.json`.
    ///
    /// The project folder owns its assets, so it can be copied, archived or
    /// opened on another machine without a per-user cache. The on-disk name is
    /// the content hash (ADR-0002 B.3: never derive a filename from user
    /// text); the extension is chosen from a closed set so the folder stays
    /// readable in a file browser. The bytes are re-hashed first: bytes that
    /// are not the asset's address are refused, never filed under it.
    pub fn adopt_asset(
        &self,
        project: &str,
        item: &AssetLibraryItem,
        bytes: &[u8],
    ) -> Result<(), EditorError> {
        self.require_project(project)?;
        self.upgrade_project(project)?;
        let hash = asset_hash(item)?;
        let actual = gx_asset_plane::content_hash(bytes);
        if actual != hash {
            return Err(Refusal::AssetHashMismatch {
                expected: hash,
                actual,
            }
            .into());
        }
        let directory = self.assets_directory(project);
        std::fs::create_dir_all(&directory).map_err(|source| EditorError::Io {
            path: directory.clone(),
            source,
        })?;
        let extension = asset_extension(item);
        gx_fs::write_atomic(&directory.join(format!("{}.{extension}", hash.0)), bytes)
            .map_err(EditorError::Write)?;
        let record = serde_json::to_vec_pretty(item).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&directory.join(format!("{}.json", hash.0)), &record)
            .map_err(EditorError::Write)
    }

    /// Whether the project already holds the bytes for this content address.
    pub fn has_asset(&self, project: &str, hash: &ContentHash) -> Result<bool, EditorError> {
        Ok(self.asset_file(project, hash)?.is_some())
    }

    /// The verified bytes of a project asset, or `None` when the project does
    /// not hold them. A file whose bytes no longer match its name is an error
    /// naming the hash, never served.
    pub fn read_asset(
        &self,
        project: &str,
        hash: &ContentHash,
    ) -> Result<Option<Vec<u8>>, EditorError> {
        let Some(path) = self.asset_file(project, hash)? else {
            return Ok(None);
        };
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io { path, source })?;
        let actual = gx_asset_plane::content_hash(&bytes);
        if &actual != hash {
            return Err(Refusal::AssetHashMismatch {
                expected: hash.clone(),
                actual,
            }
            .into());
        }
        Ok(Some(bytes))
    }

    /// Every asset record the project holds, sorted by name then id. A record
    /// that does not parse is an error naming its file, never a quietly
    /// shorter library.
    pub fn project_assets(&self, project: &str) -> Result<Vec<AssetLibraryItem>, EditorError> {
        self.require_project(project)?;
        let mut paths = directory_paths(&self.assets_directory(project))?
            .into_iter()
            .filter(|path| {
                path.extension().and_then(|extension| extension.to_str()) == Some("json")
            })
            .collect::<Vec<_>>();
        paths.sort();
        let mut items = paths
            .iter()
            .map(|path| read_json::<AssetLibraryItem>(path))
            .collect::<Result<Vec<_>, _>>()?;
        // What is filed in Assets and Fonts is the project's assets too.
        items.extend(
            self.project_files(project)?
                .into_iter()
                .map(|(item, _)| item),
        );
        items.sort_by(|a, b| {
            a.name
                .cmp(&b.name)
                .then_with(|| a.asset_id.cmp(&b.asset_id))
        });
        Ok(items)
    }

    /// The file holding a content address, found by its hash prefix so the
    /// extension never has to be known to look it up.
    fn asset_file(
        &self,
        project: &str,
        hash: &ContentHash,
    ) -> Result<Option<PathBuf>, EditorError> {
        self.require_project(project)?;
        require_hash(hash)?;
        let prefix = format!("{}.", hash.0);
        let filed = directory_paths(&self.assets_directory(project))?
            .into_iter()
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix) && !name.ends_with(".json"))
            });
        match filed {
            Some(path) => Ok(Some(path)),
            // A file in Assets or Fonts is found by its content like any asset.
            None => self.media_file_by_hash(project, hash),
        }
    }

    /// The projects that exist, in directory order.
    pub fn list_projects(&self) -> Result<Vec<String>, EditorError> {
        let mut names = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            // A root that does not exist holds no projects, which is an answer
            // rather than a failure.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(source) => {
                return Err(EditorError::Io {
                    path: self.root.clone(),
                    source,
                })
            }
        };
        names.sort();
        Ok(names)
    }

    /// The refusal every write runs first.
    ///
    /// Factored out so that adding a write cannot accidentally omit it: there
    /// is one place that answers "may I write into this project", and a new
    /// operation that forgets to call it fails its own test rather than
    /// silently creating directories.
    ///
    /// The name is checked before existence: a project is one directory under
    /// the root, and `../elsewhere` names a directory that may well exist.
    fn require_project(&self, project: &str) -> Result<(), EditorError> {
        require_component(project, |project| Refusal::ProjectNameInvalid { project })?;
        if self.exists(project) {
            Ok(())
        } else {
            Err(Refusal::ProjectNotFound {
                project: project.to_owned(),
            }
            .into())
        }
    }

    /// Write a scene into an existing project.
    pub fn write_scene(&self, project: &str, scene: &SceneDocument) -> Result<(), EditorError> {
        self.require_project(project)?;
        self.upgrade_project(project)?;
        require_component(&scene.id, |id| Refusal::SceneIdInvalid { id })?;
        self.require_working_space(project, scene)?;
        let bytes = serde_json::to_vec_pretty(scene).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&self.scene_path(project, &scene.id), &bytes)
            .map_err(EditorError::Write)
    }

    /// Read a scene back, through the same closed reader the engine uses.
    ///
    /// Parsing goes through `parse_scene_document` rather than plain serde so
    /// that a document the Editor accepts is one the engine will also parse
    /// (invariant 45). A laxer reader here would let an author save something
    /// that only refuses at publish.
    pub fn read_scene(&self, project: &str, scene_id: &str) -> Result<SceneDocument, EditorError> {
        self.require_project(project)?;
        require_component(scene_id, |id| Refusal::SceneIdInvalid { id })?;
        let path = self.scene_path(project, scene_id);
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io { path, source })?;
        let scene = parse_scene_document(&bytes).map_err(EditorError::Refused)?;
        self.require_working_space(project, &scene)?;
        Ok(scene)
    }

    /// Take the write lock for one project's scenes (8.12).
    ///
    /// A stored write that checks a revision is a compare-and-swap only if no
    /// other writer can land between its read and its write. The writers are
    /// the Editor shell and every MCP server process, so this is a lock on a
    /// file, which holds across processes. Hold it for the whole of a
    /// read-check-write, and for a create's exists-then-write. It is released
    /// when the value drops, and by the operating system if the process dies.
    pub fn lock_scenes(&self, project: &str) -> Result<SceneLock, EditorError> {
        self.require_project(project)?;
        let path = self.project_directory(project).join(SCENES_LOCK_FILE);
        gx_fs::FileLock::exclusive(&path)
            .map(|held| SceneLock { _held: held })
            .map_err(|source| EditorError::Io { path, source })
    }

    /// A stored scene's authoring revision (8.12), read without validating the
    /// document: absent is 0, and a file that cannot be read as a scene has no
    /// revision to compare, which is `None`. A scene whose file is damaged can
    /// therefore still be saved over, as it could before revisions existed.
    pub fn stored_revision(
        &self,
        project: &str,
        scene_id: &str,
    ) -> Result<Option<Revision>, EditorError> {
        self.require_project(project)?;
        require_component(scene_id, |id| Refusal::SceneIdInvalid { id })?;
        let path = self.scene_path(project, scene_id);
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io { path, source })?;
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return Ok(None);
        };
        Ok(Some(Revision(
            value
                .get("revision")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )))
    }

    /// The scene ids in a project, sorted.
    pub fn list_scenes(&self, project: &str) -> Result<Vec<String>, EditorError> {
        self.require_project(project)?;
        let directory = self.scenes_directory(project);
        let mut ids: Vec<String> = std::fs::read_dir(&directory)
            .map_err(|source| EditorError::Io {
                path: directory,
                source,
            })?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                (path.extension().and_then(|e| e.to_str()) == Some("json"))
                    .then(|| path.file_stem()?.to_str().map(str::to_owned))
                    .flatten()
            })
            .collect();
        ids.sort();
        Ok(ids)
    }

    /// Delete a scene. Absent is reported, never treated as success.
    pub fn delete_scene(&self, project: &str, scene_id: &str) -> Result<(), EditorError> {
        self.require_project(project)?;
        require_component(scene_id, |id| Refusal::SceneIdInvalid { id })?;
        let path = self.scene_path(project, scene_id);
        std::fs::remove_file(&path).map_err(|source| EditorError::Io { path, source })
    }
}

/// The lock file a project keeps while its scenes are being written; never part of a copy.
const SCENES_LOCK_FILE: &str = ".scenes.lock";

/// Copy a project folder into an empty one: files and folders only. The scene lock and the
/// source's own document (`skip_document`, rewritten under the new name) are left behind, and a
/// link or special file refuses by name, since following it could copy something outside the
/// project and dropping it would lose it.
fn copy_project_tree(
    from: &Path,
    to: &Path,
    top: bool,
    skip_document: &str,
) -> Result<(), EditorError> {
    let entries = std::fs::read_dir(from).map_err(|source| EditorError::Io {
        path: from.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| EditorError::Io {
            path: from.to_path_buf(),
            source,
        })?;
        let name = entry.file_name();
        if top && (name == SCENES_LOCK_FILE || name == skip_document) {
            continue;
        }
        let source_path = entry.path();
        let target = to.join(&name);
        let kind = entry.file_type().map_err(|source| EditorError::Io {
            path: source_path.clone(),
            source,
        })?;
        if kind.is_dir() {
            std::fs::create_dir(&target).map_err(|source| EditorError::Io {
                path: target.clone(),
                source,
            })?;
            copy_project_tree(&source_path, &target, false, skip_document)?;
        } else if kind.is_file() {
            std::fs::copy(&source_path, &target).map_err(|source| EditorError::Io {
                path: source_path,
                source,
            })?;
        } else {
            return Err(EditorError::Io {
                path: source_path,
                source: std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "a link or special file cannot be copied into a project; remove it or replace it with the file itself",
                ),
            });
        }
    }
    Ok(())
}

/// Refuse a project, scene or take-page id that is not one canonical filename.
///
/// Every id becomes a path component under the store root, so an id that is
/// not already a single, canonical component — `../escape`, `a/b`, a trailing
/// dot Windows would drop — would address a file the store does not own.
/// Refused rather than sanitised: rewriting the id would save the author's
/// work under a name they did not choose.
/// A content address is 64 lowercase hex digits; anything else could name a
/// path outside the project's asset folder.
fn require_hash(hash: &ContentHash) -> Result<(), EditorError> {
    if hash.0.len() == 64
        && hash
            .0
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(Refusal::AssetMissing { hash: hash.clone() }.into())
    }
}

/// The paths in a library folder; empty when the folder does not exist yet.
/// An entry the system cannot read is an error against the folder, never a
/// file quietly missing from the listing.
fn directory_paths(directory: &Path) -> Result<Vec<PathBuf>, EditorError> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(EditorError::Io {
                path: directory.to_path_buf(),
                source,
            })
        }
    };
    entries
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|source| EditorError::Io {
                    path: directory.to_path_buf(),
                    source,
                })
        })
        .collect()
}

/// One library record, with a read or parse failure naming its file.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, EditorError> {
    let bytes = std::fs::read(path).map_err(|source| EditorError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|source| EditorError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

fn asset_hash(item: &AssetLibraryItem) -> Result<ContentHash, EditorError> {
    let hash = item.checksum.clone().ok_or_else(|| Refusal::AssetMissing {
        hash: ContentHash(String::new()),
    })?;
    require_hash(&hash)?;
    Ok(hash)
}

/// The extension a project asset file carries: the library path's own, if it
/// is a short alphanumeric one, otherwise `bin`.
fn asset_extension(item: &AssetLibraryItem) -> String {
    std::path::Path::new(&item.path)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| {
            (1..=5).contains(&extension.len())
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .map_or_else(|| "bin".to_owned(), str::to_ascii_lowercase)
}

fn require_component(
    value: &str,
    refusal: impl FnOnce(String) -> Refusal,
) -> Result<(), EditorError> {
    if gx_contracts::platform::is_canonical_filename(value) {
        Ok(())
    } else {
        Err(refusal(value.to_owned()).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::provenance::{
        AssetApproval, AssetOrigin, AssetProvenance, LicenseClass, ProvenanceTool,
    };
    use gx_contracts::scene::{AssetKind, AssetLibraryItem, SceneCanvas, SceneTimeline};
    use gx_contracts::{RationalRate, Revision};

    fn scratch(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gx-editor-{label}-{nanos}"));
        std::fs::create_dir_all(&path).expect("scratch directory");
        path
    }

    fn scene(id: &str) -> SceneDocument {
        SceneDocument {
            working_color_space: WorkingColorSpace::NEW_PROJECT,
            color_depth: ColorDepth::NEW_PROJECT,
            id: id.into(),
            name: id.into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 1,
                ..Default::default()
            },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            path_links: Vec::new(),
            guides: Vec::new(),
            scene_label: None,
            objects: Vec::new(),
        }
    }

    #[test]
    fn a_write_into_a_project_that_does_not_exist_refuses_by_name() {
        // 7.1's done-when. The failure being prevented is a typo becoming a
        // second project that looks perfectly normal from the inside.
        let root = scratch("missing-project");
        let projects = Projects::at_root(&root);

        let error = projects
            .write_scene("no-such-project", &scene("lower-third"))
            .expect_err("a write must not conjure a project");
        assert!(
            matches!(
                &error,
                EditorError::Refused(Refusal::ProjectNotFound { project })
                    if project == "no-such-project"
            ),
            "expected ProjectNotFound, got {error}"
        );
        assert!(
            !root.join("no-such-project").exists(),
            "the refused write must not have created anything"
        );

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn the_same_write_succeeds_once_the_project_exists() {
        let root = scratch("create-then-write");
        let projects = Projects::at_root(&root);

        projects
            .create_project("news")
            .expect("a project is created");
        projects
            .write_scene("news", &scene("lower-third"))
            .expect("the same write now succeeds");

        let read_back = projects
            .read_scene("news", "lower-third")
            .expect("what was written can be read");
        assert_eq!(read_back, scene("lower-third"));
        assert_eq!(projects.list_scenes("news").unwrap(), vec!["lower-third"]);
        assert_eq!(projects.list_projects().unwrap(), vec!["news"]);

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn every_read_and_list_also_refuses_a_missing_project() {
        // The guard is on one path, so a new operation that forgets it fails
        // here rather than quietly succeeding against nothing.
        let root = scratch("guard-everywhere");
        let projects = Projects::at_root(&root);

        for outcome in [
            projects.read_scene("nope", "s").err(),
            projects.list_scenes("nope").err(),
            projects.delete_scene("nope", "s").err(),
        ] {
            assert!(
                matches!(
                    outcome,
                    Some(EditorError::Refused(Refusal::ProjectNotFound { .. }))
                ),
                "every operation must refuse a missing project by name"
            );
        }

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn a_scene_the_engine_would_reject_does_not_read_back() {
        // The Editor reads through the same closed schema the engine uses
        // (invariant 45), so an unknown field is caught at authoring time
        // rather than at publish.
        let root = scratch("closed-reader");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();

        let mut document = serde_json::to_value(scene("odd")).unwrap();
        document["notAField"] = serde_json::json!(true);
        std::fs::write(
            root.join("news").join("scenes").join("odd.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();

        let error = projects
            .read_scene("news", "odd")
            .expect_err("an unknown field must refuse");
        assert!(matches!(
            error,
            EditorError::Refused(Refusal::SceneUnknownField { .. })
        ));

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn an_id_that_is_not_one_canonical_filename_never_reaches_the_filesystem() {
        let root = scratch("components");
        let projects = Projects::at_root(root.join("store"));
        std::fs::create_dir_all(root.join("outside").join("scenes")).unwrap();

        assert!(matches!(
            projects.create_project("../outside2"),
            Err(EditorError::Refused(Refusal::ProjectNameInvalid { project })) if project == "../outside2"
        ));
        assert!(
            !root.join("outside2").exists(),
            "the refused create wrote nothing"
        );
        // The directory exists, so only the name check stands between this
        // write and a file outside the store.
        assert!(matches!(
            projects.write_scene("../outside", &scene("escape")),
            Err(EditorError::Refused(Refusal::ProjectNameInvalid { .. }))
        ));

        projects.create_project("news").unwrap();
        for outcome in [
            projects.write_scene("news", &scene("../escape")).err(),
            projects.read_scene("news", "../escape").err(),
            projects.delete_scene("news", "a/b").err(),
        ] {
            assert!(
                matches!(
                    outcome,
                    Some(EditorError::Refused(Refusal::SceneIdInvalid { .. }))
                ),
                "a scene id is one filename, never a path: {outcome:?}"
            );
        }
        let page = TakePage {
            page_id: "../page".into(),
            name: "Page".into(),
            scene_id: "lower-third".into(),
            values: Default::default(),
        };
        assert!(matches!(
            projects.write_take_page("news", &page),
            Err(EditorError::Refused(Refusal::TakePageIdInvalid { .. }))
        ));
        assert!(matches!(
            projects.read_take_page("news", "../page"),
            Err(EditorError::Refused(Refusal::TakePageIdInvalid { .. }))
        ));
        assert!(!root
            .join("outside")
            .join("scenes")
            .join("escape.json")
            .exists());

        std::fs::remove_dir_all(root).expect("clean up");
    }

    /// 11.39's migration. The fixture is a scene exactly as the Editor saved
    /// it before provenance existed (written by the pre-11.39 build): it reads
    /// at the current schema, every asset gains an empty provenance record,
    /// nothing else changes, and once saved it reloads byte-for-byte.
    #[test]
    fn a_project_saved_before_provenance_upgrades_losslessly() {
        const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/pre-11.39/witness.json");
        let root = scratch("pre-11.39");
        let projects = Projects::at_root(&root);
        projects.create_project("legacy").unwrap();
        // A project from before 11.39 is also from before 3.15: no settings file.
        std::fs::remove_file(projects.gpx_path("legacy")).unwrap();
        let path = root.join("legacy").join("scenes").join("witness.json");
        std::fs::write(&path, FIXTURE).unwrap();

        let upgraded = projects
            .read_scene("legacy", "witness")
            .expect("a version 1 scene reads");
        let original: serde_json::Value = serde_json::from_slice(FIXTURE).unwrap();
        assert_eq!(original["version"], 1, "the fixture predates 11.39");
        assert_eq!(upgraded.version, gx_contracts::scene::SCENE_SCHEMA_VERSION);
        assert_eq!(upgraded.assets.len(), 3);
        assert!(upgraded
            .assets
            .iter()
            .all(|asset| asset.provenance == AssetProvenance::default()));

        // Take away exactly what the upgrade adds; what remains is the
        // original, value for value.
        let mut after = serde_json::to_value(&upgraded).unwrap();
        after["version"] = original["version"].clone();
        for asset in after["assets"].as_array_mut().unwrap() {
            asset.as_object_mut().unwrap().remove("provenance");
        }
        assert_eq!(upgraded.working_color_space, WorkingColorSpace::BEFORE_3_15);
        after.as_object_mut().unwrap().remove("workingColorSpace");
        assert_eq!(upgraded.color_depth, ColorDepth::BEFORE_DEPTH);
        after.as_object_mut().unwrap().remove("colorDepth");
        assert_eq!(
            after, original,
            "the upgrade changed something the document stated"
        );

        projects.write_scene("legacy", &upgraded).unwrap();
        let saved = std::fs::read(&path).unwrap();
        let reread = projects.read_scene("legacy", "witness").unwrap();
        assert_eq!(reread, upgraded);
        projects.write_scene("legacy", &reread).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), saved);

        // A scene from a newer build is refused by name, never read with
        // whatever it added dropped.
        let mut newer = original;
        let supported = gx_contracts::scene::SCENE_SCHEMA_VERSION;
        newer["version"] = serde_json::json!(supported + 1);
        std::fs::write(&path, serde_json::to_vec(&newer).unwrap()).unwrap();
        assert!(matches!(
            projects.read_scene("legacy", "witness"),
            Err(EditorError::Refused(Refusal::SceneSchemaUnsupported {
                actual,
                supported: held
            })) if actual == supported + 1 && held == supported
        ));

        std::fs::remove_dir_all(root).expect("clean up");
    }

    /// 3.15's migration. The fixture is a scene exactly as the schema-2
    /// Editor saved it: generated on 13 October 2026 by the build at
    /// 44a8c3d, reading the pre-11.39 witness and saving it through
    /// `Projects::write_scene`. In a project created before 3.15 (no
    /// settings file) it reads at schema 3 composited in linear light,
    /// nothing else changes, and once saved it reloads byte-for-byte. The
    /// same scene refuses by name in a project that declares sRGB.
    #[test]
    fn a_scene_saved_before_working_spaces_upgrades_to_linear_losslessly() {
        const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/pre-3.15/witness.json");
        let root = scratch("pre-3.15");
        let projects = Projects::at_root(&root);
        projects.create_project("legacy").unwrap();
        std::fs::remove_file(projects.gpx_path("legacy")).unwrap();
        assert_eq!(
            projects.settings("legacy").unwrap(),
            ProjectSettings::before_3_15()
        );
        let path = root.join("legacy").join("scenes").join("witness.json");
        std::fs::write(&path, FIXTURE).unwrap();

        let upgraded = projects
            .read_scene("legacy", "witness")
            .expect("a version 2 scene reads");
        let original: serde_json::Value = serde_json::from_slice(FIXTURE).unwrap();
        assert_eq!(original["version"], 2, "the fixture predates 3.15");
        assert!(original.get("workingColorSpace").is_none());
        assert_eq!(upgraded.version, gx_contracts::scene::SCENE_SCHEMA_VERSION);
        assert_eq!(upgraded.working_color_space, WorkingColorSpace::LinearSrgb);

        let mut after = serde_json::to_value(&upgraded).unwrap();
        after["version"] = original["version"].clone();
        after.as_object_mut().unwrap().remove("workingColorSpace");
        assert_eq!(upgraded.color_depth, ColorDepth::BEFORE_DEPTH);
        after.as_object_mut().unwrap().remove("colorDepth");
        assert_eq!(
            after, original,
            "the upgrade changed something the document stated"
        );

        projects.write_scene("legacy", &upgraded).unwrap();
        let saved = std::fs::read(&path).unwrap();
        let reread = projects.read_scene("legacy", "witness").unwrap();
        assert_eq!(reread, upgraded);
        projects.write_scene("legacy", &reread).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), saved);

        projects.create_project("design").unwrap();
        std::fs::write(
            root.join("design").join("scenes").join("witness.json"),
            FIXTURE,
        )
        .unwrap();
        assert!(matches!(
            projects.read_scene("design", "witness"),
            Err(EditorError::Refused(Refusal::SceneWorkingSpaceMismatch {
                scene: WorkingColorSpace::LinearSrgb,
                project_space: WorkingColorSpace::Srgb,
                ..
            }))
        ));

        std::fs::remove_dir_all(root).expect("clean up");
    }

    /// 3.15: a project declares its working space once, every scene in it
    /// carries the same one, and a scene that differs refuses by name and is
    /// never written.
    #[test]
    fn a_project_declares_its_working_space_and_refuses_scenes_that_differ() {
        let root = scratch("working-space");
        let projects = Projects::at_root(&root);
        projects.create_project("show").unwrap();
        let file = std::fs::read(projects.gpx_path("show")).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&file).unwrap(),
            serde_json::json!({
                "schemaVersion": 1,
                "name": "show",
                "settings": { "workingColorSpace": "srgb", "colorDepth": "16" }
            })
        );
        assert_eq!(
            projects.settings("show").unwrap().working_color_space,
            WorkingColorSpace::Srgb
        );

        let mut linear = scene("linear");
        linear.working_color_space = WorkingColorSpace::LinearSrgb;
        assert!(matches!(
            projects.write_scene("show", &linear),
            Err(EditorError::Refused(
                Refusal::SceneWorkingSpaceMismatch { .. }
            ))
        ));
        assert!(
            !root
                .join("show")
                .join("scenes")
                .join("linear.json")
                .exists(),
            "a refused scene is not written"
        );

        projects
            .create_project_with(
                "physical",
                ProjectSettings {
                    working_color_space: WorkingColorSpace::LinearSrgb,
                    color_depth: ColorDepth::NEW_PROJECT,
                },
            )
            .unwrap();
        projects
            .write_scene("physical", &linear)
            .expect("a linear scene belongs in a linear project");
        assert_eq!(projects.read_scene("physical", "linear").unwrap(), linear);

        assert!(
            matches!(
                projects.create_project("show"),
                Err(EditorError::Refused(Refusal::ProjectAlreadyExists { .. }))
            ),
            "creating a project again never rewrites what it declared"
        );

        std::fs::write(projects.gpx_path("show"), br#"{"workingColorSpace":"hdr"}"#).unwrap();
        assert!(matches!(
            projects.settings("show"),
            Err(EditorError::Refused(Refusal::ProjectSettingsInvalid { .. }))
        ));

        std::fs::remove_dir_all(root).expect("clean up");
    }

    /// 11.43: a project is a named `.gpx` beside its supporting folders, like an XPression
    /// project beside Images and Fonts.
    #[test]
    fn a_project_is_a_named_gpx_beside_its_assets_and_fonts() {
        let root = scratch("gpx-layout");
        let projects = Projects::at_root(&root);
        projects.create_project("Finals").unwrap();
        let folder = root.join("Finals");
        assert!(folder.join("Finals.gpx").is_file());
        for name in [
            "Assets/Images",
            "Assets/Videos",
            "Assets/Audio",
            "Assets/Models",
            "Fonts",
            "scenes",
        ] {
            assert!(folder.join(name).is_dir(), "{name}");
        }
        assert!(
            !folder.join("Footage").exists(),
            "footage is Assets/Videos now"
        );
        assert!(
            !folder.join(PROJECT_SETTINGS_FILE).exists(),
            "the settings live in the document, not a second file"
        );
        assert_eq!(
            projects.images_directory("Finals"),
            folder.join("Assets").join("Images")
        );
        assert_eq!(
            projects.videos_directory("Finals"),
            folder.join("Assets").join("Videos")
        );
        assert_eq!(
            projects.audio_directory("Finals"),
            folder.join("Assets").join("Audio")
        );
        assert_eq!(
            projects.models_directory("Finals"),
            folder.join("Assets").join("Models")
        );
        assert_eq!(projects.fonts_directory("Finals"), folder.join("Fonts"));
        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn a_project_made_before_the_gpx_upgrades_on_its_first_write_keeping_its_space() {
        let root = scratch("gpx-upgrade");
        let projects = Projects::at_root(&root);
        // Two old shapes: one with a settings file (sRGB), one with none (linear, pre-3.15).
        for (name, settings) in [
            (
                "declared",
                Some(br#"{"workingColorSpace":"srgb"}"#.as_slice()),
            ),
            ("undeclared", None),
        ] {
            let folder = root.join(name);
            std::fs::create_dir_all(folder.join("scenes")).unwrap();
            if let Some(bytes) = settings {
                std::fs::write(folder.join(PROJECT_SETTINGS_FILE), bytes).unwrap();
            }
        }
        assert_eq!(
            projects.settings("declared").unwrap().working_color_space,
            WorkingColorSpace::Srgb,
            "an old project reads without being changed"
        );
        assert!(
            !projects.gpx_path("declared").exists(),
            "a read writes nothing"
        );

        // No depth in an old settings file means the 32-bit float it rendered in.
        assert_eq!(
            projects.settings("declared").unwrap().color_depth,
            ColorDepth::BEFORE_DEPTH
        );
        let mut before_depth = scene("a");
        before_depth.color_depth = ColorDepth::BEFORE_DEPTH;
        projects.write_scene("declared", &before_depth).unwrap();
        assert!(projects.gpx_path("declared").is_file());
        assert!(!root.join("declared").join(PROJECT_SETTINGS_FILE).exists());
        assert!(root.join("declared").join("Assets").join("Images").is_dir());
        assert_eq!(
            projects.settings("declared").unwrap().working_color_space,
            WorkingColorSpace::Srgb
        );
        assert_eq!(
            projects.settings("declared").unwrap().color_depth,
            ColorDepth::BEFORE_DEPTH,
            "the upgrade keeps the depth the project had"
        );
        assert!(
            !projects.upgrade_project("declared").unwrap(),
            "already current"
        );

        assert!(projects.upgrade_project("undeclared").unwrap());
        assert_eq!(
            projects.settings("undeclared").unwrap(),
            ProjectSettings::before_3_15(),
            "a project with no settings keeps the linear light it was made in, now written down"
        );
        std::fs::remove_dir_all(root).expect("clean up");
    }

    /// File > Open: a project is opened from its `.gpx`, and only from one that is a project.
    #[test]
    fn a_project_opens_from_its_gpx_path_and_nothing_else_opens() {
        let root = scratch("gpx-open");
        let chosen = root.join("My Shows");
        let projects = Projects::at_root(&chosen);
        projects.create_project("Finals").unwrap();
        projects.write_scene("Finals", &scene("a")).unwrap();

        let (opened, name) = Projects::open_gpx(&projects.gpx_path("Finals")).unwrap();
        assert_eq!(name, "Finals");
        assert_eq!(opened.root(), chosen);
        assert_eq!(opened.list_scenes("Finals").unwrap(), ["a"]);

        // A renamed copy, a scene file that also ends in .gpx, a missing file and a bare name.
        let copy = chosen.join("Finals").join("Copy of Finals.gpx");
        std::fs::copy(projects.gpx_path("Finals"), &copy).unwrap();
        assert!(Projects::open_gpx(&copy).is_err(), "named after its folder");
        let scene_file = chosen.join("Finals").join("Finals.gpx.bak");
        std::fs::write(&scene_file, b"{}").unwrap();
        assert!(Projects::open_gpx(&scene_file).is_err());
        assert!(Projects::open_gpx(&chosen.join("Nothing").join("Nothing.gpx")).is_err());
        assert!(Projects::open_gpx(Path::new("Finals.gpx")).is_err());
        std::fs::write(projects.gpx_path("Finals"), br#"{"scene":true}"#).unwrap();
        assert!(
            Projects::open_gpx(&projects.gpx_path("Finals")).is_err(),
            "a file that is not a project document does not open as one"
        );
        std::fs::remove_dir_all(root).expect("clean up");
    }

    /// File > New: a project is made in the folder the user chose, never over another.
    #[test]
    fn a_project_is_created_in_the_chosen_folder_and_never_over_another() {
        let root = scratch("create-in");
        let chosen = root.join("My Shows");
        std::fs::create_dir_all(&chosen).unwrap();
        let projects = Projects::create_in(&chosen, "Finals").unwrap();
        assert!(chosen.join("Finals").join("Finals.gpx").is_file());
        assert_eq!(projects.root(), chosen);
        // It can be opened again from the file.
        let (_, name) = Projects::open_gpx(&projects.gpx_path("Finals")).unwrap();
        assert_eq!(name, "Finals");

        assert!(
            matches!(
                Projects::create_in(&chosen, "Finals"),
                Err(EditorError::Refused(Refusal::ProjectAlreadyExists { .. }))
            ),
            "a project already there is never overwritten"
        );
        for bad in ["", "a/b", "..", "CON", "x:y"] {
            assert!(Projects::create_in(&chosen, bad).is_err(), "{bad:?}");
        }
        assert!(
            matches!(
                Projects::create_in(&root.join("not made"), "X"),
                Err(EditorError::Refused(
                    Refusal::PlatformDirectoryUnavailable { .. }
                ))
            ),
            "the folder is picked, so it must exist"
        );
        assert!(
            !root.join("not made").exists(),
            "nothing was created on the way"
        );
        assert!(Projects::create_in(Path::new("relative"), "X").is_err());
        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn a_folder_made_before_the_gpx_opens_after_a_lossless_upgrade() {
        let root = scratch("open-folder");
        let folder = root.join("old");
        std::fs::create_dir_all(folder.join("scenes")).unwrap();
        std::fs::write(
            folder.join(PROJECT_SETTINGS_FILE),
            br#"{"workingColorSpace":"srgb"}"#,
        )
        .unwrap();
        let (projects, name) = Projects::open_folder(&folder).unwrap();
        assert_eq!(name, "old");
        assert_eq!(
            projects.settings("old").unwrap().working_color_space,
            WorkingColorSpace::Srgb
        );
        assert!(projects.gpx_path("old").is_file());
        assert!(!folder.join(PROJECT_SETTINGS_FILE).exists());
        assert!(Projects::open_folder(&root.join("nothing")).is_err());
        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn the_document_wins_over_a_stale_settings_file_and_a_bad_document_refuses() {
        let root = scratch("gpx-wins");
        let projects = Projects::at_root(&root);
        projects.create_project("show").unwrap();
        // A crash between writing the document and removing the old file leaves both.
        std::fs::write(
            root.join("show").join(PROJECT_SETTINGS_FILE),
            br#"{"workingColorSpace":"linearSrgb"}"#,
        )
        .unwrap();
        assert_eq!(
            projects.settings("show").unwrap().working_color_space,
            WorkingColorSpace::Srgb
        );
        assert!(projects.upgrade_project("show").unwrap());
        assert!(!root.join("show").join(PROJECT_SETTINGS_FILE).exists());

        let invalid = |bytes: &[u8]| {
            std::fs::write(projects.gpx_path("show"), bytes).unwrap();
            matches!(
                projects.settings("show"),
                Err(EditorError::Refused(Refusal::ProjectSettingsInvalid { .. }))
            )
        };
        assert!(invalid(
            br#"{"schemaVersion":2,"name":"show","settings":{"workingColorSpace":"srgb"}}"#
        ));
        assert!(
            invalid(
                br#"{"schemaVersion":1,"name":"other","settings":{"workingColorSpace":"srgb"}}"#
            ),
            "a document that names another project is refused"
        );
        assert!(invalid(
            br#"{"schemaVersion":1,"name":"show","settings":{"workingColorSpace":"srgb"},"hdr":true}"#
        ));
        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn every_provenance_field_survives_save_and_reload_byte_for_byte() {
        let provenance = AssetProvenance {
            origin: Some(AssetOrigin::Model),
            tool: Some(ProvenanceTool {
                name: "Generator".into(),
                version: Some("2.1".into()),
            }),
            provider: Some("Model vendor".into()),
            license_class: Some(LicenseClass::NonCommercial),
            prompt_hash: Some(gx_contracts::ContentHash("b".repeat(64))),
            sources: vec![
                "https://example.com/reference.png".into(),
                "asset_images_0123".into(),
            ],
            approval: Some(AssetApproval {
                user: "producer@example.com".into(),
                at: "2026-10-04T09:30:00Z".into(),
            }),
            c2pa_manifest: Some("assets/c2pa/backdrop.c2pa".into()),
        };
        let mut document = scene("generated");
        document.assets.push(AssetLibraryItem {
            asset_id: "backdrop".into(),
            name: "Backdrop".into(),
            kind: AssetKind::Image,
            path: "assets/images/backdrop.png".into(),
            checksum: Some(gx_contracts::ContentHash("c".repeat(64))),
            mime_type: Some("image/png".into()),
            size_bytes: Some(2048),
            status: None,
            provenance: provenance.clone(),
            color_space: None,
        });
        let root = scratch("provenance-round-trip");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();
        let path = root.join("news").join("scenes").join("generated.json");

        projects.write_scene("news", &document).unwrap();
        let saved = std::fs::read(&path).unwrap();
        let reread = projects.read_scene("news", "generated").unwrap();
        assert_eq!(reread.assets[0].provenance, provenance);
        projects.write_scene("news", &reread).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), saved);

        let written: serde_json::Value = serde_json::from_slice(&saved).unwrap();
        let record = &written["assets"][0]["provenance"];
        for field in [
            "origin",
            "tool",
            "provider",
            "licenseClass",
            "promptHash",
            "sources",
            "approval",
            "c2paManifest",
        ] {
            assert!(
                record.get(field).is_some(),
                "the saved record names {field}"
            );
        }

        std::fs::remove_dir_all(root).expect("clean up");
    }

    // --- project-owned assets ------------------------------------------------

    fn asset_item(name: &str, path: &str, bytes: &[u8]) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: format!("asset_{name}"),
            name: name.into(),
            kind: AssetKind::Image,
            path: path.into(),
            checksum: Some(gx_asset_plane::content_hash(bytes)),
            mime_type: Some("image/png".into()),
            size_bytes: Some(bytes.len() as u64),
            status: None,
            provenance: AssetProvenance::default(),
            color_space: None,
        }
    }

    #[test]
    fn an_adopted_asset_lives_in_the_project_and_reads_back_verified() {
        let root = scratch("project-assets");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();
        let bytes = b"not really a png".to_vec();
        let item = asset_item("Logo", "assets/images/abc.png", &bytes);
        let hash = item.checksum.clone().unwrap();

        assert!(!projects.has_asset("news", &hash).unwrap());
        assert_eq!(projects.read_asset("news", &hash).unwrap(), None);
        projects.adopt_asset("news", &item, &bytes).unwrap();

        // Named by hash with the library path's extension; the record sits beside it.
        let file = root
            .join("news")
            .join("Sources")
            .join(format!("{}.png", hash.0));
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
        assert!(projects.has_asset("news", &hash).unwrap());
        assert_eq!(
            projects.read_asset("news", &hash).unwrap(),
            Some(bytes.clone())
        );
        assert_eq!(projects.project_assets("news").unwrap(), vec![item.clone()]);

        // Adopting the same asset again is the same file, not a second copy.
        projects.adopt_asset("news", &item, &bytes).unwrap();
        assert_eq!(
            std::fs::read_dir(root.join("news").join("Sources"))
                .unwrap()
                .count(),
            2
        );

        // A file that no longer matches its name is refused, never served.
        std::fs::write(&file, b"tampered").unwrap();
        assert!(matches!(
            projects.read_asset("news", &hash),
            Err(EditorError::Refused(Refusal::AssetHashMismatch { .. }))
        ));
        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn project_assets_refuse_wrong_bytes_unknown_projects_and_path_like_hashes() {
        let root = scratch("project-assets-refusals");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();
        let item = asset_item("Logo", "assets/images/abc.png", b"right bytes");

        // Bytes that are not the asset's address are not filed under it.
        assert!(matches!(
            projects.adopt_asset("news", &item, b"other bytes"),
            Err(EditorError::Refused(Refusal::AssetHashMismatch { .. }))
        ));
        assert!(projects.project_assets("news").unwrap().is_empty());

        // A project that does not exist is refused, not created.
        assert!(matches!(
            projects.adopt_asset("nowhere", &item, b"right bytes"),
            Err(EditorError::Refused(Refusal::ProjectNotFound { .. }))
        ));
        assert!(!root.join("nowhere").exists());

        // An address that could name a path is refused before it touches one.
        let evil = gx_contracts::ContentHash("../../scenes/escape".into());
        assert!(matches!(
            projects.read_asset("news", &evil),
            Err(EditorError::Refused(Refusal::AssetMissing { .. }))
        ));
        let mut no_hash = item.clone();
        no_hash.checksum = None;
        assert!(matches!(
            projects.adopt_asset("news", &no_hash, b"right bytes"),
            Err(EditorError::Refused(Refusal::AssetMissing { .. }))
        ));

        // An odd extension falls back to the closed default.
        let mut odd = asset_item("Odd", "assets/images/x.not_an_extension", b"odd");
        projects.adopt_asset("news", &odd, b"odd").unwrap();
        let hash = odd.checksum.take().unwrap();
        assert!(root
            .join("news")
            .join("Sources")
            .join(format!("{}.bin", hash.0))
            .exists());
        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn a_library_record_that_does_not_parse_names_its_file() {
        let root = scratch("project-library-parse");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();
        let item = asset_item("Logo", "assets/images/abc.png", b"logo");
        projects.adopt_asset("news", &item, b"logo").unwrap();

        let assets = root.join("news").join("Sources");
        std::fs::write(assets.join("broken.json"), b"{ not json").unwrap();
        let error = projects.project_assets("news").unwrap_err();
        assert!(
            matches!(&error, EditorError::Parse { path, .. } if path == &assets.join("broken.json"))
        );
        assert!(error.to_string().contains("broken.json"), "{error}");

        let presets = root.join("news").join("motion-presets");
        std::fs::create_dir_all(&presets).unwrap();
        std::fs::write(presets.join("bad.json"), b"[]").unwrap();
        let error = projects.motion_presets("news").unwrap_err();
        assert!(error.to_string().contains("bad.json"), "{error}");
        std::fs::remove_dir_all(root).expect("clean up");
    }
}
