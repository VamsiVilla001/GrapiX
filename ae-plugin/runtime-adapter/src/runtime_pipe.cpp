#include "AEConfig.h"
#include "runtime_pipe.h"

#ifdef AE_OS_WIN
#include <sddl.h>
#include <windows.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_set>
#include <unordered_map>
#include <utility>
#include <vector>

namespace grapix {
namespace {

std::string json_escape(const std::string &value)
{
    std::string out;
    out.reserve(value.size() + 8);
    for (unsigned char character : value) {
        switch (character) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (character < 0x20) {
                    char escaped[7];
                    sprintf_s(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(character));
                    out += escaped;
                } else {
                    out.push_back(static_cast<char>(character));
                }
        }
    }
    return out;
}

class JsonReader {
public:
    explicit JsonReader(const std::string &text) : text_(text) {}

    bool object_field_string(const char *wanted, std::string *out) const
    {
        std::size_t value = 0;
        if (!find_top_level_field(wanted, &value) || value >= text_.size() || text_[value] != '"') return false;
        return parse_string(value, out, nullptr);
    }

    bool object_field_integer(const char *wanted, std::int64_t *out) const
    {
        std::size_t value = 0;
        if (!find_top_level_field(wanted, &value)) return false;
        bool negative = false;
        if (value < text_.size() && text_[value] == '-') { negative = true; ++value; }
        if (value >= text_.size() || !std::isdigit(static_cast<unsigned char>(text_[value]))) return false;
        std::int64_t result = 0;
        while (value < text_.size() && std::isdigit(static_cast<unsigned char>(text_[value]))) {
            const int digit = text_[value++] - '0';
            if (result > (INT64_MAX - digit) / 10) return false;
            result = result * 10 + digit;
        }
        *out = negative ? -result : result;
        return true;
    }

    bool object_field_nullable_string(const char *wanted, std::string *out) const
    {
        std::size_t value = 0;
        if (!find_top_level_field(wanted, &value)) return false;
        if (text_.compare(value, 4, "null") == 0) { out->clear(); return true; }
        return value < text_.size() && text_[value] == '"' && parse_string(value, out, nullptr);
    }

    bool object_field_raw(const char *wanted, std::string *out) const
    {
        std::size_t value = 0;
        if (!find_top_level_field(wanted, &value)) return false;
        std::size_t end = 0;
        if (!skip_value(value, &end)) return false;
        *out = text_.substr(value, end - value);
        return true;
    }

    bool object_field_string_array(const char *wanted, std::vector<std::string> *out) const
    {
        std::size_t position = 0;
        if (!find_top_level_field(wanted, &position) || position >= text_.size() || text_[position] != '[') return false;
        ++position;
        out->clear();
        while (true) {
            skip_space(&position);
            if (position >= text_.size()) return false;
            if (text_[position] == ']') return true;
            std::string value;
            std::size_t end = 0;
            if (!parse_string(position, &value, &end)) return false;
            out->push_back(std::move(value));
            position = end;
            skip_space(&position);
            if (position >= text_.size()) return false;
            if (text_[position] == ']') return true;
            if (text_[position] != ',') return false;
            ++position;
        }
    }

private:
    void skip_space(std::size_t *position) const
    {
        while (*position < text_.size() && std::isspace(static_cast<unsigned char>(text_[*position]))) ++*position;
    }

    bool parse_string(std::size_t position, std::string *out, std::size_t *end) const
    {
        if (position >= text_.size() || text_[position] != '"') return false;
        ++position;
        out->clear();
        while (position < text_.size()) {
            const char character = text_[position++];
            if (character == '"') {
                if (end != nullptr) *end = position;
                return true;
            }
            if (character != '\\') {
                if (static_cast<unsigned char>(character) < 0x20) return false;
                out->push_back(character);
                continue;
            }
            if (position >= text_.size()) return false;
            const char escaped = text_[position++];
            switch (escaped) {
                case '"': out->push_back('"'); break;
                case '\\': out->push_back('\\'); break;
                case '/': out->push_back('/'); break;
                case 'b': out->push_back('\b'); break;
                case 'f': out->push_back('\f'); break;
                case 'n': out->push_back('\n'); break;
                case 'r': out->push_back('\r'); break;
                case 't': out->push_back('\t'); break;
                default: return false; // Protocol identifiers and tokens are ASCII; reject ambiguous escapes.
            }
        }
        return false;
    }

