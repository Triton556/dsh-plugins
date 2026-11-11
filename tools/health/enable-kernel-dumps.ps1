# Enable kernel crash dumps so the next 0x154 leaves an analysable dump.
# Must run elevated (writes HKLM). Usage:
#   powershell -ExecutionPolicy Bypass -File enable-kernel-dumps.ps1
$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Run this script from an elevated (Administrator) PowerShell.'
  exit 2
}

$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
$before = (Get-ItemProperty $key).CrashDumpEnabled
# 2 = kernel dump: enough to name the faulting driver/module for 0x154.
Set-ItemProperty -Path $key -Name CrashDumpEnabled -Value 2 -Type DWord
Set-ItemProperty -Path $key -Name AlwaysKeepMemoryDump -Value 1 -Type DWord -ErrorAction SilentlyContinue
$after = (Get-ItemProperty $key).CrashDumpEnabled

$pagefiles = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue
$totalMb = ($pagefiles | Measure-Object -Property AllocatedBaseSize -Sum).Sum
$dumpDir = (Get-ItemProperty $key).MinidumpDir

[pscustomobject]@{
  CrashDumpEnabledBefore = $before
  CrashDumpEnabledAfter = $after
  DumpFile = (Get-ItemProperty $key).DumpFile
  MinidumpDir = $dumpDir
  PageFileTotalMB = $totalMb
  PageFileOk = ($totalMb -ge 8192)
  AutoReboot = (Get-ItemProperty $key).AutoReboot
} | Format-List

Write-Output 'Kernel dumps enabled. The next bugcheck should leave C:\Windows\MEMORY.DMP.'
Write-Output 'Collect the result afterwards with: collect-crash.ps1'