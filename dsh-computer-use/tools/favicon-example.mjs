// Round 7: navigate the EXISTING demo tab to example.com, badge it, restore.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CDP = new URL('./cdp.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const b64 = readFileSync('C:/Users/Danil/AppData/Local/Temp/favicon-badge.b64', 'utf8').trim();
const targetId = process.argv[process.argv.indexOf('-Target') + 1];

function run(args) {
  return execFileSync(process.execPath, [CDP, ...args], { encoding: 'utf8', timeout: 30000 });
}

// 1. navigate the existing tab
run(['-Eval', "location.href = 'https://example.com'; 'navigating'", '-Target', targetId]);
for (let n = 0; n < 15; n += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = run(['-Eval', 'location.href + "|" + document.readyState', '-Target', targetId]).trim();
  if (s.includes('example.com') && s.includes('complete')) break;
}
console.log('loaded:', run(['-Eval', 'location.href', '-Target', targetId]).trim());

// 2. badge favicon
const swapOn = `(function(){
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image width="64" height="64" href="data:image/png;base64,${b64}"/></svg>');
  window.__dshTitle = window.__dshTitle || document.title;
  let link = document.querySelector('link[rel*="icon"]');
  if (link) { window.__dshOld = link.href; link.href = dataUrl; }
  else {
    link = document.createElement('link');
    link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = dataUrl;
    document.head.appendChild(link);
  }
  document.title = '[DSH working] Example Domain';
  return 'badge on (old icon: ' + (window.__dshOld || 'none') + ')';
})()`;
const swapOff = `(function(){
  let link = document.querySelector('link[rel*="icon"]');
  if (window.__dshOld) link.href = window.__dshOld; else if (link) link.remove();
  if (window.__dshTitle) document.title = window.__dshTitle;
  return 'restored';
})()`;

console.log('swap:', run(['-Eval', swapOn, '-Target', targetId]).trim());

// 3. hold the badge for 30 s (two PrintWindow shots land inside)
await new Promise((r) => setTimeout(r, 30000));

console.log('restore:', run(['-Eval', swapOff, '-Target', targetId]).trim());

// 4. navigate back to the DeepSeek page
run(['-Eval', "location.href = 'https://chat.deepseek.com'; 'back'", '-Target', targetId]);
await new Promise((r) => setTimeout(r, 4000));
console.log('tab navigated back');