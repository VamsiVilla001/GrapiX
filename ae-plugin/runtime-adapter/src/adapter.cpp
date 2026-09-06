/*
 * GrapiX runtime adapter — AE-A0 resident-adapter kill experiment.
 *
 * Phase AE-A0 of docs/ae-runtime-container-phase-plan.md. This is a deliberately small
 * experiment, not a product runtime. It answers exactly one question the existing one-shot
 * `afterfx.exe -r` bridge cannot: can a GrapiX-owned component stay resident inside a licensed
 * After Effects, accept a bounded command while AE remains open, and perform supported control
 * work without a panel click and without a remote script endpoint?
 *
 * What it deliberately is not:
 *   - a socket server. There is no listener of any kind. AE-A1 introduces the authenticated
 *     same-user local pipe; until then the command channel is a file in this user's own
 *     LOCALAPPDATA, which cannot be reached from another machine.
 *   - a scripting endpoint. The verb set below is closed. There is no eval, no script text, no
 *     shell, no arbitrary filesystem write, and no expression authoring.
 *   - a frame path. Nothing here renders or reads pixels; that is AE-F0.
 *
 * Threading rule, which the SDK is explicit about: every AE suite call happens on AE's own
 * callback thread, inside the idle hook. Nothing else in this file touches a suite.
 *
 * Licence posture: this file is GrapiX source. It calls the After Effects SDK and copies no
 * Adobe sample code. The SDK itself is not vendored into any artefact — see
 * docs/ae-runtime-licensing-decision-request.md §9.2.
 */

#include "AEConfig.h"

#ifdef AE_OS_WIN
#include <windows.h>
#endif

#include "entry.h"
#include "AE_GeneralPlug.h"
#include "AE_Macros.h"
#include "frame_ring.h"
#include "runtime_pipe.h"
#include "revision_apply.h"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Suites. Acquired once at entry, released never — the plugin lives as long as AE does, and
// the death hook is where a real runtime would clean up.
// ---------------------------------------------------------------------------

namespace {

struct Suites {
    SPBasicSuite *basic = nullptr;
    AEGP_ProjSuite6 *proj = nullptr;
    AEGP_ItemSuite9 *item = nullptr;
    AEGP_CompSuite12 *comp = nullptr;
    AEGP_LayerSuite9 *layer = nullptr;
    AEGP_StreamSuite6 *stream = nullptr;
    AEGP_DynamicStreamSuite4 *dynamicStream = nullptr;
    AEGP_UtilitySuite6 *util = nullptr;
    AEGP_MemorySuite1 *mem = nullptr;
    AEGP_KeyframeSuite5 *keyframe = nullptr;
    AEGP_RegisterSuite5 *reg = nullptr;
    // AE-F0: the pixel path. Kept separate from the control suites above because a failure to
    // acquire these must degrade `checkout` alone and never stop the adapter from loading.
    AEGP_RenderOptionsSuite4 *renderOptions = nullptr;
    AEGP_RenderSuite5 *render = nullptr;
    AEGP_WorldSuite3 *world = nullptr;
    // BO0a authoring only. Optional so a host that omits mask authoring can still answer
    // control and checkout commands; `fixture ... edge-corpus` reports the missing capability.
    AEGP_MaskSuite6 *mask = nullptr;
    AEGP_MaskOutlineSuite3 *maskOutline = nullptr;
    AEGP_TextDocumentSuite1 *textDocument = nullptr;
    AEGP_EffectSuite5 *effect = nullptr;
    AEGP_FootageSuite5 *footage = nullptr;
};

Suites g;
AEGP_PluginID g_plugin_id = 0L;

/** Sequence of the last command executed, so a stale file is never replayed. */
long g_last_sequence = -1L;
/** Commands executed since load, reported in every result for evidence. */
long g_commands_executed = 0L;
/** The thread the idle hook runs on, captured at load. AE-F0 has to answer "which thread owns
 *  the pixels", and the only way to answer it is to compare against a thread we know. */
unsigned long g_hook_thread_id = 0UL;

std::string g_state_dir;
std::string g_command_path;
std::string g_result_path;
std::string g_log_path;

unsigned long g_idle_tick = 0;
grapix::RuntimePipeServer g_runtime_pipe;
/// Pipe requests this host has serviced, so a stall separates admission from servicing.
std::uint64_t g_pipe_serviced_total = 0ULL;

/// Idle-callback cadence, so "how often does AE call us" is measurable instead of assumed.
std::uint64_t g_idle_first_micros = 0ULL;
std::uint64_t g_idle_last_micros = 0ULL;
std::uint64_t g_idle_max_gap_micros = 0ULL;

/// Operations serviced per idle callback, and the wall-clock budget one callback may spend.
///
/// These are measured, not chosen. AE-F3 found the frame path at ~21 Hz with one operation per callback;
/// batching lifted it, and a sweep of this pair over `RENDER_FRAME` at 1920x1080 on licensed AE 26.3 then
/// bounded what batching can buy:
///
///   24 ms /  8 ->  2.94 frames per callback, 46.9 ms period,  63.6 fps (1.06x of 59.94)
///   45 ms / 16 ->  5.02 frames per callback, 59.6 ms period,  84.6 fps (1.41x of 59.94)
///  200 ms / 32 -> 20.0  frames per callback, 226.6 ms period, 88.6 fps (1.48x of 59.94)
///
/// A callback's period is `max(AE's own ~47 ms idle cadence, batch x ~11.3 ms per frame)`. Under that
/// floor batching is free - it spends time AE would have slept. Past it the batch becomes the clock and
/// throughput converges on 1/11.3 ms, so no budget reaches 2x of 59.94 and the 200 ms point buys 5% more
/// throughput for a 3.8x worse period, which stutters AE's own UI to ~4 Hz.
///
/// 45 ms / 16 is therefore the knee: 95% of the achievable rate while handing AE's thread back inside
/// roughly one and a half 59.94 frame periods. Both stay overridable by environment - a compile-time
/// sweep would change this binary's hash mid-series, and evidence records the hash that produced it.
constexpr unsigned kDefaultMaxRequestsPerIdleCallback = 16;
constexpr std::uint64_t kDefaultIdleServiceBudgetMicros = 45'000ULL;
unsigned g_max_requests_per_idle_callback = kDefaultMaxRequestsPerIdleCallback;
std::uint64_t g_idle_service_budget_micros = kDefaultIdleServiceBudgetMicros;

/// A monotonic microsecond clock. `GetTickCount` has ~15.6 ms resolution, which cannot measure either
/// a frame budget or the gap between callbacks — it is what makes the adapter's `renderMs` report 0.
std::uint64_t monotonic_micros()
{
    static const std::uint64_t frequency = []() -> std::uint64_t {
        LARGE_INTEGER value = {};
        QueryPerformanceFrequency(&value);
        return value.QuadPart > 0 ? static_cast<std::uint64_t>(value.QuadPart) : 1ULL;
    }();
    LARGE_INTEGER now = {};
    QueryPerformanceCounter(&now);
    return static_cast<std::uint64_t>(now.QuadPart) * 1'000'000ULL / frequency;
}

/// Read the idle-service bounds from the environment, clamped to values that cannot wedge the host.
///
/// These exist because AE-F3 has to *measure* the batch's effect: rebuilding the adapter between
/// sweeps would change its hash mid-series, which the certification rules forbid.
void configure_idle_service_bounds()
{
    if (const char *ops = std::getenv("GRAPIX_AE_IDLE_MAX_OPS")) {
        const long value = strtol(ops, nullptr, 10);
        // At least one, or the adapter would accept requests and never answer them.
        if (value >= 1 && value <= 64) g_max_requests_per_idle_callback = static_cast<unsigned>(value);
    }
    if (const char *budget = std::getenv("GRAPIX_AE_IDLE_BUDGET_MS")) {
        const long value = strtol(budget, nullptr, 10);
        if (value >= 1 && value <= 500) {
            g_idle_service_budget_micros = static_cast<std::uint64_t>(value) * 1000ULL;
        }
    }
}

// AE-F2a's adapter-owned producer. The mapping is created once from the local runtime session
// id and never resized: a later frame outside the first checked-out world's geometry is refused
// rather than recreating a mapping beneath a consumer. frame_ring.cpp owns its state machine.
std::unique_ptr<grapix::SharedFrameRing> g_ae_frame_ring;
std::string g_ae_frame_ring_session_id;
std::wstring g_ae_frame_ring_name;

// ---------------------------------------------------------------------------
// Revision write fault injection — the only route to a *live* rollback measurement.
//
// AE-CD2's rollback had never been triggered because phase 2 is thorough: it gates every kind on a
// cheap total query before acquiring a stream, so on the pinned fixture no validated member has a way
// to fail `AEGP_SetStreamValue` mid-batch. That is a property worth keeping, not a hole to open — which
// leaves fault injection as the honest way to exercise the recovery path against *real* After Effects
// state. The cause is synthetic; the writes, the restores and the read-back are all real.
//
// Two safeguards, because a production adapter that can be told to fail is a liability:
//  * it is armed only by an explicit environment variable, read once at load, and it is **one-shot** —
//    it disarms on use, so a soak cannot quietly keep failing every batch;
//  * when armed it is reported in the HELLO fingerprint, so a supervisor sees it and a certification
//    runner can refuse to record evidence from an adapter that was told to lie.
// ---------------------------------------------------------------------------

/** Zero-based index of the revision member whose write is forced to fail, or -1 when disarmed. */
long g_fault_inject_revision_write = -1;

void arm_fault_injection()
{
    const char *value = std::getenv("GRAPIX_AE_RUNTIME_FAULT_INJECT_REVISION_WRITE");
    if (value == nullptr || *value == '\0') return;
    char *end = nullptr;
    const long index = strtol(value, &end, 10);
    if (end == nullptr || *end != '\0' || index < 0) return;
    g_fault_inject_revision_write = index;
}

/** The fingerprint's `faultInjection` value: a description when armed, JSON `null` when not. */
std::string fault_injection_fingerprint()
{
    if (g_fault_inject_revision_write < 0) return "null";
    return "\"revision-write@" + std::to_string(g_fault_inject_revision_write) + "\"";
}

/** True once, for the armed index only, then disarms. */
bool consume_injected_revision_write_fault(std::size_t index)
{
    if (g_fault_inject_revision_write < 0) return false;
    if (static_cast<std::size_t>(g_fault_inject_revision_write) != index) return false;
    g_fault_inject_revision_write = -1;
    return true;
}

// ---------------------------------------------------------------------------
// State directory. This user's own LOCALAPPDATA, never a shared or configurable location:
// an adapter that reads a caller-supplied path is a filesystem oracle, which §26 forbids.
// ---------------------------------------------------------------------------

bool resolve_state_dir()
{
#ifdef AE_OS_WIN
    char buffer[MAX_PATH] = {0};
    DWORD written = GetEnvironmentVariableA("LOCALAPPDATA", buffer, MAX_PATH);
    if (written == 0 || written >= MAX_PATH) return false;

    g_state_dir = std::string(buffer) + "\\GrapiX\\ae-adapter";
    std::string grapix = std::string(buffer) + "\\GrapiX";
    CreateDirectoryA(grapix.c_str(), nullptr);
    CreateDirectoryA(g_state_dir.c_str(), nullptr);

    g_command_path = g_state_dir + "\\command.txt";
    g_result_path = g_state_dir + "\\result.json";
    g_log_path = g_state_dir + "\\log.txt";
    return true;
#else
    return false;
#endif
}

void append_log(const std::string &line)
{
    if (g_log_path.empty()) return;
    FILE *file = nullptr;
    if (fopen_s(&file, g_log_path.c_str(), "ab") != 0 || file == nullptr) return;
    fputs(line.c_str(), file);
    fputs("\n", file);
    fclose(file);
}

/** Write the whole result atomically enough for a spike: temp file, then replace. */
void write_result(const std::string &json)
{
    if (g_result_path.empty()) return;
    std::string temporary = g_result_path + ".tmp";
    FILE *file = nullptr;
    if (fopen_s(&file, temporary.c_str(), "wb") != 0 || file == nullptr) return;
    fwrite(json.data(), 1, json.size(), file);
    fclose(file);
#ifdef AE_OS_WIN
    MoveFileExA(temporary.c_str(), g_result_path.c_str(), MOVEFILE_REPLACE_EXISTING);
#endif
}

std::string json_escape(const std::string &value)
{
    std::string out;
    out.reserve(value.size() + 8);
    for (char character : value) {
        switch (character) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(character) < 0x20) {
                    char escape[8];
                    sprintf_s(escape, sizeof(escape), "\\u%04x", character & 0xff);
                    out += escape;
                } else {
                    out += character;
                }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Unicode helpers. AE's project/item/layer APIs are UTF-16; the command file is UTF-8 so it
// stays readable and diffable.
// ---------------------------------------------------------------------------

std::vector<A_UTF16Char> utf8_to_utf16(const std::string &utf8)
{
    std::vector<A_UTF16Char> out;
#ifdef AE_OS_WIN
    int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    if (needed <= 0) {
        out.push_back(0);
        return out;
    }
    std::vector<wchar_t> wide(static_cast<size_t>(needed));
    MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, wide.data(), needed);
    out.reserve(wide.size());
    for (wchar_t character : wide) out.push_back(static_cast<A_UTF16Char>(character));
#else
    out.push_back(0);
#endif
    return out;
}

std::string utf16_to_utf8(const A_UTF16Char *utf16)
{
#ifdef AE_OS_WIN
    if (utf16 == nullptr) return std::string();
    const wchar_t *wide = reinterpret_cast<const wchar_t *>(utf16);
    int needed = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return std::string();
    std::vector<char> out(static_cast<size_t>(needed));
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), needed, nullptr, nullptr);
    return std::string(out.data());
#else
    return std::string();
#endif
}

/** Read an AEGP_MemHandle of UTF-16 and always free it, including on the error paths. */
std::string take_handle_string(AEGP_MemHandle handle)
{
    if (handle == nullptr || g.mem == nullptr) return std::string();
    void *pointer = nullptr;
    std::string out;
    if (g.mem->AEGP_LockMemHandle(handle, &pointer) == A_Err_NONE && pointer != nullptr) {
        out = utf16_to_utf8(static_cast<const A_UTF16Char *>(pointer));
        g.mem->AEGP_UnlockMemHandle(handle);
    }
    g.mem->AEGP_FreeMemHandle(handle);
    return out;
}

// ---------------------------------------------------------------------------
// The closed verb set. Adding a verb here is a deliberate act; there is no dispatch by name
// into anything AE exposes, and no way to reach a suite this file does not call itself.
// ---------------------------------------------------------------------------

enum Verb {
    VERB_UNKNOWN,
    VERB_PING,      // prove the adapter is resident and the channel round-trips
    VERB_OPEN,      // open <utf8 project path>
    VERB_LIST,      // enumerate project items, comps, layers
    VERB_READ,      // read <compIndex> <layerIndex> <opacity|rotation>
    VERB_SET,       // set <compIndex> <layerIndex> <opacity|rotation> <value>
    VERB_PROBE,     // probe <compIndex> <layerIndex> <opacity|rotation> — writability facts
    VERB_DIRTY,     // does AE think the project has unsaved changes?
    VERB_DISCARD,   // replace the open project with an empty one, discarding changes
    VERB_CHECKOUT,  // AE-F0: render one composition frame and describe the pixels
    VERB_FIXTURE,   // AE-F0/BO0a: author pinned certification fixtures
    VERB_FIXTURE_CONTROL // BO0a: write only a pinned fixture's declared stable target
};

Verb parse_verb(const std::string &token)
{
    if (token == "ping") return VERB_PING;
    if (token == "open") return VERB_OPEN;
    if (token == "list") return VERB_LIST;
    if (token == "read") return VERB_READ;
    if (token == "set") return VERB_SET;
    if (token == "probe") return VERB_PROBE;
    if (token == "dirty") return VERB_DIRTY;
    if (token == "discard") return VERB_DISCARD;
    if (token == "checkout") return VERB_CHECKOUT;
    if (token == "fixture") return VERB_FIXTURE;
    if (token == "fixture-control") return VERB_FIXTURE_CONTROL;
    return VERB_UNKNOWN;
}

/** Only unkeyframed 1D transform streams. The SDK restricts AEGP_SetStreamValue to
 *  AEGP_GetStreamNumKFs == 0 or NO_DATA, so the spike stays inside that. */
bool parse_stream(const std::string &token, AEGP_LayerStream *out)
{
    if (token == "opacity") { *out = AEGP_LayerStream_OPACITY; return true; }
    if (token == "rotation") { *out = AEGP_LayerStream_ROTATION; return true; }
    return false;
}

struct Command {
    long sequence = -1L;
    Verb verb = VERB_UNKNOWN;
    std::vector<std::string> arguments;
    bool valid = false;
};

/** Command file format, one line: `<sequence> <verb> [args...]`.
 *  Deliberately not JSON: a spike should not add a parser it has to trust. */
Command read_command()
{
    Command command;
    FILE *file = nullptr;
    if (fopen_s(&file, g_command_path.c_str(), "rb") != 0 || file == nullptr) return command;

    char buffer[2048] = {0};
    size_t read = fread(buffer, 1, sizeof(buffer) - 1, file);
    fclose(file);
    if (read == 0) return command;
    buffer[read] = '\0';

    std::string line(buffer);
    size_t newline = line.find_first_of("\r\n");
    if (newline != std::string::npos) line = line.substr(0, newline);

    std::vector<std::string> tokens;
    size_t cursor = 0;
    while (cursor < line.size()) {
        while (cursor < line.size() && line[cursor] == ' ') cursor += 1;
        if (cursor >= line.size()) break;
        // A quoted token keeps spaces, which project paths have.
        if (line[cursor] == '"') {
            size_t close = line.find('"', cursor + 1);
            if (close == std::string::npos) break;
            tokens.push_back(line.substr(cursor + 1, close - cursor - 1));
            cursor = close + 1;
        } else {
            size_t space = line.find(' ', cursor);
            if (space == std::string::npos) space = line.size();
            tokens.push_back(line.substr(cursor, space - cursor));
            cursor = space;
        }
    }

    if (tokens.size() < 2) return command;
    command.sequence = strtol(tokens[0].c_str(), nullptr, 10);
    command.verb = parse_verb(tokens[1]);
    for (size_t index = 2; index < tokens.size(); index += 1) command.arguments.push_back(tokens[index]);
    command.valid = true;
    return command;
}

// ---------------------------------------------------------------------------
// Project navigation. Index-based for the spike; AE-A3 replaces indices with the stable
// identities (item id, layer id, unique stream id) a real control manifest needs.
// ---------------------------------------------------------------------------

A_Err first_project(AEGP_ProjectH *out)
{
    A_long count = 0;
    A_Err err = g.proj->AEGP_GetNumProjects(&count);
    if (err != A_Err_NONE) return err;
    if (count < 1) return A_Err_GENERIC;
    return g.proj->AEGP_GetProjectByIndex(0, out);
}

/** The nth composition in project order. */
A_Err comp_by_index(long wanted, AEGP_CompH *out, std::string *name)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) return err;

    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    if (err != A_Err_NONE) return err;

    long seen = 0;
    while (item != nullptr) {
        AEGP_ItemType type = AEGP_ItemType_NONE;
        if (g.item->AEGP_GetItemType(item, &type) == A_Err_NONE && type == AEGP_ItemType_COMP) {
            if (seen == wanted) {
                if (name != nullptr) {
                    AEGP_MemHandle handle = nullptr;
                    if (g.item->AEGP_GetItemName(g_plugin_id, item, &handle) == A_Err_NONE) {
                        *name = take_handle_string(handle);
                    }
                }
                return g.comp->AEGP_GetCompFromItem(item, out);
            }
            seen += 1;
        }
        AEGP_ItemH next = nullptr;
        if (g.item->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) break;
        item = next;
    }
    return A_Err_GENERIC;
}

A_Err layer_by_index(long comp_index, long layer_index, AEGP_LayerH *out, std::string *layer_name)
{
    AEGP_CompH comp = nullptr;
    A_Err err = comp_by_index(comp_index, &comp, nullptr);
    if (err != A_Err_NONE) return err;

    A_long layers = 0;
    err = g.layer->AEGP_GetCompNumLayers(comp, &layers);
    if (err != A_Err_NONE) return err;
    if (layer_index < 0 || layer_index >= layers) return A_Err_GENERIC;

    err = g.layer->AEGP_GetCompLayerByIndex(comp, static_cast<A_long>(layer_index), out);
    if (err != A_Err_NONE) return err;

    if (layer_name != nullptr) {
        AEGP_MemHandle name_handle = nullptr;
        AEGP_MemHandle source_handle = nullptr;
        if (g.layer->AEGP_GetLayerName(g_plugin_id, *out, &name_handle, &source_handle) == A_Err_NONE) {
            *layer_name = take_handle_string(name_handle);
            if (source_handle != nullptr) g.mem->AEGP_FreeMemHandle(source_handle);
        }
    }
    return A_Err_NONE;
}

// ---------------------------------------------------------------------------
// Verb implementations. Each returns the JSON body of its result; the dispatcher wraps it.
// ---------------------------------------------------------------------------

/** The host process id is stamped on every reply by the result header, not here: the channel is
 *  a file pair in a fixed state directory and so has no process identity of its own. A second
 *  After Effects with this adapter installed would answer on the same channel, and a supervisor
 *  comparing sequence numbers alone would happily attribute that reply to the process it
 *  launched. The pid is what lets a caller prove whose AE just spoke, and it is the basis of the
 *  attach ownership rule. */
std::string do_ping()
{
    A_short major = 0;
    A_short minor = 0;
    g.util->AEGP_GetDriverImplementationVersion(&major, &minor);

    // Health also proves project identity: a supervisor-owned project change now replaces the
    // whole After Effects process, so the only trustworthy evidence is the path the fresh host
    // reports for the project it actually opened. An unsaved project reports an empty path and
    // is surfaced as null rather than silently matching an empty expectation.
    std::string project_path;
    AEGP_ProjectH project = nullptr;
    if (first_project(&project) == A_Err_NONE) {
        AEGP_MemHandle path_handle = nullptr;
        if (g.proj->AEGP_GetProjectPath(project, &path_handle) == A_Err_NONE) {
            project_path = take_handle_string(path_handle);
        }
    }

    // The idle-callback cadence travels with health because AE-F3's ceiling was a *dispatch* limit,
    // not a render one: how often this hook runs, and the worst gap between runs, are the two numbers
    // that explain a frame rate. Microseconds, because `GetTickCount`'s 15.6 ms tick is coarser than
    char body[640];
    sprintf_s(body, sizeof(body),
              "\"resident\":true,\"driverMajor\":%d,\"driverMinor\":%d,\"pluginId\":%ld,"
              "\"idleTicks\":%lu,\"idleElapsedMicros\":%llu,\"idleMaxGapMicros\":%llu,"
              "\"idleMaxOpsPerCallback\":%u,\"idleBudgetMicros\":%llu,"
              "\"pipeAccepted\":%llu,\"pipeServiced\":%llu,\"pipePending\":%llu",
              static_cast<int>(major), static_cast<int>(minor), static_cast<long>(g_plugin_id),
              g_idle_tick,
              static_cast<unsigned long long>(
                  g_idle_last_micros > g_idle_first_micros ? g_idle_last_micros - g_idle_first_micros : 0ULL),
              static_cast<unsigned long long>(g_idle_max_gap_micros),
              g_max_requests_per_idle_callback,
              static_cast<unsigned long long>(g_idle_service_budget_micros),
              static_cast<unsigned long long>(g_runtime_pipe.accepted_requests()),
              static_cast<unsigned long long>(g_pipe_serviced_total),
              static_cast<unsigned long long>(g_runtime_pipe.pending_requests()));
    return std::string(body) + ",\"projectPath\":" +
        (project_path.empty() ? "null" : "\"" + json_escape(project_path) + "\"");
}

