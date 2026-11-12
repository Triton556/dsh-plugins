// Favicon badge demo, round 5: the Dzen tab (loaded document), blink + poke.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = new URL('./cdp.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const b64 = readFileSync('C:/Users/Danil/AppData/Local/Temp/favicon-badge.b64', 'utf8').trim();
const hwnd = Number(process.argv[process.argv.indexOf('-Hwnd') + 1] || 0);
const targetId = process.argv[process.argv.indexOf('-Target') + 1];

function run(args) {
  return execFileSync(process.execPath, [CDP, ...args], { encoding: 'utf8', timeout: 30000 });
}
const statePath = join(tmpdir(), 'dsh-cua-overlay-state.json');
function pushState(label, ttlMs = 15000) {
  const payload = {
    updated: Date.now(), ttlMs, screen: false,
    target: { hwnd, rect: [-8, -8, 1928, 1040] },
    cursor: { x: 700, y: 420 }, label: label.slice(0, 48), mode: 'window'
  };
  writeFileSync(statePath, JSON.stringify(payload), 'utf8');
}

// 1. wait for the document to be usable
for (let n = 0; n < 25; n += 1) {
  const s = run(['-Eval', 'document.readyState + "|" + location.href.slice(0, 40)', '-Target', targetId]).trim();
  if (s.startsWith('complete')) break;
  await new Promise((r) => setTimeout(r, 1500));
}
console.log('document ready');

const swapOn = `(function(){
  const dataUrl = 'data:image/png;base64,${b64}';
  window.__dshFav = window.__dshFav || null;
  window.__dshTitle = window.__dshTitle || document.title;
  let link = document.querySelector('link[rel*="icon"]');
  if (link && !window.__dshFav) window.__dshFav = link.href;
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.type = 'image/png'; link.href = dataUrl;
  document.title = '[DSH working] ' + window.__dshTitle.slice(0, 20);
  return 'badge on: ' + window.__dshTitle.slice(0, 24);
})()`;
const swapOff = `(function(){
  let link = document.querySelector('link[rel*="icon"]');
  if (link && window.__dshFav) link.href = window.__dshFav;
  if (window.__dshTitle) document.title = window.__dshTitle;
  return 'restored';
})()`;
const blinkOn = `(function(){ let l = document.querySelector('link[rel*="icon"]'); if (l) l.href = 'data:image/png;base64,${b64}'; return 'on'; })()`;
const blinkOff = `(function(){ let l = document.querySelector('link[rel*="icon"]'); if (l && window.__dshFav) l.href = window.__dshFav; return 'off'; })()`;
const poke = (text) => `(function(){
  const t = document.querySelector('#header-search input, input[name="q"], input#text, input[type="text"]');
  if (!t) return 'no input yet';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(t, ${JSON.stringify(text)});
  t.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed: ' + t.value.slice(0, 30);
})()`;

console.log('swap:', run(['-Eval', swapOn, '-Target', targetId]).trim());
pushState('tab: dzen.ru - badge demo');

const start = Date.now();
let step = 0;
let blink = false;
while (Date.now() - start < 60000) {
  step += 1;
  blink = !blink;
  run(['-Eval', blink ? blinkOn : blinkOff, '-Target', targetId]);
  const res = run(['-Eval', poke(`дзен тест агента DSH ${step}`), '-Target', targetId]).trim();
  pushState(`tab: dzen.ru - typing query ${step}`);
  console.log(`step ${step}: ${blink ? 'badge' : 'orig '} | ${res}`);
  await new Promise((r) => setTimeout(r, 2500));
}
console.log('restore:', run(['-Eval', swapOff, '-Target', targetId]).trim());
pushState('tab: dzen.ru - done', 6000);
await new Promise((r) => setTimeout(r, 4000));
console.log('demo finished');