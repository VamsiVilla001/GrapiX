#!/usr/bin/env sh
# AE-F0, step one: produce reference frames that the pixel checkout will be judged against —
# and produce them *independently of the code under test*.
#
# The plan is explicit about why (docs/ae-runtime-container-phase-plan.md, AE-F0): if references
# are captured through the same path being tested, a channel-swizzle or premultiplication defect
# blesses its own baseline and every later comparison agrees with the bug. So references come
# from After Effects' own Render Queue via `aerender.exe`, a separate binary, with pinned
# settings recorded next to the pixels.
#
#   ./export-references.sh <project.aep> <comp name> [startFrame] [endFrame]
#
# Output: references/<comp>/frames + manifest.json carrying the AE build, the templates, the
# project digest, and a SHA-256 per frame. The manifest is the artefact; the frames are evidence.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
AE_ROOT="${GRAPIX_AE_ROOT:-C:/Program Files/Adobe/Adobe After Effects 2026}"
REFERENCE_ROOT="${REFERENCE_ROOT:-$HERE}"
PHASE="${PHASE:-AE-F0}"
AERENDER="$AE_ROOT/Support Files/aerender.exe"

# Pinned deliberately. "Best Settings" and an alpha-carrying lossless output module are the two
# choices that decide what the reference actually contains; naming them in the manifest is the
# difference between a reference and a screenshot.
RS_TEMPLATE="${RS_TEMPLATE:-Best Settings}"
OM_TEMPLATE="${OM_TEMPLATE:-TIFF Sequence with Alpha}"

project="${1:?usage: export-references.sh <project.aep> <comp> [start] [end]}"
comp="${2:?usage: export-references.sh <project.aep> <comp> [start] [end]}"
start_frame="${3:-0}"
end_frame="${4:-0}"

if [ ! -f "$AERENDER" ]; then
    echo "aerender not found at $AERENDER" >&2
    exit 1
fi
if [ ! -f "$project" ]; then
    echo "project not found: $project" >&2
    exit 1
fi


# aerender resolves a relative path against its own install directory, not the caller's working
# directory, and reports it as an invalid path — so the project is made absolute here, in Windows
# form, before it is ever passed on.
to_windows_path() {
    case "$1" in
        ?:[/\\]*) printf '%s' "$1" ;;
        *) printf '%s' "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")" | sed 's|^/\([a-zA-Z]\)/|\1:/|' ;;
    esac
}

win_project=$(to_windows_path "$project")
safe_comp=$(printf '%s' "$comp" | tr -c 'A-Za-z0-9._-' '_')
out_dir="$REFERENCE_ROOT/$safe_comp"
frame_dir="$out_dir/frames"
log_file="$out_dir/aerender.log"
manifest="$out_dir/manifest.json"

rm -rf "$out_dir"
mkdir -p "$frame_dir"

project_digest=$(sha256sum "$project" | cut -d' ' -f1)
ae_version=$(powershell -NoProfile -Command "(Get-Item '$AE_ROOT/Support Files/AfterFX.exe').VersionInfo.ProductVersion" 2>/dev/null | tr -d '\r')

# aerender wants a Windows path with a [####] frame token for a sequence.
win_frames=$(printf '%s' "$frame_dir" | sed 's|^/\([a-z]\)/|\1:/|')
output_pattern="$win_frames/frame_[#####].tif"

echo "exporting $comp frames $start_frame..$end_frame"
echo "  render settings: $RS_TEMPLATE"
echo "  output module:   $OM_TEMPLATE"

set +e
"$AERENDER" -project "$win_project" -comp "$comp" \
    -s "$start_frame" -e "$end_frame" \
    -RStemplate "$RS_TEMPLATE" -OMtemplate "$OM_TEMPLATE" \
    -output "$output_pattern" >"$log_file" 2>&1
render_status=$?
set -e

frame_count=$(find "$frame_dir" -type f | wc -l | tr -d ' ')
echo "  aerender exit=$render_status frames=$frame_count (log: $log_file)"

# The manifest is written whether or not the render succeeded: a failed export with its reason
# recorded is evidence too, and AE-F0's gate cares about refusals as much as successes.
{
    printf '{\n'
    printf '  "phase": "%s",\n' "$PHASE"
    printf '  "role": "independent reference frames, exported through After Effects Render Queue",\n'
    printf '  "recordedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "aeProductVersion": "%s",\n' "$ae_version"
    printf '  "aerender": "%s",\n' "$AERENDER"
    printf '  "project": "%s",\n' "$(basename "$project")"
    printf '  "projectSha256": "%s",\n' "$project_digest"
    printf '  "composition": "%s",\n' "$comp"
    printf '  "startFrame": %s,\n' "$start_frame"
    printf '  "endFrame": %s,\n' "$end_frame"
    printf '  "renderSettingsTemplate": "%s",\n' "$RS_TEMPLATE"
    printf '  "outputModuleTemplate": "%s",\n' "$OM_TEMPLATE"
    printf '  "aerenderExitCode": %s,\n' "$render_status"
    printf '  "frameCount": %s,\n' "$frame_count"
    printf '  "independence": "Frames come from AE'\''s Render Queue through aerender.exe, not through the adapter'\''s checkout path. The GrapiX adapter is resident in the render process because it lives in the Plug-ins folder, but it issues no command during an export and contributes no pixels.",\n'
    printf '  "comparableUnit": "pixelSha256 — the decoded strip payload. Never fileSha256: After Effects embeds per-render XMP metadata, so three renders of one unchanged frame produced three different file digests over byte-identical pixels. A file digest would report a pixel defect that does not exist.",\n'
    printf '  "frames": [\n'
    first=1
    # Read line by line: this repository's path contains spaces, and `for f in $(find ...)`
    # word-splits them into nonexistent paths.
    find "$frame_dir" -type f -name '*.tif' | sort | while IFS= read -r frame; do
        [ "$first" -eq 1 ] || printf ',\n'
        printf '    '
        node "$HERE/pixel-digest.mjs" "$frame" | tr -d '\n'
        first=0
    done
    printf '\n'
    printf '  ]\n'
    printf '}\n'
} > "$manifest"

echo "manifest: $manifest"
[ "$render_status" -eq 0 ] && [ "$frame_count" -gt 0 ]
