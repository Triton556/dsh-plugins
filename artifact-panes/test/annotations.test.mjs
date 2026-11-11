// End-to-end check of the element-annotation flow, driven through a tiny hook
// runtime: enable the picker, receive a picked element from the artifact,
// edit its note, add a task and send — the agent must get one readable message.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8');

// ---- window with a real message bus --------------------------------------
const listeners = { message: [] };
const fakeWindow = {
  __ModuleLoader__: { load({ factory }) { globalThis.__factory = factory; } },
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => {
    const list = listeners[type] || [];
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
  },
};
globalThis.window = fakeWindow;

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: () => { throw new Error('useState must be installed by the runtime'); },
  useEffect: () => { throw new Error('useEffect must be installed by the runtime'); },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => { throw new Error('useRef must be installed by the runtime'); },
};
const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};

new Function('window', source)(globalThis.window);
const module = globalThis.__factory(requireStub);

// ---- minimal hook runtime ------------------------------------------------
const states = [];
let pendingEffects = [];
let effectSlots = [];
let cursor = 0;
React.useState = (init) => {
  const i = cursor++;
  if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
  return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
};
React.useRef = (init) => {
  const i = cursor++;
  if (!(i in states)) states[i] = { current: init };
  return states[i];
};
React.useEffect = (fn, deps) => {
  const i = cursor++;
  pendingEffects.push({ i, fn, deps });
};

let component;
// Child components (Header, AnnotationDesk) are ordinary functions here, so the
// runtime expands them: React would call them, this stub must do the same.
function expand(node, depth = 0) {
  if (Array.isArray(node)) return node.map((child) => expand(child, depth));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function' && depth < 6) return expand(node.type(node.props), depth + 1);
  return { ...node, children: (node.children || []).map((child) => expand(child, depth)) };
}
function render(props) {
  cursor = 0;
  pendingEffects = [];
  const tree = component(props);
  for (const { i, fn, deps } of pendingEffects) {
    const prev = effectSlots[i];
    const same = prev && deps && prev.deps
      && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]));
    if (same) continue;
    if (prev && typeof prev.cleanup === 'function') prev.cleanup();
    const cleanup = fn();
    effectSlots[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
  }
  return expand(tree);
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
const byText = (tree, text) => findNodes(tree, (n) => n.type === 'button' && n.children.flat(Infinity).includes(text));

// ---- install the browser pane -------------------------------------------
const writes = [];
let context;
module.apply({
  effect(fn) { return fn(); },
  locale: { register: () => () => {} },
  sidebarRightTabs: { register: () => () => {} },
  slots: {
    inject: (name, cb) => cb(),
    register: (options, comp) => { if (options.key === 'dsh-artifact-panes/browser') component = comp; return () => {}; },
  },
  remote: { workspaceFiles: { readBytes: () => new Promise(() => {}) } },
  resources: {},
  get(name) {
    if (name === 'sessions') {
      return {
        scope: (id) => ({
          conversation: { send: (text) => { writes.push({ id, text }); return Promise.resolve(); } },
        }),
      };
    }
    return undefined;
  },
});

const ITEMS = [{ path: 'C:/ws/artifacts/demo.html', title: 'Demo', size: 10, mtime: 1 }];
// Seed the pane with a loaded artifact so the test drives only annotations.
states[0] = ITEMS;
states[1] = ITEMS[0];
states[2] = { status: 'ok', url: 'blob:demo' };

globalThis.fetch = () => new Promise(() => {});
// A hidden document keeps the artifact poll timer a no-op.
globalThis.document = { hidden: true };

const deliver = (sessionId, text) => {
  const sessions = { scope: () => ({ conversation: { send: (t) => { writes.push({ id: sessionId, text: t }); return Promise.resolve(); } } }) };
  return sessions.scope(sessionId).conversation.send(text);
};

let props = { read: () => new Promise(() => {}), sessionId: 'sess-1', deliver };
let tree = render(props);

// The artifact iframe exposes its window; wire it like React would.
const frame = findNodes(tree, (n) => n.type === 'iframe')[0];
const frameWin = { postMessage: (msg) => { frame.posted = (frame.posted || []).concat([msg]); } };
frame.props.ref.current = { contentWindow: frameWin };

