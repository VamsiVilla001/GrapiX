#!/usr/bin/env bash
# Build the GrapiX runtime adapter (AE-A0 spike) into a loadable .aex.
#
# Why a script and not CMake: CMake needs a generator plus MSBuild or Ninja on PATH, and the
# PiPL step is a two-tool custom build anyway. This keeps the whole toolchain visible in one
# place and reproducible from bash, which is what the spike needs. Override any path below
# with an environment variable if your install differs.
#
# The Adobe SDK is read from vendor/adobe (gitignored, never redistributed). Nothing from it
# is copied into build output except the compiled PiPL blob this build generates itself.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADAPTER_DIR="$REPO_ROOT/ae-plugin/runtime-adapter"
SRC_DIR="$ADAPTER_DIR/src"
BUILD_DIR="${BUILD_DIR:-$ADAPTER_DIR/build}"

SDK_ROOT="${GRAPIX_AE_SDK_ROOT:-$REPO_ROOT/vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK/Examples}"
SDK_HEADERS="$SDK_ROOT/Headers"
SDK_SP_HEADERS="$SDK_ROOT/Headers/SP"
SDK_UTIL="$SDK_ROOT/Util"
PIPL_TOOL="$SDK_ROOT/Resources/PiPLtool.exe"
MSVC_ROOT="${GRAPIX_MSVC_ROOT:-C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC/14.44.35207}"
WINKIT_ROOT="${GRAPIX_WINKIT_ROOT:-C:/Program Files (x86)/Windows Kits/10}"
WINKIT_VERSION="${GRAPIX_WINKIT_VERSION:-10.0.26100.0}"

RC_EXE="$WINKIT_ROOT/bin/$WINKIT_VERSION/x64/rc.exe"
# `link` on PATH is GNU coreutils in this shell, which silently is not the MSVC linker.
LINK_EXE="$MSVC_ROOT/bin/Hostx64/x64/link.exe"

for required in "$SDK_HEADERS/AE_GeneralPlug.h" "$PIPL_TOOL" "$RC_EXE" "$LINK_EXE"; do
  if [[ ! -f "$required" ]]; then
    echo "missing prerequisite: $required" >&2
    exit 1
  fi
done

export INCLUDE="$MSVC_ROOT/include;$WINKIT_ROOT/Include/$WINKIT_VERSION/ucrt;$WINKIT_ROOT/Include/$WINKIT_VERSION/um;$WINKIT_ROOT/Include/$WINKIT_VERSION/shared"
export LIB="$MSVC_ROOT/lib/x64;$WINKIT_ROOT/Lib/$WINKIT_VERSION/ucrt/x64;$WINKIT_ROOT/Lib/$WINKIT_VERSION/um/x64"

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo "== 1/4 preprocess the PiPL =="
# PiPLtool wants the .r run through the C preprocessor first. /EP writes to stdout without
# #line directives, which is what the tool expects.
cl //nologo //EP //I "$SDK_HEADERS" //I "$SDK_UTIL" "$SRC_DIR/adapter_PiPL.r" > adapter_PiPL.rr

echo "== 2/4 compile the PiPL blob =="
"$PIPL_TOOL" adapter_PiPL.rr adapter_PiPL.rrc

echo "== 3/4 compile resources and code =="
"$RC_EXE" //nologo //I "$BUILD_DIR" //I "$SRC_DIR" //fo adapter_res.res "$SRC_DIR/adapter.rc"

# AEConfig.h defines AE_OS_WIN itself; defining it on the command line only earns a warning.
cl //nologo //c //EHsc //std:c++17 //MD //O2 //W3 \
  //D "WIN32" //D "_WINDOWS" //D "MSWindows" \
  //I "$SDK_HEADERS" //I "$SDK_SP_HEADERS" //I "$SDK_UTIL" \
  //Fo:adapter.obj \
  "$SRC_DIR/adapter.cpp"

cl //nologo //c //EHsc //std:c++17 //MD //O2 //W3 \
  //D "WIN32" //D "_WINDOWS" //D "MSWindows" \
  //I "$SDK_HEADERS" //I "$SDK_SP_HEADERS" //I "$SDK_UTIL" \
  //Fo:runtime_pipe.obj \
  "$SRC_DIR/runtime_pipe.cpp"

cl //nologo //c //EHsc //std:c++17 //MD //O2 //W3 \
  //D "WIN32" //D "_WINDOWS" //D "MSWindows" \
  //I "$SDK_HEADERS" //I "$SDK_SP_HEADERS" //I "$SDK_UTIL" \
  //Fo:frame_ring.obj \
  "$SRC_DIR/frame_ring.cpp"

# `revision_apply.cpp` is AE-CD2's write/rollback sequencing, factored out of After Effects so an
# independent harness can measure it. It has no SDK dependency, but it is linked into the .aex like any
# other translation unit — omitting it here cost an LNK2019 on `apply_revision_with_rollback` and is
# exactly the kind of break a build script that lists its inputs by hand invites.
cl //nologo //c //EHsc //std:c++17 //MD //O2 //W3 \
  //D "WIN32" //D "_WINDOWS" //D "MSWindows" \
  //I "$SDK_HEADERS" //I "$SDK_SP_HEADERS" //I "$SDK_UTIL" \
  //Fo:revision_apply.obj \
  "$SRC_DIR/revision_apply.cpp"

echo "== 4/4 link the .aex =="
"$LINK_EXE" //nologo //DLL //MACHINE:X64 \
  //OUT:GrapiXRuntimeAdapter.aex \
  adapter.obj runtime_pipe.obj frame_ring.obj revision_apply.obj adapter_res.res \
  user32.lib kernel32.lib advapi32.lib

echo
echo "built: $BUILD_DIR/GrapiXRuntimeAdapter.aex"
echo "install with: ./install.sh   (copies into the After Effects Plug-ins folder)"
