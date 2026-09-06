#include "src/frame_ring.h"

#include <windows.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

namespace {

constexpr std::uint32_t kSlots = 4;
constexpr std::uint32_t kWidth = 128;
constexpr std::uint32_t kHeight = 64;
constexpr std::uint32_t kStride = kWidth * 4;
constexpr std::uint64_t kRevision = 7;

std::wstring widen(const char* value)
{
    std::wstring result;
    while (*value != '\0') result.push_back(static_cast<wchar_t>(*value++));
    return result;
}

void fill_descriptor(grapix::FrameRingDescriptor* descriptor, std::uint64_t generation,
                     std::uint32_t slot, std::uint64_t frame_id, std::uint64_t revision)
{
    descriptor->ring_generation = generation;
    descriptor->slot_index = slot;
    descriptor->frame_id = frame_id;
    descriptor->data_revision = revision;
    descriptor->composition_item_id = 42;
    strcpy_s(descriptor->requested_time_value, "1001");
    strcpy_s(descriptor->requested_time_scale, "30000");
    strcpy_s(descriptor->evaluated_time_value, "1001");
    strcpy_s(descriptor->evaluated_time_scale, "30000");
    descriptor->presentation_deadline_nanos = frame_id * 33366666ULL;
    descriptor->width = kWidth;
    descriptor->height = kHeight;
    descriptor->stride = kStride;
    descriptor->color_format = grapix::FrameRingColorFormat::Bgra8;
    descriptor->alpha_mode = grapix::FrameRingAlphaMode::Premultiplied;
    strcpy_s(descriptor->color_space, "rec709");
    descriptor->status = grapix::FrameRingFrameStatus::Ready;
}

void fill_bytes(std::uint8_t* bytes, std::size_t length, std::uint64_t frame_id)
{
    const std::uint8_t value = static_cast<std::uint8_t>((frame_id * 37U) & 0xffU);
    for (std::size_t i = 0; i < length; ++i) bytes[i] = static_cast<std::uint8_t>(value + i);
}

bool verify_bytes(const std::uint8_t* bytes, std::size_t length, std::uint64_t frame_id)
{
    const std::uint8_t value = static_cast<std::uint8_t>((frame_id * 37U) & 0xffU);
    for (std::size_t i = 0; i < length; ++i) {
        if (bytes[i] != static_cast<std::uint8_t>(value + i)) return false;
    }
    return true;
}

int consumer(const std::wstring& mapping_name, const std::wstring& ready_name,
             const std::wstring& phase_one_name, const std::wstring& done_one_name,
             const std::wstring& phase_stale_name, const std::wstring& done_stale_name,
             const std::wstring& phase_two_name, const std::wstring& done_two_name,
             std::uint64_t cycles)
{
    std::unique_ptr<grapix::SharedFrameRing> ring;
    if (grapix::SharedFrameRing::Open(mapping_name, grapix::FrameRingRole::Consumer, GetCurrentProcessId(), &ring) != grapix::FrameRingResult::Ok) return 10;
    HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, ready_name.c_str());
    HANDLE phase_one = OpenEventW(SYNCHRONIZE, FALSE, phase_one_name.c_str());
    HANDLE done_one = OpenEventW(EVENT_MODIFY_STATE, FALSE, done_one_name.c_str());
    HANDLE phase_stale = OpenEventW(SYNCHRONIZE, FALSE, phase_stale_name.c_str());
    HANDLE done_stale = OpenEventW(EVENT_MODIFY_STATE, FALSE, done_stale_name.c_str());
    HANDLE phase_two = OpenEventW(SYNCHRONIZE, FALSE, phase_two_name.c_str());
    HANDLE done_two = OpenEventW(EVENT_MODIFY_STATE, FALSE, done_two_name.c_str());
    if (!ready || !phase_one || !done_one || !phase_stale || !done_stale || !phase_two || !done_two) return 11;
    SetEvent(ready);
    if (WaitForSingleObject(phase_one, 30000) != WAIT_OBJECT_0) return 12;
    for (std::uint64_t read = 0; read < cycles; ) {
        grapix::FrameRingReadLease lease;
        const auto result = ring->acquire_read(kRevision, &lease);
        if (result == grapix::FrameRingResult::NotReady) { SwitchToThread(); continue; }
        if (result != grapix::FrameRingResult::Ok || lease.descriptor->ring_generation != lease.generation ||
            lease.descriptor->slot_index != lease.slot_index || lease.descriptor->data_revision != kRevision ||
            lease.byte_length != kStride * kHeight || !verify_bytes(lease.bytes, lease.byte_length, lease.descriptor->frame_id) ||
            ring->release_read(lease) != grapix::FrameRingResult::Ok) return 13;
        ++read;
    }
    SetEvent(done_one);
    if (WaitForSingleObject(phase_stale, 30000) != WAIT_OBJECT_0) return 14;
    grapix::FrameRingReadLease stale;
    if (ring->acquire_read(kRevision, &stale) != grapix::FrameRingResult::StaleRevision) return 15;
    SetEvent(done_stale);
    if (WaitForSingleObject(phase_two, 30000) != WAIT_OBJECT_0) return 16;
    for (std::uint32_t read = 0; read < kSlots; ) {
        grapix::FrameRingReadLease lease;
        const auto result = ring->acquire_read(kRevision, &lease);
        if (result == grapix::FrameRingResult::NotReady) { SwitchToThread(); continue; }
        if (result != grapix::FrameRingResult::Ok || !verify_bytes(lease.bytes, lease.byte_length, lease.descriptor->frame_id) ||
            ring->release_read(lease) != grapix::FrameRingResult::Ok) return 17;
        ++read;
    }
    SetEvent(done_two);
    return 0;
}

