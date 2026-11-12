
# DeepSeek computer-use indicator (WPF).
#
# WPF gives real per-pixel alpha, so the sprite keeps its soft glow (no dithering,
# no magenta fringes) and the edge glow can fade smoothly instead of ending in a
# hard line.
#
#   * full-screen transparent window, click-through, never takes focus;
#   * four edge gradients: opaque at the screen border, transparent ~72 px inside;
#   * the cursor sprite, tinted and gently rocking while an action runs;
#   * a small caption next to it naming what the agent is doing.
#
# State file written by the plugin:
#   { "updated": <unix ms>, "ttlMs": 90000, "screen": true,
#     "target": { "hwnd": 123, "rect": [l,t,r,b] },
#     "cursor": { "x": 900, "y": 520 }, "label": "click 592,781" }
param(
  [string]$StatePath = (Join-Path $env:TEMP 'dsh-cua-overlay-state.json'),
  [string]$PidPath = (Join-Path $env:TEMP 'dsh-cua-overlay.pid'),
  [string]$LogPath = (Join-Path $env:TEMP 'dsh-cua-overlay.log'),
  [int]$Depth = 72,
  [double]$CursorSize = 40
)

# boot marker: written before the heavy start-up work, so a silent death is visible
try { Add-Content -LiteralPath (Join-Path $env:TEMP 'dsh-cua-overlay.log') -Value ((Get-Date -Format 'HH:mm:ss') + " boot pid=" + $PID) } catch {}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Windows.Forms, System.Drawing

if (-not ('CuaWpf.Native' -as [type])) {
  Add-Type -Namespace CuaWpf -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@
}

function Note([string]$text) {
  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $text) } catch {}
}
try { [System.IO.File]::WriteAllText($PidPath, [string]$PID, (New-Object System.Text.UTF8Encoding($false))) } catch {}
Note "start pid=$PID"

$v = [System.Windows.Forms.SystemInformation]::VirtualScreen; $screen = [pscustomobject]@{ X = $v.X; Y = $v.Y; Width = $v.Width; Height = $v.Height }
$left = $screen.X; $top = $screen.Y; $width = $screen.Width; $height = $screen.Height

$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.ShowInTaskbar = $false
$window.Topmost = $true
$window.ResizeMode = 'NoResize'
$window.IsHitTestVisible = $false
$window.Left = $left
$window.Top = $top
$window.Width = $width
$window.Height = $height

$canvas = New-Object System.Windows.Controls.Canvas
$canvas.Width = $width
$canvas.Height = $height
$window.Content = $canvas

function New-EdgeGradient([string]$side) {
  $brush = New-Object System.Windows.Media.LinearGradientBrush
  $deepseek = [System.Windows.Media.Color]::FromArgb(150, 77, 107, 254)
  $clear = [System.Windows.Media.Color]::FromArgb(0, 77, 107, 254)
  switch ($side) {
    'top' { $brush.StartPoint = New-Object System.Windows.Point(0, 0); $brush.EndPoint = New-Object System.Windows.Point(0, 1) }
    'bottom' { $brush.StartPoint = New-Object System.Windows.Point(0, 1); $brush.EndPoint = New-Object System.Windows.Point(0, 0) }
    'left' { $brush.StartPoint = New-Object System.Windows.Point(0, 0); $brush.EndPoint = New-Object System.Windows.Point(1, 0) }
    'right' { $brush.StartPoint = New-Object System.Windows.Point(1, 0); $brush.EndPoint = New-Object System.Windows.Point(0, 0) }
  }
  $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop($deepseek, 0)))
  $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop($clear, 1)))
  return $brush
}

$bands = @(
  @{ side = 'top'; x = 0; y = 0; w = $width; h = $Depth },
  @{ side = 'bottom'; x = 0; y = ($height - $Depth); w = $width; h = $Depth },
  @{ side = 'left'; x = 0; y = 0; w = $Depth; h = $height },
  @{ side = 'right'; x = ($width - $Depth); y = 0; w = $Depth; h = $height }
)
foreach ($band in $bands) {
  $rect = New-Object System.Windows.Shapes.Rectangle
  $rect.Width = $band.w
  $rect.Height = $band.h
  $rect.Fill = New-EdgeGradient $band.side
  [System.Windows.Controls.Canvas]::SetLeft($rect, $band.x)
  [System.Windows.Controls.Canvas]::SetTop($rect, $band.y)
  [void]$canvas.Children.Add($rect)
}

