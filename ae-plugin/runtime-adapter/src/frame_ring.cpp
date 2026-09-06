#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "frame_ring.h"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <limits>
#include <new>

namespace grapix {
namespace {
std::size_t align_up(std::size_t value, std::size_t alignment)
{
    return (value + alignment - 1U) / alignment * alignment;
}

bool multiply_checked(std::size_t left, std::size_t right, std::size_t* out)
{
    if (left != 0 && right > std::numeric_limits<std::size_t>::max() / left) return false;
    *out = left * right;
    return true;
}

bool valid_config(const FrameRingConfig& config, std::size_t* slot_bytes, std::size_t* mapped_bytes)
{
    if (config.slot_count < 2 || config.slot_count > kFrameRingMaxSlots || config.max_width == 0 ||
        config.max_height == 0 || config.max_width > std::numeric_limits<std::uint32_t>::max() / 4U ||
        config.max_stride < config.max_width * 4U) return false;
    std::size_t payload_bytes = 0;
    if (!multiply_checked(config.max_stride, config.max_height, &payload_bytes)) return false;
    *slot_bytes = align_up(sizeof(FrameRingSlot) + payload_bytes, kFrameRingAlignment);
    std::size_t slots_bytes = 0;
    if (!multiply_checked(*slot_bytes, config.slot_count, &slots_bytes) ||
        slots_bytes > std::numeric_limits<std::size_t>::max() - sizeof(FrameRingHeader)) return false;
    *mapped_bytes = sizeof(FrameRingHeader) + slots_bytes;
    return true;
}

bool valid_decimal(const char* value, std::size_t size, bool require_nonzero)
{
    std::size_t length = 0;
    while (length < size && value[length] != '\0') ++length;
    if (length == 0 || length == size) return false;
    std::size_t start = value[0] == '-' ? 1U : 0U;
    if (start == length) return false;
    bool nonzero = false;
    for (std::size_t i = start; i < length; ++i) {
        if (value[i] < '0' || value[i] > '9') return false;
        nonzero = nonzero || value[i] != '0';
    }
    return !require_nonzero || nonzero;
}

bool valid_text(const char* value, std::size_t size)
{
    for (std::size_t i = 0; i < size; ++i) {
        if (value[i] == '\0') return i != 0;
        if (static_cast<unsigned char>(value[i]) < 0x20U) return false;
    }
    return false;
}

bool valid_descriptor(const FrameRingHeader* header, const FrameRingDescriptor& descriptor,
                      std::uint64_t generation, std::uint32_t index, std::size_t byte_length)
{
    if (descriptor.ring_generation != generation || descriptor.slot_index != index ||
        descriptor.width == 0 || descriptor.height == 0 || descriptor.stride < descriptor.width * 4U ||
        descriptor.width > header->max_width || descriptor.height > header->max_height ||
        descriptor.stride > header->max_stride ||
        descriptor.color_format != static_cast<FrameRingColorFormat>(header->configured_color_format) ||
        descriptor.alpha_mode < FrameRingAlphaMode::Premultiplied || descriptor.alpha_mode > FrameRingAlphaMode::Opaque ||
        descriptor.status < FrameRingFrameStatus::Ready || descriptor.status > FrameRingFrameStatus::Missed ||
        !valid_decimal(descriptor.requested_time_value, sizeof(descriptor.requested_time_value), false) ||
        !valid_decimal(descriptor.requested_time_scale, sizeof(descriptor.requested_time_scale), true) ||
        !valid_decimal(descriptor.evaluated_time_value, sizeof(descriptor.evaluated_time_value), false) ||
        !valid_decimal(descriptor.evaluated_time_scale, sizeof(descriptor.evaluated_time_scale), true) ||
        !valid_text(descriptor.color_space, sizeof(descriptor.color_space))) return false;
    std::size_t required = 0;
    return multiply_checked(descriptor.stride, descriptor.height, &required) && required == byte_length;
}

std::uint64_t checksum(const std::uint8_t* bytes, std::size_t length)
{
    std::uint64_t value = 1469598103934665603ULL;
    for (std::size_t i = 0; i < length; ++i) {
        value ^= bytes[i];
        value *= 1099511628211ULL;
    }
    return value;
}

std::uint64_t steady_nanos()
{
    using namespace std::chrono;
    return static_cast<std::uint64_t>(duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count());
}

void increase_high_water(std::atomic<std::uint64_t>* high_water, std::uint64_t depth)
{
    std::uint64_t seen = high_water->load(std::memory_order_relaxed);
    while (seen < depth && !high_water->compare_exchange_weak(seen, depth, std::memory_order_relaxed)) {}
}

bool owner_is_gone(std::uint64_t owner_id)
{
    const HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(owner_id));
    if (process == nullptr) return GetLastError() == ERROR_INVALID_PARAMETER;
    const DWORD state = WaitForSingleObject(process, 0);
    CloseHandle(process);
    return state == WAIT_OBJECT_0;
}

} // namespace

