import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/tools/overlay.ps1';
let text = readFileSync(target, 'utf8');

const anchor = "if (-not ('CuaGlow.Native' -as [type])) {";
const cs = [
  "if (-not ('CuaGlow.ClickThroughForm' -as [type])) {",
  "  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'",
  'using System;',
  'using System.Windows.Forms;',
  '',
  'namespace CuaGlow {',
  '  // Every hit test answers HTTRANSPARENT, so the overlay never eats a click even',
  '  // where the layered colour key alone would still be hit-testable.',
  '  public class ClickThroughForm : Form {',
  '    protected override void WndProc(ref Message m) {',
  '      if (m.Msg == 0x0084) { m.Result = (IntPtr)(-1); return; }',
  '      base.WndProc(ref m);',
  '    }',
  '  }',
  '}',
  "'@",
  '}',
  '',
  anchor,
].join('\n');

if (!text.includes(anchor)) { console.error('anchor missing'); process.exit(2); }
text = text.replace(anchor, cs);
text = text.split('New-Object System.Windows.Forms.Form').join('New-Object CuaGlow.ClickThroughForm');
writeFileSync(target, text, 'utf8');
console.log('click-through form wired:', (text.match(/ClickThroughForm/g) || []).length, 'references');