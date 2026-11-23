# DSH Browser Bridge - build.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# Generates the extension key/manifest once, then compiles the native host.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostSource = Join-Path $root 'host\NativeHost.cs'
$hostExe = Join-Path $root 'host\NativeHost.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path (Join-Path $root 'extension\manifest.json'))) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'node.exe not found; needed once to generate the extension key' }
  & $node (Join-Path $root 'genkey.cjs') $root | Out-Host
} else {
  Write-Host 'extension manifest present, keeping the existing key'
}

if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }
& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$hostExe" $hostSource
if (-not (Test-Path $hostExe)) { throw "build failed: $hostExe" }
Write-Host "built: $hostExe ($((Get-Item $hostExe).Length) bytes)"
Write-Host (Get-Content (Join-Path $root 'extension-id.txt') -Raw).Trim()
