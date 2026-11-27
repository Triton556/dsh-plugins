// DSH Browser Bridge — MV3 service worker (M0: read-only transport).
//
// Connects to the native messaging host `com.dsh.browser` and serves commands
// from the DSH side. Page access goes through chrome.debugger attached to one
// tab at a time (CDP inside the extension, never an external debug port), so it
// works on an already running browser and never restarts it.
//
// M0 commands: ping, tabs.list, tabs.claim, ax.snapshot, page.shot, page.wait.

const HOST_NAME = 'com.dsh.browser';
const CDP_VERSION = '1.3';
const DETACH_IDLE_MS = 20000;
const SNAPSHOT_TTL_MS = 60000;
const SHOT_BACKGROUND_MS = 2000;
const SHOT_ACTIVE_MS = 6000;
const SHOT_SETUP_MS = 1500;

let port = null;
let retryTimer = null;
let retryDelay = 1000;
const attached = new Set();
const detachTimers = new Map();
const claims = new Map();      // tabId -> { title, url, at }
const snapshots = new Map();   // tabId -> { at, nodes }
const snapshotReads = new Map(); // tabId -> identity of the current read
const shotReads = new Map();     // tabId -> identity of the current capture

function invalidateSnapshot(tabId) {
  snapshots.delete(tabId);
  snapshotReads.delete(tabId);
}

// ------------------------------------------------------------------ plumbing

function call(fn, thisArg, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    try {
      const result = fn.apply(thisArg, [...args, (value) => {
        const err = chrome.runtime.lastError;
        if (err) fail(new Error(err.message)); else done(value);
      }]);
      if (result && typeof result.then === 'function') result.then(done, fail);
    } catch (error) { fail(error); }
  });
}

const cdpRaw = (tabId, method, params) => call(chrome.debugger.sendCommand, chrome.debugger, { tabId }, method, params || {});

// A discarded or frozen tab answers CDP only after Chrome reloads it, which can
// take tens of seconds. Never let one command wedge the whole bridge.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout after ' + ms + 'ms: ' + label)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

const cdp = (tabId, method, params) => withTimeout(cdpRaw(tabId, method, params), 25000, method);

// Chrome unloads background tabs; a snapshot of such a tab has to load it first.
// Activating it is the only reliable way, so do that when it is unloaded.
async function ensureLoaded(tabId, args) {
  let tab = await tabsGet(tabId);
  if (tab.status === 'complete') return tab;
  if (args && args.activate === false) return tab;
  await tabsUpdate(tabId, { active: true });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    tab = await tabsGet(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise((r) => setTimeout(r, 250));
  }
  return tab;
}
const tabsQuery = (info) => call(chrome.tabs.query, chrome.tabs, info);
const tabsGet = (id) => call(chrome.tabs.get, chrome.tabs, id);
const tabsUpdate = (id, props) => call(chrome.tabs.update, chrome.tabs, id, props);

function connect() {
  if (port) return;
  retryTimer = null;
  try { port = chrome.runtime.connectNative(HOST_NAME); } catch (error) { port = null; scheduleReconnect(); return; }
  retryDelay = 1000;
  port.onMessage.addListener((message) => { handle(message).catch(() => {}); });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) console.log('[dsh-bridge] host disconnect:', err.message);
    port = null;
    scheduleReconnect();
  });
  port.postMessage({ id: 'hello', ok: true, data: { version: '0.1.0', ready: true } });
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15000);
}

let busy = 0;

async function handle(message) {
  const id = message && message.id;
  const cmd = message && message.cmd;
  const args = (message && message.args) || {};
  let reply;
  busy += 1;
  try { reply = { id, ok: true, data: await run(cmd, args) }; }
  catch (error) { reply = { id, ok: false, error: String((error && error.message) || error) }; }
  finally { busy -= 1; }
  if (!port) return;
  try { port.postMessage(reply); } catch (error) { console.log('[dsh-bridge] reply failed:', error.message); }
}

