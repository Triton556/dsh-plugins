// Round 8: navigate the demo tab to Wikipedia, read its favicon URL, then the
// orchestrator composites the badge onto it outside the browser and applies it.
import { execFileSync, writeFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CDP = new URL('./cdp.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const targetId = process.argv[process.argv.indexOf('-Target') + 1];

function run(args) {
  return execFileSync(process.execPath, [CDP, ...args], { encoding: 'utf8', timeout: 30000 });
}

// 1. navigate to Wikipedia
run(['-Eval', "location.href = 'https://ru.wikipedia.org'; 'navigating'", '-Target', targetId]);
for (let n = 0; n < 20; n += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = run(['-Eval', 'location.href + "|" + document.readyState', '-Target', targetId]).trim();
  if (s.includes('wikipedia.org') && s.includes('complete')) break;
}
console.log('loaded:', run(['-Eval', 'location.href.slice(0,50)', '-Target', targetId]).trim());

// 2. the favicon URL (absolute)
const iconHref = run(['-Eval', `(function(){ const l = document.querySelector('link[rel*="icon"]'); return l ? l.href : ''; })()`, '-Target', targetId]).trim();
console.log('icon href:', iconHref);
writeFileSync('C:/Users/Danil/AppData/Local/Temp/wiki-icon-url.txt', iconHref, 'utf8');

// 3. swap with the composited badge (the orchestrator writes the b64 file first)
const b64 = readFileSync('C:/Users/Danil/AppData/Local/Temp/wiki-badge.b64', 'utf8').trim();
const swapOn = `(function(){
  const dataUrl = 'data:image/png;base64,${b64}';
  window.__dshTitle = window.__dshTitle || document.title;
  let link = document.querySelector('link[rel*="icon"]');
  if (link) { window.__dshOld = link.href; link.href = dataUrl; }
  else {
    link = document.createElement('link');
    link.rel = 'icon'; link.type = 'image/png'; link.href = dataUrl;
    document.head.appendChild(link);
  }
  document.title = '[DSH working] Википедия';
  return 'badge on';
})()`;
const swapOff = `(function(){
  let link = document.querySelector('link[rel*="icon"]');
  if (window.__dshOld) link.href = window.__dshOld; else if (link) link.remove();
  if (window.__dshTitle) document.title = window.__dshTitle;
  return 'restored';
})()`;

console.log('swap:', run(['-Eval', swapOn, '-Target', targetId]).trim());

// 4. hold the composited badge for 25 s (the screenshot lands inside)
await new Promise((r) => setTimeout(r, 25000));

console.log('restore:', run(['-Eval', swapOff, '-Target', targetId]).trim());
run(['-Eval', "location.href = 'https://chat.deepseek.com'; 'back'", '-Target', targetId]);
console.log('navigated back');