SharedFrameRing::SharedFrameRing(void* mapping_handle, void* view, std::size_t mapped_bytes,
                                 FrameRingHeader* header, FrameRingRole role, std::uint64_t owner_id)
    : mapping_handle_(mapping_handle), view_(view), mapped_bytes_(mapped_bytes), header_(header),
      role_(role), owner_id_(owner_id)
{}

SharedFrameRing::~SharedFrameRing()
{
    if (view_ != nullptr) UnmapViewOfFile(view_);
    if (mapping_handle_ != nullptr) CloseHandle(static_cast<HANDLE>(mapping_handle_));
}

FrameRingResult SharedFrameRing::Create(const std::wstring& name, const FrameRingConfig& config,
                                        std::uint64_t producer_owner_id, std::unique_ptr<SharedFrameRing>* out)
{
    if (out == nullptr || producer_owner_id == 0) return FrameRingResult::InvalidConfiguration;
    std::size_t slot_bytes = 0;
    std::size_t mapped_bytes = 0;
    if (!valid_config(config, &slot_bytes, &mapped_bytes)) return FrameRingResult::InvalidConfiguration;
    const auto mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
        static_cast<DWORD>((static_cast<std::uint64_t>(mapped_bytes) >> 32U) & 0xffffffffU),
        static_cast<DWORD>(mapped_bytes & 0xffffffffU), name.c_str());
    if (mapping == nullptr || GetLastError() == ERROR_ALREADY_EXISTS) {
        if (mapping != nullptr) CloseHandle(mapping);
        return FrameRingResult::InvalidMapping;
    }
    void* view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, mapped_bytes);
    if (view == nullptr) {
        CloseHandle(mapping);
        return FrameRingResult::InvalidMapping;
    }
    std::memset(view, 0, mapped_bytes);
    auto* header = new (view) FrameRingHeader();
    header->magic = kFrameRingMagic;
    header->version = kFrameRingVersion;
    header->header_bytes = static_cast<std::uint32_t>(sizeof(FrameRingHeader));
    header->slot_bytes = static_cast<std::uint32_t>(slot_bytes);
    header->slot_count = config.slot_count;
    header->max_width = config.max_width;
    header->max_height = config.max_height;
    header->max_stride = config.max_stride;
    header->configured_color_format = static_cast<std::uint32_t>(config.color_format);
    header->generation.store(1, std::memory_order_relaxed);
    header->producer_owner_id.store(producer_owner_id, std::memory_order_relaxed);
    header->free_depth.store(config.slot_count, std::memory_order_relaxed);
    for (std::uint32_t index = 0; index < config.slot_count; ++index) {
        auto* slot = reinterpret_cast<FrameRingSlot*>(static_cast<std::uint8_t*>(view) + sizeof(FrameRingHeader) + index * slot_bytes);
        new (slot) FrameRingSlot();
        slot->index = index;
    }
    *out = std::unique_ptr<SharedFrameRing>(new SharedFrameRing(mapping, view, mapped_bytes, header,
                                                                  FrameRingRole::Producer, producer_owner_id));
    return FrameRingResult::Ok;
}

FrameRingResult SharedFrameRing::Open(const std::wstring& name, FrameRingRole role,
                                      std::uint64_t owner_id, std::unique_ptr<SharedFrameRing>* out)
{
    if (out == nullptr || owner_id == 0) return FrameRingResult::InvalidConfiguration;
    const auto mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name.c_str());
    if (mapping == nullptr) return FrameRingResult::InvalidMapping;
    void* view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, 0);
    if (view == nullptr) {
        CloseHandle(mapping);
        return FrameRingResult::InvalidMapping;
    }
    MEMORY_BASIC_INFORMATION info{};
    VirtualQuery(view, &info, sizeof(info));
    auto* header = static_cast<FrameRingHeader*>(view);
    const std::size_t minimum = sizeof(FrameRingHeader) + static_cast<std::size_t>(header->slot_count) * header->slot_bytes;
    if (header->magic != kFrameRingMagic || header->version != kFrameRingVersion ||
        header->header_bytes != sizeof(FrameRingHeader) || header->slot_count < 2 ||
        header->slot_count > kFrameRingMaxSlots || header->slot_bytes < sizeof(FrameRingSlot) ||
        header->slot_bytes % kFrameRingAlignment != 0 || info.RegionSize < minimum) {
        UnmapViewOfFile(view);
        CloseHandle(mapping);
        return FrameRingResult::InvalidMapping;
    }
    std::atomic<std::uint64_t>& owner = role == FrameRingRole::Producer
        ? header->producer_owner_id : header->consumer_owner_id;
    std::uint64_t expected = 0;
    if (!owner.compare_exchange_strong(expected, owner_id, std::memory_order_acq_rel) && expected != owner_id) {
        UnmapViewOfFile(view);
        CloseHandle(mapping);
        return FrameRingResult::NotOwner;
    }
    *out = std::unique_ptr<SharedFrameRing>(new SharedFrameRing(mapping, view, info.RegionSize, header, role, owner_id));
    return FrameRingResult::Ok;
}