std::string do_open(const std::vector<std::string> &, A_Err *err_out)
{
    // The legacy command channel has no project-opening route either. AEGP_OpenProjectFromPath
    // on this hook has already wedged idle processing once; the supervised process launch is
    // the only supported replacement path.
    *err_out = A_Err_PARAMETER;
    return "\"reason\":\"project changes are supervisor-owned restarts\"";
}

std::string do_list(A_Err *err_out)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    *err_out = err;
    if (err != A_Err_NONE) return "\"reason\":\"no open project\"";

    std::string out = "\"compositions\":[";
    AEGP_ItemH item = nullptr;
    if (g.item->AEGP_GetFirstProjItem(project, &item) != A_Err_NONE) item = nullptr;

    long comp_index = 0;
    bool first_entry = true;
    while (item != nullptr) {
        AEGP_ItemType type = AEGP_ItemType_NONE;
        if (g.item->AEGP_GetItemType(item, &type) == A_Err_NONE && type == AEGP_ItemType_COMP) {
            std::string comp_name;
            AEGP_MemHandle handle = nullptr;
            if (g.item->AEGP_GetItemName(g_plugin_id, item, &handle) == A_Err_NONE) {
                comp_name = take_handle_string(handle);
            }

            AEGP_CompH comp = nullptr;
            A_long layers = 0;
            if (g.comp->AEGP_GetCompFromItem(item, &comp) == A_Err_NONE) {
                g.layer->AEGP_GetCompNumLayers(comp, &layers);
            }

            // Geometry and timing, because a caller that must check out "first, middle and last
            // frame" cannot derive those from a layer list. Duration arrives as a rational in
            // comp time: reported as the exact pair, never as a rounded float, so a 30000/1001
            // composition stays distinguishable from a 30/1 one.
            A_long width = 0;
            A_long height = 0;
            g.item->AEGP_GetItemDimensions(item, &width, &height);

            A_Time duration = {0, 1};
            g.item->AEGP_GetItemDuration(item, &duration);

            A_FpLong frame_rate = 0.0;
            if (comp != nullptr) g.comp->AEGP_GetCompFramerate(comp, &frame_rate);

            const A_long frame_count = (duration.scale > 0 && frame_rate > 0.0)
                ? static_cast<A_long>((static_cast<double>(duration.value) / duration.scale) * frame_rate + 0.5)
                : 0;

            if (!first_entry) out += ",";
            first_entry = false;

            char head[512];
            sprintf_s(head, sizeof(head),
                      "{\"index\":%ld,\"name\":\"%s\",\"width\":%ld,\"height\":%ld,"
                      "\"durationValue\":%ld,\"durationScale\":%lu,\"frameRate\":%.6f,\"frameCount\":%ld,"
                      "\"layers\":[",
                      comp_index, json_escape(comp_name).c_str(),
                      static_cast<long>(width), static_cast<long>(height),
                      static_cast<long>(duration.value), static_cast<unsigned long>(duration.scale),
                      frame_rate, static_cast<long>(frame_count));
            out += head;

            for (A_long layer_index = 0; layer_index < layers; layer_index += 1) {
                AEGP_LayerH layer = nullptr;
                if (g.layer->AEGP_GetCompLayerByIndex(comp, layer_index, &layer) != A_Err_NONE) continue;

                std::string layer_name;
                AEGP_MemHandle name_handle = nullptr;
                AEGP_MemHandle source_handle = nullptr;
                if (g.layer->AEGP_GetLayerName(g_plugin_id, layer, &name_handle, &source_handle) == A_Err_NONE) {
                    layer_name = take_handle_string(name_handle);
                    if (source_handle != nullptr) g.mem->AEGP_FreeMemHandle(source_handle);
                }

                char entry[512];
                sprintf_s(entry, sizeof(entry), "%s{\"index\":%ld,\"name\":\"%s\"}",
                          layer_index == 0 ? "" : ",", static_cast<long>(layer_index),
                          json_escape(layer_name).c_str());
                out += entry;
            }
            out += "]}";
            comp_index += 1;
        }
        AEGP_ItemH next = nullptr;
        if (g.item->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) break;
        item = next;
    }
    out += "]";
    return out;
}

/** Read the stream at time zero, in composition time. */
std::string do_read(const std::vector<std::string> &arguments, A_Err *err_out)
{
    if (arguments.size() < 3) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"read needs compIndex layerIndex stream\"";
    }
    AEGP_LayerStream which = AEGP_LayerStream_OPACITY;
    if (!parse_stream(arguments[2], &which)) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"unsupported stream; this spike allows opacity or rotation\"";
    }

    std::string layer_name;
    AEGP_LayerH layer = nullptr;
    A_Err err = layer_by_index(strtol(arguments[0].c_str(), nullptr, 10),
                               strtol(arguments[1].c_str(), nullptr, 10), &layer, &layer_name);
    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"layer not found\"";
    }

    AEGP_StreamRefH stream = nullptr;
    err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, which, &stream);
    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"AEGP_GetNewLayerStream failed\"";
    }

    A_Time zero = {0, 100};
    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    err = g.stream->AEGP_GetNewStreamValue(g_plugin_id, stream, AEGP_LTimeMode_CompTime, &zero, FALSE, &value);

    std::string body;
    if (err == A_Err_NONE) {
        A_long keys = 0;
        g.keyframe->AEGP_GetStreamNumKFs(stream, &keys);
        int unique_id = 0;
        g.stream->AEGP_GetUniqueStreamID(stream, &unique_id);

        char text[512];
        sprintf_s(text, sizeof(text),
                  "\"layer\":\"%s\",\"stream\":\"%s\",\"value\":%.6f,\"keyframes\":%ld,\"uniqueStreamId\":%d",
                  json_escape(layer_name).c_str(), arguments[2].c_str(),
                  value.val.one_d, static_cast<long>(keys), unique_id);
        body = text;
        g.stream->AEGP_DisposeStreamValue(&value);
    } else {
        body = "\"reason\":\"AEGP_GetNewStreamValue failed\"";
    }

    g.stream->AEGP_DisposeStream(stream);
    *err_out = err;
    return body;
}

/** Report writability facts rather than guessing them: keyframe count decides whether
 *  AEGP_SetStreamValue is even legal on this stream. */
std::string do_probe(const std::vector<std::string> &arguments, A_Err *err_out)
{
    if (arguments.size() < 3) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"probe needs compIndex layerIndex stream\"";
    }
    AEGP_LayerStream which = AEGP_LayerStream_OPACITY;
    if (!parse_stream(arguments[2], &which)) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"unsupported stream\"";
    }

    std::string layer_name;
    AEGP_LayerH layer = nullptr;
    A_Err err = layer_by_index(strtol(arguments[0].c_str(), nullptr, 10),
                               strtol(arguments[1].c_str(), nullptr, 10), &layer, &layer_name);
    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"layer not found\"";
    }

    AEGP_StreamRefH stream = nullptr;
    err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, which, &stream);
    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"AEGP_GetNewLayerStream failed\"";
    }

    A_long keys = 0;
    g.keyframe->AEGP_GetStreamNumKFs(stream, &keys);
    A_Boolean is_time_varying = FALSE;
    g.stream->AEGP_IsStreamTimevarying(stream, &is_time_varying);
    int unique_id = 0;
    g.stream->AEGP_GetUniqueStreamID(stream, &unique_id);

    char text[512];
    sprintf_s(text, sizeof(text),
              "\"layer\":\"%s\",\"stream\":\"%s\",\"keyframes\":%ld,\"timeVarying\":%s,"
              "\"setStreamValueLegal\":%s,\"uniqueStreamId\":%d",
              json_escape(layer_name).c_str(), arguments[2].c_str(), static_cast<long>(keys),
              is_time_varying ? "true" : "false", keys == 0 ? "true" : "false", unique_id);

    g.stream->AEGP_DisposeStream(stream);
    *err_out = A_Err_NONE;
    return std::string(text);
}

/** One declared write, wrapped in one undo group, refused outright if the stream is keyed. */
std::string do_set(const std::vector<std::string> &arguments, A_Err *err_out)
{
    if (arguments.size() < 4) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"set needs compIndex layerIndex stream value\"";
    }
    AEGP_LayerStream which = AEGP_LayerStream_OPACITY;
    if (!parse_stream(arguments[2], &which)) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"unsupported stream; this spike allows opacity or rotation\"";
    }

    std::string layer_name;
    AEGP_LayerH layer = nullptr;
    A_Err err = layer_by_index(strtol(arguments[0].c_str(), nullptr, 10),
                               strtol(arguments[1].c_str(), nullptr, 10), &layer, &layer_name);
    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"layer not found\"";
    }

    AEGP_StreamRefH stream = nullptr;
    err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, which, &stream);
    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"AEGP_GetNewLayerStream failed\"";
    }

    // The SDK says AEGP_SetStreamValue is legal only with no keyframes. Check rather than
    // discover: a refusal with a reason is the useful outcome, a silent failure is not.
    A_long keys = 0;
    g.keyframe->AEGP_GetStreamNumKFs(stream, &keys);
    if (keys != 0) {
        g.stream->AEGP_DisposeStream(stream);
        *err_out = A_Err_PARAMETER;
        char text[256];
        sprintf_s(text, sizeof(text),
                  "\"reason\":\"stream has %ld keyframes; AEGP_SetStreamValue is not legal\"",
                  static_cast<long>(keys));
        return std::string(text);
    }

    A_Time zero = {0, 100};
    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    err = g.stream->AEGP_GetNewStreamValue(g_plugin_id, stream, AEGP_LTimeMode_CompTime, &zero, FALSE, &value);
    if (err != A_Err_NONE) {
        g.stream->AEGP_DisposeStream(stream);
        *err_out = err;
        return "\"reason\":\"AEGP_GetNewStreamValue failed\"";
    }

    double previous = value.val.one_d;
    value.val.one_d = strtod(arguments[3].c_str(), nullptr);

    g.util->AEGP_StartUndoGroup("GrapiX adapter set");
    err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
    g.util->AEGP_EndUndoGroup();

    std::string body;
    if (err == A_Err_NONE) {
        // Read back through a fresh value so the report is what AE holds, not what we sent.
        AEGP_StreamValue2 confirm;
        memset(&confirm, 0, sizeof(confirm));
        double readback = 0.0;
        if (g.stream->AEGP_GetNewStreamValue(g_plugin_id, stream, AEGP_LTimeMode_CompTime, &zero, FALSE, &confirm) == A_Err_NONE) {
            readback = confirm.val.one_d;
            g.stream->AEGP_DisposeStreamValue(&confirm);
        }
        char text[512];
        sprintf_s(text, sizeof(text),
                  "\"layer\":\"%s\",\"stream\":\"%s\",\"previous\":%.6f,\"requested\":%.6f,\"readback\":%.6f",
                  json_escape(layer_name).c_str(), arguments[2].c_str(), previous,
                  value.val.one_d, readback);
        body = text;
    } else {
        body = "\"reason\":\"AEGP_SetStreamValue failed\"";
    }

    g.stream->AEGP_DisposeStreamValue(&value);
    g.stream->AEGP_DisposeStream(stream);
    *err_out = err;
    return body;
}

/** Does AE consider the project unsaved? A supervisor needs this before it asks AE to quit:
 *  a dirty project means a save prompt is coming, and an unattended shutdown that does not
 *  expect one hangs on it. */
std::string do_dirty(A_Err *err_out)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    *err_out = err;
    if (err != A_Err_NONE) return "\"reason\":\"no open project\"";

    A_Boolean is_dirty = FALSE;
    err = g.proj->AEGP_ProjectIsDirty(project, &is_dirty);
    *err_out = err;
    if (err != A_Err_NONE) return "\"reason\":\"AEGP_ProjectIsDirty failed\"";

    A_char project_name[AEGP_MAX_PROJ_NAME_SIZE] = {0};
    g.proj->AEGP_GetProjectName(project, project_name);

    char text[512];
    sprintf_s(text, sizeof(text), "\"projectName\":\"%s\",\"dirty\":%s",
              json_escape(project_name).c_str(), is_dirty ? "true" : "false");
    return std::string(text);
}

/** Replace whatever is open with an empty project. The SDK warns this closes open projects,
 *  which is exactly the point: it is the candidate for discarding edits without a save prompt,
 *  so a supervisor can reach a clean state before shutdown. Whether it prompts is the thing
 *  this verb exists to find out — and note finding F2: project-lifecycle calls on the idle
 *  path have already wedged idle processing once. */
std::string do_discard(A_Err *err_out)
{
    AEGP_ProjectH before = nullptr;
    A_Boolean was_dirty = FALSE;
    if (first_project(&before) == A_Err_NONE) {
        g.proj->AEGP_ProjectIsDirty(before, &was_dirty);
    }

    AEGP_ProjectH fresh = nullptr;
    A_Err err = g.proj->AEGP_NewProject(&fresh);
    *err_out = err;
    if (err != A_Err_NONE) return "\"reason\":\"AEGP_NewProject failed\"";

    A_char project_name[AEGP_MAX_PROJ_NAME_SIZE] = {0};
    g.proj->AEGP_GetProjectName(fresh, project_name);

    char text[512];
    sprintf_s(text, sizeof(text), "\"wasDirty\":%s,\"projectName\":\"%s\"",
              was_dirty ? "true" : "false", json_escape(project_name).c_str());
    return std::string(text);
}

/** Set a layer's position, whichever dimensionality its stream has. A 2D layer's position is a
 *  TwoD stream and a 3D layer's is ThreeD; writing the wrong member of the union silently places
 *  the layer somewhere else, which for an alpha fixture means the expectations are about a frame
 *  that was never rendered. */
A_Err set_layer_position(AEGP_LayerH layer, double x, double y)
{
    AEGP_StreamRefH stream = nullptr;
    A_Err err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, AEGP_LayerStream_POSITION, &stream);
    if (err != A_Err_NONE) return err;

    AEGP_StreamType type = AEGP_StreamType_NO_DATA;
    err = g.stream->AEGP_GetStreamType(stream, &type);

    if (err == A_Err_NONE) {
        AEGP_StreamValue2 value;
        memset(&value, 0, sizeof(value));
        AEGP_StreamVal2 payload;
        memset(&payload, 0, sizeof(payload));

        if (type == AEGP_StreamType_ThreeD_SPATIAL || type == AEGP_StreamType_ThreeD) {
            payload.three_d.x = x;
            payload.three_d.y = y;
            payload.three_d.z = 0.0;
        } else if (type == AEGP_StreamType_TwoD_SPATIAL || type == AEGP_StreamType_TwoD) {
            payload.two_d.x = x;
            payload.two_d.y = y;
        } else {
            g.stream->AEGP_DisposeStream(stream);
            return A_Err_PARAMETER;
        }

        value.streamH = stream;
        value.val = payload;
        err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
    }

    g.stream->AEGP_DisposeStream(stream);
    return err;
}

A_Err set_layer_opacity(AEGP_LayerH layer, double percent)
{
    AEGP_StreamRefH stream = nullptr;
    A_Err err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, AEGP_LayerStream_OPACITY, &stream);
    if (err != A_Err_NONE) return err;

    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    value.streamH = stream;
    value.val.one_d = percent;
    err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);

    g.stream->AEGP_DisposeStream(stream);
    return err;
}

A_Err set_layer_rotation(AEGP_LayerH layer, double degrees)
{
    AEGP_StreamRefH stream = nullptr;
    A_Err err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, AEGP_LayerStream_ROTATION, &stream);
    if (err != A_Err_NONE) return err;

    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    value.streamH = stream;
    value.val.one_d = degrees;
    err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
    g.stream->AEGP_DisposeStream(stream);
    return err;
}

A_Err create_solid(AEGP_CompH comp, const A_Time &duration, const char *name,
                   long width, long height, const AEGP_ColorVal &colour,
                   double x, double y, double opacity, double rotation,
                   AEGP_LayerH *out)
{
    std::vector<A_UTF16Char> wide_name = utf8_to_utf16(name);
    A_Err err = g.comp->AEGP_CreateSolidInComp(
        wide_name.data(), width, height, &colour, comp, &duration, out);
    if (err == A_Err_NONE) err = g.layer->AEGP_SetLayerName(*out, wide_name.data());
    if (err == A_Err_NONE) err = set_layer_position(*out, x, y);
    if (err == A_Err_NONE) err = set_layer_opacity(*out, opacity);
    if (err == A_Err_NONE && rotation != 0.0) err = set_layer_rotation(*out, rotation);
    if (err == A_Err_NONE) err = g.layer->AEGP_SetLayerQuality(*out, AEGP_LayerQual_BEST);
    return err;
}

/** Put a closed rectangular mask on a solid and optionally feather it.
 *
 *  The outline is authored through a disposable stream value, exactly as Adobe's Projector
 *  sample does. Mask coordinates are layer-local. This matters for the edge corpus: using comp
 *  coordinates would move the soft edge away from the pixels its manifest describes. */
A_Err add_rect_mask(AEGP_LayerH layer, double left, double top, double right, double bottom,
                    double feather_x, double feather_y)
{
    if (g.mask == nullptr || g.maskOutline == nullptr) return A_Err_GENERIC;

    AEGP_MaskRefH mask = nullptr;
    A_long mask_index = 0;
    AEGP_StreamRefH outline_stream = nullptr;
    AEGP_StreamValue2 outline_value;
    memset(&outline_value, 0, sizeof(outline_value));
    bool have_outline_value = false;

    A_Err err = g.mask->AEGP_CreateNewMask(layer, &mask, &mask_index);
    if (err == A_Err_NONE) err = g.mask->AEGP_SetMaskMode(mask, PF_MaskMode_ADD);
    if (err == A_Err_NONE) {
        err = g.stream->AEGP_GetNewMaskStream(
            g_plugin_id, mask, AEGP_MaskStream_OUTLINE, &outline_stream);
    }

    const A_Time zero = {0, 1};
    if (err == A_Err_NONE) {
        err = g.stream->AEGP_GetNewStreamValue(
            g_plugin_id, outline_stream, AEGP_LTimeMode_CompTime, &zero, TRUE, &outline_value);
        have_outline_value = err == A_Err_NONE;
    }

    for (A_long index = 0; err == A_Err_NONE && index < 4; index += 1) {
        err = g.maskOutline->AEGP_CreateVertex(outline_value.val.mask, index);
    }

    const double points[4][2] = {
        {left, top}, {right, top}, {right, bottom}, {left, bottom}
    };
    for (A_long index = 0; err == A_Err_NONE && index < 4; index += 1) {
        AEGP_MaskVertex vertex;
        memset(&vertex, 0, sizeof(vertex));
        vertex.x = points[index][0];
        vertex.y = points[index][1];
        err = g.maskOutline->AEGP_SetMaskOutlineVertexInfo(
            outline_value.val.mask, index, &vertex);
    }
    if (err == A_Err_NONE) {
        err = g.maskOutline->AEGP_SetMaskOutlineOpen(outline_value.val.mask, FALSE);
    }
    if (err == A_Err_NONE) {
        err = g.stream->AEGP_SetStreamValue(g_plugin_id, outline_stream, &outline_value);
    }

    if (have_outline_value) g.stream->AEGP_DisposeStreamValue(&outline_value);
    if (outline_stream != nullptr) g.stream->AEGP_DisposeStream(outline_stream);

    if (err == A_Err_NONE && (feather_x > 0.0 || feather_y > 0.0)) {
        AEGP_StreamRefH feather_stream = nullptr;
        err = g.stream->AEGP_GetNewMaskStream(
            g_plugin_id, mask, AEGP_MaskStream_FEATHER, &feather_stream);
        if (err == A_Err_NONE) {
            AEGP_StreamValue2 feather_value;
            memset(&feather_value, 0, sizeof(feather_value));
            feather_value.streamH = feather_stream;
            feather_value.val.two_d.x = feather_x;
            feather_value.val.two_d.y = feather_y;
            err = g.stream->AEGP_SetStreamValue(g_plugin_id, feather_stream, &feather_value);
        }
        if (feather_stream != nullptr) g.stream->AEGP_DisposeStream(feather_stream);
    }

    if (mask != nullptr) g.mask->AEGP_DisposeMask(mask);
    return err;
}

A_Err create_fixture_comp(const char *name, long width, long height,
                          const A_Ratio &pixel_aspect, const A_Time &duration,
                          const A_Ratio &frame_rate, AEGP_CompH *out)
{
    std::vector<A_UTF16Char> wide_name = utf8_to_utf16(name);
    return g.comp->AEGP_CreateComp(
        nullptr, wide_name.data(), width, height, &pixel_aspect, &duration, &frame_rate, out);
}

A_Err save_fixture_project(const std::string &path)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err == A_Err_NONE) {
        std::vector<A_UTF16Char> wide_path = utf8_to_utf16(path);
        err = g.proj->AEGP_SaveProjectToPath(project, wide_path.data());
    }
    return err;
}

A_Err set_layer_name(AEGP_LayerH layer, const char *name)
{
    std::vector<A_UTF16Char> wide_name = utf8_to_utf16(name);
    return g.layer->AEGP_SetLayerName(layer, wide_name.data());
}

A_Err create_text(AEGP_CompH comp, const char *name, const char *content,
                  double x, double y, AEGP_LayerH *out)
{
    if (g.textDocument == nullptr) return A_Err_GENERIC;
    A_Err err = g.comp->AEGP_CreateTextLayerInComp(comp, FALSE, TRUE, out);
    if (err == A_Err_NONE) err = set_layer_name(*out, name);
    if (err == A_Err_NONE) err = set_layer_position(*out, x, y);

    AEGP_StreamRefH stream = nullptr;
    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    bool have_value = false;
    if (err == A_Err_NONE) {
        err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, *out, AEGP_LayerStream_SOURCE_TEXT, &stream);
    }
    const A_Time zero = {0, 1};
    if (err == A_Err_NONE) {
        err = g.stream->AEGP_GetNewStreamValue(
            g_plugin_id, stream, AEGP_LTimeMode_LayerTime, &zero, TRUE, &value);
        have_value = err == A_Err_NONE;
    }
    std::vector<A_UTF16Char> wide_content = utf8_to_utf16(content);
    if (err == A_Err_NONE) {
        err = g.textDocument->AEGP_SetText(
            value.val.text_documentH,
            reinterpret_cast<const A_u_short *>(wide_content.data()),
            static_cast<A_long>(wide_content.size() - 1));
    }
    if (err == A_Err_NONE) err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
    if (have_value) g.stream->AEGP_DisposeStreamValue(&value);
    if (stream != nullptr) g.stream->AEGP_DisposeStream(stream);
    return err;
}

