//! The settings service (build plan 2.28).
//!
//! One typed store for what the Editor and Playout read as settings, in two files: **user**
//! settings (roaming: language, confirmations, what a new animation starts with) and **machine**
//! settings (local: GPU adapter, caches, ports). Project settings are not here; they stay in the
//! project's `.gpx`, because nothing a Preferences dialog changes may change what a graphic on air
//! renders as (see `gx_contracts::settings`).
//!
//! Rules held here:
//! - **A value is checked before it is kept.** An unknown key, a value of the wrong kind or one
//!   outside its range refuses by name (`Refusal::SettingInvalid`, with the key) and changes nothing.
//! - **A write is atomic and keeps the last good copy.** Every change replaces the file whole
//!   (`gx_fs::write_atomic`) after copying the previous file to `<file>.bak`.
//! - **A file that does not read is set aside, never silently lost.** It is renamed to
//!   `<file>.corrupt-<ms>`, the backup is used if it reads, else the defaults, and the load report
//!   says which. A file written by a *newer* schema is refused and left untouched.
//! - **Changes are announced.** A listener is told the scope, the key (none for a whole-scope
//!   reset) and a revision that rises on every change.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use gx_contracts::settings::{
    MachineSettings, SettingProblem, SettingsScope, UserSettings, SETTINGS_SCHEMA_VERSION,
};
use gx_contracts::Refusal;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Why a settings call failed.
#[derive(Debug)]
pub enum SettingsError {
    /// A named refusal: an unknown key, or a value that is not acceptable.
    Refused(Refusal),
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Write(gx_fs::AtomicWriteError),
    Serialize(serde_json::Error),
    /// The file was written by a newer build. It is left as it is.
    NewerSchema {
        path: PathBuf,
        found: u64,
        supported: u32,
    },
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Write(source) => write!(f, "{source}"),
            Self::Serialize(source) => write!(f, "{source}"),
            Self::NewerSchema {
                path,
                found,
                supported,
            } => write!(
                f,
                "{} was written by a newer GrapiX (settings schema {found}; this build reads {supported}); it is left as it is",
                path.display()
            ),
        }
    }
}

impl std::error::Error for SettingsError {}

impl From<Refusal> for SettingsError {
    fn from(value: Refusal) -> Self {
        Self::Refused(value)
    }
}

fn invalid(problem: SettingProblem) -> SettingsError {
    Refusal::SettingInvalid {
        key: problem.key,
        detail: problem.detail,
    }
    .into()
}

/// One scope's settings type: how to check it and which scope it is.
trait Scoped: Serialize + DeserializeOwned + Default + Clone + PartialEq {
    const SCOPE: SettingsScope;
    fn check(&self) -> Result<(), SettingProblem>;
}

impl Scoped for UserSettings {
    const SCOPE: SettingsScope = SettingsScope::User;
    fn check(&self) -> Result<(), SettingProblem> {
        self.validate()
    }
}

impl Scoped for MachineSettings {
    const SCOPE: SettingsScope = SettingsScope::Machine;
    fn check(&self) -> Result<(), SettingProblem> {
        self.validate()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document<T> {
    schema_version: u32,
    settings: T,
}

/// A change that was made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsChange {
    pub scope: SettingsScope,
    /// The setting that changed, or `None` when a whole scope was reset.
    pub key: Option<String>,
    pub revision: u64,
}

/// What opening the store had to do about files that did not read.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LoadReport {
    /// Scopes whose file did not read and whose last good copy was used instead.
    pub recovered_from_backup: Vec<SettingsScope>,
    /// Scopes whose file did not read and had no good copy: defaults are in use.
    pub reset_to_defaults: Vec<SettingsScope>,
    /// Where each unreadable file was set aside.
    pub set_aside: Vec<PathBuf>,
}

type Listener = Arc<dyn Fn(&SettingsChange) + Send + Sync>;

struct Inner {
    user: UserSettings,
    machine: MachineSettings,
    revision: u64,
}

/// The two settings files and what they hold.
pub struct SettingsStore {
    user_file: PathBuf,
    machine_file: PathBuf,
    inner: Mutex<Inner>,
    listeners: Mutex<Vec<Listener>>,
}

fn backup_of(file: &Path) -> PathBuf {
    let mut name = file
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".bak");
    file.with_file_name(name)
}