FrameRingSlot* SharedFrameRing::slot_at(std::uint32_t index) const
{
    return reinterpret_cast<FrameRingSlot*>(static_cast<std::uint8_t*>(view_) + sizeof(FrameRingHeader) +
                                             static_cast<std::size_t>(index) * header_->slot_bytes);
}

std::uint8_t* SharedFrameRing::payload_at(FrameRingSlot* slot) const
{
    return reinterpret_cast<std::uint8_t*>(slot) + sizeof(FrameRingSlot);
}

std::size_t SharedFrameRing::payload_capacity() const
{
    return header_->slot_bytes - sizeof(FrameRingSlot);
}

bool SharedFrameRing::owns(FrameRingRole role) const
{
    const std::atomic<std::uint64_t>& owner = role == FrameRingRole::Producer
        ? header_->producer_owner_id : header_->consumer_owner_id;
    return owner.load(std::memory_order_acquire) == owner_id_;
}

FrameRingResult SharedFrameRing::acquire_write(FrameRingWriteLease* out)
{
    if (out == nullptr || role_ != FrameRingRole::Producer || !owns(FrameRingRole::Producer)) return FrameRingResult::NotOwner;
    const std::uint32_t count = header_->slot_count;
    const std::uint64_t start = header_->producer_cursor.fetch_add(1, std::memory_order_relaxed);
    for (std::uint32_t offset = 0; offset < count; ++offset) {
        const std::uint32_t index = static_cast<std::uint32_t>((start + offset) % count);
        auto* slot = slot_at(index);
        std::uint32_t expected = static_cast<std::uint32_t>(FrameRingSlotState::Free);
        if (!slot->state.compare_exchange_strong(expected, static_cast<std::uint32_t>(FrameRingSlotState::Writing),
                                                 std::memory_order_acq_rel)) continue;
        slot->producer_owner_id.store(owner_id_, std::memory_order_release);
        slot->consumer_owner_id.store(0, std::memory_order_release);
        slot->generation.store(header_->generation.load(std::memory_order_acquire), std::memory_order_release);
        slot->write_started_nanos.store(steady_nanos(), std::memory_order_release);
        header_->free_depth.fetch_sub(1, std::memory_order_relaxed);
        *out = {index, slot->generation.load(std::memory_order_acquire), payload_at(slot), payload_capacity()};
        return FrameRingResult::Ok;
    }
    header_->producer_drops.fetch_add(1, std::memory_order_relaxed);
    header_->back_pressure_events.fetch_add(1, std::memory_order_relaxed);
    return FrameRingResult::BackPressure;
}

FrameRingResult SharedFrameRing::publish(const FrameRingWriteLease& lease, const FrameRingDescriptor& descriptor,
                                         std::size_t byte_length)
{
    if (role_ != FrameRingRole::Producer || !owns(FrameRingRole::Producer) || lease.slot_index >= header_->slot_count) return FrameRingResult::NotOwner;
    auto* slot = slot_at(lease.slot_index);
    if (slot->state.load(std::memory_order_acquire) != static_cast<std::uint32_t>(FrameRingSlotState::Writing) ||
        slot->producer_owner_id.load(std::memory_order_acquire) != owner_id_) return FrameRingResult::NotOwner;
    const std::uint64_t generation = header_->generation.load(std::memory_order_acquire);
    if (lease.generation != generation || slot->generation.load(std::memory_order_acquire) != generation ||
        descriptor.ring_generation != generation) return FrameRingResult::StaleGeneration;
    if (byte_length > lease.capacity) return FrameRingResult::InvalidLength;
    if (!valid_descriptor(header_, descriptor, generation, lease.slot_index, byte_length)) return FrameRingResult::InvalidDescriptor;
    slot->descriptor = descriptor;
    slot->byte_length.store(byte_length, std::memory_order_relaxed);
    slot->checksum.store(checksum(lease.bytes, byte_length), std::memory_order_relaxed);
    slot->publish_sequence.store(header_->produced_sequence.fetch_add(1, std::memory_order_relaxed) + 1,
                                 std::memory_order_release);
    slot->state.store(static_cast<std::uint32_t>(FrameRingSlotState::Ready), std::memory_order_release);
    const std::uint64_t depth = header_->ready_depth.fetch_add(1, std::memory_order_relaxed) + 1;
    increase_high_water(&header_->ready_high_water, depth);
    return FrameRingResult::Ok;
}

