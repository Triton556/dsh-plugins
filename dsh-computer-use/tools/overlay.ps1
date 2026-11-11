# Click-through overlay that flashes the window being driven and the click point.
# Short-lived by design: the plugin starts one process per tool call, it paints for
# -Seconds and exits, so there is no daemon to supervise.
#
#   powershell -File overlay.ps1 -Rect "l,t,r,b" [-Click "x,y"] [-Seconds 6]
#
# Two overlays may run at once (e.g. a frame from the previous call fading out);
# each is independent, topmost and never takes focus.
param(
  [string]$Rect = '',
  [string]$Click = '',
  [int]$Seconds = 6
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('CuaOverlay.Native' -as [type])) {
  Add-Type -Namespace CuaOverlay -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
'@
}

$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$frame = $null
if ($Rect) {
  $parts = $Rect.Split(',') | ForEach-Object { [int]$_ }
  if ($parts.Count -eq 4) {
    $frame = New-Object System.Drawing.Rectangle(
      ($parts[0] - $virtual.X), ($parts[1] - $virtual.Y), ($parts[2] - $parts[0]), ($parts[3] - $parts[1]))
  }
}
$point = $null
if ($Click) {
  $xy = $Click.Split(',') | ForEach-Object { [int]$_ }
  if ($xy.Count -eq 2) {
    $point = New-Object System.Drawing.Point(($xy[0] - $virtual.X), ($xy[1] - $virtual.Y))
  }
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::Fuchsia
$form.TransparencyKey = [System.Drawing.Color]::Fuchsia
$form.Bounds = if ($frame) { $frame } else { New-Object System.Drawing.Rectangle(0, 0, $virtual.Width, $virtual.Height) }
# The window only needs the area it paints; a full-screen form would swallow the
# transparency key over the whole desktop.
if ($frame) {
  $pad = 26
  $form.Bounds = New-Object System.Drawing.Rectangle(([Math]::Max(0, $frame.X - $pad)), ([Math]::Max(0, $frame.Y - $pad)), ($frame.Width + $pad * 2), ($frame.Height + $pad * 2))
}

$script:started = [DateTime]::Now
$script:origin = New-Object System.Drawing.Point($form.Bounds.X, $form.Bounds.Y)

$form.add_Shown({
  $handle = $form.Handle
  $style = [CuaOverlay.Native]::GetWindowLong($handle, -20)
  [void][CuaOverlay.Native]::SetWindowLong($handle, -20, ($style -bor 0x80000 -bor 0x20 -bor 0x80))
})

$form.add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $age = ([DateTime]::Now - $script:started).TotalMilliseconds

  if ($frame) {
    $local = New-Object System.Drawing.Rectangle(
      ($frame.X - $script:origin.X), ($frame.Y - $script:origin.Y), $frame.Width, $frame.Height)
    $glow = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(72, 77, 107, 254), 7)
    $g.DrawRectangle($glow, $local)
    $glow.Dispose()
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 77, 107, 254), 2)
    $g.DrawRectangle($pen, $local)
    $pen.Dispose()
  }

  if ($point) {
    $x = $point.X - $script:origin.X
    $y = $point.Y - $script:origin.Y
    $t = ($age % 800) / 800.0
    $radius = 12 + 30 * $t
    $alpha = [int](190 * (1 - $t))
    if ($alpha -gt 0) {
      $ring = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($alpha, 255, 122, 69), 2)
      $g.DrawEllipse($ring, ($x - $radius), ($y - $radius), ($radius * 2), ($radius * 2))
      $ring.Dispose()
    }
    $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 122, 69))
    $outline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 24, 24, 28), 1.5)
    $points = @(
      (New-Object System.Drawing.PointF(($x + 1), ($y + 1))),
      (New-Object System.Drawing.PointF(($x + 1), ($y + 21))),
      (New-Object System.Drawing.PointF(($x + 7), ($y + 15))),
      (New-Object System.Drawing.PointF(($x + 11), ($y + 25))),
      (New-Object System.Drawing.PointF(($x + 15), ($y + 23))),
      (New-Object System.Drawing.PointF(($x + 11), ($y + 14))),
      (New-Object System.Drawing.PointF(($x + 18), ($y + 14)))
    )
    $g.FillPolygon($fill, $points)
    $g.DrawPolygon($outline, $points)
    $fill.Dispose(); $outline.Dispose()
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
$timer.add_Tick({ $form.Invalidate() })
$timer.Start()

$stop = New-Object System.Windows.Forms.Timer
$stop.Interval = [Math]::Max(400, $Seconds * 1000)
$stop.add_Tick({ $form.Close() })
$stop.Start()

[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)