    bool skip_value(std::size_t position, std::size_t *end) const
    {
        skip_space(&position);
        if (position >= text_.size()) return false;
        if (text_[position] == '"') {
            std::string ignored;
            return parse_string(position, &ignored, end);
        }
        if (text_[position] == '{' || text_[position] == '[') {
            const char open = text_[position];
            const char close = open == '{' ? '}' : ']';
            int depth = 0;
            bool in_string = false;
            bool escaped = false;
            for (; position < text_.size(); ++position) {
                const char character = text_[position];
                if (in_string) {
                    if (escaped) escaped = false;
                    else if (character == '\\') escaped = true;
                    else if (character == '"') in_string = false;
                    continue;
                }
                if (character == '"') { in_string = true; continue; }
                if (character == open) ++depth;
                else if (character == close && --depth == 0) { *end = position + 1; return true; }
            }
            return false;
        }
        while (position < text_.size() && text_[position] != ',' && text_[position] != '}' && text_[position] != ']') ++position;
        *end = position;
        return true;
    }

    bool find_top_level_field(const char *wanted, std::size_t *value_position) const
    {
        std::size_t position = 0;
        skip_space(&position);
        if (position >= text_.size() || text_[position++] != '{') return false;
        while (true) {
            skip_space(&position);
            if (position >= text_.size() || text_[position] == '}') return false;
            std::string key;
            std::size_t after_key = 0;
            if (!parse_string(position, &key, &after_key)) return false;
            position = after_key;
            skip_space(&position);
            if (position >= text_.size() || text_[position++] != ':') return false;
            skip_space(&position);
            if (key == wanted) { *value_position = position; return true; }
            std::size_t after_value = 0;
            if (!skip_value(position, &after_value)) return false;
            position = after_value;
            skip_space(&position);
            if (position >= text_.size() || text_[position] == '}') return false;
            if (text_[position++] != ',') return false;
        }
    }

