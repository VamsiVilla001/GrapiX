#pragma once

// Adapter-owned, fixed-capacity frame transport. This is deliberately independent
// from runtime_pipe: only descriptors and a mapped payload slab cross this boundary.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace grapix {

constexpr std::uint32_t kFrameRingMagic = 0x47584652; // "GXFR"
constexpr std::uint32_t kFrameRingVersion = 1;
constexpr std::uint32_t kFrameRingAlignment = 64;
constexpr std::uint32_t kFrameRingMaxSlots = 64;

enum class FrameRingColorFormat : std::uint32_t { Bgra8 = 1, Rgba8 = 2, Argb8 = 3 };
enum class FrameRingAlphaMode : std::uint32_t { Premultiplied = 1, Straight = 2, Opaque = 3 };
enum class FrameRingFrameStatus : std::uint32_t { Ready = 1, Late = 2, Missed = 3 };
enum class FrameRingSlotState : std::uint32_t { Free = 0, Writing = 1, Ready = 2, Reading = 3 };
enum class FrameRingResult : std::uint32_t {
    Ok = 0,
    BackPressure,
    InvalidConfiguration,
    InvalidMapping,
    InvalidLength,
    InvalidDescriptor,
    StaleGeneration,
    StaleRevision,
    ChecksumFault,
    NotOwner,
    NotReady,
    PeerStillAlive,
    FormatChangePending,
};

struct FrameRingConfig {
    std::uint32_t slot_count = 0;
    std::uint32_t max_width = 0;
    std::uint32_t max_height = 0;
    std::uint32_t max_stride = 0;
    FrameRingColorFormat color_format = FrameRingColorFormat::Bgra8;
};

// The fixed-size native representation of the wire AeFrameDescriptor. Decimal
// strings preserve exact AE time without putting pixels in any protocol message.
struct FrameRingDescriptor {
    std::uint64_t ring_generation = 0;
    std::uint32_t slot_index = 0;
    std::uint64_t frame_id = 0;
    std::uint64_t data_revision = 0;
    std::int64_t composition_item_id = 0;
    char requested_time_value[32]{};
    char requested_time_scale[32]{};
    char evaluated_time_value[32]{};
    char evaluated_time_scale[32]{};
    std::uint64_t presentation_deadline_nanos = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t stride = 0;
    FrameRingColorFormat color_format = FrameRingColorFormat::Bgra8;
    FrameRingAlphaMode alpha_mode = FrameRingAlphaMode::Premultiplied;
    char color_space[32]{};
    FrameRingFrameStatus status = FrameRingFrameStatus::Ready;
};

// Header and slots are the exact shared-memory layout. All atomics are aligned
// and each slot begins on a cache-line boundary; payload immediately follows its
// slot header at offset sizeof(FrameRingSlot), then padding to slot_bytes.
struct alignas(kFrameRingAlignment) FrameRingHeader {
    std::uint32_t magic = kFrameRingMagic;
    std::uint32_t version = kFrameRingVersion;
    std::uint32_t header_bytes = 0;
    std::uint32_t slot_bytes = 0;
    std::uint32_t slot_count = 0;
    std::uint32_t max_width = 0;
    std::uint32_t max_height = 0;
    std::uint32_t max_stride = 0;
    std::uint32_t configured_color_format = 0;
    std::uint32_t reserved = 0;
    std::atomic<std::uint64_t> generation{1};
    std::atomic<std::uint64_t> producer_owner_id{0};
    std::atomic<std::uint64_t> consumer_owner_id{0};
    std::atomic<std::uint64_t> producer_cursor{0};
    std::atomic<std::uint64_t> produced_sequence{0};
    std::atomic<std::uint64_t> consumed_sequence{0};
    std::atomic<std::uint64_t> free_depth{0};
    std::atomic<std::uint64_t> ready_depth{0};
    std::atomic<std::uint64_t> ready_high_water{0};
    std::atomic<std::uint64_t> producer_drops{0};
    std::atomic<std::uint64_t> back_pressure_events{0};
    std::atomic<std::uint64_t> consumer_stale_generation_rejects{0};
    std::atomic<std::uint64_t> consumer_stale_revision_rejects{0};
    std::atomic<std::uint64_t> checksum_faults{0};
    std::atomic<std::uint64_t> lease_duration_nanos{0};
    std::atomic<std::uint64_t> sequence_gaps{0};
    std::atomic<std::uint64_t> allocations_after_configure{0};
};

