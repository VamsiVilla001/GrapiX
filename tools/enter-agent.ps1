$ErrorActionPreference = 'Stop'
$CommonDirectory = & git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the GrapiX shared Git directory' }
$PrimaryRepository = Split-Path -Parent $CommonDirectory.Trim()
$CanonicalWorktree = Join-Path $PrimaryRepository 'agent/worktree'
if (-not (Test-Path -LiteralPath (Join-Path $CanonicalWorktree '.git') -PathType Leaf)) {
    throw "The existing shared worktree is missing: $CanonicalWorktree. Do not create an alternative."
}
Push-Location -LiteralPath $CanonicalWorktree
try {
    & node (Join-Path $CanonicalWorktree 'tools/check-agent-worktree.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Shared worktree verification failed' }
}
finally { Pop-Location }
Set-Location -LiteralPath $CanonicalWorktree
Write-Output "All agent work belongs here: $CanonicalWorktree"