    const std::string &text_;
};

std::int64_t unix_time_ms()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

bool safe_session_id(const std::string &value)
{
    if (value.empty() || value.size() > 64) return false;
    for (unsigned char character : value) {
        if (!std::isalnum(character) && character != '-') return false;
    }
    return true;
}

#ifdef AE_OS_WIN
bool read_exact(HANDLE pipe, void *buffer, DWORD size)
{
    auto *bytes = static_cast<unsigned char *>(buffer);
    DWORD completed = 0;
    while (completed < size) {
        DWORD read = 0;
        if (!ReadFile(pipe, bytes + completed, size - completed, &read, nullptr) || read == 0) return false;
        completed += read;
    }
    return true;
}

bool write_exact(HANDLE pipe, const void *buffer, DWORD size)
{
    const auto *bytes = static_cast<const unsigned char *>(buffer);
    DWORD completed = 0;
    while (completed < size) {
        DWORD written = 0;
        if (!WriteFile(pipe, bytes + completed, size - completed, &written, nullptr) || written == 0) return false;
        completed += written;
    }
    return true;
}

bool read_frame(HANDLE pipe, std::string *json, std::string *code)
{
    unsigned char prefix[4] = {0, 0, 0, 0};
    if (!read_exact(pipe, prefix, sizeof(prefix))) return false;
    const std::uint32_t size = (static_cast<std::uint32_t>(prefix[0]) << 24U) |
                               (static_cast<std::uint32_t>(prefix[1]) << 16U) |
                               (static_cast<std::uint32_t>(prefix[2]) << 8U) |
                               static_cast<std::uint32_t>(prefix[3]);
    if (size == 0 || size > kRuntimeMaxFrameBytes) {
        *code = size > kRuntimeMaxFrameBytes ? "FRAME_TOO_LARGE" : "MALFORMED_FRAME";
        return false;
    }
    json->resize(size);
    if (!read_exact(pipe, json->data(), size)) return false;
    return true;
}

bool write_frame(HANDLE pipe, const std::string &json)
{
    if (json.empty() || json.size() > kRuntimeMaxFrameBytes) return false;
    const auto size = static_cast<std::uint32_t>(json.size());
    unsigned char prefix[4] = {
        static_cast<unsigned char>((size >> 24U) & 0xffU),
        static_cast<unsigned char>((size >> 16U) & 0xffU),
        static_cast<unsigned char>((size >> 8U) & 0xffU),
        static_cast<unsigned char>(size & 0xffU)
    };
    return write_exact(pipe, prefix, sizeof(prefix)) && write_exact(pipe, json.data(), size);
}

/// Poll for one complete frame without ever blocking on a partial one.
///
/// Returns 1 when `json` holds a frame, 0 when the client has not sent one yet, -1 on a broken or
/// malformed connection.
///
/// This exists because the pipe handle is **synchronous**, and Windows serialises I/O on a synchronous
/// file object: a thread parked in `ReadFile` blocks a `WriteFile` another thread issues on the same
/// handle. That is how a reply written from AE's idle hook froze the host — the write queued behind a
/// read that could only finish once the client saw that reply. So exactly one thread performs pipe I/O,
/// and it must never park in a read while replies are waiting to go out.
///
/// `PeekNamedPipe` is what makes that possible: it reports how many bytes are queued without consuming
/// them, so the length prefix is inspected first and the payload is only read once all of it has
/// arrived. Every `ReadFile` below is therefore already satisfiable.
int poll_frame(HANDLE pipe, std::string *json, std::string *code)
{
    unsigned char prefix[4] = {0, 0, 0, 0};
    DWORD peeked = 0;
    DWORD available = 0;
    DWORD remaining = 0;
    if (!PeekNamedPipe(pipe, prefix, sizeof(prefix), &peeked, &available, &remaining)) return -1;
    if (peeked < sizeof(prefix)) return 0;

    const std::uint32_t size = (static_cast<std::uint32_t>(prefix[0]) << 24U) |
                               (static_cast<std::uint32_t>(prefix[1]) << 16U) |
                               (static_cast<std::uint32_t>(prefix[2]) << 8U) |
                               static_cast<std::uint32_t>(prefix[3]);
    if (size == 0 || size > kRuntimeMaxFrameBytes) {
        *code = size > kRuntimeMaxFrameBytes ? "FRAME_TOO_LARGE" : "MALFORMED_FRAME";
        return -1;
    }
    if (available < sizeof(prefix) + size) return 0;

    if (!read_exact(pipe, prefix, sizeof(prefix))) return -1;
    json->resize(size);
    if (!read_exact(pipe, json->data(), size)) return -1;
    return 1;
}
#endif

std::string protocol_error(const std::string &session_id, const std::string &request_id,
                           std::int64_t sequence, const std::string &operation,
                           const std::string &code, const std::string &message, bool retryable = false)
{
    return "{\"kind\":\"result\",\"protocolMajor\":" + std::to_string(kRuntimeProtocolMajor) + ",\"protocolMinor\":" + std::to_string(kRuntimeProtocolMinor) + ",\"sessionId\":\"" +
        json_escape(session_id) + "\",\"requestId\":\"" + json_escape(request_id) +
        "\",\"sequence\":" + std::to_string(sequence) + ",\"operation\":\"" +
        json_escape(operation) + "\",\"ok\":false,\"surface\":null,\"projectDigest\":null,"
        "\"time\":null,\"error\":{\"code\":\"" + json_escape(code) +
        "\",\"message\":\"" + json_escape(message) + "\",\"retryable\":" +
        (retryable ? "true" : "false") + "}}";
}

/// One request's reply envelope. Shared by the reader's refusals and the idle hook's completions,
/// because a reply written from two places must not be two subtly different shapes.
std::string result_envelope(const std::string &session_id, const RuntimePipeRequest &request,
                            const RuntimePipeCompletion &completion)
{
    std::string response = "{\"kind\":\"result\",\"protocolMajor\":" +
        std::to_string(kRuntimeProtocolMajor) + ",\"protocolMinor\":" +
        std::to_string(kRuntimeProtocolMinor) + ",\"sessionId\":\"" + json_escape(session_id) +
        "\",\"requestId\":\"" + json_escape(request.request_id) + "\",\"sequence\":" +
        std::to_string(request.sequence) + ",\"operation\":\"" + json_escape(request.operation) +
        "\",\"ok\":" + (completion.ok ? "true" : "false") +
        ",\"surface\":" + (completion.surface.empty() ? "null" : "\"" + json_escape(completion.surface) + "\"") +
        ",\"projectDigest\":" + (completion.project_digest.empty() ? "null" : "\"" + json_escape(completion.project_digest) + "\"") +
        ",\"time\":" + completion.time_json;
    if (completion.ok) return response + ",\"result\":" + completion.result_json + "}";
    return response + ",\"error\":{\"code\":\"" + json_escape(completion.error_code) +
        "\",\"message\":\"" + json_escape(completion.error_message) + "\",\"retryable\":" +
        (completion.retryable ? "true" : "false") + "}}";
}

/// How many accepted requests may wait for the idle hook at once.
/// Simultaneous clients: the supervisor, render engine, and two diagnostic/control clients.
constexpr std::size_t kRuntimePipeMaxInstances = 4;
constexpr std::size_t kMaxOutboundEnvelopes = 256;
constexpr std::size_t kMaxAcceptedIdempotencyKeys = 4096;
///
/// The queue exists so a client can pipeline. Before it, the reader waited for each completion before
/// reading the next frame, so the protocol could never exceed one operation per AE idle callback no
/// matter how many the client sent. It is bounded because a client that outruns After Effects must be
/// told so rather than allowed to grow the adapter's memory: a 1080p render is tens of milliseconds,
/// and a caller queueing thousands of frames has already lost the race it is trying to win.
constexpr std::size_t kMaxPendingRequests = 64;

} // namespace

