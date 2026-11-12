import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/index.js';
let text = readFileSync(target, 'utf8');

// 1) a short human caption per tool call, shown next to the cursor
const captionFn = `
// Caption shown next to the cursor: what the agent is about to do, in a few words.
function captionFor(name, args = {}) {
  const target = args.window || (args.pid ? \`pid \${args.pid}\` : '');
  const where = target ? \` · \${String(target).slice(0, 34)}\` : '';
  switch (name) {
    case 'computer_shot': return \`screenshot\${where}\`;
    case 'computer_click': return \`click \${args.x ?? '?'},\${args.y ?? '?'}\${where}\`;
    case 'computer_drag': return \`drag \${args.x ?? '?'},\${args.y ?? '?'} → \${args.x2 ?? '?'},\${args.y2 ?? '?'}\`;
    case 'computer_type': return \`type "\${String(args.text || '').slice(0, 24)}"\`;
    case 'computer_key': return \`key \${String(args.text || '').slice(0, 20)}\`;
    case 'computer_scroll': return \`scroll \${args.delta ?? ''}\${where}\`;
    case 'computer_focus': return \`focus\${where}\`;
    case 'computer_window': return \`window \${args.op || 'normal'}\${where}\`;
    case 'computer_launch': return \`launch \${String(args.path || '').split(/[\\\\/]/).pop()}\`;
    case 'computer_tabs': return \`browser tabs\${where}\`;
    case 'computer_tab': return \`tab "\${String(args.title || '').slice(0, 24)}"\`;
    case 'computer_wait': return \`wait \${args.window || args.text || ''}\`.trim();
    case 'computer_record': return \`record \${args.frames || 10} frames\${where}\`;
    case 'computer_video': return \`record \${args.format || 'mp4'}\${where}\`;
    case 'computer_ocr': return 'read text (ocr)';
    case 'computer_uitree': return \`ui tree\${where}\`;
    case 'computer_ui_action': return \`ui \${args.kind || 'act'} "\${String(args.name || '').slice(0, 20)}"\`;
    case 'computer_cdp': return \`browser \${args.action || ''}\${args.target ? \` · \${String(args.target).slice(0, 24)}\` : ''}\`;
    default: return name.replace(/^computer_/, '');
  }
}
`;

const marker = '// ------------------------------------------------------------------- catalogue';
if (!text.includes(marker)) { console.error('catalogue marker missing'); process.exit(2); }
text = text.replace(marker, captionFn + '\n' + marker);

// 2) push the caption together with the geometry
text = text.replace(
  'function pushOverlay(hwnd, rect, click) {',
  'function pushOverlay(hwnd, rect, click, label) {'
);
text = text.replace(
  '      cursor: Number.isFinite(point[0]) && Number.isFinite(point[1]) ? { x: point[0], y: point[1] } : undefined',
  '      cursor: Number.isFinite(point[0]) && Number.isFinite(point[1]) ? { x: point[0], y: point[1] } : undefined,\n      label: String(label || \'\').slice(0, 48)'
);

// 3) call site gains the caption (CDP tools have no engine geometry line, so they
//    write the state themselves)
text = text.replace(
  '                if (parsed.rect && CUA_OVERLAY) pushOverlay(parsed.hwnd, parsed.rect, parsed.click);',
  '                if (parsed.rect && CUA_OVERLAY) pushOverlay(parsed.hwnd, parsed.rect, parsed.click, captionFor(spec.name, args));'
);

writeFileSync(target, text, 'utf8');
console.log('captions wired');