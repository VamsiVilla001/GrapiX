#pragma once

#ifdef AE_OS_WIN
#include <windows.h>
#endif

#include <cstdint>
#include <memory>
#include <string>

namespace grapix {

constexpr std::uint32_t kRuntimeProtocolMajor = 2;
constexpr std::uint32_t kRuntimeProtocolMinor = 0;
constexpr std::uint32_t kRuntimeMaxFrameBytes = 256U * 1024U;

struct RuntimePipeRequest {
    std::string session_id;
    std::string request_id;
    std::string idempotency_key;
    std::string operation;
    std::string expected_project_digest;
    std::string payload_json;
    std::uint64_t connection_id = 0;
    std::int64_t sequence = 0;
    std::int64_t deadline_unix_ms = 0;
};

struct RuntimePipeCompletion {
    bool ok = false;
    std::string surface;
    std::string project_digest;
    std::string time_json = "null";
    std::string result_json = "null";
    std::string error_code;
    std::string error_message;
    bool retryable = false;
};

/**
 * Same-user, launch-authenticated local transport.
 *
 * The worker owns only bytes and envelopes. `take_request` is polled from AE's idle hook; therefore
 * no After Effects suite call can ever run on the pipe thread.
 */
class RuntimePipeServer {
public:
    RuntimePipeServer();
    ~RuntimePipeServer();
    RuntimePipeServer(const RuntimePipeServer &) = delete;
    RuntimePipeServer &operator=(const RuntimePipeServer &) = delete;

    /** Starts only when GRAPIX_AE_RUNTIME_SESSION_ID and GRAPIX_AE_RUNTIME_TOKEN are present. */
    bool start(const std::string &fingerprint_json, unsigned long host_pid);
    void stop();
    bool enabled() const;
    /**
     * Writes an adapter-to-client event through the same serialised pipe writer used for results.
     * `detail_json` must be one complete JSON value; event envelopes intentionally have no requestId.
     */
    bool emit_event(const std::string &event, const std::string &detail_json);
    /**
     * Hands over the next request whose deadline has not passed, retiring any that expired while they
     * waited for a callback. Polled from AE's idle hook, so no suite call runs on the pipe thread.
     */
    bool take_request(RuntimePipeRequest *out);
    /** Writes one request's reply. Called from the thread that performed the work. */
    void complete(const RuntimePipeRequest &request, RuntimePipeCompletion completion);
    /** Accepted requests still waiting for a callback, so the host can ask for a shorter sleep. */
    std::size_t pending_requests() const;
    /** Requests admitted since load, so a stall can be attributed to admission or to servicing. */
    std::uint64_t accepted_requests() const;
private:
    bool write_serialized(std::uint64_t connection_id, const std::string &json, bool is_event = false);
#ifdef AE_OS_WIN
    /// Writes every queued envelope for this connection. Only that connection's worker may call it.
    bool flush_outbound(std::uint64_t connection_id);
    void close_serialized_pipe(std::uint64_t connection_id);
#endif
    struct State;
    std::unique_ptr<State> state_;
};

} // namespace grapix