FrameRingResult SharedFrameRing::cancel_write(const FrameRingWriteLease& lease)
{
    if (role_ != FrameRingRole::Producer || lease.slot_index >= header_->slot_count) return FrameRingResult::NotOwner;
    auto* slot = slot_at(lease.slot_index);
    if (slot->producer_owner_id.load(std::memory_order_acquire) != owner_id_) return FrameRingResult::NotOwner;
    std::uint32_t expected = static_cast<std::uint32_t>(FrameRingSlotState::Writing);
    if (!slot->state.compare_exchange_strong(expected, static_cast<std::uint32_t>(FrameRingSlotState::Free), std::memory_order_release)) return FrameRingResult::NotReady;
    header_->free_depth.fetch_add(1, std::memory_order_relaxed);
    return FrameRingResult::Ok;
}

FrameRingResult SharedFrameRing::acquire_read(std::uint64_t expected_revision, FrameRingReadLease* out)
{
    if (out == nullptr || role_ != FrameRingRole::Consumer || !owns(FrameRingRole::Consumer)) return FrameRingResult::NotOwner;
    std::uint32_t candidate = header_->slot_count;
    std::uint64_t candidate_sequence = std::numeric_limits<std::uint64_t>::max();
    for (std::uint32_t index = 0; index < header_->slot_count; ++index) {
        auto* possible = slot_at(index);
        if (possible->state.load(std::memory_order_acquire) != static_cast<std::uint32_t>(FrameRingSlotState::Ready)) continue;
        const std::uint64_t sequence = possible->publish_sequence.load(std::memory_order_acquire);
        if (sequence < candidate_sequence) { candidate = index; candidate_sequence = sequence; }
    }
    if (candidate == header_->slot_count) return FrameRingResult::NotReady;
    auto* slot = slot_at(candidate);
    std::uint32_t expected = static_cast<std::uint32_t>(FrameRingSlotState::Ready);
    if (!slot->state.compare_exchange_strong(expected, static_cast<std::uint32_t>(FrameRingSlotState::Reading),
                                             std::memory_order_acq_rel)) return FrameRingResult::NotReady;
        header_->ready_depth.fetch_sub(1, std::memory_order_relaxed);
        slot->consumer_owner_id.store(owner_id_, std::memory_order_release);
        const std::uint64_t generation = header_->generation.load(std::memory_order_acquire);
        const bool stale_generation = slot->generation.load(std::memory_order_acquire) != generation ||
            slot->descriptor.ring_generation != generation;
        const bool stale_revision = slot->descriptor.data_revision != expected_revision;
        const std::size_t length = static_cast<std::size_t>(slot->byte_length.load(std::memory_order_acquire));
        const bool checksum_matches = length <= payload_capacity() &&
            slot->checksum.load(std::memory_order_acquire) == checksum(payload_at(slot), length);
        if (stale_generation || stale_revision || !checksum_matches) {
            if (stale_generation) header_->consumer_stale_generation_rejects.fetch_add(1, std::memory_order_relaxed);
            if (stale_revision) header_->consumer_stale_revision_rejects.fetch_add(1, std::memory_order_relaxed);
            if (!checksum_matches) header_->checksum_faults.fetch_add(1, std::memory_order_relaxed);
            slot->consumer_owner_id.store(0, std::memory_order_release);
            slot->state.store(static_cast<std::uint32_t>(FrameRingSlotState::Free), std::memory_order_release);
            header_->free_depth.fetch_add(1, std::memory_order_relaxed);
            return stale_generation ? FrameRingResult::StaleGeneration : stale_revision ? FrameRingResult::StaleRevision : FrameRingResult::ChecksumFault;
        }
        const std::uint64_t sequence = slot->publish_sequence.load(std::memory_order_acquire);
        const std::uint64_t prior = header_->consumed_sequence.exchange(sequence, std::memory_order_relaxed);
        if (prior != 0 && sequence != prior + 1) header_->sequence_gaps.fetch_add(1, std::memory_order_relaxed);
        *out = {candidate, generation, payload_at(slot), length, &slot->descriptor};
        return FrameRingResult::Ok;
}

