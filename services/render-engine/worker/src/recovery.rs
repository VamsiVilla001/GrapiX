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
use gx_contracts::scene::{SceneDocument, SCENE_SCHEMA_VERSION};
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
/// The journal holds one for each take's latest published revision and one
/// for every earlier revision Program or the cue still names (5.12): a take
/// published again while an earlier revision is on air keeps that revision
/// recoverable, because publication is additive (invariant 30).
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
    /// Cues outside layer zero. Older journals omit this field.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub layer_cues: BTreeMap<i32, ProgramState>,
    pub program: Option<ProgramState>,
    /// Scenes on air outside layer zero (task 112). Older journals omit this field.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub layer_programs: BTreeMap<i32, ProgramState>,
    /// A scene waiting on each layer for the one leaving it to finish its Out (task 112). A restart must not turn a replacement
    /// into a cut, so it is journaled with the frame it starts at. Older journals omit this field.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub replacements: BTreeMap<i32, Replacement>,
    /// The revision each dropped take last had (5.11), so publishing it again
    /// continues from there and a revision number is never reused for other
    /// content (invariant 61). A take has a floor only while it is not
    /// published.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub revision_floors: BTreeMap<TakeId, Revision>,
}

/// A scene queued onto a layer: it takes the layer when the engine clock reaches `start_frame`, the frame the scene on it finishes
/// leaving (its authored Out). `state` is how it will be on air from then (its committed frame is `start_frame`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replacement {
    pub state: ProgramState,
    pub start_frame: u64,
}

