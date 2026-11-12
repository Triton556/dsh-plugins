# DeepSeek computer-use indicator.
#
# A full-screen, click-through window: the glow is built from a handful of nested
# strokes and the window's constant opacity makes them translucent. Colour key plus
# opacity together would wash the whole screen, so the form keeps the key and only
# the strokes carry the tint - short (48 px), light and unobtrusive.
#
# State file written by the plugin:
#   { "updated": <unix ms>, "ttlMs": 90000, "screen": true|false,
#     "target": { "hwnd": 123, "rect": [l,t,r,b] }, "cursor": { "x": 900, "y": 520 } }
param(
  [string]$StatePath = (Join-Path $env:TEMP 'dsh-cua-overlay-state.json'),
  [string]$PidPath = (Join-Path $env:TEMP 'dsh-cua-overlay.pid'),
  [string]$LogPath = (Join-Path $env:TEMP 'dsh-cua-overlay.log')
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('CuaGlow.ClickThroughForm' -as [type])) {
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Windows.Forms;

namespace CuaGlow {
  // Every hit test answers HTTRANSPARENT, so the overlay never eats a click even
  // where the layered colour key alone would still be hit-testable.
  public class ClickThroughForm : Form {
    public ClickThroughForm() {
      DoubleBuffered = true;
      SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
    }
    protected override void WndProc(ref Message m) {
      if (m.Msg == 0x0084) { m.Result = (IntPtr)(-1); return; }
      base.WndProc(ref m);
    }
  }
}
'@
}

if (-not ('CuaGlow.Native' -as [type])) {
  Add-Type -Namespace CuaGlow -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags);
'@
}

function Note([string]$text) {
  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $text) } catch {}
}

try { [System.IO.File]::WriteAllText($PidPath, [string]$PID, (New-Object System.Text.UTF8Encoding($false))) } catch {}
Note "start pid=$PID"

$spritePath = Join-Path $PSScriptRoot 'cursor-neon.png'
$sprite = $null
try { if (Test-Path -LiteralPath $spritePath) { $sprite = [System.Drawing.Image]::FromFile($spritePath) } } catch {}

$fuchsia = [System.Drawing.Color]::Fuchsia
# short, light ramp: 8 strokes of 6 px, fading towards the middle of the screen
$bands = @()
for ($i = 0; $i -lt 24; $i++) {
  $t = $i / 23.0
  $r = [int](77 + (201 - 77) * $t)
  $g = [int](107 + (214 - 107) * $t)
  $b = [int](254 + (255 - 254) * $t)
  $bands += [System.Drawing.Color]::FromArgb($r, $g, $b)
}
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen

$form = New-Object CuaGlow.ClickThroughForm
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.BackColor = $fuchsia
$form.TransparencyKey = $fuchsia
$form.Bounds = $virtual
$form.Opacity = 0.22
$form.Add_HandleCreated({
  $style = [CuaGlow.Native]::GetWindowLong($form.Handle, -20)
  [void][CuaGlow.Native]::SetWindowLong($form.Handle, -20, ($style -bor 0x20 -bor 0x80 -bor 0x08000000))
})

$script:active = $false
$script:curX = -1.0
$script:curY = -1.0
$script:goalX = -1.0
$script:goalY = -1.0
$script:lastSeen = 0
$script:frames = 0
$script:lastPaint = @{ x = -1.0; y = -1.0; active = $false }

$form.Add_Paint({
  param($sender, $e)
  if (-not $script:active) { return }
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  $w = $sender.ClientSize.Width
  $h = $sender.ClientSize.Height

  $thickness = 2
  $inset = 0
  foreach ($color in $bands) {
    $pen = New-Object System.Drawing.Pen($color, $thickness)
    $rect = New-Object System.Drawing.Rectangle($inset, $inset, ($w - $inset * 2 - 1), ($h - $inset * 2 - 1))
    $g.DrawRectangle($pen, $rect)
    $pen.Dispose()
    $inset += $thickness
  }

})

function Read-Snapshot {
  try {
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($StatePath, [System.Text.Encoding]::UTF8)
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
  } catch { return $null }
}

function ForegroundMatches($snapshot) {
  if (-not $snapshot) { return $false }
  if ($snapshot.screen -eq $true) { return $true }
  try {
    $foreground = [CuaGlow.Native]::GetForegroundWindow()
    if ($foreground -eq [System.IntPtr]::Zero) { return $false }
    if ($snapshot.target -and $snapshot.target.hwnd) {
      $target = [int64]$snapshot.target.hwnd
      if ([int64]$foreground.ToInt64() -eq $target) { return $true }
      $root = [CuaGlow.Native]::GetAncestor($foreground, 2)
      if ($root -ne [System.IntPtr]::Zero -and [int64]$root.ToInt64() -eq $target) { return $true }
    }
    return $false
  } catch { return $false }
}

$form.Show()