# cursor: sprite + rotation + caption
$cursorGroup = New-Object System.Windows.Controls.Canvas
$cursorGroup.Width = $CursorSize
$cursorGroup.Height = $CursorSize
$cursorGroup.RenderTransformOrigin = New-Object System.Windows.Point(0.2, 0.15)
$rotate = New-Object System.Windows.Media.RotateTransform(0)
$cursorGroup.RenderTransform = $rotate

$spritePath = Join-Path $PSScriptRoot 'cursor-neon-crisp.png'
if (Test-Path -LiteralPath $spritePath) {
  $image = New-Object System.Windows.Controls.Image
  $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
  $bitmap.BeginInit()
  $bitmap.UriSource = New-Object System.Uri($spritePath)
  $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bitmap.EndInit()
  $image.Source = $bitmap
  $image.Width = $CursorSize
  $image.Height = $CursorSize
  [void]$cursorGroup.Children.Add($image)
}
[System.Windows.Controls.Canvas]::SetLeft($cursorGroup, 0)
[System.Windows.Controls.Canvas]::SetTop($cursorGroup, 0)
[void]$canvas.Children.Add($cursorGroup)

$captionBorder = New-Object System.Windows.Controls.Border
$captionBorder.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(232, 16, 20, 34))
$captionBorder.CornerRadius = New-Object System.Windows.CornerRadius(7)
$captionBorder.Padding = New-Object System.Windows.Thickness(9, 4, 9, 4)
$captionText = New-Object System.Windows.Controls.TextBlock
$captionText.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(242, 224, 232, 255))
$captionText.FontSize = 12
$captionText.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI')
$captionBorder.Child = $captionText
$captionBorder.Visibility = 'Collapsed'
[void]$canvas.Children.Add($captionBorder)

# Banner shown while the agent drives the whole screen (like Codex's notice).
$banner = New-Object System.Windows.Controls.Border
$banner.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(236, 18, 22, 38))
$banner.CornerRadius = New-Object System.Windows.CornerRadius(10)
$banner.Padding = New-Object System.Windows.Thickness(16, 10, 16, 10)
$banner.BorderThickness = New-Object System.Windows.Thickness(1)
$banner.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(150, 77, 107, 254))
$bannerStack = New-Object System.Windows.Controls.StackPanel
$bannerTitle = New-Object System.Windows.Controls.TextBlock
$bannerTitle.Text = 'DeepSeek using your computer'
$bannerTitle.FontSize = 14
$bannerTitle.FontWeight = 'SemiBold'
$bannerTitle.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI')
$bannerTitle.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(240, 224, 232, 255))
$bannerHint = New-Object System.Windows.Controls.TextBlock
$bannerHint.Text = 'ESC to stop'
$bannerHint.FontSize = 12
$bannerHint.Margin = New-Object System.Windows.Thickness(0, 3, 0, 0)
$bannerHint.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI')
$bannerHint.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(190, 150, 174, 255))
[void]$bannerStack.Children.Add($bannerTitle)
[void]$bannerStack.Children.Add($bannerHint)
$banner.Child = $bannerStack
$banner.Visibility = 'Collapsed'
[void]$canvas.Children.Add($banner)


$window.Show()

$handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
$style = [CuaWpf.Native]::GetWindowLong($handle, -20)
[void][CuaWpf.Native]::SetWindowLong($handle, -20, ($style -bor 0x80000 -bor 0x20 -bor 0x80 -bor 0x08000000))
Note ('hwnd=' + $handle + ' ex=0x{0:X}' -f [CuaWpf.Native]::GetWindowLong($handle, -20))

$script:snapshot = $null
$script:curX = -1.0
$script:curY = -1.0
$script:goalX = -1.0
$script:goalY = -1.0
$script:lastStamp = 0
$script:lastSeen = 0
$script:rock = 0.0
$script:lastEsc = 0
$script:stoppedAt = 0
$StopPath = Join-Path $env:TEMP 'dsh-cua-stop.json'

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
    $foreground = [CuaWpf.Native]::GetForegroundWindow()
    if ($foreground -eq [System.IntPtr]::Zero) { return $false }
    if ($snapshot.target -and $snapshot.target.hwnd) {
      $target = [int64]$snapshot.target.hwnd
      if ([int64]$foreground.ToInt64() -eq $target) { return $true }
      $root = [CuaWpf.Native]::GetAncestor($foreground, 2)
      if ($root -ne [System.IntPtr]::Zero -and [int64]$root.ToInt64() -eq $target) { return $true }
    }
    return $false
  } catch { return $false }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(33)
