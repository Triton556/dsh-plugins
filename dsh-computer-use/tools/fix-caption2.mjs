import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/index.js';
const lines = readFileSync(target, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.includes('function captionFor(name, args = {})'));
if (start < 0) { console.error('captionFor missing'); process.exit(2); }
let end = start;
while (end < lines.length && lines[end].trim() !== '}') end += 1;
const replacement = [
  '// Caption shown next to the cursor: the intent of the action in a few words, so the',
  '// user reads the purpose instead of raw coordinates.',
  'function captionFor(name, args = {}) {',
  '  const intent = String(args.intent || "").trim().slice(0, 40);',
  '  const verb = {',
  '    computer_shot: "screenshot",',
  '    computer_click: "click",',
  '    computer_drag: "drag",',
  '    computer_type: "type",',
  '    computer_key: "key",',
  '    computer_scroll: "scroll",',
  '    computer_focus: "focus",',
  '    computer_window: "window",',
  '    computer_launch: "launch",',
  '    computer_tabs: "browser tabs",',
  '    computer_tab: "tab",',
  '    computer_wait: "wait",',
  '    computer_record: "record",',
  '    computer_video: "record",',
  '    computer_ocr: "read text",',
  '    computer_uitree: "ui tree",',
  '    computer_ui_action: "ui action",',
  '    computer_cdp: "browser",',
  '  }[name] || name.replace(/^computer_/, "");',
  '  if (intent) return verb + ": " + intent;',
  '  const target = args.window || (args.pid ? "pid " + args.pid : "");',
  '  return target ? verb + ": " + String(target).slice(0, 30) : verb;',
  '}',
];
const out = [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)];
writeFileSync(target, out.join('\n'), 'utf8');
console.log('captionFor replaced, lines', start + 1, '-', end + 1);