# Exercise the production capture functions with fake Win32 and GDI. This
# never reads the desktop; it also runs on Linux PowerShell 7.
$ErrorActionPreference = 'Stop'
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'cua.ps1'), [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Capture-ShotBitmap', 'Shot', 'Shot-Region')) {
  $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $fn) { throw "Missing capture function: $name" }
  . ([scriptblock]::Create($fn.Extent.Text))
}

Add-Type -Namespace Cua -Name Native -MemberDefinition @'
public struct RECT { public int Left, Top, Right, Bottom; }
public static int PrintCalls;
public static bool PrintSucceeds = true;
public static bool GetWindowRect(System.IntPtr h, ref RECT r) {
  r.Left = -120; r.Top = 20; r.Right = 80; r.Bottom = 120; return true;
}
public static bool PrintWindow(System.IntPtr hwnd, System.IntPtr hdc, uint flags) {
  if (flags != 2 || hwnd.ToInt32() != 123 || hdc.ToInt32() != 42)
    throw new System.ArgumentException("Unexpected PrintWindow arguments");
  PrintCalls++; return PrintSucceeds;
}
'@
function New-FakeBitmap([int]$w, [int]$h) {
  $bitmap = [pscustomobject]@{ Width = $w; Height = $h; Size = "$w,$h"; PixelFormat = 'fake' }
  Add-Member -InputObject $bitmap -MemberType ScriptMethod -Name Clone -Value {
    param($rect, $format)
    $script:events.Add("crop:$($rect.X),$($rect.Y),$($rect.Width),$($rect.Height)")
    New-FakeBitmap $rect.Width $rect.Height
  }
  Add-Member -InputObject $bitmap -MemberType ScriptMethod -Name Save -Value {
    param($path, $format)
    $script:events.Add("save:$($this.Width),$($this.Height)")
  }
  Add-Member -InputObject $bitmap -MemberType ScriptMethod -Name Dispose -Value {
    $script:events.Add("dispose:$($this.Width),$($this.Height)")
  }
  return $bitmap
}
function New-Object {
  if ($args[0] -eq 'System.Drawing.Bitmap') {
    return (New-FakeBitmap $args[1][0] $args[1][1])
  }
  Microsoft.PowerShell.Utility\New-Object @args
}
function New-ShotGraphics($bitmap) {
  $graphics = [pscustomobject]@{}
  Add-Member -InputObject $graphics -MemberType ScriptMethod -Name CopyFromScreen -Value {
    param($x, $y, $dx, $dy, $size)
    $script:events.Add("screen:$x,$y,$dx,$dy,$size")
  }
  Add-Member -InputObject $graphics -MemberType ScriptMethod -Name GetHdc -Value {
    $script:events.Add('get-hdc')
    return [IntPtr]42
  }
  Add-Member -InputObject $graphics -MemberType ScriptMethod -Name ReleaseHdc -Value {
    param($hdc)
    $script:events.Add("release:$hdc")
  }
  Add-Member -InputObject $graphics -MemberType ScriptMethod -Name Dispose -Value {
    $script:events.Add('dispose-graphics')
  }
  return $graphics
}
function Require-Events([string]$expected) {
  $actual = $script:events -join ';'
  if ($expected -ne $actual) { throw "Expected '$expected', got '$actual'" }
  $script:events.Clear()
}

$script:events = [System.Collections.Generic.List[string]]::new()
$handle = [IntPtr]123
$Method = 'screen'
if ((Shot 'full.png' $handle) -ne 'full.png') { throw 'Full screen shot did not report its path' }
Require-Events 'screen:-120,20,0,0,200,100;dispose-graphics;save:200,100;dispose:200,100'
if ((Shot-Region 'crop.png' $handle 190 90 25 25) -ne 'crop.png') { throw 'Screen crop did not report its path' }
Require-Events 'screen:-120,20,0,0,200,100;dispose-graphics;crop:190,90,10,10;save:10,10;dispose:10,10;dispose:200,100'
if ([Cua.Native]::PrintCalls) { throw 'Visible mode must not call PrintWindow' }

$Method = 'print'
[void](Shot 'full.png' $handle)
Require-Events 'get-hdc;release:42;dispose-graphics;save:200,100;dispose:200,100'
[void](Shot-Region 'crop.png' $handle 190 90 25 25)
Require-Events 'get-hdc;release:42;dispose-graphics;crop:190,90,10,10;save:10,10;dispose:10,10;dispose:200,100'
if ([Cua.Native]::PrintCalls -ne 2) { throw 'Both print paths must use PrintWindow' }

[Cua.Native]::PrintSucceeds = $false
foreach ($capture in @({ Shot 'full.png' $handle }, { Shot-Region 'crop.png' $handle 190 90 25 25 })) {
  try {
    & $capture
    throw 'Expected PrintWindow failure, not a success path'
  } catch {
    if ($_.Exception.Message -notlike 'CAPTURE_FAILED: PrintWindow failed*') { throw }
  }
  Require-Events 'get-hdc;release:42;dispose-graphics;dispose:200,100'
}
Write-Output 'PASS: full and cropped shots respect the requested backend; failed PrintWindow never saves a PNG'
