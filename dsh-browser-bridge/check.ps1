# DSH Browser Bridge - diagnostics.
#
# Read-only checks. Run after installing the host and loading the extension:
#
#   powershell -ExecutionPolicy Bypass -File check.ps1
#
# Exit code 0 means every check passed.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostName = 'com.dsh.browser'
$manifestPath = Join-Path $root 'host\com.dsh.browser.json'
$idFile = Join-Path $root 'extension-id.txt'
$failures = 0

function Ok($message) { Write-Host "  OK   $message" }
function Fail($message) { Write-Host "  FAIL $message"; $script:failures++ }
function Warn($message) { Write-Host "  WARN $message" }

Write-Host "DSH Browser Bridge - checks"

# 1. files
foreach ($file in @(
  @{ path = (Join-Path $root 'host\NativeHost.exe'); label = 'host exe' },
  @{ path = $manifestPath; label = 'host manifest' },
  @{ path = (Join-Path $root 'extension\manifest.json'); label = 'extension manifest' },
  @{ path = $idFile; label = 'extension id file' }
)) {
  if (Test-Path $file.path) { Ok "$($file.label): $($file.path)" } else { Fail "$($file.label) missing: $($file.path)" }
}

# 2. extension id matches allowed_origins
if ((Test-Path $idFile) -and (Test-Path $manifestPath)) {
  $id = ((Get-Content $idFile -Raw) -split '=')[1].Trim()
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.allowed_origins -contains "chrome-extension://$id/") {
    Ok "allowed_origins matches $id"
  } else {
    Fail "allowed_origins does not contain chrome-extension://$id/ (re-run install-host.ps1)"
  }
}

# 3. registry registration
foreach ($key in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)) {
  $value = (Get-ItemProperty -Path $key -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
  if ($value) { Ok "registry: $key -> $value" } else { Warn "registry not set: $key (Chrome only is enough if you do not use Edge)" }
}

# 4. bridge alive
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'node.exe not found in PATH' } else {
  $reply = '{"cmd":"ping"}' | & $node (Join-Path $root 'bridge.mjs') 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $reply -match '"ok":\s*true') { Ok 'bridge answers ping' }
  else {
    Fail 'bridge does not answer on \\.\pipe\dsh-browser-bridge'
    Write-Host '       Chrome running, extension loaded and enabled? Open chrome://extensions and check the card.'
    Write-Host "       raw: $($reply.Trim().Split([Environment]::NewLine)[0])"
  }
}

Write-Host ""
if ($failures -eq 0) { Write-Host 'all checks passed'; exit 0 }
Write-Host "$failures check(s) failed"
exit 1
