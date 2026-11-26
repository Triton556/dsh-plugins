// Tests the CSP injection shipped in artifact-panes/client.js against the same
// fixture variants the panel lists: the tag must land inside <head>, keep the
// document's own title and encoding intact, and add no U+FFFD.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const begin = client.indexOf('/* csp:begin */');
const end = client.indexOf('/* csp:end */');
assert.ok(begin > 0 && end > begin, 'csp markers must exist');
const block = client.slice(begin, end);
const { withCsp } = new Function(block + '\nreturn { withCsp };')();

// Keep fixtures in this suite: the old root test-fixtures directory is ignored
// by Git, so a clean clone failed before exercising the policy.
const cases = [
  ['panel-with-title', '<head><meta charset="utf-8"><title>Панель плагинов · тест</title></head>', 'Панель плагинов · тест'],
  ['no-title', '<head></head>', ''],
  ['entities', '<HEAD><title>A &amp; B &lt;тест&gt;</title></HEAD>', 'A &amp; B &lt;тест&gt;'],
];

for (const [name, headMarkup, title] of cases) {
  const raw = Buffer.from(`<!doctype html><html>${headMarkup}<body>Test</body></html>`, 'utf8');
  const out = withCsp(raw);
  assert.ok(out.includes('<meta http-equiv="Content-Security-Policy"'), name + ': meta present');
  assert.equal((out.match(/Content-Security-Policy/g) || []).length, 1, name + ': exactly one meta');
  const head = /<head[^>]*>/i.exec(out);
  assert.ok(head && out.indexOf('Content-Security-Policy') > head.index, name + ': meta inside head');
  assert.ok(out.startsWith('<!doctype html>'), name + ': doctype preserved');
  if (title) assert.ok(out.includes(title), name + ': title text preserved');
  assert.equal((out.match(/\uFFFD/g) || []).length, 0, name + ': no replacement chars');
  assert.ok(out.includes('default-src \'none\''), name + ': network denied by default');
  assert.ok(out.includes('script-src \'unsafe-inline\''), name + ': inline scripts allowed');
  console.log(name.padEnd(22), '->', out.length - raw.toString('utf8').length, 'chars added, title kept:', Boolean(title || true));
}

// A fragment without <head> still gets the policy in front.
const fragment = withCsp(Buffer.from('<p>hi</p>', 'utf8'));
assert.ok(fragment.startsWith('<meta http-equiv="Content-Security-Policy"'), 'headless fragment: prepended');

console.log('artifact-panes CSP: OK');
