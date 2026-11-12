import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/tools/overlay.ps1';
let text = readFileSync(target, 'utf8');

// double buffering belongs in the class: the property is protected on Form
text = text.replace(
  '  public class ClickThroughForm : Form {',
  '  public class ClickThroughForm : Form {\n    public ClickThroughForm() {\n      DoubleBuffered = true;\n      SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);\n    }'
);
text = text.split('$form.DoubleBuffered = $true\n').join('');
text = text.split('$cursorForm.DoubleBuffered = $true\n').join('');

writeFileSync(target, text, 'utf8');
console.log('double buffering moved into the class');