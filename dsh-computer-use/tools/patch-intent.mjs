import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/index.js';
let text = readFileSync(target, 'utf8');

// 1) intent parameter on the input tools (the agent supplies 1-3 words)
for (const tool of ['computer_click', 'computer_drag', 'computer_type', 'computer_key', 'computer_scroll', 'computer_focus', 'computer_window', 'computer_tab', 'computer_launch']) {
  const marker = "    name: '" + tool + "',";
  const idx = text.indexOf(marker);
  if (idx < 0) continue;
  const paramsIdx = text.indexOf('parameters: {', idx);
  if (paramsIdx < 0) continue;
  const insertion = `parameters: {\n      intent: { type: 'string', description: 'One to three words of intent for the on-screen caption, e.g. "open settings", "send message"' },`;
  text = text.slice(0, paramsIdx) + insertion + text.slice(paramsIdx + 'parameters: {'.length);
}

// 2) captions prefer the intent and drop coordinates
const oldCaptions = text.slice(text.indexOf('function captionFor(name, args = {}) {'), text.indexOf('}\n\n// ------------------------------------------------------------------- catalogue'));
const newCaptions = `function captionFor(name, args = {}) {
  const intent = String(args.intent || '').trim().slice(0, 40);
  const target = args.window || (args.pid ? \`pid \${args.pid}\` : '');
  const where = target ? String(target).slice(0, 30) : '';
  const verb = {
    computer_shot: 'screenshot',
    computer_click: 'click',
    computer_drag: 'drag',
    computer_type: 'type',
    computer_key: 'key',
    computer_scroll: 'scroll',
    computer_focus: 'focus',
    computer_window: 'window',
    computer_launch: 'launch',
    computer_tabs: 'browser tabs',
    computer_tab: 'tab',
    computer_wait: 'wait',
    computer_record: 'record',
    computer_video: 'record',
    computer_ocr: 'read text',
    computer_uitree: 'ui tree',
    computer_ui_action: 'ui action',
    computer_cdp: 'browser',
  }[name] || name.replace(/^computer_/, '');
  // intent is what the agent is trying to achieve; the window is a fallback hint
  const parts = [verb];
  if (intent) parts.push(intent);
  else if (where) parts.push(where);
  return parts.join(' · ');
}
`;
if (!oldCaptions || oldCaptions.length < 40) { console.error('caption function not found'); process.exit(2); }
text = text.replace(oldCaptions, newCaptions);

// 3) the system prompt asks for the intent
text = text.replace(
  "  '- Never fight the user for the cursor: if they take over, stop and ask.',",
  "  '- Never fight the user for the cursor: if they take over, stop and ask.',\n  '- Give input tools a short `intent` (1-3 words: \"open settings\", \"send message\"): it is what',\n  '  the on-screen caption shows next to the cursor, so the user sees the purpose, not coordinates.',"
);

writeFileSync(target, text, 'utf8');
console.log('intent captions wired');