A_Err installed_effect_by_match_name(const char *wanted, AEGP_InstalledEffectKey *out)
{
    if (g.effect == nullptr) return A_Err_GENERIC;
    A_long count = 0;
    A_Err err = g.effect->AEGP_GetNumInstalledEffects(&count);
    if (err != A_Err_NONE) return err;

    AEGP_InstalledEffectKey key = AEGP_InstalledEffectKey_NONE;
    for (A_long index = 0; index < count; index += 1) {
        AEGP_InstalledEffectKey next = AEGP_InstalledEffectKey_NONE;
        err = g.effect->AEGP_GetNextInstalledEffect(key, &next);
        if (err != A_Err_NONE) return err;
        char match_name[AEGP_MAX_EFFECT_MATCH_NAME_SIZE] = {0};
        err = g.effect->AEGP_GetEffectMatchName(next, match_name);
        if (err != A_Err_NONE) return err;
        if (strcmp(match_name, wanted) == 0) {
            *out = next;
            return A_Err_NONE;
        }
        key = next;
    }
    return A_Err_GENERIC;
}

A_Err apply_fill_effect(AEGP_LayerH layer, const AEGP_ColorVal &colour,
                        int32_t *colour_stream_id)
{
    AEGP_InstalledEffectKey key = AEGP_InstalledEffectKey_NONE;
    A_Err err = installed_effect_by_match_name("ADBE Fill", &key);
    AEGP_EffectRefH effect = nullptr;
    if (err == A_Err_NONE) err = g.effect->AEGP_ApplyEffect(g_plugin_id, layer, key, &effect);

    A_long params = 0;
    if (err == A_Err_NONE) err = g.stream->AEGP_GetEffectNumParamStreams(effect, &params);
    bool found_colour = false;
    for (A_long index = 1; err == A_Err_NONE && index < params; index += 1) {
        AEGP_StreamRefH stream = nullptr;
        err = g.stream->AEGP_GetNewEffectStreamByIndex(
            g_plugin_id, effect, static_cast<PF_ParamIndex>(index), &stream);
        if (err != A_Err_NONE) break;
        AEGP_StreamType type = AEGP_StreamType_NO_DATA;
        err = g.stream->AEGP_GetStreamType(stream, &type);
        if (err == A_Err_NONE && type == AEGP_StreamType_COLOR) {
            AEGP_StreamValue2 value;
            memset(&value, 0, sizeof(value));
            value.streamH = stream;
            value.val.color = colour;
            err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
            if (err == A_Err_NONE && colour_stream_id != nullptr) {
                g.stream->AEGP_GetUniqueStreamID(stream, colour_stream_id);
            }
            found_colour = err == A_Err_NONE;
        }
        g.stream->AEGP_DisposeStream(stream);
        if (found_colour) break;
    }
    if (effect != nullptr) g.effect->AEGP_DisposeEffect(effect);
    return err == A_Err_NONE && found_colour ? A_Err_NONE : A_Err_GENERIC;
}

struct FixtureTarget {
    A_long item_id = 0;
    AEGP_LayerIDVal layer_id = 0;
    A_long source_item_id = 0;
    int32_t stream_id = 0;
};

FixtureTarget fixture_target(AEGP_CompH comp, AEGP_LayerH layer, AEGP_LayerStream which)
{
    FixtureTarget target;
    AEGP_ItemH item = nullptr;
    if (g.comp->AEGP_GetItemFromComp(comp, &item) == A_Err_NONE && item != nullptr) {
        g.item->AEGP_GetItemID(item, &target.item_id);
    }
    g.layer->AEGP_GetLayerID(layer, &target.layer_id);
    g.layer->AEGP_GetLayerSourceItemID(layer, &target.source_item_id);
    AEGP_StreamRefH stream = nullptr;
    if (g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, which, &stream) == A_Err_NONE) {
        g.stream->AEGP_GetUniqueStreamID(stream, &target.stream_id);
        g.stream->AEGP_DisposeStream(stream);
    }
    return target;
}

std::string target_json(const FixtureTarget &target)
{
    char text[240];
    sprintf_s(text, sizeof(text),
              "{\"compositionItemId\":%ld,\"layerId\":%ld,\"sourceItemId\":%ld,\"streamId\":%ld}",
              static_cast<long>(target.item_id), static_cast<long>(target.layer_id),
              static_cast<long>(target.source_item_id), static_cast<long>(target.stream_id));
    return std::string(text);
}

A_Err fixture_layer_by_id(A_long item_id, AEGP_LayerIDVal layer_id, AEGP_LayerH *out)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) return err;
    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    while (err == A_Err_NONE && item != nullptr) {
        A_long candidate_id = 0;
        AEGP_ItemType type = AEGP_ItemType_NONE;
        g.item->AEGP_GetItemID(item, &candidate_id);
        g.item->AEGP_GetItemType(item, &type);
        if (candidate_id == item_id && type == AEGP_ItemType_COMP) {
            AEGP_CompH comp = nullptr;
            err = g.comp->AEGP_GetCompFromItem(item, &comp);
            if (err == A_Err_NONE) err = g.layer->AEGP_GetLayerFromLayerID(comp, layer_id, out);
            return err;
        }
        AEGP_ItemH next = nullptr;
        err = g.item->AEGP_GetNextProjItem(project, item, &next);
        item = next;
    }
    return A_Err_GENERIC;
}

A_Err set_fixture_text(AEGP_LayerH layer, const std::string &content,
                       std::string *previous, std::string *readback)
{
    AEGP_StreamRefH stream = nullptr;
    A_Err err = g.stream->AEGP_GetNewLayerStream(
        g_plugin_id, layer, AEGP_LayerStream_SOURCE_TEXT, &stream);
    const A_Time zero = {0, 1};
    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    bool have_value = false;
    if (err == A_Err_NONE) {
        err = g.stream->AEGP_GetNewStreamValue(
            g_plugin_id, stream, AEGP_LTimeMode_LayerTime, &zero, FALSE, &value);
        have_value = err == A_Err_NONE;
    }
    if (err == A_Err_NONE) {
        AEGP_MemHandle text = nullptr;
        err = g.textDocument->AEGP_GetNewText(g_plugin_id, value.val.text_documentH, &text);
        if (err == A_Err_NONE) *previous = take_handle_string(text);
    }
    std::vector<A_UTF16Char> wide = utf8_to_utf16(content);
    if (err == A_Err_NONE) {
        err = g.textDocument->AEGP_SetText(
            value.val.text_documentH, reinterpret_cast<const A_u_short *>(wide.data()),
            static_cast<A_long>(wide.size() - 1));
    }
    if (err == A_Err_NONE) err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
    if (have_value) g.stream->AEGP_DisposeStreamValue(&value);

    AEGP_StreamValue2 confirm;
    memset(&confirm, 0, sizeof(confirm));
    bool have_confirm = false;
    if (err == A_Err_NONE) {
        err = g.stream->AEGP_GetNewStreamValue(
            g_plugin_id, stream, AEGP_LTimeMode_LayerTime, &zero, FALSE, &confirm);
        have_confirm = err == A_Err_NONE;
    }
    if (err == A_Err_NONE) {
        AEGP_MemHandle text = nullptr;
        err = g.textDocument->AEGP_GetNewText(g_plugin_id, confirm.val.text_documentH, &text);
        if (err == A_Err_NONE) *readback = take_handle_string(text);
    }
    if (have_confirm) g.stream->AEGP_DisposeStreamValue(&confirm);
    if (stream != nullptr) g.stream->AEGP_DisposeStream(stream);
    return err;
}

A_Err fill_colour_stream(AEGP_LayerH layer, AEGP_EffectRefH *effect_out,
                         AEGP_StreamRefH *stream_out)
{
    A_long effects = 0;
    A_Err err = g.effect->AEGP_GetLayerNumEffects(layer, &effects);
    for (A_long effect_index = 0; err == A_Err_NONE && effect_index < effects; effect_index += 1) {
        AEGP_EffectRefH effect = nullptr;
        err = g.effect->AEGP_GetLayerEffectByIndex(g_plugin_id, layer, effect_index, &effect);
        if (err != A_Err_NONE) break;
        AEGP_InstalledEffectKey key = AEGP_InstalledEffectKey_NONE;
        char match_name[AEGP_MAX_EFFECT_MATCH_NAME_SIZE] = {0};
        err = g.effect->AEGP_GetInstalledKeyFromLayerEffect(effect, &key);
        if (err == A_Err_NONE) err = g.effect->AEGP_GetEffectMatchName(key, match_name);
        if (err == A_Err_NONE && strcmp(match_name, "ADBE Fill") == 0) {
            A_long params = 0;
            err = g.stream->AEGP_GetEffectNumParamStreams(effect, &params);
            for (A_long index = 1; err == A_Err_NONE && index < params; index += 1) {
                AEGP_StreamRefH stream = nullptr;
                err = g.stream->AEGP_GetNewEffectStreamByIndex(
                    g_plugin_id, effect, static_cast<PF_ParamIndex>(index), &stream);
                if (err != A_Err_NONE) break;
                AEGP_StreamType type = AEGP_StreamType_NO_DATA;
                err = g.stream->AEGP_GetStreamType(stream, &type);
                if (err == A_Err_NONE && type == AEGP_StreamType_COLOR) {
                    *effect_out = effect;
                    *stream_out = stream;
                    return A_Err_NONE;
                }
                g.stream->AEGP_DisposeStream(stream);
            }
        }
        g.effect->AEGP_DisposeEffect(effect);
    }
    return A_Err_GENERIC;
}

std::string colour_hex(const AEGP_ColorVal &colour)
{
    char text[8];
    sprintf_s(text, sizeof(text), "#%02X%02X%02X",
              static_cast<int>(colour.redF * 255.0 + 0.5),
              static_cast<int>(colour.greenF * 255.0 + 0.5),
              static_cast<int>(colour.blueF * 255.0 + 0.5));
    return std::string(text);
}

bool parse_colour_hex(const std::string &text, AEGP_ColorVal *out)
{
    if (text.size() != 7 || text[0] != '#') return false;
    char *end = nullptr;
    const long value = strtol(text.c_str() + 1, &end, 16);
    if (end == nullptr || *end != '\0') return false;
    out->alphaF = 1.0;
    out->redF = static_cast<double>((value >> 16) & 0xff) / 255.0;
    out->greenF = static_cast<double>((value >> 8) & 0xff) / 255.0;
    out->blueF = static_cast<double>(value & 0xff) / 255.0;
    return true;
}

std::string do_fixture_control(const std::vector<std::string> &arguments, A_Err *err_out)
{
    if (arguments.size() < 4) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"usage: fixture-control <compositionItemId> <layerId> <PLAYER_NAME|SCORE|PLAYER_IMAGE|TEAM_COLOR|KEYFRAME_OPACITY|EXPRESSION_ROTATION> <value>\"";
    }
    const A_long item_id = strtol(arguments[0].c_str(), nullptr, 10);
    const AEGP_LayerIDVal layer_id = strtol(arguments[1].c_str(), nullptr, 10);
    const std::string &control = arguments[2];
    std::string requested = arguments[3];
    AEGP_LayerH layer = nullptr;
    A_Err err = fixture_layer_by_id(item_id, layer_id, &layer);
    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"stable item/layer target not found\"";
    }

    std::string previous;
    std::string readback;
    g.util->AEGP_StartUndoGroup("GrapiX fixture control");
    if (control == "PLAYER_NAME") {
        if (requested.empty() || requested.size() > 80) err = A_Err_PARAMETER;
        if (err == A_Err_NONE) err = set_fixture_text(layer, requested, &previous, &readback);
    } else if (control == "SCORE") {
        char *end = nullptr;
        const long score = strtol(requested.c_str(), &end, 10);
        if (end == nullptr || *end != '\0' || score < 0 || score > 999) {
            err = A_Err_PARAMETER;
        } else {
            char formatted[4];
            sprintf_s(formatted, sizeof(formatted), "%03ld", score);
            requested = formatted;
            err = set_fixture_text(layer, requested, &previous, &readback);
        }
    } else if (control == "TEAM_COLOR") {
        AEGP_ColorVal colour;
        memset(&colour, 0, sizeof(colour));
        if (!parse_colour_hex(requested, &colour)) {
            err = A_Err_PARAMETER;
        } else {
            AEGP_EffectRefH effect = nullptr;
            AEGP_StreamRefH stream = nullptr;
            err = fill_colour_stream(layer, &effect, &stream);
            if (err == A_Err_NONE) {
                const A_Time zero = {0, 1};
                AEGP_StreamValue2 value;
                memset(&value, 0, sizeof(value));
                err = g.stream->AEGP_GetNewStreamValue(
                    g_plugin_id, stream, AEGP_LTimeMode_LayerTime, &zero, FALSE, &value);
                if (err == A_Err_NONE) {
                    previous = colour_hex(value.val.color);
                    value.val.color = colour;
                    err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
                    g.stream->AEGP_DisposeStreamValue(&value);
                }
                AEGP_StreamValue2 confirm;
                memset(&confirm, 0, sizeof(confirm));
                if (err == A_Err_NONE) {
                    err = g.stream->AEGP_GetNewStreamValue(
                        g_plugin_id, stream, AEGP_LTimeMode_LayerTime, &zero, FALSE, &confirm);
                    if (err == A_Err_NONE) {
                        readback = colour_hex(confirm.val.color);
                        g.stream->AEGP_DisposeStreamValue(&confirm);
                    }
                }
            }
            if (stream != nullptr) g.stream->AEGP_DisposeStream(stream);
            if (effect != nullptr) g.effect->AEGP_DisposeEffect(effect);
        }
    } else if (control == "KEYFRAME_OPACITY") {
        AEGP_StreamRefH stream = nullptr;
        err = g.stream->AEGP_GetNewLayerStream(
            g_plugin_id, layer, AEGP_LayerStream_OPACITY, &stream);
        A_long keyframes = 0;
        if (err == A_Err_NONE) err = g.keyframe->AEGP_GetStreamNumKFs(stream, &keyframes);
        if (err == A_Err_NONE) previous = std::to_string(static_cast<long>(keyframes));
        if (err == A_Err_NONE && requested == "add") {
            const A_Time zero = {0, 1};
            AEGP_KeyframeIndex keyframe_index = 0;
            err = g.keyframe->AEGP_InsertKeyframe(
                stream, AEGP_LTimeMode_CompTime, &zero, &keyframe_index);
        } else if (err == A_Err_NONE && requested == "clear") {
            for (A_long index = keyframes; index > 0 && err == A_Err_NONE; --index) {
                err = g.keyframe->AEGP_DeleteKeyframe(
                    stream, static_cast<AEGP_KeyframeIndex>(index - 1));
            }
        } else if (err == A_Err_NONE) {
            err = A_Err_PARAMETER;
        }
        if (err == A_Err_NONE) {
            err = g.keyframe->AEGP_GetStreamNumKFs(stream, &keyframes);
            if (err == A_Err_NONE) readback = std::to_string(static_cast<long>(keyframes));
        }
        if (stream != nullptr) g.stream->AEGP_DisposeStream(stream);
    } else if (control == "EXPRESSION_ROTATION") {
        AEGP_StreamRefH stream = nullptr;
        err = g.stream->AEGP_GetNewLayerStream(
            g_plugin_id, layer, AEGP_LayerStream_ROTATION, &stream);
        A_Boolean enabled = FALSE;
        if (err == A_Err_NONE) {
            err = g.stream->AEGP_GetExpressionState(g_plugin_id, stream, &enabled);
        }
        if (err == A_Err_NONE) previous = enabled == TRUE ? "enabled" : "disabled";
        if (err == A_Err_NONE && requested == "add") {
            std::vector<A_UTF16Char> expression = utf8_to_utf16("value");
            err = g.stream->AEGP_SetExpression(g_plugin_id, stream, expression.data());
            if (err == A_Err_NONE) {
                err = g.stream->AEGP_SetExpressionState(g_plugin_id, stream, TRUE);
            }
        } else if (err == A_Err_NONE && requested == "clear") {
            err = g.stream->AEGP_SetExpressionState(g_plugin_id, stream, FALSE);
            if (err == A_Err_NONE) {
                std::vector<A_UTF16Char> expression = utf8_to_utf16("");
                err = g.stream->AEGP_SetExpression(g_plugin_id, stream, expression.data());
            }
        } else if (err == A_Err_NONE) {
            err = A_Err_PARAMETER;
        }
        if (err == A_Err_NONE) {
            err = g.stream->AEGP_GetExpressionState(g_plugin_id, stream, &enabled);
            if (err == A_Err_NONE) readback = enabled == TRUE ? "enabled" : "disabled";
        }
        if (stream != nullptr) g.stream->AEGP_DisposeStream(stream);
    } else if (control == "PLAYER_IMAGE") {
        AEGP_ColorVal colour;
        memset(&colour, 0, sizeof(colour));
        if (requested == "portrait-blue") {
            colour = {1.0, 0.10, 0.30, 0.80};
        } else if (requested == "portrait-gold") {
            colour = {1.0, 0.95, 0.55, 0.08};
        } else {
            err = A_Err_PARAMETER;
        }
        AEGP_ItemH source = nullptr;
        if (err == A_Err_NONE) err = g.layer->AEGP_GetLayerSourceItem(layer, &source);
        AEGP_ColorVal old_colour;
        memset(&old_colour, 0, sizeof(old_colour));
        if (err == A_Err_NONE) err = g.footage->AEGP_GetSolidFootageColor(source, FALSE, &old_colour);
        if (err == A_Err_NONE) previous = colour_hex(old_colour);
        AEGP_FootageH replacement = nullptr;
        if (err == A_Err_NONE) {
            err = g.footage->AEGP_NewSolidFootage(
                requested.c_str(), 210, 210, &colour, &replacement);
        }
        if (err == A_Err_NONE) {
            err = g.footage->AEGP_ReplaceItemMainFootage(replacement, source);
            replacement = nullptr;
        }
        if (replacement != nullptr) g.footage->AEGP_DisposeFootage(replacement);
        AEGP_ColorVal confirmed;
        memset(&confirmed, 0, sizeof(confirmed));
        if (err == A_Err_NONE) err = g.footage->AEGP_GetSolidFootageColor(source, FALSE, &confirmed);
        if (err == A_Err_NONE) readback = colour_hex(confirmed);
    } else {
        err = A_Err_PARAMETER;
    }
    g.util->AEGP_EndUndoGroup();

    *err_out = err;
    if (err != A_Err_NONE) {
        return std::string("\"reason\":\"fixture control refused\",\"control\":\"") +
               json_escape(control) + "\"";
    }
    return std::string("\"control\":\"") + json_escape(control) +
           "\",\"target\":{\"compositionItemId\":" + std::to_string(item_id) +
           ",\"layerId\":" + std::to_string(static_cast<long>(layer_id)) +
           "},\"previous\":\"" + json_escape(previous) +
           "\",\"requested\":\"" + json_escape(requested) +
           "\",\"readback\":\"" + json_escape(readback) + "\"";
}


/** Author the narrow §37 LOWER_THIRD fixture without pretending unavailable gates have passed.
 *  The approved third-party plugin and production AE-CD dispatch are external/later prerequisites;
 *  this project supplies stable native targets for those phases to bind and certify. */
std::string do_lower_third_fixture(const std::string &path, A_Err *err_out)
{
    const long width = 1920;
    const long height = 1080;
    const A_Ratio pixel_aspect = {1, 1};
    const A_Ratio frame_rate = {30000, 1001};
    const A_Time duration = {300000, 30000}; // ten seconds at the same rational time base
    const AEGP_ColorVal bar_colour = {1.0, 0.035, 0.045, 0.070};
    const AEGP_ColorVal team_colour = {1.0, 0.020, 0.340, 1.000};
    const AEGP_ColorVal image_colour = {1.0, 0.160, 0.190, 0.230};
    const AEGP_ColorVal white = {1.0, 1.0, 1.0, 1.0};

    AEGP_CompH comp = nullptr;
    A_Err err = create_fixture_comp(
        "LOWER_THIRD", width, height, pixel_aspect, duration, frame_rate, &comp);
    const char *failed = "composition";

    AEGP_LayerH bar = nullptr;
    if (err == A_Err_NONE) {
        failed = "BAR";
        err = create_solid(comp, duration, "BAR", 1540, 260, bar_colour,
                           960, 870, 94.0, 0.0, &bar);
    }
    if (err == A_Err_NONE) err = add_rect_mask(bar, 30, 25, 1510, 235, 18, 18);

    AEGP_LayerH team = nullptr;
    int32_t team_colour_stream_id = 0;
    if (err == A_Err_NONE) {
        failed = "TEAM_COLOR";
        err = create_solid(comp, duration, "TEAM_COLOR", 28, 210, white,
                           245, 870, 100.0, 0.0, &team);
    }
    if (err == A_Err_NONE) err = apply_fill_effect(team, team_colour, &team_colour_stream_id);

    AEGP_LayerH player_image = nullptr;
    if (err == A_Err_NONE) {
        failed = "PLAYER_IMAGE";
        err = create_solid(comp, duration, "PLAYER_IMAGE", 210, 210, image_colour,
                           380, 870, 100.0, 0.0, &player_image);
    }
    if (err == A_Err_NONE) err = add_rect_mask(player_image, 10, 10, 200, 200, 12, 12);

    AEGP_LayerH player_name = nullptr;
    if (err == A_Err_NONE) {
        failed = "PLAYER_NAME";
        err = create_text(comp, "PLAYER_NAME", "MAYA RIVERA", 530, 825, &player_name);
    }

    AEGP_LayerH score = nullptr;
    if (err == A_Err_NONE) {
        failed = "SCORE";
        err = create_text(comp, "SCORE", "042", 1430, 875, &score);
    }

    FixtureTarget name_target;
    FixtureTarget score_target;
    FixtureTarget image_target;
    FixtureTarget colour_target;
    if (err == A_Err_NONE) {
        name_target = fixture_target(comp, player_name, AEGP_LayerStream_SOURCE_TEXT);
        score_target = fixture_target(comp, score, AEGP_LayerStream_SOURCE_TEXT);
        image_target = fixture_target(comp, player_image, AEGP_LayerStream_OPACITY);
        AEGP_ItemH item = nullptr;
        if (g.comp->AEGP_GetItemFromComp(comp, &item) == A_Err_NONE && item != nullptr) {
            g.item->AEGP_GetItemID(item, &colour_target.item_id);
        }
        g.layer->AEGP_GetLayerID(team, &colour_target.layer_id);
        colour_target.stream_id = team_colour_stream_id;
    }

    if (err == A_Err_NONE) err = save_fixture_project(path);
    if (err != A_Err_NONE) {
        *err_out = err;
        return std::string("\"reason\":\"could not author LOWER_THIRD\",\"target\":\"") + failed + "\"";
    }

    *err_out = A_Err_NONE;
    return std::string(
        "\"fixture\":\"lower-third-v1\",\"composition\":\"LOWER_THIRD\","
        "\"width\":1920,\"height\":1080,\"frameRate\":\"30000/1001\",\"savedTo\":\"") +
        json_escape(path) + "\",\"targets\":{\"PLAYER_NAME\":" + target_json(name_target) +
        ",\"SCORE\":" + target_json(score_target) +
        ",\"PLAYER_IMAGE\":" + target_json(image_target) +
        ",\"TEAM_COLOR\":" + target_json(colour_target) +
        "},\"externalGate\":\"approved licensed third-party plugin not provisioned\"";
}


