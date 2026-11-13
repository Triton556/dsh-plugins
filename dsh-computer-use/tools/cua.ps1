# Minimal computer-use toolkit for Windows: see the screen, focus windows,
# click, drag, type and scroll. Pure PowerShell + Win32 via Add-Type.
#
#   pwsh -File cua.ps1 -Action list
#   pwsh -File cua.ps1 -Action shot  [-Path out.png] [-Window "Claude"] [-Client]
#   pwsh -File cua.ps1 -Action focus -Window "Claude"
#   pwsh -File cua.ps1 -Action click -X 800 -Y 400 [-Double] [-Right] [-Window "Claude"]
#   pwsh -File cua.ps1 -Action drag  -X 800 -Y 400 -X2 1100 -Y2 400 [-Steps 20] [-Window "Claude"]
#   pwsh -File cua.ps1 -Action type  -Text "hello"
#   pwsh -File cua.ps1 -Action key   -Text "{ENTER}"
#   pwsh -File cua.ps1 -Action scroll -X 800 -Y 400 -Delta -600
#   pwsh -File cua.ps1 -Action info  -Window "Claude"
#
# Coordinates are screen coordinates unless -Window is given, in which case
# -X/-Y are relative to that window's client area.

param(
  [Parameter(Mandatory = $true)][ValidateSet('list','windows','tabs','tab','uitree','find','hit','shot','focus','activate','click','drag','type','key','keycombo','scroll','clipboard','wait','window','launch','record','video','ocr','uiact','info','overlay')][string]$Action,
  [string]$Path,
  [string]$Window,
  [string]$Text,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$X2 = 0,
  [int]$Y2 = 0,
  [int]$Delta = -600,
  [int]$Steps = 18,
  [int]$Delay = 12,
  [switch]$Double,
  [switch]$Right,
  [switch]$Client,
  [ValidateSet('screen','print')][string]$Method = 'screen',
  [string]$LaunchArgs,
  [int]$Timeout = 8000,
  [int]$Frames = 10,
  [int]$Interval = 150,
  [ValidateSet('move','resize','min','max','normal','topmost','untopmost','park','unpark')][string]$Op = 'normal',
  [int]$Width = 0,
  [int]$Height = 0,
  [switch]$Unicode,
  [string]$Value,
  [string]$TextFile,
  [string]$LaunchArgsFile,
  [switch]$Park,
  [ValidateSet('mp4','gif')][string]$Format = 'mp4',
  [int]$ProcessId = 0,
  [string]$Script,
  [switch]$Overlay
)

# UTF-8 on the way out: PowerShell 5.1 defaults to the OEM code page, which
# turns any non-ASCII result (clipboard, UIA names, OCR) into question marks.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}
$ErrorActionPreference = 'Stop'
# Free text never travels on the command line: quotes and backticks survive any
# Windows/PowerShell argument parsing, so callers pass a UTF-8 file instead.
if ($TextFile -and (Test-Path -LiteralPath $TextFile)) {
  $Text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $TextFile -Force -ErrorAction SilentlyContinue
}
if ($LaunchArgsFile -and (Test-Path -LiteralPath $LaunchArgsFile)) {
  $LaunchArgs = [System.IO.File]::ReadAllText($LaunchArgsFile, [System.Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $LaunchArgsFile -Force -ErrorAction SilentlyContinue
}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('Cua.Native' -as [type])) {
  Add-Type -Namespace Cua -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, System.IntPtr pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(System.IntPtr hWnd, ref POINT p);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr hWnd, System.IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr param);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr param);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public const uint LBUTTONDOWN = 0x0002, LBUTTONUP = 0x0004, RBUTTONDOWN = 0x0008, RBUTTONUP = 0x0010, WHEEL = 0x0800;
'@
}

[void][Cua.Native]::SetProcessDPIAware()

function Get-WindowHandle([string]$name) {
  if (-not $name) { return [System.IntPtr]::Zero }
  # Every top-level window, so secondary windows of one process (e.g. a
  # DevTools window owned by the same Electron process) are addressable.
  $byTitle = Get-TopWindows | Where-Object { $_.title -like "*$name*" } |
    Sort-Object @{ Expression = { $_.title.Length } } | Select-Object -First 1
  if ($byTitle) { return [System.IntPtr]$byTitle.hwnd }
  $proc = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$name*" -or $_.MainWindowTitle -like "*$name*")
  } | Select-Object -First 1
  if ($proc) { return [System.IntPtr]$proc.MainWindowHandle }
  throw "window not found: $name"
}

