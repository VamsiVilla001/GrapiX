//! Durable recovery journal for the render worker (build-plan step 3.12).
//!
//! A process may die between two control-plane messages, but it must never
//! forget which state it had made durable and then resume output by guesswork.
//! This module records the complete recoverable engine state through
//! [`gx_fs::write_atomic`]: after a kill the file is either the previous
//! complete state or the next complete state, never a plausible truncation.
//! A caller must treat every load or write error as a named failure; selecting
//! an empty state after a malformed journal would be an unrecovered output.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use gx_contracts::platform::service_data_root;
use gx_contracts::scene::SceneDocument;
use gx_contracts::{ContentHash, Epoch, Refusal, Revision, TakeId};
use gx_control_plane::status::ProgramState;
use serde::{Deserialize, Serialize};

/// The only journal schema this worker understands. Version 3 carries scene
/// schema 2 documents (11.39): the pinned hashes in a version 2 journal were
/// taken over scene schema 1, so its prepared scenes would no longer match
/// them, and it is refused by version rather than by hash.
pub const RECOVERY_SCHEMA_VERSION: u32 = 3;

/// The journal's standard location beneath the operating-system service root.
pub const RECOVERY_JOURNAL_RELATIVE_PATH: &str = "render-engine/recovery.json";

/// One prepared authored scene that can be rebuilt after a worker restart.
///
/// The prepared form deliberately stays out of the journal: it is derived from
/// the document, verified assets and current renderer capability. Persisting
/// that derivative would allow a stale preparation to bypass those checks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedSceneRecord {
    pub take_id: TakeId,
    pub revision: Revision,
    pub document: SceneDocument,
}

/// The state that survives a worker process. `epoch` is the incarnation that
/// wrote it; a restored engine advances it before accepting control traffic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryState {
    pub schema_version: u32,
    pub epoch: Epoch,
    /// Each published take's revision and the content hash it pins (schema 2,
    /// 11.38). A schema-1 journal carries no hashes and is refused by name.
    pub published: BTreeMap<TakeId, gx_control_plane::intent::HeldRevision>,
    pub prepared_scenes: Vec<PreparedSceneRecord>,
    pub verified_assets: BTreeSet<ContentHash>,
    pub cued: Option<ProgramState>,
    pub program: Option<ProgramState>,
}

impl RecoveryState {
    /// A new worker's durable state, before it accepts its first mutation.
    pub fn empty(epoch: Epoch) -> Self {
        Self {
            schema_version: RECOVERY_SCHEMA_VERSION,
            epoch,
            published: BTreeMap::new(),
            prepared_scenes: Vec::new(),
            verified_assets: BTreeSet::new(),
            cued: None,
            program: None,
        }
    }

    /// Reject contradictory records rather than recovering a subset of one.
    pub fn validate(&self) -> Result<(), RecoveryError> {
        if self.schema_version != RECOVERY_SCHEMA_VERSION {
            return Err(RecoveryError::UnsupportedSchema {
                found: self.schema_version,
                supported: RECOVERY_SCHEMA_VERSION,
            });
        }

        let mut seen = BTreeSet::new();
        for scene in &self.prepared_scenes {
            let key = (scene.take_id.clone(), scene.revision);
            if !seen.insert(key.clone()) {
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene {}/{} is recorded more than once",
                        key.0, key.1 .0
                    ),
                });
            }
            if scene.document.id != scene.take_id.0 {
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene document id {} disagrees with take id {}",
                        scene.document.id, scene.take_id
                    ),
                });
            }
            if self.published.get(&scene.take_id).map(|held| held.revision) != Some(scene.revision) {
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene {}/{} is not the published revision",
                        scene.take_id, scene.revision.0
                    ),
                });
            }
            // The bytes behind a pinned hash must still be those bytes: a
            // journal that disagrees would let a pin load different content.
            let pinned = self.published.get(&scene.take_id).map(|held| &held.content_hash);
            if pinned != Some(&scene.document.content_hash()) {
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene {}/{} does not hash to its published pin",
                        scene.take_id, scene.revision.0
                    ),
                });
            }
        }

        for (name, state) in [("cued", &self.cued), ("program", &self.program)] {
            if let Some(state) = state {
                if self.published.get(&state.take_id).map(|held| held.revision) != Some(state.revision) {
                    return Err(RecoveryError::InvalidState {
                        detail: format!(
                            "{name} state {}/{} is not a published revision",
                            state.take_id, state.revision.0
                        ),
                    });
                }
            }
        }
        Ok(())
    }

    /// The next engine incarnation. An exhausted counter is a hard recovery
    /// failure, never a reused (therefore stale) epoch.
    pub fn next_epoch(&self) -> Result<Epoch, RecoveryError> {
        self.epoch
            .0
            .checked_add(1)
            .map(Epoch)
            .ok_or(RecoveryError::EpochExhausted)
    }
}

