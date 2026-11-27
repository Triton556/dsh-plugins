param([string]$Lab)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FrameQa {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint op);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
}
'@
$script:a = New-Object Windows.Forms.Form
$a.Text = 'DSH QA Timing A'
$a.StartPosition = 'Manual'
$a.Location = New-Object Drawing.Point(28,62)
$a.ClientSize = New-Object Drawing.Size(330,235)
$a.BackColor = [Drawing.Color]::FromArgb(208,117,0)
$a.MaximizeBox = $false
$a.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedSingle
$script:events = Join-Path $Lab 'input.csv'
[IO.File]::WriteAllText($events,"utcMs,event,x,y`r`n")
function Log-Input($name,$x,$y) {
  [IO.File]::AppendAllText($script:events,("$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),$name,$x,$y`r`n"))
}
$script:button = New-Object Windows.Forms.Button
$button.Text='Click test'
$button.SetBounds(42,50,125,40)
$button.Add_MouseDown({param($s,$e) Log-Input 'click-down' $e.X $e.Y; $s.Text='Button down'})
$button.Add_MouseUp({param($s,$e) Log-Input 'click-up' $e.X $e.Y; $s.Text='Click complete'})
$a.Controls.Add($button)
$script:drag = New-Object Windows.Forms.Panel
$drag.BackColor=[Drawing.Color]::FromArgb(237,159,22)
$drag.SetBounds(42,105,245,105)
$drag.Add_MouseDown({param($s,$e) Log-Input 'drag-down' $e.X $e.Y; $s.BackColor=[Drawing.Color]::FromArgb(251,185,28)})
$drag.Add_MouseUp({param($s,$e) Log-Input 'drag-up' $e.X $e.Y; $s.BackColor=[Drawing.Color]::FromArgb(237,159,22)})
$a.Controls.Add($drag)
$script:label=New-Object Windows.Forms.Label
$label.Text='Real fixture / native input'
$label.Font=New-Object Drawing.Font('Segoe UI',12,[Drawing.FontStyle]::Bold)
$label.AutoSize=$true
$label.Location=New-Object Drawing.Point(42,18)
$a.Controls.Add($label)
$script:armed=$false; $script:sent=$false; $script:pressAt=0; $script:i=0; $script:prevTag='';$script:origin=New-Object FrameQa+Point
$script:frames = Join-Path $Lab 'frames'
[void](New-Item -ItemType Directory $frames)
$script:stats = Join-Path $Lab 'samples.csv'
[IO.File]::WriteAllText($stats,"frame,utcMs,phase,blue,down,active,cursorX,cursorY`r`n")
function Sample-Frame {
  $t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $tag='baseline'
  try { $tag=[IO.File]::ReadAllText((Join-Path $Lab 'phase.txt')).Trim() } catch {}
  if (!$tag) { $tag=$script:prevTag }
  if (!$tag) { $tag='baseline' }
  $script:prevTag=$tag
  $pressed=([FrameQa]::GetAsyncKeyState(1) -band 32768) -ne 0
  $active=[FrameQa]::GetForegroundWindow() -eq $a.Handle
  $p=New-Object FrameQa+Point;[void][FrameQa]::GetCursorPos([ref]$p)
  $left=$script:origin.X-6;$top=$script:origin.Y-32
  $bmp=New-Object Drawing.Bitmap(346,275)
  $g=[Drawing.Graphics]::FromImage($bmp)
  try {
    $dest=$g.GetHdc();$src=[FrameQa]::GetDC([IntPtr]::Zero)
    try {
      if ($src -eq [IntPtr]::Zero -or ![FrameQa]::BitBlt($dest,0,0,346,275,$src,$left,$top,0x40CC0020)) { throw 'BitBlt failed' }
    } finally {
      $g.ReleaseHdc($dest); if($src -ne [IntPtr]::Zero){[void][FrameQa]::ReleaseDC([IntPtr]::Zero,$src)}
    }
    $blue=0
    for($j=7;$j -lt 18;$j++){
      for($k=144;$k -lt 157;$k+=3) {$blue=[Math]::Max($blue,$bmp.GetPixel($j,$k).B)}
    }
    $number=$script:i++
    $bmp.Save((Join-Path $script:frames ('{0:D5}.png' -f $number)),[Drawing.Imaging.ImageFormat]::Png)
    [IO.File]::AppendAllText($script:stats,("$number,$t,$tag,$blue,$([int]$pressed),$([int]$active),$($p.X-$left),$($p.Y-$top)`r`n"))
  } finally { $g.Dispose();$bmp.Dispose() }
  if($tag -eq 'escape' -and $active -and $pressed -and !$script:sent) {
    if(!$script:pressAt){$script:pressAt=$t}
    if($t-$script:pressAt -ge 950){
      $script:sent=$true;Log-Input 'esc-injected' 0 0
      [FrameQa]::keybd_event(27,0,0,[UIntPtr]::Zero)
      Start-Sleep -Milliseconds 90
      [FrameQa]::keybd_event(27,0,2,[UIntPtr]::Zero)
    }
  }
}
$a.KeyPreview=$true
$a.Add_KeyDown({param($s,$e) if($e.KeyCode -eq [Windows.Forms.Keys]::Escape){Log-Input 'esc-window' 0 0}})
$a.Add_Shown({
  [void][FrameQa]::ClientToScreen($a.Handle,[ref]$script:origin)
  $a.Activate()
  $script:timer=New-Object Windows.Forms.Timer
  $timer.Interval=23
  $timer.Add_Tick({try {Sample-Frame} catch {[IO.File]::WriteAllText((Join-Path $Lab 'sampler-error.txt'),($_|Out-String));$script:timer.Stop()}})
  $timer.Start()
  [IO.File]::WriteAllText((Join-Path $Lab 'ready'),'ready')
})
[Windows.Forms.Application]::Run($a)
