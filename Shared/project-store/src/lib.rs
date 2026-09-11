//! Durable project documents, backups and bounded autosaves (build plan 2.6).
//!
//! A project document is the authoring authority. Replacing it with a direct
//! write would create a truncation window where a crash turns a valid project
//! into an empty one. This crate takes a named backup before replacement and
//! delegates every durable file write to `gx_fs::write_atomic_with`, so the
//! on-disk document is always either the complete old version or the complete
//! new version. Autosaves use the same write path and evict their oldest entry
//! after the configured bound is exceeded.

#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use gx_contracts::platform::{sanitize_filename, service_data_root, FileName};
use gx_contracts::Refusal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The only project document schema this store understands.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// The default number of autosaves retained per project.
pub const DEFAULT_AUTOSAVE_LIMIT: NonZeroUsize = match NonZeroUsize::new(10) {
    Some(limit) => limit,
    None => unreachable!(),
};

/// A project name after the single boundary sanitisation required for a path
/// component. Equality follows the cross-platform case policy through
/// [`FileName`], while [`ProjectKey::display`] retains the author-facing form.
#[derive(Debug, Clone)]
pub struct ProjectKey {
    name: FileName,
}

impl ProjectKey {
    /// Sanitise user-supplied project text once as it becomes a path component.
    pub fn from_user_input(name: impl AsRef<str>) -> Self {
        Self {
            name: FileName::new(sanitize_filename(name.as_ref())),
        }
    }

    /// The sanitised project component used on disk and displayed to callers.
    pub fn display(&self) -> &str {
        self.name.display()
    }
}

impl PartialEq for ProjectKey {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

impl Eq for ProjectKey {}

/// JSON persisted for one project. `contents` is deliberately a JSON value:
/// scene and catalogue schemas evolve independently of the store, while this
/// envelope is what proves a file belongs to the requested project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocument {
    pub schema_version: u32,
    pub id: String,
    #[serde(default)]
    pub contents: Value,
}

impl ProjectDocument {
    /// Start a current-schema document whose persisted id agrees with `project`.
    pub fn new(project: &ProjectKey, contents: Value) -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: project.display().to_owned(),
            contents,
        }
    }
}

/// A timestamped, complete project snapshot available for an explicit restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backup {
    path: PathBuf,
}

impl Backup {
    /// The timestamped backup filename, for presenting a recovery choice.
    pub fn file_name(&self) -> Option<&std::ffi::OsStr> {
        self.path.file_name()
    }
}

/// The result of an explicitly chosen backup restore. Loading never returns
/// this implicitly: callers must surface that they are no longer on the
/// current document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryReport {
    pub recovered_from: Backup,
}

/// Failures from durable project storage. Contract failures are kept as
/// `Refusal` so callers can present their named condition; filesystem and JSON
/// serialisation failures carry their operation and path rather than becoming
/// a generic save error.
#[derive(Debug)]
pub enum ProjectStoreError {
    Refusal(Refusal),
    CreateDirectory {
        path: PathBuf,
        source: io::Error,
    },
    Inspect {
        path: PathBuf,
        source: io::Error,
    },
    Read {
        path: PathBuf,
        source: io::Error,
    },
    ReadDirectory {
        path: PathBuf,
        source: io::Error,
    },
    ReadDirectoryEntry {
        path: PathBuf,
        source: io::Error,
    },
    RemoveAutosave {
        path: PathBuf,
        source: io::Error,
    },
    Serialize {
        project: String,
        source: serde_json::Error,
    },
    AtomicWrite {
        path: PathBuf,
        source: gx_fs::AtomicWriteError,
    },
}

impl fmt::Display for ProjectStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refusal(refusal) => refusal.fmt(f),
            Self::CreateDirectory { path, source } => {
                write!(
                    f,
                    "could not create project directory {}: {source}",
                    path.display()
                )
            }
            Self::Inspect { path, source } => {
                write!(
                    f,
                    "could not inspect project path {}: {source}",
                    path.display()
                )
            }
            Self::Read { path, source } => {
                write!(
                    f,
                    "could not read project file {}: {source}",
                    path.display()
                )
            }
            Self::ReadDirectory { path, source } => {
                write!(
                    f,
                    "could not list project directory {}: {source}",
                    path.display()
                )
            }
            Self::ReadDirectoryEntry { path, source } => {
                write!(f, "could not read entry in {}: {source}", path.display())
            }
            Self::RemoveAutosave { path, source } => {
                write!(f, "could not evict autosave {}: {source}", path.display())
            }
            Self::Serialize { project, source } => {
                write!(f, "could not serialise project {project}: {source}")
            }
            Self::AtomicWrite { path, source } => {
                write!(f, "could not atomically write {}: {source}", path.display())
            }
        }
    }
}

