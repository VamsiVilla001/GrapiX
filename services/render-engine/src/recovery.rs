//! Durable M3 Program recovery journal.
//!
//! A successful Playout Program/output/data command enters the checksummed WAL
//! before its acknowledgement is sent. Snapshots are written to a sibling temporary
//! file, fsynced, atomically renamed, then the directory is synced. Restore starts
//! output-inhibited; callers must validate one fresh off-air frame before enabling
//! any live sink.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("recovery storage error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("recovery data is corrupt: {0}")]
    Corrupt(String),
    #[error("recovery data cannot be serialized: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("output activation is inhibited until a first off-air frame validates")]
    OutputInhibited,
}

/// Every durable Program mutation carries enough context to reject stale replays.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCommand {
    pub state_revision: u64,
    pub idempotency_key: String,
    pub precondition_revision: Option<u64>,
    pub message_type: String,
    pub payload: Value,
    pub package_checksum: String,
    pub output_lease: String,
    pub output_fence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WalRecord {
    command: RecoveryCommand,
    checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    /// Last WAL state revision included in `state`.
    pub watermark: u64,
    pub state: Value,
    pub package_checksums: Vec<String>,
    pub output_lease: String,
    pub output_fence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChecksummedSnapshot {
    snapshot: RecoverySnapshot,
    checksum: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RestoredRecovery {
    pub snapshot: RecoverySnapshot,
    pub replay: Vec<RecoveryCommand>,
}

/// File-backed journal. Paths are deployment-local and no recovery material is
/// accepted from a client, which keeps an attacker from redirecting durable state.
pub struct RecoveryJournal {
    wal_path: PathBuf,
    snapshot_path: PathBuf,
    next_revision: u64,
}

impl RecoveryJournal {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self, RecoveryError> {
        let directory = directory.as_ref();
        fs::create_dir_all(directory).map_err(|source| RecoveryError::Io {
            path: directory.to_path_buf(),
            source,
        })?;
        let wal_path = directory.join("program.wal");
        let snapshot_path = directory.join("program.snapshot.json");
        let next_revision = Self::read_wal(&wal_path)
            .map(|records| {
                records
                    .last()
                    .map(|record| record.command.state_revision + 1)
                    .unwrap_or(1)
            })?
            .max(1);
        Ok(Self {
            wal_path,
            snapshot_path,
            next_revision,
        })
    }

    pub fn next_revision(&self) -> u64 {
        self.next_revision
    }

    /// Assign a monotonic revision and fsync the command. Call this before forming
    /// the successful protocol acknowledgement; an I/O failure must refuse it.
    pub fn append_accepted(
        &mut self,
        mut command: RecoveryCommand,
    ) -> Result<RecoveryCommand, RecoveryError> {
        if command.idempotency_key.trim().is_empty() {
            return Err(RecoveryError::Corrupt(
                "accepted command has an empty idempotency key".to_string(),
            ));
        }
        if command.package_checksum.trim().is_empty() || command.output_lease.trim().is_empty() {
            return Err(RecoveryError::Corrupt(
                "accepted command lacks package checksum or output lease".to_string(),
            ));
        }
        command.state_revision = self.next_revision;
        let record = WalRecord {
            checksum: checksum(&command)?,
            command: command.clone(),
        };
        let bytes = serde_json::to_vec(&record)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.wal_path)
            .map_err(|source| RecoveryError::Io {
                path: self.wal_path.clone(),
                source,
            })?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_data())
            .map_err(|source| RecoveryError::Io {
                path: self.wal_path.clone(),
                source,
            })?;
        self.next_revision = self
            .next_revision
            .checked_add(1)
            .ok_or_else(|| RecoveryError::Corrupt("state revision overflow".to_string()))?;
        Ok(command)
    }

    /// Atomically replace the snapshot. WAL is intentionally retained: the snapshot
    /// watermark tells restore precisely which entries still require replay.
    pub fn write_snapshot(&self, snapshot: RecoverySnapshot) -> Result<(), RecoveryError> {
        let wrapped = ChecksummedSnapshot {
            checksum: checksum(&snapshot)?,
            snapshot,
        };
        let payload = serde_json::to_vec(&wrapped)?;
        let temporary = self.snapshot_path.with_extension("snapshot.tmp");
        {
            let mut file = File::create(&temporary).map_err(|source| RecoveryError::Io {
                path: temporary.clone(),
                source,
            })?;
            file.write_all(&payload)
                .and_then(|_| file.sync_all())
                .map_err(|source| RecoveryError::Io {
                    path: temporary.clone(),
                    source,
                })?;
        }
        fs::rename(&temporary, &self.snapshot_path).map_err(|source| RecoveryError::Io {
            path: self.snapshot_path.clone(),
            source,
        })?;
        sync_parent(&self.snapshot_path)?;
        Ok(())
    }

    /// Reads verified recovery data. A missing snapshot is safe only if there are no
    /// WAL records; callers otherwise leave output off-air and publish the error.
    pub fn restore(&self) -> Result<RestoredRecovery, RecoveryError> {
        let records = Self::read_wal(&self.wal_path)?;
        let snapshot = match fs::read(&self.snapshot_path) {
            Ok(bytes) => {
                let wrapped: ChecksummedSnapshot = serde_json::from_slice(&bytes)?;
                if checksum(&wrapped.snapshot)? != wrapped.checksum {
                    return Err(RecoveryError::Corrupt(
                        "snapshot checksum mismatch".to_string(),
                    ));
                }
                wrapped.snapshot
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && records.is_empty() => {
                RecoverySnapshot {
                    watermark: 0,
                    state: Value::Null,
                    package_checksums: Vec::new(),
                    output_lease: String::new(),
                    output_fence: 0,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(RecoveryError::Corrupt(
                    "WAL exists but snapshot is missing".to_string(),
                ));
            }
            Err(source) => {
                return Err(RecoveryError::Io {
                    path: self.snapshot_path.clone(),
                    source,
                })
            }
        };
        let mut replay = Vec::new();
        let mut last_revision = snapshot.watermark;
        for record in records {
            if record.command.state_revision <= snapshot.watermark {
                continue;
            }
            if record.command.state_revision != last_revision + 1 {
                return Err(RecoveryError::Corrupt(format!(
                    "non-contiguous WAL revision {} after {last_revision}",
                    record.command.state_revision
                )));
            }
            last_revision = record.command.state_revision;
            replay.push(record.command);
        }
        Ok(RestoredRecovery { snapshot, replay })
    }

    fn read_wal(path: &Path) -> Result<Vec<WalRecord>, RecoveryError> {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(RecoveryError::Io {
                    path: path.to_path_buf(),
                    source,
                })
            }
        };
        let mut records = Vec::new();
        let mut previous = 0_u64;
        for (line_index, line_result) in BufReader::new(file).lines().enumerate() {
            let line = line_result.map_err(|source| RecoveryError::Io {
                path: path.to_path_buf(),
                source,
            })?;
            if line.is_empty() {
                continue;
            }
            let record: WalRecord = serde_json::from_str(&line).map_err(|error| {
                RecoveryError::Corrupt(format!("WAL line {}: {error}", line_index + 1))
            })?;
            if checksum(&record.command)? != record.checksum {
                return Err(RecoveryError::Corrupt(format!(
                    "WAL line {} checksum mismatch",
                    line_index + 1
                )));
            }
            if record.command.state_revision <= previous {
                return Err(RecoveryError::Corrupt(format!(
                    "WAL line {} revision is not monotonic",
                    line_index + 1
                )));
            }
            previous = record.command.state_revision;
            records.push(record);
        }
        Ok(records)
    }
}

