// Readability test: flat brand-blue circle vs the Dzen star - are favicon swaps
// even rendering? Two phases, no whale detail, so the difference is obvious.
import { execFileSync } from 'node:child_process';

const CDP = new URL('./cdp.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const targetId = process.argv[process.argv.indexOf('-Target') + 1];

function run(args) {
  return execFileSync(process.execPath, [CDP, ...args], { encoding: 'utf8', timeout: 30000 });
}

function circleUrl(n) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="26" fill="#4D6BFE" stroke="#FFFFFF" stroke-width="6"/><!--${n}--></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const swapOn = `(function(){
  window.__dshSaved = window.__dshSaved || [];
  window.__dshTitle = window.__dshTitle || document.title;
  window.__dshN = (window.__dshN || 0) + 1;
  const url = ${JSON.stringify(circleUrl(0))}.replace('<!--0-->', '<!--' + window.__dshN + '-->');
  document.querySelectorAll('link[rel*="icon"]').forEach((l) => { window.__dshSaved.push({ el: l, href: l.href }); });
  window.__dshManifest = document.querySelector('link[rel="manifest"]');
  if (window.__dshManifest) window.__dshManifest.remove();
  document.querySelectorAll('link[rel*="icon"]').forEach((l) => { l.type = 'image/svg+xml'; l.href = url; });
  if (window.__dshSaved.length === 0) {
    const l = document.createElement('link'); l.rel = 'icon'; l.type = 'image/svg+xml'; l.href = url;
    document.head.appendChild(l);
  }
  document.title = '[DSH working] ' + window.__dshTitle.slice(0, 20);
  return 'badge on, unique url #' + window.__dshN;
})()`;
const swapOff = `(function(){
  document.querySelectorAll('link[rel*="icon"]').forEach((l) => {
    const saved = (window.__dshSaved || []).find((s) => s.el === l);
    if (saved) l.href = saved.href;
  });
  if (window.__dshManifest && window.__dshManifest.parentElement) window.__dshManifest.parentElement.appendChild(window.__dshManifest);
  if (window.__dshTitle) document.title = window.__dshTitle;
  return 'restored';
})()`;

console.log('phase 1: badge on');
console.log('  ', run(['-Eval', swapOn, '-Target', targetId]).trim());
await new Promise((r) => setTimeout(r, 10000));
console.log('phase 2: restore');
console.log('  ', run(['-Eval', swapOff, '-Target', targetId]).trim());
await new Promise((r) => setTimeout(r, 4000));
console.log('proof script done');