function Focus-Window([System.IntPtr]$h) {
  if ($h -eq [System.IntPtr]::Zero) { return }
  if ([Cua.Native]::IsIconic($h)) { [void][Cua.Native]::ShowWindow($h, 9) }  # SW_RESTORE
  [void][Cua.Native]::ShowWindow($h, 5)
  for ($i = 0; $i -lt 3; $i++) { [void][Cua.Native]::SetForegroundWindow($h); Start-Sleep -Milliseconds 60 }
}

function Get-VisibleRect([System.IntPtr]$h) {
  # The visible frame: GetWindowRect includes the invisible DWM border, which
  # shifted window-relative coordinates by about 8 px.
  $r = New-Object Cua.Native+RECT
  try {
    $ok = [Cua.Native]::DwmGetWindowAttribute($h, [Cua.Native]::DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$r, 16)
    if ($ok -eq 0 -and $r.Right -gt $r.Left) { return $r }
  } catch {}
  [void][Cua.Native]::GetWindowRect($h, [ref]$r)
  return $r
}

function Convert-Point([System.IntPtr]$h, [int]$px, [int]$py) {
  if ($h -eq [System.IntPtr]::Zero) { return @{ X = $px; Y = $py } }
  $p = New-Object Cua.Native+POINT
  $p.X = $px; $p.Y = $py
  if ($Client) { [void][Cua.Native]::ClientToScreen($h, [ref]$p) }
  else {
    $r = Get-VisibleRect $h
    $p.X = $r.Left + $px; $p.Y = $r.Top + $py
  }
  return @{ X = $p.X; Y = $p.Y }
}

function Move-To([int]$px, [int]$py) { [void][Cua.Native]::SetCursorPos($px, $py); Start-Sleep -Milliseconds $Delay }

function Shot([string]$target, [System.IntPtr]$h) {
  if (-not $target) {
    $dir = Join-Path $env:TEMP 'dsh-cua'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $target = Join-Path $dir ("shot-{0:yyyyMMdd-HHmmss}.png" -f (Get-Date))
  }
  $dir = Split-Path -Parent $target; if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if ($h -ne [System.IntPtr]::Zero) {
    $r = New-Object Cua.Native+RECT
    [void][Cua.Native]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    if ($w -le 0 -or $hh -le 0) { throw 'window has no size' }
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    if ($Method -eq 'print') {
      # PW_RENDERFULLCONTENT works for Chromium/Electron even when covered.
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      [void][Cua.Native]::PrintWindow($h, $hdc, 2)
      $g.ReleaseHdc($hdc)
      $g.Dispose()
    } else {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
      $g.Dispose()
    }
  } else {
    $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $v.Width, $v.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($v.Left, $v.Top, 0, 0, $bmp.Size)
    $g.Dispose()
  }
  $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output $target
}

