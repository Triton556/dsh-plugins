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
public static System.IntPtr GetForegroundWindow() { return Foreground; }
public static System.IntPtr WindowFromPoint(POINT p) { return Hit; }
public static System.IntPtr GetAncestor(System.IntPtr h, uint flag) { return Root; }
'@
foreach ($name in @('Assert-Foreground','Assert-PointerTarget')) {
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
