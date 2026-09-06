#!/usr/bin/env sh
# BO0a alpha-vector stages. `export` and `compare` are deliberately separate commands: the
# independent reference path must finish before the adapter path under test starts checking out.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/v1"
SPEC="$ROOT/edge-corpus.json"
FIXTURE="$ROOT/fixtures/bo0a-alpha-edges.aep"
REFERENCES="$ROOT/references"
ADAPTER="$HERE/../../../ae-plugin/runtime-adapter"
EXPORTER="$ADAPTER/references/export-references.sh"
to_windows_path() {
  printf '%s' "$1" | sed 's|^/\([a-zA-Z]\)/|\1:/|' | sed 's|/|\\|g'
}

case "${1:-all}" in
  author)
    mkdir -p "$(dirname "$FIXTURE")"
    win_fixture=$(to_windows_path "$FIXTURE")
    sh "$ADAPTER/supervise.sh" start
    TIMEOUT_SECONDS=120 sh "$ADAPTER/send.sh" fixture "$win_fixture" edge-corpus
    sh "$ADAPTER/supervise.sh" quit
    ;;
  export)
    [ -f "$FIXTURE" ] || { echo "missing fixture: run '$0 author' first" >&2; exit 1; }
    mkdir -p "$REFERENCES"
    for composition in \
      BO0a-Opaque \
      BO0a-ZeroAlpha \
      BO0a-HardEdge \
      BO0a-AntialiasedEdge \
      BO0a-Gradient50 \
      BO0a-ColouredTranslucentShadow \
      BO0a-PremultipliedBlackEdge
    do
      PHASE=BO0a REFERENCE_ROOT="$REFERENCES" sh "$EXPORTER" "$FIXTURE" "$composition" 0 0
    done
    ;;
  compare)
    [ -f "$FIXTURE" ] || { echo "missing fixture: run '$0 author' first" >&2; exit 1; }
    win_fixture=$(to_windows_path "$FIXTURE")
    sh "$ADAPTER/supervise.sh" start "$win_fixture"
    status=0
    node "$HERE/compare-edge-corpus.mjs" "$SPEC" || status=$?
    sh "$ADAPTER/supervise.sh" quit || status=$?
    exit "$status"
    ;;
  all)
    # Certification starts from the pinned project. Re-authoring it would change the digest and
    # silently replace the thing under review; `author` is an explicit fixture-maintenance step.
    sh "$0" export
    sh "$0" compare
    ;;
  *)
    echo "usage: $0 [author|export|compare|all]" >&2
    exit 2
    ;;
esac