impl Error for ProjectStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Refusal(refusal) => Some(refusal),
            Self::CreateDirectory { source, .. }
            | Self::Inspect { source, .. }
            | Self::Read { source, .. }
            | Self::ReadDirectory { source, .. }
            | Self::ReadDirectoryEntry { source, .. }
            | Self::RemoveAutosave { source, .. } => Some(source),
            Self::Serialize { source, .. } => Some(source),
            Self::AtomicWrite { source, .. } => Some(source),
        }
    }
}

impl From<Refusal> for ProjectStoreError {
    fn from(refusal: Refusal) -> Self {
        Self::Refusal(refusal)
    }
}

/// The on-disk owner of project JSON beneath the operating system service-data
/// root. It intentionally has no constructor for arbitrary repositories: a
/// project store writes only under [`service_data_root`].
#[derive(Debug, Clone)]
pub struct ProjectStore {
    root: PathBuf,
    autosave_limit: NonZeroUsize,
}

impl ProjectStore {
    /// Open the project store at the platform's per-user service-data root.
    pub fn open() -> Result<Self, ProjectStoreError> {
        Self::open_with_autosave_limit(DEFAULT_AUTOSAVE_LIMIT)
    }

    /// Open the store with an explicit per-project autosave retention bound.
    pub fn open_with_autosave_limit(
        autosave_limit: NonZeroUsize,
    ) -> Result<Self, ProjectStoreError> {
        let root = service_data_root()?;
        let projects = root.join("projects");
        fs::create_dir_all(&projects).map_err(|source| ProjectStoreError::CreateDirectory {
            path: projects,
            source,
        })?;
        Ok(Self {
            root,
            autosave_limit,
        })
    }

    /// Convert user-entered project text to its one canonical path component.
    pub fn project_key(&self, name: impl AsRef<str>) -> ProjectKey {
        ProjectKey::from_user_input(name)
    }

    /// Load the current document. Corrupt JSON, an unknown schema and a
    /// location/id disagreement are named refusals; no backup is selected here.
    pub fn load(&self, project: &ProjectKey) -> Result<ProjectDocument, ProjectStoreError> {
        self.read_document(&self.document_path(project), project)
    }

