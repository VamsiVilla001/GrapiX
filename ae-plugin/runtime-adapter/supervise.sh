#!/usr/bin/env sh
# AE-A0 lifecycle harness: launch After Effects, get it to a commandable state, drive it, quit
# it cleanly. This is the shape AE-A2's supervisor needs, proven at spike scale.
#
#   ./supervise.sh start [project.aep]   launch, clear startup modals, wait for a live channel
#   ./supervise.sh quit                  graceful quit, discarding changes, never saving
#   ./supervise.sh cycle N [project.aep] N × start → command → quit, one line of evidence each
#
# Readiness is not "the process exists". It is: the adapter wrote its load marker AND a command
# round-tripped through AE's callback. Finding F3 is why — the idle hook does not fire until AE
# reaches its normal idle state, so a PID proves nothing.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
AE_ROOT="${GRAPIX_AE_ROOT:-C:/Program Files/Adobe/Adobe After Effects 2026}"
AE_EXE="$AE_ROOT/Support Files/afterfx.exe"
STATE_DIR="${GRAPIX_AE_ADAPTER_DIR:-$LOCALAPPDATA/GrapiX/ae-adapter}"
WINDOW_HELPER="$HERE/ae-window.ps1"
CLAIM_FILE="$STATE_DIR/grapix-owner.json"
# A cold AE 2026 start on this host is ~150 s: it rescans plugins and fonts before the editor
# window exists. 120 s looked like a hang and was not one, so the budget states the measurement.
READY_TIMEOUT="${READY_TIMEOUT:-300}"

# A startup whose CPU counter has not moved for this long, with no adapter marker, is stalled
# rather than slow: the measured stalls froze the counter completely, while healthy cold starts
# advanced it every sample and reached the editor in 40-90 s.
STALL_SECONDS="${STALL_SECONDS:-60}"
# How many launches one cycle may spend before the host itself is called unhealthy.
START_ATTEMPTS="${START_ATTEMPTS:-3}"
# Which layer a cycle writes to. Layer 0 exists in any composition that has layers at all, so the
# gate is not tied to one fixture's shape: pointing it at layer 16 made a 3-cycle run on a
# two-layer fixture report command-failed, which is a harness assumption failing, not the runtime.
PROBE_LAYER="${PROBE_LAYER:-0}"

ps_run() {
    powershell -NoProfile -ExecutionPolicy Bypass -File "$WINDOW_HELPER" "$@" 2>&1
}

ae_running() {
    powershell -NoProfile -Command "if (Get-Process afterfx -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }" 2>/dev/null | tr -d '\r'
}

