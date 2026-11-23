# DSH Browser Bridge - one-time host installer.
#
# Run this yourself. It writes the native messaging manifest and the HKCU
# registration Chrome/Edge need in order to spawn the host. It does not touch
# the Chrome profile and does not restart the browser.
#
#   powershell -ExecutionPolicy Bypass -File install-host.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostExe = Join-Path $root 'host\NativeHost.exe'
$manifestPath = Join-Path $root 'host\com.dsh.browser.json'
$hostName = 'com.dsh.browser'
$idFile = Join-Path $root 'extension-id.txt'
$extensionDir = Join-Path $root 'extension'

if (-not (Test-Path $hostExe)) { throw "native host not built: $hostExe (run build.ps1)" }
if (-not (Test-Path $idFile)) { throw "extension id missing: $idFile (run build.ps1)" }

$extensionId = ((Get-Content $idFile -Raw) -split '=')[1].Trim()
if ($extensionId -notmatch '^[a-p]{32}$') { throw "invalid extension id: $extensionId" }

$manifest = [ordered]@{
  name            = $hostName
  description     = 'DSH Browser Bridge native host'
  path            = $hostExe
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}

$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

foreach ($key in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)) {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  Write-Host "registered: $key"
}

Write-Host ""
Write-Host "Extension ID : $extensionId"
Write-Host "Extension dir: $extensionDir"
Write-Host "Host exe     : $hostExe"
Write-Host "Host manifest: $manifestPath"
Write-Host ""
Write-Host "Now load the extension once in Chrome:"
Write-Host "  1. open chrome://extensions"
Write-Host "  2. enable Developer mode"
Write-Host "  3. Load unpacked -> $extensionDir"