struct RuntimePipeServer::State {
    std::string session_id;
    std::string token;
    std::string fingerprint_json;
    unsigned long host_pid = 0;
#ifdef AE_OS_WIN
    std::wstring pipe_name;
    struct Connection {
        std::uint64_t id = 0;
        HANDLE pipe = INVALID_HANDLE_VALUE;
        std::mutex writer_mutex;
        struct OutboundEnvelope {
            std::string json;
            bool is_event = false;
        };
        std::deque<OutboundEnvelope> outbound;
        std::uint64_t next_event_sequence = 1;
        std::atomic<bool> closing{false};
    };
    std::mutex connections_mutex;
    std::unordered_map<std::uint64_t, std::shared_ptr<Connection>> connections;
    std::vector<std::thread> connection_workers;
    std::unordered_map<std::string, std::uint64_t> render_request_connections;
    std::uint64_t next_connection_id = 1;
#endif
    std::atomic<bool> stopping{false};
    std::atomic<bool> running{false};
    std::thread worker;
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<RuntimePipeRequest> requests;
    /// Requests admitted to the queue since load. Paired with the host's serviced count this answers
    /// the only question that matters when an operation stalls: was it never accepted, or accepted and
    /// never run?
    std::uint64_t accepted_total = 0;
    std::atomic<bool> runtime_ready_emitted{false};
    std::atomic<bool> runtime_degraded_emitted{false};
    std::unordered_set<std::string> accepted_idempotency_keys;
    std::deque<std::string> accepted_idempotency_key_order;
};

#ifdef AE_OS_WIN
std::string utc_timestamp()
{
    SYSTEMTIME now = {};
    GetSystemTime(&now);
    char timestamp[32] = {};
    sprintf_s(timestamp, sizeof(timestamp), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
              static_cast<unsigned>(now.wYear), static_cast<unsigned>(now.wMonth),
              static_cast<unsigned>(now.wDay), static_cast<unsigned>(now.wHour),
              static_cast<unsigned>(now.wMinute), static_cast<unsigned>(now.wSecond),
              static_cast<unsigned>(now.wMilliseconds));
    return timestamp;
}

#endif

RuntimePipeServer::RuntimePipeServer() : state_(new State()) {}
RuntimePipeServer::~RuntimePipeServer() { stop(); }

