// Isolated check of dsh-artifact-panes' client module: loads client.js with a
// stubbed ModuleLoader, React and Cordis ctx, then asserts the registrations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8');

let factory;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: fn }) {
      assert.equal(id, 'dsh-artifact-panes');
      factory = fn;
    },
  },
  // client.js polls with window timers inside its effects
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestIdleCallback: (fn) => { fn(); return 0; },
  cancelIdleCallback: () => {},
};
// Minimal DOM: the divider controller probes the environment and bails with
// CONTRACT_UNAVAILABLE when the ctx lacks layout/sidebarRight, which is exactly
// what this test wants to exercise.
// client.js also reads localStorage and bare timers from the page context
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const realSetTimeout = globalThis.setTimeout;

globalThis.document = {
  defaultView: {
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
  },
  head: { append: () => {} },
  body: { style: {}, dataset: {} },
  documentElement: { style: {}, dataset: {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};

// React stub: only the surface the module touches at load/apply time.
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  // memo/forwardRef pass the component through: the stub renders directly
  memo: (component) => component,
  forwardRef: (render) => render,
};

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};

// Evaluate the module source like the browser loader does.
new Function('window', source)(globalThis.window);
assert.equal(typeof factory, 'function');
const module = factory(requireStub);

// Slot names the client may inject into, derived from its own source so the test
// does not rot when a new experiment adds a slot.
const SLOT_NAMES = [...source.matchAll(/slots\.inject\(\s*'([^']+)'/g)].map((m) => m[1]);
assert.ok(SLOT_NAMES.includes('sidebar.right.pane.tab'), 'the pane tab slot is gone from client.js');

// The inject list grows with the experiments (layout/divider, chat, sessions);
// derived from the source the same way so it tracks reality.
const INJECT_LIST = [...source.matchAll(/inject:\s*\[([^\]]+)\]/g)].flatMap((m) =>
  [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
assert.deepEqual(module.inject, INJECT_LIST);

const calls = { types: [], slots: [], locale: [], effects: [] };
const ctx = {
  effect(fn, label) {
    calls.effects.push(label);
    const dispose = fn();
    return dispose;
  },
  locale: { register: (...args) => { calls.locale.push(args); return () => {}; } },
  sidebarRightTabs: { register: (def) => { calls.types.push(def); return () => {}; } },
  slots: {
    inject: (name, cb) => {
      assert.ok(SLOT_NAMES.includes(name), 'unexpected slot: ' + name);
      calls.slotInjections = calls.slotInjections || [];
      calls.slotInjections.push(name);
      return cb();
    },
    register: (options, component) => { calls.slots.push({ options, component }); return () => {}; },
  },
  remote: { workspaceFiles: { readBytes: () => Promise.resolve({ ok: true, value: { data: new Uint8Array(), version: 1 } }) } },
  resources: {},
  // the coordinator subscribes to sidebar mount events (service is declared
  // in the inject list, so production always has it)
  sidebarRight: {
    mounted: { subscribe: () => () => {}, getSnapshot: () => [] },
    active: () => null,
  },
};

module.apply(ctx);

assert.equal(calls.types.length, 2);
const def = calls.types.find((d) => d.id === 'dsh-artifact-panes');
const browser = calls.types.find((d) => d.id === 'dsh-artifact-panes/browser');
assert.ok(def && browser);
assert.equal(def.kind, 'artifact');
assert.equal(def.priority, 'extension');
assert.equal(def.keepMounted, true);
assert.deepEqual(def.patterns, ['*.html', '*.htm', '*.xhtml']);

const addr = (p) => 'dsh-resource://file/session/sess-1/' + p;
assert.equal(def.canOpen(addr('artifacts/dsh-panel.html')), true);
assert.equal(def.canOpen(addr('artifacts/x.ui4a.tsx')), false);
assert.equal(def.canOpen(addr('artifacts/notes.md')), false);
assert.equal(def.canOpen('dsh-resource://file/absolute/C:/a.html'), false, 'absolute scope must not be claimed');
assert.equal(def.title(addr('artifacts/%D1%81%D1%85%D0%B5%D0%BC%D0%B0.html')), 'схема.html');

// The browser page type carries the guide card shown on the sidebar start page.
assert.equal(browser.kind, 'artifact-browser');
assert.equal(browser.priority, 'builtin');
assert.equal(browser.title(), 'Artifacts');
assert.equal(browser.guide.length, 1);
assert.equal(browser.guide[0].kind, undefined, 'kind is filled by the registry');
assert.equal(browser.guide[0].title(), 'Artifacts');
assert.equal(typeof browser.guide[0].icon, 'function');

// Experiments add more slot registrations; every slot must belong to this bundle
// (its own keys are dsh-artifact-panes* and the annotation renderer dsh-annotations),
// and the two core ones must still be there.
assert.ok(calls.slots.length >= 2, 'core slot registrations missing');
for (const { options } of calls.slots) {
  const key = String(options.key ?? options.id ?? '');
  assert.ok(
    key.startsWith('dsh-artifact-panes') || key === 'dsh-annotations',
    'foreign slot key: ' + key
  );
}
const readerSlot = calls.slots.find((s) => s.options.key === 'dsh-artifact-panes');
const browserSlot = calls.slots.find((s) => s.options.key === 'dsh-artifact-panes/browser');
assert.ok(readerSlot && browserSlot);
assert.equal(readerSlot.options.name, 'sidebar.right.pane.tab');
assert.equal(readerSlot.options.locale, 'artifactPanes');
assert.equal(typeof readerSlot.component, 'function');
assert.equal(typeof browserSlot.component, 'function');

// The browser slot resolves the session id inside inject (slot args are an
// empty object, so a parameter named sessionId used to be an opaque object
// and every read crashed the tab body into a white pane).
const injected = browserSlot.options.inject();
assert.equal(typeof injected.sessionId, 'string');
assert.equal(injected.sessionId, '');
assert.equal(typeof injected.read, 'function');
const noRead = () => { throw new Error('read must not run without a session'); };
const chrome = browserComponentRender(browserSlot.component, { read: noRead, sessionId: '' });
assert.equal(chrome.type, 'div');

assert.equal(calls.locale.length, 1);
assert.equal(calls.locale[0][0], 'artifactPanes');
assert.ok(calls.locale[0][1].en && calls.locale[0][1].ru && calls.locale[0][1].zh);

// Render a component once through the React stub (hooks are no-ops, so this
// exercises only the render path, not the effects).
function browserComponentRender(component, props) {
  return component(props);
}

// Body: an HTML resource address produces the panel with header + canvas.
const readerComponent = calls.slots.find((s) => s.options.key === 'dsh-artifact-panes').component;
function renderBody(contentId, readImpl) {
  const props = {
    useTabInfo: () => ({ tab: { contentId, title: 'x', actions: {} } }),
    useResource: () => ({ status: 'loading' }),
    read: readImpl,
    resources: { source: () => ({ getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {} }) },
  };
  return readerComponent(props);
}
const tree = renderBody(addr('artifacts/dsh-panel.html'), () => Promise.resolve({ ok: true, value: { data: new Uint8Array(), version: 1 } }));
assert.equal(tree.type, 'div');
// The pane composes the header, an optional notice and the body; the annotation
// dock is a separate slot registration (conversation.input.dock), not a child.
const kids = tree.children.filter(Boolean);
assert.ok(kids.length >= 2, 'header + body');
assert.equal(typeof kids[0].type, 'function', 'header is the first child');
const bodyEl = kids[kids.length - 1];
assert.ok(bodyEl && (bodyEl.type === 'iframe' || bodyEl.type === 'div'), 'body is the last child');

// Regression: picking another artifact in the dropdown used to throw on an
// undefined ref before setCurrent, so the selector never switched files.
const ITEMS = [
  { path: 'C:/ws/artifacts/a.html', title: 'A', size: 1, mtime: 2 },
  { path: 'C:/ws/artifacts/b.html', title: 'B', size: 1, mtime: 1 },
];
const setters = {};
let hookIndex = 0;
let overrides = {};
React.useState = (init) => {
  const i = hookIndex++;
  const initial = Object.prototype.hasOwnProperty.call(overrides, i)
    ? overrides[i]
    : (typeof init === 'function' ? init() : init);
  return [initial, (next) => { setters[i] = typeof next === 'function' ? next(initial) : next; }];
};
const renderBrowser = (state) => {
  overrides = state;
  hookIndex = 0;
  return browserSlot.component({ read: noRead, sessionId: 'sess-1' });
};
const openMenu = renderBrowser({ 0: ITEMS, 1: ITEMS[0], 3: true });
const menuItems = findNodes(openMenu, (node) => node.props && node.props.role === 'menuitemradio');
assert.equal(menuItems.length, ITEMS.length, 'dropdown must list every artifact');
assert.doesNotThrow(() => menuItems[1].props.onClick(), 'clicking a menu item must not throw');
assert.equal(setters[1] && setters[1].path, ITEMS[1].path, 'clicking a menu item must select it');
assert.equal(setters[3], false, 'clicking a menu item must close the menu');

// Hover feedback is CSS-driven (one injected stylesheet), so hovering a row or
// the trigger costs no React render; the current artifact is marked by
// aria-checked and a class the stylesheet tints.
const hoveredMenu = renderBrowser({ 0: ITEMS, 1: ITEMS[0], 3: true });
const rows = findNodes(hoveredMenu, (node) => node.props && node.props.role === 'menuitemradio');
assert.equal(rows[0].props['aria-checked'], true, 'current row is flagged');
assert.equal(rows[1].props['aria-checked'], false, 'other rows are not');
for (const row of rows) {
  assert.equal(row.props.className, 'dap-item', 'rows share one CSS class');
  assert.equal(row.props.onMouseEnter, undefined, 'no per-row hover state to re-render');
}
const trigger = findNodes(hoveredMenu, (node) => node.props && node.props.className === 'dap-trigger')[0];
assert.ok(trigger, 'trigger carries the CSS class');
assert.equal(trigger.props.style, undefined, 'trigger styling lives in the stylesheet');

// The stylesheet must actually define the states the markup relies on.
for (const rule of ['.dap-trigger:hover', '.dap-trigger[aria-expanded="true"]', '.dap-item:hover', '.dap-item[aria-checked="true"]', '.dap-btn:hover']) {
  assert.ok(source.includes(rule), 'stylesheet defines ' + rule);
}

// Re-render cost: unchanged inputs must hand back the cached elements, so a
// sidebar resize re-render does not rebuild the list or the iframe.
const memo = { entries: [], index: 0, hits: 0 };
const realUseMemo = React.useMemo;
React.useMemo = (fn, deps) => {
  const slot = memo.index++;
  const prev = memo.entries[slot];
  const same = prev && deps && prev.deps && deps.length === prev.deps.length
    && deps.every((d, i) => Object.is(d, prev.deps[i]));
  if (same) { memo.hits += 1; return prev.value; }
  const value = fn();
  memo.entries[slot] = { deps, value };
  return value;
};
const renderMemo = (state) => { memo.index = 0; return renderBrowser(state); };
const first = renderMemo({ 0: ITEMS, 1: ITEMS[0], 2: { status: 'ok', url: 'blob:x' }, 3: true });
const hitsAfterFirst = memo.hits;
const second = renderMemo({ 0: ITEMS, 1: ITEMS[0], 2: { status: 'ok', url: 'blob:x' }, 3: true });
assert.ok(memo.hits > hitsAfterFirst, 'repeat render hits the memo cache');
assert.equal(findNodes(second, (n) => n.props && n.props.role === 'menu').length, 1);
const frames = findNodes(second, (n) => n.type === 'iframe');
assert.equal(frames.length, 1, 'canvas renders the artifact once');
assert.equal(frames[0], findNodes(first, (n) => n.type === 'iframe')[0], 'the cached iframe element is reused verbatim');
React.useMemo = realUseMemo;

function findNodes(node, predicate) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    if (value.props && predicate(value)) out.push(value);
    if (value.children) walk(value.children);
  };
  walk(node);
  return out;
}

console.log('artifact-panes client module: OK');
console.log('  registered type:', def.id, '| kind:', def.kind, '| patterns:', def.patterns.join(', '));
console.log('  slot registration:', calls.slots[0].options.name, '/', calls.slots[0].options.key);
console.log('  effects:', calls.effects.join(' | '));