FrameRingResult SharedFrameRing::release_read(const FrameRingReadLease& lease)
{
    if (role_ != FrameRingRole::Consumer || lease.slot_index >= header_->slot_count || !owns(FrameRingRole::Consumer)) return FrameRingResult::NotOwner;
    auto* slot = slot_at(lease.slot_index);
    if (slot->consumer_owner_id.load(std::memory_order_acquire) != owner_id_) return FrameRingResult::NotOwner;
    std::uint32_t expected = static_cast<std::uint32_t>(FrameRingSlotState::Reading);
    if (!slot->state.compare_exchange_strong(expected, static_cast<std::uint32_t>(FrameRingSlotState::Free), std::memory_order_release)) return FrameRingResult::NotReady;
    const std::uint64_t start = slot->write_started_nanos.load(std::memory_order_acquire);
    if (start != 0) header_->lease_duration_nanos.fetch_add(steady_nanos() - start, std::memory_order_relaxed);
    slot->consumer_owner_id.store(0, std::memory_order_release);
    header_->free_depth.fetch_add(1, std::memory_order_relaxed);
    return FrameRingResult::Ok;
}

FrameRingResult SharedFrameRing::reconfigure_format(FrameRingColorFormat color_format)
{
    if (role_ != FrameRingRole::Producer || !owns(FrameRingRole::Producer)) return FrameRingResult::NotOwner;
    if (header_->ready_depth.load(std::memory_order_acquire) != 0) return FrameRingResult::FormatChangePending;
    for (std::uint32_t index = 0; index < header_->slot_count; ++index) {
        if (slot_at(index)->state.load(std::memory_order_acquire) != static_cast<std::uint32_t>(FrameRingSlotState::Free)) return FrameRingResult::FormatChangePending;
    }
    header_->configured_color_format = static_cast<std::uint32_t>(color_format);
    return FrameRingResult::Ok;
}

FrameRingResult SharedFrameRing::invalidate_if_peer_gone(std::uint64_t peer_owner_id)
{
    if (peer_owner_id == 0 || !owner_is_gone(peer_owner_id)) return FrameRingResult::PeerStillAlive;
    header_->generation.fetch_add(1, std::memory_order_acq_rel);
    std::uint64_t free_depth = 0;
    std::uint64_t ready_depth = 0;
    for (std::uint32_t index = 0; index < header_->slot_count; ++index) {
        auto* slot = slot_at(index);
        const auto state = static_cast<FrameRingSlotState>(slot->state.load(std::memory_order_acquire));
        if (state != FrameRingSlotState::Free &&
            (slot->producer_owner_id.load(std::memory_order_acquire) == peer_owner_id ||
             slot->consumer_owner_id.load(std::memory_order_acquire) == peer_owner_id)) {
            slot->state.store(static_cast<std::uint32_t>(FrameRingSlotState::Free), std::memory_order_release);
            ++free_depth;
        } else if (state == FrameRingSlotState::Free) {
            ++free_depth;
        } else if (state == FrameRingSlotState::Ready) {
            ++ready_depth;
        }
    }
    header_->free_depth.store(free_depth, std::memory_order_release);
    header_->ready_depth.store(ready_depth, std::memory_order_release);
    return FrameRingResult::Ok;
}

FrameRingMetrics SharedFrameRing::metrics() const
{
    return {
        header_->free_depth.load(std::memory_order_relaxed),
        header_->ready_depth.load(std::memory_order_relaxed),
        header_->ready_high_water.load(std::memory_order_relaxed),
        header_->producer_drops.load(std::memory_order_relaxed),
        header_->back_pressure_events.load(std::memory_order_relaxed),
        header_->consumer_stale_generation_rejects.load(std::memory_order_relaxed),
        header_->consumer_stale_revision_rejects.load(std::memory_order_relaxed),
        header_->checksum_faults.load(std::memory_order_relaxed),
        header_->lease_duration_nanos.load(std::memory_order_relaxed),
        header_->sequence_gaps.load(std::memory_order_relaxed),
        header_->allocations_after_configure.load(std::memory_order_relaxed),
    };
}

} // namespace grapix
