# DeepSeek computer-use indicator (colour-key variant, no per-pixel alpha).
#
# Two click-through topmost windows, both invisible to input and focus:
#   * a frame window over the controlled window that paints nested border bands -
#     each band is a solid colour, and the window's constant opacity turns them into
#     a soft inward glow (the "fade from the edges" look of the Codex indicator);
#   * a small cursor window with the DeepSeek pointer that glides to the action point.
#
# State file (written by the plugin):
#   { "updated": <unix ms>, "ttlMs": 60000,
#     "target": { "hwnd": 12345, "rect": [l, t, r, b] },
#     "screen": false, "cursor": { "x": 900, "y": 520 } }
#
# The indicator is drawn while the controlled window is in the foreground (or the
# whole desktop is under control) and fades out otherwise.
param(
  [string]$StatePath = (Join-Path $env:TEMP 'dsh-cua-overlay-state.json'),
  [string]$PidPath = (Join-Path $env:TEMP 'dsh-cua-overlay.pid'),
  [string]$LogPath = (Join-Path $env:TEMP 'dsh-cua-overlay.log')
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('CuaFrame.Native' -as [type])) {
  Add-Type -Namespace CuaFrame -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
}

function Note([string]$text) {
  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $text) } catch {}
}

try { [System.IO.File]::WriteAllText($PidPath, [string]$PID, (New-Object System.Text.UTF8Encoding($false))) } catch {}
Note "start pid=$PID"

$deepseek = [System.Drawing.Color]::FromArgb(77, 107, 254)
$deepseekLight = [System.Drawing.Color]::FromArgb(122, 145, 255)
$fuchsia = [System.Drawing.Color]::Fuchsia

function New-Chrome {
  param([int]$Width, [int]$Height)
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = 'None'
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.BackColor = $fuchsia
  $form.TransparencyKey = $fuchsia
  $form.Size = New-Object System.Drawing.Size($Width, $Height)
  return $form
}

# --- frame: nested bands inside one semi-transparent window --------------------
$frameForm = New-Chrome -Width 400 -Height 300
$frameForm.Opacity = 0.62
$frameForm.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $w = $sender.ClientSize.Width
  $h = $sender.ClientSize.Height
  if ($w -lt 30 -or $h -lt 30) { return }
  # three concentric bands: bright hairline, mid glow, wide soft falloff
  $bands = @(
    @{ inset = 0; thickness = 2; color = $deepseekLight },
    @{ inset = 2; thickness = 5; color = $deepseek },
    @{ inset = 7; thickness = 9; color = [System.Drawing.Color]::FromArgb(150, 77, 107, 254) }
  )
  foreach ($band in $bands) {
    $pen = New-Object System.Drawing.Pen($band.color, $band.thickness)
    $rect = New-Object System.Drawing.Rectangle(
      ($band.inset + [int]($band.thickness / 2)), ($band.inset + [int]($band.thickness / 2)),
      ($w - $band.inset * 2 - $band.thickness), ($h - $band.inset * 2 - $band.thickness))
    $g.DrawRectangle($pen, $rect)
    $pen.Dispose()
  }
})

# --- cursor: small click-through window with the pointer ---------------------
$cursorSize = 40
$cursorForm = New-Chrome -Width $cursorSize -Height $cursorSize
$cursorForm.Opacity = 1.0
$cursorForm.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $fill = New-Object System.Drawing.SolidBrush($deepseek)
  $outline = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 1.8)
  $points = @(
    (New-Object System.Drawing.PointF(2, 2)),
    (New-Object System.Drawing.PointF(2, 26)),
    (New-Object System.Drawing.PointF(9, 19)),
    (New-Object System.Drawing.PointF(15, 32)),
    (New-Object System.Drawing.PointF(20, 30)),
    (New-Object System.Drawing.PointF(14, 17)),
    (New-Object System.Drawing.PointF(24, 17))
  )
  $g.FillPolygon($fill, $points)
  $g.DrawPolygon($outline, $points)
  $fill.Dispose(); $outline.Dispose()
})

foreach ($form in @($frameForm, $cursorForm)) {
  $form.Add_HandleCreated({
    param($sender, $e)
    $current = [CuaFrame.Native]::GetWindowLong($sender.Handle, -20)
    [void][CuaFrame.Native]::SetWindowLong($sender.Handle, -20, ($current -bor 0x20 -bor 0x80))
  })
}

$script:snapshot = $null
$script:opacity = 0.0
$script:curX = -1.0
$script:curY = -1.0
$script:goalX = -1.0
$script:goalY = -1.0
$script:lastStamp = 0
$script:lastSeen = 0
$script:frames = 0

$frameForm.Show()
$cursorForm.Show()

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
    $foreground = [CuaFrame.Native]::GetForegroundWindow()
    if ($foreground -eq [System.IntPtr]::Zero) { return $false }
    if ($snapshot.target -and $snapshot.target.hwnd) {
      $target = [int64]$snapshot.target.hwnd
      if ([int64]$foreground.ToInt64() -eq $target) { return $true }
      $root = [CuaFrame.Native]::GetAncestor($foreground, 2)
      if ($root -ne [System.IntPtr]::Zero -and [int64]$root.ToInt64() -eq $target) { return $true }
    }
    return $false
  } catch { return $false }
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
  $script:opacity += ($goal - $script:opacity) * 0.22
  if ($script:opacity -lt 0.02) { $script:opacity = 0.0 }
  $frameForm.Opacity = 0.62 * $script:opacity
  $cursorVisible = $script:opacity -gt 0.15

  if ($visible -and $snapshot.target -and $snapshot.target.rect) {
    $r = $snapshot.target.rect
    $rect = New-Object System.Drawing.Rectangle([int]$r[0], [int]$r[1], ([int]$r[2] - [int]$r[0]), ([int]$r[3] - [int]$r[1]))
    if ($rect.Width -gt 60 -and $rect.Height -gt 60) {
      if ($frameForm.Bounds -ne $rect) {
        $frameForm.Bounds = $rect
        $frameForm.Invalidate()
      }
      if (-not $frameForm.Visible) { $frameForm.Show() }
    }
  } else {
    $frameForm.Hide()
  }

  if ($visible -and $snapshot.cursor) {
    $script:goalX = [double]$snapshot.cursor.x
    $script:goalY = [double]$snapshot.cursor.y
    if ($script:curX -lt 0) { $script:curX = $script:goalX; $script:curY = $script:goalY }
    if ($snapshot.updated -ne $script:lastStamp) { $script:lastStamp = $snapshot.updated }
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
    $cursorForm.Location = New-Object System.Drawing.Point([int]$script:curX, [int]$script:curY)
    if ($cursorVisible -and -not $cursorForm.Visible) { $cursorForm.Show() }
    if (-not $cursorVisible -and $cursorForm.Visible) { $cursorForm.Hide() }
  } else {
    $cursorForm.Hide()
  }

  $script:frames += 1
  if ($script:frames % 75 -eq 0) {
    Note ('tick op=' + [Math]::Round($script:opacity, 2) + ' vis=' + $visible + ' cur=' + [Math]::Round($script:curX) + ',' + [Math]::Round($script:curY) + ' frameVisible=' + $frameForm.Visible)
  }

  if ($script:lastSeen -gt 0 -and ($now - $script:lastSeen) -gt 300000) {
    $frameForm.Close(); $cursorForm.Close()
    [System.Windows.Forms.Application]::ExitThread()
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()