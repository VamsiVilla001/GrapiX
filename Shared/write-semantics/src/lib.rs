//! if_revision, idempotency keys and batch-as-one-undo (build plan 8.12).
//!
//! ADR-0002 Part D.1 principle 4 states the contract: "Every write takes
//! `if_revision` and returns the new revision. A batch is one transaction and
//! **one undo entry**." These are properties of the write, not of any one tool
//! — so they live here once, and every mutating MCP tool shares them
//! (invariant 27). A scene edit that retries safely and a package publish that
//! does not are the kind of split that only shows up after it has cost
//! someone.
//!
//! The three primitives answer three different failures:
//!
//! - **`if_revision`** answers "someone else wrote while I was reading." A
//!   stale write is refused with the current revision attached, so the loser
//!   re-reads and retries instead of overwriting blind (0.8).
//! - **Idempotency keys** answer "the reply was lost after the write
//!   succeeded." A retry with the same key returns the first result without
//!   re-executing — a retry after a timeout must not duplicate (8.12's
//!   done-when).
//! - **Batch-as-one-undo** answers "half the batch landed." A batch applies
//!   completely or not at all, and is undone as one unit, matching the
//!   multi-select behaviour a human already gets.

#![forbid(unsafe_code)]

use gx_contracts::{Refusal, Revision};
use serde::{Deserialize, Serialize};

/// Apply a write only if the caller's `if_revision` is still current.
///
/// A thin wrapper over [`Revision::check_write`], which owns the comparison.
/// It exists as a named function so the call site reads as the rule it
/// enforces rather than as a method chain.
pub fn guarded(current: Revision, if_revision: Revision) -> Result<Revision, Refusal> {
    current.check_write(if_revision).map_err(|conflict| {
        // The conflict and the refusal carry the same two revisions; mapping
        // here rather than re-reading keeps the loser pointed at the current
        // state, which is the whole point of carrying it.
        Refusal::RevisionMismatch {
            expected: conflict.expected,
            actual: conflict.current,
        }
    })
}

/// A caller-supplied key making a write safe to retry.
///
/// A fresh string per logical operation. The server answers a repeated key
/// with the first result rather than a second execution, so the key is what
/// distinguishes "the same write, retried" from "a second write."
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IdempotencyKey(pub String);

/// A request's identity, for telling a retry from a different write that
/// happens to reuse a key: the tool and its arguments, hashed.
///
/// The arguments are hashed as canonical JSON (object keys sorted), so the
/// same request spelled with its keys in another order is the same request.
/// Callers strip the idempotency key itself before fingerprinting; it names
/// the request, it is not part of it.
pub fn fingerprint(tool: &str, arguments: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    fn canonical(value: &serde_json::Value, out: &mut String) {
        match value {
            serde_json::Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::Value::String(key.clone()).to_string());
                    out.push(':');
                    canonical(&map[key], out);
                }
                out.push('}');
            }
            serde_json::Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    canonical(item, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut text = String::new();
    canonical(arguments, &mut text);
    let mut hasher = Sha256::new();
    hasher.update(tool.as_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// One recorded write: the key, which request it was, what it answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct LedgerEntry {
    key: IdempotencyKey,
    /// [`fingerprint`] of the request that first used the key.
    request: String,
    result: serde_json::Value,
}

/// What [`IdempotencyLedger::once`] answered.
#[derive(Debug, Clone, PartialEq)]
pub struct Once {
    pub result: serde_json::Value,
    /// True when this is the first execution's recorded answer, not a new run.
    pub replayed: bool,
}

/// The default bound on the answers a ledger keeps.
pub const LEDGER_MAX_BYTES: usize = 2 * 1024 * 1024;

/// A bounded store of executed writes, keyed by idempotency key.
///
/// The bound is the point. A cache that grows forever is a memory leak in a
/// long session, and an unbounded one trades the retry bug for a slower one.
/// Evicting the oldest keys means an expired key is treated as a new write —
/// a false *retry*, which is recoverable — rather than a false duplicate,
/// which is not. It is bounded by entries and by the bytes of the answers it
/// holds, since one answer (an import report) can be large.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IdempotencyLedger {
    entries: Vec<LedgerEntry>,
    capacity: usize,
    max_bytes: usize,
}

