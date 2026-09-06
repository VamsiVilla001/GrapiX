#!/usr/bin/env sh
# Install the built adapter into the After Effects Plug-ins folder.
#
# Writing into Program Files needs an elevated shell. An unelevated copy is tried first; when it is
# refused, the copy is handed to a UAC prompt as an `-EncodedCommand` child. Encoding is what makes
# that reliable rather than clever: the destination contains spaces, and the payload would otherwise
# have to survive three levels of quoting (sh, PowerShell, elevated PowerShell) unharmed.
#
# The installed file is hashed and compared afterwards, because "the prompt was dismissed" and "the
# copy succeeded" are not distinguishable from the launching shell's exit code alone. A stale .aex
# that still answers on the pipe is the worst outcome available here: it negotiates an older
# protocol major and the failure surfaces much later, as a supervisor that cannot connect.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILT="${BUILT:-$REPO_ROOT/ae-plugin/runtime-adapter/build/GrapiXRuntimeAdapter.aex}"
AE_ROOT="${GRAPIX_AE_ROOT:-C:/Program Files/Adobe/Adobe After Effects 2026}"
TARGET_DIR="$AE_ROOT/Support Files/Plug-ins/GrapiX"
TARGET="$TARGET_DIR/GrapiXRuntimeAdapter.aex"

if [ ! -f "$BUILT" ]; then
  echo "not built yet: $BUILT" >&2
  echo "run ./build.sh first" >&2
  exit 1
fi

# PowerShell cannot read the MSYS-style path this shell reports, so hand it a Windows one.
if command -v cygpath >/dev/null 2>&1; then
  BUILT_WIN="$(cygpath -w "$BUILT")"
  TARGET_WIN="$(cygpath -w "$TARGET")"
else
  BUILT_WIN="$BUILT"
  TARGET_WIN="$TARGET"
fi

expected="$(sha256sum "$BUILT" | cut -d' ' -f1)"
installed_hash() {
  [ -f "$TARGET" ] || return 0
  sha256sum "$TARGET" | cut -d' ' -f1
}

if [ "$(installed_hash)" = "$expected" ]; then
  echo "already installed: $TARGET"
  echo "  sha256 $expected"
  exit 0
fi

mkdir -p "$TARGET_DIR" 2>/dev/null || true

if [ -d "$TARGET_DIR" ] && cp "$BUILT" "$TARGET" 2>/dev/null; then
  echo "installed: $TARGET"
else
  echo "unelevated copy refused; requesting elevation"
  GRAPIX_INSTALL_SRC="$BUILT_WIN" \
  GRAPIX_INSTALL_DIR="$TARGET_DIR" \
  GRAPIX_INSTALL_DST="$TARGET_WIN" \
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '
    # Backtick-escaped quotes, not backslash: PowerShell has no \" escape, and a single quote
    # cannot appear here because this whole block is sh-single-quoted.
    $child = "New-Item -ItemType Directory -Force -Path `"$env:GRAPIX_INSTALL_DIR`" | Out-Null; Copy-Item -LiteralPath `"$env:GRAPIX_INSTALL_SRC`" -Destination `"$env:GRAPIX_INSTALL_DST`" -Force"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
    $elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList @("-NoProfile", "-EncodedCommand", $encoded)
    exit $elevated.ExitCode
  ' || true
fi

actual="$(installed_hash)"
if [ "$actual" != "$expected" ]; then
  echo "install did not take effect." >&2
  echo "  expected sha256 $expected" >&2
  echo "  installed sha256 ${actual:-<absent>}" >&2
  echo "run this from an administrator prompt:" >&2
  echo "  copy \"$BUILT_WIN\" \"$TARGET_WIN\"" >&2
  exit 1
fi

echo "installed: $TARGET"
echo "  sha256 $actual"
echo "restart After Effects, then check the load marker:"
echo "  \$LOCALAPPDATA/GrapiX/ae-adapter/result.json"
