// Profile the DSH web GUI over CDP: open a session, then step the viewport width
// while tracing. A viewport step re-lays out the whole app exactly like a panel
// resize does, so the numbers describe the same work the divider triggers.
//
// Usage: node tools/gui-profile.mjs <port> [sessionTitleSubstring] [seconds]
const port = Number(process.argv[2] || 9507);
const sessionTitle = process.argv[3] || '';
const windowSec = Number(process.argv[4] || 3);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'));
if (!page) { console.error('no GUI page target'); process.exit(2); }

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let serial = 0;
const events = [];
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Tracing.dataCollected' && Array.isArray(msg.params?.value)) events.push(...msg.params.value);
  if (msg.method === 'Tracing.tracingComplete') completed = true;
  if (!msg.id || !pending.has(msg.id)) return;
  const { res, rej } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) rej(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data || '')}`)); else res(msg.result);
});
let completed = false;
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
  const rect = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('a,button,div[role="button"],li,span')];
    const hit = nodes.find((n) => (n.textContent || '').trim().startsWith(${JSON.stringify(text)}) && n.getBoundingClientRect().width > 0);
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
  })()`);
  if (!rect) return false;
  const [x, y] = String(rect).split(',').map(Number);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  return true;
};

const metrics = await send('Page.getLayoutMetrics').catch(() => null);
const baseWidth = Math.round(metrics?.cssLayoutViewport?.clientWidth || 1600);
const baseHeight = Math.round(metrics?.cssLayoutViewport?.clientHeight || 900);
console.log(`viewport ${baseWidth}x${baseHeight}, url ${page.url.split('?')[0]}`);

if (sessionTitle) {
  const opened = await clickText(sessionTitle);
  console.log(opened ? `opened session "${sessionTitle}"` : `session "${sessionTitle}" not found (profiling the current view)`);
  await new Promise((r) => setTimeout(r, 2500));
}

const nodeCount = await evaluate('document.querySelectorAll("*").length');
console.log('DOM nodes:', nodeCount);

await send('Tracing.start', {
  categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,latencyInfo,viz',
  transferMode: 'ReportEvents'
});
const steps = Math.max(10, Math.round((windowSec * 1000) / 16));
for (let i = 0; i < steps; i += 1) {
  const delta = Math.round(120 * Math.sin((i / steps) * Math.PI * 2));
  await send('Emulation.setDeviceMetricsOverride', { width: baseWidth - delta, height: baseHeight, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 16));
}
await send('Emulation.clearDeviceMetricsOverride');
await send('Tracing.end');
for (let i = 0; i < 100 && !completed; i += 1) await new Promise((r) => setTimeout(r, 100));

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