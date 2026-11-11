// Drag the GUI's own divider over CDP and trace the work it causes.
// Assumes the right panel is already open.
// Usage: node tools/divider-drag-trace.mjs <port> [deltaPx] [steps]
const port = Number(process.argv[2] || 9513);
const delta = Number(process.argv[3] || -160);
const steps = Number(process.argv[4] || 16);

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

const handleRaw = await evaluate(`(() => {
  const h = document.querySelector('[data-side="rightbar"]');
  if (!h) return null;
  const r = h.getBoundingClientRect();
  if (!r.width) return null;
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 240)) });
})()`);
if (!handleRaw) { console.error('no divider handle'); process.exit(3); }
const handle = JSON.parse(String(handleRaw));
const panelWidth = () => evaluate(`(() => { const p = document.querySelector('[data-sidebar-right-panel="push"][data-sidebar-right-open]'); return p ? Math.round(p.getBoundingClientRect().width) : null; })()`);
const before = await panelWidth();
const nodes = await evaluate('document.querySelectorAll("*").length');
console.log(`handle ${handle.x},${handle.y} | panel ${before} | DOM ${nodes}`);

await send('Tracing.start', {
  categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,latencyInfo,viz',
  transferMode: 'ReportEvents'
});

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y, button: 'none', buttons: 0 });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1, buttons: 1 });
for (let i = 1; i <= steps; i += 1) {
  const x = Math.round(handle.x + (delta * i) / steps);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: handle.y, button: 'left', buttons: 1 });
  await new Promise((r) => setTimeout(r, 20));
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + delta, y: handle.y, button: 'left', clickCount: 1, buttons: 0 });
await new Promise((r) => setTimeout(r, 700));

await send('Tracing.end');
for (let i = 0; i < 100 && !completed; i += 1) await new Promise((r) => setTimeout(r, 100));

const after = await panelWidth();
console.log(`panel width ${before} -> ${after} (delta ${delta})`);

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
    : name === 'FunctionCall' || name === 'TimerFire' || name === 'RunTask' || name === 'EventDispatch' || name === 'FireIdleCallback' ? 'script'
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