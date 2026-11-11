// Verify CDP background click: build a page, compute the button centre, click.
// Usage: node tools/click-probe.mjs <port>
const port = Number(process.argv[2] || 9491);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let serial = 0;
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { res, rej } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) rej(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data || '')}`));
  else res(msg.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const send = (method, params) => new Promise((res, rej) => {
  const id = ++serial;
  pending.set(id, { res, rej });
  socket.send(JSON.stringify({ id, method, params }));
});

const pageHtml = '<button id=b style="margin:60px;padding:40px 80px;font:22px sans-serif">press</button><div id=out style="margin:20px;font:18px monospace"></div>';
await send('Runtime.evaluate', {
  expression: `document.open();document.write(${JSON.stringify(pageHtml)});document.close();window.n=0;document.getElementById('b').onclick=function(){window.n++;document.getElementById('out').textContent='n='+window.n};`,
  returnByValue: true
});
await new Promise((r) => setTimeout(r, 400));

const metrics = await send('Runtime.evaluate', {
  expression: "(function(){var r=document.getElementById('b').getBoundingClientRect();return Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2);})()",
  returnByValue: true
});
const [x, y] = String(metrics.result.value).split(',').map(Number);
console.log('button centre:', x, y);

for (const [label, calls] of [
  ['minimal', [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]],
  ['with-buttons', [['mouseMoved', { button: 'none', buttons: 0 }], ['mousePressed', { button: 'left', clickCount: 1, buttons: 1 }], ['mouseReleased', { button: 'left', clickCount: 1, buttons: 0 }]]]
]) {
  await send('Runtime.evaluate', { expression: 'window.n = 0', returnByValue: true });
  let error = null;
  for (const [type, extra] of calls) {
    try { await send('Input.dispatchMouseEvent', { type, x, y, ...extra }); }
    catch (e) { error = `${type}: ${e.message}`; break; }
  }
  const after = await send('Runtime.evaluate', { expression: 'window.n', returnByValue: true });
  console.log(`${label.padEnd(14)} clicks=${after.result.value}${error ? ' ERROR ' + error : ''}`);
}
socket.close();