struct alignas(kFrameRingAlignment) FrameRingSlot {
    std::atomic<std::uint32_t> state{static_cast<std::uint32_t>(FrameRingSlotState::Free)};
    std::uint32_t index = 0;
    std::atomic<std::uint64_t> generation{0};
    std::atomic<std::uint64_t> producer_owner_id{0};
    std::atomic<std::uint64_t> consumer_owner_id{0};
    std::atomic<std::uint64_t> write_started_nanos{0};
    std::atomic<std::uint64_t> checksum{0};
    std::atomic<std::uint64_t> byte_length{0};
    std::atomic<std::uint64_t> publish_sequence{0};
    FrameRingDescriptor descriptor{};
};

static_assert(sizeof(FrameRingHeader) % kFrameRingAlignment == 0, "header must be cache-line aligned");
static_assert(sizeof(FrameRingSlot) % kFrameRingAlignment == 0, "slot must be cache-line aligned");

struct FrameRingMetrics {
    std::uint64_t free_depth = 0;
    std::uint64_t ready_depth = 0;
    std::uint64_t ready_high_water = 0;
    std::uint64_t producer_drops = 0;
    std::uint64_t back_pressure_events = 0;
    std::uint64_t consumer_stale_generation_rejects = 0;
    std::uint64_t consumer_stale_revision_rejects = 0;
    std::uint64_t checksum_faults = 0;
    std::uint64_t lease_duration_nanos = 0;
    std::uint64_t sequence_gaps = 0;
    std::uint64_t allocations_after_configure = 0;
};

struct FrameRingWriteLease {
    std::uint32_t slot_index = 0;
    std::uint64_t generation = 0;
    std::uint8_t* bytes = nullptr;
    std::size_t capacity = 0;
};

struct FrameRingReadLease {
    std::uint32_t slot_index = 0;
    std::uint64_t generation = 0;
    const std::uint8_t* bytes = nullptr;
    std::size_t byte_length = 0;
    const FrameRingDescriptor* descriptor = nullptr;
};

enum class FrameRingRole { Producer, Consumer };

class SharedFrameRing {
public:
    ~SharedFrameRing();
    SharedFrameRing(const SharedFrameRing&) = delete;
    SharedFrameRing& operator=(const SharedFrameRing&) = delete;

    static FrameRingResult Create(const std::wstring& name, const FrameRingConfig& config,
                                  std::uint64_t producer_owner_id, std::unique_ptr<SharedFrameRing>* out);
    static FrameRingResult Open(const std::wstring& name, FrameRingRole role,
                                std::uint64_t owner_id, std::unique_ptr<SharedFrameRing>* out);

    FrameRingResult acquire_write(FrameRingWriteLease* out);
    FrameRingResult publish(const FrameRingWriteLease& lease, const FrameRingDescriptor& descriptor,
                            std::size_t byte_length);
    FrameRingResult cancel_write(const FrameRingWriteLease& lease);
    FrameRingResult acquire_read(std::uint64_t expected_revision, FrameRingReadLease* out);
    FrameRingResult release_read(const FrameRingReadLease& lease);
    FrameRingResult reconfigure_format(FrameRingColorFormat color_format);
    FrameRingResult invalidate_if_peer_gone(std::uint64_t peer_owner_id);

    FrameRingMetrics metrics() const;
    const FrameRingHeader* header() const { return header_; }
    std::size_t payload_capacity() const;

private:
    SharedFrameRing(void* mapping_handle, void* view, std::size_t mapped_bytes,
                    FrameRingHeader* header, FrameRingRole role, std::uint64_t owner_id);
    FrameRingSlot* slot_at(std::uint32_t index) const;
    std::uint8_t* payload_at(FrameRingSlot* slot) const;
    bool owns(FrameRingRole role) const;

    void* mapping_handle_ = nullptr;
    void* view_ = nullptr;
    std::size_t mapped_bytes_ = 0;
    FrameRingHeader* header_ = nullptr;
    FrameRingRole role_ = FrameRingRole::Producer;
    std::uint64_t owner_id_ = 0;
};

} // namespace grapix