fn read_document<T: Scoped>(path: &Path) -> Result<Option<T>, SettingsError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(SettingsError::Io {
                path: path.to_path_buf(),
                source,
            })
        }
    };
    // The version is read first, so a newer file is refused as such and not as whichever field
    // happened to change shape.
    let raw: Value = match serde_json::from_slice(&bytes) {
        Ok(raw) => raw,
        Err(_) => return Err(unreadable(path)),
    };
    if let Some(found) = raw.get("schemaVersion").and_then(Value::as_u64) {
        if found > u64::from(SETTINGS_SCHEMA_VERSION) {
            return Err(SettingsError::NewerSchema {
                path: path.to_path_buf(),
                found,
                supported: SETTINGS_SCHEMA_VERSION,
            });
        }
    }
    let document: Document<T> = serde_json::from_value(raw).map_err(|_| unreadable(path))?;
    if document.schema_version != SETTINGS_SCHEMA_VERSION || document.settings.check().is_err() {
        return Err(unreadable(path));
    }
    Ok(Some(document.settings))
}

/// A marker for "this file does not read": the caller sets it aside.
fn unreadable(path: &Path) -> SettingsError {
    SettingsError::Io {
        path: path.to_path_buf(),
        source: std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the settings file does not read",
        ),
    }
}

fn is_unreadable(error: &SettingsError) -> bool {
    matches!(error, SettingsError::Io { source, .. } if source.kind() == std::io::ErrorKind::InvalidData)
}

/// Load one scope: the file, else its backup, else the defaults. An unreadable file is renamed
/// aside before anything else is written over it.
fn load<T: Scoped>(file: &Path, stamp: u64, report: &mut LoadReport) -> Result<T, SettingsError> {
    match read_document::<T>(file) {
        Ok(Some(settings)) => return Ok(settings),
        Ok(None) => return Ok(T::default()),
        Err(error) if !is_unreadable(&error) => return Err(error),
        Err(_) => {}
    }
    let mut aside_name = file
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    aside_name.push(format!(".corrupt-{stamp}"));
    let aside = file.with_file_name(aside_name);
    std::fs::rename(file, &aside).map_err(|source| SettingsError::Io {
        path: file.to_path_buf(),
        source,
    })?;
    tracing::warn!(event = "settings.file_set_aside", file = %file.display(), kept = %aside.display());
    report.set_aside.push(aside);
    match read_document::<T>(&backup_of(file)) {
        Ok(Some(settings)) => {
            report.recovered_from_backup.push(T::SCOPE);
            Ok(settings)
        }
        _ => {
            report.reset_to_defaults.push(T::SCOPE);
            Ok(T::default())
        }
    }
}

fn save<T: Scoped>(file: &Path, settings: &T) -> Result<(), SettingsError> {
    settings.check().map_err(invalid)?;
    let bytes = serde_json::to_vec_pretty(&Document {
        schema_version: SETTINGS_SCHEMA_VERSION,
        settings,
    })
    .map_err(SettingsError::Serialize)?;
    // The last good copy, taken before the file is replaced.
    if file.is_file() {
        std::fs::copy(file, backup_of(file)).map_err(|source| SettingsError::Io {
            path: file.to_path_buf(),
            source,
        })?;
    }
    gx_fs::write_atomic(file, &bytes).map_err(SettingsError::Write)
}

/// Replace one top-level setting of `current` with `value`, refusing an unknown key, a value of the
/// wrong kind and a value out of range.
fn with_key<T: Scoped>(current: &T, key: &str, value: Value) -> Result<T, SettingsError> {
    let mut object = serde_json::to_value(current).map_err(SettingsError::Serialize)?;
    let map = object
        .as_object_mut()
        .expect("a settings struct is a JSON object");
    if !map.contains_key(key) {
        return Err(invalid(SettingProblem {
            key: key.to_owned(),
            detail: "is not a setting".to_owned(),
        }));
    }
    map.insert(key.to_owned(), value);
    let next: T = serde_json::from_value(object).map_err(|error| {
        invalid(SettingProblem {
            key: key.to_owned(),
            detail: format!("is the wrong kind of value: {error}"),
        })
    })?;
    next.check().map_err(invalid)?;
    Ok(next)
}

