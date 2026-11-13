// End-to-end check of the annotation flow in its current shape:
//   * the picker trigger lives in the global overlay (shell.overlay slot) and posts
//     `dsh-pick` to the artifact frame of the open right panel;
//   * pending annotations live in the dock (conversation.input.dock slot) and are
//     sent to the agent as one text block wrapped in DSH_ANNOTATIONS markers.
// Both components are rendered with a tiny hook runtime; no React DOM is involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8');

// ---- window with a message bus and deterministic timers -------------------
const listeners = { message: [] };
const timerQueue = [];
const fakeWindow = {
  __ModuleLoader__: { load({ factory }) { globalThis.__factory = factory; } },
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => {
    const list = listeners[type] || [];
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn) => { timerQueue.push(fn); return timerQueue.length; },
  clearTimeout: () => {},
  requestIdleCallback: (fn) => { fn(); return 0; },
  cancelIdleCallback: () => {},
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame: () => {},
  dispatchEvent: () => {},
  innerWidth: 1400,
  innerHeight: 900,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  MutationObserver: class { observe() {} disconnect() {} },
};
globalThis.window = fakeWindow;
globalThis.requestAnimationFrame = fakeWindow.requestAnimationFrame;
// client.js also schedules bare (global) timers, so they must be deterministic too
globalThis.setTimeout = fakeWindow.setTimeout;
globalThis.clearTimeout = fakeWindow.clearTimeout;
globalThis.setInterval = fakeWindow.setInterval;
globalThis.clearInterval = fakeWindow.clearInterval;
globalThis.cancelAnimationFrame = () => {};
globalThis.MutationObserver = fakeWindow.MutationObserver;
function flushTimers() {
  let guard = 0;
  while (timerQueue.length && guard < 200) { timerQueue.shift()(); guard += 1; }
}

// ---- the artifact frame and the right panel it lives in -------------------
const posted = [];
const frameWin = { postMessage: (msg) => { posted.push(msg); } };
const fakeFrame = {
  contentWindow: frameWin,
  getBoundingClientRect: () => ({ left: 1000, top: 120, width: 400, height: 800, right: 1400, bottom: 920 }),
};
const fakeChrome = { insertBefore: () => {}, firstChild: null };
const fakePanel = {
  getAttribute: (name) => (name === 'data-sidebar-right-session' ? 'sess-1' : null),
  setAttribute: () => {},
  removeAttribute: () => {},
  getBoundingClientRect: () => ({ left: 1000, top: 0, width: 400, height: 900, right: 1400, bottom: 900 }),
  querySelector: (selector) => (String(selector).includes('data-dockkit-strip-chrome') ? fakeChrome : null),
  querySelectorAll: (selector) => (String(selector).includes('iframe') ? [fakeFrame] : []),
};

// ---- a deterministic document facade --------------------------------------
function fakeElement() {
  const el = {
    className: '', style: {}, dataset: {},
    isConnected: true, firstChild: null, parentNode: null,
    setAttribute: () => {}, removeAttribute: () => {},
    append: () => {}, insertBefore: () => {}, removeChild: () => {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 80, height: 24, right: 180, bottom: 124 }),
    contains: () => false,
  };
  // self-return keeps every lookup a usable element (a chip button needs rect/query)
  el.querySelector = () => el;
  return el;
}
const composerParent = fakeElement();
globalThis.document = {
  hidden: false,
  defaultView: fakeWindow,
  head: { append: () => {} },
  body: fakeElement(),
  documentElement: fakeElement(),
  createElement: () => fakeElement(),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelectorAll: (selector) => (String(selector).includes('data-sidebar-right-session') ? [fakePanel] : []),
  querySelector: (selector) => (String(selector).includes('data-composer-seat') || String(selector).includes('_scroll')
    ? composerParent : null),
};

