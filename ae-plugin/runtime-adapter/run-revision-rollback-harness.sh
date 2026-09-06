#!/usr/bin/env bash
# Builds and runs the adapter rollback-sequence gate without After Effects or the AE SDK.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADAPTER_DIR="$REPO_ROOT/ae-plugin/runtime-adapter"
BUILD_DIR="${REVISION_ROLLBACK_HARNESS_BUILD_DIR:-$ADAPTER_DIR/build/revision-rollback-harness}"
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
export MSYS2_ARG_CONV_EXCL='/nologo;/EHsc;/std:*;/MD;/O2;/W3;/I;/c;/Fo:*;/OUT:*'
mkdir -p "$BUILD_DIR"
trap 'rm -rf "$BUILD_DIR"' EXIT
cd "$BUILD_DIR"
"$CL_EXE" /nologo /EHsc /std:c++17 /MD /O2 /W3 /I "$ADAPTER_DIR/src" /c "$ADAPTER_DIR/src/revision_apply.cpp" /Fo:revision_apply.obj
"$CL_EXE" /nologo /EHsc /std:c++17 /MD /O2 /W3 /I "$ADAPTER_DIR/src" /c "$ADAPTER_DIR/revision_rollback_harness.cpp" /Fo:revision_rollback_harness.obj
"$LINK_EXE" /nologo /OUT:revision_rollback_harness.exe revision_apply.obj revision_rollback_harness.obj
./revision_rollback_harness.exe
