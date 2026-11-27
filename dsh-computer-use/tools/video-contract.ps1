# Run only with an isolated process temp directory, no screen access.
param([string]$FixtureFrame)
$ErrorActionPreference = 'Stop'
if (-not $env:DSH_CUA_TEST_TEMP -or $env:TEMP -ne $env:DSH_CUA_TEST_TEMP -or
    [IO.Path]::GetTempPath().TrimEnd('/', '\') -ne $env:TEMP) {
  throw 'Set TEMP and TMPDIR to a dedicated DSH_CUA_TEST_TEMP.'
}
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'cua.ps1'), [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('New-CapturePath', 'Save-Video')) {
  $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $fn) { throw "Missing function $name" }
  . ([scriptblock]::Create($fn.Extent.Text))
}
function Get-Date { [datetime]'2026-11-26T22:20:00Z' }
function Shot([string]$target, [IntPtr]$handle) {
  if ($FixtureFrame) { Copy-Item -LiteralPath $FixtureFrame -Destination $target }
  else { [IO.File]::WriteAllText($target, 'stub frame') }
}
function Get-Command {
  if ($FixtureFrame) { Microsoft.PowerShell.Core\Get-Command @args }
  elseif ($script:encoder -ne 'missing') { [pscustomobject]@{ Source = 'Invoke-FakeEncoder' } }
}
function Invoke-FakeEncoder {
  $script:argsSeen = $args
  $global:LASTEXITCODE = if ($script:encoder -eq 'broken') { 7 } else { 0 }
  if ($script:encoder -eq 'works') { [IO.File]::WriteAllText($args[-1], 'fake clip') }
}

$handle = [IntPtr]123
$script:encoder = "works"
$gif = Save-Video '' $handle 'gif' 2 20
$gifAgain = Save-Video '' $handle 'gif' 2 20
$outputs = foreach ($receipt in @($gif, $gifAgain)) {
  if ($receipt -notmatch '^video: (.+\.gif) \(') { throw "Invalid GIF receipt: $receipt" }
  $Matches[1]
}
if ($outputs[0] -eq $outputs[1]) { throw 'Two same-second video outputs collided' }
if (@($outputs | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 2) { throw 'Missing GIF output' }
$target = Join-Path $env:TEMP 'A clip (test).MP4'
$mp4 = Save-Video $target $handle 'mp4' 2 20
if (-not $mp4.StartsWith("video: $target (") -or -not (Test-Path -LiteralPath ([IO.Path]::ChangeExtension($target, '.png')))) {
  throw "Explicit MP4 or poster missing: $mp4"
}
if ($FixtureFrame) {
  $outputs
  $target
  return
}
if (($argsSeen[-3] -ne '-f') -or ($argsSeen[-2] -ne 'mp4')) { throw 'MP4 muxer not explicit' }
foreach ($mode in @('missing', 'broken', 'zero-without-output')) {
  $script:encoder = $mode
  $failure = Join-Path $env:TEMP "$mode.gif"
  try {
    Save-Video $failure $handle 'gif' 1 20
    throw "Encoder mode $mode unexpectedly succeeded"
  } catch {
    if ($_.Exception.Message -notmatch '^VIDEO_FAILED: .*; frames kept in (.+)$') { throw }
    if (-not (Test-Path -LiteralPath (Join-Path $Matches[1] 'frame-000.png'))) { throw 'Failure lost the captured frame' }
  }
  if (Test-Path -LiteralPath $failure) { throw "Failure produced a destination: $failure" }
}
Write-Output 'PASS: requested containers, unique defaults, explicit paths/posters, and encoder failures with raw frames'
