param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 600,
  [int]$H = 400,
  [int]$Pad = 12
)

Add-Type -AssemblyName System.Drawing

if (-not ('DshShotWin32' -as [type])) {
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class DshShotWin32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int length);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  public static IntPtr FindWindow(int[] processIds) {
    var ids = new HashSet<int>(processIds);
    var foreground = GetForegroundWindow();
    IntPtr found = IntPtr.Zero;
    long area = 0;
    EnumWindows((window, unused) => {
      uint id;
      GetWindowThreadProcessId(window, out id);
      if (!ids.Contains((int)id) || !IsWindowVisible(window)) return true;
      var title = new StringBuilder(1024);
      GetWindowText(window, title, title.Capacity);
      string text = title.ToString();
      if (text.IndexOf("DeepSeek Harness", StringComparison.OrdinalIgnoreCase) < 0
          || text.StartsWith("Developer Tools", StringComparison.OrdinalIgnoreCase)) return true;
      if (window == foreground) { found = window; return false; }
      RECT rect;
      if (GetWindowRect(window, out rect)) {
        long size = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
        if (size > area) { found = window; area = size; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
'@
}

# Electron's Process.MainWindowHandle may name DevTools or a hidden window.
# Enumerate visible windows owned by DSH instead of trusting that cached choice.
$dshProcessIds = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$hwnd = [DshShotWin32]::FindWindow([int[]]$dshProcessIds)
if ($hwnd -eq [IntPtr]::Zero) { throw 'DSH window not found' }
if ([DshShotWin32]::IsIconic($hwnd)) { [DshShotWin32]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 250 }

$winRect = New-Object DshShotWin32+RECT
if (-not [DshShotWin32]::GetWindowRect($hwnd, [ref]$winRect)) { throw 'GetWindowRect failed' }
$width = $winRect.Right - $winRect.Left
$height = $winRect.Bottom - $winRect.Top
if ($width -lt 2 -or $height -lt 2) { throw 'DSH window has no size' }

$client = New-Object DshShotWin32+POINT
$client.X = 0
$client.Y = 0
[DshShotWin32]::ClientToScreen($hwnd, [ref]$client) | Out-Null

$full = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($full)
$hdc = $graphics.GetHdc()
$printed = [DshShotWin32]::PrintWindow($hwnd, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
if (-not $printed) {
  $graphics = [System.Drawing.Graphics]::FromImage($full)
  $graphics.CopyFromScreen($winRect.Left, $winRect.Top, 0, 0, $full.Size)
  $graphics.Dispose()
}

$offsetX = $client.X - $winRect.Left
$offsetY = $client.Y - $winRect.Top
$cropX = [Math]::Max(0, $offsetX + $X - $Pad)
$cropY = [Math]::Max(0, $offsetY + $Y - $Pad)
$cropW = [Math]::Min($full.Width - $cropX, $W + 2 * $Pad)
$cropH = [Math]::Min($full.Height - $cropY, $H + 2 * $Pad)
if ($cropW -lt 1 -or $cropH -lt 1) { $full.Dispose(); throw 'crop is empty' }

$crop = New-Object System.Drawing.Bitmap $cropW, $cropH
$cropGraphics = [System.Drawing.Graphics]::FromImage($crop)
$dest = New-Object System.Drawing.Rectangle 0, 0, $cropW, $cropH
$source = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropW, $cropH
$cropGraphics.DrawImage($full, $dest, $source, [System.Drawing.GraphicsUnit]::Pixel)
$cropGraphics.Dispose()
$full.Dispose()

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose()
Write-Output $Out
