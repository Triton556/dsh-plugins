# DeepSeek computer-use indicator.
#
# A click-through, per-pixel-alpha layer (UpdateLayeredWindow) that draws, like the
# Codex/Claude indicator but in DeepSeek colours:
#   * a soft glow fading inwards from the edges of the window under control;
#   * a persistent glowing cursor that glides to the action point when one lands.
#
# State comes from a small JSON file, so the agent side never manages windows:
#   { "updated": <unix ms>, "ttlMs": 60000,
#     "target": { "hwnd": 12345, "rect": [l, t, r, b] },
#     "screen": false,                       // true = whole-desktop control
#     "cursor": { "x": 900, "y": 520 } }
#
# Visible only while the controlled window is in the foreground (or the desktop is
# under control); switching away fades the whole layer out.
param(
  [string]$StatePath = (Join-Path $env:TEMP 'dsh-cua-overlay-state.json'),
  [string]$PidPath = (Join-Path $env:TEMP 'dsh-cua-overlay.pid'),
  [string]$LogPath = (Join-Path $env:TEMP 'dsh-cua-overlay.log')
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('CuaLayer.Native' -as [type])) {
  Add-Type -Namespace CuaLayer -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
[StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(System.IntPtr hwnd, System.IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, System.IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
}

function Note([string]$text) {
  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $text) } catch {}
}

try { [System.IO.File]::WriteAllText($PidPath, [string]$PID, (New-Object System.Text.UTF8Encoding($false))) } catch {}
Note "start pid=$PID state=[$StatePath]"

$deepseek = [System.Drawing.Color]::FromArgb(255, 77, 107, 254)
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$width = $virtual.Width
$height = $virtual.Height

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.Bounds = $virtual
$form.add_Shown({
  $style = [CuaLayer.Native]::GetWindowLong($form.Handle, -20)
  [void][CuaLayer.Native]::SetWindowLong($form.Handle, -20, ($style -bor 0x80000 -bor 0x20 -bor 0x80))
})

$script:snapshot = $null
$script:opacity = 0.0
$script:curX = -1.0
$script:curY = -1.0
$script:goalX = -1.0
$script:goalY = -1.0
$script:lastStamp = 0
$script:pulseStart = 0
$script:lastSeen = 0
$script:renderCount = 0

function Read-Snapshot {
  try {
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($StatePath, [System.Text.Encoding]::UTF8)
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    Note ("read failed: " + $_.Exception.Message)
    return $null
  }
}

function ForegroundMatches($snapshot) {
  if (-not $snapshot) { return $false }
  if ($snapshot.screen -eq $true) { return $true }
  try {
    $foreground = [CuaLayer.Native]::GetForegroundWindow()
    if ($foreground -eq [System.IntPtr]::Zero) { return $false }
    if ($snapshot.target -and $snapshot.target.hwnd) {
      $target = [int64]$snapshot.target.hwnd
      if ([int64]$foreground.ToInt64() -eq $target) { return $true }
      $root = [CuaLayer.Native]::GetAncestor($foreground, 2)
      if ($root -ne [System.IntPtr]::Zero -and [int64]$root.ToInt64() -eq $target) { return $true }
    }
    return $false
  } catch { return $false }
}

