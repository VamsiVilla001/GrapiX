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

use gx_contracts::color::WorkingColorSpace;
use gx_contracts::control::TakePage;
use gx_contracts::design_system::MotionPreset;
use gx_contracts::project::{ProjectSettings, PROJECT_SETTINGS_FILE};
use gx_contracts::scene::{parse_scene_document, AssetLibraryItem, SceneDocument};
use gx_contracts::ContentHash;
use gx_contracts::Refusal;

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

    fn settings_path(&self, project: &str) -> PathBuf {
        self.project_directory(project).join(PROJECT_SETTINGS_FILE)
    }

    fn take_pages_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join("take-pages")
    }

    fn take_page_path(&self, project: &str, page_id: &str) -> PathBuf {
        self.take_pages_directory(project)
            .join(format!("{page_id}.json"))
    }

    fn assets_directory(&self, project: &str) -> PathBuf {
        self.project_directory(project).join("assets")
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
        let scenes = self.scenes_directory(project);
        std::fs::create_dir_all(&scenes).map_err(|source| EditorError::Io {
            path: scenes,
            source,
        })?;
        let bytes = serde_json::to_vec_pretty(&settings).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&self.settings_path(project), &bytes).map_err(EditorError::Write)
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
        let path = self.settings_path(project);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                Refusal::ProjectSettingsInvalid {
                    project: project.to_owned(),
                    detail: error.to_string(),
                }
                .into()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(ProjectSettings::before_3_15())
            }
            Err(source) => Err(EditorError::Io { path, source }),
        }
    }

    /// A scene composites in its project's space or not at all (3.15).
    fn require_working_space(
        &self,
        project: &str,
        scene: &SceneDocument,
    ) -> Result<(), EditorError> {
        let declared: WorkingColorSpace = self.settings(project)?.working_color_space;
        if scene.working_color_space == declared {
            Ok(())
        } else {
            Err(Refusal::SceneWorkingSpaceMismatch {
                project: project.to_owned(),
                scene_id: scene.id.clone(),
                scene: scene.working_color_space,
                project_space: declared,
            }
            .into())
        }
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
        Ok(directory_paths(&self.assets_directory(project))?
            .into_iter()
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix) && !name.ends_with(".json"))
            }))
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
        std::fs::remove_file(root.join("legacy").join(PROJECT_SETTINGS_FILE)).unwrap();
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
        newer["version"] = serde_json::json!(4);
        std::fs::write(&path, serde_json::to_vec(&newer).unwrap()).unwrap();
        assert!(matches!(
            projects.read_scene("legacy", "witness"),
            Err(EditorError::Refused(Refusal::SceneSchemaUnsupported {
                actual: 4,
                supported: 3
            }))
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
        std::fs::remove_file(root.join("legacy").join(PROJECT_SETTINGS_FILE)).unwrap();
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
        let file = std::fs::read(root.join("show").join(PROJECT_SETTINGS_FILE)).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&file).unwrap(),
            serde_json::json!({ "workingColorSpace": "srgb" })
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

        std::fs::write(
            root.join("show").join(PROJECT_SETTINGS_FILE),
            br#"{"workingColorSpace":"hdr"}"#,
        )
        .unwrap();
        assert!(matches!(
            projects.settings("show"),
            Err(EditorError::Refused(Refusal::ProjectSettingsInvalid { .. }))
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
            .join("assets")
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
            std::fs::read_dir(root.join("news").join("assets"))
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
            .join("assets")
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

        let assets = root.join("news").join("assets");
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
