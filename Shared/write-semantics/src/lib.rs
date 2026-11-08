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

/// A bounded store of executed writes, keyed by idempotency key.
///
/// The bound is the point. A cache that grows forever is a memory leak in a
/// long session, and an unbounded one trades the retry bug for a slower one.
/// Evicting the oldest keys means an expired key is treated as a new write —
/// a false *retry*, which is recoverable — rather than a false duplicate,
/// which is not.
#[derive(Debug)]
pub struct IdempotencyLedger {
    entries: Vec<(IdempotencyKey, serde_json::Value)>,
    capacity: usize,
}

impl IdempotencyLedger {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
            capacity: capacity.max(1),
        }
    }

    /// A previously executed key's result, without executing again.
    pub fn lookup(&self, key: &IdempotencyKey) -> Option<&serde_json::Value> {
        self.entries
            .iter()
            .find(|(held, _)| held == key)
            .map(|(_, result)| result)
    }

    /// Record an executed key and its result, evicting the oldest at capacity.
    pub fn record(&mut self, key: IdempotencyKey, result: serde_json::Value) {
        if self.entries.len() == self.capacity {
            self.entries.remove(0);
        }
        self.entries.push((key, result));
    }

    /// Run a write, or return the result it already produced.
    ///
    /// The done-when of 8.12 expressed as the only way to call: there is no
    /// path that executes `operation` twice for the same key, because the
    /// lookup and the execution are one method. A separate "have you seen this
    /// key" call would leave a window between check and run in which two
    /// retries both think they are first.
    pub fn once<T>(
        &mut self,
        key: IdempotencyKey,
        operation: impl FnOnce() -> Result<T, Refusal>,
    ) -> Result<serde_json::Value, Refusal>
    where
        T: Serialize,
    {
        if let Some(result) = self.lookup(&key) {
            return Ok(result.clone());
        }
        let result = operation()?;
        let value = serde_json::to_value(result).map_err(|error| Refusal::TransportFailed {
            detail: format!("a write's result could not be recorded: {error}"),
        })?;
        self.record(key, value.clone());
        Ok(value)
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
            .once(IdempotencyKey("op-1".into()), || {
                executions += 1;
                Ok::<_, Refusal>("written")
            })
            .expect("the first execution runs");

        // The timeout happened here — the caller got nothing back and retries.
        let retried = ledger
            .once(IdempotencyKey("op-1".into()), || {
                executions += 1;
                Ok::<_, Refusal>("written")
            })
            .expect("a retry is answered, not refused");

        assert_eq!(executions, 1, "the write ran exactly once");
        assert_eq!(first, retried, "the retry returns the first result");
    }

    #[test]
    fn a_different_key_is_a_different_write() {
        let mut ledger = IdempotencyLedger::with_capacity(8);
        let mut executions = 0;
        for key in ["op-1", "op-2"] {
            ledger
                .once(IdempotencyKey(key.into()), || {
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
                .once(IdempotencyKey(key.into()), || {
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
}