start_ae() {
    project="${1:-}"

    if [ "$(ae_running)" = "yes" ]; then
        echo "an After Effects is already running; quit it first" >&2
        return 1
    fi

    # A stale load marker would make readiness look instant, so the channel starts empty. The
    # claim goes too: ownership is only ever established by a launch this harness performed.
    rm -f "$STATE_DIR/result.json" "$STATE_DIR/command.txt" "$STATE_DIR/sequence.txt" "$CLAIM_FILE" 2>/dev/null || true

    if [ -n "$project" ]; then
        powershell -NoProfile -Command "Start-Process -FilePath '$AE_EXE' -ArgumentList '\"$project\"'" >/dev/null 2>&1
    else
        powershell -NoProfile -Command "Start-Process -FilePath '$AE_EXE'" >/dev/null 2>&1
    fi

    # After Effects' startup queues modal dialogs, and until they are answered its idle loop never
    # runs — so the adapter loads but no command can reach it. They cannot be answered the way a
    # person would: no automatable controls, usually no window text, sometimes never painted at
    # all, and synthetic keystrokes are ignored. Found by window class and answered with WM_CLOSE,
    # they clear, and WM_CLOSE takes each one's non-destructive default — after clearing a chain
    # containing Crash Repair Options, whose neighbours are "Start in Safe Mode" and "Manage
    # Plugins", this adapter still loaded and answered. That is the evidence for doing it.
    #
    # Provisioning still matters more than clearing: a clean quit stops the crash dialog from ever
    # being armed, and a host with broken third-party plugins raises a load-failure modal on every
    # cold scan. The clearing loop is what makes an unattended start survive them anyway.
    #
    # Readiness itself is the adapter's channel: its load marker, then a command that round-trips
    # through AE's callback. Not a window — a commandable AE here had no editor window at all.
    waited=0
    last_cpu=""
    frozen_for=0
    while [ "$waited" -lt "$READY_TIMEOUT" ]; do
        # Readiness is a successful round-trip, and *only* that. An earlier version required the
        # adapter's `"event":"loaded"` marker in result.json first — but result.json is the reply
        # slot, so the first command that succeeds overwrites the marker with its own answer. If
        # that command's reply arrived after the caller's timeout, readiness could never be
        # declared again: the channel was live and the gate was watching for a file that no longer
        # existed. The claim uses the pid from the reply, which is the only process identity the
        # channel carries.
        claimed=$(TIMEOUT_SECONDS=10 sh "$HERE/send.sh" ping 2>/dev/null | sed -n 's/.*"hostPid":\([0-9]*\).*/\1/p' | head -1)
        if [ -n "$claimed" ]; then
            # Windows paths are full of backslashes, and an unescaped one makes this file invalid
            # JSON for anything that later tries to read the claim.
            escaped_project=$(printf '%s' "$project" | sed 's/\\/\\\\/g')
            printf '{ "ownedPid": %s, "launchedAt": "%s", "project": "%s" }\n' \
                "$claimed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$escaped_project" > "$CLAIM_FILE"
            echo "ready after ${waited}s (owned pid $claimed)"
            return 0
        fi

        # Answer whatever startup queued. Cheap when there is nothing to close.
        cleared=$(ps_run -Action clear-dialogs 2>/dev/null | sed -n 's/^closed: //p' | head -1)
        if [ -n "$cleared" ] && [ "$cleared" != "0" ]; then
            echo "  cleared $cleared startup dialog(s) at ${waited}s"
            frozen_for=0
        fi

        cpu=$(powershell -NoProfile -Command "\$p=Get-Process afterfx -ErrorAction SilentlyContinue; if(\$p){\$p.CPU}else{'gone'}" 2>/dev/null | tr -d '\r ')
        if [ "$cpu" = "gone" ] || [ -z "$cpu" ]; then
            echo "after effects exited during startup" >&2
            return 3
        fi
        if [ "$cpu" = "$last_cpu" ]; then
            frozen_for=$((frozen_for + 3))
        else
            last_cpu="$cpu"
            frozen_for=0
        fi
        if [ "$frozen_for" -ge "$STALL_SECONDS" ]; then
            echo "startup stalled: cpu=$cpu unchanged for ${frozen_for}s, no adapter marker" >&2
            ps_run -Action await-editor -TimeoutSeconds 5 | sed 's/^/  /' >&2
            return 2
        fi

        sleep 3
        waited=$((waited + 3))
    done

    echo "not-ready after ${READY_TIMEOUT}s" >&2
    ps_run -Action await-editor -TimeoutSeconds 5 | sed 's/^/  /' >&2
    return 1
}