bool RuntimePipeServer::start(const std::string &fingerprint_json, unsigned long host_pid)
{
#ifndef AE_OS_WIN
    (void)fingerprint_json;
    (void)host_pid;
    return false;
#else
    if (state_->running.load()) return true;
    char session[129] = {0};
    char token[257] = {0};
    const DWORD session_size = GetEnvironmentVariableA("GRAPIX_AE_RUNTIME_SESSION_ID", session, sizeof(session));
    const DWORD token_size = GetEnvironmentVariableA("GRAPIX_AE_RUNTIME_TOKEN", token, sizeof(token));
    if (session_size == 0 || session_size >= sizeof(session) || token_size < 32 || token_size >= sizeof(token)) return false;
    state_->session_id.assign(session, session_size);
    state_->token.assign(token, token_size);
    SecureZeroMemory(token, sizeof(token));
    if (!safe_session_id(state_->session_id)) return false;
    state_->fingerprint_json = fingerprint_json;
    state_->host_pid = host_pid;
    const std::string pipe_utf8 = "\\\\.\\pipe\\grapix-ae-runtime-" + state_->session_id;
    state_->pipe_name.assign(pipe_utf8.begin(), pipe_utf8.end());
    state_->stopping.store(false);
    state_->running.store(true);

    state_->worker = std::thread([this, state = state_.get()]() {
        while (!state->stopping.load()) {
            PSECURITY_DESCRIPTOR descriptor = nullptr;
            // Protected DACL: only the owner of the After Effects process receives full access.
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    L"D:P(A;;GA;;;OW)", SDDL_REVISION_1, &descriptor, nullptr)) break;
            SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
            HANDLE pipe = CreateNamedPipeW(
                state->pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                static_cast<DWORD>(kRuntimePipeMaxInstances),
                kRuntimeMaxFrameBytes + 4, kRuntimeMaxFrameBytes + 4, 0, &security);
            LocalFree(descriptor);
            if (pipe == INVALID_HANDLE_VALUE) break;
            const BOOL connected = ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED;
            if (!connected || state->stopping.load()) { CloseHandle(pipe); continue; }

            const auto connection = std::make_shared<State::Connection>();
            {
                std::lock_guard<std::mutex> lock(state->connections_mutex);
                connection->id = state->next_connection_id++;
                connection->pipe = pipe;
                state->connections.emplace(connection->id, connection);
                state->connection_workers.emplace_back([this, state, connection]() {
                    const std::uint64_t connection_id = connection->id;
                    const auto reject = [this, state, connection_id](const std::string &request_id,
                                                                      std::int64_t sequence,
                                                                      const std::string &operation,
                                                                      const std::string &code,
                                                                      const std::string &message,
                                                                      bool retryable = false) {
                        write_serialized(connection_id, protocol_error(state->session_id, request_id, sequence,
                                                                         operation, code, message, retryable));
                        flush_outbound(connection_id);
                    };

                    std::string hello_json;
                    std::string frame_error;
                    while (!state->stopping.load() && !connection->closing.load()) {
                        const int framed = poll_frame(connection->pipe, &hello_json, &frame_error);
                        if (framed < 0) { connection->closing.store(true); break; }
                        if (framed == 1) break;
                        std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    }
                    if (!connection->closing.load() && !state->stopping.load()) {
                        JsonReader hello(hello_json);
                        std::string kind, session_id, token;
                        std::int64_t major = 0, minor = 0;
                        std::vector<std::string> capabilities;
                        if (!hello.object_field_string("kind", &kind) || kind != "hello" ||
                            !hello.object_field_integer("protocolMajor", &major) ||
                            !hello.object_field_integer("protocolMinor", &minor) ||
                            !hello.object_field_string("sessionId", &session_id) ||
                            !hello.object_field_string("token", &token) ||
                            !hello.object_field_string_array("capabilities", &capabilities)) {
                            reject("", 0, "HEALTH", "MALFORMED_FRAME", "invalid HELLO envelope");
                            connection->closing.store(true);
                        } else if (major != kRuntimeProtocolMajor) {
                            reject("", 0, "HEALTH", "PROTOCOL_INCOMPATIBLE", "runtime protocol major is incompatible");
                            connection->closing.store(true);
                        } else if (session_id != state->session_id || token != state->token) {
                            reject("", 0, "HEALTH", "AUTH_FAILED", "runtime launch credentials do not match");
                            connection->closing.store(true);
                        } else {
                            static const std::unordered_set<std::string> available = {
                                "project.discovery", "property.read", "property.write",
                                "time.rational", "render.readiness", "data.revision"
                            };
                            bool capability_missing = false;
                            for (const std::string &capability : capabilities) {
                                if (available.find(capability) == available.end()) { capability_missing = true; break; }
                            }
                            if (capability_missing) {
                                reject("", 0, "HEALTH", "CAPABILITY_MISSING", "adapter lacks a required capability");
                                connection->closing.store(true);
                            } else {
                                const std::string ack = "{\"kind\":\"hello-ack\",\"protocolMajor\":" +
                                    std::to_string(kRuntimeProtocolMajor) + ",\"protocolMinor\":" +
                                    std::to_string((std::min<std::int64_t>)(minor, kRuntimeProtocolMinor)) +
                                    ",\"sessionId\":\"" + json_escape(state->session_id) +
                                    "\",\"capabilities\":[\"project.discovery\",\"property.read\","
                                    "\"property.write\",\"time.rational\",\"render.readiness\",\"data.revision\"],\"fingerprint\":" +
                                    state->fingerprint_json + ",\"hostPid\":" + std::to_string(state->host_pid) + "}";
                                write_serialized(connection_id, ack);
                                if (!flush_outbound(connection_id)) connection->closing.store(true);
                                if (!connection->closing.load() && !state->runtime_ready_emitted.exchange(true)) {
                                    emit_event("RUNTIME_READY", "{\"reason\":\"runtime pipe is serving authenticated clients\"}");
                                }
                            }
                        }
                    }

                    while (!state->stopping.load() && !connection->closing.load()) {
                        if (!flush_outbound(connection_id)) break;
                        std::string request_json;
                        frame_error.clear();
                        const int framed = poll_frame(connection->pipe, &request_json, &frame_error);
                        if (framed < 0) break;
                        if (framed == 0) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(1));
                            continue;
                        }
                        JsonReader reader(request_json);
                        RuntimePipeRequest request;
                        request.connection_id = connection_id;
                        std::string request_kind;
                        std::int64_t request_major = 0;
                        std::int64_t request_minor = 0;
                        if (!reader.object_field_string("kind", &request_kind) || request_kind != "request" ||
                            !reader.object_field_integer("protocolMajor", &request_major) ||
                            !reader.object_field_integer("protocolMinor", &request_minor) ||
                            !reader.object_field_string("sessionId", &request.session_id) ||
                            !reader.object_field_string("requestId", &request.request_id) ||
                            !reader.object_field_integer("sequence", &request.sequence) ||
                            !reader.object_field_string("idempotencyKey", &request.idempotency_key) ||
                            !reader.object_field_integer("deadlineUnixMs", &request.deadline_unix_ms) ||
                            !reader.object_field_nullable_string("expectedProjectDigest", &request.expected_project_digest) ||
                            !reader.object_field_string("operation", &request.operation) ||
                            !reader.object_field_raw("payload", &request.payload_json)) {
                            reject(request.request_id, request.sequence, request.operation, "MALFORMED_FRAME", "invalid runtime request envelope");
                            continue;
                        }
                        if (request_major != kRuntimeProtocolMajor || request.session_id != state->session_id) {
                            reject(request.request_id, request.sequence, request.operation, "AUTH_FAILED", "runtime request session does not match");
                            continue;
                        }
                        if (request.operation != "HEALTH" && request.operation != "SHUTDOWN" &&
                            request.operation != "LIST_PROJECT_ITEMS" && request.operation != "LIST_COMPOSITIONS" &&
                            request.operation != "LIST_LAYERS" && request.operation != "LIST_PROPERTIES" &&
                            request.operation != "READ_PROPERTY" && request.operation != "SET_PROPERTY" &&
                            request.operation != "READ_PROPERTY_METADATA" && request.operation != "LIST_EFFECTS" &&
                            request.operation != "FIXTURE_IDENTITY" && request.operation != "SET_TIME" &&
                            request.operation != "RENDER_FRAME" && request.operation != "APPLY_DATA_REVISION") {
                            reject(request.request_id, request.sequence, request.operation, "OPERATION_UNSUPPORTED", "operation is outside the closed runtime protocol");
                            continue;
                        }
                        if ((request.operation == "SET_PROPERTY" || request.operation == "APPLY_DATA_REVISION") &&
                            request.expected_project_digest.empty()) {
                            reject(request.request_id, request.sequence, request.operation, "PROJECT_DIGEST_MISMATCH", "mutating operation requires the pinned project digest");
                            continue;
                        }
                        if (request.deadline_unix_ms <= unix_time_ms()) {
                            reject(request.request_id, request.sequence, request.operation, "DEADLINE_EXPIRED", "runtime request deadline expired");
                            continue;
                        }
                        {
                            std::lock_guard<std::mutex> lock(state->mutex);
                            if (state->requests.size() >= kMaxPendingRequests) {
                                reject(request.request_id, request.sequence, request.operation, "RUNTIME_UNAVAILABLE",
                                       "the adapter already holds the maximum pending requests; retry after a completion", true);
                                continue;
                            }
                            if (!state->accepted_idempotency_keys.insert(request.idempotency_key).second) {
                                reject(request.request_id, request.sequence, request.operation, "DUPLICATE_REQUEST", "idempotency key was already accepted");
                                continue;
                            }
                            state->accepted_idempotency_key_order.push_back(request.idempotency_key);
                            if (state->accepted_idempotency_key_order.size() > kMaxAcceptedIdempotencyKeys) {
                                state->accepted_idempotency_keys.erase(state->accepted_idempotency_key_order.front());
                                state->accepted_idempotency_key_order.pop_front();
                                OutputDebugStringA("GrapiX AE runtime warning: idempotency history evicted its oldest key.\n");
                            }
                            if (request.operation == "RENDER_FRAME") {
                                std::string render_request_id;
                                if (JsonReader(request.payload_json).object_field_string("renderRequestId", &render_request_id)) {
                                    std::lock_guard<std::mutex> connections_lock(state->connections_mutex);
                                    state->render_request_connections[render_request_id] = connection_id;
                                }
                            }
                            state->requests.push_back(request);
                            state->accepted_total += 1;
                        }
                        state->changed.notify_all();
                    }
                    close_serialized_pipe(connection_id);
                });
            }
        }
        state->running.store(false);
    });
    return true;