/// Named errors from persistence and validation. These are intentionally not
/// `io::Error`: callers must distinguish a missing journal (a normal first
/// start) from a corrupt or unwritable journal (a safe startup failure).
#[derive(Debug)]
pub enum RecoveryError {
    DataRoot(Refusal),
    CreateDirectory {
        path: PathBuf,
        source: io::Error,
    },
    Read {
        path: PathBuf,
        source: io::Error,
    },
    Encode {
        source: serde_json::Error,
    },
    Decode {
        path: PathBuf,
        source: serde_json::Error,
    },
    Write {
        path: PathBuf,
        source: gx_fs::AtomicWriteError,
    },
    UnsupportedSchema {
        found: u32,
        supported: u32,
    },
    InvalidState {
        detail: String,
    },
    EpochExhausted,
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DataRoot(refusal) => write!(f, "cannot locate service data root: {refusal}"),
            Self::CreateDirectory { path, source } => {
                write!(
                    f,
                    "cannot create recovery directory {}: {source}",
                    path.display()
                )
            }
            Self::Read { path, source } => {
                write!(
                    f,
                    "cannot read recovery journal {}: {source}",
                    path.display()
                )
            }
            Self::Encode { source } => write!(f, "cannot encode recovery journal: {source}"),
            Self::Decode { path, source } => {
                write!(
                    f,
                    "cannot decode recovery journal {}: {source}",
                    path.display()
                )
            }
            Self::Write { path, source } => {
                write!(
                    f,
                    "cannot write recovery journal {}: {source}",
                    path.display()
                )
            }
            Self::UnsupportedSchema { found, supported } => write!(
                f,
                "recovery journal schema {found} is unsupported (this worker supports {supported})"
            ),
            Self::InvalidState { detail } => write!(f, "invalid recovery journal state: {detail}"),
            Self::EpochExhausted => f.write_str("recovery journal epoch is exhausted"),
        }
    }
}

impl Error for RecoveryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::DataRoot(refusal) => Some(refusal),
            Self::CreateDirectory { source, .. } | Self::Read { source, .. } => Some(source),
            Self::Encode { source } | Self::Decode { source, .. } => Some(source),
            Self::Write { source, .. } => Some(source),
            Self::UnsupportedSchema { .. } | Self::InvalidState { .. } | Self::EpochExhausted => {
                None
            }
        }
    }
}

/// A single durable journal file. The production constructor is deliberately
/// rooted at the platform service directory so a launched worker never writes
/// recovery state into the repository or its current working directory.
#[derive(Debug, Clone)]
pub struct RecoveryJournal {
    path: PathBuf,
}

impl RecoveryJournal {
    /// Open the journal at the platform-owned service data root.
    pub fn open() -> Result<Self, RecoveryError> {
        let root = service_data_root().map_err(RecoveryError::DataRoot)?;
        Self::open_at(root.join(RECOVERY_JOURNAL_RELATIVE_PATH))
    }

    /// Open a journal at an already-authorised location. The host uses this
    /// only for a path it derived below `service_data_root`; tests use a unique
    /// child of that same root so process-death coverage never writes a repo
    /// fixture.
    pub fn open_at(path: PathBuf) -> Result<Self, RecoveryError> {
        let parent = path.parent().ok_or_else(|| RecoveryError::InvalidState {
            detail: format!("journal path {} has no parent directory", path.display()),
        })?;
        fs::create_dir_all(parent).map_err(|source| RecoveryError::CreateDirectory {
            path: parent.to_path_buf(),
            source,
        })?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read and validate a complete journal. Absence is only normal before the
    /// first engine start; malformed bytes are a recovery error, never an empty
    /// engine selected as a fallback.
    pub fn load(&self) -> Result<Option<RecoveryState>, RecoveryError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(RecoveryError::Read {
                    path: self.path.clone(),
                    source,
                })
            }
        };
        let decode = |source| RecoveryError::Decode {
            path: self.path.clone(),
            source,
        };
        // The schema version is read before the body, so a journal from
        // another schema is refused by that name rather than as whichever
        // field happened to change shape first.
        let raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(decode)?;
        if let Some(found) = raw.get("schemaVersion").and_then(serde_json::Value::as_u64) {
            if found != u64::from(RECOVERY_SCHEMA_VERSION) {
                return Err(RecoveryError::UnsupportedSchema {
                    found: u32::try_from(found).unwrap_or(u32::MAX),
                    supported: RECOVERY_SCHEMA_VERSION,
                });
            }
        }
        let state: RecoveryState = serde_json::from_value(raw).map_err(decode)?;
        state.validate()?;
        Ok(Some(state))
    }

    /// Atomically replace the last durable state. Validation happens before
    /// serialization so an impossible in-memory state is never made durable.
    pub fn record(&self, state: &RecoveryState) -> Result<(), RecoveryError> {
        state.validate()?;
        let bytes = serde_json::to_vec(state).map_err(|source| RecoveryError::Encode { source })?;
        gx_fs::write_atomic(&self.path, &bytes).map_err(|source| RecoveryError::Write {
            path: self.path.clone(),
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn journal() -> RecoveryJournal {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = service_data_root()
            .unwrap()
            .join(format!("render-engine-test-{nonce}"));
        RecoveryJournal::open_at(root.join("recovery.json")).unwrap()
    }

    #[test]
    fn a_complete_recovery_state_round_trips_through_the_atomic_journal() {
        let journal = journal();
        let state = RecoveryState::empty(Epoch(7));
        journal.record(&state).unwrap();
        assert_eq!(journal.load().unwrap(), Some(state));
        // Best effort: the round trip above is the test. On Windows another
        // process can hold a just-written folder under the user data root for
        // longer than the test runs (a sharing violation).
        let _ = fs::remove_dir_all(journal.path().parent().unwrap());
    }

    #[test]
    fn a_contradictory_program_state_refuses_recovery() {
        let mut state = RecoveryState::empty(Epoch(1));
        state.program = Some(ProgramState {
            take_id: TakeId("not-published".into()),
            revision: Revision(1),
            committed_frame: 10,
            scene_frame: 0,
            playing: true,
            phase: None,
            stop_frame: None,
        });
        assert!(matches!(
            state.validate(),
            Err(RecoveryError::InvalidState { .. })
        ));
    }

    #[test]
    fn an_exhausted_epoch_never_reuses_a_stale_incarnation() {
        assert!(matches!(
            RecoveryState::empty(Epoch(u64::MAX)).next_epoch(),
            Err(RecoveryError::EpochExhausted)
        ));
    }
}
