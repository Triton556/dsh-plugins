import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/tools/overlay.ps1';
let text = readFileSync(target, 'utf8');

// 1) ESC polling support
text = text.replace(
  "[DllImport(\"user32.dll\")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags);",
  "[DllImport(\"user32.dll\")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags);\n[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);"
);

// 2) banner: a dark card with the Codex-style two lines, shown for whole-screen use
const bannerCode = `
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
`;
const anchor = '[void]$canvas.Children.Add($captionBorder)';
if (!text.includes(anchor)) { console.error('caption anchor missing'); process.exit(2); }
text = text.replace(anchor, anchor + '\n' + bannerCode);

// 3) state fields: mode + ESC handling in the timer
text = text.replace(
  `  $visible = $fresh -and (ForegroundMatches $snapshot)`,
  `  $visible = $fresh -and (ForegroundMatches $snapshot)
  $screenMode = $snapshot -and $snapshot.mode -eq 'screen'

  # ESC stops the takeover: write a marker the plugin reads on the next call and
  # hide the overlay until the state changes again.
  if ($visible -and $screenMode) {
    $esc = [CuaWpf.Native]::GetAsyncKeyState(0x1B)
    if (($esc -band 0x8000) -ne 0 -and $now - $script:lastEsc -gt 700) {
      $script:lastEsc = $now
      try {
        [System.IO.File]::WriteAllText($StopPath, ('{"at":' + $now + '}'), (New-Object System.Text.UTF8Encoding($false)))
        Note 'esc pressed - stop marker written'
      } catch {}
      $script:stoppedAt = $now
    }
  }
  if ($script:stoppedAt -gt 0 -and ($now - $script:stoppedAt) -lt 4000) { $visible = $false }`
);

// 4) banner visibility + placement
text = text.replace(
  `  $captionBorder.Visibility = if ($visible -and $captionText.Text) { 'Visible' } else { 'Collapsed' }`,
  `  $captionBorder.Visibility = if ($visible -and $captionText.Text) { 'Visible' } else { 'Collapsed' }
  $banner.Visibility = if ($visible -and $screenMode) { 'Visible' } else { 'Collapsed' }
  if ($banner.Visibility -eq 'Visible') {
    $banner.Measure((New-Object System.Windows.Size([double]::PositiveInfinity, [double]::PositiveInfinity)))
    $bannerW = $banner.DesiredSize.Width
    [System.Windows.Controls.Canvas]::SetLeft($banner, [Math]::Max(0, ($width - $bannerW) / 2))
    [System.Windows.Controls.Canvas]::SetTop($banner, [Math]::Max(24, $height * 0.12))
  }`
);

// 5) state variables and the stop marker path
text = text.replace(
  `$script:rock = 0.0`,
  `$script:rock = 0.0
$script:lastEsc = 0
$script:stoppedAt = 0
$StopPath = Join-Path $env:TEMP 'dsh-cua-stop.json'`
);

writeFileSync(target, text, 'utf8');
console.log('banner + esc wired');