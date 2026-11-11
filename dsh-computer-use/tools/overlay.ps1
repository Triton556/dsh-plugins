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

$spritePath = Join-Path $PSScriptRoot 'cursor-arrow.png'
$sprite = $null
try { if (Test-Path -LiteralPath $spritePath) { $sprite = [System.Drawing.Image]::FromFile($spritePath) } } catch {}

$fuchsia = [System.Drawing.Color]::Fuchsia
# short, light ramp: 8 strokes of 6 px, fading towards the middle of the screen
$bands = @(
  [System.Drawing.Color]::FromArgb(77, 107, 254),
  [System.Drawing.Color]::FromArgb(97, 125, 255),
  [System.Drawing.Color]::FromArgb(117, 143, 255),
  [System.Drawing.Color]::FromArgb(137, 161, 255),
  [System.Drawing.Color]::FromArgb(157, 179, 255),
  [System.Drawing.Color]::FromArgb(177, 197, 255),
  [System.Drawing.Color]::FromArgb(197, 213, 255),
  [System.Drawing.Color]::FromArgb(217, 229, 255)
)
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.BackColor = $fuchsia
$form.TransparencyKey = $fuchsia
$form.Bounds = $virtual
$form.DoubleBuffered = $true
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

  $thickness = 6
  $inset = 0
  foreach ($color in $bands) {
    $pen = New-Object System.Drawing.Pen($color, $thickness)
    $rect = New-Object System.Drawing.Rectangle($inset, $inset, ($w - $inset * 2 - 1), ($h - $inset * 2 - 1))
    $g.DrawRectangle($pen, $rect)
    $pen.Dispose()
    $inset += $thickness
  }

  if ($script:curX -ge 0) {
    $x = [single]($script:curX - $virtual.X)
    $y = [single]($script:curY - $virtual.Y)
    if ($sprite) {
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.DrawImage($sprite, ($x - 1), ($y - 1), 40, 40)
    }
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