// One pending annotation is pre-seeded, exactly like a reload would restore it.
const PENDING = {
  id: 'ann-1', tag: 'button', idAttr: 'send', classes: 'send primary',
  selector: 'body > div.foot > button#send', text: 'Отправить ответы',
  html: '<button class="send primary" id="send">Отправить ответы</button>',
  note: 'Кнопка слишком близко к краю',
  rect: { x: 100, y: 200, w: 160, h: 36 }, localRect: { x: 10, y: 20, w: 160, h: 36 },
  title: 'demo.html', path: 'C:/ws/artifacts/demo.html', frame: true,
};
globalThis.localStorage = {
  store: new Map([['dsh-artifact-panes:annotations', JSON.stringify({ 'sess-1': [PENDING] })]]),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, value) { this.store.set(key, value); },
  removeItem(key) { this.store.delete(key); },
};
globalThis.fetch = () => new Promise(() => {});

// ---- React stub with a reusable hook runtime ------------------------------
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const React = {
  createElement: h,
  useState: () => { throw new Error('useState must be installed by the runtime'); },
  useEffect: () => { throw new Error('useEffect must be installed by the runtime'); },
  useLayoutEffect: () => { throw new Error('useLayoutEffect must be installed by the runtime'); },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => { throw new Error('useRef must be installed by the runtime'); },
  memo: (component) => component,
  forwardRef: (render) => render,
};
const ReactDOM = { createPortal: (element) => element };
const requireStub = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error('unexpected require: ' + name);
};

new Function('window', 'document', source)(fakeWindow, globalThis.document);
const module = globalThis.__factory(requireStub);

// State is stored per component: the overlay and the dock are rendered into the
// same process, and a shared hook array would leak one component's state into
// the other's slots.
const stores = new WeakMap();
let hookStates = [];
let hookSlots = [];
let pendingEffects = [];
let cursor = 0;
React.useState = (init) => {
  const i = cursor++;
  if (!(i in hookStates)) hookStates[i] = typeof init === 'function' ? init() : init;
  return [hookStates[i], (next) => { hookStates[i] = typeof next === 'function' ? next(hookStates[i]) : next; }];
};
React.useRef = (init) => {
  const i = cursor++;
  if (!(i in hookStates)) hookStates[i] = { current: init };
  return hookStates[i];
};
React.useEffect = (fn, deps) => { pendingEffects.push({ i: cursor++, fn, deps }); };
React.useLayoutEffect = React.useEffect;

function expand(node, depth = 0) {
  if (Array.isArray(node)) return node.map((child) => expand(child, depth));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function' && depth < 8) return expand(node.type(node.props), depth + 1);
  return { ...node, children: (node.children || []).map((child) => expand(child, depth)) };
}
function render(component, props) {
  let store = stores.get(component);
  if (!store) { store = { states: [], slots: [] }; stores.set(component, store); }
  hookStates = store.states;
  hookSlots = store.slots;
  cursor = 0;
  pendingEffects = [];
  const tree = expand(component(props));
  for (const { i, fn, deps } of pendingEffects) {
    const prev = hookSlots[i];
    const same = prev && deps && prev.deps
      && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]));
    if (same) continue;
    if (prev && typeof prev.cleanup === 'function') prev.cleanup();
    const cleanup = fn();
    hookSlots[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
  }
  return tree;
}
function findNodes(node, predicate) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    if (value.props) walk(value.children);
    if (value.props && predicate(value)) out.push(value);
  };
  walk(node);
  return out;
}
const byTitle = (tree, part) => findNodes(tree, (n) => n.type === 'button' && String(n.props.title || '').includes(part));
const byText = (tree, text) => findNodes(tree, (n) => n.type === 'button' && (n.children || []).flat(Infinity).includes(text));

// ---- install both halves --------------------------------------------------
let overlay;   // GlobalAnnotations (shell.overlay)
let dock;      // AnnotationDock (conversation.input.dock)
module.apply({
  effect(fn) { return fn(); },
  locale: { register: () => () => {} },
  sidebarRightTabs: { register: () => () => {} },
  slots: {
    inject: (name, cb) => cb(),
    register: (options, comp) => {
      if (options.name === 'shell.overlay') overlay = comp;
      if (options.name === 'conversation.input.dock') dock = comp;
      return () => {};
    },
  },
  remote: { workspaceFiles: { readBytes: () => new Promise(() => {}) } },
  resources: {},
  sidebarRight: { mounted: { subscribe: () => () => {}, getSnapshot: () => [] }, active: () => null },
  get(name) {
    if (name === 'sessions') return { scope: () => ({ conversation: { send: () => Promise.resolve() } }) };
    return undefined;
  },
});
assert.ok(overlay, 'annotation overlay registered');
assert.ok(dock, 'annotation dock registered');