impl SettingsStore {
    /// Open the two files, creating their folders. `stamp` names a file set aside.
    pub fn open(
        user_file: impl Into<PathBuf>,
        machine_file: impl Into<PathBuf>,
    ) -> Result<(Self, LoadReport), SettingsError> {
        let (user_file, machine_file) = (user_file.into(), machine_file.into());
        for file in [&user_file, &machine_file] {
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).map_err(|source| SettingsError::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let mut report = LoadReport::default();
        let user = load::<UserSettings>(&user_file, stamp, &mut report)?;
        let machine = load::<MachineSettings>(&machine_file, stamp, &mut report)?;
        Ok((
            Self {
                user_file,
                machine_file,
                inner: Mutex::new(Inner {
                    user,
                    machine,
                    revision: 0,
                }),
                listeners: Mutex::new(Vec::new()),
            },
            report,
        ))
    }

    /// Open at the platform's own folders: user settings under the roaming data root, machine
    /// settings under the local one.
    pub fn open_default() -> Result<(Self, LoadReport), SettingsError> {
        let user = gx_contracts::platform::service_data_root()?.join("settings");
        let machine = gx_contracts::platform::machine_settings_root()?.join("settings");
        Self::open(
            user.join("user-settings.json"),
            machine.join("machine-settings.json"),
        )
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn user(&self) -> UserSettings {
        self.lock().user.clone()
    }

    pub fn machine(&self) -> MachineSettings {
        self.lock().machine.clone()
    }

    /// Rises by one on every change.
    pub fn revision(&self) -> u64 {
        self.lock().revision
    }

    /// Be told of every change, after it is durable. Called on the thread that made it.
    pub fn subscribe(&self, listener: impl Fn(&SettingsChange) + Send + Sync + 'static) {
        self.listeners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(Arc::new(listener));
    }

    fn announce(&self, scope: SettingsScope, key: Option<String>, revision: u64) {
        let change = SettingsChange {
            scope,
            key,
            revision,
        };
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        for listener in listeners {
            listener(&change);
        }
    }

    /// Set one setting by its JSON key. Returns whether anything changed (the same value again is
    /// not a change and is not announced).
    pub fn set(
        &self,
        scope: SettingsScope,
        key: &str,
        value: Value,
    ) -> Result<bool, SettingsError> {
        let revision = {
            let mut inner = self.lock();
            let next_revision = inner.revision + 1;
            match scope {
                SettingsScope::User => {
                    let next = with_key(&inner.user, key, value)?;
                    if next == inner.user {
                        return Ok(false);
                    }
                    save(&self.user_file, &next)?;
                    inner.user = next;
                }
                SettingsScope::Machine => {
                    let next = with_key(&inner.machine, key, value)?;
                    if next == inner.machine {
                        return Ok(false);
                    }
                    save(&self.machine_file, &next)?;
                    inner.machine = next;
                }
            }
            inner.revision = next_revision;
            next_revision
        };
        self.announce(scope, Some(key.to_owned()), revision);
        Ok(true)
    }

    /// Put one setting, or with `None` every setting of the scope, back to its default. Returns
    /// whether anything changed.
    pub fn reset(&self, scope: SettingsScope, key: Option<&str>) -> Result<bool, SettingsError> {
        if let Some(key) = key {
            let default = match scope {
                SettingsScope::User => serde_json::to_value(UserSettings::default()),
                SettingsScope::Machine => serde_json::to_value(MachineSettings::default()),
            }
            .map_err(SettingsError::Serialize)?;
            let value = default.get(key).cloned().ok_or_else(|| {
                invalid(SettingProblem {
                    key: key.to_owned(),
                    detail: "is not a setting".to_owned(),
                })
            })?;
            return self.set(scope, key, value);
        }
        let revision = {
            let mut inner = self.lock();
            let changed = match scope {
                SettingsScope::User => {
                    let defaults = UserSettings::default();
                    if defaults == inner.user {
                        false
                    } else {
                        save(&self.user_file, &defaults)?;
                        inner.user = defaults;
                        true
                    }
                }
                SettingsScope::Machine => {
                    let defaults = MachineSettings::default();
                    if defaults == inner.machine {
                        false
                    } else {
                        save(&self.machine_file, &defaults)?;
                        inner.machine = defaults;
                        true
                    }
                }
            };
            if !changed {
                return Ok(false);
            }
            inner.revision += 1;
            inner.revision
        };
        self.announce(scope, None, revision);
        Ok(true)
    }
}

#[cfg(test)]
mod tests;
