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

use gx_contracts::scene::{parse_scene_document, SceneDocument};
use gx_contracts::Refusal;

/// What the Editor service can fail at.
#[derive(Debug)]
pub enum EditorError {
    /// A named refusal from the contract vocabulary.
    Refused(Refusal),
    /// The filesystem did not cooperate. Distinct from a refusal: nothing was
    /// decided, the operation simply could not be carried out.
    Io { path: PathBuf, source: std::io::Error },
    /// A durable write did not complete.
    Write(gx_fs::AtomicWriteError),
    /// A document could not be serialised.
    Serialize(serde_json::Error),
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
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

    fn scene_path(&self, project: &str, scene_id: &str) -> PathBuf {
        self.scenes_directory(project).join(format!("{scene_id}.json"))
    }

    /// Whether a project exists. The question every write asks first.
    pub fn exists(&self, project: &str) -> bool {
        self.project_directory(project).is_dir()
    }

    /// Bring a project into being. The only thing that does.
    pub fn create_project(&self, project: &str) -> Result<(), EditorError> {
        let scenes = self.scenes_directory(project);
        std::fs::create_dir_all(&scenes).map_err(|source| EditorError::Io {
            path: scenes,
            source,
        })
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
    fn require_project(&self, project: &str) -> Result<(), EditorError> {
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
        let path = self.scene_path(project, scene_id);
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io { path, source })?;
        parse_scene_document(&bytes).map_err(EditorError::Refused)
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
        let path = self.scene_path(project, scene_id);
        std::fs::remove_file(&path).map_err(|source| EditorError::Io { path, source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::scene::{SceneCanvas, SceneTimeline};
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
            id: id.into(),
            name: id.into(),
            version: 1,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline { duration_frames: 1 },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
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

        projects.create_project("news").expect("a project is created");
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
}