/// Restore state machine. Every failure remains inhibited and must be surfaced as a
/// degraded event by the engine host; no cached frame can transition this to live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryActivation {
    Inhibited,
    ReplayedOffAir,
    FirstFrameValidated,
    Degraded,
}

pub struct RecoveryGate {
    state: RecoveryActivation,
}

impl Default for RecoveryGate {
    fn default() -> Self {
        Self {
            state: RecoveryActivation::Inhibited,
        }
    }
}

impl RecoveryGate {
    pub fn state(&self) -> RecoveryActivation {
        self.state
    }
    pub fn begin_restore(&mut self) {
        self.state = RecoveryActivation::Inhibited;
    }
    pub fn replayed_off_air(&mut self) -> Result<(), RecoveryError> {
        if self.state != RecoveryActivation::Inhibited {
            return Err(RecoveryError::OutputInhibited);
        }
        self.state = RecoveryActivation::ReplayedOffAir;
        Ok(())
    }
    pub fn validate_first_frame(&mut self, valid: bool) -> Result<(), RecoveryError> {
        if self.state != RecoveryActivation::ReplayedOffAir || !valid {
            self.state = RecoveryActivation::Degraded;
            return Err(RecoveryError::OutputInhibited);
        }
        self.state = RecoveryActivation::FirstFrameValidated;
        Ok(())
    }
    pub fn permit_output(&self) -> Result<(), RecoveryError> {
        (self.state == RecoveryActivation::FirstFrameValidated)
            .then_some(())
            .ok_or(RecoveryError::OutputInhibited)
    }
    pub fn degrade(&mut self) {
        self.state = RecoveryActivation::Degraded;
    }
}