// ---------------------------------------------------------------- debugger

function cancelDetach(tabId) {
  const timer = detachTimers.get(tabId);
  if (timer) { clearTimeout(timer); detachTimers.delete(tabId); }
}

function scheduleDetach(tabId) {
  cancelDetach(tabId);
  detachTimers.set(tabId, setTimeout(() => {
    // Never drop the debugger under a command that is still running: a detach
    // mid-flight surfaces as "Detached while handling command".
    if (busy > 0) { scheduleDetach(tabId); return; }
    detach(tabId).catch(() => {});
  }, DETACH_IDLE_MS));
}

async function attach(tabId) {
  if (attached.has(tabId)) { scheduleDetach(tabId); return; }
  try { await call(chrome.debugger.attach, chrome.debugger, { tabId }, CDP_VERSION); }
  catch (error) {
    if (!/already attached/i.test(String(error && error.message))) throw error;
  }
  attached.add(tabId);
  scheduleDetach(tabId);
}

async function detach(tabId) {
  cancelDetach(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await call(chrome.debugger.detach, chrome.debugger, { tabId }); } catch (_) { /* ignore */ }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId !== undefined) { attached.delete(source.tabId); cancelDetach(source.tabId); }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url !== undefined) invalidateSnapshot(tabId);
  if (change.status === 'loading' || change.url !== undefined || change.discarded === true) shotReads.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId); cancelDetach(tabId); claims.delete(tabId); invalidateSnapshot(tabId);
  shotReads.delete(tabId);
});

async function pickTab(args) {
  if (args.tabId !== undefined && args.tabId !== null) return Number(args.tabId);
  const all = await tabsQuery({});
  if (args.tabMatch) {
    const needle = String(args.tabMatch).trim().toLowerCase();
    if (!needle) throw new Error('tabMatch must contain a title or URL substring; use tabs.list or pass tabId');
    const hits = all.filter((t) => (t.title || '').toLowerCase().includes(needle) || (t.url || '').toLowerCase().includes(needle));
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) throw new Error('tabMatch matched ' + hits.length + ' tabs; use tabs.list and pass an exact tabId');
    throw new Error('no tab matching ' + args.tabMatch);
  }
  const active = all.find((t) => t.active);
  if (active) return active.id;
  if (!all.length) throw new Error('no tabs');
  return all[0].id;
}

// --------------------------------------------------------------- AX mapping

function roleOf(node) {
  return (node.role && node.role.value) || 'unknown';
}
function nameOf(node) {
  return (node.name && node.name.value) || '';
}
function valueOf(node) {
  const v = node.value && node.value.value;
  return v === undefined ? null : v;
}
function backendId(node) {
  return node.backendDOMNodeId || null;
}

async function collectBounds(tabId, backendIds) {
  const out = new Map();
  for (const nodeId of backendIds.slice(0, 60)) {
    try {
      const box = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: nodeId });
      const q = box && box.model && box.model.content;
      if (q && q.length === 8) {
        out.set(nodeId, {
          x: Math.round(Math.min(q[0], q[2], q[4], q[6])),
          y: Math.round(Math.min(q[1], q[3], q[5], q[7])),
          w: Math.round(Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6])),
          h: Math.round(Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7])),
        });
      }
    } catch (_) { /* node without a box */ }
  }
  return out;
}

async function axSnapshot(tabId, args) {
  await ensureLoaded(tabId, args);
  const read = {};
  snapshotReads.set(tabId, read);
  try {
    const result = await readAxSnapshot(tabId, args);
    if (snapshotReads.get(tabId) !== read) {
      throw new Error('Browser page changed or the snapshot was superseded; call ax.snapshot again.');
    }
    snapshots.set(tabId, { at: Date.now(), nodes: result.nodes });
    return result;
  } finally {
    if (snapshotReads.get(tabId) === read) snapshotReads.delete(tabId);
  }
}

