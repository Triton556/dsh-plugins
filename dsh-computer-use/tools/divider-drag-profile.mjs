// Profile a real divider drag in the web GUI over CDP: open a session, ask the
// artifact plugin to open a tab (so the right panel and its handle exist), then
// drag the handle with Input events while tracing.
//
// Usage: node tools/divider-drag-profile.mjs <port> <sessionTitle> <artifactPath> [seconds]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const port = Number(process.argv[2] || 9511);
const sessionTitle = process.argv[3] || 'Session';
const artifactPath = process.argv[4] || 'artifacts/plan.html';
const settleMs = Number(process.argv[5] || 3) * 1000;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'));
if (!page) { console.error('no GUI page target'); process.exit(2); }

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const events = [];
let serial = 0;
let completed = false;
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Tracing.dataCollected' && Array.isArray(msg.params?.value)) events.push(...msg.params.value);
  if (msg.method === 'Tracing.tracingComplete') completed = true;
  if (!msg.id || !pending.has(msg.id)) return;
  const { res, rej } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++serial;
  pending.set(id, { res, rej });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  return r?.result?.value;
};

const clickText = async (text) => {
  const point = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('a,button,div[role="button"],li,span')];
    const hit = nodes.find((n) => (n.textContent || '').trim().startsWith(${JSON.stringify(text)}) && n.getBoundingClientRect().width > 0);
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
  })()`);
  if (!point) return false;
  const [x, y] = String(point).split(',').map(Number);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  return true;
};

console.log('opening session:', sessionTitle);
console.log('session clicked:', await clickText(sessionTitle));
await new Promise((r) => setTimeout(r, 2500));

// Ask the artifact plugin to open a tab; its client polls this file.
const requestFile = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/.dsh/artifact-panes/open-request.json';
mkdirSync(dirname(requestFile), { recursive: true });
writeFileSync(requestFile, JSON.stringify({ n: Date.now(), path: artifactPath }), 'utf8');
console.log('open-request written for', artifactPath);

let handle = null;
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  handle = await evaluate(`(() => {
    const h = document.querySelector('[data-side="rightbar"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    if (!r.width) return null;
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 240)), w: Math.round(r.width) });
  })()`);
  if (handle) break;
}
if (!handle) { console.error('divider handle never appeared'); process.exit(3); }
const start = JSON.parse(String(handle));
console.log('divider handle at', start);

const panelBefore = await evaluate(`(() => { const p = document.querySelector('[data-sidebar-right-panel="push"][data-sidebar-right-open]'); return p ? Math.round(p.getBoundingClientRect().width) : null; })()`);
const nodes = await evaluate('document.querySelectorAll("*").length');
console.log('panel width before:', panelBefore, '| DOM nodes:', nodes);

await send('Tracing.start', {
  categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,latencyInfo,viz',
  transferMode: 'ReportEvents'
});

const dragTo = start.x - 160;
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0 });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, buttons: 1 });
const steps = 16;
for (let i = 1; i <= steps; i += 1) {
  const x = Math.round(start.x + ((dragTo - start.x) * i) / steps);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: start.y, button: 'left', buttons: 1 });
  await new Promise((r) => setTimeout(r, 20));
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragTo, y: start.y, button: 'left', clickCount: 1, buttons: 0 });
await new Promise((r) => setTimeout(r, settleMs));

await send('Tracing.end');
for (let i = 0; i < 100 && !completed; i += 1) await new Promise((r) => setTimeout(r, 100));

const panelAfter = await evaluate(`(() => { const p = document.querySelector('[data-sidebar-right-panel="push"][data-sidebar-right-open]'); return p ? Math.round(p.getBoundingClientRect().width) : null; })()`);
console.log('panel width after :', panelAfter);

const frameStarts = events.filter((e) => e.name === 'FireAnimationFrame' && e.ts !== undefined)
  .map((e) => Number(e.ts) / 1000).sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < frameStarts.length; i += 1) gaps.push(Math.round(frameStarts[i] - frameStarts[i - 1]));
const sorted = [...gaps].sort((a, b) => a - b);
const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const byPhase = new Map();
for (const e of events) {
  if (!e.dur) continue;
  const name = String(e.name);
  const phase = name === 'Layout' || name === 'UpdateLayoutTree' ? 'style/layout'
    : name === 'Paint' || name === 'PrePaint' || name === 'RasterTask' ? 'paint'
    : name === 'FireAnimationFrame' ? 'frames'
    : name === 'FunctionCall' || name === 'TimerFire' || name === 'RunTask' || name === 'EventDispatch' ? 'script'
    : name === 'Commit' || name === 'CompositeLayers' ? 'composite'
    : 'other';
  byPhase.set(phase, (byPhase.get(phase) || 0) + e.dur / 1000);
}
console.log(JSON.stringify({
  frames: frameStarts.length,
  frameP50: pct(0.5),
  frameP95: pct(0.95),
  frameMax: sorted[sorted.length - 1] || 0,
  framesOver50: gaps.filter((g) => g > 50).length,
  phases: Object.fromEntries([...byPhase.entries()].map(([k, v]) => [k, Math.round(v)])),
  events: events.length
}, null, 2));
socket.close();