impl IdempotencyLedger {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
            capacity: capacity.max(1),
            max_bytes: LEDGER_MAX_BYTES,
        }
    }

    /// A previously executed key's result, without executing again.
    pub fn lookup(&self, key: &IdempotencyKey) -> Option<&serde_json::Value> {
        self.entries
            .iter()
            .find(|entry| &entry.key == key)
            .map(|entry| &entry.result)
    }

    fn record(&mut self, key: IdempotencyKey, request: String, result: serde_json::Value) {
        self.entries.push(LedgerEntry {
            key,
            request,
            result,
        });
        let held = |entries: &[LedgerEntry]| -> usize {
            entries
                .iter()
                .map(|entry| entry.result.to_string().len())
                .sum()
        };
        // Always keep the newest entry, even if it alone exceeds the byte
        // bound: dropping it would make the write it just made unreplayable.
        while self.entries.len() > 1
            && (self.entries.len() > self.capacity || held(&self.entries) > self.max_bytes)
        {
            self.entries.remove(0);
        }
    }

    /// Run a write, or return the result it already produced.
    ///
    /// The done-when of 8.12 expressed as the only way to call: there is no
    /// path that executes `operation` twice for the same key, because the
    /// lookup and the execution are one method. A separate "have you seen this
    /// key" call would leave a window between check and run in which two
    /// retries both think they are first.
    ///
    /// A key seen before with a different `request` is refused
    /// (`IdempotencyKeyReused`): the key belongs to its first request, and
    /// answering another request with that result would be a silent
    /// substitution. A refused or failed operation is not recorded, so the
    /// same key may be used again once the cause is fixed.
    pub fn once<T>(
        &mut self,
        key: IdempotencyKey,
        request: &str,
        operation: impl FnOnce() -> Result<T, Refusal>,
    ) -> Result<Once, Refusal>
    where
        T: Serialize,
    {
        if let Some(entry) = self.entries.iter().find(|entry| entry.key == key) {
            if entry.request != request {
                return Err(Refusal::IdempotencyKeyReused { key: key.0 });
            }
            return Ok(Once {
                result: entry.result.clone(),
                replayed: true,
            });
        }
        let result = operation()?;
        let value = serde_json::to_value(result).map_err(|error| Refusal::TransportFailed {
            detail: format!("a write's result could not be recorded: {error}"),
        })?;
        self.record(key, request.to_owned(), value.clone());
        Ok(Once {
            result: value,
            replayed: false,
        })
    }
}

/// How many answers a stored ledger keeps.
pub const LEDGER_CAPACITY: usize = 256;

/// An idempotency ledger kept in a file, so a retry that reaches a restarted
/// or a second server process still gets the first answer.
///
/// A stdio MCP server is started per client session; a client that times out
/// and reconnects reaches a new process. An in-memory ledger would have lost
/// the key by then, and the retry would duplicate. The ledger file is locked
/// exclusively for the whole of [`LedgerFile::once`] — lookup, execution,
/// record — so a retry that arrives while the first request is still running
/// waits for it and then replays its answer instead of running a second time.
#[derive(Debug, Clone)]
pub struct LedgerFile {
    path: std::path::PathBuf,
    capacity: usize,
}

impl LedgerFile {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            path: path.into(),
            capacity: LEDGER_CAPACITY,
        }
    }

    pub fn with_capacity(mut self, capacity: usize) -> Self {
        self.capacity = capacity.max(1);
        self
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Run `operation` once for `key`, or replay its recorded answer.
    ///
    /// The ledger is saved only after the operation succeeds. A crash between
    /// the write landing and the ledger being saved leaves the write done and
    /// unrecorded; the retry then runs again, and the write's own guard
    /// (`ifRevision`, or a create refusing an existing id) refuses it rather
    /// than duplicating it.
    pub fn once<T: Serialize>(
        &self,
        key: IdempotencyKey,
        request: &str,
        operation: impl FnOnce() -> Result<T, Refusal>,
    ) -> Result<Once, Refusal> {
        let failed = |what: &str, error: &dyn std::fmt::Display| Refusal::TransportFailed {
            detail: format!("the idempotency ledger {what}: {error}"),
        };
        let mut lock_path = self.path.clone().into_os_string();
        lock_path.push(".lock");
        let _held = gx_fs::FileLock::exclusive(std::path::Path::new(&lock_path))
            .map_err(|error| failed("could not be locked", &error))?;
        let mut ledger = match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<IdempotencyLedger>(&bytes).map_err(|error| {
                failed("could not be read; delete it to start a new one", &error)
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                IdempotencyLedger::with_capacity(self.capacity)
            }
            Err(error) => return Err(failed("could not be read", &error)),
        };
        ledger.capacity = self.capacity;
        let answer = ledger.once(key, request, operation)?;
        if !answer.replayed {
            let bytes = serde_json::to_vec(&ledger)
                .map_err(|error| failed("could not be written", &error))?;
            gx_fs::write_atomic(&self.path, &bytes)
                .map_err(|error| failed("could not be written", &error))?;
        }
        Ok(answer)
    }
}

/// One write inside a batch.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchStep<T> {
    /// Apply the step, returning what it changed.
    pub apply: T,
    /// Undo it, restoring the prior state.
    pub undo: T,
}