#endif
}

void RuntimePipeServer::stop()
{
#ifdef AE_OS_WIN
    if (!state_->running.load() && !state_->worker.joinable()) return;
    state_->stopping.store(true);
    state_->changed.notify_all();
    {
        std::lock_guard<std::mutex> lock(state_->connections_mutex);
        for (const auto &entry : state_->connections) entry.second->closing.store(true);
    }
    if (!state_->pipe_name.empty()) {
        HANDLE wake = CreateFileW(state_->pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (wake != INVALID_HANDLE_VALUE) CloseHandle(wake);
    }
    if (state_->worker.joinable()) state_->worker.join();
    for (std::thread &connection_worker : state_->connection_workers) {
        if (connection_worker.joinable()) connection_worker.join();
    }
    state_->connection_workers.clear();
    state_->running.store(false);
#endif
}

/// Queue one envelope for one connection's I/O owner. AE callbacks never touch a pipe handle.
bool RuntimePipeServer::write_serialized(std::uint64_t connection_id, const std::string &json, bool is_event)
{
#ifdef AE_OS_WIN
    if (json.empty() || json.size() > kRuntimeMaxFrameBytes) return false;
    std::shared_ptr<State::Connection> connection;
    {
        std::lock_guard<std::mutex> lock(state_->connections_mutex);
        const auto found = state_->connections.find(connection_id);
        if (found == state_->connections.end()) return false;
        connection = found->second;
    }
    std::lock_guard<std::mutex> lock(connection->writer_mutex);
    if (connection->pipe == INVALID_HANDLE_VALUE || connection->closing.load()) return false;
    if (connection->outbound.size() >= kMaxOutboundEnvelopes) {
        const auto oldest_event = std::find_if(connection->outbound.begin(), connection->outbound.end(),
                                               [](const State::Connection::OutboundEnvelope &envelope) {
                                                   return envelope.is_event;
                                               });
        if (oldest_event != connection->outbound.end()) {
            connection->outbound.erase(oldest_event);
            OutputDebugStringA("GrapiX AE runtime warning: dropped an oldest outbound event due to connection backpressure.\n");
        } else if (is_event) {
            OutputDebugStringA("GrapiX AE runtime warning: dropped an outbound event because replies occupy the bounded queue.\n");
            return false;
        } else {
            // A reply is never discarded. Closing the stalled connection is the only bounded outcome.
            connection->closing.store(true);
            OutputDebugStringA("GrapiX AE runtime warning: closed a backpressured connection rather than discard a reply.\n");
            return false;
        }
    }
    connection->outbound.push_back({json, is_event});
    return true;
#else
    (void)connection_id;
    (void)json;
    (void)is_event;
    return false;
#endif
}

#ifdef AE_OS_WIN
/// Drain one outbound queue. This is called only by its connection's worker.
bool RuntimePipeServer::flush_outbound(std::uint64_t connection_id)
{
    std::shared_ptr<State::Connection> connection;
    {
        std::lock_guard<std::mutex> lock(state_->connections_mutex);
        const auto found = state_->connections.find(connection_id);
        if (found == state_->connections.end()) return false;
        connection = found->second;
    }
    while (!connection->closing.load()) {
        std::string json;
        {
            std::lock_guard<std::mutex> lock(connection->writer_mutex);
            if (connection->outbound.empty()) return true;
            json = std::move(connection->outbound.front().json);
            connection->outbound.pop_front();
        }
        if (!write_frame(connection->pipe, json)) {
            connection->closing.store(true);
            return false;
        }
    }
    return false;
}

void RuntimePipeServer::close_serialized_pipe(std::uint64_t connection_id)
{
    std::shared_ptr<State::Connection> connection;
    bool dropped_outstanding = false;
    {
        std::lock_guard<std::mutex> lock(state_->connections_mutex);
        const auto found = state_->connections.find(connection_id);
        if (found == state_->connections.end()) return;
        connection = found->second;
        state_->connections.erase(found);
        for (auto render = state_->render_request_connections.begin();
             render != state_->render_request_connections.end();) {
            if (render->second == connection_id) {
                dropped_outstanding = true;
                render = state_->render_request_connections.erase(render);
            } else ++render;
        }
    }
    {
        std::lock_guard<std::mutex> lock(state_->mutex);
        for (const RuntimePipeRequest &request : state_->requests) {
            if (request.connection_id == connection_id) { dropped_outstanding = true; break; }
        }
    }
    {
        std::lock_guard<std::mutex> lock(connection->writer_mutex);
        connection->closing.store(true);
        if (connection->pipe != INVALID_HANDLE_VALUE) {
            FlushFileBuffers(connection->pipe);
            DisconnectNamedPipe(connection->pipe);
            CloseHandle(connection->pipe);
            connection->pipe = INVALID_HANDLE_VALUE;
        }
    }
    if (dropped_outstanding && !state_->stopping.load()) {
        emit_event("RUNTIME_DEGRADED", "{\"reason\":\"a client connection dropped while requests were outstanding\"}");
    }
}
#endif

bool RuntimePipeServer::emit_event(const std::string &event, const std::string &detail_json)
{
#ifndef AE_OS_WIN
    (void)event;
    (void)detail_json;
    return false;
#else
    if (event != "RUNTIME_READY" && event != "RUNTIME_DEGRADED" &&
        event != "RENDER_READY" && event != "RENDER_FAILED") return false;
    if (event == "RUNTIME_READY") state_->runtime_degraded_emitted.store(false);
    if (event == "RUNTIME_DEGRADED" && state_->runtime_degraded_emitted.exchange(true)) return false;
    std::vector<std::uint64_t> targets;
    {
        std::lock_guard<std::mutex> lock(state_->connections_mutex);
        if (event == "RENDER_READY" || event == "RENDER_FAILED") {
            std::string render_request_id;
            if (!JsonReader(detail_json).object_field_string("renderRequestId", &render_request_id)) return false;
            const auto found = state_->render_request_connections.find(render_request_id);
            if (found == state_->render_request_connections.end()) return false;
            targets.push_back(found->second);
            state_->render_request_connections.erase(found);
        } else {
            for (const auto &entry : state_->connections) targets.push_back(entry.first);
        }
    }
    bool queued = false;
    for (const std::uint64_t target : targets) {
        std::shared_ptr<State::Connection> connection;
        {
            std::lock_guard<std::mutex> lock(state_->connections_mutex);
            const auto found = state_->connections.find(target);
            if (found == state_->connections.end()) continue;
            connection = found->second;
        }
        std::uint64_t sequence = 0;
        {
            std::lock_guard<std::mutex> lock(connection->writer_mutex);
            sequence = connection->next_event_sequence++;
        }
        const std::string envelope =
            "{\"kind\":\"event\",\"protocolMajor\":" + std::to_string(kRuntimeProtocolMajor) + ",\"protocolMinor\":" + std::to_string(kRuntimeProtocolMinor) + ",\"sessionId\":\"" +
            json_escape(state_->session_id) + "\",\"sequence\":" + std::to_string(sequence) +
            ",\"event\":\"" + json_escape(event) + "\",\"at\":\"" + utc_timestamp() +
            "\",\"detail\":" + detail_json + "}";
        queued = write_serialized(target, envelope, true) || queued;
    }
    return queued;
#endif
}

/// Hand the idle hook the next live request, retiring any whose deadline has already passed.
///
/// Expiry is decided here rather than in the reader because the wait that matters happens *in this
/// queue*: a request accepted while the host was busy may be worthless by the time a callback arrives,
/// and rendering it would spend a frame budget on a frame nobody can present.
bool RuntimePipeServer::take_request(RuntimePipeRequest *out)
{
    while (true) {
        RuntimePipeRequest candidate;
        {
            std::lock_guard<std::mutex> lock(state_->mutex);
            if (state_->requests.empty()) return false;
            candidate = std::move(state_->requests.front());
            state_->requests.pop_front();
        }
        if (candidate.deadline_unix_ms > unix_time_ms()) {
            *out = std::move(candidate);
            return true;
        }
        write_serialized(candidate.connection_id,
                         protocol_error(state_->session_id, candidate.request_id, candidate.sequence,
                                        candidate.operation, "DEADLINE_EXPIRED",
                                        "the request expired while queued for an After Effects callback",
                                        true));
    }
}

/// Queue one request's reply on the connection that admitted it. AE's idle hook never touches I/O.
void RuntimePipeServer::complete(const RuntimePipeRequest &request, RuntimePipeCompletion completion)
{
    write_serialized(request.connection_id, result_envelope(state_->session_id, request, completion));
    if (request.operation == "RENDER_FRAME") {
        std::string render_request_id;
        if (JsonReader(request.payload_json).object_field_string("renderRequestId", &render_request_id)) {
            std::lock_guard<std::mutex> lock(state_->connections_mutex);
            state_->render_request_connections.erase(render_request_id);
        }
    }
}

std::size_t RuntimePipeServer::pending_requests() const
{
    std::lock_guard<std::mutex> lock(state_->mutex);
    return state_->requests.size();
}

std::uint64_t RuntimePipeServer::accepted_requests() const
{
    std::lock_guard<std::mutex> lock(state_->mutex);
    return state_->accepted_total;
}

} // namespace grapix