    /// Save the current document. If a current document exists, its complete
    /// bytes are copied into a timestamped backup before atomic replacement.
    pub fn save(
        &self,
        project: &ProjectKey,
        document: &ProjectDocument,
    ) -> Result<(), ProjectStoreError> {
        self.validate_document(project, document)?;
        self.create_project_directories(project)?;
        let destination = self.document_path(project);
        match fs::metadata(&destination) {
            Ok(_) => self.back_up_current(project, &destination)?,
            Err(source) if source.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(ProjectStoreError::Inspect {
                    path: destination,
                    source,
                });
            }
        }
        self.write_document(&destination, document)
    }

    /// Write a bounded autosave without replacing the current document.
    pub fn autosave(
        &self,
        project: &ProjectKey,
        document: &ProjectDocument,
    ) -> Result<(), ProjectStoreError> {
        self.validate_document(project, document)?;
        self.create_project_directories(project)?;
        let autosave = self.autosave_directory(project);
        let path = autosave.join(timestamped_name("autosave"));
        self.write_document(&path, document)?;
        self.evict_old_autosaves(project)
    }

    /// Enumerate timestamped backups in oldest-to-newest filename order so an
    /// operator can deliberately select the snapshot to recover.
    pub fn backups(&self, project: &ProjectKey) -> Result<Vec<Backup>, ProjectStoreError> {
        let directory = self.backups_directory(project);
        let mut backups = self.json_files(&directory)?;
        backups.sort();
        Ok(backups.into_iter().map(|path| Backup { path }).collect())
    }

    /// Read and validate one backup without changing the current project.
    pub fn load_backup(
        &self,
        project: &ProjectKey,
        backup: &Backup,
    ) -> Result<ProjectDocument, ProjectStoreError> {
        self.ensure_backup_belongs_to(project, backup)?;
        self.read_document(&backup.path, project)
    }

    /// Replace the current document with a specifically selected valid backup.
    /// The replacement goes through [`ProjectStore::save`], therefore preserves
    /// the current file as a fresh backup first.
    pub fn recover_backup(
        &self,
        project: &ProjectKey,
        backup: &Backup,
    ) -> Result<RecoveryReport, ProjectStoreError> {
        let document = self.load_backup(project, backup)?;
        self.save(project, &document)?;
        Ok(RecoveryReport {
            recovered_from: backup.clone(),
        })
    }

    /// Return the currently retained autosaves in oldest-to-newest order.
    pub fn autosaves(&self, project: &ProjectKey) -> Result<Vec<PathBuf>, ProjectStoreError> {
        let mut autosaves = self.json_files(&self.autosave_directory(project))?;
        autosaves.sort();
        Ok(autosaves)
    }

    fn project_directory(&self, project: &ProjectKey) -> PathBuf {
        self.root.join("projects").join(project.display())
    }

    fn document_path(&self, project: &ProjectKey) -> PathBuf {
        self.project_directory(project).join("project.json")
    }

    fn backups_directory(&self, project: &ProjectKey) -> PathBuf {
        self.project_directory(project).join("backups")
    }

    fn autosave_directory(&self, project: &ProjectKey) -> PathBuf {
        self.project_directory(project).join("autosaves")
    }

    fn create_project_directories(&self, project: &ProjectKey) -> Result<(), ProjectStoreError> {
        for directory in [
            self.project_directory(project),
            self.backups_directory(project),
            self.autosave_directory(project),
        ] {
            fs::create_dir_all(&directory).map_err(|source| {
                ProjectStoreError::CreateDirectory {
                    path: directory,
                    source,
                }
            })?;
        }
        Ok(())
    }

    fn back_up_current(
        &self,
        project: &ProjectKey,
        source: &Path,
    ) -> Result<(), ProjectStoreError> {
        let destination = self
            .backups_directory(project)
            .join(timestamped_name("backup"));
        gx_fs::write_atomic_with(&destination, |destination_file| {
            let mut source_file = fs::File::open(source)?;
            io::copy(&mut source_file, destination_file).map(|_| ())
        })
        .map_err(|source| ProjectStoreError::AtomicWrite {
            path: destination,
            source,
        })
    }

    fn write_document(
        &self,
        path: &Path,
        document: &ProjectDocument,
    ) -> Result<(), ProjectStoreError> {
        gx_fs::write_atomic_with(path, |file| {
            serde_json::to_writer_pretty(&mut *file, document)
                .map_err(io::Error::other)
                .and_then(|()| file.write_all(b"\n"))
        })
        .map_err(|source| ProjectStoreError::AtomicWrite {
            path: path.to_path_buf(),
            source,
        })
    }

    fn read_document(
        &self,
        path: &Path,
        project: &ProjectKey,
    ) -> Result<ProjectDocument, ProjectStoreError> {
        let bytes = fs::read(path).map_err(|source| ProjectStoreError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        let document = serde_json::from_slice(&bytes).map_err(|source| {
            ProjectStoreError::Refusal(Refusal::ProjectJsonCorrupt {
                project: project.display().to_owned(),
                detail: source.to_string(),
            })
        })?;
        self.validate_document(project, &document)?;
        Ok(document)
    }

    fn validate_document(
        &self,
        project: &ProjectKey,
        document: &ProjectDocument,
    ) -> Result<(), ProjectStoreError> {
        if document.schema_version != CURRENT_SCHEMA_VERSION {
            return Err(Refusal::UnknownProjectSchema {
                project: project.display().to_owned(),
                actual: document.schema_version,
                supported: CURRENT_SCHEMA_VERSION,
            }
            .into());
        }
        if FileName::new(document.id.clone()) != project.name {
            return Err(Refusal::ProjectIdLocationMismatch {
                project_id: document.id.clone(),
                location: project.display().to_owned(),
            }
            .into());
        }
        Ok(())
    }

    fn json_files(&self, directory: &Path) -> Result<Vec<PathBuf>, ProjectStoreError> {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(ProjectStoreError::ReadDirectory {
                    path: directory.to_path_buf(),
                    source,
                });
            }
        };
        entries
            .map(|entry| {
                entry
                    .map_err(|source| ProjectStoreError::ReadDirectoryEntry {
                        path: directory.to_path_buf(),
                        source,
                    })
                    .map(|entry| entry.path())
            })
            .filter_map(|result| match result {
                Ok(path)
                    if path
                        .extension()
                        .is_some_and(|extension| extension == "json") =>
                {
                    Some(Ok(path))
                }
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect()
    }

    fn evict_old_autosaves(&self, project: &ProjectKey) -> Result<(), ProjectStoreError> {
        let autosaves = self.autosaves(project)?;
        let excess = autosaves.len().saturating_sub(self.autosave_limit.get());
        for path in autosaves.into_iter().take(excess) {
            fs::remove_file(&path)
                .map_err(|source| ProjectStoreError::RemoveAutosave { path, source })?;
        }
        Ok(())
    }

    fn ensure_backup_belongs_to(
        &self,
        project: &ProjectKey,
        backup: &Backup,
    ) -> Result<(), ProjectStoreError> {
        if backup.path.parent() != Some(self.backups_directory(project).as_path()) {
            return Err(Refusal::ProjectIdLocationMismatch {
                project_id: backup.path.display().to_string(),
                location: project.display().to_owned(),
            }
            .into());
        }
        Ok(())
    }
}

