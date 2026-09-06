// Measures the rollback sequence without After Effects; triggering a real AE write refusal remains a separate live-host gate.
#include "src/revision_apply.h"

#include <cstdio>
#include <string>
#include <vector>

namespace {

constexpr std::size_t kNoFailure = static_cast<std::size_t>(-1);

struct CountingFaultInjector {
    std::size_t failing_write = kNoFailure;
    std::size_t failing_restore = kNoFailure;
    bool fail_every_restore = false;
    std::string write_failure_code = "WRITE_REFUSED";
    std::string restore_failure_code = "RESTORE_REFUSED";
    std::vector<std::size_t> write_calls;
    std::vector<std::size_t> restore_calls;

    grapix::RevisionWriteStatus write(std::size_t index)
    {
        write_calls.push_back(index);
        if (index == failing_write) return {false, write_failure_code};
        return {true, {}};
    }

    grapix::RevisionWriteStatus restore(std::size_t index)
    {
        restore_calls.push_back(index);
        if (fail_every_restore || index == failing_restore) return {false, restore_failure_code};
        return {true, {}};
    }
};

bool equals(const std::vector<std::size_t> &actual, std::initializer_list<std::size_t> expected)
{
    return actual == std::vector<std::size_t>(expected);
}

bool descending_indices(std::size_t count, const std::vector<std::size_t> &actual)
{
    if (actual.size() != count) return false;
    for (std::size_t index = 0; index < count; ++index) {
        if (actual[index] != count - index - 1) return false;
    }
    return true;
}

bool restored_exactly_once(const CountingFaultInjector &injector, std::size_t written)
{
    if (injector.restore_calls.size() != written) return false;
    std::vector<std::size_t> counts(written, 0);
    for (const std::size_t index : injector.restore_calls) {
        if (index >= written || ++counts[index] != 1) return false;
    }
    for (const std::size_t count : counts) if (count != 1) return false;
    return true;
}

void print_case(const char *name, bool passed)
{
    std::printf("%s %s\n", passed ? "PASS" : "FAIL", name);
}

bool case_all_success()
{
    constexpr std::size_t count = 4;
    CountingFaultInjector injector;
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        count,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::Applied &&
        report.written == count && report.restored.empty() && report.restore_failures.empty() &&
        injector.write_calls.size() == count && injector.restore_calls.empty();
    print_case("all-success", passed);
    return passed;
}

bool case_mid_batch_failure()
{
    CountingFaultInjector injector;
    injector.failing_write = 3;
    injector.write_failure_code = "WRITE_AT_3";
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        5,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::RolledBack &&
        report.written == 3 && report.failed_index == 3 && report.failure_code == "WRITE_AT_3" &&
        equals(report.restored, {2, 1, 0}) && report.restore_failures.empty() &&
        equals(injector.restore_calls, {2, 1, 0}) && restored_exactly_once(injector, 3);
    print_case("mid-batch-failure-reverses-exactly-once", passed);
    return passed;
}

bool case_first_member_fails()
{
    CountingFaultInjector injector;
    injector.failing_write = 0;
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        4,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::RolledBack &&
        report.written == 0 && report.restored.empty() && report.restore_failures.empty() &&
        injector.restore_calls.empty();
    print_case("first-member-fails", passed);
    return passed;
}

bool case_last_member_fails()
{
    CountingFaultInjector injector;
    injector.failing_write = 3;
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        4,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::RolledBack &&
        report.written == 3 && report.failed_index == 3 && equals(report.restored, {2, 1, 0}) &&
        restored_exactly_once(injector, 3);
    print_case("last-member-fails", passed);
    return passed;
}

bool case_failed_restore_continues()
{
    CountingFaultInjector injector;
    injector.failing_write = 3;
    injector.failing_restore = 1;
    injector.restore_failure_code = "RESTORE_AT_1";
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        5,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::RollbackFailed &&
        equals(report.restore_failures, {1}) && report.restore_failure_code == "RESTORE_AT_1" &&
        equals(report.restored, {2, 0}) && equals(injector.restore_calls, {2, 1, 0}) &&
        restored_exactly_once(injector, 3);
    print_case("failed-restore-continues", passed);
    return passed;
}

bool case_every_restore_fails()
{
    CountingFaultInjector injector;
    injector.failing_write = 3;
    injector.fail_every_restore = true;
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        4,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::RollbackFailed &&
        report.restored.empty() && equals(report.restore_failures, {2, 1, 0}) &&
        equals(injector.restore_calls, {2, 1, 0}) && restored_exactly_once(injector, 3);
    print_case("every-restore-fails", passed);
    return passed;
}

bool case_original_failure_survives()
{
    CountingFaultInjector injector;
    injector.failing_write = 3;
    injector.failing_restore = 2;
    injector.write_failure_code = "ORIGINAL_WRITE_FAILURE";
    injector.restore_failure_code = "SECONDARY_RESTORE_FAILURE";
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        4,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::RollbackFailed &&
        report.failure_code == "ORIGINAL_WRITE_FAILURE" &&
        report.restore_failure_code == "SECONDARY_RESTORE_FAILURE";
    print_case("original-failure-code-survives", passed);
    return passed;
}

bool case_empty_batch()
{
    CountingFaultInjector injector;
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        0,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::Applied &&
        report.written == 0 && report.restored.empty() && report.restore_failures.empty() &&
        injector.write_calls.empty() && injector.restore_calls.empty();
    print_case("empty-batch", passed);
    return passed;
}

bool case_empty_restore_code_normalized()
{
    CountingFaultInjector injector;
    injector.failing_write = 2;
    injector.failing_restore = 1;
    injector.restore_failure_code.clear();
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        3,
        [&injector](std::size_t index) { return injector.write(index); },
        [&injector](std::size_t index) { return injector.restore(index); });
    const bool passed = report.outcome == grapix::RevisionOutcome::RollbackFailed &&
        report.restore_failure_code == "AE_ERROR" && equals(report.restore_failures, {1}) &&
        equals(injector.restore_calls, {1, 0});
    print_case("empty-restore-code-normalized", passed);
    return passed;
}

