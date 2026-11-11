// Minimal Chrome DevTools Protocol client over the built-in WebSocket.
//   node cdp.mjs -List -Port 9222
//   node cdp.mjs -Eval "document.title" -Port 9222 [-Target <id|url substring>]
//   node cdp.mjs -Shot out.png -Port 9222 [-Target ...]
//   node cdp.mjs -Dom -Port 9222 [-Target ...]        (outerHTML of <body>)
//   node cdp.mjs -Perf 3000 -Port 9222                (frame timing summary)
// Targets: Chromium/Electron started with --remote-debugging-port=<Port>.
const options = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('-')) continue;
  const name = key.slice(1);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('-')) { options[name] = next; i += 1; } else options[name] = true;
}

const port = Number(options.Port || 9222);
const timeoutMs = Number(options.Timeout || 15000);

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
  return res.json();
}

function pick(list, needle) {
  const pages = list.filter((t) => t.type === 'page' || t.type === 'webview');
  if (!needle) return pages[0];
  return pages.find((t) => t.id === needle)
    || pages.find((t) => String(t.url || '').includes(needle))
    || pages.find((t) => String(t.title || '').includes(needle))
    || null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let serial = 0;
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new Error('CDP connect timeout')); }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++serial;
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { socket.close(); } catch {} },
        onEvent(handler) { socket.addEventListener('message', (event) => { try { const msg = JSON.parse(event.data); if (msg.method) handler(msg); } catch {} }); },
        raw: socket,
        drain() { for (const { rej } of pending.values()) rej(new Error('closed')); pending.clear(); }
      });
      socket.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg.id || !pending.has(msg.id)) return;
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
        else res(msg.result);
      });
      socket.addEventListener('close', () => { for (const { rej } of pending.values()) rej(new Error('CDP socket closed')); pending.clear(); });
    }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP socket error on ${url}`)); }, { once: true });
  });
}

(async () => {
  try {
    const list = await targets();
    if (options.List) {
      console.log(JSON.stringify(list.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })), null, 2));
      return;
    }
    const target = pick(list, options.Target);
    if (!target) { console.error('no matching target'); process.exit(2); }
    const client = await connect(target.webSocketDebuggerUrl);

    if (options.Eval) {
      const result = await client.send('Runtime.evaluate', {
        expression: String(options.Eval),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      });
      const value = result?.result?.value;
      console.log(typeof value === 'string' ? value : JSON.stringify(result?.result ?? result, null, 2));
    } else if (options.Dom) {
      const result = await client.send('Runtime.evaluate', { expression: 'document.body ? document.body.outerHTML : ""', returnByValue: true });
      console.log(String(result?.result?.value || '').slice(0, 200000));
    } else if (options.Drag) {
      // Background drag: press, glide through intermediate points, release - all
      // inside the renderer, so a slider or a draggable card moves without the
      // window ever being focused.
      const [x1, y1, x2, y2] = String(options.Drag).split(',').map(Number);
      if (![x1, y1, x2, y2].every(Number.isFinite)) {
        console.error(`drag needs four numeric coordinates, got ${options.Drag}`);
        process.exit(2);
      }
      const steps = Number(options.Steps || 12);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0 });
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 });
      for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(x1 + ((x2 - x1) * i) / steps);
        const y = Math.round(y1 + ((y2 - y1) * i) / steps);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await new Promise((r) => setTimeout(r, 12));
      }
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0 });
      console.log(`dragged ${x1},${y1} -> ${x2},${y2} (background)`);
    } else if (options.Click) {
      // Background input: dispatched into the renderer, no window activation,
      // no cursor movement, no focus steal.
      const [cx, cy] = String(options.Click).split(',').map(Number);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        console.error(`click needs numeric coordinates, got ${options.Click}`);
        process.exit(2);
      }
      const base = { x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 };
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
      console.log(`clicked ${cx},${cy} (background)`);
    } else if (options.Type) {
      await client.send('Input.insertText', { text: String(options.Type) });
      console.log(`typed ${String(options.Type).length} chars (background)`);
    } else if (options.Key) {
      const map = { CTRL: 2, ALT: 1, SHIFT: 8, META: 4 };
      const parts = String(options.Key).split('+');
      const key = parts.pop();
      let modifiers = 0;
      for (const part of parts) modifiers |= map[part.toUpperCase()] || 0;
      const code = key.length === 1 ? key.toUpperCase() : key;
      const vk = code.length === 1 ? code.charCodeAt(0) : ({
        ENTER: 13, TAB: 9, ESC: 27, ESCAPE: 27, SPACE: 32, BACKSPACE: 8, DELETE: 46,
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, HOME: 36, END: 35
      }[code] || 0);
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      console.log(`key ${options.Key} (background)`);
    } else if (options.Scroll) {
      const [sx, sy] = String(options.Scroll).split(',').map(Number);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
        console.error(`scroll needs numeric coordinates, got ${options.Scroll}`);
        process.exit(2);
      }
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: sx, y: sy, deltaX: 0, deltaY: Number(options.Delta || -300) });
      console.log(`scrolled ${options.Delta || -300} at ${sx},${sy} (background)`);
    } else if (options.Navigate) {
      await client.send('Page.enable').catch(() => {});
      await client.send('Page.bringToFront').catch(() => {});
      const loaded = new Promise((resolve) => {
        client.onEvent((msg) => { if (msg.method === 'Page.loadEventFired') resolve(); });
        setTimeout(resolve, Number(options.Timeout || 8000));
      });
      await client.send('Page.navigate', { url: String(options.Navigate) });
      await loaded;
      const title = await client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      console.log(`navigated: ${title?.result?.value || '(no title)'}`);
    } else if (options.Shot) {
      await client.send('Page.enable').catch(() => {});
      await client.send('Page.bringToFront').catch(() => {});
      const metrics = await client.send('Page.getLayoutMetrics');
      const width = Math.ceil(metrics.cssContentSize?.width || metrics.contentSize?.width || 0);
      const height = Math.ceil(metrics.cssContentSize?.height || metrics.contentSize?.height || 0);
      const params = { format: 'png', captureBeyondViewport: false };
      if (Number(options.Clip)) params.clip = { x: 0, y: 0, width: Math.min(width, Number(options.Clip)), height: Math.min(height, Number(options.Clip)), scale: 1 };
      const shot = await client.send('Page.captureScreenshot', params);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(String(options.Shot), Buffer.from(shot.data, 'base64'));
      console.log(`${options.Shot} (${width}x${height})`);
    } else if (options.Trace) {
      const { writeFileSync } = await import('node:fs');
      const windowMs = Number(options.Perf || 3000);
      const events = [];
      client.onEvent((msg) => {
        if (msg.method === 'Tracing.dataCollected' && Array.isArray(msg.params?.value)) events.push(...msg.params.value);
      });
      const done = new Promise((resolve) => client.onEvent((msg) => { if (msg.method === 'Tracing.tracingComplete') resolve(); }));
      await client.send('Tracing.start', {
        categories: options.Categories || 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,latencyInfo,viz',
        transferMode: 'ReportEvents',
        options: 'sampling-frequency=10000'
      });
      await new Promise((r) => setTimeout(r, windowMs));
      await client.send('Tracing.end');
      await done;
      writeFileSync(String(options.Trace), JSON.stringify({ traceEvents: events }));
      // Frame pacing is the gap between consecutive animation frames, not the
      // duration attached to each event (which is usually zero).
      const frameStarts = events.filter((e) => e.name === 'FireAnimationFrame' && e.ts !== undefined)
        .map((e) => Number(e.ts) / 1000).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < frameStarts.length; i += 1) gaps.push(Math.round(frameStarts[i] - frameStarts[i - 1]));
      const frames = { length: frameStarts.length };
      const sorted = [...gaps].sort((a, b) => a - b);
      const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
      // Breakdown by event name and by phase, so a report answers "where did the
      // frame time go" instead of only "how many frames".
      const byName = new Map();
      const byPhase = new Map();
      const longTasks = [];
      let totalMs = 0;
      for (const e of events) {
        if (!e.dur) continue;
        const ms = e.dur / 1000;
        const name = String(e.name || '?');
        totalMs += ms;
        byName.set(name, (byName.get(name) || 0) + ms);
        const phase = name === 'Layout' || name === 'UpdateLayoutTree' ? 'style/layout'
          : name === 'Paint' || name === 'PrePaint' || name === 'RasterTask' ? 'paint'
          : name === 'FireAnimationFrame' || name === 'FireIdleCallback' ? 'frames'
          : name === 'FunctionCall' || name === 'TimerFire' || name === 'RunTask' ? 'script'
          : name === 'Commit' || name === 'CompositeLayers' ? 'composite'
          : 'other';
        byPhase.set(phase, (byPhase.get(phase) || 0) + ms);
        if (ms >= 50) longTasks.push({ name, ms: Math.round(ms), start: Math.round((e.ts || 0) / 1000) });
      }
      const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([name, dur]) => ({ name, ms: Math.round(dur) }));
      const phases = Object.fromEntries([...byPhase.entries()].map(([k, v]) => [k, Math.round(v)]));
      longTasks.sort((a, b) => b.ms - a.ms);
      console.log(JSON.stringify({
        file: options.Trace,
        events: events.length,
        windowMs,
        frames: frames.length,
        frameP50: pct(0.5), frameP95: pct(0.95), frameMax: sorted[sorted.length - 1] || 0,
        totalEventMs: Math.round(totalMs),
        phases,
        topBySelfTime: top,
        longestTasks: longTasks.slice(0, 8)
      }, null, 2));
    } else if (options.Perf) {
      const windowMs = Number(options.Perf);
      const frames = [];
      client.onEvent((msg) => {
        if (msg.method === 'Tracing.dataCollected' && Array.isArray(msg.params?.value)) frames.push(...msg.params.value);
      });
      await client.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' });
      await new Promise((r) => setTimeout(r, windowMs));
      const done = new Promise((resolve) => client.onEvent((msg) => { if (msg.method === 'Tracing.tracingComplete') resolve(); }));
      await client.send('Tracing.end');
      await done;
      const durs = frames.filter((e) => e.name === 'FireAnimationFrame' && e.dur).map((e) => Math.round(e.dur / 1000));
      const gaps = [];
      for (let i = 1; i < durs.length; i += 1) gaps.push(durs[i]);
      const sorted = [...gaps].sort((a, b) => a - b);
      const p = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
      console.log(JSON.stringify({ frames: durs.length, p50: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1] || 0 }, null, 2));
    } else if (options.Ports) {
      console.log(JSON.stringify(list.map((t) => t.id)));
    } else {
      console.log(JSON.stringify({ target: { id: target.id, title: target.title, url: target.url } }, null, 2));
    }
    client.close();
  } catch (error) {
    console.error(String(error && error.message || error));
    process.exit(1);
  }
})();