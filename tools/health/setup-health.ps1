# One-shot setup for post-crash diagnostics. MUST run elevated (right-click ->
# "Run with PowerShell" as administrator, or from an admin terminal):
#   powershell -ExecutionPolicy Bypass -File setup-health.ps1
# 1. enables kernel crash dumps so the next 0x154 leaves C:\Windows\MEMORY.DMP;
# 2. registers a logon task that records the previous shutdown reason.
$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Need administrator rights. Reopen PowerShell as administrator and run:' -ForegroundColor Yellow
  Write-Host ("  powershell -ExecutionPolicy Bypass -File `"{0}`"" -f $PSCommandPath)
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 2
}

# 1. kernel dumps
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
$before = (Get-ItemProperty $key).CrashDumpEnabled
Set-ItemProperty -Path $key -Name CrashDumpEnabled -Value 2 -Type DWord
Set-ItemProperty -Path $key -Name AlwaysKeepMemoryDump -Value 1 -Type DWord -ErrorAction SilentlyContinue
$after = (Get-ItemProperty $key).CrashDumpEnabled

# 2. logon task
$collector = Join-Path (Split-Path -Parent $PSScriptRoot) 'health\collect-crash.ps1'
$collector = (Resolve-Path $collector).Path
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $collector)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'DSH crash report' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Collects the previous shutdown reason (bugcheck, dumps, WHEA) into docs/health after each logon.' -Force | Out-Null

$pagefiles = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue
$totalMb = ($pagefiles | Measure-Object -Property AllocatedBaseSize -Sum).Sum
$task = Get-ScheduledTask -TaskName 'DSH crash report'

Write-Host ''
Write-Host 'Done:'
Write-Host ("  CrashDumpEnabled {0} -> {1} (2 = kernel dump)" -f $before, $after)
Write-Host ("  pagefile total  {0} MB (needs >= 8192)" -f $totalMb)
Write-Host ("  logon task      {0} ({1})" -f $task.TaskName, $task.State)
Write-Host ''
Write-Host 'After the next crash: run tools\health\collect-crash.ps1 and read docs\health\crash-*.md'
Read-Host 'Press Enter to close'