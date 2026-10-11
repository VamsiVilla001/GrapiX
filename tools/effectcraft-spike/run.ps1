param(
    [ValidateSet('dx12', 'vulkan')][string]$Backend = 'dx12',
    [string]$ScratchDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) 'grapix-effectcraft-spike-20261011-9a7d3e7'),
    [string]$DxcPath,
    [switch]$CoreTests
)

$ErrorActionPreference = 'Stop'
$PinnedCommit = '9a7d3e76991d5372448033b473dc12c2480a6a04'
$Toolchain = '1.95.0'
$Checkout = Join-Path $ScratchDirectory 'upstream'
New-Item -ItemType Directory -Path $ScratchDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $Checkout '.git'))) {
    & git clone --no-checkout --depth 1 https://github.com/storytold/effectcraft.git $Checkout
    if ($LASTEXITCODE -ne 0) { throw 'Upstream clone failed' }
    & git -C $Checkout fetch --depth 1 origin $PinnedCommit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned fetch failed' }
    & git -C $Checkout checkout --detach $PinnedCommit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned checkout failed' }
}
$ActualCommit = & git -C $Checkout rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $ActualCommit.Trim() -ne $PinnedCommit) {
    throw "Scratch checkout must be $PinnedCommit; found $ActualCommit. Use a fresh scratch directory."
}
& git -C $Checkout diff --exit-code HEAD --
if ($LASTEXITCODE -ne 0) { throw 'Tracked upstream files changed; probe requires an unpatched checkout' }
& rustup run $Toolchain rustc --version
if ($LASTEXITCODE -ne 0) { throw "Install the separate candidate toolchain: rustup toolchain install $Toolchain --profile minimal" }
$Examples = Join-Path $Checkout 'crates/gpu/examples'
New-Item -ItemType Directory -Path $Examples -Force | Out-Null
$ProbeSource = Join-Path $PSScriptRoot 'grapix_probe.rs'
$ProbeDestination = Join-Path $Examples 'grapix_probe.rs'
if (-not (Test-Path -LiteralPath $ProbeDestination) -or
    (Get-FileHash -LiteralPath $ProbeSource).Hash -ne (Get-FileHash -LiteralPath $ProbeDestination).Hash) {
    Copy-Item -LiteralPath $ProbeSource -Destination $ProbeDestination
}
$ProbeArguments = @($Backend)
if ($DxcPath) {
    if ($Backend -ne 'dx12' -or -not (Test-Path -LiteralPath $DxcPath -PathType Leaf)) {
        throw '-DxcPath requires backend dx12 and an existing dxcompiler.dll'
    }
    $ProbeArguments += (Resolve-Path -LiteralPath $DxcPath).Path
}
$PreviousBackend = $env:WGPU_BACKEND
$PreviousRequiredGpu = $env:EFFECTCRAFT_REQUIRE_GPU
$PreviousSearchPath = $env:PATH
$PreviousDx12Compiler = $env:WGPU_DX12_COMPILER
Push-Location -LiteralPath $Checkout
try {
    $env:WGPU_BACKEND = $Backend
    $env:EFFECTCRAFT_REQUIRE_GPU = '1'
    if ($DxcPath) {
        # Upstream test devices use Auto and resolve dxcompiler.dll via PATH.
        $env:PATH = (Split-Path -Parent $DxcPath) + [System.IO.Path]::PathSeparator + $PreviousSearchPath
        $env:WGPU_DX12_COMPILER = 'dxc'
        Write-Output "DXC file version: $((Get-Item -LiteralPath $DxcPath).VersionInfo.FileVersion)"
        Write-Output "DXC SHA256: $((Get-FileHash -LiteralPath $DxcPath -Algorithm SHA256).Hash)"
    }
    Write-Output "Pinned commit: $PinnedCommit; requested backend: $Backend"
    # Compile as an example of the upstream crate: the original upstream lockfile
    # applies. Nothing joins the GrapiX product workspace or its dependency graph.
    & cargo "+$Toolchain" run --release --locked -p effectcraft-gpu --example grapix_probe -- @ProbeArguments
    if ($LASTEXITCODE -ne 0) { throw 'Shared-device probe failed; GPU gate is not passed' }
    if ($CoreTests) {
        & cargo "+$Toolchain" test --release --locked -p effectcraft-render -p effectcraft-gpu -- --test-threads=1 --nocapture
        if ($LASTEXITCODE -ne 0) { throw 'Pinned core tests failed' }
        # Upstream general parity tests may log-and-return for no adapter. Review
        # the log for skips even when libtest reports success; the probe above
        # requires actual hardware rendering, but it does not certify each test.
    }
}
finally {
    Pop-Location
    $env:WGPU_BACKEND = $PreviousBackend
    $env:EFFECTCRAFT_REQUIRE_GPU = $PreviousRequiredGpu
    $env:PATH = $PreviousSearchPath
    $env:WGPU_DX12_COMPILER = $PreviousDx12Compiler
}