/** BO0a's adversarial alpha vectors. Each composition isolates one pixel condition so a
 *  comparator can name the failure rather than merely report that a montage changed. */
std::string do_edge_corpus_fixture(const std::string &path, A_Err *err_out)
{
    const long width = 640;
    const long height = 360;
    const A_Ratio pixel_aspect = {1, 1};
    const A_Ratio frame_rate = {25, 1};
    const A_Time duration = {1, 1};

    const AEGP_ColorVal red = {1.0, 1.0, 0.0, 0.0};
    const AEGP_ColorVal cyan = {1.0, 0.0, 1.0, 1.0};
    const AEGP_ColorVal yellow = {1.0, 1.0, 1.0, 0.0};
    const AEGP_ColorVal magenta = {1.0, 1.0, 0.0, 1.0};
    const AEGP_ColorVal violet = {1.0, 0.55, 0.10, 1.0};
    const AEGP_ColorVal orange = {1.0, 1.0, 0.28, 0.02};
    const AEGP_ColorVal white = {1.0, 1.0, 1.0, 1.0};

    A_Err err = A_Err_NONE;
    const char *failed_case = "";
    AEGP_CompH comp = nullptr;
    AEGP_LayerH layer = nullptr;

    if (err == A_Err_NONE) {
        failed_case = "Opaque";
        err = create_fixture_comp("BO0a-Opaque", width, height, pixel_aspect, duration, frame_rate, &comp);
        if (err == A_Err_NONE) {
            err = create_solid(comp, duration, "opaque-red", width, height, red,
                               width * 0.5, height * 0.5, 100.0, 0.0, &layer);
        }
    }
    if (err == A_Err_NONE) {
        failed_case = "ZeroAlpha";
        err = create_fixture_comp("BO0a-ZeroAlpha", width, height, pixel_aspect, duration, frame_rate, &comp);
    }
    if (err == A_Err_NONE) {
        failed_case = "HardEdge";
        err = create_fixture_comp("BO0a-HardEdge", width, height, pixel_aspect, duration, frame_rate, &comp);
        if (err == A_Err_NONE) {
            err = create_solid(comp, duration, "hard-cyan", 300, 160, cyan,
                               width * 0.5, height * 0.5, 100.0, 0.0, &layer);
        }
    }
    if (err == A_Err_NONE) {
        failed_case = "AntialiasedEdge";
        err = create_fixture_comp("BO0a-AntialiasedEdge", width, height, pixel_aspect, duration, frame_rate, &comp);
        if (err == A_Err_NONE) {
            err = create_solid(comp, duration, "rotated-yellow", 330, 118, yellow,
                               width * 0.5, height * 0.5, 100.0, 23.0, &layer);
        }
    }
    if (err == A_Err_NONE) {
        failed_case = "Gradient50";
        err = create_fixture_comp("BO0a-Gradient50", width, height, pixel_aspect, duration, frame_rate, &comp);
        if (err == A_Err_NONE) {
            err = create_solid(comp, duration, "gradient-magenta", 500, 280, magenta,
                               width * 0.5, height * 0.5, 100.0, 0.0, &layer);
        }
        if (err == A_Err_NONE) err = add_rect_mask(layer, 80, 60, 420, 220, 90, 90);
    }
    if (err == A_Err_NONE) {
        failed_case = "ColouredTranslucentShadow";
        err = create_fixture_comp("BO0a-ColouredTranslucentShadow", width, height,
                                  pixel_aspect, duration, frame_rate, &comp);
        if (err == A_Err_NONE) {
            err = create_solid(comp, duration, "violet-shadow", 430, 240, violet,
                               360, 210, 62.0, 0.0, &layer);
        }
        if (err == A_Err_NONE) err = add_rect_mask(layer, 70, 50, 360, 190, 48, 48);
        if (err == A_Err_NONE) {
            err = create_solid(comp, duration, "orange-caster", 285, 105, orange,
                               290, 145, 100.0, 0.0, &layer);
        }
    }
    if (err == A_Err_NONE) {
        failed_case = "PremultipliedBlackEdge";
        err = create_fixture_comp("BO0a-PremultipliedBlackEdge", width, height,
                                  pixel_aspect, duration, frame_rate, &comp);
        if (err == A_Err_NONE) {
            err = create_solid(comp, duration, "soft-white", 440, 240, white,
                               width * 0.5, height * 0.5, 100.0, 0.0, &layer);
        }
        if (err == A_Err_NONE) err = add_rect_mask(layer, 58, 42, 382, 198, 30, 30);
    }

    if (err == A_Err_NONE) err = save_fixture_project(path);
    if (err != A_Err_NONE) {
        *err_out = err;
        return std::string("\"reason\":\"could not author BO0a edge case\",\"case\":\"") +
               failed_case + "\"";
    }

    *err_out = A_Err_NONE;
    return std::string(
        "\"fixture\":\"edge-corpus-v1\",\"width\":640,\"height\":360,\"frameRate\":\"25/1\","
        "\"savedTo\":\"") + json_escape(path) +
        "\",\"compositions\":[\"BO0a-Opaque\",\"BO0a-ZeroAlpha\",\"BO0a-HardEdge\","
        "\"BO0a-AntialiasedEdge\",\"BO0a-Gradient50\",\"BO0a-ColouredTranslucentShadow\","
        "\"BO0a-PremultipliedBlackEdge\"]";
}


/** Build the alpha probe this phase has been missing, and save it.
 *
 *  AE-F0 cannot settle premultiplication or channel order against the fixtures this repository
 *  has: they are .aep *parser* fixtures whose layers carry no renderable source, so every frame
 *  they render is uniformly transparent and every alpha hypothesis fits it equally well. This
 *  builds the smallest composition that can *falsify* one:
 *
 *    top-left  quadrant  pure red at 100% opacity   -> alpha 255, and red identifies its channel
 *    top-right quadrant  pure green at 50% opacity  -> alpha ~128 with colour, the decisive case
 *    bottom    half      nothing                    -> alpha 0
 *
 *  The 50% quadrant is what does the work. Under premultiplied alpha its green channel must be
 *  about 128; under straight alpha it stays 255. One frame therefore separates the two, and the
 *  red/green split separates BGRA from ARGB at the same time.
 *
 *  It is saved so that `aerender` can produce the independent reference from the same file — the
 *  comparison is worthless if the adapter is the only thing that has ever seen this composition. */
std::string do_fixture(const std::vector<std::string> &arguments, A_Err *err_out)
{
    if (arguments.empty()) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"usage: fixture <absolute .aep path to write> [alpha-probe|edge-corpus|lower-third]\"";
    }
    if (arguments.size() >= 2 && arguments[1] == "edge-corpus") {
        return do_edge_corpus_fixture(arguments[0], err_out);
    }
    if (arguments.size() >= 2 && arguments[1] == "lower-third") {
        return do_lower_third_fixture(arguments[0], err_out);
    }

    const long width = 640;
    const long height = 360;
    const A_Ratio pixel_aspect = {1, 1};
    const A_Ratio frame_rate = {25, 1};
    const A_Time duration = {1, 1};

    std::vector<A_UTF16Char> comp_name = utf8_to_utf16("AlphaProbe");
    AEGP_CompH comp = nullptr;
    A_Err err = g.comp->AEGP_CreateComp(
        nullptr, comp_name.data(),
        width, height, &pixel_aspect, &duration, &frame_rate, &comp);
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"AEGP_CreateComp failed\""; }

    const AEGP_ColorVal red = {1.0, 1.0, 0.0, 0.0};
    const AEGP_ColorVal green = {1.0, 0.0, 1.0, 0.0};

    AEGP_LayerH opaque_layer = nullptr;
    err = create_solid(comp, duration, "opaque-red", width / 2, height / 2, red,
                       width * 0.25, height * 0.25, 100.0, 0.0, &opaque_layer);
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"could not build the opaque quadrant\""; }

    AEGP_LayerH half_layer = nullptr;
    err = create_solid(comp, duration, "half-green", width / 2, height / 2, green,
                       width * 0.75, height * 0.25, 50.0, 0.0, &half_layer);
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"could not build the 50% quadrant\""; }

    err = save_fixture_project(arguments[0]);
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"AEGP_SaveProjectToPath failed\""; }

    char text[900];
    sprintf_s(text, sizeof(text),
              "\"comp\":\"AlphaProbe\",\"width\":%ld,\"height\":%ld,\"frameRate\":\"25/1\","
              "\"savedTo\":\"%s\",\"expect\":{"
              "\"topLeft\":\"alpha 255, red 255, green 0 — identifies the red channel\","
              "\"topRight\":\"alpha ~128; green ~128 if premultiplied, 255 if straight\","
              "\"bottomHalf\":\"alpha 0\"}",
              width, height, json_escape(arguments[0]).c_str());
    *err_out = A_Err_NONE;
    return std::string(text);
}

/** The nth composition's *item*, which is what render options are built from. */
A_Err comp_item_by_index(long wanted, AEGP_ItemH *out, std::string *name)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) return err;

    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    if (err != A_Err_NONE) return err;

    long seen = 0;
    while (item != nullptr) {
        AEGP_ItemType type = AEGP_ItemType_NONE;
        if (g.item->AEGP_GetItemType(item, &type) == A_Err_NONE && type == AEGP_ItemType_COMP) {
            if (seen == wanted) {
                if (name != nullptr) {
                    AEGP_MemHandle handle = nullptr;
                    if (g.item->AEGP_GetItemName(g_plugin_id, item, &handle) == A_Err_NONE) {
                        *name = take_handle_string(handle);
                    }
                }
                *out = item;
                return A_Err_NONE;
            }
            seen += 1;
        }
        AEGP_ItemH next = nullptr;
        if (g.item->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) break;
        item = next;
    }
    return A_Err_GENERIC;
}

/** Statistics computed over the checked-out buffer, in the adapter, so the alpha question is
 *  answered from pixels rather than from a container that declines to declare it. A premultiplied
 *  buffer can never carry a colour channel above its alpha; a straight one can. */

/** Named lookup makes a certification manifest stable when a fixture gains another composition.
 *  Numeric composition indices remain supported for the original spike commands. */
A_Err comp_item_by_name(const std::string &wanted, AEGP_ItemH *out, std::string *name)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) return err;

    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    if (err != A_Err_NONE) return err;

    while (item != nullptr) {
        AEGP_ItemType type = AEGP_ItemType_NONE;
        if (g.item->AEGP_GetItemType(item, &type) == A_Err_NONE && type == AEGP_ItemType_COMP) {
            AEGP_MemHandle handle = nullptr;
            if (g.item->AEGP_GetItemName(g_plugin_id, item, &handle) == A_Err_NONE) {
                std::string candidate = take_handle_string(handle);
                if (candidate == wanted) {
                    if (name != nullptr) *name = candidate;
                    *out = item;
                    return A_Err_NONE;
                }
            }
        }
        AEGP_ItemH next = nullptr;
        if (g.item->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) break;
        item = next;
    }
    return A_Err_GENERIC;
}

/** Stable-identity lookup: the item id `LIST_COMPOSITIONS` publishes and every descriptor carries.
 *
 *  This is the form the runtime protocol uses. An index moves when a project is reordered and names
 *  repeat across a fixture corpus, so neither can correlate a render request with the descriptor it
 *  produces — the id can, and `AE-F2a`'s ingress already refuses a composition mismatch by it. */
A_Err comp_item_by_id(A_long wanted, AEGP_ItemH *out, std::string *name)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) return err;

    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    if (err != A_Err_NONE) return err;

    while (item != nullptr) {
        AEGP_ItemType type = AEGP_ItemType_NONE;
        A_long candidate = 0;
        if (g.item->AEGP_GetItemType(item, &type) == A_Err_NONE && type == AEGP_ItemType_COMP &&
            g.item->AEGP_GetItemID(item, &candidate) == A_Err_NONE && candidate == wanted) {
            if (name != nullptr) {
                AEGP_MemHandle handle = nullptr;
                if (g.item->AEGP_GetItemName(g_plugin_id, item, &handle) == A_Err_NONE) {
                    *name = take_handle_string(handle);
                }
            }
            *out = item;
            return A_Err_NONE;
        }
        AEGP_ItemH next = nullptr;
        if (g.item->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) break;
        item = next;
    }
    return A_Err_GENERIC;
}

struct PixelStats {
    unsigned long long opaque = 0ULL;
    unsigned long long transparent = 0ULL;
    unsigned long long partial = 0ULL;
    unsigned long long colourAboveAlpha = 0ULL;
    unsigned long long colourAtZeroAlpha = 0ULL;
    unsigned int worstExcess = 0U;
    unsigned char minChannel[4] = {255, 255, 255, 255};
    unsigned char maxChannel[4] = {0, 0, 0, 0};
};

// `checkout ... ring ...` is intentionally an opt-in extension of the existing send.sh verb,
// rather than a new command surface. It keeps AE-F2a's one live producer reachable on a licensed
// host without exposing a second renderer or another control transport.
struct RingPublishRequest {
    bool enabled = false;
    std::string render_request_id;
    std::uint64_t data_revision = 0;
    std::uint64_t frame_id = 0;
    std::uint64_t presentation_deadline_nanos = 0;
};

struct RingPublishOutcome {
    bool attempted = false;
    bool published = false;
    bool back_pressure = false;
    grapix::FrameRingResult result = grapix::FrameRingResult::Ok;
    std::uint32_t slot_index = 0;
    std::uint64_t generation = 0;
    std::string error_code;
    std::string error_message;
};

bool parse_u64_decimal(const std::string &text, std::uint64_t *out)
{
    if (out == nullptr || text.empty()) return false;
    std::uint64_t value = 0;
    for (unsigned char character : text) {
        if (character < '0' || character > '9') return false;
        const std::uint64_t digit = static_cast<std::uint64_t>(character - '0');
        if (value > ((std::numeric_limits<std::uint64_t>::max)() - digit) / 10U) return false;
        value = value * 10U + digit;
    }
    *out = value;
    return true;
}

template <std::size_t N>
bool copy_decimal(char (&target)[N], const std::string &source)
{
    if (source.empty() || source.size() >= N) return false;
    memcpy(target, source.data(), source.size());
    target[source.size()] = '\0';
    return true;
}

bool checkout_ring_request(const std::vector<std::string> &arguments, RingPublishRequest *out,
                           std::string *reason)
{
    if (out == nullptr || reason == nullptr) return false;
    if (arguments.size() <= 5) return true;
    if (arguments.size() != 10 || arguments[5] != "ring") {
        *reason = "usage: checkout <compIndex> <frame> [8|16|32] [straight|premul-black|premul-bg] "
                  "[argb|bgra] [ring <renderRequestId> <dataRevision> <frameId> <presentationDeadlineNanos>]";
        return false;
    }
    RingPublishRequest request;
    request.enabled = true;
    request.render_request_id = arguments[6];
    if (request.render_request_id.empty() || request.render_request_id.size() > 128U ||
        !parse_u64_decimal(arguments[7], &request.data_revision) ||
        request.data_revision > static_cast<std::uint64_t>((std::numeric_limits<std::int64_t>::max)()) ||
        !parse_u64_decimal(arguments[8], &request.frame_id) ||
        !parse_u64_decimal(arguments[9], &request.presentation_deadline_nanos)) {
        *reason = "ring publish requires a non-empty request id and decimal data revision, frame id and deadline";
        return false;
    }
    *out = request;
    return true;
}

const char *frame_ring_result_name(grapix::FrameRingResult result)
{
    switch (result) {
        case grapix::FrameRingResult::Ok: return "OK";
        case grapix::FrameRingResult::BackPressure: return "BACK_PRESSURE";
        case grapix::FrameRingResult::InvalidConfiguration: return "INVALID_CONFIGURATION";
        case grapix::FrameRingResult::InvalidMapping: return "INVALID_MAPPING";
        case grapix::FrameRingResult::InvalidLength: return "INVALID_LENGTH";
        case grapix::FrameRingResult::InvalidDescriptor: return "INVALID_DESCRIPTOR";
        case grapix::FrameRingResult::StaleGeneration: return "STALE_GENERATION";
        case grapix::FrameRingResult::StaleRevision: return "STALE_REVISION";
        case grapix::FrameRingResult::ChecksumFault: return "CHECKSUM_FAULT";
        case grapix::FrameRingResult::NotOwner: return "NOT_OWNER";
        case grapix::FrameRingResult::NotReady: return "NOT_READY";
        case grapix::FrameRingResult::PeerStillAlive: return "PEER_STILL_ALIVE";
        case grapix::FrameRingResult::FormatChangePending: return "FORMAT_CHANGE_PENDING";
    }
    return "UNKNOWN";
}

bool runtime_session_for_ring(std::string *out)
{
    char session[65] = {0};
    const DWORD length = GetEnvironmentVariableA("GRAPIX_AE_RUNTIME_SESSION_ID", session, sizeof(session));
    if (out == nullptr || length == 0 || length >= sizeof(session)) return false;
    for (unsigned char character : std::string(session, length)) {
        if (!std::isalnum(character) && character != '-') return false;
    }
    *out = std::string(session, length);
    return true;
}

grapix::FrameRingResult ensure_ae_frame_ring(std::uint32_t width, std::uint32_t height,
                                             std::uint32_t stride)
{
    std::string session_id;
    if (!runtime_session_for_ring(&session_id)) return grapix::FrameRingResult::InvalidConfiguration;

    if (g_ae_frame_ring != nullptr) {
        const grapix::FrameRingHeader *header = g_ae_frame_ring->header();
        if (session_id != g_ae_frame_ring_session_id || header == nullptr ||
            width > header->max_width || height > header->max_height || stride > header->max_stride) {
            return grapix::FrameRingResult::InvalidConfiguration;
        }
        return grapix::FrameRingResult::Ok;
    }

    // The consumer derives this exact Local mapping name from the authenticated runtime session id.
    // No caller chooses a path or mapping name, and a session change never repoints an in-use producer.
    g_ae_frame_ring_name = L"Local\\GrapiX-AeFrameRing-v1-";
    g_ae_frame_ring_name.append(session_id.begin(), session_id.end());
    const grapix::FrameRingConfig config = {
        4U, width, height, stride, grapix::FrameRingColorFormat::Bgra8
    };
    std::unique_ptr<grapix::SharedFrameRing> ring;
    const grapix::FrameRingResult result = grapix::SharedFrameRing::Create(
        g_ae_frame_ring_name, config, static_cast<std::uint64_t>(GetCurrentProcessId()), &ring);
    if (result == grapix::FrameRingResult::Ok) {
        g_ae_frame_ring = std::move(ring);
        g_ae_frame_ring_session_id = session_id;
    }
    return result;
}

RingPublishOutcome publish_argb8_frame(const RingPublishRequest &request, std::int64_t composition_item_id,
                                       const A_Time &evaluated_time, const unsigned char *base,
                                       A_long width, A_long height, A_u_long row_bytes)
{
    RingPublishOutcome outcome;
    outcome.attempted = true;
    if (base == nullptr || width <= 0 || height <= 0 || row_bytes == 0 ||
        static_cast<unsigned long long>(row_bytes) <
            static_cast<unsigned long long>(width) * 4ULL) {
        outcome.result = grapix::FrameRingResult::InvalidDescriptor;
        outcome.error_code = "AE_IMPOSSIBLE_GEOMETRY";
        outcome.error_message = "the checked-out ARGB8 world has an impossible width, height or stride";
        return outcome;
    }

    const std::uint32_t frame_width = static_cast<std::uint32_t>(width);
    const std::uint32_t frame_height = static_cast<std::uint32_t>(height);
    const std::uint32_t stride = static_cast<std::uint32_t>(row_bytes);
    outcome.result = ensure_ae_frame_ring(frame_width, frame_height, stride);
    if (outcome.result != grapix::FrameRingResult::Ok) {
        outcome.error_code = "FRAME_RING_" + std::string(frame_ring_result_name(outcome.result));
        outcome.error_message = "the adapter could not create or use its session frame ring";
        return outcome;
    }

    grapix::FrameRingWriteLease lease;
    outcome.result = g_ae_frame_ring->acquire_write(&lease);
    if (outcome.result == grapix::FrameRingResult::BackPressure) {
        outcome.back_pressure = true;
        outcome.error_code = "FRAME_RING_BACKPRESSURE";
        outcome.error_message = "the frame ring is full; the evaluated frame was dropped";
        return outcome;
    }
    if (outcome.result != grapix::FrameRingResult::Ok) {
        outcome.error_code = "FRAME_RING_" + std::string(frame_ring_result_name(outcome.result));
        outcome.error_message = "the adapter could not acquire a frame-ring write lease";
        return outcome;
    }

    // C4 established that ARGB is AE's stable observed 8-bit checkout layout. We always request it
    // below, then write the lease directly as BGRA: [A,R,G,B] -> [B,G,R,A]. This explicit swizzle
    // preserves premultiplied components and labels the descriptor's stored layout, never the request.
    const std::size_t byte_length = static_cast<std::size_t>(stride) * frame_height;
    bool copied = byte_length <= lease.capacity;
    if (copied) {
        const std::size_t packed_row = static_cast<std::size_t>(frame_width) * 4U;
        for (std::uint32_t y = 0; y < frame_height; ++y) {
            const unsigned char *source = base + static_cast<std::size_t>(y) * stride;
            std::uint8_t *destination = lease.bytes + static_cast<std::size_t>(y) * stride;
            for (std::size_t x = 0; x < packed_row; x += 4U) {
                destination[x] = source[x + 3U];
                destination[x + 1U] = source[x + 2U];
                destination[x + 2U] = source[x + 1U];
                destination[x + 3U] = source[x];
            }
            // Padding is not pixel data; make it deterministic rather than copying AE-owned slack.
            memset(destination + packed_row, 0, stride - packed_row);
        }
    }

    grapix::FrameRingDescriptor descriptor;
    descriptor.ring_generation = lease.generation;
    descriptor.slot_index = lease.slot_index;
    descriptor.frame_id = request.frame_id;
    descriptor.data_revision = request.data_revision;
    descriptor.composition_item_id = composition_item_id;
    copied = copied &&
        copy_decimal(descriptor.requested_time_value, std::to_string(static_cast<long long>(evaluated_time.value))) &&
        copy_decimal(descriptor.requested_time_scale, std::to_string(static_cast<long long>(evaluated_time.scale))) &&
        copy_decimal(descriptor.evaluated_time_value, std::to_string(static_cast<long long>(evaluated_time.value))) &&
        copy_decimal(descriptor.evaluated_time_scale, std::to_string(static_cast<long long>(evaluated_time.scale)));
    descriptor.presentation_deadline_nanos = request.presentation_deadline_nanos;
    descriptor.width = frame_width;
    descriptor.height = frame_height;
    descriptor.stride = stride; // This is AEGP_GetRowBytes, never an assumed four-byte pitch.
    descriptor.color_format = grapix::FrameRingColorFormat::Bgra8;
    descriptor.alpha_mode = grapix::FrameRingAlphaMode::Premultiplied;
    strcpy_s(descriptor.color_space, "sRGB");
    descriptor.status = grapix::FrameRingFrameStatus::Ready;

    outcome.result = copied ? g_ae_frame_ring->publish(lease, descriptor, byte_length)
                             : grapix::FrameRingResult::InvalidLength;
    if (outcome.result != grapix::FrameRingResult::Ok) {
        // Every acquired lease is returned on failure. A Writing slot must never survive a bad
        // descriptor, an unexpected capacity mismatch or a rejected publish.
        g_ae_frame_ring->cancel_write(lease);
        outcome.error_code = "FRAME_RING_" + std::string(frame_ring_result_name(outcome.result));
        outcome.error_message = "the adapter could not publish the checked-out frame";
        return outcome;
    }
    outcome.published = true;
    outcome.slot_index = lease.slot_index;
    outcome.generation = lease.generation;
    return outcome;
}

