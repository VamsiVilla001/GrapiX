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
///
/// 5.11 keeps version 3. The asset bytes live in a store beside the journal,
/// not in it, and the one new field (`revisionFloors`) is optional, so a
/// version-3 journal written before 5.11 still restores: its scenes with
/// assets have no stored bytes and are dropped by name instead of keeping
/// the engine down.
pub const RECOVERY_SCHEMA_VERSION: u32 = 3;

/// Appended to the journal's file name to name the engine's own asset store
/// beside it (5.11): `recovery.json` keeps its bytes in `recovery.json.assets`.
pub const ASSET_STORE_SUFFIX: &str = ".assets";

/// Appended to the journal's file name to name the report of the scenes the
/// last restore that dropped any dropped (5.11).
pub const DROP_REPORT_SUFFIX: &str = ".dropped.json";

/// The only drop report schema this worker writes.
pub const DROP_REPORT_SCHEMA_VERSION: u32 = 1;

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
    /// Hashes whose verified bytes are in the store beside the journal: those
    /// accepted since start and those read back at restore (5.11). Restore
    /// does not trust this list; it reads back every journaled scene's
    /// declared assets.
    pub verified_assets: BTreeSet<ContentHash>,
    pub cued: Option<ProgramState>,
    pub program: Option<ProgramState>,
    /// The revision each dropped take last had (5.11), so publishing it again
    /// continues from there and a revision number is never reused for other
    /// content (invariant 61). A take has a floor only while it is not
    /// published.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub revision_floors: BTreeMap<TakeId, Revision>,
}

/// A journaled scene a restore dropped because its asset bytes were missing,
/// altered or unreadable in the engine's store (5.11). The engine starts
/// without it; Cue, Take and Render of the take are refused with `reason`
/// until it is published again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DroppedScene {
    pub take_id: TakeId,
    pub revision: Revision,
    pub content_hash: ContentHash,
    pub reason: Refusal,
    pub was_program: bool,
    pub was_cued: bool,
}

impl fmt::Display for DroppedScene {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}/{} (pin {}): {}: {}",
            self.take_id,
            self.revision.0,
            self.content_hash,
            self.reason.code_name(),
            self.reason
        )?;
        if self.was_program {
            f.write_str("; it was on Program, now clear")?;
        }
        if self.was_cued {
            f.write_str("; it was cued, now clear")?;
        }
        Ok(())
    }
}

/// Every scene one restore dropped, written beside the journal before the
/// journal that no longer lists them replaces the one that did (5.11). The
/// engine host does not keep a worker's stderr, so this file is where an
/// operator finds what to re-publish. It holds the latest restore that
/// dropped anything.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DropReport {
    pub schema_version: u32,
    /// The incarnation that dropped them.
    pub epoch: Epoch,
    pub dropped: Vec<DroppedScene>,
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
            revision_floors: BTreeMap::new(),
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
            if self.published.get(&scene.take_id).map(|held| held.revision) != Some(scene.revision)
            {
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene {}/{} is not the published revision",
                        scene.take_id, scene.revision.0
                    ),
                });
            }
            // The bytes behind a pinned hash must still be those bytes: a
            // journal that disagrees would let a pin load different content.
            let pinned = self
                .published
                .get(&scene.take_id)
                .map(|held| &held.content_hash);
            if pinned != Some(&scene.document.content_hash()) {
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene {}/{} does not hash to its published pin",
                        scene.take_id, scene.revision.0
                    ),
                });
            }
        }

        if let Some(take_id) = self
            .revision_floors
            .keys()
            .find(|take_id| self.published.contains_key(*take_id))
        {
            return Err(RecoveryError::InvalidState {
                detail: format!(
                    "take {take_id} is published and also has a dropped revision floor"
                ),
            });
        }

        for (name, state) in [("cued", &self.cued), ("program", &self.program)] {
            if let Some(state) = state {
                if self.published.get(&state.take_id).map(|held| held.revision)
                    != Some(state.revision)
                {
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
        if path.file_name().is_none() {
            return Err(RecoveryError::InvalidState {
                detail: format!("journal path {} names no file", path.display()),
            });
        }
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

    /// The engine's own content-addressed asset store beside this journal
    /// (5.11). Named after the journal's file, so two journals in one
    /// directory never share a store, and never equal to the journal itself.
    pub fn asset_store_directory(&self) -> PathBuf {
        self.sibling(ASSET_STORE_SUFFIX)
    }

    /// The report of the scenes the last restore that dropped any dropped.
    pub fn drop_report_path(&self) -> PathBuf {
        self.sibling(DROP_REPORT_SUFFIX)
    }

    fn sibling(&self, suffix: &str) -> PathBuf {
        let mut name = self
            .path
            .file_name()
            .expect("open_at refuses a journal path that names no file")
            .to_os_string();
        name.push(suffix);
        self.path.with_file_name(name)
    }

    /// Atomically write the scenes a restore dropped (5.11).
    pub fn record_drops(&self, report: &DropReport) -> Result<PathBuf, RecoveryError> {
        let path = self.drop_report_path();
        let bytes =
            serde_json::to_vec_pretty(report).map_err(|source| RecoveryError::Encode { source })?;
        gx_fs::write_atomic(&path, &bytes).map_err(|source| RecoveryError::Write {
            path: path.clone(),
            source,
        })?;
        Ok(path)
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

    #[test]
    fn the_store_and_the_drop_report_are_named_after_their_journal_file() {
        let root = std::env::temp_dir().join(format!(
            "gx-recovery-names-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let journal = RecoveryJournal::open_at(root.join("recovery.json")).expect("journal");
        assert_eq!(
            journal.asset_store_directory(),
            root.join("recovery.json.assets")
        );
        assert_eq!(
            journal.drop_report_path(),
            root.join("recovery.json.dropped.json")
        );
        // Two journals in one directory get distinct stores; a journal named
        // like a store never shares its own name.
        let other = RecoveryJournal::open_at(root.join("other.json")).expect("journal");
        assert_ne!(
            other.asset_store_directory(),
            journal.asset_store_directory()
        );
        let odd = RecoveryJournal::open_at(root.join("x.assets")).expect("journal");
        assert_eq!(odd.asset_store_directory(), root.join("x.assets.assets"));
        assert_ne!(odd.asset_store_directory(), odd.path());
        assert!(matches!(
            RecoveryJournal::open_at(PathBuf::from(r"C:\")),
            Err(RecoveryError::InvalidState { .. })
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_take_cannot_be_published_and_carry_a_dropped_floor() {
        let mut state = RecoveryState::empty(Epoch(4));
        state.published.insert(
            TakeId("t".into()),
            gx_control_plane::intent::HeldRevision {
                revision: Revision(2),
                content_hash: ContentHash("0".repeat(64)),
            },
        );
        state
            .revision_floors
            .insert(TakeId("t".into()), Revision(1));
        assert!(matches!(
            state.validate(),
            Err(RecoveryError::InvalidState { .. })
        ));
        // A journal without the field still reads, as a version-3 journal
        // written before 5.11 does.
        let mut plain = serde_json::to_value(RecoveryState::empty(Epoch(4))).unwrap();
        assert!(plain.get("revisionFloors").is_none());
        plain.as_object_mut().unwrap().remove("revisionFloors");
        let read: RecoveryState = serde_json::from_value(plain).unwrap();
        assert!(read.revision_floors.is_empty());
    }
}