# The ownership rule, and the reason it exists: `discard` throws away unsaved work and `quit`
# closes the application. On an After Effects this harness launched, both are correct — it owns
# the session and the project is a fixture. On an After Effects an operator is working in, both
# are destructive, and the adapter cannot tell the difference: the channel is a shared file pair,
# and any AE with the adapter installed answers on it.
#
# So ownership is a claim written at launch, holding the pid the adapter itself reported, and a
# process that does not match the claim is *attached*, not owned: controls are allowed, lifecycle
# is refused.
ownership_of() {
    live_pid=$(TIMEOUT_SECONDS=10 sh "$HERE/send.sh" ping 2>/dev/null | sed -n 's/.*"hostPid":\([0-9]*\).*/\1/p' | head -1)
    if [ -z "$live_pid" ]; then
        echo "unreachable"
        return 0
    fi
    if [ ! -f "$CLAIM_FILE" ]; then
        echo "attached $live_pid"
        return 0
    fi
    owned_pid=$(sed -n 's/.*"ownedPid": *\([0-9]*\).*/\1/p' "$CLAIM_FILE" | head -1)
    if [ "$live_pid" = "$owned_pid" ]; then
        echo "owned $live_pid"
    else
        echo "attached $live_pid"
    fi
}

quit_ae() {
    if [ "$(ae_running)" = "no" ]; then
        echo "already-stopped"
        return 0
    fi

    ownership=$(ownership_of)
    case "$ownership" in
        owned\ *) echo "  ${ownership} — this harness launched it, lifecycle allowed" ;;
        attached\ *)
            echo "refusing to quit: ${ownership}. This After Effects was not launched by this" >&2
            echo "harness, so it may hold an operator's unsaved work. Close it yourself." >&2
            return 4
            ;;
        *)
            echo "refusing to quit: the adapter did not answer, so ownership cannot be proven" >&2
            return 4
            ;;
    esac

    # A save prompt cannot be answered — AE's dialogs expose no named controls, and WM_CLOSE on
    # that prompt means Cancel. So the project is made clean *before* the quit, through the
    # adapter: AEGP_NewProject discards a dirty project with no modal at all, and unlike
    # AEGP_OpenProjectFromPath (finding F2) it leaves the idle channel alive.
    dirty=$(TIMEOUT_SECONDS=10 sh "$HERE/send.sh" dirty 2>/dev/null | head -c 300 || true)
    case "$dirty" in
        *'"dirty":true'*)
            echo "  project is dirty; discarding so no save prompt can appear"
            discarded=$(TIMEOUT_SECONDS=20 sh "$HERE/send.sh" discard 2>/dev/null | head -c 300 || true)
            case "$discarded" in
                *'"ok":true'*) echo "  discarded" ;;
                *) echo "  discard failed: ${discarded:-no answer}" >&2 ;;
            esac
            ;;
        *'"dirty":false'*) echo "  project is clean" ;;
        *)                 echo "  dirty state unknown: ${dirty:-no answer}" ;;
    esac

    ps_run -Action quit -TimeoutSeconds 60 | sed 's/^/  /'

    waited=0
    while [ "$waited" -lt 30 ]; do
        [ "$(ae_running)" = "no" ] && { echo "stopped"; return 0; }
        sleep 2
        waited=$((waited + 2))
    done

    echo "still running after graceful quit" >&2
    return 1
}