std::string ring_publish_outcome_json(const RingPublishOutcome &outcome)
{
    if (!outcome.attempted) return "{\"outcome\":\"not-requested\"}";
    if (outcome.published) {
        return "{\"outcome\":\"published\",\"slotIndex\":" + std::to_string(outcome.slot_index) +
            ",\"ringGeneration\":\"" + std::to_string(outcome.generation) + "\"}";
    }
    return "{\"outcome\":\"" + std::string(outcome.back_pressure ? "backpressure" : "refused") +
        "\",\"code\":\"" + json_escape(outcome.error_code) + "\",\"message\":\"" +
        json_escape(outcome.error_message) + "\"}";
}

bool emit_render_ready_event(const std::string &render_request_id, std::int64_t composition_item_id,
                             const std::string &time_json, std::int64_t data_revision,
                             const std::string &frame_id, const std::string &presentation_deadline_nanos);
bool emit_render_failed_event(const std::string &render_request_id, std::int64_t composition_item_id,
                              const std::string &time_json, const std::string &data_revision_json,
                              const std::string &error_code, const std::string &error_message, bool retryable);

/** Check out one composition frame and describe it. Deliberately synchronous and on the idle
 *  (host callback) thread: the header marks the UI-thread synchronous call deprecated for
 *  interactive plugins, and recording what it actually does here is exactly this phase's job. */
std::string do_checkout(const std::vector<std::string> &arguments, A_Err *err_out, bool write_payload = true)
{
    if (g.renderOptions == nullptr || g.render == nullptr || g.world == nullptr) {
        *err_out = A_Err_GENERIC;
        return "\"reason\":\"render/world suites unavailable; this AE build did not supply them\"";
    }
    if (arguments.size() < 2) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"usage: checkout <compIndex> <frame> [8|16|32] [straight|premul-black|premul-bg] [argb|bgra] [ring <renderRequestId> <dataRevision> <frameId> <presentationDeadlineNanos>]\"";
    }
    RingPublishRequest ring_request;
    std::string ring_request_error;
    if (!checkout_ring_request(arguments, &ring_request, &ring_request_error)) {
        *err_out = A_Err_PARAMETER;
        return std::string("\"reason\":\"") + ring_request_error + "\"";
    }

    // Three selector forms. An index is the AE-A0 spike's shape and a name is the readable one, but
    // neither is stable identity: an index moves when the project is reordered and names repeat. The
    // runtime protocol therefore addresses a composition by `id:<itemId>` — the same stable item id
    // `LIST_COMPOSITIONS` publishes and every descriptor carries.
    const char *selector_text = arguments[0].c_str();
    const bool selector_is_item_id = arguments[0].rfind("id:", 0) == 0;
    if (selector_is_item_id) selector_text = arguments[0].c_str() + 3;
    char *selector_end = nullptr;
    const long comp_selector = strtol(selector_text, &selector_end, 10);
    const bool selector_is_index = !selector_is_item_id && selector_end != selector_text && *selector_end == '\0';
    if (selector_is_item_id && (selector_end == selector_text || *selector_end != '\0')) {
        *err_out = A_Err_PARAMETER;
        return "\"reason\":\"id: selector needs a decimal composition item id\"";
    }
    const long frame = strtol(arguments[1].c_str(), nullptr, 10);

    AEGP_WorldType requested_type = AEGP_WorldType_8;
    if (arguments.size() >= 3) {
        if (arguments[2] == "8") requested_type = AEGP_WorldType_8;
        else if (arguments[2] == "16") requested_type = AEGP_WorldType_16;
        else if (arguments[2] == "32") requested_type = AEGP_WorldType_32;
        else { *err_out = A_Err_PARAMETER; return "\"reason\":\"depth must be 8, 16 or 32\""; }
    }

    // ARGB is the stable observed 8-bit world layout (AE-F0 C4). BGRA output is produced by our
    // explicit swizzle into the ring; asking AE for BGRA can alternate layouts by call count.
    AEGP_MatteMode matte = AEGP_MatteMode_PREMUL_BLACK;
    if (arguments.size() >= 4) {
        if (arguments[3] == "straight") matte = AEGP_MatteMode_STRAIGHT;
        else if (arguments[3] == "premul-black") matte = AEGP_MatteMode_PREMUL_BLACK;
        else if (arguments[3] == "premul-bg") matte = AEGP_MatteMode_PREMUL_BG_COLOR;
        else { *err_out = A_Err_PARAMETER; return "\"reason\":\"matte must be straight, premul-black or premul-bg\""; }
    }

    AEGP_ChannelOrder order = AEGP_ChannelOrder_ARGB;
    if (arguments.size() >= 5) {
        if (arguments[4] == "argb") order = AEGP_ChannelOrder_ARGB;
        else if (arguments[4] == "bgra") order = AEGP_ChannelOrder_BGRA;
        else { *err_out = A_Err_PARAMETER; return "\"reason\":\"order must be argb or bgra\""; }
    }
    if (ring_request.enabled) order = AEGP_ChannelOrder_ARGB;

    AEGP_ItemH item = nullptr;
    std::string comp_name;
    A_Err err = A_Err_NONE;
    if (selector_is_item_id) {
        err = comp_item_by_id(static_cast<A_long>(comp_selector), &item, &comp_name);
    } else if (selector_is_index) {
        err = comp_item_by_index(comp_selector, &item, &comp_name);
    } else {
        err = comp_item_by_name(arguments[0], &item, &comp_name);
    }
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"composition not found\""; }
    A_long item_id = 0;
    err = g.item->AEGP_GetItemID(item, &item_id);
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"AEGP_GetItemID failed\""; }

    AEGP_CompH comp = nullptr;
    err = g.comp->AEGP_GetCompFromItem(item, &comp);
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"AEGP_GetCompFromItem failed\""; }

    // Frame -> time as an exact rational multiple of the comp's own frame duration. Deriving it
    // from a float frame rate would put 30000/1001 material a fraction off every frame boundary.
    A_Time frame_duration = {0, 1};
    err = g.comp->AEGP_GetCompFrameDuration(comp, &frame_duration);
    if (err != A_Err_NONE) { *err_out = err; return "\"reason\":\"AEGP_GetCompFrameDuration failed\""; }

    A_Time render_time;
    render_time.scale = frame_duration.scale;
    render_time.value = frame_duration.value * frame;

    AEGP_RenderOptionsH options = nullptr;
    err = g.renderOptions->AEGP_NewFromItem(g_plugin_id, item, &options);
    const std::string render_time_json = "{\"value\":\"" +
        std::to_string(static_cast<long long>(render_time.value)) + "\",\"scale\":\"" +
        std::to_string(static_cast<long long>(render_time.scale)) + "\"}";
    const auto emit_ring_failure = [&](const std::string &code, const std::string &message, bool retryable) {
        if (ring_request.enabled) {
            emit_render_failed_event(ring_request.render_request_id, static_cast<std::int64_t>(item_id),
                                     render_time_json, std::to_string(ring_request.data_revision),
                                     code, message, retryable);
        }
    };
    if (err != A_Err_NONE) {
        emit_ring_failure("AE_RENDER_OPTIONS_FAILED", "AEGP_NewFromItem failed", false);
        *err_out = err;
        return "\"reason\":\"AEGP_NewFromItem failed\"";
    }

    std::string failure;
    if (err == A_Err_NONE) err = g.renderOptions->AEGP_SetTime(options, render_time);
    if (err != A_Err_NONE && failure.empty()) failure = "AEGP_SetTime";
    if (err == A_Err_NONE) err = g.renderOptions->AEGP_SetTimeStep(options, frame_duration);
    if (err != A_Err_NONE && failure.empty()) failure = "AEGP_SetTimeStep";

    // Full resolution, stated rather than inherited. AEGP_NewFromItem hands back the
    // composition's *current* options, which carry whatever downsample factor the Composition
    // panel happens to be showing: the first checkout on this machine returned 480x270 for a
    // 1920x1080 comp because the panel sat at quarter resolution. A pixel gate compared against a
    // full-resolution reference would have failed on the operator's zoom level.
    if (err == A_Err_NONE) err = g.renderOptions->AEGP_SetDownsampleFactor(options, 1, 1);
    if (err != A_Err_NONE && failure.empty()) failure = "AEGP_SetDownsampleFactor";
    if (err == A_Err_NONE) err = g.renderOptions->AEGP_SetRenderQuality(options, AEGP_ItemQuality_BEST);
    if (err != A_Err_NONE && failure.empty()) failure = "AEGP_SetRenderQuality";
    if (err == A_Err_NONE) err = g.renderOptions->AEGP_SetWorldType(options, requested_type);
    if (err != A_Err_NONE && failure.empty()) failure = "AEGP_SetWorldType";
    if (err == A_Err_NONE) err = g.renderOptions->AEGP_SetMatteMode(options, matte);
    if (err != A_Err_NONE && failure.empty()) failure = "AEGP_SetMatteMode";
    if (err == A_Err_NONE) err = g.renderOptions->AEGP_SetChannelOrder(options, order);
    if (err != A_Err_NONE && failure.empty()) failure = "AEGP_SetChannelOrder";

    if (err != A_Err_NONE) {
        g.renderOptions->AEGP_Dispose(options);
        emit_ring_failure("AE_RENDER_OPTIONS_FAILED", failure + " refused the requested configuration", false);
        *err_out = err;
        return std::string("\"reason\":\"") + failure + " refused the requested configuration\"";
    }

    const DWORD started_at = GetTickCount();
    AEGP_FrameReceiptH receipt = nullptr;
    err = g.render->AEGP_RenderAndCheckoutFrame(options, nullptr, nullptr, &receipt);
    const DWORD render_ms = GetTickCount() - started_at;

    if (err != A_Err_NONE) {
        g.renderOptions->AEGP_Dispose(options);
        emit_ring_failure("AE_RENDER_FAILED", "AEGP_RenderAndCheckoutFrame failed", true);
        *err_out = err;
        char text[256];
        sprintf_s(text, sizeof(text),
                  "\"reason\":\"AEGP_RenderAndCheckoutFrame failed\",\"renderMs\":%lu", render_ms);
        return std::string(text);
    }

    AEGP_WorldH world = nullptr;
    AEGP_WorldType actual_type = AEGP_WorldType_NONE;
    A_long width = 0;
    A_long height = 0;
    A_u_long row_bytes = 0;
    const unsigned char *base = nullptr;

    err = g.render->AEGP_GetReceiptWorld(receipt, &world);
    if (err == A_Err_NONE) err = g.world->AEGP_GetType(world, &actual_type);
    if (err == A_Err_NONE) err = g.world->AEGP_GetSize(world, &width, &height);
    if (err == A_Err_NONE) err = g.world->AEGP_GetRowBytes(world, &row_bytes);

    // Bytes per pixel follows the world type, and the getter is type-specific: calling
    // GetBaseAddr8 on a 16- or 32-bit world is documented to fail. Deriving the packed row from a
    // hardcoded 4 bytes reported a 16-bit row as half padding, which is a reporting lie about a
    // correct AE result — so the stride comes from the type, always.
    long bytes_per_pixel = 0;
    if (err == A_Err_NONE) {
        switch (actual_type) {
            case AEGP_WorldType_8: {
                PF_Pixel8 *typed = nullptr;
                err = g.world->AEGP_GetBaseAddr8(world, &typed);
                base = reinterpret_cast<const unsigned char *>(typed);
                bytes_per_pixel = 4;
                break;
            }
            case AEGP_WorldType_16: {
                PF_Pixel16 *typed = nullptr;
                err = g.world->AEGP_GetBaseAddr16(world, &typed);
                base = reinterpret_cast<const unsigned char *>(typed);
                bytes_per_pixel = 8;
                break;
            }
            case AEGP_WorldType_32: {
                PF_PixelFloat *typed = nullptr;
                err = g.world->AEGP_GetBaseAddr32(world, &typed);
                base = reinterpret_cast<const unsigned char *>(typed);
                bytes_per_pixel = 16;
                break;
            }
            default:
                err = A_Err_GENERIC;
                break;
        }
    }

    A_LRect region = {0, 0, 0, 0};
    g.render->AEGP_GetRenderedRegion(receipt, &region);

    PixelStats stats;
    unsigned long long written = 0ULL;
    std::string payload_path;

    bool stats_available = false;
    // The payload file and its per-pixel alpha statistics are AE-F0/BO0a *comparison* evidence: one
    // frame, written once, compared against an exported reference. On a path that runs continuously
    // they are ruinous — 8.29 MB and a full-frame pass per frame, 447 GB for thirty minutes at 29.97 —
    // so a caller that only wants pixels in the ring switches them off. The ring publish below reads
    // the checked-out world directly and is unaffected either way.
    if (write_payload && err == A_Err_NONE && base != nullptr && width > 0 && height > 0 && bytes_per_pixel > 0) {
        // Rows are padded to rowBytes, so the file is written row by row at the packed width.
        // Anything comparing against an exported reference must see packed rows or the comparison
        // is measuring padding.
        payload_path = g_state_dir + "\\frames";
        CreateDirectoryA(payload_path.c_str(), nullptr);
        std::string safe_comp = comp_name;
        for (char &c : safe_comp) {
            if (!isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') c = '_';
        }
        char leaf[220];
        sprintf_s(leaf, sizeof(leaf), "\\%s-frame%ld-%ldbpc.raw",
                  safe_comp.c_str(), frame, bytes_per_pixel * 2);
        payload_path += leaf;

        const size_t packed_row = static_cast<size_t>(width) * bytes_per_pixel;

        FILE *out = nullptr;
        if (fopen_s(&out, payload_path.c_str(), "wb") == 0 && out != nullptr) {
            for (A_long y = 0; y < height; y += 1) {
                const unsigned char *row = base + static_cast<size_t>(y) * row_bytes;
                written += fwrite(row, 1, packed_row, out);

                // Alpha statistics are 8-bit reasoning: comparing a channel against its alpha as
                // a byte is only meaningful when a channel *is* a byte. For 16- and 32-bit worlds
                // the payload is still written, and the statistics are reported as unavailable
                // rather than computed wrongly.
                if (bytes_per_pixel != 4) continue;
                stats_available = true;
                for (A_long x = 0; x < width; x += 1) {
                    const unsigned char *pixel = row + static_cast<size_t>(x) * 4;
                    // Channel 3 is alpha under BGRA; under ARGB it is channel 0. Reading the
                    // wrong one would invent an answer to the premultiplication question.
                    const unsigned char alpha = (order == AEGP_ChannelOrder_BGRA) ? pixel[3] : pixel[0];
                    unsigned char highest = 0;
                    for (int channel = 0; channel < 4; channel += 1) {
                        const unsigned char value = pixel[channel];
                        if (value < stats.minChannel[channel]) stats.minChannel[channel] = value;
                        if (value > stats.maxChannel[channel]) stats.maxChannel[channel] = value;
                        const bool is_alpha = (order == AEGP_ChannelOrder_BGRA) ? (channel == 3) : (channel == 0);
                        if (!is_alpha && value > highest) highest = value;
                    }
                    if (alpha == 255) stats.opaque += 1;
                    else if (alpha == 0) stats.transparent += 1;
                    else stats.partial += 1;
                    if (highest > alpha) {
                        stats.colourAboveAlpha += 1;
                        const unsigned int excess = static_cast<unsigned int>(highest - alpha);
                        if (excess > stats.worstExcess) stats.worstExcess = excess;
                    }
                    if (alpha == 0 && highest > 0) stats.colourAtZeroAlpha += 1;
                }
            }
            fclose(out);
        }
    }

    RingPublishOutcome ring_outcome;
    if (ring_request.enabled) {
        if (err != A_Err_NONE || base == nullptr) {
            ring_outcome.attempted = true;
            ring_outcome.result = grapix::FrameRingResult::InvalidDescriptor;
            ring_outcome.error_code = "AE_WORLD_UNREADABLE";
            ring_outcome.error_message = "the checked-out receipt did not yield readable pixels";
        } else if (actual_type != AEGP_WorldType_8) {
            // There is no tested 16- or 32-bit conversion. Reporting its actual depth is useful;
            // labelling its bytes BGRA8 would be a visually corrupting fallback.
            ring_outcome.attempted = true;
            ring_outcome.result = grapix::FrameRingResult::InvalidDescriptor;
            ring_outcome.error_code = "AE_REJECTED_FORMAT";
            ring_outcome.error_message = "only an observed 8-bit world can be converted for the BGRA8 ring";
        } else if (matte != AEGP_MatteMode_PREMUL_BLACK) {
            ring_outcome.attempted = true;
            ring_outcome.result = grapix::FrameRingResult::InvalidDescriptor;
            ring_outcome.error_code = "AE_REJECTED_FORMAT";
            ring_outcome.error_message = "only premul-black is accepted; straight or background-premultiplied alpha is never relabelled";
        } else if (order != AEGP_ChannelOrder_ARGB) {
            ring_outcome.attempted = true;
            ring_outcome.result = grapix::FrameRingResult::InvalidDescriptor;
            ring_outcome.error_code = "AE_REJECTED_FORMAT";
            ring_outcome.error_message = "the observed world layout is not the stable ARGB layout required for the tested swizzle";
        } else {
            ring_outcome = publish_argb8_frame(ring_request, static_cast<std::int64_t>(item_id),
                                                render_time, base, width, height, row_bytes);
        }
    }

    const A_Err checkin_err = g.render->AEGP_CheckinFrame(receipt);
    g.renderOptions->AEGP_Dispose(options);
    if (ring_request.enabled) {
        if (ring_outcome.published) {
            emit_render_ready_event(ring_request.render_request_id, static_cast<std::int64_t>(item_id),
                                    render_time_json, static_cast<std::int64_t>(ring_request.data_revision),
                                    std::to_string(ring_request.frame_id),
                                    std::to_string(ring_request.presentation_deadline_nanos));
        } else {
            emit_render_failed_event(ring_request.render_request_id, static_cast<std::int64_t>(item_id),
                                     render_time_json, std::to_string(ring_request.data_revision),
                                     ring_outcome.error_code, ring_outcome.error_message,
                                     ring_outcome.back_pressure);
            if (ring_outcome.back_pressure) {
                g_runtime_pipe.emit_event("RUNTIME_DEGRADED",
                                          "{\"reason\":\"render ring backpressure prevented a frame publish\"}");
            }
        }
    }

    if (err != A_Err_NONE) {
        *err_out = err;
        return "\"reason\":\"the receipt did not yield a readable world\"";
    }

    const char *type_name = actual_type == AEGP_WorldType_8 ? "8"
                          : actual_type == AEGP_WorldType_16 ? "16"
                          : actual_type == AEGP_WorldType_32 ? "32" : "none";

    char text[1800];
    sprintf_s(text, sizeof(text),
              "\"comp\":\"%s\",\"frame\":%ld,"
              "\"timeValue\":%ld,\"timeScale\":%lu,"
              "\"requestedDepth\":\"%s\",\"actualDepth\":\"%s\",\"bytesPerPixel\":%ld,"
              "\"matteMode\":\"%s\",\"channelOrder\":\"%s\","
              "\"width\":%ld,\"height\":%ld,\"rowBytes\":%lu,\"packedRowBytes\":%ld,"
              "\"rowPadding\":%ld,"
              "\"renderedRegion\":{\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld},"
              "\"renderMs\":%lu,\"threadId\":%lu,\"hookThreadId\":%lu,\"onHookThread\":%s,"
              "\"checkinError\":%d,\"payloadBytes\":%llu,\"payloadPath\":\"%s\","
              "\"alphaStatsAvailable\":%s,"
              "\"alpha\":{\"opaque\":%llu,\"transparent\":%llu,\"partial\":%llu,"
              "\"colourAboveAlpha\":%llu,\"worstExcess\":%u,\"colourAtZeroAlpha\":%llu},"
              "\"channelMin\":[%u,%u,%u,%u],\"channelMax\":[%u,%u,%u,%u]",
              json_escape(comp_name).c_str(), frame,
              static_cast<long>(render_time.value), static_cast<unsigned long>(render_time.scale),
              arguments.size() >= 3 ? arguments[2].c_str() : "8", type_name, bytes_per_pixel,
              matte == AEGP_MatteMode_STRAIGHT ? "straight"
                : matte == AEGP_MatteMode_PREMUL_BLACK ? "premul-black" : "premul-bg",
              order == AEGP_ChannelOrder_BGRA ? "bgra" : "argb",
              static_cast<long>(width), static_cast<long>(height),
              static_cast<unsigned long>(row_bytes), static_cast<long>(width) * bytes_per_pixel,
              static_cast<long>(row_bytes) - static_cast<long>(width) * bytes_per_pixel,
              static_cast<long>(region.left), static_cast<long>(region.top),
              static_cast<long>(region.right), static_cast<long>(region.bottom),
              render_ms, GetCurrentThreadId(), g_hook_thread_id,
              GetCurrentThreadId() == g_hook_thread_id ? "true" : "false",
              static_cast<int>(checkin_err), written, json_escape(payload_path).c_str(),
              stats_available ? "true" : "false",
              stats.opaque, stats.transparent, stats.partial,
              stats.colourAboveAlpha, stats.worstExcess, stats.colourAtZeroAlpha,
              stats.minChannel[0], stats.minChannel[1], stats.minChannel[2], stats.minChannel[3],
              stats.maxChannel[0], stats.maxChannel[1], stats.maxChannel[2], stats.maxChannel[3]);
    *err_out = A_Err_NONE;
    return std::string(text) + ",\"ringPublish\":" + ring_publish_outcome_json(ring_outcome);
}

A_Err runtime_comp_by_item_id(A_long item_id, AEGP_CompH *out)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) return err;
    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    while (err == A_Err_NONE && item != nullptr) {
        A_long candidate = 0;
        AEGP_ItemType type = AEGP_ItemType_NONE;
        g.item->AEGP_GetItemID(item, &candidate);
        g.item->AEGP_GetItemType(item, &type);
        if (candidate == item_id && type == AEGP_ItemType_COMP) return g.comp->AEGP_GetCompFromItem(item, out);
        AEGP_ItemH next = nullptr;
        err = g.item->AEGP_GetNextProjItem(project, item, &next);
        item = next;
    }
    return A_Err_GENERIC;
}

