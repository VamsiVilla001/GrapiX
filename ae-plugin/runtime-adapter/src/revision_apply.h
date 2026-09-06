#pragma once

/**
 * The write-and-rollback half of an atomic data revision, with After Effects factored out.
 *
 * ## Why this is its own unit
 *
 * After Effects offers a plugin no transaction to open around several stream writes, so atomicity is
 * built rather than borrowed: prove every member, capture every prior value, write, and on the first
 * failure put the already-written members back. That last clause is the load-bearing one — a batch that
 * failed halfway and left AE holding half a revision is worse than a refusal, because nobody can tell
 * which half reached air.
 *
 * It was also the one clause that had never run. `AE-CD2` shipped with the rollback implemented and its
 * refusal wired end to end, but never *triggered*: phase 2 rejects keyframed and expression-driven
 * streams up front, so on the pinned fixture no validated member had any way to fail
 * `AEGP_SetStreamValue` mid-batch. "Rollback works" was a code claim, not a measured one.
 *
 * Extracting the state machine from the AE calls is what makes it measurable. The sequencing — write
 * forward, restore in reverse, exactly once each, keep going when a restore itself fails — is pure
 * bookkeeping and needs no SDK at all. `revision_rollback_harness.cpp` drives it with injected faults
 * and no After Effects, the same way `frame_ring_harness.cpp` drives the ring.
 *
 * This does **not** replace the live trigger. Proving that a real AE stream can validate and then refuse
 * is still an experiment on the licensed host; this proves that when a write does fail, the recovery
 * sequence is correct and honestly reported.
 */

#include <cstddef>
#include <functional>
#include <string>
#include <vector>

namespace grapix {

/** One member write or restore, as the caller's AE-facing code reports it. */
struct RevisionWriteStatus {
    bool ok = false;
    /** Adapter error code when `ok` is false; empty otherwise. */
    std::string code;
};

/** Writes member `index`, or reports why it could not. */
using RevisionWriteFn = std::function<RevisionWriteStatus(std::size_t index)>;

/** Restores member `index` to the value captured before the batch. */
using RevisionRestoreFn = std::function<RevisionWriteStatus(std::size_t index)>;

enum class RevisionOutcome {
    /** Every member was written. */
    Applied,
    /** A write failed and every already-written member was restored. */
    RolledBack,
    /**
     * A write failed and at least one restore also failed, so After Effects holds a mixed state.
     *
     * Kept distinct from `RolledBack` because the operator's situation is categorically different: some
     * members are at their new value and some at their old, and no retry is safe until a human looks.
     * It is also kept distinct from an ordinary write failure — conflating the two is how the single
     * worst outcome ends up wearing the same name as a routine refusal.
     */
    RollbackFailed
};

struct RevisionApplyReport {
    RevisionOutcome outcome = RevisionOutcome::Applied;
    /** How many members were written before the failure; equals the member count when `Applied`. */
    std::size_t written = 0;
    /** Index whose write failed. Only meaningful when `outcome` is not `Applied`. */
    std::size_t failed_index = 0;
    /** The failing write's code, so the original fault is never lost behind the rollback's own report. */
    std::string failure_code;
    /** Indices restored, in the order they were restored — reverse of the order they were written. */
    std::vector<std::size_t> restored;
    /** Indices whose restore failed. Non-empty exactly when `outcome` is `RollbackFailed`. */
    std::vector<std::size_t> restore_failures;
    /** The first restore failure's code. Previously captured into a local and thrown away. */
    std::string restore_failure_code;

    bool rolled_back_cleanly() const { return outcome == RevisionOutcome::RolledBack; }
    bool mixed_state() const { return outcome == RevisionOutcome::RollbackFailed; }
};

/**
 * Write `count` members in order; on the first failure restore every already-written member in reverse.
 *
 * A failing restore does **not** stop the remaining restores: abandoning them would widen the mixed
 * state that has already begun. Every failure is recorded instead, and the outcome degrades to
 * `RollbackFailed` so no caller can report "we put it back" on evidence that says otherwise.
 *
 * `count == 0` is `Applied` with nothing written: an empty batch is refused earlier, by payload
 * validation, and this function does not invent a failure for it.
 */
RevisionApplyReport apply_revision_with_rollback(std::size_t count,
                                                 const RevisionWriteFn &write,
                                                 const RevisionRestoreFn &restore);

} // namespace grapix