case "${1:-}" in

    # Attach to an After Effects this harness did not start: report what it is, what the ownership
    # rule allows against it, and prove control still works by reading — never by mutating.
    attach)
        if [ "$(ae_running)" = "no" ]; then
            echo "no After Effects running to attach to"
            exit 1
        fi
        ownership=$(ownership_of)
        echo "ownership: $ownership"
        case "$ownership" in
            unreachable)
                echo "the adapter did not answer; this AE is running without a live channel" >&2
                exit 1
                ;;
            owned\ *)
                echo "control: full — launched by this harness"
                ;;
            attached\ *)
                echo "control: read and property writes allowed; discard and quit refused"
                ;;
        esac
        listing=$(TIMEOUT_SECONDS=20 sh "$HERE/send.sh" list 2>/dev/null | head -c 200 || true)
        case "$listing" in
            *'"compositions"'*) echo "channel: live, project enumerated" ;;
            *) echo "channel: no enumeration (${listing:-no answer})" ;;
        esac
        ;;

    start)
        start_ae "${2:-}"
        ;;

    quit)
        quit_ae
        ;;

    cycle)
        count="${2:-30}"
        project="${3:-}"
        passed=0
        failed=0
        stalls=0
        # One log per run, named by start time. An earlier version wrote a single fixed path and
        # truncated it, which destroyed a completed 30/30 record the moment a 3-cycle smoke test
        # was run against a different fixture. Evidence is append-only or it is not evidence.
        started_run=$(date -u +%Y%m%dT%H%M%SZ)
        log="$HERE/certification/AE-A0-cycles-$started_run.log"
        mkdir -p "$(dirname "$log")"
        printf '# run %s | cycles=%s | project=%s | probe=layer %s\n' \
            "$started_run" "$count" "${project:-<none>}" "$PROBE_LAYER" > "$log"

        kill_ae() {
            powershell -NoProfile -Command "Get-Process afterfx -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true
            settle=0
            while [ "$settle" -lt 30 ]; do
                [ "$(ae_running)" = "no" ] && break
                sleep 2
                settle=$((settle + 2))
            done
            sleep 3
        }

        i=1
        while [ "$i" -le "$count" ]; do
            started_at=$(date +%s)
            outcome="ok"
            detail=""
            restarts=0

            # A stalled startup is recovered, bounded, and counted. Hiding it would make the
            # cycle number a lie; retrying without a limit would make a wedged host look healthy.
            attempt=1
            while : ; do
                start_ae "$project" >/dev/null 2>&1
                start_status=$?
                [ "$start_status" -eq 0 ] && break

                if [ "$start_status" -eq 2 ]; then
                    stalls=$((stalls + 1))
                    restarts=$((restarts + 1))
                fi
                kill_ae
                attempt=$((attempt + 1))
                if [ "$attempt" -gt "$START_ATTEMPTS" ]; then
                    outcome="start-failed"
                    break
                fi
            done

            if [ "$outcome" = "ok" ]; then
                # A cycle must prove launch → ready → real control work → clean shutdown, not
                # just that the process came up. So it writes a property and reads it back.
                detail=$(TIMEOUT_SECONDS=20 sh "$HERE/send.sh" set 0 "$PROBE_LAYER" opacity 42.5 2>/dev/null | head -c 220 || true)
                case "$detail" in
                    *'"readback":42.500000'*) : ;;
                    *) outcome="command-failed" ;;
                esac
            fi

            if [ "$(ae_running)" = "yes" ]; then
                if ! quit_ae >/dev/null 2>&1; then
                    # A cycle that cannot shut down cleanly poisons the next one with the crash
                    # dialog, which does block startup — so it is a failure even if the command
                    # worked, and the kill is recorded rather than hidden.
                    [ "$outcome" = "ok" ] && outcome="quit-failed"
                    kill_ae
                fi
            fi

            # Starting AE while a previous one is still exiting is a race the harness must not
            # introduce, so every cycle ends with the process actually gone.
            settle=0
            while [ "$settle" -lt 30 ]; do
                [ "$(ae_running)" = "no" ] && break
                sleep 2
                settle=$((settle + 2))
            done
            sleep 3

            elapsed=$(( $(date +%s) - started_at ))
            printf '%s cycle=%d outcome=%s seconds=%d restarts=%d %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$i" "$outcome" "$elapsed" "$restarts" "$detail" >> "$log"
            printf 'cycle %d/%d: %s (%ds, restarts=%d)\n' "$i" "$count" "$outcome" "$elapsed" "$restarts"

            if [ "$outcome" = "ok" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); fi
            i=$((i + 1))
        done

        echo
        echo "cycles: $passed passed, $failed failed, of $count"
        echo "startup stalls detected and restarted: $stalls"
        echo "log: $log"
        [ "$failed" -eq 0 ] || exit 1
        ;;

    *)
        echo "usage: $0 {start [project]|attach|quit|cycle N [project]}" >&2
        exit 2
        ;;
esac