bool runtime_payload_integer(const std::string &json, const char *field, std::int64_t *out)
{
    std::string needle = std::string("\"") + field + "\"";
    size_t position = json.find(needle);
    if (position == std::string::npos) return false;
    position = json.find(':', position + needle.size());
    if (position == std::string::npos) return false;
    ++position;
    while (position < json.size() && isspace(static_cast<unsigned char>(json[position]))) ++position;
    char *end = nullptr;
    const long long value = strtoll(json.c_str() + position, &end, 10);
    if (end == json.c_str() + position) return false;
    *out = static_cast<std::int64_t>(value);
    return true;
}
bool runtime_payload_string(const std::string &json, const char *field, std::string *out)
{
    std::string needle = std::string("\"") + field + "\"";
    size_t position = json.find(needle);
    if (position == std::string::npos) return false;
    position = json.find(':', position + needle.size());
    if (position == std::string::npos) return false;
    position = json.find('"', position + 1);
    if (position == std::string::npos) return false;
    ++position;
    out->clear();
    bool escaped = false;
    for (; position < json.size(); ++position) {
        const char character = json[position];
        if (escaped) {
            if (character == '"' || character == '\\' || character == '/') out->push_back(character);
            else return false;
            escaped = false;
        } else if (character == '\\') {
            escaped = true;
        } else if (character == '"') {
            return true;
        } else if (static_cast<unsigned char>(character) < 0x20) {
            return false;
        } else {
            out->push_back(character);
        }
    }
    return false;
}

bool runtime_payload_number(const std::string &json, const char *field, double *out)
{
    std::string needle = std::string("\"") + field + "\"";
    size_t position = json.find(needle);
    if (position == std::string::npos) return false;
    position = json.find(':', position + needle.size());
    if (position == std::string::npos) return false;
    char *end = nullptr;
    const double value = strtod(json.c_str() + position + 1, &end);
    if (end == json.c_str() + position + 1 || !std::isfinite(value)) return false;
    *out = value;
    return true;
}

A_Err runtime_layer_by_ids(A_long composition_item_id, AEGP_LayerIDVal layer_id, AEGP_LayerH *out)
{
    AEGP_CompH comp = nullptr;
    A_Err err = runtime_comp_by_item_id(composition_item_id, &comp);
    return err == A_Err_NONE ? g.layer->AEGP_GetLayerFromLayerID(comp, layer_id, out) : err;
}

bool runtime_layer_stream(const std::string &match_name, AEGP_LayerStream *out)
{
    if (match_name == "ADBE Opacity") *out = AEGP_LayerStream_OPACITY;
    else if (match_name == "ADBE Rotate Z") *out = AEGP_LayerStream_ROTATION;
    else return false;
    return true;
}

/**
 * Extract one nested object's text, braces included.
 *
 * The field readers scan for the first occurrence of a name, so reading a member's ids straight out
 * of the member would silently depend on `target` coming first in the serialisation. Pulling the
 * sub-object out first makes the dependency a parse rather than a convention.
 */
bool runtime_payload_object(const std::string &json, const char *field, std::string *out)
{
    const std::string needle = std::string("\"") + field + "\"";
    size_t position = json.find(needle);
    if (position == std::string::npos) return false;
    position = json.find('{', position + needle.size());
    if (position == std::string::npos) return false;
    const size_t start = position;
    int depth = 0;
    bool in_string = false, escaped = false;
    for (; position < json.size(); ++position) {
        const char character = json[position];
        if (in_string) {
            if (escaped) escaped = false;
            else if (character == '\\') escaped = true;
            else if (character == '"') in_string = false;
            continue;
        }
        if (character == '"') in_string = true;
        else if (character == '{') ++depth;
        else if (character == '}' && --depth == 0) {
            *out = json.substr(start, position - start + 1);
            return true;
        }
    }
    return false;
}

// -----------------------------------------------------------------------------
// Declared canonical property surface.
//
// A property is reachable only if its canonical match-name path appears in this table. That is the
// whole point: discovery stays *declared*, so a property does not become writable merely because AE
// happens to expose it, and a path GrapiX has never proven is refused rather than guessed at.
//
// The single-segment opacity and rotation forms are kept because AE-CD1's declared controls and the
// fixtures already carry them; the fuller transform-group form is accepted as the same target so two
// spellings of one property cannot resolve differently.
// -----------------------------------------------------------------------------

enum class RuntimePropertyKind { Number, Text, Colour };

struct RuntimePropertyRef {
    RuntimePropertyKind kind = RuntimePropertyKind::Number;
    AEGP_LayerStream stream = AEGP_LayerStream_OPACITY;
    const char *value_type = "number";
    const char *display_name = "";
    /** The canonical path as this adapter reports it, so the echo and the table cannot disagree. */
    const char *canonical = "";
};

/** Split the `path` array of a target into its `matchName` segments, in order. */
bool runtime_payload_path(const std::string &json, std::vector<std::string> *segments)
{
    const std::string needle = "\"path\"";
    size_t position = json.find(needle);
    if (position == std::string::npos) return false;
    position = json.find('[', position + needle.size());
    if (position == std::string::npos) return false;
    segments->clear();
    int depth = 0;
    size_t start = 0;
    bool in_string = false, escaped = false;
    for (++position; position < json.size(); ++position) {
        const char character = json[position];
        if (in_string) {
            if (escaped) escaped = false;
            else if (character == '\\') escaped = true;
            else if (character == '"') in_string = false;
            continue;
        }
        if (character == '"') { in_string = true; continue; }
        if (character == '{') { if (depth++ == 0) start = position; }
        else if (character == '}') {
            if (depth == 0) return false;
            if (--depth == 0) {
                std::string segment;
                const std::string entry = json.substr(start, position - start + 1);
                if (!runtime_payload_string(entry, "matchName", &segment)) return false;
                segments->push_back(segment);
            }
        } else if (character == ']' && depth == 0) {
            return true;
        }
    }
    return false;
}

bool runtime_resolve_canonical(const std::vector<std::string> &segments, RuntimePropertyRef *out)
{
    const auto is = [&segments](std::initializer_list<const char *> expected) {
        if (segments.size() != expected.size()) return false;
        size_t index = 0;
        for (const char *name : expected) {
            if (segments[index++] != name) return false;
        }
        return true;
    };

    if (is({"ADBE Opacity"}) || is({"ADBE Transform Group", "ADBE Opacity"})) {
        *out = {RuntimePropertyKind::Number, AEGP_LayerStream_OPACITY, "number", "Opacity", "ADBE Opacity"};
        return true;
    }
    if (is({"ADBE Rotate Z"}) || is({"ADBE Transform Group", "ADBE Rotate Z"})) {
        *out = {RuntimePropertyKind::Number, AEGP_LayerStream_ROTATION, "number", "Rotation", "ADBE Rotate Z"};
        return true;
    }
    if (is({"ADBE Text Properties", "ADBE Text Document"})) {
        *out = {RuntimePropertyKind::Text, AEGP_LayerStream_SOURCE_TEXT, "text", "Source Text",
                "ADBE Text Properties/ADBE Text Document"};
        return true;
    }
    if (is({"ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"})) {
        // The colour stream is found by walking the Fill effect's params, not by stream id.
        *out = {RuntimePropertyKind::Colour, AEGP_LayerStream_OPACITY, "color", "Fill Color",
                "ADBE Effect Parade/ADBE Fill/ADBE Fill-0002"};
        return true;
    }
    return false;
}

/**
 * Resolve a target payload to a declared property.
 *
 * Accepts either the canonical `path` array or AE-CD1's flat `matchName`, because the control service
 * sends the array while the fixtures and smoke clients send the single name. Both land on the same
 * table entry, so there is exactly one notion of what a target means.
 */
bool runtime_resolve_property(const std::string &payload, RuntimePropertyRef *out)
{
    std::vector<std::string> segments;
    if (runtime_payload_path(payload, &segments) && !segments.empty()) {
        return runtime_resolve_canonical(segments, out);
    }
    std::string match_name;
    if (!runtime_payload_string(payload, "matchName", &match_name)) return false;
    return runtime_resolve_canonical({match_name}, out);
}

/**
 * Whether this layer can carry a property of this kind at all.
 *
 * Load-bearing, not an optimisation. Asking After Effects for a stream a layer cannot have — source
 * text on a solid, a Fill colour on a layer with no effects — **wedges the idle hook**: AE stays
 * alive and `Responding` with a flat CPU counter while no callback ever completes again, which is
 * finding F2's signature and cost a hung session to rediscover. Every kind is gated on a cheap,
 * total query before any stream is acquired.
 */
bool runtime_layer_supports_kind(AEGP_LayerH layer, RuntimePropertyKind kind)
{
    if (kind == RuntimePropertyKind::Text) {
        AEGP_ObjectType type = AEGP_ObjectType_NONE;
        if (g.layer->AEGP_GetLayerObjectType(layer, &type) != A_Err_NONE) return false;
        return type == AEGP_ObjectType_TEXT;
    }
    if (kind == RuntimePropertyKind::Colour) {
        A_long effects = 0;
        if (g.effect->AEGP_GetLayerNumEffects(layer, &effects) != A_Err_NONE) return false;
        if (effects < 1) return false;
        AEGP_EffectRefH effect = nullptr;
        AEGP_StreamRefH stream = nullptr;
        if (fill_colour_stream(layer, &effect, &stream) != A_Err_NONE) return false;
        g.stream->AEGP_DisposeStream(stream);
        g.effect->AEGP_DisposeEffect(effect);
        return true;
    }
    return true;
}

/**
 * The canonical target, with its path as the real segment list.
 *
 * `canonical` carries `/`-joined segments, and collapsing them into one segment is exactly the bug
 * that made a two-segment declared control unmatchable: the control service compares path segment by
 * segment, so a target echoed as one joined string is a target that can never be recognised. A
 * single-segment name splits to itself, so the older opacity and rotation forms are unaffected.
 */
std::string runtime_property_target_json(A_long item_id, AEGP_LayerIDVal layer_id,
                                         A_long source_id, const std::string &canonical)
{
    // A layer with no footage source reports id 0. `LIST_LAYERS` already renders that as `null`, and
    // the contract types the field `number | null`, so writing 0 here would make two descriptions of
    // the same layer disagree.
    char source_json[32];
    if (source_id == 0) strcpy_s(source_json, sizeof(source_json), "null");
    else sprintf_s(source_json, sizeof(source_json), "%ld", static_cast<long>(source_id));

    std::string path = "[";
    size_t start = 0;
    bool first = true;
    while (start <= canonical.size()) {
        const size_t separator = canonical.find('/', start);
        const std::string segment = canonical.substr(
            start, separator == std::string::npos ? std::string::npos : separator - start);
        if (!segment.empty()) {
            path += first ? "" : ",";
            path += "{\"matchName\":\"" + json_escape(segment) + "\",\"ordinal\":0}";
            first = false;
        }
        if (separator == std::string::npos) break;
        start = separator + 1;
    }
    path += "]";

    char head[256];
    sprintf_s(head, sizeof(head), "{\"compositionItemId\":%ld,\"layerId\":%ld,\"sourceItemId\":%s,\"path\":",
              static_cast<long>(item_id), static_cast<long>(layer_id), source_json);
    return std::string(head) + path + "}";
}

/** Read a declared property's current value as the JSON body the protocol expects. */
A_Err runtime_property_value_json(AEGP_LayerH layer, const RuntimePropertyRef &ref, std::string *out)
{
    if (!runtime_layer_supports_kind(layer, ref.kind)) return A_Err_GENERIC;
    if (ref.kind == RuntimePropertyKind::Colour) {
        AEGP_EffectRefH effect = nullptr;
        AEGP_StreamRefH stream = nullptr;
        A_Err err = fill_colour_stream(layer, &effect, &stream);
        if (err != A_Err_NONE) return err;
        const A_Time zero = {0, 1};
        AEGP_StreamValue2 value;
        memset(&value, 0, sizeof(value));
        err = g.stream->AEGP_GetNewStreamValue(g_plugin_id, stream, AEGP_LTimeMode_CompTime, &zero, FALSE, &value);
        if (err == A_Err_NONE) {
            *out = "{\"value\":\"" + colour_hex(value.val.color) + "\",\"valueType\":\"color\"}";
            g.stream->AEGP_DisposeStreamValue(&value);
        }
        g.stream->AEGP_DisposeStream(stream);
        g.effect->AEGP_DisposeEffect(effect);
        return err;
    }

    AEGP_StreamRefH stream = nullptr;
    A_Err err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, ref.stream, &stream);
    if (err != A_Err_NONE) return err;
    const A_Time zero = {0, 1};
    const AEGP_LTimeMode mode = ref.kind == RuntimePropertyKind::Text
        ? AEGP_LTimeMode_LayerTime : AEGP_LTimeMode_CompTime;
    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    err = g.stream->AEGP_GetNewStreamValue(g_plugin_id, stream, mode, &zero, FALSE, &value);
    if (err == A_Err_NONE) {
        if (ref.kind == RuntimePropertyKind::Text) {
            AEGP_MemHandle text = nullptr;
            err = g.textDocument->AEGP_GetNewText(g_plugin_id, value.val.text_documentH, &text);
            if (err == A_Err_NONE) {
                *out = "{\"value\":\"" + json_escape(take_handle_string(text)) + "\",\"valueType\":\"text\"}";
            }
        } else {
            char body[256];
            sprintf_s(body, sizeof(body), "{\"value\":%.12g,\"valueType\":\"number\"}", value.val.one_d);
            *out = body;
        }
        g.stream->AEGP_DisposeStreamValue(&value);
    }
    g.stream->AEGP_DisposeStream(stream);
    return err;
}

/**
 * Whether a declared property can be written, and why not when it cannot.
 *
 * `AEGP_SetStreamValue` is legal only at zero keyframes and no expression, so this is the same gate
 * the single write and the atomic revision both consult. A property is never reported writable just
 * because it was discovered.
 */
A_Err runtime_property_writable(AEGP_LayerH layer, const RuntimePropertyRef &ref,
                                bool *writable, const char **reason)
{
    *writable = false;
    *reason = "\"unavailable\"";
    if (!runtime_layer_supports_kind(layer, ref.kind)) return A_Err_GENERIC;
    AEGP_EffectRefH effect = nullptr;
    AEGP_StreamRefH stream = nullptr;
    A_Err err = ref.kind == RuntimePropertyKind::Colour
        ? fill_colour_stream(layer, &effect, &stream)
        : g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, ref.stream, &stream);
    if (err != A_Err_NONE) return err;
    A_long keys = 0;
    A_Boolean expression = FALSE;
    err = g.keyframe->AEGP_GetStreamNumKFs(stream, &keys);
    if (err == A_Err_NONE) err = g.stream->AEGP_GetExpressionState(g_plugin_id, stream, &expression);
    if (err == A_Err_NONE) {
        *writable = keys == 0 && !expression;
        *reason = keys > 0 ? "\"keyframed\"" : expression ? "\"expression-enabled\"" : "null";
    }
    g.stream->AEGP_DisposeStream(stream);
    if (effect != nullptr) g.effect->AEGP_DisposeEffect(effect);
    return err;
}

std::string runtime_property_descriptor_json(A_long item_id, AEGP_LayerIDVal layer_id, A_long source_id,
                                             AEGP_LayerH layer, const RuntimePropertyRef &ref, A_Err *err_out)
{
    bool writable = false;
    const char *reason = "null";
    const A_Err err = runtime_property_writable(layer, ref, &writable, &reason);
    if (err != A_Err_NONE) { *err_out = err; return std::string(); }

    AEGP_EffectRefH effect = nullptr;
    AEGP_StreamRefH stream = nullptr;
    A_Boolean varying = FALSE, expression = FALSE;
    if ((ref.kind == RuntimePropertyKind::Colour
            ? fill_colour_stream(layer, &effect, &stream)
            : g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, ref.stream, &stream)) == A_Err_NONE) {
        g.stream->AEGP_IsStreamTimevarying(stream, &varying);
        g.stream->AEGP_GetExpressionState(g_plugin_id, stream, &expression);
        g.stream->AEGP_DisposeStream(stream);
        if (effect != nullptr) g.effect->AEGP_DisposeEffect(effect);
    }

    *err_out = A_Err_NONE;
    return "{\"target\":" + runtime_property_target_json(item_id, layer_id, source_id, ref.canonical) +
        ",\"displayName\":\"" + ref.display_name +
        "\",\"valueType\":\"" + ref.value_type +
        "\",\"writable\":" + (writable ? "true" : "false") +
        ",\"readOnlyReason\":" + reason +
        ",\"timeVarying\":" + (varying ? "true" : "false") +
        ",\"expressionEnabled\":" + (expression ? "true" : "false") +
        ",\"surface\":\"aegp-sdk\",\"structuralFingerprint\":\"" + ref.canonical + ":0\"}";
}

std::string runtime_list_properties(const std::string &payload, A_Err *err_out)
{
    std::int64_t item_id = 0, layer_id = 0;
    if (!runtime_payload_integer(payload, "compositionItemId", &item_id) ||
        !runtime_payload_integer(payload, "layerId", &layer_id)) {
        *err_out = A_Err_PARAMETER;
        return "null";
    }
    AEGP_LayerH layer = nullptr;
    A_Err err = runtime_layer_by_ids(static_cast<A_long>(item_id), static_cast<AEGP_LayerIDVal>(layer_id), &layer);
    if (err != A_Err_NONE) { *err_out = err; return "null"; }
    A_long source_id = 0;
    g.layer->AEGP_GetLayerSourceItemID(layer, &source_id);

    // Every declared kind is offered, and each one is gated on what the layer can actually carry: a
    // solid has no source text and a layer with no Fill has no colour, and asking AE for either wedges
    // the idle hook rather than returning an error.
    RuntimePropertyRef candidates[4];
    runtime_resolve_canonical({"ADBE Opacity"}, &candidates[0]);
    runtime_resolve_canonical({"ADBE Rotate Z"}, &candidates[1]);
    runtime_resolve_canonical({"ADBE Text Properties", "ADBE Text Document"}, &candidates[2]);
    runtime_resolve_canonical({"ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"}, &candidates[3]);

    std::string out = "[";
    bool first = true;
    for (const RuntimePropertyRef &ref : candidates) {
        if (!runtime_layer_supports_kind(layer, ref.kind)) continue;
        A_Err descriptor_err = A_Err_NONE;
        const std::string descriptor = runtime_property_descriptor_json(
            static_cast<A_long>(item_id), static_cast<AEGP_LayerIDVal>(layer_id), source_id,
            layer, ref, &descriptor_err);
        if (descriptor_err != A_Err_NONE || descriptor.empty()) continue;
        out += first ? "" : ",";
        out += descriptor;
        first = false;
    }
    *err_out = A_Err_NONE;
    return out + "]";
}

std::string runtime_read_property(const std::string &payload, A_Err *err_out)
{
    std::int64_t item_id = 0, layer_id = 0;
    RuntimePropertyRef ref;
    if (!runtime_payload_integer(payload, "compositionItemId", &item_id) ||
        !runtime_payload_integer(payload, "layerId", &layer_id) ||
        !runtime_resolve_property(payload, &ref)) {
        *err_out = A_Err_PARAMETER;
        return "null";
    }
    AEGP_LayerH layer = nullptr;
    A_Err err = runtime_layer_by_ids(static_cast<A_long>(item_id), static_cast<AEGP_LayerIDVal>(layer_id), &layer);
    std::string body;
    if (err == A_Err_NONE) err = runtime_property_value_json(layer, ref, &body);
    *err_out = err;
    return err == A_Err_NONE ? body : "null";
}

/** Write one declared property. Shared by `SET_PROPERTY` and one member of an atomic revision. */
A_Err runtime_write_property(AEGP_LayerH layer, const RuntimePropertyRef &ref,
                             const std::string &payload, std::string *error_code, std::string *body)
{
    bool writable = false;
    const char *reason = "null";
    A_Err err = runtime_property_writable(layer, ref, &writable, &reason);
    if (err != A_Err_NONE) return err;
    if (!writable) {
        *error_code = "PROPERTY_READ_ONLY";
        return A_Err_GENERIC;
    }

    if (ref.kind == RuntimePropertyKind::Text) {
        std::string requested;
        if (!runtime_payload_string(payload, "value", &requested) || requested.size() > 4096) {
            *error_code = "INVALID_PAYLOAD";
            return A_Err_PARAMETER;
        }
        std::string previous, readback;
        err = set_fixture_text(layer, requested, &previous, &readback);
        if (err == A_Err_NONE) {
            *body = "{\"value\":\"" + json_escape(readback) + "\",\"valueType\":\"text\"}";
        }
        return err;
    }

    if (ref.kind == RuntimePropertyKind::Colour) {
        std::string requested;
        AEGP_ColorVal colour;
        if (!runtime_payload_string(payload, "value", &requested) || !parse_colour_hex(requested, &colour)) {
            *error_code = "INVALID_PAYLOAD";
            return A_Err_PARAMETER;
        }
        AEGP_EffectRefH effect = nullptr;
        AEGP_StreamRefH stream = nullptr;
        err = fill_colour_stream(layer, &effect, &stream);
        if (err != A_Err_NONE) return err;
        AEGP_StreamValue2 value;
        memset(&value, 0, sizeof(value));
        value.streamH = stream;
        value.val.color = colour;
        err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
        g.stream->AEGP_DisposeStream(stream);
        g.effect->AEGP_DisposeEffect(effect);
        if (err == A_Err_NONE) *body = "{\"value\":\"" + colour_hex(colour) + "\",\"valueType\":\"color\"}";
        return err;
    }

    double requested = 0.0;
    if (!runtime_payload_number(payload, "value", &requested) ||
        (ref.stream == AEGP_LayerStream_OPACITY && (requested < 0.0 || requested > 100.0))) {
        *error_code = "INVALID_PAYLOAD";
        return A_Err_PARAMETER;
    }
    AEGP_StreamRefH stream = nullptr;
    err = g.stream->AEGP_GetNewLayerStream(g_plugin_id, layer, ref.stream, &stream);
    if (err != A_Err_NONE) return err;
    AEGP_StreamValue2 value;
    memset(&value, 0, sizeof(value));
    value.streamH = stream;
    value.val.one_d = requested;
    err = g.stream->AEGP_SetStreamValue(g_plugin_id, stream, &value);
    g.stream->AEGP_DisposeStream(stream);
    if (err == A_Err_NONE) {
        char out[256];
        sprintf_s(out, sizeof(out), "{\"value\":%.12g,\"valueType\":\"number\"}", requested);
        *body = out;
    }
    return err;
}