fn checksum<T: Serialize>(value: &T) -> Result<String, RecoveryError> {
    let bytes = serde_json::to_vec(value)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn sync_parent(path: &Path) -> Result<(), RecoveryError> {
    let parent = path
        .parent()
        .ok_or_else(|| RecoveryError::Corrupt("snapshot has no parent directory".to_string()))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| RecoveryError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(key: &str) -> RecoveryCommand {
        RecoveryCommand {
            state_revision: 0,
            idempotency_key: key.to_string(),
            precondition_revision: Some(4),
            message_type: "playout.update".to_string(),
            payload: serde_json::json!({"headline": "On air"}),
            package_checksum: "pkg-sha256".to_string(),
            output_lease: "lease-1".to_string(),
            output_fence: 7,
        }
    }

    #[test]
    fn replays_only_entries_after_atomic_snapshot_watermark() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = RecoveryJournal::open(directory.path()).unwrap();
        let first = journal.append_accepted(command("one")).unwrap();
        let second = journal.append_accepted(command("two")).unwrap();
        journal
            .write_snapshot(RecoverySnapshot {
                watermark: first.state_revision,
                state: serde_json::json!({"program": "scene-a"}),
                package_checksums: vec![first.package_checksum],
                output_lease: first.output_lease,
                output_fence: first.output_fence,
            })
            .unwrap();
        let restored = journal.restore().unwrap();
        assert_eq!(restored.snapshot.watermark, 1);
        assert_eq!(restored.replay, vec![second]);
    }

    #[test]
    fn tampered_wal_refuses_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = RecoveryJournal::open(directory.path()).unwrap();
        journal.append_accepted(command("one")).unwrap();
        fs::write(directory.path().join("program.wal"), "{\"bad\":true}\n").unwrap();
        assert!(matches!(journal.restore(), Err(RecoveryError::Corrupt(_))));
    }

    #[test]
    fn output_requires_fresh_off_air_validation() {
        let mut gate = RecoveryGate::default();
        assert!(gate.permit_output().is_err());
        gate.replayed_off_air().unwrap();
        assert!(gate.validate_first_frame(false).is_err());
        assert_eq!(gate.state(), RecoveryActivation::Degraded);
        gate.begin_restore();
        gate.replayed_off_air().unwrap();
        gate.validate_first_frame(true).unwrap();
        assert!(gate.permit_output().is_ok());
    }
}