// 1. The trigger posts the picker command to the artifact frame of the panel.
let tree = render(overlay, { currentSessionId: 'sess-1' });
tree = render(overlay, { currentSessionId: 'sess-1' });
const [trigger] = byTitle(tree, 'Annotate');
assert.ok(trigger, 'annotate trigger is rendered');
trigger.props.onClick({ preventDefault() {}, stopPropagation() {} });
tree = render(overlay, { currentSessionId: 'sess-1' });
assert.deepEqual(posted.at(-1), { type: 'dsh-pick', on: true }, 'picker activation reaches the artifact frame');
assert.ok(byTitle(tree, 'Exit annotation mode').length === 1, 'the trigger flips to exit mode');

// 2. A picked element from the frame seeds the pending card.
posted.length = 0;
const payload = {
  tag: 'button', id: 'send', classes: 'send primary',
  selector: 'body > div.foot > button#send', chain: 'div.foot < body',
  text: 'Отправить ответы', html: '<button class="send primary" id="send">Отправить ответы</button>',
  styleText: 'display:inline-flex', rect: { x: 10, y: 20, w: 160, h: 36 },
};
for (const fn of listeners.message) fn({ data: { type: 'dsh-picked', payload }, source: frameWin });
tree = render(overlay, { currentSessionId: 'sess-1' });
assert.ok(byText(tree, 'Save').length === 1, 'the picked element opens the note card');

// 3. The dock lists the pending annotation and sends it with the user's text.
let draft = 'поправь кнопку';
let submitted = false;
tree = render(dock, {
  sessionId: 'sess-1',
  getDraft: () => draft,
  setDraft: (text) => { draft = text; },
  submit: () => { submitted = true; },
});
tree = render(dock, {
  sessionId: 'sess-1',
  getDraft: () => draft,
  setDraft: (text) => { draft = text; },
  submit: () => { submitted = true; },
});
const chip = findNodes(tree, (n) => n.props && n.props.className === 'dsh-ann-chip')[0];
assert.ok(chip, 'dock chip is rendered for the pending annotation');
chip.props.onClick({ preventDefault() {}, stopPropagation() {} });
flushTimers();
tree = render(dock, {
  sessionId: 'sess-1',
  getDraft: () => draft,
  setDraft: (text) => { draft = text; },
  submit: () => { submitted = true; },
});
tree = render(dock, {
  sessionId: 'sess-1',
  getDraft: () => draft,
  setDraft: (text) => { draft = text; },
  submit: () => { submitted = true; },
});
const [send] = byText(tree, 'Send with annotations');
assert.ok(send, 'send button is rendered');
send.props.onClick();
flushTimers();
assert.equal(submitted, true, 'the composer submits right after the draft is written');
assert.ok(draft.includes('<<<DSH_ANNOTATIONS>>>'), 'the annotation block is appended');
assert.ok(draft.includes('<<</DSH_ANNOTATIONS>>>'), 'the block is closed');
assert.ok(draft.startsWith('поправь кнопку'), 'the user text stays first');
const block = JSON.parse(draft.slice(
  draft.indexOf('<<<DSH_ANNOTATIONS>>>') + '<<<DSH_ANNOTATIONS>>>'.length,
  draft.indexOf('<<</DSH_ANNOTATIONS>>>')
).trim());
assert.equal(block.kind, 'dsh.annotations');
assert.equal(block.items.length, 1);
assert.equal(block.items[0].selector, 'body > div.foot > button#send');
assert.equal(block.items[0].comment, 'Кнопка слишком близко к краю');
assert.equal(block.items[0].tag, 'button');

console.log('artifact-panes annotations: OK');
console.log('  draft length:', draft.length, 'chars');
