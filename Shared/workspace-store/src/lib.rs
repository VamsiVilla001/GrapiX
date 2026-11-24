//! The workspace store (build plan 2.29).
//!
//! Where the Editor's and Playout's saved panel arrangements live. A workspace is a JSON document the
//! page owns and checks (`Editor/src/dock-validate.ts` holds the rules about panels, weights and
//! secrets); this store keeps the files safely and checks only the *envelope* of each one. It does not
//! copy the page's rules, which would drift apart.
//!
//! Rules held here:
//! - **Two places.** Saved baselines roam with the person (`saved_root`). Session copies, last-known-good
//!   copies and the name of the workspace in use belong to this computer (`local_root`): they hold window
//!   positions and change constantly. One folder per application, so the Editor's choices never reach
//!   Playout's.
//! - **A write is atomic and keeps the copy it replaces.** The previous file is copied to `<file>.bak`,
//!   then the new one replaces it whole (`gx_fs::write_atomic`). A failed copy or write leaves the old
//!   file as it was.
//! - **The envelope is checked before anything is written.** A safe file name for the id, a size limit, a
//!   JSON object that carries a whole `schemaVersion` and a `workspaceId` equal to the id. A refusal names
//!   the reason (`Refusal::WorkspaceInvalid`) and writes nothing.
//! - **A newer file is never overwritten.** A file written by a newer build (a `schemaVersion` this build
//!   does not write) is returned as such and left untouched, and a write over it is refused
//!   (`Refusal::WorkspaceNewer`).
//! - **A file that does not read is set aside, never lost.** It is renamed to `<file>.corrupt-<ms>`, the
//!   backup is offered if it reads, and the caller falls back from there (last good, then shipped). The
//!   app never deletes a set-aside file.

use std::fmt;
use std::path::{Path, PathBuf};

use gx_contracts::Refusal;
use serde_json::Value;

/// The layout schema version this build writes and reads. The page's `WORKSPACE_SCHEMA_VERSION`
/// (`Editor/src/dock-model.ts`) is the same number; a test holds the two together.
pub const LAYOUT_SCHEMA_VERSION: u32 = 1;

/// The most one workspace file may hold. A real arrangement is a few kilobytes; this stops a runaway.
pub const MAX_WORKSPACE_BYTES: usize = 1 << 20;

/// The longest id.
const MAX_ID_LEN: usize = 64;

/// Which application a workspace is for. The two never share a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum App {
    Editor,
    Playout,
}

impl App {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Playout => "playout",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "editor" => Some(Self::Editor),
            "playout" => Some(Self::Playout),
            _ => None,
        }
    }
}

/// Which copy of a workspace a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The author's saved baseline. Roams.
    Saved,
    /// The arrangement as the author last left it, saved a moment after each change. This computer's.
    Session,
    /// The last arrangement that read and validated, kept to fall back to. This computer's.
    LastGood,
}

impl Kind {
    fn folder(self) -> &'static str {
        match self {
            Self::Saved => "saved",
            Self::Session => "session",
            Self::LastGood => "last-good",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "saved" => Some(Self::Saved),
            "session" => Some(Self::Session),
            "lastGood" => Some(Self::LastGood),
            _ => None,
        }
    }
}

