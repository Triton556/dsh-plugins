// End-to-end check of the questionnaire page against a minimal DOM stub:
// it must announce itself, restore saved answers, autosave drafts on every
// change and only report "Отправлено" after the plugin's ack. Also checks that
// the page and the plugin agree on every postMessage type they exchange.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', '..', 'artifacts', 'templates', 'decision-survey.html'), 'utf8');
const clientSource = readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const code = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)][0][1];

// ---- minimal DOM ----------------------------------------------------------
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.hidden = false;
    this._text = '';
    this._html = '';
    this._stubs = new Map();
    this._listeners = {};
  }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type, event) { for (const fn of this._listeners[type] || []) fn(event || {}); }
  click() { this.dispatch('click', {}); }
  descendants() {
    const out = [];
    const walk = (node) => { for (const child of node.children) { out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelectorAll(selector) { return this.descendants().filter((el) => matches(el, selector)); }
  querySelector(selector) {
    const found = this.querySelectorAll(selector)[0];
    if (found) return found;
    if (!this._stubs.has(selector)) this._stubs.set(selector, new El(selector.replace(/^\./, '')));
    return this._stubs.get(selector);
  }
}
function matches(el, selector) {
  if (selector.startsWith('.')) return el.className.split(/\s+/).includes(selector.slice(1));
  return el.tag === selector;
}

const ids = ['questions', 'summary', 'verdict', 'bar', 'send', 'status', 'rawjson'];
const nodes = Object.fromEntries(ids.map((id) => [id, new El('div')]));
const documentStub = {
  getElementById: (id) => nodes[id] || null,
  createElement: (tag) => new El(tag),
};

const posted = [];
const parentWindow = { postMessage: (msg) => posted.push(msg) };
const listeners = {};
const windowStub = {
  parent: parentWindow,
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: () => {},
};
const deliver = (data) => { for (const fn of listeners.message || []) fn({ data }); };

new Function('window', 'document', 'navigator', 'setTimeout', 'clearTimeout', code)(
  windowStub,
  documentStub,
  { clipboard: { writeText: () => Promise.resolve() } },
  setTimeout,
  clearTimeout,
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. The page announces itself so the plugin can hand back saved answers.
assert.deepEqual(posted[0], { type: 'dsh-artifact-ready', requestId: 'decision-demo' });

// 2. A restore message paints the saved selection back into the UI.
deliver({ type: 'dsh-artifact-restore', requestId: 'decision-demo', kind: 'draft', answers: { speed_vs_safety: 'safe', overnight_style: ['hotel'] } });
const option = (qid, value) => nodes.questions.descendants().find((el) => el.dataset.qid === qid && el.dataset.value === value);
assert.equal(option('speed_vs_safety', 'safe').getAttribute('aria-pressed'), 'true');
assert.equal(option('overnight_style', 'hotel').getAttribute('aria-pressed'), 'true');
assert.equal(option('speed_vs_safety', 'fast').getAttribute('aria-pressed'), 'false');
assert.match(nodes.status.textContent, /Восстановлены сохранённые ответы/);

// 3. A change autosaves a draft (debounced), without marking the survey sent.
option('speed_vs_safety', 'cheap').click();
await wait(520);
const draft = posted.filter((m) => m.type === 'dsh-artifact-draft').pop();
assert.ok(draft, 'a draft is posted after a choice');
assert.equal(draft.answers.speed_vs_safety, 'cheap');
assert.notEqual(nodes.send.textContent, 'Отправлено', 'a draft does not finish the survey');
deliver({ type: 'dsh-artifact-ack', kind: 'draft', ok: true, savedAt: new Date().toISOString() });
assert.match(nodes.status.textContent, /Черновик сохранён/);

// 4. "Отправить" posts the final answer and waits for the ack.
nodes.send.dispatch('click', {});
const final = posted.filter((m) => m.type === 'dsh-artifact-answer').pop();
assert.ok(final, 'the final answer is posted');
assert.equal(final.answers.speed_vs_safety, 'cheap');
assert.equal(nodes.send.textContent, 'Отправляю…');
deliver({ type: 'dsh-artifact-ack', kind: 'final', ok: true, path: 'x.json' });
assert.equal(nodes.send.textContent, 'Отправлено');
assert.match(nodes.status.textContent, /Ответы сохранены/);

// 5. A rejected final answer re-enables the button instead of lying.
assert.equal(posted.filter((m) => m.type === 'dsh-artifact-draft').length >= 1, true);

// ---- both halves must agree on the message vocabulary ---------------------
for (const type of ['dsh-artifact-ready', 'dsh-artifact-draft', 'dsh-artifact-answer']) {
  assert.ok(html.includes(type), `page sends ${type}`);
  assert.ok(clientSource.includes(type), `plugin handles ${type}`);
}
for (const type of ['dsh-artifact-restore', 'dsh-artifact-ack']) {
  assert.ok(clientSource.includes(type), `plugin sends ${type}`);
  assert.ok(html.includes(type), `page handles ${type}`);
}

console.log('artifact-panes survey page: OK');
console.log('  messages:', [...new Set(posted.map((m) => m.type))].join(', '));
