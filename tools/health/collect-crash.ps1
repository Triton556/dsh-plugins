# Collect why this machine unexpectedly shut down: bugcheck code, dumps, WHEA,
# power transitions. Runs without elevation (System log + file listing only).
# Writes docs/health/crash-<timestamp>.md and appends a JSON line to
# docs/health/crash-history.jsonl.
# Usage: powershell -ExecutionPolicy Bypass -File collect-crash.ps1
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # workspace root
$outDir = Join-Path $root 'docs\health'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$os = Get-CimInstance Win32_OperatingSystem
$lastBoot = $os.LastBootUpTime

function Get-KernelPower41 {
  try {
    Get-WinEvent -FilterHashtable @{LogName = 'System'; Id = 41} -MaxEvents 5 -ErrorAction Stop | ForEach-Object {
      $xml = [xml]$_.ToXml()
      $data = @{}
      foreach ($d in $xml.Event.EventData.Data) { $data[$d.Name] = $d.'#text' }
      [pscustomobject]@{
        Time = $_.TimeCreated
        BugcheckCode = [int]$data['BugcheckCode']
        BugcheckHex = ('0x{0:X}' -f [int]$data['BugcheckCode'])
        FromEFI = $data['BugcheckInfoFromEFI']
        LongPowerButton = $data['LongPowerButtonPressDetected']
      }
    }
  } catch {}
}

function Get-UnexpectedShutdowns {
  try {
    Get-WinEvent -FilterHashtable @{LogName = 'System'; Id = 6008} -MaxEvents 10 -ErrorAction Stop |
      Select-Object TimeCreated, @{n = 'Message'; e = { ($_.Message -replace '\s+', ' ').Trim() }}
  } catch {}
}

function Get-Whea {
  try {
    Get-WinEvent -FilterHashtable @{LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'} -MaxEvents 10 -ErrorAction Stop |
      Select-Object TimeCreated, Id, @{n = 'Message'; e = { ($_.Message -replace '\s+', ' ').Substring(0, [Math]::Min(160, ($_.Message -replace '\s+', ' ').Length)) }}
  } catch {}
}

$bugchecks = @(Get-KernelPower41)
$shutdowns = @(Get-UnexpectedShutdowns)
$whea = @(Get-Whea)
$dumps = @(Get-ChildItem 'C:\Windows\Minidump' -File -ErrorAction SilentlyContinue)
$memoryDump = Test-Path 'C:\Windows\MEMORY.DMP'
$cc = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl' -ErrorAction SilentlyContinue

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$md = Join-Path $outDir ("crash-{0}.md" -f $stamp)

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Crash report $stamp")
$lines.Add("")
$lines.Add("Last boot: $lastBoot")
$lines.Add("Uptime at collection: $([math]::Round(((Get-Date) - $lastBoot).TotalMinutes,1)) min")
$lines.Add("CrashDumpEnabled: $($cc.CrashDumpEnabled) (2 = kernel, 3 = small, 0 = none)")
$lines.Add("MEMORY.DMP present: $memoryDump | minidumps: $($dumps.Count)")
$lines.Add("")
$lines.Add("## Kernel-Power 41 (bugcheck) events")
foreach ($b in $bugchecks) {
  $lines.Add(("- {0}: {1} ({2}), fromEFI={3}, longPowerButton={4}" -f $b.Time, $b.BugcheckHex, $b.BugcheckCode, $b.FromEFI, $b.LongPowerButton))
}
if (-not $bugchecks.Count) { $lines.Add('- none') }
$lines.Add("")
$lines.Add("## Unexpected shutdowns (6008)")
foreach ($s in $shutdowns) { $lines.Add(("- {0}: {1}" -f $s.TimeCreated, $s.Message)) }
if (-not $shutdowns.Count) { $lines.Add('- none') }
$lines.Add("")
$lines.Add("## WHEA hardware errors")
foreach ($w in $whea) { $lines.Add(("- {0} id={1}: {2}" -f $w.TimeCreated, $w.Id, $w.Message)) }
if (-not $whea.Count) { $lines.Add('- none') }
$lines.Add("")
$lines.Add("## Dumps")
if ($memoryDump) { $lines.Add(("- C:\Windows\MEMORY.DMP ({0} MB)" -f [math]::Round((Get-Item 'C:\Windows\MEMORY.DMP').Length / 1MB, 1))) }
foreach ($d in $dumps) { $lines.Add(("- {0} ({1} KB) {2}" -f $d.Name, [math]::Round($d.Length / 1KB, 1), $d.LastWriteTime)) }
if (-not $memoryDump -and -not $dumps.Count) { $lines.Add('- no dump files') }
$lines.Add("")
$lines.Add("## Latest bugcheck summary")
$latest = $bugchecks | Select-Object -First 1
if ($latest) { $lines.Add(("**{0}** at {1}" -f $latest.BugcheckHex, $latest.Time)) } else { $lines.Add('no bugcheck recorded') }

Set-Content -LiteralPath $md -Value $lines -Encoding UTF8

$history = Join-Path $outDir 'crash-history.jsonl'
$record = [pscustomobject]@{
  at = (Get-Date).ToString('o')
  lastBoot = $lastBoot.ToString('o')
  crashDumpEnabled = $cc.CrashDumpEnabled
  latestBugcheck = if ($latest) { $latest.BugcheckHex } else { $null }
  latestBugcheckAt = if ($latest) { $latest.Time.ToString('o') } else { $null }
  dumps = $dumps.Count
  memoryDump = $memoryDump
  report = $md
}
Add-Content -LiteralPath $history -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8

Write-Output "report: $md"
if ($latest) { Write-Output ("latest bugcheck: {0} at {1}" -f $latest.BugcheckHex, $latest.Time) }