std::string runtime_set_property(const std::string &payload, A_Err *err_out, std::string *error_code)
{
    std::int64_t item_id = 0, layer_id = 0;
    RuntimePropertyRef ref;
    if (!runtime_payload_integer(payload, "compositionItemId", &item_id) ||
        !runtime_payload_integer(payload, "layerId", &layer_id) ||
        !runtime_resolve_property(payload, &ref)) {
        *err_out = A_Err_PARAMETER;
        *error_code = "INVALID_PAYLOAD";
        return "null";
    }
    AEGP_LayerH layer = nullptr;
    A_Err err = runtime_layer_by_ids(static_cast<A_long>(item_id), static_cast<AEGP_LayerIDVal>(layer_id), &layer);
    if (err != A_Err_NONE) {
        *err_out = err;
        *error_code = "TARGET_NOT_FOUND";
        return "null";
    }
    std::string body;
    g.util->AEGP_StartUndoGroup("GrapiX property set");
    err = runtime_write_property(layer, ref, payload, error_code, &body);
    g.util->AEGP_EndUndoGroup();
    *err_out = err;
    return err == A_Err_NONE ? body : "null";
}

/**
 * Position the composition at an exact rational time.
 *
 * The time arrives as PL1 resolved it — `{value, scale}` decimal strings, already proven to land on a
 * Program frame — and is never reconstructed from a float here. `A_Time` carries a signed 32-bit
 * value, so a run long enough to overflow it is refused rather than wrapped into a different instant.
 */
std::string runtime_set_time(const std::string &payload, A_Err *err_out, std::string *error_code)
{
    std::int64_t item_id = 0;
    std::string time_json, value_text, scale_text;
    if (!runtime_payload_integer(payload, "compositionItemId", &item_id) ||
        !runtime_payload_object(payload, "time", &time_json) ||
        !runtime_payload_string(time_json, "value", &value_text) ||
        !runtime_payload_string(time_json, "scale", &scale_text)) {
        *err_out = A_Err_PARAMETER;
        *error_code = "INVALID_PAYLOAD";
        return "null";
    }
    char *value_end = nullptr;
    char *scale_end = nullptr;
    const long long value = strtoll(value_text.c_str(), &value_end, 10);
    const long long scale = strtoll(scale_text.c_str(), &scale_end, 10);
    if (value_end == nullptr || *value_end != '\0' || scale_end == nullptr || *scale_end != '\0' ||
        value < 0 || scale <= 0 || value > 2147483647LL || scale > 2147483647LL) {
        *err_out = A_Err_PARAMETER;
        *error_code = "INVALID_PAYLOAD";
        return "null";
    }

    AEGP_CompH comp = nullptr;
    A_Err err = runtime_comp_by_item_id(static_cast<A_long>(item_id), &comp);
    AEGP_ItemH item = nullptr;
    if (err == A_Err_NONE) err = g.comp->AEGP_GetItemFromComp(comp, &item);
    if (err != A_Err_NONE) {
        *err_out = err;
        *error_code = "TARGET_NOT_FOUND";
        return "null";
    }

    A_Time requested = { static_cast<A_long>(value), static_cast<A_u_long>(scale) };
    g.util->AEGP_StartUndoGroup("GrapiX set time");
    err = g.item->AEGP_SetItemCurrentTime(item, &requested);
    g.util->AEGP_EndUndoGroup();
    if (err != A_Err_NONE) { *err_out = err; return "null"; }

    // Read back rather than echo: AE holds the time in the item's own timespace, and the only honest
    // report of where the composition is standing is the one AE gives back.
    A_Time actual = {0, 1};
    err = g.item->AEGP_GetItemCurrentTime(item, &actual);
    *err_out = err;
    if (err != A_Err_NONE) return "null";

    // AE holds time in the item's own scale, and that scale may not be able to represent the instant
    // asked for: this fixture's scale is 23976 (exactly 29.97), so a cue declared at 30000/1001
    // quantises to 800/23976 — a different instant, 24 apart under cross-multiplication. Accepting it
    // would park a cue on a frame nobody declared, so the mismatch is a refusal naming both instants.
    const long long actual_value = static_cast<long long>(actual.value);
    const long long actual_scale = static_cast<long long>(actual.scale);
    if (actual_value * scale != value * actual_scale) {
        *err_out = A_Err_GENERIC;
        *error_code = "TIME_NOT_REPRESENTABLE";
        char detail[256];
        sprintf_s(detail, sizeof(detail),
                  "{\"requested\":{\"value\":\"%lld\",\"scale\":\"%lld\"},"
                  "\"actual\":{\"value\":\"%lld\",\"scale\":\"%lld\"}}",
                  value, scale, actual_value, actual_scale);
        return std::string(detail);
    }
    char out[256];
    sprintf_s(out, sizeof(out), "{\"time\":{\"value\":\"%ld\",\"scale\":\"%lu\"},\"requested\":{\"value\":\"%s\",\"scale\":\"%s\"}}",
              static_cast<long>(actual.value), static_cast<unsigned long>(actual.scale),
              json_escape(value_text).c_str(), json_escape(scale_text).c_str());
    return std::string(out);
}

/**
 * Evaluate one frame and publish it into the AE-F1 ring. The Program frame path's request, at last on
 * the authenticated protocol.
 *
 * `AE-F3` found that the only way to make After Effects evaluate a frame was the legacy *file* command
 * channel: `RENDER_READY`/`RENDER_FAILED` were events no request could cause, and the engine's own
 * `request_ae_program_frames` had nothing to forward them to. This is that missing request.
 *
 * Three deliberate differences from the `checkout` verb it shares its implementation with:
 *
 *  - **No payload file and no alpha statistics.** They are one-shot comparison evidence; at 8.29 MB and
 *    a full-frame pass per frame they would cost 447 GB over a 30-minute soak.
 *  - **The composition is addressed by stable item id**, not an index or a name.
 *  - **The instant is an exact rational, checked against the composition's own frame duration.** A time
 *    that is not on a frame boundary of *this* composition is refused rather than rounded, which is
 *    `PL1`'s rule and the same reason `SET_TIME` refuses `TIME_NOT_REPRESENTABLE`.
 */
std::string runtime_render_frame(const std::string &payload, A_Err *err_out, std::string *error_code)
{
    std::int64_t item_id = 0;
    std::int64_t data_revision = 0;
    std::int64_t frame_id = 0;
    std::string render_request_id;
    std::string deadline_text;
    std::string time_json, value_text, scale_text;
    if (!runtime_payload_integer(payload, "compositionItemId", &item_id) ||
        !runtime_payload_integer(payload, "dataRevision", &data_revision) ||
        !runtime_payload_integer(payload, "frameId", &frame_id) ||
        !runtime_payload_string(payload, "renderRequestId", &render_request_id) ||
        !runtime_payload_string(payload, "presentationDeadlineNanos", &deadline_text) ||
        !runtime_payload_object(payload, "time", &time_json) ||
        !runtime_payload_string(time_json, "value", &value_text) ||
        !runtime_payload_string(time_json, "scale", &scale_text) ||
        render_request_id.empty() || render_request_id.size() > 128 ||
        data_revision < 0 || frame_id < 0) {
        *err_out = A_Err_PARAMETER;
        *error_code = "INVALID_PAYLOAD";
        return "null";
    }

    char *value_end = nullptr;
    char *scale_end = nullptr;
    char *deadline_end = nullptr;
    const long long value = strtoll(value_text.c_str(), &value_end, 10);
    const long long scale = strtoll(scale_text.c_str(), &scale_end, 10);
    const long long deadline_nanos = strtoll(deadline_text.c_str(), &deadline_end, 10);
    if (value_end == nullptr || *value_end != '\0' || scale_end == nullptr || *scale_end != '\0' ||
        deadline_end == nullptr || *deadline_end != '\0' ||
        value < 0 || scale <= 0 || deadline_nanos < 0 ||
        value > 2147483647LL || scale > 2147483647LL) {
        *err_out = A_Err_PARAMETER;
        *error_code = "INVALID_PAYLOAD";
        return "null";
    }

    AEGP_CompH comp = nullptr;
    A_Err err = runtime_comp_by_item_id(static_cast<A_long>(item_id), &comp);
    if (err != A_Err_NONE) {
        *err_out = err;
        *error_code = "TARGET_NOT_FOUND";
        return "null";
    }
    A_Time frame_duration = {0, 1};
    err = g.comp->AEGP_GetCompFrameDuration(comp, &frame_duration);
    if (err != A_Err_NONE || frame_duration.value <= 0 || frame_duration.scale == 0) {
        *err_out = err == A_Err_NONE ? A_Err_GENERIC : err;
        *error_code = "AE_ERROR";
        return "null";
    }

    // The requested instant must be an exact whole number of this composition's frames. Cross-multiply
    // rather than divide: 800/23976 and 100/2997 are the same instant, and a float would lose that.
    const long long duration_value = static_cast<long long>(frame_duration.value);
    const long long duration_scale = static_cast<long long>(frame_duration.scale);
    const long long numerator = value * duration_scale;
    const long long denominator = duration_value * scale;
    if (denominator == 0 || numerator % denominator != 0) {
        *err_out = A_Err_GENERIC;
        *error_code = "TIME_NOT_REPRESENTABLE";
        char detail[256];
        sprintf_s(detail, sizeof(detail),
                  "{\"requested\":{\"value\":\"%lld\",\"scale\":\"%lld\"},"
                  "\"frameDuration\":{\"value\":\"%lld\",\"scale\":\"%lld\"}}",
                  value, scale, duration_value, duration_scale);
        return std::string(detail);
    }
    const long long frame = numerator / denominator;

    // One render implementation, shared with the `checkout` verb: the ring publish, the observed-layout
    // rule (AE-F0 C4), the refusal of any world that is not 8-bit premultiplied ARGB, and the
    // correlated RENDER_READY/RENDER_FAILED emission all live there and are proven there.
    const std::vector<std::string> arguments = {
        "id:" + std::to_string(item_id),
        std::to_string(frame),
        "8",
        "premul-black",
        "argb",
        "ring",
        render_request_id,
        std::to_string(data_revision),
        std::to_string(frame_id),
        std::to_string(deadline_nanos)
    };
    const std::string body = do_checkout(arguments, err_out, /*write_payload=*/false);
    if (*err_out != A_Err_NONE) {
        if (error_code->empty()) *error_code = "AE_ERROR";
        return "null";
    }
    return "{" + body + "}";
}

/**
 * The layer's effect inventory, by match name.
 *
 * Read-only, and deliberately not a capability claim: an effect appearing here says AE has it applied,
 * never that GrapiX can drive it. Only the declared canonical table decides what is writable.
 */
std::string runtime_list_effects(const std::string &payload, A_Err *err_out)
{
    std::int64_t item_id = 0, layer_id = 0;
    if (!runtime_payload_integer(payload, "compositionItemId", &item_id) ||
        !runtime_payload_integer(payload, "layerId", &layer_id)) {
        *err_out = A_Err_PARAMETER;
        return "null";
    }
    AEGP_LayerH layer = nullptr;
    A_Err err = runtime_layer_by_ids(static_cast<A_long>(item_id), static_cast<AEGP_LayerIDVal>(layer_id), &layer);
    if (err != A_Err_NONE) { *err_out = err; return "null"; }
    A_long effects = 0;
    err = g.effect->AEGP_GetLayerNumEffects(layer, &effects);
    if (err != A_Err_NONE) { *err_out = err; return "null"; }
    std::string out = "[";
    for (A_long index = 0; index < effects; ++index) {
        AEGP_EffectRefH effect = nullptr;
        if (g.effect->AEGP_GetLayerEffectByIndex(g_plugin_id, layer, index, &effect) != A_Err_NONE) break;
        AEGP_InstalledEffectKey key = AEGP_InstalledEffectKey_NONE;
        char match_name[AEGP_MAX_EFFECT_MATCH_NAME_SIZE] = {0};
        char display_name[AEGP_MAX_EFFECT_NAME_SIZE] = {0};
        if (g.effect->AEGP_GetInstalledKeyFromLayerEffect(effect, &key) == A_Err_NONE) {
            g.effect->AEGP_GetEffectMatchName(key, match_name);
            g.effect->AEGP_GetEffectName(key, display_name);
        }
        char entry[1024];
        sprintf_s(entry, sizeof(entry), "%s{\"index\":%ld,\"matchName\":\"%s\",\"displayName\":\"%s\"}",
                  index == 0 ? "" : ",", static_cast<long>(index),
                  json_escape(match_name).c_str(), json_escape(display_name).c_str());
        out += entry;
        g.effect->AEGP_DisposeEffect(effect);
    }
    *err_out = A_Err_NONE;
    return out + "]";
}


// -----------------------------------------------------------------------------
// Atomic data revisions.
//
// After Effects has no transaction a plugin can open around several stream writes, so atomicity
// here is built rather than borrowed: prove every member first, capture every prior value, write,
// and on the first failure put the already-written members back. An undo group wraps the whole
// batch so AE's own history shows one entry rather than one per control.
//
// The rollback is the load-bearing part. A batch that failed halfway and left AE holding half a
// revision would be worse than a refusal, because the operator would have no way to know which
// half reached air.
// -----------------------------------------------------------------------------

struct RevisionMember {
    std::int64_t item_id = 0;
    std::int64_t layer_id = 0;
    RuntimePropertyRef ref;
    /** The member's own JSON. It carries the target and the requested value, so it is the write payload. */
    std::string member_json;
    /**
     * The value read before the batch, as a JSON body.
     *
     * Deliberately the same shape `runtime_write_property` accepts, so the restore path re-uses the
     * read rather than needing a second serialiser per kind that could disagree with it.
     */
    std::string previous_json;
    A_long source_id = 0;
    AEGP_LayerH layer = nullptr;
};

/**
 * Split the `members` array into its top-level objects.
 *
 * The existing field readers each scan for the first occurrence of a name, so they can only be
 * trusted against one object at a time. Splitting first is what keeps them honest.
 */
bool runtime_payload_members(const std::string &payload, std::vector<std::string> *out)
{
    const std::string needle = "\"members\"";
    size_t position = payload.find(needle);
    if (position == std::string::npos) return false;
    position = payload.find('[', position + needle.size());
    if (position == std::string::npos) return false;
    ++position;
    out->clear();
    int depth = 0;
    size_t start = 0;
    bool in_string = false, escaped = false;
    for (; position < payload.size(); ++position) {
        const char character = payload[position];
        if (in_string) {
            if (escaped) escaped = false;
            else if (character == '\\') escaped = true;
            else if (character == '"') in_string = false;
            continue;
        }
        if (character == '"') { in_string = true; continue; }
        if (character == '{') {
            if (depth == 0) start = position;
            ++depth;
        } else if (character == '}') {
            if (depth == 0) return false;
            if (--depth == 0) out->push_back(payload.substr(start, position - start + 1));
        } else if (character == ']' && depth == 0) {
            return true;
        }
    }
    return false;
}

/**
 * Payload checks a member must pass before any member is written.
 *
 * Separate from `runtime_write_property` because atomicity depends on every member being proven
 * acceptable while AE still holds the old values. The write path validates again, so a single
 * `SET_PROPERTY` is not relying on this having been called.
 */
bool runtime_validate_member_value(const RuntimePropertyRef &ref, const std::string &member_json)
{
    if (ref.kind == RuntimePropertyKind::Text) {
        std::string text;
        return runtime_payload_string(member_json, "value", &text) && text.size() <= 4096;
    }
    if (ref.kind == RuntimePropertyKind::Colour) {
        std::string text;
        AEGP_ColorVal colour;
        return runtime_payload_string(member_json, "value", &text) && parse_colour_hex(text, &colour);
    }
    double requested = 0.0;
    if (!runtime_payload_number(member_json, "value", &requested)) return false;
    return ref.stream != AEGP_LayerStream_OPACITY || (requested >= 0.0 && requested <= 100.0);
}

std::string runtime_apply_data_revision(const std::string &payload, A_Err *err_out, std::string *error_code)
{
    std::int64_t revision = 0;
    std::vector<std::string> member_payloads;
    if (!runtime_payload_integer(payload, "revision", &revision) || revision < 1 ||
        !runtime_payload_members(payload, &member_payloads) || member_payloads.empty()) {
        *err_out = A_Err_PARAMETER;
        *error_code = "INVALID_PAYLOAD";
        return "null";
    }

    // Phase 1: parse and validate every member before a single AE handle is resolved.
    std::vector<RevisionMember> members;
    members.reserve(member_payloads.size());
    for (const std::string &entry : member_payloads) {
        RevisionMember member;
        member.member_json = entry;
        std::string target_json;
        if (!runtime_payload_object(entry, "target", &target_json) ||
            !runtime_payload_integer(target_json, "compositionItemId", &member.item_id) ||
            !runtime_payload_integer(target_json, "layerId", &member.layer_id) ||
            !runtime_resolve_property(target_json, &member.ref) ||
            !runtime_validate_member_value(member.ref, entry)) {
            *err_out = A_Err_PARAMETER;
            *error_code = "INVALID_PAYLOAD";
            return "null";
        }
        members.push_back(member);
    }

    // Phase 2: resolve every target, prove every one writable, and capture every prior value.
    for (RevisionMember &member : members) {
        A_Err err = runtime_layer_by_ids(static_cast<A_long>(member.item_id),
                                        static_cast<AEGP_LayerIDVal>(member.layer_id), &member.layer);
        if (err != A_Err_NONE || member.layer == nullptr) {
            *err_out = err == A_Err_NONE ? A_Err_GENERIC : err;
            *error_code = "TARGET_NOT_FOUND";
            return "null";
        }
        g.layer->AEGP_GetLayerSourceItemID(member.layer, &member.source_id);
        bool writable = false;
        const char *reason = "null";
        err = runtime_property_writable(member.layer, member.ref, &writable, &reason);
        if (err != A_Err_NONE) {
            *err_out = err;
            *error_code = "TARGET_NOT_FOUND";
            return "null";
        }
        if (!writable) {
            *err_out = A_Err_GENERIC;
            *error_code = "PROPERTY_READ_ONLY";
            return "null";
        }
        err = runtime_property_value_json(member.layer, member.ref, &member.previous_json);
        if (err != A_Err_NONE) { *err_out = err; return "null"; }
    }

    // Phase 3: write. The sequencing lives in `revision_apply.cpp` so it can be measured without After
    // Effects; the lambdas below are the only AE-aware part. `AE-CD2`'s gap was that this path had never
    // been triggered — the harness triggers the sequence, the licensed host still owes the real refusal.
    g.util->AEGP_StartUndoGroup("GrapiX data revision");
    const grapix::RevisionApplyReport report = grapix::apply_revision_with_rollback(
        members.size(),
        [&members](std::size_t index) {
            // Checked before the AE call, so the injected member is genuinely never written and the
            // restore path sees exactly the state a real mid-batch failure would leave behind.
            if (consume_injected_revision_write_fault(index)) {
                return grapix::RevisionWriteStatus{false, "FAULT_INJECTED"};
            }
            std::string code, body;
            const A_Err write = runtime_write_property(members[index].layer, members[index].ref,
                                                      members[index].member_json, &code, &body);
            return grapix::RevisionWriteStatus{write == A_Err_NONE, code};
        },
        [&members](std::size_t index) {
            std::string code, body;
            const A_Err back = runtime_write_property(members[index].layer, members[index].ref,
                                                     members[index].previous_json, &code, &body);
            return grapix::RevisionWriteStatus{back == A_Err_NONE, code};
        });
    g.util->AEGP_EndUndoGroup();

    if (report.outcome != grapix::RevisionOutcome::Applied) {
        *err_out = A_Err_GENERIC;
        // A mixed state gets its own name. Rule 238 already refused to call it a clean rollback; it was
        // still wearing `AE_ERROR`, the same code as any ordinary refusal, which is the one situation an
        // operator must be able to tell apart from the routine ones.
        *error_code = report.mixed_state() ? "REVISION_ROLLBACK_FAILED" : "REVISION_ROLLED_BACK";
        return "null";
    }

    // The echo reports each member's prior and new value as the read bodies carry them, so a text or
    // colour member is described in its own type rather than coerced into a number.
    std::string out = "{\"revision\":" + std::to_string(static_cast<long long>(revision)) + ",\"applied\":[";
    for (size_t index = 0; index < members.size(); ++index) {
        std::string current;
        if (runtime_property_value_json(members[index].layer, members[index].ref, &current) != A_Err_NONE) {
            current = "null";
        }
        out += index == 0 ? "" : ",";
        out += "{\"target\":" + runtime_property_target_json(
                   static_cast<A_long>(members[index].item_id),
                   static_cast<AEGP_LayerIDVal>(members[index].layer_id),
                   members[index].source_id, members[index].ref.canonical) +
               ",\"previous\":" + members[index].previous_json +
               ",\"current\":" + current + "}";
    }
    *err_out = A_Err_NONE;
    return out + "],\"rolledBack\":false}";
}

std::string runtime_list_project_items(A_Err *err_out)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) { *err_out = err; return "null"; }
    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    if (err != A_Err_NONE) { *err_out = err; return "null"; }
    std::string out = "[";
    bool first = true;
    while (item != nullptr) {
        A_long item_id = 0;
        AEGP_ItemType type = AEGP_ItemType_NONE;
        AEGP_MemHandle name_handle = nullptr;
        g.item->AEGP_GetItemID(item, &item_id);
        g.item->AEGP_GetItemType(item, &type);
        std::string name;
        if (g.item->AEGP_GetItemName(g_plugin_id, item, &name_handle) == A_Err_NONE) name = take_handle_string(name_handle);
        const char *kind = type == AEGP_ItemType_FOLDER ? "folder" :
                           type == AEGP_ItemType_COMP ? "composition" :
                           type == AEGP_ItemType_FOOTAGE ? "footage" : "unknown";
        char entry[1024];
        sprintf_s(entry, sizeof(entry),
                  "%s{\"itemId\":%ld,\"parentItemId\":null,\"itemType\":\"%s\",\"displayName\":\"%s\"}",
                  first ? "" : ",", static_cast<long>(item_id), kind, json_escape(name).c_str());
        out += entry;
        first = false;
        AEGP_ItemH next = nullptr;
        if (g.item->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) break;
        item = next;
    }
    *err_out = A_Err_NONE;
    return out + "]";
}

