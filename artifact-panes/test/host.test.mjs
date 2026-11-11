// Isolated check of dsh-artifact-panes' host half: mounts ./index.js on a
// fake Cordis ctx plus a fake webServer, then drives both routes (list the
// library, store a questionnaire answer) against a throwaway workspace.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { apply } = await import('../index.js');
assert.equal(typeof apply, 'function');

const root = await mkdtemp(path.join(tmpdir(), 'artifact-panes-test-'));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(
  path.join(root, 'artifacts', 'demo.html'),
  '<!doctype html><html><head><title>Демо · артефакт</title></head><body>ok</body></html>',
  'utf8',
);

// Fs stub mirroring the real face: resolve → target, listDir(target), readText(target).
const fs = {
  async resolve(p) {
    const target = { targetKey: 'key:' + p, path: p };
    return target;
  },
  async stat(target) { return { type: 'directory', target }; },
  async listDir(target) {
    const dir = target.path;
    const { readdir: rd } = await import('node:fs/promises');
    const names = await rd(dir, { withFileTypes: true });
    return names.map((entry, i) => {
      const full = path.join(dir, entry.name);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        target: { targetKey: 'key:' + full, path: full },
        version: `0:${i}:${entry.name.length}:${Date.now()}e6:0`,
        size: 42,
      };
    });
  },
  async readText(target) { return readFile(target.path, 'utf8'); },
  processPath(target) { return target.path; },
};

const routes = new Map();
const ctx = {
  effect(fn) { return fn(); },
  get(name) {
    if (name === 'webServer') return { register(def) { routes.set(def.path, def); return () => routes.delete(def.path); } };
    if (name === 'fs') return fs;
    if (name === 'sessions') return { list: () => [{ header: { cwd: root, createdAt: 1 } }] };
    if (name === 'sandboxPolicy') return { workspaceRoot: root };
    return undefined;
  },
};
apply(ctx);
assert.ok(routes.has('/artifact-panes/library'), 'library route registered');
assert.ok(routes.has('/artifact-panes/answer'), 'answer route registered');
assert.equal(routes.get('/artifact-panes/library').kind, 'exact');

function response() {
  const out = { code: 0, headers: null, body: '' };
  return {
    out,
    res: {
      writeHead(code, headers) { out.code = code; out.headers = headers; },
      end(body) { out.body = String(body || ''); },
    },
  };
}

// GET library → the artifacts/ folder with the <title> as the label.
{
  const { out, res } = response();
  await routes.get('/artifact-panes/library').handler({ method: 'GET' }, res);
  const payload = JSON.parse(out.body);
  assert.equal(out.code, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.artifacts.length, 1);
  assert.equal(payload.artifacts[0].title, 'Демо · артефакт');
  assert.ok(payload.artifacts[0].mtime > 0, 'mtime comes from the FsVersion');
}

// POST answer → JSON under .dsh/artifact-panes/answers/.
{
  const { out, res } = response();
  const body = JSON.stringify({ requestId: 'survey/v1', sessionId: 'sess-1', answers: { q1: 'b', q2: ['x', 'y'] } });
  const req = {
    method: 'POST',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(body, 'utf8'); },
  };
  await routes.get('/artifact-panes/answer').handler(req, res);
  const payload = JSON.parse(out.body);
  assert.equal(out.code, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.kind, 'final');
  const dir = path.join(root, '.dsh', 'artifact-panes', 'answers');
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /-survey-v1\.json$/);
  const saved = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
  assert.deepEqual(saved.answers, { q1: 'b', q2: ['x', 'y'] });
  assert.equal(saved.sessionId, 'sess-1');
}

// POST draft → one stable file per questionnaire, overwritten on every change.
{
  const { out, res } = response();
  const body = JSON.stringify({ requestId: 'decision-demo', sessionId: 'sess-1', answers: { q1: 'fast' } });
  const req = {
    method: 'POST',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(body, 'utf8'); },
  };
  await routes.get('/artifact-panes/draft').handler(req, res);
  assert.equal(out.code, 200);
  assert.equal(JSON.parse(out.body).kind, 'draft');
  const draftFile = path.join(root, '.dsh', 'artifact-panes', 'drafts', 'decision-demo.json');
  const first = JSON.parse(await readFile(draftFile, 'utf8'));
  assert.deepEqual(first.answers, { q1: 'fast' });

  const second = response();
  const again = JSON.stringify({ requestId: 'decision-demo', answers: { q1: 'fast', q2: ['hotel'] } });
  await routes.get('/artifact-panes/draft').handler({
    method: 'POST',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(again, 'utf8'); },
  }, second.res);
  const drafts = await readdir(path.join(root, '.dsh', 'artifact-panes', 'drafts'));
  assert.equal(drafts.length, 1, 'the draft is overwritten, not appended');
  const latest = JSON.parse(await readFile(draftFile, 'utf8'));
  assert.deepEqual(latest.answers, { q1: 'fast', q2: ['hotel'] });
}

// GET state → the freshest saved answers, so a reloaded page can restore them.
{
  const ask = async (query) => {
    const { out, res } = response();
    await routes.get('/artifact-panes/state').handler({ method: 'GET', url: '/artifact-panes/state' + query }, res);
    return { code: out.code, payload: JSON.parse(out.body) };
  };
  const draft = await ask('?requestId=decision-demo');
  assert.equal(draft.code, 200);
  assert.equal(draft.payload.ok, true);
  assert.equal(draft.payload.kind, 'draft');
  assert.deepEqual(draft.payload.answers, { q1: 'fast', q2: ['hotel'] });

  const final = await ask('?requestId=survey-v1');
  assert.equal(final.payload.kind, 'final');
  assert.deepEqual(final.payload.answers, { q1: 'b', q2: ['x', 'y'] });

  const missing = await ask('?requestId=never-saved');
  assert.equal(missing.payload.ok, false);
  assert.equal(missing.payload.error, 'nothing saved yet');

  const noId = await ask('');
  assert.equal(noId.code, 400);
}

// Wrong method and broken JSON are rejected, nothing is written.
{
  const { out, res } = response();
  await routes.get('/artifact-panes/answer').handler({ method: 'GET' }, res);
  assert.equal(out.code, 405);

  const bad = response();
  const req = {
    method: 'POST',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from('{oops', 'utf8'); },
  };
  await routes.get('/artifact-panes/answer').handler(req, bad.res);
  assert.equal(bad.out.code, 400);
  const files = await readdir(path.join(root, '.dsh', 'artifact-panes', 'answers'));
  assert.equal(files.length, 1, 'rejected payloads leave no file');
}

await rm(root, { recursive: true, force: true });
console.log('artifact-panes host module: OK');
console.log('  routes:', [...routes.keys()].join(', '));
