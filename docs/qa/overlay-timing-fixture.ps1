param([string]$Lab)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FrameQa {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
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
  $pos=New-Object FrameQa+Point
  if(![FrameQa]::IsWindowVisible($a.Handle) -or ![FrameQa]::ClientToScreen($a.Handle,[ref]$pos)){return}
  $left=$pos.X;$top=$pos.Y
  $bmp=New-Object Drawing.Bitmap(330,235)
  $g=[Drawing.Graphics]::FromImage($bmp)
  try {
    $dest=$g.GetHdc();$src=[FrameQa]::GetDC([IntPtr]::Zero)
    try {
      if ($src -eq [IntPtr]::Zero -or ![FrameQa]::BitBlt($dest,0,0,330,235,$src,$left,$top,0x40CC0020)) { throw 'BitBlt failed' }
    } finally {
      $g.ReleaseHdc($dest); if($src -ne [IntPtr]::Zero){[void][FrameQa]::ReleaseDC([IntPtr]::Zero,$src)}
    }
    # Only publish frames proven to contain our two known fixture colors.
    # No runner margins or other app pixels in the recorded region.
    $a1=$bmp.GetPixel(32,112); $a2=$bmp.GetPixel(300,185); $a3=$bmp.GetPixel(260,199)
    if($a1.R -ne 208 -or $a1.G -ne 117 -or $a1.B -ne 0 -or
       $a2.R -ne 208 -or $a2.G -ne 117 -or $a2.B -ne 0 -or
       $a3.R -notin 237,251 -or $a3.G -notin 159,185 -or $a3.B -notin 22,28){return}
    $blue=0
    for($j=1;$j -lt 12;$j++){
      for($k=112;$k -lt 127;$k+=3) {$blue=[Math]::Max($blue,$bmp.GetPixel($j,$k).B)}
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
  $rect=New-Object FrameQa+Rect
  if(![FrameQa]::GetWindowRect($a.Handle,[ref]$rect)){throw 'fixture bounds unavailable'}
  $info=@{offsetX=($script:origin.X-$rect.Left);offsetY=($script:origin.Y-$rect.Top);title=$a.Text;hWnd=$a.Handle.ToInt64()} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $Lab 'ready'),$info)
})
[Windows.Forms.Application]::Run($a)