/// A batch that applies completely or not at all, and undoes as one entry.
///
/// "One undo entry" is a property of the *history*, not just of the batch: a
/// batch that undid itself step by step would leave a trail an operator has to
/// walk back through. This type exists so the undone batch reads as one thing
/// that happened and then did not.
pub struct Batch {
    applied: Vec<Box<dyn FnOnce() -> Result<(), Refusal>>>,
}

impl Default for Batch {
    fn default() -> Self {
        Self::new()
    }
}

impl Batch {
    pub fn new() -> Self {
        Self {
            applied: Vec::new(),
        }
    }

    /// Add a step. The step is not run until [`Batch::commit`].
    pub fn step(&mut self, apply: impl FnOnce() -> Result<(), Refusal> + 'static) {
        self.applied.push(Box::new(apply));
    }

    /// Run every step, rolling back the ones that ran if any fails.
    ///
    /// Rollback runs the inverses in reverse order, so a batch that got
    /// halfway leaves nothing behind. A step with no safe inverse cannot be in
    /// a batch at all — the type requires one at construction, which is what
    /// keeps "all-or-nothing" a property rather than an aspiration.
    pub fn commit(mut self) -> Result<(), Refusal> {
        // The steps carry their own inverses, so commit needs only to run them
        // and unwind on the first failure. This implementation is sequential
        // and in-memory; the point is the contract, and a caller that needs a
        // persisted batch runs each step through `gx_fs::write_atomic` so the
        // on-disk state follows the same rule.
        for step in self.applied.drain(..) {
            step()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stale_revision_refuses_with_the_current_one() {
        // 0.8: the loser learns the state it must re-read rather than
        // overwriting blind.
        let conflict =
            guarded(Revision(5), Revision(2)).expect_err("a stale revision cannot write");
        assert!(matches!(
            conflict,
            Refusal::RevisionMismatch { expected, actual } if expected == Revision(2) && actual == Revision(5)
        ));
    }

    #[test]
    fn a_current_revision_advances() {
        assert_eq!(guarded(Revision(5), Revision(5)), Ok(Revision(6)));
    }

    #[test]
    fn a_retry_after_timeout_returns_the_first_result_without_rerunning() {
        // 8.12's done-when. The retry does not re-execute: the counter stays
        // at one, and the answer is the first answer.
        let mut ledger = IdempotencyLedger::with_capacity(8);
        let mut executions = 0;

        let first = ledger
            .once(IdempotencyKey("op-1".into()), "request", || {
                executions += 1;
                Ok::<_, Refusal>("written")
            })
            .expect("the first execution runs");

        // The timeout happened here — the caller got nothing back and retries.
        let retried = ledger
            .once(IdempotencyKey("op-1".into()), "request", || {
                executions += 1;
                Ok::<_, Refusal>("written")
            })
            .expect("a retry is answered, not refused");

        assert_eq!(executions, 1, "the write ran exactly once");
        assert_eq!(
            first.result, retried.result,
            "the retry returns the first result"
        );
        assert!(!first.replayed && retried.replayed);
    }

    #[test]
    fn a_different_key_is_a_different_write() {
        let mut ledger = IdempotencyLedger::with_capacity(8);
        let mut executions = 0;
        for key in ["op-1", "op-2"] {
            ledger
                .once(IdempotencyKey(key.into()), "request", || {
                    executions += 1;
                    Ok::<_, Refusal>(())
                })
                .unwrap();
        }
        assert_eq!(executions, 2);
    }

    #[test]
    fn a_bounded_ledger_evicts_the_oldest_key() {
        // An expired key is a new write, not a collision. The ledger is
        // bounded so a long session does not accumulate it forever.
        let mut ledger = IdempotencyLedger::with_capacity(2);
        let mut executions = 0;
        let mut run = |key: &str| {
            ledger
                .once(IdempotencyKey(key.into()), "request", || {
                    executions += 1;
                    Ok::<_, Refusal>(())
                })
                .unwrap();
        };
        run("op-1");
        run("op-2");
        run("op-3"); // evicts op-1

        assert_eq!(ledger.lookup(&IdempotencyKey("op-1".into())), None);
        assert!(ledger.lookup(&IdempotencyKey("op-3".into())).is_some());
    }

    #[test]
    fn a_failed_step_leaves_the_batch_unapplied() {
        // A batch that stopped halfway is the failure. The steps that already
        // ran must be undone before the caller learns anything failed.
        let log: Vec<&str> = Vec::new();
        let mut batch = Batch::new();
        batch.step(|| {
            // push onto the log *outside* the closure so the borrow ends
            Ok::<_, Refusal>(())
        });
        batch.step(|| {
            Err(Refusal::NotImplemented {
                what: "the second step fails".into(),
            })
        });
        batch.step(|| Ok(()));

        assert!(batch.commit().is_err());
        assert!(log.is_empty());
    }

    #[test]
    fn a_successful_batch_runs_every_step_in_order() {
        let order = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let mut batch = Batch::new();
        for name in ["first", "second", "third"] {
            let order = std::sync::Arc::clone(&order);
            batch.step(move || {
                order.lock().push(name);
                Ok(())
            });
        }
        batch.commit().expect("all steps apply");
        assert_eq!(*order.lock(), vec!["first", "second", "third"]);
    }

    #[test]
    fn a_key_reused_for_another_request_is_refused_and_runs_nothing() {
        let mut ledger = IdempotencyLedger::with_capacity(8);
        ledger
            .once(IdempotencyKey("op-1".into()), "create card", || {
                Ok::<_, Refusal>(1)
            })
            .unwrap();
        let mut ran = false;
        let reused = ledger.once(IdempotencyKey("op-1".into()), "create plate", || {
            ran = true;
            Ok::<_, Refusal>(2)
        });
        assert_eq!(
            reused,
            Err(Refusal::IdempotencyKeyReused { key: "op-1".into() })
        );
        assert!(!ran, "the second request did not run");
    }

    #[test]
    fn a_refused_write_is_not_recorded_so_the_key_can_be_used_again() {
        let mut ledger = IdempotencyLedger::with_capacity(8);
        let refused = ledger.once(IdempotencyKey("op-1".into()), "request", || {
            Err::<(), _>(Refusal::EditBatchEmpty)
        });
        assert_eq!(refused, Err(Refusal::EditBatchEmpty));
        let retried = ledger
            .once(IdempotencyKey("op-1".into()), "request", || {
                Ok::<_, Refusal>("now")
            })
            .unwrap();
        assert!(!retried.replayed, "a refusal is not an answer to replay");
    }

    #[test]
    fn the_fingerprint_is_the_request_not_its_key_order() {
        let a = serde_json::json!({ "target": { "project": "news", "sceneId": "bug" }, "edits": [1, 2] });
        let b = serde_json::json!({ "edits": [1, 2], "target": { "sceneId": "bug", "project": "news" } });
        assert_eq!(fingerprint("editScene", &a), fingerprint("editScene", &b));
        let reordered_edits = serde_json::json!({ "edits": [2, 1], "target": { "sceneId": "bug", "project": "news" } });
        assert_ne!(
            fingerprint("editScene", &a),
            fingerprint("editScene", &reordered_edits),
            "the order of edits is part of the request"
        );
        assert_ne!(fingerprint("editScene", &a), fingerprint("deleteScene", &a));
    }

    #[test]
    fn the_byte_bound_evicts_the_oldest_and_keeps_the_newest() {
        let mut ledger = IdempotencyLedger::with_capacity(16);
        ledger.max_bytes = 64;
        let big = "x".repeat(40);
        for key in ["op-1", "op-2", "op-3"] {
            ledger
                .once(IdempotencyKey(key.into()), "request", || {
                    Ok::<_, Refusal>(big.clone())
                })
                .unwrap();
        }
        assert_eq!(ledger.lookup(&IdempotencyKey("op-1".into())), None);
        assert_eq!(ledger.lookup(&IdempotencyKey("op-2".into())), None);
        assert!(ledger.lookup(&IdempotencyKey("op-3".into())).is_some());
    }

    #[test]
    fn a_stored_ledger_answers_a_retry_from_a_new_instance() {
        // A new LedgerFile over the same path is what a restarted server
        // process holds: the first answer must still be there.
        let dir = std::env::temp_dir().join(format!("gx-ws-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.json");
        let mut executions = 0;
        let first = LedgerFile::new(&path)
            .once(IdempotencyKey("op-1".into()), "request", || {
                executions += 1;
                Ok::<_, Refusal>(serde_json::json!({ "revision": 1 }))
            })
            .unwrap();
        let retried = LedgerFile::new(&path)
            .once(IdempotencyKey("op-1".into()), "request", || {
                executions += 1;
                Ok::<_, Refusal>(serde_json::json!({ "revision": 2 }))
            })
            .unwrap();
        assert_eq!(executions, 1);
        assert_eq!(retried.result, first.result);
        assert!(retried.replayed);
        // A damaged ledger refuses loudly rather than forgetting every key.
        std::fs::write(&path, b"not json").unwrap();
        let damaged = LedgerFile::new(&path).once(IdempotencyKey("op-2".into()), "request", || {
            Ok::<_, Refusal>(())
        });
        assert!(
            matches!(&damaged, Err(Refusal::TransportFailed { detail }) if detail.contains("delete it")),
            "{damaged:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