/// Why a workspace store call failed.
#[derive(Debug)]
pub enum WorkspaceError {
    /// A named refusal: an id that is not safe, an envelope that is wrong, a newer file in the way.
    Refused(Refusal),
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Write(gx_fs::AtomicWriteError),
    Serialize(serde_json::Error),
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Write(source) => write!(f, "{source}"),
            Self::Serialize(source) => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for WorkspaceError {}

impl From<Refusal> for WorkspaceError {
    fn from(value: Refusal) -> Self {
        Self::Refused(value)
    }
}

fn invalid(id: &str, detail: impl Into<String>) -> WorkspaceError {
    Refusal::WorkspaceInvalid {
        id: id.to_owned(),
        detail: detail.into(),
    }
    .into()
}

fn newer(id: &str, found: u64, supported: u32) -> WorkspaceError {
    Refusal::WorkspaceNewer {
        id: id.to_owned(),
        // A version too large to count is still newer than this build.
        found: u32::try_from(found).unwrap_or(u32::MAX),
        supported,
    }
    .into()
}

/// What reading one workspace found.
#[derive(Debug, PartialEq)]
pub enum Read {
    /// There is no such file.
    Missing,
    /// The document, as stored.
    Found(Value),
    /// The file did not read. It was renamed to `aside`, and nothing was written in its place. `backup` is
    /// the copy the last write took, when that reads.
    SetAside {
        aside: PathBuf,
        backup: Option<Value>,
    },
    /// The file was written by a newer build. It is untouched.
    Newer { found: u64, supported: u32 },
}

/// Names Windows will not open as files, with or without an extension.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Whether `id` is a name a workspace file may have: lower-case letters, digits, `.`, `-` and `_`, starting
/// with a letter or a digit, at most 64 long, not ending in a dot (Windows drops it), and not a name
/// Windows reserves.
pub fn check_id(id: &str) -> Result<(), WorkspaceError> {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ID_LEN {
        return Err(invalid(
            id,
            format!("an id is 1 to {MAX_ID_LEN} characters"),
        ));
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return Err(invalid(
            id,
            "an id starts with a lower-case letter or a digit",
        ));
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err(invalid(
            id,
            "an id has only lower-case letters, digits, dots, hyphens and underscores",
        ));
    }
    if id.ends_with('.') {
        return Err(invalid(id, "an id does not end with a dot"));
    }
    let stem = id.split('.').next().unwrap_or(id);
    if RESERVED.contains(&stem) {
        return Err(invalid(id, "that name is reserved by Windows"));
    }
    Ok(())
}

/// The schema version a document carries, if it is an object with a whole one of 1 or more.
fn schema_of(value: &Value) -> Option<u64> {
    value
        .as_object()?
        .get("schemaVersion")?
        .as_u64()
        .filter(|version| *version >= 1)
}

/// What is at a workspace's place before a write.
enum Existing {
    None,
    Readable,
    Unreadable,
}

/// The two roots and what this build writes.
pub struct WorkspaceStore {
    saved_root: PathBuf,
    local_root: PathBuf,
    supported_schema: u32,
}

fn backup_of(file: &Path) -> PathBuf {
    let mut name = file
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".bak");
    file.with_file_name(name)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

impl WorkspaceStore {
    /// A store over two roots. Nothing is created until something is written.
    /// `supported_schema` is the layout schema version this build writes and reads.
    pub fn open(
        saved_root: impl Into<PathBuf>,
        local_root: impl Into<PathBuf>,
        supported_schema: u32,
    ) -> Self {
        Self {
            saved_root: saved_root.into(),
            local_root: local_root.into(),
            supported_schema,
        }
    }

    /// The store in its usual places: saved baselines in the user's roaming data folder, the rest in this
    /// computer's local one.
    pub fn open_default(supported_schema: u32) -> Result<Self, WorkspaceError> {
        let saved = gx_contracts::platform::service_data_root()?.join("workspaces");
        let local = gx_contracts::platform::machine_settings_root()?.join("workspaces");
        Ok(Self::open(saved, local, supported_schema))
    }

    fn folder(&self, app: App, kind: Kind) -> PathBuf {
        let root = match kind {
            Kind::Saved => &self.saved_root,
            Kind::Session | Kind::LastGood => &self.local_root,
        };
        root.join(app.as_str()).join(kind.folder())
    }

    fn file(&self, app: App, kind: Kind, id: &str) -> PathBuf {
        self.folder(app, kind).join(format!("{id}.json"))
    }

    fn io(path: &Path, source: std::io::Error) -> WorkspaceError {
        WorkspaceError::Io {
            path: path.to_path_buf(),
            source,
        }
    }