/// A journaled scene a restore dropped because its asset bytes were missing,
/// altered or unreadable in the engine's store (5.11). The engine starts
/// without it; Cue, Take and Render of the take are refused with `reason`
/// until it is published again or the engine restarts (the reason lives in
/// memory and in `<journal>.dropped.json`; the journal keeps the take's
/// revision floor).
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
            layer_cues: BTreeMap::new(),
            program: None,
            layer_programs: BTreeMap::new(),
            replacements: BTreeMap::new(),
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
            // A scene written under another scene schema is refused by that name, before its
            // hash is compared: its pin was taken over the other schema's JSON form, so a hash
            // mismatch would only say that something changed, not what or what to do. Holding
            // this to the document's own version means a future scene schema change is refused
            // the same way without anyone remembering to bump the journal's version.
            if scene.document.version != SCENE_SCHEMA_VERSION {
                return Err(RecoveryError::SceneSchemaMismatch {
                    take_id: scene.take_id.to_string(),
                    revision: scene.revision.0,
                    found: scene.document.version,
                    supported: SCENE_SCHEMA_VERSION,
                });
            }
            let Some(held) = self.published.get(&scene.take_id) else {
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene {}/{} is of a take that is not published",
                        scene.take_id, scene.revision.0
                    ),
                });
            };
            if scene.revision == held.revision {
                // The bytes behind a pinned hash must still be those bytes: a
                // journal that disagrees would let a pin load different
                // content.
                if held.content_hash != scene.document.content_hash() {
                    return Err(RecoveryError::InvalidState {
                        detail: format!(
                            "prepared scene {}/{} does not hash to its published pin",
                            scene.take_id, scene.revision.0
                        ),
                    });
                }
            } else if scene.revision > held.revision || !self.names(&scene.take_id, scene.revision)
            {
                // An earlier revision is kept only while Program or the cue
                // names it (5.12); anything else is not the published
                // revision and has no business in the journal.
                return Err(RecoveryError::InvalidState {
                    detail: format!(
                        "prepared scene {}/{} is not the published revision, and neither Program nor the cue names it",
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

        use gx_control_plane::message::{MAIN_LAYER, MAX_PROGRAM_LAYER, MIN_PROGRAM_LAYER};
        let in_range = |layer: i32| (MIN_PROGRAM_LAYER..=MAX_PROGRAM_LAYER).contains(&layer);
        for &layer in self.layer_cues.keys() {
            if layer == MAIN_LAYER || !in_range(layer) {
                return Err(RecoveryError::InvalidState {
                    detail: format!("invalid layer cue target {layer}"),
                });
            }
        }
        for &layer in self.layer_programs.keys() {
            if layer == MAIN_LAYER || !in_range(layer) {
                return Err(RecoveryError::InvalidState {
                    detail: format!("invalid on-air layer {layer}"),
                });
            }
        }
        // A replacement waits on a layer that has a scene leaving it; one with nothing on air under it was never made.
        for &layer in self.replacements.keys() {
            let occupied = if layer == MAIN_LAYER { self.program.is_some() } else { self.layer_programs.contains_key(&layer) };
            if !in_range(layer) || !occupied {
                return Err(RecoveryError::InvalidState {
                    detail: format!("a replacement is queued on layer {layer}, which has no scene on air to leave it"),
                });
            }
        }
        let states = [("cued", &self.cued), ("program", &self.program)]
            .into_iter()
            .filter_map(|(name, state)| state.as_ref().map(|state| (name, state)))
            .chain(self.layer_cues.values().map(|state| ("layer cue", state)))
            .chain(self.layer_programs.values().map(|state| ("layer program", state)))
            .chain(self.replacements.values().map(|queued| ("queued replacement", &queued.state)));
        for (name, state) in states {
            let latest = self.published.get(&state.take_id).map(|held| held.revision);
            match latest {
                Some(latest) if state.revision == latest => {}
                // An earlier revision of a published take, which the
                // journal must be able to rebuild (5.12).
                Some(latest)
                    if state.revision < latest
                        && self.prepared_scenes.iter().any(|scene| {
                            scene.take_id == state.take_id && scene.revision == state.revision
                        }) => {}
                _ => {
                    return Err(RecoveryError::InvalidState {
                        detail: format!(
                            "{name} state {}/{} is not a published revision the journal holds",
                            state.take_id, state.revision.0
                        ),
                    });
                }
            }
        }
        Ok(())
    }

    /// Whether a scene on any layer, a cue or a queued replacement names this revision of this take.
    pub fn names(&self, take_id: &TakeId, revision: Revision) -> bool {
        [&self.program, &self.cued]
            .into_iter()
            .flatten()
            .chain(self.layer_cues.values())
            .chain(self.layer_programs.values())
            .chain(self.replacements.values().map(|queued| &queued.state))
            .any(|state| state.take_id == *take_id && state.revision == revision)
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
    /// A prepared scene was written under another scene schema, so its pinned hash cannot be
    /// checked. The journal is not restored and not touched: the operator chooses to discard it.
    SceneSchemaMismatch {
        take_id: String,
        revision: u64,
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
            Self::SceneSchemaMismatch {
                take_id,
                revision,
                found,
                supported,
            } => write!(
                f,
                "the recovery journal holds scene {take_id}/{revision} written under scene schema {found}, and this engine reads scene schema {supported}, so it cannot be restored. Nothing was changed. To start without it, run the engine with --discard-recovery: the journal is moved aside to a dated .bak file and the engine starts empty."
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
            Self::UnsupportedSchema { .. }
            | Self::SceneSchemaMismatch { .. }
            | Self::InvalidState { .. }
            | Self::EpochExhausted => None,
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

    /// Move the journal, its asset store and its drop report aside to `<name>.discarded-<stamp>.bak`
    /// (the operator chose `--discard-recovery`), so the engine starts empty. Nothing is deleted: the
    /// bytes are kept beside where they were. Returns the journal's new path, or `None` when there
    /// was no journal. Run before the journal is read.
    pub fn discard_aside(&self, stamp: u64) -> Result<Option<PathBuf>, RecoveryError> {
        let aside = |from: PathBuf| -> Result<Option<PathBuf>, RecoveryError> {
            if !from.exists() {
                return Ok(None);
            }
            let mut name = from
                .file_name()
                .expect("a journal sibling names a file")
                .to_os_string();
            name.push(format!(".discarded-{stamp}.bak"));
            let to = from.with_file_name(name);
            fs::rename(&from, &to).map_err(|source| RecoveryError::Read { path: from, source })?;
            Ok(Some(to))
        };
        let moved = aside(self.path.clone())?;
        aside(self.asset_store_directory())?;
        aside(self.drop_report_path())?;
        Ok(moved)
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

    // --- Program layers and queued replacements (task 112) ---------------------------------------------------------------------

    fn on_air(take: &str, from: u64) -> ProgramState {
        ProgramState {
            take_id: TakeId(take.into()),
            revision: Revision(1),
            committed_frame: from,
            scene_frame: 0,
            playing: true,
            phase: None,
            stop_frame: None,
        }
    }

    fn publishing(take: &str, state: &mut RecoveryState) {
        state.published.insert(
            TakeId(take.into()),
            gx_control_plane::intent::HeldRevision { revision: Revision(1), content_hash: ContentHash("0".repeat(64)) },
        );
    }

    #[test]
    fn scenes_on_layers_and_queued_replacements_are_kept_and_named_by_the_journal_rule() {
        let mut state = RecoveryState::empty(Epoch(3));
        for take in ["a", "b", "c"] {
            publishing(take, &mut state);
        }
        state.program = Some(on_air("a", 10));
        state.layer_programs.insert(60, on_air("b", 12));
        state.replacements.insert(60, Replacement { state: on_air("c", 40), start_frame: 40 });
        state.replacements.insert(0, Replacement { state: on_air("c", 50), start_frame: 50 });
        state.validate().expect("layers, and a replacement behind each occupied layer, are consistent");
        for take in ["a", "b", "c"] {
            assert!(state.names(&TakeId(take.into()), Revision(1)), "{take} is named by a layer or a queued replacement");
        }
        // It reads back as it was written.
        let read: RecoveryState = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        assert_eq!(read, state);
    }

    #[test]
    fn a_layer_replacement_or_scene_that_cannot_exist_refuses_recovery_by_name() {
        let base = || {
            let mut state = RecoveryState::empty(Epoch(3));
            for take in ["a", "b"] {
                publishing(take, &mut state);
            }
            state
        };
        // Layer zero is `program`, never a map entry; and a layer outside the range is not a layer.
        for layer in [0, 100_000, -100_000] {
            let mut state = base();
            state.layer_programs.insert(layer, on_air("a", 1));
            assert!(matches!(state.validate(), Err(RecoveryError::InvalidState { .. })), "layer {layer}");
        }
        // A replacement waits for a scene to leave: with nothing on the layer there was nothing to leave.
        let mut orphan = base();
        orphan.replacements.insert(60, Replacement { state: on_air("b", 9), start_frame: 9 });
        assert!(matches!(orphan.validate(), Err(RecoveryError::InvalidState { .. })));
        let mut empty_zero = base();
        empty_zero.replacements.insert(0, Replacement { state: on_air("b", 9), start_frame: 9 });
        assert!(matches!(empty_zero.validate(), Err(RecoveryError::InvalidState { .. })));
        // A scene on a layer that is not published has no business in the journal.
        let mut unpublished = base();
        unpublished.layer_programs.insert(60, on_air("ghost", 1));
        assert!(matches!(unpublished.validate(), Err(RecoveryError::InvalidState { .. })));
        let mut queued_ghost = base();
        queued_ghost.layer_programs.insert(60, on_air("a", 1));
        queued_ghost.replacements.insert(60, Replacement { state: on_air("ghost", 9), start_frame: 9 });
        assert!(matches!(queued_ghost.validate(), Err(RecoveryError::InvalidState { .. })));
    }

    #[test]
    fn a_journal_written_before_layers_still_reads_with_none() {
        let mut plain = serde_json::to_value(RecoveryState::empty(Epoch(4))).unwrap();
        assert!(plain.get("layerPrograms").is_none() && plain.get("replacements").is_none());
        let read: RecoveryState = serde_json::from_value(plain.take()).unwrap();
        assert!(read.layer_programs.is_empty() && read.replacements.is_empty());
    }

    fn state_with_a_scene_of_version(version: u32) -> RecoveryState {
        let mut document = gx_contracts::scene::new_scene(
            "t",
            "t",
            gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
        );
        document.version = version;
        let mut state = RecoveryState::empty(Epoch(1));
        // The pin is the document's own hash, so the hash check can never be what refuses it.
        state.published.insert(
            TakeId("t".into()),
            gx_control_plane::intent::HeldRevision {
                revision: Revision(1),
                content_hash: document.content_hash(),
            },
        );
        state.prepared_scenes.push(PreparedSceneRecord {
            take_id: TakeId("t".into()),
            revision: Revision(1),
            document,
        });
        state
    }

    /// 11.43: the journal an operator already had (scene schema 3) stopped the engine with "does not
    /// hash to its published pin" after scene schema 4. It is now refused by what changed, and says
    /// what to do; the same state at the current schema restores, so only the schema refuses it.
    #[test]
    fn a_scene_of_another_scene_schema_is_refused_by_name_and_says_what_to_do() {
        state_with_a_scene_of_version(SCENE_SCHEMA_VERSION)
            .validate()
            .expect("the same state at the current scene schema is valid");
        for other in [SCENE_SCHEMA_VERSION - 1, SCENE_SCHEMA_VERSION + 1] {
            let error = state_with_a_scene_of_version(other)
                .validate()
                .expect_err("a scene of another schema is refused");
            assert!(
                matches!(
                    error,
                    RecoveryError::SceneSchemaMismatch { found, supported, .. }
                        if found == other && supported == SCENE_SCHEMA_VERSION
                ),
                "{error}"
            );
            let message = error.to_string();
            assert!(message.contains("--discard-recovery"), "{message}");
            assert!(message.contains("Nothing was changed"), "{message}");
            assert!(!message.contains("does not hash"), "{message}");
        }
    }

    /// `--discard-recovery` keeps every byte: it moves, never deletes.
    #[test]
    fn discard_aside_moves_the_journal_its_store_and_its_report_and_deletes_nothing() {
        let journal = journal();
        let root = journal.path().parent().unwrap().to_path_buf();
        assert_eq!(
            journal.discard_aside(1).unwrap(),
            None,
            "no journal, nothing to move"
        );
        journal.record(&RecoveryState::empty(Epoch(7))).unwrap();
        fs::create_dir_all(journal.asset_store_directory()).unwrap();
        fs::write(journal.asset_store_directory().join("a"), b"asset").unwrap();
        fs::write(journal.drop_report_path(), b"report").unwrap();

        let kept = journal
            .discard_aside(42)
            .unwrap()
            .expect("the journal moved");
        assert_eq!(kept, root.join("recovery.json.discarded-42.bak"));
        assert!(
            !journal.path().exists(),
            "nothing is left at the journal's path"
        );
        assert!(!journal.asset_store_directory().exists());
        assert!(!journal.drop_report_path().exists());
        assert!(fs::read(&kept).unwrap().starts_with(b"{"));
        assert_eq!(
            fs::read(root.join("recovery.json.assets.discarded-42.bak").join("a")).unwrap(),
            b"asset"
        );
        assert_eq!(
            fs::read(root.join("recovery.json.dropped.json.discarded-42.bak")).unwrap(),
            b"report"
        );
        // With the path clear, the next load is the normal first start.
        assert_eq!(journal.load().unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }
}
