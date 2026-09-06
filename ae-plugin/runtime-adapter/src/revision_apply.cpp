#include "revision_apply.h"

namespace grapix {

RevisionApplyReport apply_revision_with_rollback(std::size_t count,
                                                 const RevisionWriteFn &write,
                                                 const RevisionRestoreFn &restore)
{
    RevisionApplyReport report;
    if (count == 0 || !write) {
        report.outcome = RevisionOutcome::Applied;
        return report;
    }

    for (; report.written < count; ++report.written) {
        const RevisionWriteStatus status = write(report.written);
        if (!status.ok) {
            report.failed_index = report.written;
            report.failure_code = status.code;
            break;
        }
    }

    if (report.written == count) {
        report.outcome = RevisionOutcome::Applied;
        return report;
    }

    // Reverse order, so a member written later is put back before one written earlier: the writes are
    // not independent in AE's undo history, and undoing them out of order would leave the group in a
    // sequence AE never saw forwards.
    report.outcome = RevisionOutcome::RolledBack;
    for (std::size_t index = report.written; index-- > 0;) {
        const RevisionWriteStatus status = restore ? restore(index) : RevisionWriteStatus{};
        if (status.ok) {
            report.restored.push_back(index);
            continue;
        }
        // Keep restoring. Stopping here would widen the mixed state instead of limiting it, and the
        // remaining members are the ones most likely to still be recoverable.
        report.restore_failures.push_back(index);
        if (report.restore_failure_code.empty()) {
            report.restore_failure_code = status.code.empty() ? "AE_ERROR" : status.code;
        }
        report.outcome = RevisionOutcome::RollbackFailed;
    }
    return report;
}

} // namespace grapix
