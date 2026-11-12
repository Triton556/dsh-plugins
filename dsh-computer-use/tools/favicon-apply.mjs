// Apply the composited badge (original favicon + whale cursor) to the demo tab,
// hold it for the screenshot, restore. The orchestrator prepares wiki-badge.b64.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CDP = new URL('./cdp.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const b64 = readFileSync('C:/Users/Danil/AppData/Local/Temp/wiki-badge.b64', 'utf8').trim();
const targetId = process.argv[process.argv.indexOf('-Target') + 1];

function run(args) {
  return execFileSync(process.execPath, [CDP, ...args], { encoding: 'utf8', timeout: 30000 });
}

const swapOn = `(function(){
  const dataUrl = 'data:image/png;base64,${b64}';
  window.__dshTitle = window.__dshTitle || document.title;
  window.__dshSaved = window.__dshSaved || [];
  // sites expose several icon links (icon, apple-touch-icon, sizes variants):
  // Chrome may render any of them, so swap them all
  document.querySelectorAll('link[rel*="icon"]').forEach((l) => {
    window.__dshSaved.push({ el: l, href: l.href });
    l.type = 'image/png'; l.href = dataUrl;
  });
  if (window.__dshSaved.length === 0) {
    const l = document.createElement('link');
    l.rel = 'icon'; l.type = 'image/png'; l.href = dataUrl;
    document.head.appendChild(l);
  }
  document.title = '[DSH working] Википедия';
  return 'badge on (' + window.__dshSaved.length + ' links swapped)';
})()`;
const swapOff = `(function(){
  document.querySelectorAll('link[rel*="icon"]').forEach((l) => {
    const saved = (window.__dshSaved || []).find((s) => s.el === l);
    if (saved) l.href = saved.href;
  });
  if (window.__dshTitle) document.title = window.__dshTitle;
  return 'restored';
})()`;

console.log('swap:', run(['-Eval', swapOn, '-Target', targetId]).trim());
await new Promise((r) => setTimeout(r, 25000));
console.log('restore:', run(['-Eval', swapOff, '-Target', targetId]).trim());
run(['-Eval', "location.href = 'https://chat.deepseek.com'; 'back'", '-Target', targetId]);
console.log('navigated back');