bool case_scale(std::size_t *total_write_calls, std::size_t *total_restore_calls)
{
    constexpr std::size_t batches = 1000;
    constexpr std::size_t members = 8;
    bool passed = true;
    *total_write_calls = 0;
    *total_restore_calls = 0;
    for (std::size_t batch = 0; batch < batches; ++batch) {
        CountingFaultInjector injector;
        injector.failing_write = batch % members;
        const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
            members,
            [&injector](std::size_t index) { return injector.write(index); },
            [&injector](std::size_t index) { return injector.restore(index); });
        const std::size_t written = injector.failing_write;
        passed = passed && report.outcome == grapix::RevisionOutcome::RolledBack &&
            report.written == written && report.failed_index == written &&
            descending_indices(written, report.restored) && report.restore_failures.empty() &&
            restored_exactly_once(injector, written);
        *total_write_calls += injector.write_calls.size();
        *total_restore_calls += injector.restore_calls.size();
    }
    std::printf("%s scale batches=%zu members=%zu write_calls=%zu restore_calls=%zu\n",
                passed ? "PASS" : "FAIL", batches, members, *total_write_calls, *total_restore_calls);
    return passed;
}

} // namespace

int main()
{
    std::size_t scale_write_calls = 0;
    std::size_t scale_restore_calls = 0;
    bool passed = true;
    passed = case_all_success() && passed;
    passed = case_mid_batch_failure() && passed;
    passed = case_first_member_fails() && passed;
    passed = case_last_member_fails() && passed;
    passed = case_failed_restore_continues() && passed;
    passed = case_every_restore_fails() && passed;
    passed = case_original_failure_survives() && passed;
    passed = case_empty_batch() && passed;
    passed = case_empty_restore_code_normalized() && passed;
    passed = case_scale(&scale_write_calls, &scale_restore_calls) && passed;
    std::printf("summary cases=10 result=%s scale_write_calls=%zu scale_restore_calls=%zu\n",
                passed ? "PASS" : "FAIL", scale_write_calls, scale_restore_calls);
    return passed ? 0 : 1;
}