async function readAxSnapshot(tabId, args) {
  await attach(tabId);
  await cdp(tabId, 'Accessibility.enable');
  const tree = await cdp(tabId, 'Accessibility.getFullAXTree');
  const raw = (tree && tree.nodes) || [];
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 400;
  const needBounds = args.bounds === true;
  const nodes = [];
  const index = new Map();
  for (const node of raw) {
    if (node.ignored) continue;
    const role = roleOf(node);
    if (role === 'none' || role === 'generic' || role === 'Ignored') continue;
    const entry = {
      index: nodes.length,
      role,
      name: nameOf(node).slice(0, 200),
      value: valueOf(node),
      backendNodeId: backendId(node),
      actions: Array.isArray(node.properties) ? undefined : undefined,
    };
    nodes.push(entry);
    index.set(entry.index, entry);
    if (nodes.length >= limit) break;
  }
  if (needBounds) {
    const ids = nodes.map((n) => n.backendNodeId).filter(Boolean);
    const boxes = await collectBounds(tabId, ids);
    for (const node of nodes) if (node.backendNodeId && boxes.has(node.backendNodeId)) node.bounds = boxes.get(node.backendNodeId);
  }
  const document = await cdp(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  return { tabId, url: (document.result && document.result.value) || null, count: nodes.length, nodes };
}

// ------------------------------------------------------------------ projects

// Allowed page schemes: an internal page (chrome://, chrome-extension://) is
// never drivable and never even readable through this bridge.
function assertPage(url) {
  if (!url) return;
  if (/^(chrome|edge|about|devtools|chrome-extension|edge-extension):/i.test(url)) {
    throw new Error('internal pages are not drivable: ' + url);
  }
}

async function shotDocument(tabId) {
  const { frameTree } = await withTimeout(cdpRaw(tabId, 'Page.getFrameTree'), SHOT_SETUP_MS, 'identify screenshot document');
  const frame = frameTree?.frame;
  if (!frame?.id || !frame.loaderId || !frame.url) throw new Error('Cannot identify the screenshot document; retry after it has loaded.');
  assertPage(frame.url);
  return JSON.stringify([frame.id, frame.loaderId, frame.url, frame.urlFragment || '']);
}

async function pageShot(tabId, args) {
  const capture = {};
  shotReads.set(tabId, capture);
  const assertCurrent = () => {
    if (shotReads.get(tabId) !== capture) throw new Error('Browser page changed or the capture was superseded; take a new screenshot.');
  };
  try {
    const tab = await tabsGet(tabId);
    assertPage(tab.url);
    if (tab.discarded) throw new Error('Chrome unloaded the selected tab. Select the intended tab in Chrome and retry.');
    if (tab.status !== 'complete' || tab.pendingUrl) throw new Error('The selected tab is still loading; retry when it finishes.');
    await withTimeout(attach(tabId), SHOT_SETUP_MS, 'attach for screenshot');
    const before = await shotDocument(tabId);
    assertCurrent();
    const format = args.format === 'jpeg' ? 'jpeg' : 'png';
    const deadline = tab.active ? SHOT_ACTIVE_MS : SHOT_BACKGROUND_MS;
    let shot;
    try {
      shot = await withTimeout(cdpRaw(tabId, 'Page.captureScreenshot', {
        format, quality: format === 'jpeg' ? Number(args.quality) || 80 : undefined, captureBeyondViewport: false,
      }), deadline, 'Page.captureScreenshot');
    } catch (error) {
      assertCurrent();
      if (error?.message !== 'timeout after ' + deadline + 'ms: Page.captureScreenshot') throw error;
      throw new Error('Chrome did not produce a screenshot in ' + (deadline / 1000) +
        ' seconds. Select the intended tab in Chrome and retry. No tab was activated by the bridge.');
    }
    const after = await shotDocument(tabId);
    assertCurrent();
    if (before !== after) throw new Error('Browser page changed during capture; take a new screenshot.');
    if (typeof shot?.data !== 'string' || !shot.data) throw new Error('Chrome returned an empty screenshot; retry when the page is visible.');
    return { tabId, format, data: shot.data };
  } finally {
    if (shotReads.get(tabId) === capture) shotReads.delete(tabId);
  }
}

// BILLmanager-style pages keep their content in child frames, so a main-frame
// evaluate sees nothing. Build one isolated world per frame and search all of
// them.
async function frameContexts(tabId) {
  await cdp(tabId, 'Page.enable');
  const tree = await cdp(tabId, 'Page.getFrameTree');
  const frameIds = [];
  const walk = (node) => {
    if (!node || !node.frame) return;
    frameIds.push(node.frame.id);
    for (const child of node.childFrames || []) walk(child);
  };
  walk(tree && tree.frameTree);
  const contexts = [];
  for (const frameId of frameIds) {
    try {
      const created = await cdp(tabId, 'Page.createIsolatedWorld', { frameId, worldName: 'dsh-bridge' });
      if (created && created.executionContextId) contexts.push(created.executionContextId);
    } catch (_) { /* frame went away */ }
  }
  return contexts;
}

// ------------------------------------------------------------- M1: actions

// A debugger can detach after dispatch succeeded but before its reply. For
// mutating commands that is an uncertain effect, not a reason to repeat input.
async function withMutation(tabId, fn) {
  await attach(tabId);
  try { return await fn(); }
  catch (error) {
    if (!/detached|not attached|target closed|timeout after/i.test(String(error?.message || error))) throw error;
    attached.delete(tabId);
    cancelDetach(tabId);
    invalidateSnapshot(tabId);
    throw new Error('Browser action may already have run. Inspect the tab again before retrying.', { cause: error });
  }
}

function snapshotNode(tabId, index) {
  const snapshot = snapshots.get(tabId);
  if (!snapshot || Date.now() - snapshot.at > SNAPSHOT_TTL_MS) {
    throw new Error('no fresh ax snapshot for this tab; call ax.snapshot first');
  }
  const node = snapshot.nodes.find((n) => n.index === Number(index));
  if (!node) throw new Error('no ax node with index ' + index);
  if (!node.backendNodeId) throw new Error('ax node has no backendNodeId (not a DOM node)');
  return node;
}

async function nodeBox(tabId, backendNodeId) {
  await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const box = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId });
  const q = box && box.model && box.model.content;
  if (!q || q.length !== 8) throw new Error('element has no box model');
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return {
    x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
  };
}