function Send-UnicodeText([string]$value) {
  # SendInput with KEYEVENTF_UNICODE: SendKeys mangles anything outside ASCII.
  if (-not ('Cua.Keys' -as [type])) {
    Add-Type -Namespace Cua -Name Keys -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
[DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
'@
  }
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Cua.Keys+INPUT')
  foreach ($ch in $value.ToCharArray()) {
    $down = New-Object Cua.Keys+INPUT
    $down.type = 1
    $down.u.ki.wScan = [uint16][int]$ch
    $down.u.ki.dwFlags = 0x0004
    $up = New-Object Cua.Keys+INPUT
    $up.type = 1
    $up.u.ki.wScan = [uint16][int]$ch
    $up.u.ki.dwFlags = 0x0006
    [void][Cua.Keys]::SendInput(1, @($down), $size)
    [void][Cua.Keys]::SendInput(1, @($up), $size)
    Start-Sleep -Milliseconds 3
  }
  return "typed $($value.Length) chars (unicode)"
}

function Wait-For([System.IntPtr]$h, [string]$text, [string]$windowName, [int]$timeout) {
  $deadline = (Get-Date).AddMilliseconds($timeout)
  while ((Get-Date) -lt $deadline) {
    if ($windowName) {
      try { $probe = Get-WindowHandle $windowName; if ($probe -ne [System.IntPtr]::Zero) { return "window-ready:$probe" } } catch {}
    }
    if ($h -ne [System.IntPtr]::Zero -and $text) {
      $hitNode = Find-UiNode $h $text | Select-Object -First 1
      if ($hitNode) { return "element-ready:$($hitNode.name)" }
    }
    Start-Sleep -Milliseconds 120
  }
  return 'timeout'
}

function Invoke-WindowOp([System.IntPtr]$h) {
  switch ($Op) {
    'max' { [void][Cua.Native]::ShowWindow($h, 3) }
    'min' { [void][Cua.Native]::ShowWindow($h, 6) }
    'normal' {
      # ShowWindow(SW_RESTORE) does NOT clear WS_EX_TOPMOST: a topmost experiment
      # would leave the window above everything forever. Drop it explicitly.
      [void][Cua.Native]::SetWindowPos($h, [System.IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002)
      [void][Cua.Native]::ShowWindow($h, 9)
    }
    'untopmost' { [void][Cua.Native]::SetWindowPos($h, [System.IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) }
    'topmost' { [void][Cua.Native]::SetWindowPos($h, [System.IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) }
    'move' { [void][Cua.Native]::SetWindowPos($h, [System.IntPtr]::Zero, $X, $Y, 0, 0, 0x0001) }
    'park' {
      # Move the window far off any monitor: it keeps rendering and stays
      # scriptable (PrintWindow/CDP), but never covers the user's work.
      $r = New-Object Cua.Native+RECT
      [void][Cua.Native]::GetWindowRect($h, [ref]$r)
      $script:parkedX = $r.Left; $script:parkedY = $r.Top
      [void][Cua.Native]::SetWindowPos($h, [System.IntPtr]::Zero, -6000, -6000, 0, 0, 0x0001 -bor 0x0010)
      return "parked at -6000,-6000 (was $($r.Left),$($r.Top))"
    }
    'unpark' {
      $x = if ($script:parkedX -ne $null) { $script:parkedX } else { 100 }
      $y = if ($script:parkedY -ne $null) { $script:parkedY } else { 100 }
      [void][Cua.Native]::SetWindowPos($h, [System.IntPtr]::Zero, $x, $y, 0, 0, 0x0001)
      return "restored to $x,$y"
    }
    'resize' {
      if ($Width -gt 0 -and $Height -gt 0) { [void][Cua.Native]::SetWindowPos($h, [System.IntPtr]::Zero, 0, 0, $Width, $Height, 0x0002) }
      else { throw '-resize needs -W and -H' }
    }
  }
  return "window op: $Op"
}

function Shot-Region([string]$target, [System.IntPtr]$h, [int]$rx, [int]$ry, [int]$rw, [int]$rh) {
  if ($rw -le 0 -or $rh -le 0) { throw 'region needs positive width and height' }
  $dir = Split-Path -Parent $target; if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  # Capture the whole window first (PrintWindow keeps working when covered),
  # then crop, so region shots inherit the same occlusion-proof behaviour.
  if ($h -ne [System.IntPtr]::Zero) {
    $r = New-Object Cua.Native+RECT
    [void][Cua.Native]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    $full = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($full)
    $hdc = $g.GetHdc()
    [void][Cua.Native]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
  } else {
    $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $full = New-Object System.Drawing.Bitmap $v.Width, $v.Height
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($v.Left, $v.Top, 0, 0, $full.Size)
    $g.Dispose()
  }
  Add-Content -LiteralPath $env:TEMP\cua-region-debug.txt -Value ("rect=$($full.Width)x$($full.Height) rx=$rx ry=$ry rw=$rw rh=$rh")
  $x = [Math]::Max(0, [Math]::Min($rx, $full.Width - 1))
  $y = [Math]::Max(0, [Math]::Min($ry, $full.Height - 1))
  $cw = [Math]::Min($rw, $full.Width - $x)
  $ch = [Math]::Min($rh, $full.Height - $y)
  $rect = New-Object System.Drawing.Rectangle $x, $y, $cw, $ch
  $crop = $full.Clone($rect, $full.PixelFormat)
  $crop.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  $full.Dispose()
  return $target
}
function Convert-Ocr([string]$imagePath) {
  # WinRT file APIs need a normalised absolute Windows path; callers may pass
  # forward slashes (Node's TEMP joins use them).
  $imagePath = (Resolve-Path -LiteralPath $imagePath).Path
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function Await($operation, $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'no OCR language pack available' }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  return $result.Text
}
function Get-TopWindows {
  $rows = New-Object System.Collections.ArrayList
  $cb = [Cua.Native+EnumProc]{
    param($hwnd, $param)
    if (-not [Cua.Native]::IsWindowVisible($hwnd)) { return $true }
    $len = [Cua.Native]::GetWindowTextLength($hwnd)
    $sb = New-Object System.Text.StringBuilder ([Math]::Max(8, $len + 1))
    [void][Cua.Native]::GetWindowText($hwnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ($title) {
      $cls = New-Object System.Text.StringBuilder 128
      [void][Cua.Native]::GetClassName($hwnd, $cls, $cls.Capacity)
      $procId = 0
      [void][Cua.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId)
      $proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
      $r = New-Object Cua.Native+RECT
      [void][Cua.Native]::GetWindowRect($hwnd, [ref]$r)
      [void]$rows.Add([pscustomobject]@{
        hwnd = [int64]$hwnd; pid = $procId; proc = $proc; cls = $cls.ToString()
        title = $title; left = $r.Left; top = $r.Top
        w = $r.Right - $r.Left; h = $r.Bottom - $r.Top
      })
    }
    return $true
  }
  [void][Cua.Native]::EnumWindows($cb, [System.IntPtr]::Zero)
  return $rows
}

function Get-TabItems([System.IntPtr]$hwnd) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if (-not $root) { return @() }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  return $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Select-TabItem($item, [System.IntPtr]$hwnd) {
  # SelectionItemPattern (or InvokePattern) selects in a BACKGROUND window. There
  # is deliberately no focus-and-click fallback: the tool promises "no mouse, no
  # focus", and a focus steal would take the user's foreground away.
  try {
    $pattern = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    return $true
  } catch {
    try {
      $invoke = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $invoke.Invoke()
      return $true
    } catch {
      return $false
    }
  }
}

function Invoke-UiPattern($node, [string]$value) {
  # UI Automation patterns act on a control WITHOUT focusing the window or
  # moving the cursor - the only reliable "background" path for native apps.
  $attempts = @()
  try { $node.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return 'invoke' } catch { $attempts += 'invoke' }
  try { $node.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return 'toggle' } catch { $attempts += 'toggle' }
  try { $node.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return 'select' } catch { $attempts += 'select' }
  try { $node.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); return 'expand' } catch { $attempts += 'expand' }
  if ($value) {
    try { $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value); return 'value' } catch { $attempts += 'value' }
  }
  return 'unsupported'
}
function Get-UiNodes([System.IntPtr]$hwnd, [int]$maxDepth = 6) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if (-not $root) { return @() }
  $out = New-Object System.Collections.ArrayList
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  function Walk($el, $depth) {
    if ($null -eq $el -or $depth -gt $maxDepth) { return }
    try {
      $c = $el.Current
      $r = $c.BoundingRectangle
      [void]$out.Add([pscustomobject]@{
        depth = $depth
        type = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
        name = ($c.Name -replace '\s+', ' ')
        auto = $c.AutomationId
        cls = $c.ClassName
        x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
        off = $c.IsOffscreen
      })
    } catch { }
    try { $child = $walker.GetFirstChild($el) } catch { return }
    while ($null -ne $child) {
      Walk $child ($depth + 1)
      try { $child = $walker.GetNextSibling($child) } catch { break }
    }
  }
  Walk $root 0
  return $out
}

function Find-UiNode([System.IntPtr]$hwnd, [string]$text) {
  return @(Get-UiNodes $hwnd 12) | Where-Object { $_.name -like "*$text*" -and -not $_.off -and $_.w -gt 0 }
}

function Invoke-UiNode($node, [System.IntPtr]$hwnd) {
  Focus-Window $hwnd
  Start-Sleep -Milliseconds 100
  $cx = [int]($node.x + $node.w / 2); $cy = [int]($node.y + $node.h / 2)
  Move-To $cx $cy
  [void][Cua.Native]::mouse_event([Cua.Native]::LBUTTONDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [void][Cua.Native]::mouse_event([Cua.Native]::LBUTTONUP, 0, 0, 0, [UIntPtr]::Zero)
  return "clicked '$($node.name)' at $cx,$cy"
}

# Resolve the window lazily: actions such as wait poll for a window that does not
# exist yet, so a missing title must not abort the script up front.
$h = [System.IntPtr]::Zero
if ($Window) {
  try { $h = Get-WindowHandle $Window } catch { $h = [System.IntPtr]::Zero }
} elseif ($ProcessId -gt 0) {
  # Target a process directly: window titles clash and change, pids do not.
  $match = Get-TopWindows | Where-Object { $_.pid -eq $ProcessId } | Select-Object -First 1
  if ($match) { $h = [System.IntPtr]$match.hwnd }
}
# An explicit target that did not resolve must FAIL, never degrade to desktop
# input: otherwise a typo in a window title turns a scoped click into a
# whole-screen click at the given coordinates (and bypasses the consent gate).
$explicitTarget = [bool]$Window -or ($ProcessId -gt 0)
function Assert-Target([System.IntPtr]$handle) {
  if ($explicitTarget -and $handle -eq [System.IntPtr]::Zero) {
    throw "window not found: '$Window' (pid $ProcessId); refusing to fall back to whole-screen input"
  }
}
# 'wait' keeps its lazy resolution (it polls for a window that may appear later).
if ($explicitTarget -and $h -eq [System.IntPtr]::Zero -and $Action -notin @('wait')) {
  Assert-Target $h
}
# Machine-readable geometry for the on-screen overlay (frame + click marker). The
# agent side turns this line into an overlay process and strips it from the reply.
if ($Overlay -and $h -ne [System.IntPtr]::Zero) {
  try {
    $overlayRect = New-Object Cua.Native+RECT
    [void][Cua.Native]::GetWindowRect($h, [ref]$overlayRect)
    $overlayClick = ''
    if ($Action -in @('click','drag','scroll')) {
      $sx = $overlayRect.Left + $X
      $sy = $overlayRect.Top + $Y
      $overlayClick = " click=$sx,$sy"
    }
    "[overlay] hwnd=$($h.ToInt64()) rect=$($overlayRect.Left),$($overlayRect.Top),$($overlayRect.Right),$($overlayRect.Bottom)$overlayClick"
  } catch {}
}

switch ($Action) {
  'list' {
    Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object @{n='pid';e={$_.Id}}, @{n='proc';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}}, @{n='hwnd';e={$_.MainWindowHandle}} |
      Sort-Object proc | Format-Table -AutoSize | Out-String -Width 200
  }
  'overlay' {
    # Start the indicator daemon from PowerShell: a detached Node spawn produces a
    # process that dies before it can create its window, while Start-Process works.
    if (-not $Script -or -not (Test-Path -LiteralPath $Script)) { throw '-Script is required' }
    $pidFile = Join-Path $env:TEMP 'dsh-cua-overlay.pid'
    $running = $false
    if (Test-Path -LiteralPath $pidFile) {
      $existing = 0
      [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$existing)
      if ($existing -gt 0) { $running = [bool](Get-Process -Id $existing -ErrorAction SilentlyContinue) }
    }
    if (-not $running) {
      Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$Script) -WindowStyle Hidden | Out-Null
      Start-Sleep -Milliseconds 250
    }
    "overlay: " + $(if ($running) { 'already running' } else { 'started' })
  }
  'info' {
    $exStyle = [Cua.Native]::GetWindowLong($h, -20)
    $isTopmost = (($exStyle -band 0x8) -ne 0)
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    $r = New-Object Cua.Native+RECT; [void][Cua.Native]::GetWindowRect($h, [ref]$r)
    $c = New-Object Cua.Native+RECT; [void][Cua.Native]::GetClientRect($h, [ref]$c)
    $fg = [Cua.Native]::GetForegroundWindow()
    [pscustomobject]@{
      hwnd = $h; foreground = $fg; isForeground = ($fg -eq $h); topmost = $isTopmost
      window = "$($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"
      client = "$($c.Right)x$($c.Bottom)"
      monitor = ([System.Windows.Forms.Screen]::FromHandle($h)).Bounds.ToString()
      dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -ErrorAction SilentlyContinue).AppliedDPI
    } | Format-List | Out-String -Width 200
  }
  'activate' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    if ([Cua.Native]::IsIconic($h)) { [void][Cua.Native]::ShowWindow($h, 9) }
    [void][Cua.Native]::SetWindowPos($h, [System.IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002)
    $fg = [Cua.Native]::GetForegroundWindow()
    $fgThread = [Cua.Native]::GetWindowThreadProcessId($fg, [System.IntPtr]::Zero)
    $me = [Cua.Native]::GetCurrentThreadId()
    [void][Cua.Native]::AttachThreadInput($me, $fgThread, $true)
    [void][Cua.Native]::SetForegroundWindow($h)
    [void][Cua.Native]::AttachThreadInput($me, $fgThread, $false)
    [void][Cua.Native]::SetWindowPos($h, [System.IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002)
    Start-Sleep -Milliseconds 200
    "foreground now: " + ([Cua.Native]::GetForegroundWindow() -eq $h)
  }  'focus' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    Focus-Window $h
    Start-Sleep -Milliseconds 150
    "focused: " + ([Cua.Native]::GetForegroundWindow() -eq $h)
  }
  'windows' {
    Get-TopWindows | Sort-Object proc, title | Format-Table -AutoSize hwnd, pid, proc, w, h, title | Out-String -Width 200
  }
  'tabs' {
    $targets = if ($h -ne [System.IntPtr]::Zero) { @([pscustomobject]@{ hwnd = [int64]$h; proc = $Window }) }
      else { Get-TopWindows | Where-Object { $_.proc -match 'chrome|msedge|claude|codex|DeepSeek' } }
    foreach ($t in $targets) {
      $items = @(Get-TabItems ([System.IntPtr]$t.hwnd))
      if ($items.Count -eq 0) { continue }
      "== $($t.proc) hwnd=$($t.hwnd) tabs=$($items.Count)"
      foreach ($item in $items) {
        $sel = $false
        try { $sel = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch {}
        "  [{0}] {1}" -f ($(if ($sel) { 'x' } else { ' ' })), $item.Current.Name
      }
    }
  }
  'tab' {
    if (-not $Text) { throw '-Text is required' }
    $targets = if ($h -ne [System.IntPtr]::Zero) { @([pscustomobject]@{ hwnd = [int64]$h; proc = $Window }) }
      else { Get-TopWindows | Where-Object { $_.proc -match 'chrome|msedge' } }
    $done = $false
    foreach ($t in $targets) {
      $items = @(Get-TabItems ([System.IntPtr]$t.hwnd))
      $match = $items | Where-Object { $_.Current.Name -like "*$Text*" } | Select-Object -First 1
      if (-not $match) { continue }
      $hw = [System.IntPtr]$t.hwnd
      # No Focus-Window here: SelectionItemPattern selects the tab in a background
      # window; focusing would steal the user's foreground.
      $selected = Select-TabItem $match $hw
      Start-Sleep -Milliseconds 200
      if ($selected) { "selected tab: $($match.Current.Name) in hwnd=$($t.hwnd)" }
      else { "tab not selectable through UI Automation (no focus fallback): $($match.Current.Name)" }
      $done = $true
      break
    }
    if (-not $done) { "no tab matching '$Text'" }
  }
  'uitree' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    $nodes = @(Get-UiNodes $h $(if ($Delta -gt 0) { $Delta } else { 6 }))
    if ($Text) { $nodes = @($nodes | Where-Object { $_.name -like "*$Text*" -or $_.type -like "*$Text*" }) }
    foreach ($n in $nodes) {
      if ($n.off -and -not $Text) { continue }
      $indent = '  ' * $n.depth
      '{0}{1} "{2}" [{3}{4}] {5},{6} {7}x{8}{9}' -f $indent, $n.type, $n.name, $n.cls,
        $(if ($n.auto) { '#' + $n.auto } else { '' }), $n.x, $n.y, $n.w, $n.h,
        $(if ($n.off) { ' offscreen' } else { '' })
    }
  }
  'find' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    if (-not $Text) { throw '-Text is required' }
    Find-UiNode $h $Text | Select-Object -First 12 | Format-Table -AutoSize depth, type, name, cls, x, y, w, h | Out-String -Width 200
  }
  'hit' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    if (-not $Text) { throw '-Text is required' }
    $node = Find-UiNode $h $Text | Select-Object -First 1
    if (-not $node) { "no element matching '$Text'" }
    else { Invoke-UiNode $node $h }
  }
  'uiact' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    if (-not $Text) { throw '-Text is required' }
    $node = Find-UiNode $h $Text | Select-Object -First 1
    if (-not $node) { "no element matching '$Text'" }
    else {
      $nodes = Get-UiNodes $h 12 | Where-Object { $_.name -like "*$Text*" -and -not $_.off }
      $raw = $null
      try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $node.name)
        $raw = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      } catch {}
      if ($raw) { "pattern: " + (Invoke-UiPattern $raw $value) } else { "no raw element for '$Text'" }
    }
  }
  'shot' {
    if ($Width -gt 0 -and $Height -gt 0) {
      $target = if ($Path) { $Path } else { Join-Path (Join-Path $env:TEMP 'dsh-cua') ("region-{0:yyyyMMdd-HHmmss}.png" -f (Get-Date)) }
      Shot-Region $target $h $X $Y $Width $Height
    } else {
      Shot $Path $h
    }
  }
  'clipboard' {
    if ($Text) { Set-Clipboard -Value $Text; "clipboard set ($($Text.Length) chars)" }
    else { $clip = Get-Clipboard -Raw; if ($null -eq $clip) { '' } else { $clip } }
  }
  'wait' {
    Wait-For $h $Text $Window $Timeout
  }
  'window' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    Invoke-WindowOp $h
  }
  'launch' {
    if (-not $Path) { throw '-Path is required' }
    # Silent launch: Chromium honours --window-position, so its window is born
    # off every monitor and never covers the user's work. Other apps are moved
    # off-screen as soon as their first window appears.
    $exeName = [System.IO.Path]::GetFileName($Path).ToLowerInvariant()
    $isChromium = $exeName -match '^(chrome|msedge|brave|vivaldi|chromium|yandex)\.exe$'
    if ($Park -and $isChromium -and ($LaunchArgs -notmatch 'window-position')) {
      $LaunchArgs = ((@($LaunchArgs, '--window-position=-6000,-6000') | Where-Object { $_ }) -join ' ').Trim()
    }
    $proc = if ($LaunchArgs) { Start-Process -FilePath $Path -ArgumentList $LaunchArgs -PassThru }
            else { Start-Process -FilePath $Path -PassThru }
    $deadline = (Get-Date).AddMilliseconds($Timeout)
    while ((Get-Date) -lt $deadline) {
      $win = Get-TopWindows | Where-Object { $_.pid -eq $proc.Id } | Select-Object -First 1
      if ($win) {
        if ($Park) {
          [void][Cua.Native]::SetWindowPos([System.IntPtr]$win.hwnd, [System.IntPtr]::Zero, -6000, -6000, 0, 0, 0x0001 -bor 0x0010)
          "launched pid=$($proc.Id) hwnd=$($win.hwnd) parked off-screen title=$($win.title)"
        } else {
          "launched pid=$($proc.Id) hwnd=$($win.hwnd) title=$($win.title)"
        }
        break
      }
      Start-Sleep -Milliseconds 200
    }
    if ((Get-Date) -ge $deadline) { "launched pid=$($proc.Id), no window within $Timeout ms" }
  }
  'record' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    $dir = if ($Path) { $Path } else { Join-Path $env:TEMP ('dsh-cua-record-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $count = 0
    for ($i = 0; $i -lt $Frames; $i++) {
      $frame = Join-Path $dir ("frame-{0:000}.png" -f $i)
      [void](Shot $frame $h)
      $count += 1
      if ($i -lt ($Frames - 1)) { Start-Sleep -Milliseconds $Interval }
    }
    "recorded $count frames in $dir"
  }
  'video' {
    if ($h -eq [System.IntPtr]::Zero) { throw '-Window or -ProcessId is required' }
    $out = if ($Path) { $Path } else { Join-Path $env:TEMP ("dsh-cua-video-{0:yyyyMMdd-HHmmss}.mp4" -f (Get-Date)) }
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-cua-frames-" + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # PrintWindow frames keep working for covered Chromium/Electron windows, which
    # is exactly what ffmpeg's gdigrab cannot capture (it records black).
    for ($i = 0; $i -lt $Frames; $i++) {
      $frame = Join-Path $dir ("frame-{0:000}.png" -f $i)
      [void](Shot $frame $h)
      if ($i -lt ($Frames - 1)) { Start-Sleep -Milliseconds $Interval }
    }
    $ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    if (-not $ffmpeg) { "ffmpeg not found; frames kept in $dir"; return }
    if ($Format -eq 'gif') {
      # Animated GIF: the chat can show it inline, an MP4 cannot.
      $fps = [Math]::Max(1, [int](1000 / [Math]::Max(1, $Interval)))
      $gifArgs = @('-y', '-loglevel', 'error', '-framerate', "$fps", '-i', (Join-Path $dir 'frame-%03d.png'),
                   '-vf', 'scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', $out)
      $gifProc = Start-Process -FilePath $ffmpeg -ArgumentList $gifArgs -PassThru -Wait -WindowStyle Hidden
      if ($gifProc.ExitCode -eq 0 -and (Test-Path $out)) {
        "video: $out ($([math]::Round((Get-Item $out).Length / 1KB, 1)) KB, $Frames frames @ $fps fps, gif)"
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
      } else {
        "ffmpeg gif failed (exit $($gifProc.ExitCode)); frames kept in $dir"
      }
      return
    }
    $fps = [Math]::Max(1, [int](1000 / [Math]::Max(1, $Interval)))
    $args = @('-y', '-loglevel', 'error', '-framerate', "$fps", '-i', (Join-Path $dir 'frame-%03d.png'),
              '-pix_fmt', 'yuv420p', '-vcodec', 'libx264', '-preset', 'veryfast', $out)
    $proc = Start-Process -FilePath $ffmpeg -ArgumentList $args -PassThru -Wait -WindowStyle Hidden
    if ($proc.ExitCode -eq 0 -and (Test-Path $out)) {
      # Keep the first frame as a poster so a chat can show a still of the clip.
      try {
        $poster = [System.IO.Path]::ChangeExtension($out, '.png')
        Copy-Item (Join-Path $dir 'frame-000.png') $poster -Force -ErrorAction Stop
      } catch {}
      "video: $out ($([math]::Round((Get-Item $out).Length / 1KB, 1)) KB, $Frames frames @ $fps fps)"
      Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      "ffmpeg failed (exit $($proc.ExitCode)); frames kept in $dir"
    }
  }  'ocr' {
    if (-not $Path) { throw '-Path is required' }
    Convert-Ocr $Path
  }
  'keycombo' {
    if (-not $Text) { throw '-Text is required' }
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    "sent combo $Text"
  }
  'click' {
    $pt = Convert-Point $h $X $Y
    if ($h -ne [System.IntPtr]::Zero) { Focus-Window $h; Start-Sleep -Milliseconds 80 }
    Move-To $pt.X $pt.Y
    $down = if ($Right) { [Cua.Native]::RBUTTONDOWN } else { [Cua.Native]::LBUTTONDOWN }
    $up = if ($Right) { [Cua.Native]::RBUTTONUP } else { [Cua.Native]::LBUTTONUP }
    [void][Cua.Native]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
    [void][Cua.Native]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($Double) { Start-Sleep -Milliseconds 60; [void][Cua.Native]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [void][Cua.Native]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero) }
    "clicked $($pt.X),$($pt.Y)"
  }
  'drag' {
    $a = Convert-Point $h $X $Y
    $b = Convert-Point $h $X2 $Y2
    if ($h -ne [System.IntPtr]::Zero) { Focus-Window $h; Start-Sleep -Milliseconds 80 }
    Move-To $a.X $a.Y
    [void][Cua.Native]::mouse_event([Cua.Native]::LBUTTONDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    for ($i = 1; $i -le $Steps; $i++) {
      $px = [int]($a.X + ($b.X - $a.X) * $i / $Steps)
      $py = [int]($a.Y + ($b.Y - $a.Y) * $i / $Steps)
      [void][Cua.Native]::SetCursorPos($px, $py)
      Start-Sleep -Milliseconds $Delay
    }
    Start-Sleep -Milliseconds 40
    [void][Cua.Native]::mouse_event([Cua.Native]::LBUTTONUP, 0, 0, 0, [UIntPtr]::Zero)
    "dragged $($a.X),$($a.Y) -> $($b.X),$($b.Y)"
  }
  'type' {
    if ($Text) {
      # With a window target, focus it first so the text lands in the right app;
      # without one the keys go to whatever is focused (whole-screen consent).
      if ($h -ne [System.IntPtr]::Zero) { Focus-Window $h; Start-Sleep -Milliseconds 80 }
      if ($Unicode) { Send-UnicodeText $Text }
      else { [System.Windows.Forms.SendKeys]::SendWait($Text); "typed $($Text.Length) chars" }
    }
  }
  'key' {
    if ($Text) {
      if ($h -ne [System.IntPtr]::Zero) { Focus-Window $h; Start-Sleep -Milliseconds 80 }
      [System.Windows.Forms.SendKeys]::SendWait($Text); "sent $Text"
    }
  }
  'scroll' {
    $pt = Convert-Point $h $X $Y
    if ($h -ne [System.IntPtr]::Zero) { Focus-Window $h }
    Move-To $pt.X $pt.Y
    [void][Cua.Native]::mouse_event([Cua.Native]::WHEEL, 0, 0, $Delta, [UIntPtr]::Zero)
    "scrolled $Delta at $($pt.X),$($pt.Y)"
  }
}
