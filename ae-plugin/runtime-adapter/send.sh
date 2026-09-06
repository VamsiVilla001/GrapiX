#!/usr/bin/env sh
# Send one command to the resident adapter and print its result.
#
# Usage: ./send.sh <verb> [args...]
#
# The sequence number is a monotonic counter kept beside the channel, so the adapter never
# replays a stale command file. This is the AE-A0 test harness, not a product client: AE-A1
# replaces the file channel with an authenticated same-user pipe.

set -eu

STATE_DIR="${GRAPIX_AE_ADAPTER_DIR:-$LOCALAPPDATA/GrapiX/ae-adapter}"
COMMAND_FILE="$STATE_DIR/command.txt"
RESULT_FILE="$STATE_DIR/result.json"
SEQUENCE_FILE="$STATE_DIR/sequence.txt"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-20}"

if [ ! -d "$STATE_DIR" ]; then
  echo "adapter state directory not found: $STATE_DIR" >&2
  echo "is After Effects running with the adapter installed?" >&2
  exit 1
fi

sequence=1
if [ -f "$SEQUENCE_FILE" ]; then
  sequence=$(cat "$SEQUENCE_FILE")
  sequence=$((sequence + 1))
fi

# Quote every argument so a path with spaces survives; the adapter's tokeniser understands "..".
line="$sequence"
for argument in "$@"; do
  line="$line \"$argument\""
done

printf '%s\n' "$line" > "$COMMAND_FILE"
printf '%s' "$sequence" > "$SEQUENCE_FILE"

waited=0
while [ "$waited" -lt "$TIMEOUT_SECONDS" ]; do
  if [ -f "$RESULT_FILE" ] && grep -q "\"sequence\":$sequence," "$RESULT_FILE" 2>/dev/null; then
    cat "$RESULT_FILE"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done

echo "timed out after ${TIMEOUT_SECONDS}s waiting for sequence $sequence" >&2
echo "last result was:" >&2
cat "$RESULT_FILE" >&2 2>/dev/null || true
exit 1