fn timestamped_name(prefix: &str) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{timestamp:032}-{sequence:020}.json")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::num::NonZeroUsize;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    struct TestProject {
        store: ProjectStore,
        key: ProjectKey,
    }

    impl TestProject {
        fn new(label: &str) -> Self {
            let store = ProjectStore::open().unwrap();
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let key = store.project_key(format!("test-{label}-{}-{nonce}", std::process::id()));
            Self { store, key }
        }

        fn document(&self, version: u64) -> ProjectDocument {
            ProjectDocument::new(&self.key, serde_json::json!({ "version": version }))
        }
    }

    impl Drop for TestProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.store.project_directory(&self.key));
        }
    }

    #[test]
    fn replacement_backs_up_the_complete_previous_document() {
        let project = TestProject::new("backup");
        project
            .store
            .save(&project.key, &project.document(1))
            .unwrap();
        project
            .store
            .save(&project.key, &project.document(2))
            .unwrap();

        let backups = project.store.backups(&project.key).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            project
                .store
                .load_backup(&project.key, &backups[0])
                .unwrap()
                .contents["version"],
            1
        );
        assert_eq!(
            project.store.load(&project.key).unwrap().contents["version"],
            2
        );
    }

    #[test]
    fn autosave_ring_evicts_the_oldest_entry_at_its_bound() {
        let store = ProjectStore::open_with_autosave_limit(NonZeroUsize::new(3).unwrap()).unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let key = store.project_key(format!("test-autosave-{}-{nonce}", std::process::id()));
        for version in 1..=5 {
            store
                .autosave(
                    &key,
                    &ProjectDocument::new(&key, serde_json::json!({ "version": version })),
                )
                .unwrap();
        }

        let autosaves = store.autosaves(&key).unwrap();
        assert_eq!(autosaves.len(), 3);
        let versions: Vec<_> = autosaves
            .iter()
            .map(|path| {
                store.read_document(path, &key).unwrap().contents["version"]
                    .as_u64()
                    .unwrap()
            })
            .collect();
        assert_eq!(versions, vec![3, 4, 5]);
        fs::remove_dir_all(store.project_directory(&key)).unwrap();
    }

    #[test]
    fn loading_names_corruption_unknown_schema_and_location_disagreement() {
        let project = TestProject::new("refusal");
        project
            .store
            .create_project_directories(&project.key)
            .unwrap();
        let path = project.store.document_path(&project.key);
        gx_fs::write_atomic_with(&path, |file| file.write_all(b"not json")).unwrap();
        assert!(matches!(
            project.store.load(&project.key),
            Err(ProjectStoreError::Refusal(
                Refusal::ProjectJsonCorrupt { .. }
            ))
        ));

        gx_fs::write_atomic_with(&path, |file| {
            file.write_all(br#"{"schemaVersion": 99, "id": "test", "contents": {}}"#)
        })
        .unwrap();
        assert!(matches!(
            project.store.load(&project.key),
            Err(ProjectStoreError::Refusal(Refusal::UnknownProjectSchema {
                actual: 99,
                ..
            }))
        ));

        gx_fs::write_atomic_with(&path, |file| {
            file.write_all(br#"{"schemaVersion": 1, "id": "somewhere-else", "contents": {}}"#)
        })
        .unwrap();
        assert!(matches!(
            project.store.load(&project.key),
            Err(ProjectStoreError::Refusal(
                Refusal::ProjectIdLocationMismatch { .. }
            ))
        ));
    }

    #[test]
    fn successful_writes_leave_no_atomic_temporary_file() {
        let project = TestProject::new("temporary");
        project
            .store
            .save(&project.key, &project.document(1))
            .unwrap();
        project
            .store
            .autosave(&project.key, &project.document(2))
            .unwrap();
        let paths = fs::read_dir(project.store.project_directory(&project.key))
            .unwrap()
            .flat_map(|entry| {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    fs::read_dir(path)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .collect::<Vec<_>>()
                } else {
                    vec![path]
                }
            })
            .collect::<Vec<_>>();
        assert!(paths.iter().all(|path| {
            !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".gxtmp"))
        }));
    }
}
