param([string]$Path, [string[]]$Read = @())
# Open a zip and say what is in it: every member name, the text of the members asked for, and the
# members whose text holds a credential's prefix. Prints one JSON object.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Read = @($Read | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
try {
  $names = @(); $files = @{}; $credential = @()
  foreach ($entry in $zip.Entries) {
    $names += $entry.FullName
    $reader = New-Object System.IO.StreamReader($entry.Open())
    $text = $reader.ReadToEnd()
    $reader.Dispose()
    if ($text.Contains("gx1.")) { $credential += $entry.FullName }
    if ($Read -contains $entry.FullName) { $files[$entry.FullName] = $text }
  }
  [pscustomobject]@{ names = $names; files = $files; credential = $credential } | ConvertTo-Json -Depth 4 -Compress
} finally { $zip.Dispose() }
