#!/usr/bin/env bash
# Builds and runs the adapter ring exit gate without After Effects or the AE SDK.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADAPTER_DIR="$REPO_ROOT/ae-plugin/runtime-adapter"
BUILD_DIR="${FRAME_RING_HARNESS_BUILD_DIR:-$ADAPTER_DIR/build/frame-ring-harness}"
MSVC_ROOT="${GRAPIX_MSVC_ROOT:-C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC/14.44.35207}"
WINKIT_ROOT="${GRAPIX_WINKIT_ROOT:-C:/Program Files (x86)/Windows Kits/10}"
WINKIT_VERSION="${GRAPIX_WINKIT_VERSION:-10.0.26100.0}"
CL_EXE="$MSVC_ROOT/bin/Hostx64/x64/cl.exe"
LINK_EXE="$MSVC_ROOT/bin/Hostx64/x64/link.exe"

for required in "$CL_EXE" "$LINK_EXE"; do
  [[ -f "$required" ]] || { echo "missing prerequisite: $required" >&2; exit 1; }
done

export INCLUDE="$MSVC_ROOT/include;$WINKIT_ROOT/Include/$WINKIT_VERSION/ucrt;$WINKIT_ROOT/Include/$WINKIT_VERSION/um;$WINKIT_ROOT/Include/$WINKIT_VERSION/shared"
export LIB="$MSVC_ROOT/lib/x64;$WINKIT_ROOT/Lib/$WINKIT_VERSION/ucrt/x64;$WINKIT_ROOT/Lib/$WINKIT_VERSION/um/x64"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
"$CL_EXE" //nologo //EHsc //std:c++17 //MD //O2 //W3 //I "$ADAPTER_DIR/src" //c "$ADAPTER_DIR/src/frame_ring.cpp" //Fo:frame_ring.obj
"$CL_EXE" //nologo //EHsc //std:c++17 //MD //O2 //W3 //I "$ADAPTER_DIR/src" //c "$ADAPTER_DIR/frame_ring_harness.cpp" //Fo:frame_ring_harness.obj
"$LINK_EXE" //nologo //OUT:frame_ring_harness.exe frame_ring.obj frame_ring_harness.obj kernel32.lib
./frame_ring_harness.exe --cycles 100000
