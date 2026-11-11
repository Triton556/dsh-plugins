// Live checks for the tools that no other suite exercises: background drag,
// frame recording, OCR, wait, clipboard, window park/unpark and Chrome tabs.
// Usage: node tools/live-tools.mjs [port]
import { statSync, readdirSync, existsSync } from 'node:fs';
import { engine, cdp } from './engine.mjs';

const PORT = Number(process.argv[2] || process.env.LIVE_PORT || 9477);
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find((p) => existsSync(p));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 200)}` : ''}`);
};

console.log('live tools');
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const profile = `${process.env.TEMP}/dsh-cua-live-${Date.now()}`;
let alive = (await cdp({ List: true, Port: PORT })).ok;
if (!alive) {
  const launch = await engine({
    Action: 'launch', Path: CHROME, Park: true, Timeout: 20000,
    LaunchArgs: `--remote-debugging-port=${PORT} --user-data-dir=${profile} --no-first-run --no-default-browser-check --window-size=1200,900 about:blank`
  });
  check('silent launch', launch.ok && /parked/.test(launch.text), launch.text);
  for (let i = 0; i < 60 && !alive; i += 1) {
    alive = (await cdp({ List: true, Port: PORT })).ok;
    if (!alive) await new Promise((r) => setTimeout(r, 1000));
  }
} else {
  console.log('  ok   reusing a live debug port');
}
check('debug endpoint reachable', alive);

await cdp({ Port: PORT, Navigate: 'about:blank' });
const page = `<div id="handle" style="position:absolute;left:40px;top:40px;width:120px;height:80px;background:#3f6bff;cursor:grab"></div>
<div id="log" style="position:absolute;left:40px;top:200px;font:18px monospace"></div>
<script>
  const h = document.getElementById('handle');
  let dragging = false, startX = 0, startY = 0, originX = 40, originY = 40;
  h.addEventListener('pointerdown', (e) => { dragging = true; startX = e.clientX; startY = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const nx = originX + (e.clientX - startX), ny = originY + (e.clientY - startY);
    h.style.left = nx + 'px'; h.style.top = ny + 'px';
    document.getElementById('log').textContent = 'left=' + Math.round(nx) + ' top=' + Math.round(ny);
  });
  h.addEventListener('pointerup', () => { dragging = false; originX = parseFloat(h.style.left); originY = parseFloat(h.style.top); });
</script>`;
await cdp({ Port: PORT, Eval: `document.open();document.write(${JSON.stringify(page)});document.close();'built'` });
await new Promise((r) => setTimeout(r, 400));

const before = await cdp({ Port: PORT, Eval: "document.getElementById('handle').style.left" });
await cdp({ Port: PORT, Drag: '100,80,340,220', Steps: 12 });
await new Promise((r) => setTimeout(r, 250));
const after = await cdp({ Port: PORT, Eval: "document.getElementById('handle').style.left + '|' + document.getElementById('handle').style.top" });
const movedX = Number(String(after.text).split('|')[0].replace('px', ''));
check('background drag moved the element', Number.isFinite(movedX) && movedX > 200, `${before.text} -> ${after.text}`);

const shot = `${process.env.TEMP}/dsh-cua-live-ocr.png`;
await cdp({ Port: PORT, Shot: shot });
await new Promise((r) => setTimeout(r, 400));
check('screenshot for OCR', existsSync(shot) && statSync(shot).size > 2000);
const ocr = await engine({ Action: 'ocr', Path: shot });
check('ocr returns text', ocr.ok && String(ocr.text).trim().length > 0, ocr.text.slice(0, 120));

const pick = (await engine({ Action: 'windows' })).text;
const title = (pick.match(/about:blank - Google Chrome/) || [])[0];
check('window list contains the parked browser', !!title, pick.slice(0, 160));

const recordDir = `${process.env.TEMP}/dsh-cua-live-record-${Date.now()}`;
const record = await engine({ Action: 'record', Window: 'about:blank', Frames: 4, Interval: 120, Path: recordDir });
const frames = existsSync(recordDir) ? readdirSync(recordDir).filter((f) => f.endsWith('.png')).length : 0;
check('record writes frames', record.ok && frames === 4, `${frames} frames`);

const waitOk = await engine({ Action: 'wait', Window: 'about:blank', Timeout: 4000 });
check('wait finds an existing window', /window-ready/.test(waitOk.text), waitOk.text);
const waitMiss = await engine({ Action: 'wait', Window: 'definitely-not-a-window-42', Timeout: 1200 });
check('wait times out cleanly', /timeout/.test(waitMiss.text), waitMiss.text);

await engine({ Action: 'clipboard', Text: 'live-tools-check' });
const clip = await engine({ Action: 'clipboard' });
check('clipboard round-trip', String(clip.text).trim() === 'live-tools-check', clip.text);

const park = await engine({ Action: 'window', Window: 'about:blank', Op: 'park' });
check('park window', park.ok && /parked/.test(park.text), park.text);
const unpark = await engine({ Action: 'window', Window: 'about:blank', Op: 'unpark' });
check('unpark window', unpark.ok, unpark.text);

const tabs = await engine({ Action: 'tabs', Window: 'chrome' });
check('tabs enumerates Chrome tabs', tabs.ok && /tabs=\d+/.test(tabs.text), tabs.text.slice(0, 160));

const videoPath = `${process.env.TEMP}/dsh-cua-live-video-${Date.now()}.mp4`;
const video = await engine({ Action: 'video', Window: 'about:blank', Frames: 8, Interval: 120, Path: videoPath });
check('video records frames into an mp4', video.ok && /video:/.test(video.text) && existsSync(videoPath) && statSync(videoPath).size > 2000, video.text);
console.log(failures ? `FAIL: ${failures}` : 'PASS: live tools verified');
process.exit(failures ? 1 : 0);