# Reload the DSH Browser Bridge extension through UI Automation.
#
# Requires the chrome://extensions tab to be the active tab: the card's reload
# button only exists in the accessibility tree of that page. Tries every Chrome
# top-level window because a pid can own several (browser frame, bubbles).

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class ReloadHelper{
 [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
 public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
}
"@

$process = (Get-Process chrome -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1)
if (-not $process) { $process = (Get-Process chrome -ErrorAction Stop | Select-Object -First 1) }
$chromePid = $process.Id
"chrome pid: $chromePid"

$candidates = New-Object System.Collections.ArrayList
$cb = [ReloadHelper+P]{ param($h,$l)
  $p = 0; [ReloadHelper]::GetWindowThreadProcessId($h,[ref]$p) | Out-Null
  if ($p -eq $chromePid) {
    $c = New-Object System.Text.StringBuilder 128; [ReloadHelper]::GetClassNameW($h,$c,128) | Out-Null
    if ($c.ToString() -eq 'Chrome_WidgetWin_1') {
      $t = New-Object System.Text.StringBuilder 256; [ReloadHelper]::GetWindowTextW($h,$t,256) | Out-Null
      if ($t.Length -gt 0) { [void]$candidates.Add([pscustomobject]@{ Hwnd = $h; Title = $t.ToString() }) }
    }
  }
  return $true }
[ReloadHelper]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null
if ($candidates.Count -eq 0) { throw 'no Chrome window found' }
"candidates: " + (($candidates | ForEach-Object { "'" + $_.Title + "' hwnd=" + $_.Hwnd }) -join '; ')

$nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Перезагрузить")
$done = $false
foreach ($cand in $candidates) {
  if ($done) { break }
  [void][ReloadHelper]::ShowWindow([IntPtr]$cand.Hwnd, 9)
  [void][ReloadHelper]::ShowWindow([IntPtr]$cand.Hwnd, 5)
  Start-Sleep -Milliseconds 800
  $win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$cand.Hwnd)
  if (-not $win) { continue }
  # Chrome builds the accessibility tree lazily, so retry while the page settles.
  for ($attempt = 0; $attempt -lt 8 -and -not $done; $attempt++) {
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
    foreach ($el in $all) {
      $r = $el.Current.BoundingRectangle
      if ($r.Y -gt 300) {
        $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $done = $true
        "reload invoked in '$($cand.Title)' at $([int]$r.X),$([int]$r.Y) (attempt $attempt)"
        break
      }
    }
    if (-not $done) { Start-Sleep -Milliseconds 500 }
  }
}
if (-not $done) { throw 'extension reload button not found; is chrome://extensions the active tab and its card visible?' }