# The cursor lives in its own window: the glow form is translucent as a whole, and
# that would wash the pointer out with it.
$cursorForm = New-Object CuaGlow.ClickThroughForm
$cursorForm.FormBorderStyle = 'None'
$cursorForm.ShowInTaskbar = $false
$cursorForm.TopMost = $true
$cursorForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$cursorForm.BackColor = $fuchsia
$cursorForm.TransparencyKey = $fuchsia
$cursorForm.Size = New-Object System.Drawing.Size(96, 96)
$cursorForm.Add_HandleCreated({
  $style = [CuaGlow.Native]::GetWindowLong($cursorForm.Handle, -20)
  [void][CuaGlow.Native]::SetWindowLong($cursorForm.Handle, -20, ($style -bor 0x20 -bor 0x80 -bor 0x08000000))
})
$cursorForm.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  # solid strokes only: alpha would blend with the colour key and glow magenta
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  $unit = 3.4
  $pad = 8
  $shape = @( @(1, 1), @(1, 21), @(6.5, 15.5), @(10.5, 25), @(14, 23), @(9.5, 14.5), @(17, 14.5) )
  $points = @()
  foreach ($p in $shape) {
    $points += New-Object System.Drawing.PointF(($p[0] * $unit + $pad), ($p[1] * $unit + $pad))
  }
  foreach ($halo in @(
    @{ width = 16; color = [System.Drawing.Color]::FromArgb(96, 120, 255) },
    @{ width = 11; color = [System.Drawing.Color]::FromArgb(120, 145, 255) },
    @{ width = 7; color = [System.Drawing.Color]::FromArgb(152, 174, 255) }
  )) {
    $pen = New-Object System.Drawing.Pen($halo.color, $halo.width)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPolygon($pen, $points)
    $pen.Dispose()
  }
  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(77, 107, 254))
  $g.FillPolygon($fill, $points)
  $fill.Dispose()
  $rim = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(226, 236, 255), 3)
  $rim.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPolygon($rim, $points)
  $rim.Dispose()
})
$cursorForm.Show()
foreach ($wnd in @($form.Handle, $cursorForm.Handle)) {
  $current = [CuaGlow.Native]::GetWindowLong($wnd, -20)
  [void][CuaGlow.Native]::SetWindowLong($wnd, -20, ($current -bor 0x80000 -bor 0x20 -bor 0x80 -bor 0x08000000))
  Note ('style hwnd=' + $wnd + ' ex=' + ('0x{0:X}' -f [CuaGlow.Native]::GetWindowLong($wnd, -20)))
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 45
$timer.add_Tick({
  $snapshot = Read-Snapshot
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $ttl = 90000
  if ($snapshot -and $snapshot.ttlMs) { $ttl = [int]$snapshot.ttlMs }
  $fresh = $false
  if ($snapshot -and $snapshot.updated) { $fresh = ($now - [int64]$snapshot.updated) -le $ttl }
  $visible = $fresh -and (ForegroundMatches $snapshot)
  if ($visible) { $script:lastSeen = $now }
  $script:active = $visible

  if ($visible -and $snapshot.cursor) {
    $script:goalX = [double]$snapshot.cursor.x
    $script:goalY = [double]$snapshot.cursor.y
    if ($script:curX -lt 0) { $script:curX = $script:goalX; $script:curY = $script:goalY }
  }
  if ($script:curX -ge 0) {
    $dx = $script:goalX - $script:curX
    $dy = $script:goalY - $script:curY
    if ([Math]::Abs($dx) -gt 0.6 -or [Math]::Abs($dy) -gt 0.6) {
      $script:curX += $dx * 0.25
      $script:curY += $dy * 0.25
    } else {
      $script:curX = $script:goalX
      $script:curY = $script:goalY
    }
  }

  if ($script:curX -ge 0) {
    $cursorForm.Location = New-Object System.Drawing.Point([int]($script:curX - 4), [int]($script:curY - 4))
    if ($visible -and -not $cursorForm.Visible) { $cursorForm.Show() }
    if (-not $visible -and $cursorForm.Visible) { $cursorForm.Hide() }
  } else {
    if ($cursorForm.Visible) { $cursorForm.Hide() }
  }

  $moved = [Math]::Abs($script:curX - $script:lastPaint.x) -gt 0.8 -or [Math]::Abs($script:curY - $script:lastPaint.y) -gt 0.8
  $changed = $visible -ne $script:lastPaint.active
  if ($moved -or $changed -or $script:frames -lt 2) {
    $script:lastPaint = @{ x = $script:curX; y = $script:curY; active = $visible }
    $form.Invalidate()
  }

  $script:frames += 1
  if ($script:frames % 90 -eq 0) {
    Note ('tick vis=' + $visible + ' cur=' + [Math]::Round($script:curX) + ',' + [Math]::Round($script:curY))
  }

  if ($script:lastSeen -gt 0 -and ($now - $script:lastSeen) -gt 300000) {
    $form.Close()
    [System.Windows.Forms.Application]::ExitThread()
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)