$timer.Add_Tick({
  $snapshot = Read-Snapshot
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $ttl = 90000
  if ($snapshot -and $snapshot.ttlMs) { $ttl = [int]$snapshot.ttlMs }
  $fresh = $false
  if ($snapshot -and $snapshot.updated) { $fresh = ($now - [int64]$snapshot.updated) -le $ttl }
  $visible = $fresh -and (ForegroundMatches $snapshot)
  $screenMode = $snapshot -and $snapshot.mode -eq 'screen'

  # ESC stops the takeover: write a marker the plugin reads on the next call and
  # hide the overlay until the state changes again.
  if ($visible -and $screenMode) {
    $esc = [CuaWpf.Native]::GetAsyncKeyState(0x1B)
    if (($esc -band 0x8001) -ne 0 -and $now - $script:lastEsc -gt 700) {
      $script:lastEsc = $now
      try {
        [System.IO.File]::WriteAllText($StopPath, ('{"at":' + $now + '}'), (New-Object System.Text.UTF8Encoding($false)))
        Note 'esc pressed - stop marker written'
      } catch {}
      $script:stoppedAt = $now
    }
  }
  if ($script:stoppedAt -gt 0 -and ($now - $script:stoppedAt) -lt 4000) { $visible = $false }
  if ($visible) { $script:lastSeen = $now }

  $edgeOpacity = if ($visible) { 1.0 } else { 0.0 }
  foreach ($child in $canvas.Children) {
    if ($child -is [System.Windows.Shapes.Rectangle]) { $child.Opacity = $edgeOpacity }
  }
  $cursorGroup.Visibility = if ($visible) { 'Visible' } else { 'Hidden' }
  $captionBorder.Visibility = if ($visible -and $captionText.Text) { 'Visible' } else { 'Collapsed' }
  $banner.Visibility = if ($visible -and $screenMode) { 'Visible' } else { 'Collapsed' }
  if ($banner.Visibility -eq 'Visible') {
    $banner.Measure((New-Object System.Windows.Size([double]::PositiveInfinity, [double]::PositiveInfinity)))
    $bannerW = $banner.DesiredSize.Width
    [System.Windows.Controls.Canvas]::SetLeft($banner, [Math]::Max(0, ($width - $bannerW) / 2))
    [System.Windows.Controls.Canvas]::SetTop($banner, [Math]::Max(24, $height * 0.12))
  }

  if ($visible -and $snapshot.cursor) {
    $script:goalX = [double]$snapshot.cursor.x - $left
    $script:goalY = [double]$snapshot.cursor.y - $top
    if ($script:curX -lt 0) { $script:curX = $script:goalX; $script:curY = $script:goalY }
    if ($snapshot.label) { $captionText.Text = [string]$snapshot.label }
    if ($snapshot.updated -ne $script:lastStamp) {
      $script:lastStamp = $snapshot.updated
      $script:rock = 0.0
    }
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
    [System.Windows.Controls.Canvas]::SetLeft($cursorGroup, ($script:curX - $CursorSize * 0.18))
    [System.Windows.Controls.Canvas]::SetTop($cursorGroup, ($script:curY - $CursorSize * 0.15))

    # gentle rocking while the action is fresh, back to upright afterwards
    $age = $now - $script:lastStamp
    $targetAngle = if ($age -lt 6000) { 14 * [Math]::Sin($age / 260.0) } else { 0 }
    $script:rock += ($targetAngle - $script:rock) * 0.18
    $rotate.Angle = $script:rock

    if ($captionText.Text) {
      $captionBorder.Measure((New-Object System.Windows.Size([double]::PositiveInfinity, [double]::PositiveInfinity)))
      $capW = $captionBorder.DesiredSize.Width
      $capH = $captionBorder.DesiredSize.Height
      [System.Windows.Controls.Canvas]::SetLeft($captionBorder, [Math]::Min(($width - $capW - 8), ($script:curX + $CursorSize * 0.9)))
      [System.Windows.Controls.Canvas]::SetTop($captionBorder, [Math]::Max(8, ($script:curY - $capH * 0.2)))
    }
  }

  if ($script:lastSeen -gt 0 -and ($now - $script:lastSeen) -gt 300000) {
    $window.Close()
  }
})
$timer.Start()

[System.Windows.Threading.Dispatcher]::Run()
