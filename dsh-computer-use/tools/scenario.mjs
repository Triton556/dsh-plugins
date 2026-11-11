// End-to-end scenario through the TOOL layer (same argument mapping the host
// uses): launch a real Chrome with a debug port, drive it in the background,
// capture, trace, park it, then close. Proves tool -> engine -> CDP in one run.
// Usage: node tools/scenario.mjs
import { statSync } from 'node:fs';
import { TOOLS } from '../index.js';
import { engine, cdp } from './engine.mjs';

const byName = new Map(TOOLS.map((t) => [t.name, t]));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 200)}` : ''}`);
};

// Mirrors the host execute() body.
async function call(name, args) {
  const spec = byName.get(name);
  if (!spec) throw new Error(`no such tool: ${name}`);
  const spec_ = spec.run(args);
  if (spec_.cdp) {
    const c = spec_.cdp;
    return cdp({
      port: c.port,
      ...(c.action === 'list' ? { List: true } : {}),
      ...(c.action === 'eval' ? { Eval: c.expression } : {}),
      ...(c.action === 'dom' ? { Dom: true } : {}),
      ...(c.action === 'shot' ? { Shot: c.path } : {}),
      ...(c.action === 'perf' ? { Perf: c.duration || 3000 } : {}),
      ...(c.action === 'trace' ? { Trace: c.path, Perf: c.duration || 3000 } : {}),
      ...(c.action === 'navigate' ? { Navigate: c.url } : {}),
      ...(c.action === 'click' ? { Click: `${c.x},${c.y}` } : {}),
      ...(c.action === 'drag' ? { Drag: `${c.x},${c.y},${c.x2},${c.y2}` } : {}),
      ...(c.action === 'type' ? { Type: c.text } : {}),
      ...(c.action === 'key' ? { Key: c.keys } : {}),
      ...(c.action === 'scroll' ? { Scroll: `${c.x},${c.y}`, Delta: c.delta || -300 } : {}),
      ...(c.target ? { Target: c.target } : {})
    });
  }
  const engineArgs = {};
  for (const [key, value] of Object.entries(spec_)) {
    if (key === 'action') { engineArgs.Action = value; continue; }
    engineArgs[key.charAt(0).toUpperCase() + key.slice(1)] = value;
  }
  return engine(engineArgs);
}

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find((p) => { try { statSync(p); return true; } catch { return false; } });

if (!CHROME) { console.error('chrome not found'); process.exit(2); }
const PORT = Number(process.env.SCENARIO_PORT || 9471);
const profile = `${process.env.TEMP}/dsh-cua-scenario-${Date.now()}`;

console.log('scenario');
const preexisting = await call('computer_cdp', { port: PORT, action: 'list' });
let launch = { ok: true, text: 'reused an existing debug target' };
if (!preexisting.ok) {
  launch = await call('computer_launch', {
    path: CHROME,
    args: `--remote-debugging-port=${PORT} --user-data-dir=${profile} --no-first-run --no-default-browser-check --window-size=1200,900 about:blank`,
    timeout: 15000,
    park: true
  });
  check('launch browser silently (off-screen)', launch.ok && /parked off-screen/.test(launch.text), launch.text);
} else {
  console.log('  ok   reusing an already listening debug port');
}

await new Promise((r) => setTimeout(r, 800));
// A fresh profile takes a while to expose the debug endpoint (cold start on a
// busy machine can exceed 20 s), so poll generously instead of assuming a delay.
let list = preexisting;
for (let attempt = 0; attempt < 60; attempt += 1) {
  list = await call('computer_cdp', { port: PORT, action: 'list' });
  if (list.ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('list targets', list.ok && list.text.includes('"id"'), list.text);

const nav = await call('computer_cdp', { port: PORT, action: 'navigate', url: 'about:blank' });
check('navigate', nav.ok, nav.text);

const page = `<html><head><title>scenario</title></head><body style="margin:0;background:#101418;color:#e6e9f0;font:18px sans-serif">
<div style="padding:24px">scenario</div>
<button id="b" style="margin:24px;padding:16px 32px;font:18px sans-serif">press</button>
<input id="i" style="margin:24px;padding:10px;font:16px monospace">
<div id="out" style="padding:24px;font:16px monospace"></div>
<script>window.n=0;document.getElementById('b').onclick=function(){window.n++;document.getElementById('out').textContent='n='+window.n+' v='+document.getElementById('i').value};</script></body></html>`;
const build = await call('computer_cdp', {
  port: PORT,
  action: 'eval',
  expression: `document.open(); document.write(${JSON.stringify(page)}); document.close(); document.getElementById('b') ? 'built' : 'missing'`
});
check('build page through eval', build.ok && build.text.includes('built'), build.text);
await new Promise((r) => setTimeout(r, 400)); // let the new document settle before input

const rect = await call('computer_cdp', {
  port: PORT,
  action: 'eval',
  expression: `JSON.stringify((function(){var r=document.getElementById('b').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})())`
});
let x = NaN, y = NaN;
try { const p = JSON.parse(String(rect.text).trim()); x = Number(p.x); y = Number(p.y); } catch { /* keep NaN */ }
check('read button rectangle', rect.ok && Number.isFinite(x) && Number.isFinite(y), rect.text);
const click = await call('computer_cdp', { port: PORT, action: 'click', x, y });
check('background click', click.ok, click.text);

const focus = await call('computer_cdp', { port: PORT, action: 'eval', expression: "document.getElementById('i').focus(); 'focused'" });
check('focus field', focus.ok, focus.text);
const typed = await call('computer_cdp', { port: PORT, action: 'type', text: 'scenario-text' });
check('background type', typed.ok, typed.text);
await call('computer_cdp', { port: PORT, action: 'click', x, y });

const state = await call('computer_cdp', { port: PORT, action: 'eval', expression: "window.n + '|' + document.getElementById('i').value + '|' + document.getElementById('out').textContent" });
check('page reacted to background input', /2\|scenario-text\|n=2 v=scenario-text/.test(state.text), state.text);

const shotPath = `${process.env.TEMP}/dsh-cua-scenario.png`;
const shot = await call('computer_cdp', { port: PORT, action: 'shot', path: shotPath });
check('tab screenshot', shot.ok, shot.text);

const tracePath = `${process.env.TEMP}/dsh-cua-scenario-trace.json`;
const trace = await call('computer_cdp', { port: PORT, action: 'trace', path: tracePath, duration: 1200 });
check('trace file', trace.ok && trace.text.includes('events'), trace.text.slice(0, 160));

const park = await call('computer_window', { window: 'scenario', op: 'park' });
check('park browser out of the way', park.ok && /parked/.test(park.text), park.text);
await call('computer_window', { window: 'scenario', op: 'unpark' });

await call('computer_cdp', { port: PORT, action: 'eval', expression: 'window.close()' });
console.log(failures ? `FAIL: ${failures}` : 'PASS: tool layer driven end to end');
process.exit(failures ? 1 : 0);