// Behavioural check of the comment picker that gets serialised INTO the
// artifact document. It is the riskiest piece (it runs inside a sandboxed
// iframe we cannot inspect afterwards), so it is exercised against a small DOM
// stub: activation, hover outline, click capture, Alt+click parenting, Escape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8');

// Pull the real function out of the bundle by brace matching.
const start = source.indexOf('function dshCommentPicker(config) {');
assert.ok(start > 0, 'dshCommentPicker exists in client.js');
let depth = 0;
let end = start;
for (let i = source.indexOf('{', start); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') {
    depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
}
const pickerSource = source.slice(start, end);
assert.equal(pickerSource.includes('</script'), false, 'the injected script cannot close its own tag');
const picker = new Function('return (' + pickerSource + ')')();
assert.equal(typeof picker, 'function');

// ---- DOM stub ------------------------------------------------------------
function makeEl(tag) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    _attrs: {},
    style: {},
    children: [],
    textContent: '',
    innerText: '',
    outerHTML: '<' + tag + '></' + tag + '>',
    parentElement: null,
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 30 }; },
  };
}

const body = makeEl('body');
const page = makeEl('div');
page.id = 'app';
const button = makeEl('button');
button.className = 'send primary';
button.setAttribute('class', 'send primary');
button.id = 'send';
button.innerText = 'Отправить ответы';
button.outerHTML = '<button class="send primary" id="send">Отправить ответы</button>';
page.appendChild(button);
body.appendChild(page);

const docListeners = {};
const document = {
  body,
  documentElement: makeEl('html'),
  createElement: (tag) => makeEl(tag),
  addEventListener: (type, fn) => { docListeners[type] = fn; },
  getComputedStyle: () => ({
    getPropertyValue(name) {
      const table = { display: 'inline-flex', color: 'rgb(255, 255, 255)', 'background-color': 'rgba(0, 0, 0, 0)', width: '100px' };
      return table[name] || '';
    },
  }),
};
const windowListeners = {};
const posted = [];
const window = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener: (type, fn) => { windowListeners[type] = fn; },
};
const parent = { postMessage: (msg) => posted.push(msg) };

new Function('window', 'document', 'parent', 'getComputedStyle', 'config',
  pickerSource + '\ndshCommentPicker(config);')(window, document, parent, document.getComputedStyle,
  { marker: 'test', hint: 'Комментарий: клик по элементу' });

// 1. Inert at first: a click is not intercepted.
let prevented = false;
docListeners.click({ target: button, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
assert.equal(prevented, false, 'picker is inert until enabled');
assert.equal(posted.length, 0);

// 2. Enabling shows the hint.
const send = (data) => windowListeners.message({ data });
send({ type: 'dsh-pick', on: true });
const hint = body.children.find((el) => el.textContent === 'Комментарий: клик по элементу');
assert.ok(hint, 'hint banner is mounted');
assert.equal(hint.style.display, 'block', 'hint is visible while picking');
assert.equal(document.documentElement.style.cursor, 'crosshair');

// 3. Hover outlines the element under the cursor.
docListeners.mousemove({ target: button });
const outline = body.children.find((el) => el.getAttribute('data-dsh-picker') === '1' && el !== hint);
assert.ok(outline, 'highlight box is mounted');
assert.equal(outline.style.display, 'block');
assert.equal(outline.style.width, '100px');
assert.equal(outline.style.left, '10px');

// 4. A click reports what was clicked and stops the page's own behaviour.
prevented = false;
let stopped = false;
docListeners.click({
  target: button,
  altKey: false,
  preventDefault: () => { prevented = true; },
  stopPropagation: () => { stopped = true; },
});
assert.equal(prevented, true, 'the page click is swallowed');
assert.equal(stopped, true, 'the page click does not bubble');
const picked = posted.find((m) => m.type === 'dsh-picked');
assert.ok(picked, 'the picked element is reported');
const p = picked.payload;
assert.equal(p.tag, 'button');
assert.equal(p.id, 'send');
assert.equal(p.classes, 'send primary');
assert.equal(p.selector, 'button#send', 'an id is enough on its own');
assert.equal(p.text, 'Отправить ответы');
assert.equal(p.rect.w, 100);
assert.equal(p.rect.h, 30);
assert.match(p.styleText, /display:inline-flex/);
assert.equal(p.html, '<button class="send primary" id="send">Отправить ответы</button>');
assert.equal(p.marker, 'test');

// 5. Alt+click climbs to the parent, so a wrapper can be selected too.
docListeners.click({ target: button, altKey: true, preventDefault: () => {}, stopPropagation: () => {} });
const climbed = posted.filter((m) => m.type === 'dsh-picked').pop().payload;
assert.equal(climbed.tag, 'div');
assert.equal(climbed.id, 'app');

// 6. Escape leaves the mode and tells the pane.
docListeners.keydown({ key: 'Escape' });
assert.equal(document.documentElement.style.cursor, '', 'cursor restored');
assert.equal(posted.filter((m) => m.type === 'dsh-pick-state').pop().on, false);

prevented = false;
docListeners.click({ target: button, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
assert.equal(prevented, false, 'the page works again after leaving the mode');

console.log('artifact-panes picker: OK');
console.log('  selector:', p.selector);
console.log('  style:', p.styleText.slice(0, 60));