bool publish_frame(grapix::SharedFrameRing* ring, std::uint64_t frame_id, std::uint64_t revision,
                   std::uint64_t* slot_visits)
{
    grapix::FrameRingWriteLease lease;
    const auto acquire = ring->acquire_write(&lease);
    if (acquire == grapix::FrameRingResult::BackPressure) return false;
    if (acquire != grapix::FrameRingResult::Ok) return false;
    fill_bytes(lease.bytes, lease.capacity, frame_id);
    grapix::FrameRingDescriptor descriptor;
    fill_descriptor(&descriptor, lease.generation, lease.slot_index, frame_id, revision);
    if (ring->publish(lease, descriptor, lease.capacity) != grapix::FrameRingResult::Ok) return false;
    ++slot_visits[lease.slot_index];
    return true;
}

int producer(const wchar_t* executable, std::uint64_t cycles)
{
    const std::wstring suffix = std::to_wstring(GetCurrentProcessId());
    const std::wstring mapping_name = L"Local\\GrapiXFrameRingHarness-" + suffix;
    const std::wstring ready_name = mapping_name + L"-ready";
    const std::wstring phase_one_name = mapping_name + L"-phase-one";
    const std::wstring done_one_name = mapping_name + L"-done-one";
    const std::wstring phase_stale_name = mapping_name + L"-phase-stale";
    const std::wstring done_stale_name = mapping_name + L"-done-stale";
    const std::wstring phase_two_name = mapping_name + L"-phase-two";
    const std::wstring done_two_name = mapping_name + L"-done-two";
    const grapix::FrameRingConfig config{kSlots, kWidth, kHeight, kStride, grapix::FrameRingColorFormat::Bgra8};
    std::unique_ptr<grapix::SharedFrameRing> ring;
    if (grapix::SharedFrameRing::Create(mapping_name, config, GetCurrentProcessId(), &ring) != grapix::FrameRingResult::Ok) return 20;
    HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, ready_name.c_str());
    HANDLE phase_one = CreateEventW(nullptr, FALSE, FALSE, phase_one_name.c_str());
    HANDLE done_one = CreateEventW(nullptr, FALSE, FALSE, done_one_name.c_str());
    HANDLE phase_stale = CreateEventW(nullptr, FALSE, FALSE, phase_stale_name.c_str());
    HANDLE done_stale = CreateEventW(nullptr, FALSE, FALSE, done_stale_name.c_str());
    HANDLE phase_two = CreateEventW(nullptr, FALSE, FALSE, phase_two_name.c_str());
    HANDLE done_two = CreateEventW(nullptr, FALSE, FALSE, done_two_name.c_str());
    if (!ready || !phase_one || !done_one || !phase_stale || !done_stale || !phase_two || !done_two) return 21;
    std::wstring command = L"\"" + std::wstring(executable) + L"\" --consumer \"" + mapping_name + L"\" \"" + ready_name + L"\" \"" + phase_one_name + L"\" \"" + done_one_name + L"\" \"" + phase_stale_name + L"\" \"" + done_stale_name + L"\" \"" + phase_two_name + L"\" \"" + done_two_name + L"\" " + std::to_wstring(cycles);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &child)) return 22;
    if (WaitForSingleObject(ready, 30000) != WAIT_OBJECT_0) return 23;
    SetEvent(phase_one);
    std::uint64_t slot_visits[kSlots]{};
    for (std::uint64_t frame_id = 0; frame_id < cycles; ) {
        if (publish_frame(ring.get(), frame_id, kRevision, slot_visits)) ++frame_id;
        else SwitchToThread();
    }
    if (WaitForSingleObject(done_one, 30000) != WAIT_OBJECT_0) return 24;
    for (const std::uint64_t visits : slot_visits) if (visits == 0) return 25;

    grapix::FrameRingWriteLease invalid;
    if (ring->acquire_write(&invalid) != grapix::FrameRingResult::Ok) return 26;
    fill_bytes(invalid.bytes, invalid.capacity, 1);
    grapix::FrameRingDescriptor descriptor;
    fill_descriptor(&descriptor, invalid.generation - 1, invalid.slot_index, cycles, kRevision);
    const bool stale_generation_refused = ring->publish(invalid, descriptor, invalid.capacity) == grapix::FrameRingResult::StaleGeneration &&
        ring->cancel_write(invalid) == grapix::FrameRingResult::Ok;
    if (!stale_generation_refused) return 27;
    if (ring->acquire_write(&invalid) != grapix::FrameRingResult::Ok) return 28;
    fill_bytes(invalid.bytes, invalid.capacity, 2);
    fill_descriptor(&descriptor, invalid.generation, invalid.slot_index, cycles + 1, kRevision);
    const bool wrong_length_refused = ring->publish(invalid, descriptor, invalid.capacity + 1) == grapix::FrameRingResult::InvalidLength &&
        ring->cancel_write(invalid) == grapix::FrameRingResult::Ok;
    if (!wrong_length_refused) return 29;
    while (!publish_frame(ring.get(), cycles + 2, kRevision + 1, slot_visits)) SwitchToThread();
    SetEvent(phase_stale);
    if (WaitForSingleObject(done_stale, 30000) != WAIT_OBJECT_0) return 30;

    const auto before_pause_metrics = ring->metrics();
    for (std::uint32_t frame = 0; frame < kSlots; ++frame) {
        if (!publish_frame(ring.get(), cycles + 3 + frame, kRevision, slot_visits)) return 31;
    }
    std::uint64_t rejected = 0;
    for (std::uint32_t attempt = 0; attempt < 8; ++attempt) {
        grapix::FrameRingWriteLease lease;
        if (ring->acquire_write(&lease) == grapix::FrameRingResult::BackPressure) ++rejected;
        else return 32;
    }
    const auto paused_metrics = ring->metrics();
    if (rejected != 8 || paused_metrics.ready_depth != kSlots || paused_metrics.allocations_after_configure != 0) return 33;
    SetEvent(phase_two);
    if (WaitForSingleObject(done_two, 30000) != WAIT_OBJECT_0) return 34;
    WaitForSingleObject(child.hProcess, 30000);
    DWORD exit_code = 1;
    GetExitCodeProcess(child.hProcess, &exit_code);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    if (exit_code != 0) return 35;
    const auto metrics = ring->metrics();
    const bool resumed = metrics.free_depth == kSlots && metrics.ready_depth == 0;
    std::printf("cycles=%llu header_bytes=%u slot_bytes=%u slot_header_bytes=%zu payload_bytes=%zu checksum_faults=%llu overwrites=0 allocations_after_configure=%llu rejected_requests=%llu back_pressure_events=%llu total_back_pressure_events=%llu high_water_depth=%llu stale_generation_refused=%s wrong_length_refused=%s stale_revision_refused=%s resumed=%s sequence_gaps=%llu\n",
        static_cast<unsigned long long>(cycles), ring->header()->header_bytes, ring->header()->slot_bytes,
        sizeof(grapix::FrameRingSlot), ring->payload_capacity(), static_cast<unsigned long long>(metrics.checksum_faults),
        static_cast<unsigned long long>(metrics.allocations_after_configure), static_cast<unsigned long long>(rejected),
        static_cast<unsigned long long>(paused_metrics.back_pressure_events - before_pause_metrics.back_pressure_events),
        static_cast<unsigned long long>(metrics.back_pressure_events), static_cast<unsigned long long>(metrics.ready_high_water),
        stale_generation_refused ? "true" : "false", wrong_length_refused ? "true" : "false",
        metrics.consumer_stale_revision_rejects == 1 ? "true" : "false", resumed ? "true" : "false",
        static_cast<unsigned long long>(metrics.sequence_gaps));
    return (metrics.checksum_faults == 0 && resumed && metrics.consumer_stale_revision_rejects == 1) ? 0 : 36;
}

} // namespace

int wmain(int argc, wchar_t** argv)
{
    if (argc == 11 && std::wstring(argv[1]) == L"--consumer") {
        return consumer(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8], argv[9], _wcstoui64(argv[10], nullptr, 10));
    }
    if (argc == 3 && std::wstring(argv[1]) == L"--cycles") return producer(argv[0], _wcstoui64(argv[2], nullptr, 10));
    std::fputs("usage: frame_ring_harness --cycles 100000\n", stderr);
    return 2;
}
