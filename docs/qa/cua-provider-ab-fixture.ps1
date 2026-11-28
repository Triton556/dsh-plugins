param([Parameter(Mandatory=$true)][string]$Lab)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Probe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
}
'@
function New-Fixture([string]$letter,[int]$x) {
  $form = New-Object Windows.Forms.Form
  $form.Text = "DSH Provider QA $letter"
  $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point($x,70)
  $form.ClientSize = New-Object Drawing.Size(270,180)
  $button = New-Object Windows.Forms.Button
  $button.Text = "Increment $letter"
  $button.SetBounds(24,28,165,45)
  $file = Join-Path $Lab ("$letter.count")
  [IO.File]::WriteAllText($file,'')
  $button.Tag = $file
  $button.Add_Click({param($sender,$unused) [IO.File]::AppendAllText($sender.Tag,("1"+[Environment]::NewLine))})
  $form.Controls.Add($button)
  return $form
}
$a = New-Fixture 'A' 35
$b = New-Fixture 'B' 375
$a.Show(); $b.Show(); $b.Activate()
$timer=New-Object Windows.Forms.Timer
$timer.Interval=35
$timer.Add_Tick({
  $pt = New-Object Probe+Point
  [void][Probe]::GetCursorPos([ref]$pt)
  $line = "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),$([Probe]::GetForegroundWindow().ToInt64()),$($pt.X),$($pt.Y)"
  [IO.File]::AppendAllText((Join-Path $Lab 'focus.csv'), ($line+[Environment]::NewLine))
})
$timer.Start()
$ready=@{pid=$PID; a=$a.Handle.ToInt64(); b=$b.Handle.ToInt64()} | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $Lab 'ready'),$ready)
[Windows.Forms.Application]::Run()