std::string runtime_list_compositions(A_Err *err_out)
{
    AEGP_ProjectH project = nullptr;
    A_Err err = first_project(&project);
    if (err != A_Err_NONE) { *err_out = err; return "null"; }
    AEGP_ItemH item = nullptr;
    err = g.item->AEGP_GetFirstProjItem(project, &item);
    std::string out = "[";
    bool first = true;
    while (err == A_Err_NONE && item != nullptr) {
        AEGP_ItemType type = AEGP_ItemType_NONE;
        g.item->AEGP_GetItemType(item, &type);
        if (type == AEGP_ItemType_COMP) {
            A_long item_id = 0, width = 0, height = 0;
            A_Time duration = {0, 1};
            AEGP_CompH comp = nullptr;
            A_FpLong frame_rate = 0.0;
            // The composition's own clock, as an exact rational. `frameRate` below is an `A_FpLong`
            // and cannot be trusted to separate 2997/100 from 30000/1001 — that distinction is the
            // whole reason a cue declared at 30000/1001 was quantised onto a neighbouring frame by a
            // composition whose scale is 23976. GrapiX reconciles against this pair, never the float.
            A_Time frame_duration = {0, 1};
            bool has_frame_duration = false;
            AEGP_MemHandle name_handle = nullptr;
            std::string name;
            g.item->AEGP_GetItemID(item, &item_id);
            g.item->AEGP_GetItemDimensions(item, &width, &height);
            g.item->AEGP_GetItemDuration(item, &duration);
            if (g.item->AEGP_GetItemName(g_plugin_id, item, &name_handle) == A_Err_NONE) name = take_handle_string(name_handle);
            if (g.comp->AEGP_GetCompFromItem(item, &comp) == A_Err_NONE) {
                g.comp->AEGP_GetCompFramerate(comp, &frame_rate);
                // A composition with a zero or negative frame duration has no clock to report, and a
                // fabricated one would be worse than its absence: the field is omitted instead.
                if (g.comp->AEGP_GetCompFrameDuration(comp, &frame_duration) == A_Err_NONE &&
                    frame_duration.value > 0 && frame_duration.scale > 0) {
                    has_frame_duration = true;
                }
            }
            char entry[1024];
            if (has_frame_duration) {
                sprintf_s(entry, sizeof(entry),
                          "%s{\"itemId\":%ld,\"displayName\":\"%s\",\"width\":%ld,\"height\":%ld,"
                          "\"duration\":{\"value\":\"%ld\",\"scale\":\"%lu\"},\"frameRate\":\"%.9g\","
                          "\"clock\":{\"frameDuration\":\"%ld\",\"timeScale\":\"%lu\"}}",
                          first ? "" : ",", static_cast<long>(item_id), json_escape(name).c_str(),
                          static_cast<long>(width), static_cast<long>(height), static_cast<long>(duration.value),
                          static_cast<unsigned long>(duration.scale), frame_rate,
                          static_cast<long>(frame_duration.value),
                          static_cast<unsigned long>(frame_duration.scale));
            } else {
                sprintf_s(entry, sizeof(entry),
                          "%s{\"itemId\":%ld,\"displayName\":\"%s\",\"width\":%ld,\"height\":%ld,"
                          "\"duration\":{\"value\":\"%ld\",\"scale\":\"%lu\"},\"frameRate\":\"%.9g\"}",
                          first ? "" : ",", static_cast<long>(item_id), json_escape(name).c_str(),
                          static_cast<long>(width), static_cast<long>(height), static_cast<long>(duration.value),
                          static_cast<unsigned long>(duration.scale), frame_rate);
            }
            out += entry;
            first = false;
        }
        AEGP_ItemH next = nullptr;
        err = g.item->AEGP_GetNextProjItem(project, item, &next);
        item = next;
    }
    *err_out = A_Err_NONE;
    return out + "]";
}

std::string runtime_list_layers(const std::string &payload, A_Err *err_out)
{
    std::int64_t composition_item_id = 0;
    if (!runtime_payload_integer(payload, "compositionItemId", &composition_item_id)) {
        *err_out = A_Err_PARAMETER;
        return "null";
    }
    AEGP_CompH comp = nullptr;
    A_Err err = runtime_comp_by_item_id(static_cast<A_long>(composition_item_id), &comp);
    if (err != A_Err_NONE) { *err_out = err; return "null"; }
    A_long count = 0;
    err = g.layer->AEGP_GetCompNumLayers(comp, &count);
    std::string out = "[";
    for (A_long index = 0; err == A_Err_NONE && index < count; ++index) {
        AEGP_LayerH layer = nullptr;
        AEGP_LayerIDVal layer_id = 0;
        AEGP_ItemH source = nullptr;
        A_long source_id = 0;
        std::string name;
        AEGP_MemHandle name_handle = nullptr, source_handle = nullptr;
        err = g.layer->AEGP_GetCompLayerByIndex(comp, index, &layer);
        if (err != A_Err_NONE) break;
        g.layer->AEGP_GetLayerID(layer, &layer_id);
        if (g.layer->AEGP_GetLayerSourceItem(layer, &source) == A_Err_NONE && source != nullptr) g.item->AEGP_GetItemID(source, &source_id);
        if (g.layer->AEGP_GetLayerName(g_plugin_id, layer, &name_handle, &source_handle) == A_Err_NONE) {
            name = take_handle_string(name_handle);
            if (source_handle != nullptr) g.mem->AEGP_FreeMemHandle(source_handle);
        }
        char entry[1024];
        char source_json[32];
        if (source == nullptr) strcpy_s(source_json, sizeof(source_json), "null");
        else sprintf_s(source_json, sizeof(source_json), "%ld", static_cast<long>(source_id));
        sprintf_s(entry, sizeof(entry),
                  "%s{\"compositionItemId\":%lld,\"layerId\":%ld,\"sourceItemId\":%s,\"index\":%ld,\"displayName\":\"%s\"}",
                  index == 0 ? "" : ",", static_cast<long long>(composition_item_id), static_cast<long>(layer_id),
                  source_json, static_cast<long>(index), json_escape(name).c_str());
        out += entry;
    }
    *err_out = err;
    return out + "]";
}

// ---------------------------------------------------------------------------
// Hooks
std::string runtime_fixture_identity(const std::string &payload, A_Err *err_out)
{
    std::int64_t item_id = 0, layer_id = 0;
    std::string action;
    if (!runtime_payload_integer(payload, "compositionItemId", &item_id) ||
        !runtime_payload_integer(payload, "layerId", &layer_id) ||
        !runtime_payload_string(payload, "action", &action)) {
        *err_out = A_Err_PARAMETER;
        return "null";
    }
    AEGP_LayerH layer = nullptr;
    A_Err err = runtime_layer_by_ids(static_cast<A_long>(item_id), static_cast<AEGP_LayerIDVal>(layer_id), &layer);
    AEGP_LayerH duplicate = nullptr;
    if (err == A_Err_NONE && action == "rename") {
        std::string name;
        if (!runtime_payload_string(payload, "name", &name)) err = A_Err_PARAMETER;
        else {
            std::vector<A_UTF16Char> utf16 = utf8_to_utf16(name);
            err = g.layer->AEGP_SetLayerName(layer, utf16.data());
        }
    } else if (err == A_Err_NONE && action == "duplicate") {
        err = g.layer->AEGP_DuplicateLayer(layer, &duplicate);
    } else if (action != "rename" && action != "duplicate") {
        err = A_Err_PARAMETER;
    }
    AEGP_LayerIDVal resolved_id = 0, duplicate_id = 0;
    if (err == A_Err_NONE) g.layer->AEGP_GetLayerID(layer, &resolved_id);
    if (duplicate != nullptr) g.layer->AEGP_GetLayerID(duplicate, &duplicate_id);
    char duplicate_json[32];
    if (duplicate == nullptr) strcpy_s(duplicate_json, sizeof(duplicate_json), "null");
    else sprintf_s(duplicate_json, sizeof(duplicate_json), "%ld", static_cast<long>(duplicate_id));
    char out[256];
    sprintf_s(out, sizeof(out), "{\"layerId\":%ld,\"duplicateLayerId\":%s}",

              static_cast<long>(resolved_id), duplicate_json);
    *err_out = err;
    return err == A_Err_NONE ? std::string(out) : "null";
}

/**
 * AE-F2 checkout production calls these only after it has published a descriptor and payload, or
 * refused that publish. They serialise control-plane correlation only; pixels never enter the pipe.
 */
bool emit_render_ready_event(const std::string &render_request_id,
                                               std::int64_t composition_item_id,
                                               const std::string &time_json,
                                               std::int64_t data_revision,
                                               const std::string &frame_id,
                                               const std::string &presentation_deadline_nanos)
{
    const std::string detail = "{\"renderRequestId\":\"" + json_escape(render_request_id) +
        "\",\"compositionItemId\":" + std::to_string(composition_item_id) +
        ",\"time\":" + time_json + ",\"dataRevision\":" + std::to_string(data_revision) +
        ",\"frameId\":\"" + json_escape(frame_id) + "\",\"presentationDeadlineNanos\":\"" +
        json_escape(presentation_deadline_nanos) + "\"}";
    return g_runtime_pipe.emit_event("RENDER_READY", detail);
}

bool emit_render_failed_event(const std::string &render_request_id,
                                                std::int64_t composition_item_id,
                                                const std::string &time_json,
                                                const std::string &data_revision_json,
                                                const std::string &error_code,
                                                const std::string &error_message,
                                                bool retryable)
{
    const std::string detail = "{\"renderRequestId\":\"" + json_escape(render_request_id) +
        "\",\"compositionItemId\":" + std::to_string(composition_item_id) +
        ",\"time\":" + (time_json.empty() ? "null" : time_json) +
        ",\"dataRevision\":" + (data_revision_json.empty() ? "null" : data_revision_json) +
        ",\"error\":{\"code\":\"" + json_escape(error_code) + "\",\"message\":\"" +
        json_escape(error_message) + "\",\"retryable\":" + (retryable ? "true" : "false") + "}}";
    return g_runtime_pipe.emit_event("RENDER_FAILED", detail);
}



// ---------------------------------------------------------------------------

grapix::RuntimePipeCompletion dispatch_runtime_request(const grapix::RuntimePipeRequest &request)
{
    grapix::RuntimePipeCompletion completion;
    completion.surface = "aegp-sdk";
    A_Err err = A_Err_NONE;
    std::string body;
    if (request.operation == "HEALTH") {
        body = std::string("{") + do_ping() + "}";
    } else if (request.operation == "LIST_PROJECT_ITEMS") {
        body = runtime_list_project_items(&err);
    } else if (request.operation == "LIST_COMPOSITIONS") {
        body = runtime_list_compositions(&err);
    } else if (request.operation == "LIST_LAYERS") {
        body = runtime_list_layers(request.payload_json, &err);
    } else if (request.operation == "LIST_PROPERTIES" ||
               request.operation == "READ_PROPERTY_METADATA") {
        body = runtime_list_properties(request.payload_json, &err);
    } else if (request.operation == "READ_PROPERTY") {
        body = runtime_read_property(request.payload_json, &err);
    } else if (request.operation == "SET_PROPERTY") {
        std::string refusal;
        body = runtime_set_property(request.payload_json, &err, &refusal);
        if (!refusal.empty()) completion.error_code = refusal;
    } else if (request.operation == "APPLY_DATA_REVISION") {
        std::string refusal;
        body = runtime_apply_data_revision(request.payload_json, &err, &refusal);
        if (!refusal.empty()) completion.error_code = refusal;
    } else if (request.operation == "SET_TIME") {
        std::string refusal;
        body = runtime_set_time(request.payload_json, &err, &refusal);
        if (!refusal.empty()) completion.error_code = refusal;
    } else if (request.operation == "RENDER_FRAME") {
        std::string refusal;
        body = runtime_render_frame(request.payload_json, &err, &refusal);
        if (!refusal.empty()) completion.error_code = refusal;
    } else if (request.operation == "LIST_EFFECTS") {
        body = runtime_list_effects(request.payload_json, &err);
    } else if (request.operation == "FIXTURE_IDENTITY") {
        body = runtime_fixture_identity(request.payload_json, &err);
    } else if (request.operation == "SHUTDOWN") {
        body = "{\"accepted\":true}";
    } else {
        completion.error_code = "OPERATION_UNSUPPORTED";
        completion.error_message = "operation is not implemented by this adapter build";
        return completion;
    }
    if (err != A_Err_NONE) {
        if (completion.error_code.empty()) completion.error_code = "AE_ERROR";
        completion.error_message = completion.error_code == "PROPERTY_READ_ONLY"
            ? "property is keyframed or expression-enabled"
            : completion.error_code == "REVISION_ROLLED_BACK"
                ? "the revision failed part-way and every applied member was restored"
                : completion.error_code == "REVISION_ROLLBACK_FAILED"
                    ? "the revision failed part-way and at least one member could not be restored: After Effects holds a mixed state and no retry is safe until it is inspected"
                    : "After Effects rejected the operation";
        return completion;
    }
    completion.ok = true;
    completion.result_json = body;
    return completion;
}

A_Err dispatch(const Command &command)
{
    A_Err err = A_Err_NONE;
    std::string body;

    switch (command.verb) {
        case VERB_PING: body = do_ping(); break;
        case VERB_OPEN: body = do_open(command.arguments, &err); break;
        case VERB_LIST: body = do_list(&err); break;
        case VERB_READ: body = do_read(command.arguments, &err); break;
        case VERB_SET: body = do_set(command.arguments, &err); break;
        case VERB_PROBE: body = do_probe(command.arguments, &err); break;
        case VERB_DIRTY: body = do_dirty(&err); break;
        case VERB_DISCARD: body = do_discard(&err); break;
        case VERB_FIXTURE_CONTROL: body = do_fixture_control(command.arguments, &err); break;
        case VERB_CHECKOUT: body = do_checkout(command.arguments, &err); break;
        case VERB_FIXTURE: body = do_fixture(command.arguments, &err); break;
        default:
            body = "\"reason\":\"unknown verb; the adapter accepts ping, open, list, read, set, "
                   "probe, dirty, discard, checkout, fixture, fixture-control\"";
            break;
    }

    g_commands_executed += 1;

    char head[256];
    sprintf_s(head, sizeof(head),
              "{\"sequence\":%ld,\"hostPid\":%lu,\"ok\":%s,\"aeError\":%d,\"commandsExecuted\":%ld,",
              command.sequence, static_cast<unsigned long>(GetCurrentProcessId()),
              err == A_Err_NONE ? "true" : "false",
              static_cast<int>(err), g_commands_executed);

    std::string json = std::string(head) + body + "}\n";
    write_result(json);
    append_log(json.substr(0, json.size() - 1));
    return err;
}

A_Err IdleHook(AEGP_GlobalRefcon /*plugin_refconP*/, AEGP_IdleRefcon /*refconP*/, A_long *max_sleepPL)
{
    // First idle tick records which thread AE gives us. AE-F0 needs a known thread to compare a
    // checkout against, and the hook is the only thread this adapter is ever handed.
    if (g_hook_thread_id == 0UL) g_hook_thread_id = GetCurrentThreadId();

    // Callback cadence, measured rather than assumed. AE-F3 found the frame path capped at ~21 Hz
    // because exactly one request was serviced per callback, so how often this hook runs — and the
    // worst gap between runs — are now facts a caller can read out of HEALTH.
    const std::uint64_t entered_at_micros = monotonic_micros();
    if (g_idle_first_micros == 0ULL) g_idle_first_micros = entered_at_micros;
    if (g_idle_last_micros != 0ULL) {
        const std::uint64_t gap = entered_at_micros - g_idle_last_micros;
        if (gap > g_idle_max_gap_micros) g_idle_max_gap_micros = gap;
    }
    g_idle_last_micros = entered_at_micros;
    ++g_idle_tick;

    // Service a *batch*, bounded twice. The count bound keeps one callback from becoming an unbounded
    // work loop; the time bound keeps a batch of slow operations — a render is tens of milliseconds —
    // from holding AE's own thread for an unpredictable stretch. Whichever bound is reached first wins,
    // and anything still queued is serviced on the next callback rather than dropped.
    unsigned serviced = 0;
    grapix::RuntimePipeRequest runtime_request;
    while (serviced < g_max_requests_per_idle_callback &&
           (monotonic_micros() - entered_at_micros) < g_idle_service_budget_micros &&
           g_runtime_pipe.take_request(&runtime_request)) {
        g_runtime_pipe.complete(runtime_request, dispatch_runtime_request(runtime_request));
        g_pipe_serviced_total += 1;
        serviced += 1;
    }

    // Sleep advice, in AE's 1/60s ticks. With work still queued, ask for the shortest sleep AE will
    // honour so the next batch starts sooner; with nothing pending, stay at ten ticks so an idle AE is
    // not spun by a plugin with nothing to do.
    if (max_sleepPL != nullptr) {
        const A_long wanted = g_runtime_pipe.pending_requests() > 0 ? 1 : 10;
        if (*max_sleepPL > wanted) *max_sleepPL = wanted;
    }

    Command command = read_command();
    if (!command.valid) return A_Err_NONE;
    if (command.sequence <= g_last_sequence) return A_Err_NONE;

    g_last_sequence = command.sequence;
    dispatch(command);
    return A_Err_NONE;
}

A_Err DeathHook(AEGP_GlobalRefcon /*plugin_refconP*/, AEGP_DeathRefcon /*refconP*/)
{
    char line[256];
    sprintf_s(line, sizeof(line),
              "{\"event\":\"death\",\"commandsExecuted\":%ld,\"lastSequence\":%ld}",
              g_commands_executed, g_last_sequence);
    g_runtime_pipe.stop();
    append_log(line);
    return A_Err_NONE;
}

} // namespace

// ---------------------------------------------------------------------------
// Entry point. Named in the PiPL; AE calls it once when it loads the plugin.
// ---------------------------------------------------------------------------

extern "C" DllExport A_Err EntryPointFunc(
    struct SPBasicSuite *pica_basicP,
    A_long /*major_versionL*/,
    A_long /*minor_versionL*/,
    AEGP_PluginID aegp_plugin_id,
    AEGP_GlobalRefcon * /*global_refconV*/)
{
    g_plugin_id = aegp_plugin_id;
    g.basic = pica_basicP;
    if (g.basic == nullptr) return A_Err_GENERIC;

    // Acquire every suite up front and refuse to load if one is missing: an adapter that
    // half-registers is worse than one that visibly fails, because the failure surfaces later
    // as a mysterious command error.
    A_Err err = A_Err_NONE;
    err |= g.basic->AcquireSuite(kAEGPProjSuite, kAEGPProjSuiteVersion6, (const void **)&g.proj);
    err |= g.basic->AcquireSuite(kAEGPItemSuite, kAEGPItemSuiteVersion9, (const void **)&g.item);
    err |= g.basic->AcquireSuite(kAEGPCompSuite, kAEGPCompSuiteVersion12, (const void **)&g.comp);
    err |= g.basic->AcquireSuite(kAEGPLayerSuite, kAEGPLayerSuiteVersion9, (const void **)&g.layer);
    err |= g.basic->AcquireSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6, (const void **)&g.stream);
    err |= g.basic->AcquireSuite(kAEGPDynamicStreamSuite, kAEGPDynamicStreamSuiteVersion4, (const void **)&g.dynamicStream);
    err |= g.basic->AcquireSuite(kAEGPKeyframeSuite, kAEGPKeyframeSuiteVersion5, (const void **)&g.keyframe);
    err |= g.basic->AcquireSuite(kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6, (const void **)&g.util);
    err |= g.basic->AcquireSuite(kAEGPMemorySuite, kAEGPMemorySuiteVersion1, (const void **)&g.mem);
    err |= g.basic->AcquireSuite(kAEGPRegisterSuite, kAEGPRegisterSuiteVersion5, (const void **)&g.reg);
    err |= g.basic->AcquireSuite(kAEGPTextDocumentSuite, kAEGPTextDocumentSuiteVersion1, (const void **)&g.textDocument);
    err |= g.basic->AcquireSuite(kAEGPEffectSuite, kAEGPEffectSuiteVersion5, (const void **)&g.effect);
    err |= g.basic->AcquireSuite(kAEGPFootageSuite, kAEGPFootageSuiteVersion5, (const void **)&g.footage);
    if (err != A_Err_NONE) return err;

    if (!resolve_state_dir()) return A_Err_GENERIC;

    // The pixel path is acquired separately and its failures are not fatal: a build that cannot
    // supply these should still load and answer control commands, with `checkout` reporting why.
    // Note kAEGPRenderSuiteVersion5 is the macro whose value is 8 — using the number would be a
    // guess, and the pair has been wrong in this codebase before.
    g.basic->AcquireSuite(kAEGPRenderOptionsSuite, kAEGPRenderOptionsSuiteVersion4, (const void **)&g.renderOptions);
    g.basic->AcquireSuite(kAEGPRenderSuite, kAEGPRenderSuiteVersion5, (const void **)&g.render);
    g.basic->AcquireSuite(kAEGPWorldSuite, kAEGPWorldSuiteVersion3, (const void **)&g.world);
    g.basic->AcquireSuite(kAEGPMaskSuite, kAEGPMaskSuiteVersion6, (const void **)&g.mask);
    g.basic->AcquireSuite(kAEGPMaskOutlineSuite, kAEGPMaskOutlineSuiteVersion3, (const void **)&g.maskOutline);

    err |= g.reg->AEGP_RegisterIdleHook(g_plugin_id, IdleHook, nullptr);
    err |= g.reg->AEGP_RegisterDeathHook(g_plugin_id, DeathHook, nullptr);
    if (err != A_Err_NONE) return err;

    A_short driver_major = 0;
    A_short driver_minor = 0;
    g.util->AEGP_GetDriverImplementationVersion(&driver_major, &driver_minor);

    char line[512];
    sprintf_s(line, sizeof(line),
              "{\"event\":\"loaded\",\"hostPid\":%lu,\"pluginId\":%ld,\"driverMajor\":%d,"
              "\"driverMinor\":%d,\"stateDir\":\"%s\"}",
              static_cast<unsigned long>(GetCurrentProcessId()),
              static_cast<long>(g_plugin_id), static_cast<int>(driver_major),
              static_cast<int>(driver_minor), json_escape(g_state_dir).c_str());
    const char *adapter_sha = std::getenv("GRAPIX_AE_RUNTIME_ADAPTER_SHA256");
    const char *plugin_set_sha = std::getenv("GRAPIX_AE_RUNTIME_PLUGIN_SET_SHA256");
    arm_fault_injection();
    configure_idle_service_bounds();
    std::string fingerprint =
        std::string("{\"aeVersion\":\"26.3\",\"adapterVersion\":\"1.0.0\",\"adapterSha256\":\"") +
        json_escape(adapter_sha == nullptr ? std::string(64, '0') : adapter_sha) +
        "\",\"pluginSetSha256\":\"" +
        json_escape(plugin_set_sha == nullptr ? std::string(64, '0') : plugin_set_sha) +
        "\",\"suiteVersions\":{\"AEGP_ProjSuite\":6,\"AEGP_ItemSuite\":9,\"AEGP_CompSuite\":12,"
        "\"AEGP_LayerSuite\":9,\"AEGP_StreamSuite\":6,\"AEGP_EffectSuite\":5},"
        // Armed injection travels in the fingerprint so a supervisor sees it on connect and a
        // certification run can refuse evidence from an adapter that was told to fail.
        "\"faultInjection\":" + fault_injection_fingerprint() + "}";
    g_runtime_pipe.start(fingerprint, static_cast<unsigned long>(GetCurrentProcessId()));
    append_log(line);

    // A load marker written immediately, so "did AE load the adapter?" is answerable without
    // sending a command and without AE's UI. It carries the host pid for the same reason every
    // reply does: the channel cannot say by itself which process wrote to it.
    char marker[512];
    sprintf_s(marker, sizeof(marker),
              "{\"sequence\":0,\"hostPid\":%lu,\"ok\":true,\"aeError\":0,\"commandsExecuted\":0,"
              "\"event\":\"loaded\",",
              static_cast<unsigned long>(GetCurrentProcessId()));
    write_result(std::string(marker) + do_ping() + "}\n");
    return A_Err_NONE;
}
