# Window capture contract. Uses a fake Win32 surface; never reads the desktop.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run the capture contract on Windows' }
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class DshShotWin32 {
  public static bool Render;
  public static int Calls;
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static IntPtr FindWindow(int[] ignored) { return new IntPtr(281); }
  public static bool IsIconic(IntPtr hwnd) { return false; }
  public static bool GetWindowRect(IntPtr hwnd, out RECT r) { r = new RECT { Left = 20, Top = 30, Right = 120, Bottom = 130 }; return true; }
  public static bool ClientToScreen(IntPtr hwnd, ref POINT p) { p.X = 20; p.Y = 30; return true; }
  public static bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags) {
    Calls++;
    if (hwnd != new IntPtr(281) || flags != 2) throw new InvalidOperationException("wrong window or flags");
    if (!Render) return false;
    using (var g = Graphics.FromHdc(hdc)) g.Clear(Color.FromArgb(228, 34, 89));
    return true;
  }
}
'@
$shot = Join-Path $PSScriptRoot '..\shot.ps1'
$lab = Join-Path ([IO.Path]::GetTempPath()) ('dsh-panes-window-contract-' + [Guid]::NewGuid())
try {
  $fail = Join-Path $lab 'failed.png'
  $message = ''
  try { & $shot -Out $fail -X 10 -Y 15 -W 20 -H 18 -Pad 0 } catch { $message = $_.Exception.Message }
  if ($message -notlike 'WINDOW_CAPTURE_UNAVAILABLE*' -or (Test-Path $fail) -or [DshShotWin32]::Calls -ne 1) {
    throw 'Failed PrintWindow must produce an explicit error, no PNG, and exactly one native call'
  }
  Write-Output 'PASS: failing PrintWindow creates no PNG and returns one explicit failure.'
  [DshShotWin32]::Render = $true
  $ok = Join-Path $lab 'target.png'
  & $shot -Out $ok -X 10 -Y 15 -W 20 -H 18 -Pad 0 | Out-Null
  $image = New-Object System.Drawing.Bitmap $ok
  try {
    $c = $image.GetPixel(10, 10)
    if ($image.Width -ne 20 -or $image.Height -ne 18 -or $c.R -ne 228 -or $c.G -ne 34 -or $c.B -ne 89) {
      throw 'Successful capture must crop the supplied target pixels'
    }
  } finally { $image.Dispose() }
  Write-Output 'PASS: successful PrintWindow uses its own target pixels (20x18, center 228,34,89).'
} finally { if (Test-Path $lab) { Remove-Item -LiteralPath $lab -Recurse -Force } }
