param([Parameter(Mandatory=$true)][string]$Cache)
$ErrorActionPreference = 'Stop'
$pins = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-sources.json') -Raw | ConvertFrom-Json
$cacheRoot = [IO.Path]::GetFullPath($Cache)
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
foreach ($name in @('host','python','nsis')) {
  $pin = $pins.$name
  $filename = switch ($name) { 'host' {'penguin-installer.exe'} 'python' {'python-embed.zip'} 'nsis' {'nsis.7z'} }
  $target = Join-Path $cacheRoot $filename
  if (-not (Test-Path -LiteralPath $target)) {
    $temporary = $target + '.download'
    Invoke-WebRequest -Uri $pin.url -OutFile $temporary -TimeoutSec 600
    if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw "Download checksum mismatch: $name" }
    Move-Item -LiteralPath $temporary -Destination $target
  }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw "Cached checksum mismatch: $name" }
  Write-Output "Verified $name $($pin.version)"
}
