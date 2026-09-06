#!/usr/bin/env sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/v1"
FIXTURE="$ROOT/fixtures/lower-third.aep"
ADAPTER="$HERE/../../../ae-plugin/runtime-adapter"
to_windows_path() { printf '%s' "$1" | sed 's|^/\([a-zA-Z]\)/|\1:/|' | sed 's|/|\\|g'; }
session="bo0a-lower-third-$(date +%s)"
token="a91e8f763b8542009d14c6f18a58d0ec6d2f3b7749594e00bd1a526c87f3d110"
win_fixture=$(to_windows_path "$FIXTURE")
cleanup() { sh "$ADAPTER/supervise.sh" quit >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
GRAPIX_AE_RUNTIME_SESSION_ID="$session" GRAPIX_AE_RUNTIME_TOKEN="$token" sh "$ADAPTER/supervise.sh" start "$win_fixture"
GRAPIX_AE_RUNTIME_SESSION_ID="$session" GRAPIX_AE_RUNTIME_TOKEN="$token" node "$HERE/compare-lower-third.mjs" "$ROOT/lower-third.json"