function Render-Frame {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $alphaScale = $script:opacity

  $snapshot = $script:snapshot
  if ($snapshot -and $snapshot.target -and $snapshot.target.rect) {
    $r = $snapshot.target.rect
    $rect = New-Object System.Drawing.Rectangle(($r[0] - $virtual.X), ($r[1] - $virtual.Y), ($r[2] - $r[0]), ($r[3] - $r[1]))
    if ($rect.Width -gt 60 -and $rect.Height -gt 60) {
      $depth = 110
      $peak = [int](120 * $alphaScale)
      # fade inward from each edge (no hard frame, like the Codex indicator)
      $top = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle($rect.X, $rect.Y, $rect.Width, $depth)),
        [System.Drawing.Color]::FromArgb($peak, 77, 107, 254),
        [System.Drawing.Color]::FromArgb(0, 77, 107, 254),
        [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
      $g.FillRectangle($top, $rect.X, $rect.Y, $rect.Width, $depth)
      $top.Dispose()

      $bottom = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle($rect.X, ($rect.Bottom - $depth), $rect.Width, $depth)),
        [System.Drawing.Color]::FromArgb(0, 77, 107, 254),
        [System.Drawing.Color]::FromArgb($peak, 77, 107, 254),
        [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
      $g.FillRectangle($bottom, $rect.X, ($rect.Bottom - $depth), $rect.Width, $depth)
      $bottom.Dispose()

      $left = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle($rect.X, $rect.Y, $depth, $rect.Height)),
        [System.Drawing.Color]::FromArgb($peak, 77, 107, 254),
        [System.Drawing.Color]::FromArgb(0, 77, 107, 254),
        [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
      $g.FillRectangle($left, $rect.X, $rect.Y, $depth, $rect.Height)
      $left.Dispose()

      $right = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle(($rect.Right - $depth), $rect.Y, $depth, $rect.Height)),
        [System.Drawing.Color]::FromArgb(0, 77, 107, 254),
        [System.Drawing.Color]::FromArgb($peak, 77, 107, 254),
        [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
      $g.FillRectangle($right, ($rect.Right - $depth), $rect.Y, $depth, $rect.Height)
      $right.Dispose()

      $line = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb([int](150 * $alphaScale), 122, 145, 255), 1.5)
      $g.DrawRectangle($line, $rect)
      $line.Dispose()
    }
  }

  if ($script:curX -ge 0 -and $alphaScale -gt 0.02) {
    $x = [single]$script:curX
    $y = [single]$script:curY
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:pulseStart
    $t = ($age % 1200) / 1200.0
    $radius = 10 + 30 * $t
    $ringAlpha = [int](180 * (1 - $t) * $alphaScale)
    if ($ringAlpha -gt 0) {
      $ring = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($ringAlpha, 122, 145, 255), 2)
      $g.DrawEllipse($ring, ($x - $radius), ($y - $radius), ($radius * 2), ($radius * 2))
      $ring.Dispose()
    }
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowRadius = 26
    $glowPath.AddEllipse(($x - $glowRadius + 4), ($y - $glowRadius + 4), ($glowRadius * 2), ($glowRadius * 2))
    $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
    $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb([int](150 * $alphaScale), 77, 107, 254)
    $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 77, 107, 254))
    $g.FillPath($glowBrush, $glowPath)
    $glowBrush.Dispose(); $glowPath.Dispose()

    $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](255 * $alphaScale), 77, 107, 254))
    $outline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb([int](240 * $alphaScale), 255, 255, 255), 1.6)
    $points = @(
      (New-Object System.Drawing.PointF(($x + 1), ($y + 1))),
      (New-Object System.Drawing.PointF(($x + 1), ($y + 22))),
      (New-Object System.Drawing.PointF(($x + 7), ($y + 16))),
      (New-Object System.Drawing.PointF(($x + 12), ($y + 27))),
      (New-Object System.Drawing.PointF(($x + 16), ($y + 25))),
      (New-Object System.Drawing.PointF(($x + 12), ($y + 15))),
      (New-Object System.Drawing.PointF(($x + 20), ($y + 15)))
    )
    $g.FillPolygon($fill, $points)
    $g.DrawPolygon($outline, $points)
    $fill.Dispose(); $outline.Dispose()
  }

  $hdc = $g.GetHdc()
  $dest = New-Object CuaLayer.Native+POINT
  $dest.X = $virtual.X
  $dest.Y = $virtual.Y
  $size = New-Object CuaLayer.Native+SIZE
  $size.cx = $width
  $size.cy = $height
  $source = New-Object CuaLayer.Native+POINT
  $source.X = 0
  $source.Y = 0
  $blend = New-Object CuaLayer.Native+BLENDFUNCTION
  $blend.BlendOp = 0
  $blend.SourceConstantAlpha = 255
  $blend.AlphaFormat = 1
  $ok = [CuaLayer.Native]::UpdateLayeredWindow($form.Handle, [System.IntPtr]::Zero, [ref]$dest, [ref]$size, $hdc, [ref]$source, 0, [ref]$blend, 2)
  $script:renderCount = [int]$script:renderCount + 1
  if (-not $ok -and $script:renderCount % 10 -eq 1) { Note ('UpdateLayeredWindow failed err=' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  elseif ($script:renderCount % 40 -eq 1) { Note ('rendered #' + $script:renderCount + ' op=' + [Math]::Round($script:opacity,2) + ' cur=' + [Math]::Round($script:curX) + ',' + [Math]::Round($script:curY)) }
  if ($script:renderCount -eq 1) { [void][CuaLayer.Native]::SetWindowPos($form.Handle, [System.IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) }
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $bitmap.Dispose()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
$timer.add_Tick({
  $snapshot = Read-Snapshot
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $ttl = 60000
  if ($snapshot -and $snapshot.ttlMs) { $ttl = [int]$snapshot.ttlMs }
  $fresh = $false
  if ($snapshot -and $snapshot.updated) { $fresh = ($now - [int64]$snapshot.updated) -le $ttl }

  $visible = $fresh -and (ForegroundMatches $snapshot)
  if ($visible) { $script:lastSeen = $now }
  $goal = if ($visible) { 1.0 } else { 0.0 }
  $script:opacity += ($goal - $script:opacity) * 0.2
  if ($script:opacity -lt 0.02) { $script:opacity = 0.0 }
  $script:snapshot = if ($fresh) { $snapshot } else { $null }

  if ($fresh -and $snapshot.cursor) {
    $script:goalX = [double]$snapshot.cursor.x
    $script:goalY = [double]$snapshot.cursor.y
    if ($script:curX -lt 0) { $script:curX = $script:goalX; $script:curY = $script:goalY }
    if ($snapshot.updated -ne $script:lastStamp) {
      $script:lastStamp = $snapshot.updated
      $script:pulseStart = $now
    }
  }

  if ($script:curX -ge 0) {
    $dx = $script:goalX - $script:curX
    $dy = $script:goalY - $script:curY
    if ([Math]::Abs($dx) -gt 0.6 -or [Math]::Abs($dy) -gt 0.6) {
      $script:curX += $dx * 0.24
      $script:curY += $dy * 0.24
    } else {
      $script:curX = $script:goalX
      $script:curY = $script:goalY
    }
  }

  try { Render-Frame } catch { Note ('render failed: ' + $_.Exception.Message) }

  if ($script:lastSeen -gt 0 -and ($now - $script:lastSeen) -gt 300000 -and $script:opacity -eq 0) { $form.Close() }
})
$timer.Start()

[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)
