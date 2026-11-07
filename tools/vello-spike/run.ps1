param(
    [ValidateSet('dx12', 'vulkan')][string]$Backend = 'dx12',
    [string]$DxcPath,
    [string]$OutDirectory
)

# Isolated Vello / Vello Hybrid spike (build-plan 3.17, 16.9). Builds its own
# Cargo project (not a product workspace member) into agent/tmp, renders the
# three broadcast workloads, and writes PNGs and the log beside the target.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Scratch = Join-Path $Root 'agent\tmp\vello-spike'
if (-not $OutDirectory) { $OutDirectory = Join-Path $Scratch "out-$Backend" }
New-Item -ItemType Directory -Path $OutDirectory -Force | Out-Null

& cargo build --release --locked --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --target-dir (Join-Path $Scratch 'target')
if ($LASTEXITCODE -ne 0) { throw 'spike build failed' }

$Arguments = @($Backend, $OutDirectory)
if ($DxcPath) {
    if ($Backend -ne 'dx12' -or -not (Test-Path -LiteralPath $DxcPath -PathType Leaf)) {
        throw '-DxcPath requires backend dx12 and an existing dxcompiler.dll'
    }
    $Arguments += (Resolve-Path -LiteralPath $DxcPath).Path
    Write-Output "DXC file version: $((Get-Item -LiteralPath $DxcPath).VersionInfo.FileVersion)"
}
$Log = Join-Path $Scratch "$Backend$(if ($DxcPath) { '-dxc' }).log"
& (Join-Path $Scratch 'target\release\gx-vello-spike.exe') @Arguments *>&1 | Tee-Object -FilePath $Log
if ($LASTEXITCODE -ne 0) { throw "spike failed; see $Log" }
Write-Output "Log: $Log; PNGs: $OutDirectory"