    /// Read one workspace. A file that does not read is set aside before anything else happens to it.
    pub fn get(&self, app: App, kind: Kind, id: &str) -> Result<Read, WorkspaceError> {
        check_id(id)?;
        let file = self.file(app, kind, id);
        let bytes = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Read::Missing),
            Err(source) => return Err(Self::io(&file, source)),
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => match schema_of(&value) {
                Some(found) if found > u64::from(self.supported_schema) => Ok(Read::Newer {
                    found,
                    supported: self.supported_schema,
                }),
                Some(_) => Ok(Read::Found(value)),
                None => self.set_aside(&file),
            },
            Err(_) => self.set_aside(&file),
        }
    }

    fn set_aside(&self, file: &Path) -> Result<Read, WorkspaceError> {
        let stamp = now_ms();
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut aside = file.with_file_name(format!("{name}.corrupt-{stamp}"));
        // Two files set aside in one millisecond must not replace each other.
        for n in 2.. {
            if !aside.exists() {
                break;
            }
            aside = file.with_file_name(format!("{name}.corrupt-{stamp}-{n}"));
        }
        std::fs::rename(file, &aside).map_err(|source| Self::io(file, source))?;
        tracing::warn!(event = "workspace.file_set_aside", file = %file.display(), kept = %aside.display());
        let backup = std::fs::read(backup_of(file))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|value| matches!(schema_of(value), Some(found) if found <= u64::from(self.supported_schema)));
        Ok(Read::SetAside { aside, backup })
    }

    /// Check a document before it is written: an object, a whole `schemaVersion` this build writes, a
    /// `workspaceId` equal to `id`, and not larger than the limit. Returns the bytes to write.
    fn envelope(&self, id: &str, value: &Value) -> Result<Vec<u8>, WorkspaceError> {
        let Some(object) = value.as_object() else {
            return Err(invalid(id, "a workspace is a JSON object"));
        };
        let Some(found) = schema_of(value) else {
            return Err(invalid(
                id,
                "a workspace carries a schemaVersion, a whole number of 1 or more",
            ));
        };
        if found > u64::from(self.supported_schema) {
            return Err(newer(id, found, self.supported_schema));
        }
        if object.get("workspaceId").and_then(Value::as_str) != Some(id) {
            return Err(invalid(
                id,
                "the workspaceId inside the document is not the id it is saved under",
            ));
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(WorkspaceError::Serialize)?;
        if bytes.len() > MAX_WORKSPACE_BYTES {
            return Err(invalid(
                id,
                format!("a workspace is at most {MAX_WORKSPACE_BYTES} bytes"),
            ));
        }
        Ok(bytes)
    }

    /// Write one workspace. Nothing is written when the id or the document is refused, or when a file
    /// written by a newer build is in the way.
    pub fn put(&self, app: App, kind: Kind, id: &str, value: &Value) -> Result<(), WorkspaceError> {
        check_id(id)?;
        let bytes = self.envelope(id, value)?;
        let file = self.file(app, kind, id);
        match self.existing(&file, id)? {
            Existing::None => {}
            // The copy the write replaces, taken before the file is.
            Existing::Readable => {
                std::fs::copy(&file, backup_of(&file)).map_err(|source| Self::io(&file, source))?;
            }
            // A file that does not read is set aside, never copied over the backup: the backup may be the
            // only good copy left.
            Existing::Unreadable => {
                self.set_aside(&file)?;
            }
        }
        if let Some(folder) = file.parent() {
            std::fs::create_dir_all(folder).map_err(|source| Self::io(folder, source))?;
        }
        gx_fs::write_atomic(&file, &bytes).map_err(WorkspaceError::Write)
    }

    /// What is at `file` now, refusing by name when it was written by a newer build.
    fn existing(&self, file: &Path, id: &str) -> Result<Existing, WorkspaceError> {
        let bytes = match std::fs::read(file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Existing::None)
            }
            Err(source) => return Err(Self::io(file, source)),
        };
        match serde_json::from_slice::<Value>(&bytes)
            .ok()
            .as_ref()
            .and_then(schema_of)
        {
            Some(found) if found > u64::from(self.supported_schema) => {
                Err(newer(id, found, self.supported_schema))
            }
            Some(_) => Ok(Existing::Readable),
            None => Ok(Existing::Unreadable),
        }
    }

    /// Remove one workspace and the copy beside it. A file that was set aside stays. Returns whether there
    /// was a file.
    pub fn delete(&self, app: App, kind: Kind, id: &str) -> Result<bool, WorkspaceError> {
        check_id(id)?;
        let file = self.file(app, kind, id);
        // A newer build's file is not this build's to remove.
        self.existing(&file, id)?;
        let existed = match std::fs::remove_file(&file) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(source) => return Err(Self::io(&file, source)),
        };
        match std::fs::remove_file(backup_of(&file)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(Self::io(&backup_of(&file), source)),
        }
        Ok(existed)
    }

    /// The ids of the workspaces of one kind, sorted. Backups and set-aside files are not listed.
    pub fn list(&self, app: App, kind: Kind) -> Result<Vec<String>, WorkspaceError> {
        let folder = self.folder(app, kind);
        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(Self::io(&folder, source)),
        };
        let mut ids: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let id = name.strip_suffix(".json")?;
                check_id(id).is_ok().then(|| id.to_owned())
            })
            .collect();
        ids.sort();
        Ok(ids)
    }

    // -----------------------------------------------------------------------------------------------
    // The two small indexes: which workspace is in use (this computer's) and in what order they are
    // listed (the person's, so it roams with the saved ones).
    // -----------------------------------------------------------------------------------------------

    fn active_file(&self, app: App) -> PathBuf {
        self.local_root.join(app.as_str()).join("active.json")
    }

    fn order_file(&self, app: App) -> PathBuf {
        self.saved_root.join(app.as_str()).join("order.json")
    }

    /// Read a small index document; an unreadable one is set aside and reads as absent.
    fn read_index(&self, file: &Path) -> Result<Option<Value>, WorkspaceError> {
        let bytes = match std::fs::read(file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(Self::io(file, source)),
        };
        match serde_json::from_slice::<Value>(&bytes).ok() {
            Some(value) => match schema_of(&value) {
                Some(found) if found <= u64::from(self.supported_schema) => Ok(Some(value)),
                // A newer build's index reads as absent here and is left exactly where it is.
                Some(_) => Ok(None),
                None => {
                    self.set_aside(file)?;
                    Ok(None)
                }
            },
            None => {
                self.set_aside(file)?;
                Ok(None)
            }
        }
    }

    fn write_index(&self, file: &Path, name: &str, value: &Value) -> Result<(), WorkspaceError> {
        if let Existing::Unreadable = self.existing(file, name)? {
            self.set_aside(file)?;
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(WorkspaceError::Serialize)?;
        if let Some(folder) = file.parent() {
            std::fs::create_dir_all(folder).map_err(|source| Self::io(folder, source))?;
        }
        gx_fs::write_atomic(file, &bytes).map_err(WorkspaceError::Write)
    }

    /// The id of the workspace in use for an application, if one was chosen.
    pub fn active(&self, app: App) -> Result<Option<String>, WorkspaceError> {
        Ok(self
            .read_index(&self.active_file(app))?
            .and_then(|value| {
                value
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|id| check_id(id).is_ok()))
    }

    /// Choose the workspace in use, or `None` for none.
    pub fn set_active(&self, app: App, id: Option<&str>) -> Result<(), WorkspaceError> {
        if let Some(id) = id {
            check_id(id)?;
        }
        let value = serde_json::json!({ "schemaVersion": 1, "workspaceId": id });
        self.write_index(&self.active_file(app), "active", &value)
    }

    /// The order the person put their workspaces in.
    pub fn order(&self, app: App) -> Result<Vec<String>, WorkspaceError> {
        Ok(self
            .read_index(&self.order_file(app))?
            .and_then(|value| {
                value.get("ids").and_then(Value::as_array).map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .filter(|id| check_id(id).is_ok())
                        .map(str::to_owned)
                        .collect()
                })
            })
            .unwrap_or_default())
    }

    /// Keep the order. Every id must be a safe one, and none may repeat.
    pub fn set_order(&self, app: App, ids: &[String]) -> Result<(), WorkspaceError> {
        let mut seen = std::collections::BTreeSet::new();
        for id in ids {
            check_id(id)?;
            if !seen.insert(id.as_str()) {
                return Err(invalid(id, "an id appears twice in the order"));
            }
        }
        let value = serde_json::json!({ "schemaVersion": 1, "ids": ids });
        self.write_index(&self.order_file(app), "order", &value)
    }
}

#[cfg(test)]
mod tests;
