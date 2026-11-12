import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/tools/overlay.ps1';
let text = readFileSync(target, 'utf8');

// 1) +50% opacity for the glow
text = text.replace('$form.Opacity = 0.15', '$form.Opacity = 0.22');

// 2) bigger cursor window so the arrow is never clipped
text = text.replace('$cursorForm.Size = New-Object System.Drawing.Size(48, 48)', '$cursorForm.Size = New-Object System.Drawing.Size(96, 96)');

// 3) larger drawing with three halo steps (solid colours only, no alpha)
const start = text.indexOf('$cursorForm.Add_Paint({');
const end = text.indexOf('})', text.indexOf('$rim.Dispose()')) + 2;
if (start < 0 || end < 3) { console.error('cursor paint block missing'); process.exit(2); }
const paint = `$cursorForm.Add_Paint({
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
})`;
text = text.slice(0, start) + paint + text.slice(end);

// 4) make both windows transparent to input AFTER they are shown, and log the style
const marker = '$cursorForm.Show()';
if (!text.includes(marker)) { console.error('cursor show missing'); process.exit(2); }
text = text.replace(marker, `${marker}
foreach ($wnd in @($form.Handle, $cursorForm.Handle)) {
  $current = [CuaGlow.Native]::GetWindowLong($wnd, -20)
  [void][CuaGlow.Native]::SetWindowLong($wnd, -20, ($current -bor 0x80000 -bor 0x20 -bor 0x80 -bor 0x08000000))
  Note ('style hwnd=' + $wnd + ' ex=' + ('0x{0:X}' -f [CuaGlow.Native]::GetWindowLong($wnd, -20)))
}`);

writeFileSync(target, text, 'utf8');
console.log('overlay patched: opacity, size, click-through');