async function clickAt(tabId, x, y) {
  const base = { x, y, button: 'left', modifiers: 0, clickCount: 1 };
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
}

async function axClick(tabId, index) {
  const node = snapshotNode(tabId, index);
  return withMutation(tabId, async () => {
    const point = await nodeBox(tabId, node.backendNodeId);
    await clickAt(tabId, point.x, point.y);
    return { tabId, index, role: node.role, name: node.name, clicked: point };
  });
}

async function axSetValue(tabId, index, value) {
  const node = snapshotNode(tabId, index);
  return withMutation(tabId, async () => {
    const resolved = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId });
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (!objectId) throw new Error('cannot resolve the node for writing');
    const result = await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function (next) {
        if (!this || !('value' in this)) return { ok: false, reason: 'not a form field' };
        const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
          : this.tagName === 'SELECT' ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(this, next);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: this.value };
      }`,
      arguments: [{ value: String(value) }],
    });
    const payload = (result && result.result && result.result.value) || null;
    if (!payload || payload.ok !== true) throw new Error('setValue rejected: ' + JSON.stringify(payload));
    return { tabId, index, role: node.role, value: payload.value };
  });
}

const KEY_ALIASES = {
  ENTER: 'ENTER', RETURN: 'ENTER', TAB: 'TAB', ESC: 'ESC', ESCAPE: 'ESC',
  BACKSPACE: 'BACKSPACE', DELETE: 'DELETE', UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT',
};

function describeKey(combo) {
  const parts = String(combo).toUpperCase().split('+').map((p) => p.trim()).filter(Boolean);
  let key = parts.pop();
  key = KEY_ALIASES[key] || key;
  const table = {
    ENTER: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    TAB: { key: 'Tab', code: 'Tab', vk: 9 },
    ESC: { key: 'Escape', code: 'Escape', vk: 27 },
    BACKSPACE: { key: 'Backspace', code: 'Backspace', vk: 8 },
    DELETE: { key: 'Delete', code: 'Delete', vk: 46 },
    SPACE: { key: ' ', code: 'Space', vk: 32, text: ' ' },
    UP: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    DOWN: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    LEFT: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    RIGHT: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    HOME: { key: 'Home', code: 'Home', vk: 36 },
    END: { key: 'End', code: 'End', vk: 35 },
    PAGEUP: { key: 'PageUp', code: 'PageUp', vk: 33 },
    PAGEDOWN: { key: 'PageDown', code: 'PageDown', vk: 34 },
  };
  const base = table[key] || { key: key.length === 1 ? key.toLowerCase() : key, code: undefined, vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
  let modifiers = 0;
  for (const part of parts) {
    if (part === 'CTRL' || part === 'CONTROL') modifiers |= 2;
    else if (part === 'ALT') modifiers |= 1;
    else if (part === 'SHIFT') modifiers |= 8;
    else if (part === 'META' || part === 'CMD') modifiers |= 4;
  }
  return { ...base, modifiers };
}

async function pressKeys(tabId, keys) {
  const combos = Array.isArray(keys) ? keys : String(keys || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!combos.length) throw new Error('keys is required');
  return withMutation(tabId, async () => {
    // Keyboard events only reach the tab that owns the focused frame.
    const tab = await tabsGet(tabId);
    if (!tab.active) { await tabsUpdate(tabId, { active: true }); await new Promise((r) => setTimeout(r, 150)); }
    for (const combo of combos) {
      const spec = describeKey(combo);
      const common = { modifiers: spec.modifiers || 0, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', text: spec.text, unmodifiedText: spec.text, ...common });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    }
    return { tabId, pressed: combos };
  });
}

async function pageNavigate(tabId, url) {
  if (!url) throw new Error('url is required');
  const tab = await tabsGet(tabId);
  assertPage(tab.url || '');
  if (/^(chrome|edge|about|devtools|chrome-extension|edge-extension):/i.test(url)) {
    throw new Error('internal pages are not drivable: ' + url);
  }
  return withMutation(tabId, async () => {
    await cdp(tabId, 'Page.enable');
    invalidateSnapshot(tabId);
    const navigation = await cdp(tabId, 'Page.navigate', { url });
    if (navigation?.errorText) throw new Error('Navigation failed: ' + navigation.errorText);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const state = await cdp(tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (state.result && state.result.value === 'complete') {
          const href = await cdp(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
          return { tabId, url: (href.result && href.result.value) || url, ready: true };
        }
      } catch (_) { /* the context is being replaced during navigation */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { tabId, url, ready: false };
  });
}

async function run(cmd, args) {
  switch (String(cmd || '').toLowerCase()) {
    case 'ping':
      return { ok: true, host: HOST_NAME, rev: 'm1.1', attached: [...attached], claimed: [...claims.keys()] };

    case 'tabs.list': {
      const all = await tabsQuery({});
      return {
        tabs: all.map((t) => ({
          id: t.id, windowId: t.windowId, title: t.title, url: t.url,
          active: t.active, pinned: t.pinned, status: t.status,
          claimed: claims.has(t.id),
        })),
      };
    }

    case 'tabs.claim': {
      const tabId = await pickTab(args);
      const tab = await tabsGet(tabId);
      assertPage(tab.url);
      if (args.expectTitle !== undefined && String(tab.title || '') !== String(args.expectTitle)) {
        throw new Error('title changed; refusing to claim: ' + (tab.title || ''));
      }
      if (args.expectUrl !== undefined && String(tab.url || '') !== String(args.expectUrl)) {
        throw new Error('url changed; refusing to claim: ' + (tab.url || ''));
      }
      claims.set(tabId, { title: tab.title || '', url: tab.url || '', at: Date.now() });
      return { tabId, title: tab.title || null, url: tab.url || null, claimed: true };
    }

    case 'tabs.release': {
      const tabId = await pickTab(args);
      claims.delete(tabId);
      await detach(tabId);
      return { tabId, claimed: false };
    }

    case 'ax.snapshot': {
      const tabId = await pickTab(args);
      const tab = await tabsGet(tabId);
      assertPage(tab.url);
      return axSnapshot(tabId, args);
    }

    case 'page.shot': {
      return pageShot(await pickTab(args), args);
    }

    case 'page.wait': {
      if (!args.selector && !args.text) throw new Error('selector or text is required');
      const tabId = await pickTab(args);
      const tab = await tabsGet(tabId);
      assertPage(tab.url);
      await attach(tabId);
      const timeout = Math.min(Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 10000, 30000);
      const started = Date.now();
      const expression = args.selector
        ? `(function(){ return !!document.querySelector(${JSON.stringify(args.selector)}); })()`
        : `(function(){ return document.body ? document.body.innerText.includes(${JSON.stringify(args.text)}) : false; })()`;
      const contexts = await frameContexts(tabId);
      while (Date.now() - started <= timeout) {
        for (const contextId of contexts) {
          try {
            const result = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, contextId });
            if (result.result && result.result.value === true) {
              return { tabId, satisfied: true, frames: contexts.length, elapsedMs: Date.now() - started };
            }
          } catch (_) { /* context detached; try the next one */ }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return { tabId, satisfied: false, frames: contexts.length, elapsedMs: Date.now() - started };
    }

    case 'tabs.new': {
      const tab = await call(chrome.tabs.create, chrome.tabs, { url: args.url || 'about:blank', active: args.active !== false });
      return { tabId: tab.id, url: tab.url, title: tab.title };
    }

    case 'ax.click': {
      const tabId = await pickTab(args);
      const tab = await tabsGet(tabId);
      assertPage(tab.url);
      return axClick(tabId, args.index);
    }

    // The command name is lowercased before the switch, so camelCase API names
    // arrive here in lower case.
    case 'ax.setvalue': {
      const tabId = await pickTab(args);
      const tab = await tabsGet(tabId);
      assertPage(tab.url);
      if (args.value === undefined) throw new Error('value is required');
      return axSetValue(tabId, args.index, args.value);
    }

    case 'input.type': {
      const tabId = await pickTab(args);
      const tab = await tabsGet(tabId);
      assertPage(tab.url);
      if (typeof args.text !== 'string') throw new Error('text is required');
      return withMutation(tabId, async () => {
        await cdp(tabId, 'Input.insertText', { text: args.text });
        return { tabId, typed: args.text.length };
      });
    }

    case 'input.key':
    case 'input.keys': {
      const tabId = await pickTab(args);
      const tab = await tabsGet(tabId);
      assertPage(tab.url);
      return pressKeys(tabId, args.keys);
    }

    case 'page.navigate': {
      const tabId = await pickTab(args);
      return pageNavigate(tabId, args.url);
    }

    default:
      throw new Error('unknown command: ' + cmd);
  }
}

// ----------------------------------------------------------------- lifecycle

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('dsh-bridge-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'dsh-bridge-keepalive') return;
  if (!port) { connect(); return; }
  try { port.postMessage({ id: 'keepalive', ok: true }); } catch (_) { port = null; connect(); }
});

connect();