// 1. The picker button turns the artifact into comment mode.
const [pickButton] = byTitle(tree, 'Комментировать');
assert.ok(pickButton, 'picker button is present');
pickButton.props.onClick();
assert.deepEqual(frame.posted[0], { type: 'dsh-pick', on: true }, 'picker activation is posted to the artifact');

// 2. A picked element arrives from the artifact and becomes a card.
const payload = {
  tag: 'button', id: 'send', classes: 'send primary',
  selector: 'body > div.foot > button#send',
  chain: 'div.foot < body',
  text: 'Отправить ответы',
  html: '<button class="send primary" id="send">Отправить ответы</button>',
  styleText: 'display:inline-flex; color:rgb(255,255,255); background-color:rgb(124,92,255)',
  rect: { x: 100, y: 200, w: 160, h: 36 },
};
for (const fn of listeners.message) fn({ data: { type: 'dsh-picked', payload }, source: frameWin });
tree = render(props);

const cards = findNodes(tree, (n) => n.type === 'div' && n.props.style && n.props.style.borderRadius === 8);
assert.equal(cards.length, 1, 'one annotation card');

// A message from someone else's frame must be ignored.
for (const fn of listeners.message) fn({ data: { type: 'dsh-picked', payload }, source: { other: true } });
tree = render(props);
assert.equal(findNodes(tree, (n) => n.type === 'div' && n.props.style && n.props.style.borderRadius === 8).length, 1, 'foreign frames are ignored');

// 3. The note and the task are editable.
const note = findNodes(tree, (n) => n.type === 'textarea' && String(n.props.placeholder || '').includes('Что здесь не так'))[0];
assert.ok(note, 'note textarea');
note.props.onChange({ target: { value: 'Кнопка слишком близко к краю' } });
tree = render(props);
const task = findNodes(tree, (n) => n.type === 'textarea' && String(n.props.placeholder || '').includes('Задача целиком'))[0];
task.props.onChange({ target: { value: 'перепиши блок так, чтобы кнопка была в сетке' } });
tree = render(props);

// 4. Sending hands the agent one structured message.
const [sendButton] = byText(tree, 'Отправить');
assert.ok(sendButton, 'send button');
sendButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(writes.length, 1, 'one prompt is admitted');
assert.equal(writes[0].id, 'sess-1');
const text = writes[0].text;
assert.match(text, /Аннотации к артефакту `C:\/ws\/artifacts\/demo\.html` — 1\./);
assert.match(text, /button#send\.send\.primary/);
assert.match(text, /селектор: body > div\.foot > button#send/);
assert.match(text, /геометрия: 160×36 при 100,200/);
assert.match(text, /стили: display:inline-flex/);
assert.match(text, /```html\n<button class="send primary" id="send">Отправить ответы<\/button>\n```/);
assert.match(text, /заметка: Кнопка слишком близко к краю/);
assert.match(text, /Задача: перепиши блок так, чтобы кнопка была в сетке/);

// 5. After sending the desk is empty and the picker is off.
tree = render(props);
assert.equal(findNodes(tree, (n) => n.type === 'div' && n.props.style && n.props.style.borderRadius === 8).length, 0, 'desk cleared');
assert.deepEqual(frame.posted.pop(), { type: 'dsh-pick', on: false }, 'picker switched off');

// 6. Without the sessions service the pane must say so instead of losing the work.
props = { ...props, deliver: undefined };
tree = render(props);
for (const fn of listeners.message) fn({ data: { type: 'dsh-picked', payload }, source: frameWin });
tree = render(props);
byText(tree, 'Отправить')[0].props.onClick();
tree = render(props);
const error = findNodes(tree, (n) => (n.children || []).flat(Infinity)
  .some((child) => typeof child === 'string' && child.startsWith('Отправка недоступна')));
assert.equal(error.length, 1, 'a missing conversation service is reported');
assert.equal(writes.length, 1, 'nothing was sent');
assert.equal(byTitle(tree, 'Комментировать').length, 1, 'the annotation is still held, not dropped');

console.log('artifact-panes annotations: OK');
console.log('  message length:', text.length, 'chars ·', text.split('\n').length, 'lines');
process.exit(0);
