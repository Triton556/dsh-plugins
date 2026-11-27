# Pure logic test. Compiles a dummy user32 surface; never loads Win32 or sends
# input. Can be run in PowerShell 7 on Linux or in a fresh Windows process.
$ErrorActionPreference = 'Stop'
$enginePath = Join-Path $PSScriptRoot 'cua.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($enginePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$overlay = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'overlay.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }

Add-Type -Namespace Cua -Name Native -MemberDefinition @'
public struct POINT { public int X, Y; }
public static System.IntPtr Foreground;
public static System.IntPtr Hit;
public static System.IntPtr Root;
public static bool DpiExportsMissing;
public static System.IntPtr DpiTarget;
public static uint GetDpiForWindow(System.IntPtr h) { if (DpiExportsMissing) throw new System.EntryPointNotFoundException(); return h == DpiTarget ? 144u : 0u; }
public static System.IntPtr GetWindowDpiAwarenessContext(System.IntPtr h) { if (DpiExportsMissing) throw new System.EntryPointNotFoundException(); return h == DpiTarget ? new System.IntPtr(-4) : System.IntPtr.Zero; }
public static int GetAwarenessFromDpiAwarenessContext(System.IntPtr c) { return c.ToInt64() == -4 ? 2 : -1; }
public static System.Collections.Generic.List<uint> MouseEvents = new System.Collections.Generic.List<uint>();
public static void mouse_event(uint flags, uint x, uint y, uint data, System.UIntPtr extra) { MouseEvents.Add(flags); }
public static System.IntPtr GetForegroundWindow() { return Foreground; }
public static System.IntPtr WindowFromPoint(POINT p) { return Hit; }
public static System.IntPtr GetAncestor(System.IntPtr h, uint flag) { return Root; }
'@
foreach ($name in @('Assert-Foreground','Assert-PointerTarget','Assert-ActionActive','Wait-ActionDelay','Invoke-MousePress','Get-TargetDpi')) {
  $fn = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  if (-not $fn) { throw "Missing function $name" }
  . ([scriptblock]::Create($fn.Extent.Text))
}
function Require-Rejection([scriptblock]$test, [string]$message) {
  try { & $test } catch {
    if (-not $_.Exception.Message.StartsWith($message)) { throw }
    return
  }
  throw "Expected $message"
}
$target = [System.IntPtr]123
$other = [System.IntPtr]124
[Cua.Native]::Foreground = $other
[Cua.Native]::Hit = $target
Require-Rejection { Assert-PointerTarget $target 30 40 } 'TARGET_NOT_FOREGROUND'
[Cua.Native]::Foreground = $target
[Cua.Native]::Hit = $other
[Cua.Native]::Root = $other
Require-Rejection { Assert-PointerTarget $target 30 40 } 'TARGET_POINT_BLOCKED'
[Cua.Native]::Root = $target
Assert-PointerTarget $target -30 40
Assert-PointerTarget ([System.IntPtr]::Zero) -130 40

$nativeKeys = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Value -match 'struct INPUTUNION'
}, $true)
Add-Type -Namespace Cua -Name Keys -MemberDefinition $nativeKeys.Value
$size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Cua.Keys+INPUT')
$expected = if ([System.IntPtr]::Size -eq 8) { 40 } else { 28 }
if ($size -ne $expected) { throw "Win32 INPUT layout: expected $expected bytes, got $size" }
Write-Output "PASS: script parsing, foreground/coverage guard, child HWND, Win32 INPUT layout (${size} bytes)"

# Stopping while a press is active must release it before propagating the
# cancellation. These tests exercise the production PowerShell try/finally.
$stopSignal = Join-Path ([IO.Path]::GetTempPath()) ("dsh-input-contract-" + [guid]::NewGuid())
$DeadlineMs = 0
try {
  Require-Rejection {
    Invoke-MousePress 2 4 {
      [IO.File]::WriteAllText($stopSignal, '')
      Wait-ActionDelay 0
    }
  } 'STOPPED:'
  if (([Cua.Native]::MouseEvents -join ',') -ne '2,4') { throw 'ESC did not release the left button' }
  [Cua.Native]::MouseEvents.Clear()
  Require-Rejection { Invoke-MousePress 2 4 { throw 'unreachable' } } 'STOPPED:'
  if ([Cua.Native]::MouseEvents.Count) { throw 'Already-cancelled action pressed a button' }
  [IO.File]::Delete($stopSignal)
  Require-Rejection {
    Invoke-MousePress 8 16 {
      $DeadlineMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 1
      Wait-ActionDelay 0
    }
  } 'TIMED_OUT:'
  if (([Cua.Native]::MouseEvents -join ',') -ne '8,16') { throw 'Deadline did not release the right button' }
  Write-Output 'PASS: per-action stop and deadline release simulated mouse presses once; a cancelled action never presses'
} finally { [IO.File]::Delete($stopSignal) }

# One test HWND at 144 DPI must not become a system DPI guess for another HWND.
[Cua.Native]::DpiTarget = $target
$dpi = Get-TargetDpi $target
if ($dpi.Dpi -ne 144 -or $dpi.Awareness -ne 'per-monitor-aware') { throw 'Target DPI not attributed to the exact HWND' }
$missing = Get-TargetDpi $other
if ($null -ne $missing.Dpi -or $missing.Awareness -ne 'unknown') { throw 'No-DPI result invented a DPI or awareness' }
[Cua.Native]::DpiExportsMissing = $true
$legacy = Get-TargetDpi $target
if ($null -ne $legacy.Dpi -or $legacy.Awareness -ne 'unknown') { throw 'Unavailable APIs invented a DPI or awareness' }
Write-Output 'PASS: window DPI from exact HWND, awareness and unknown/missing APIs without registry fallback'
