// Isolated check of dsh-artifact-panes' host half: mounts ./index.js on a
// fake Cordis ctx plus a fake webServer, then drives both routes (list the
// library, store a questionnaire answer) against a throwaway workspace.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolate from the real session index: only the live sessions below exist here.
// A unique directory per run, so concurrent or failed runs cannot erase each
// other's fixtures.
process.env.DSH_HOME = await mkdtemp(path.join(tmpdir(), 'artifact-panes-no-dsh-home-'));
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
const sessionsList = [{ id: 'sess-1', header: { cwd: root, createdAt: 1 } }];
const ctx = {
  effect(fn) { return fn(); },
  // the host plugin also injects the tools service for the artifact tools
  inject(services, callback) { if (services.includes('tools')) callback(ctx); return () => {}; },
  get(name) {
    if (name === 'webServer') return { register(def) { routes.set(def.path, def); return () => routes.delete(def.path); } };
    if (name === 'fs') return fs;
    if (name === 'sessions') return { list: () => sessionsList };
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

// A second workspace: the picker must list it, switch the listing to it by
// session id, and add recent HTML outside artifacts/ only when asked.
{
  const ws2 = await mkdtemp(path.join(tmpdir(), 'artifact-panes-ws2-'));
  await mkdir(path.join(ws2, 'artifacts'), { recursive: true });
  await writeFile(path.join(ws2, 'artifacts', 'second.html'),
    '<html><head><title>Second workspace</title></head><body></body></html>', 'utf8');
  await writeFile(path.join(ws2, 'recent-outside.html'),
    '<html><head><title>Outside recent</title></head><body></body></html>', 'utf8');
  sessionsList.push({ id: 'sess-2', header: { cwd: ws2, createdAt: 2 } });

  const ws = response();
  await routes.get('/artifact-panes/workspaces').handler({ method: 'GET' }, ws.res);
  const list = JSON.parse(ws.out.body);
  assert.equal(list.ok, true);
  assert.equal(list.workspaces.length, 2, 'both workspaces are offered');
  const second = list.workspaces.find((item) => item.sessionId === 'sess-2');
  assert.ok(second, 'the second session is present');
  assert.ok(second.label.length > 0, 'the label is derived from the folder');
  assert.equal(second.hasArtifacts, true);

  const bySession = response();
  await routes.get('/artifact-panes/library').handler({ method: 'GET', url: '/artifact-panes/library?sessionId=sess-2' }, bySession.res);
  const scoped = JSON.parse(bySession.out.body);
  assert.equal(scoped.ok, true);
  assert.ok(scoped.root.endsWith('artifacts'), 'root points at the artifacts folder');
  assert.ok(scoped.root.includes(path.basename(ws2)), 'root follows the requested session');
  assert.ok(scoped.artifacts.some((item) => item.title === 'Second workspace'));

  const plain = response();
  await routes.get('/artifact-panes/library').handler({ method: 'GET', url: '/artifact-panes/library?sessionId=sess-2' }, plain.res);
  assert.equal(JSON.parse(plain.out.body).artifacts.some((item) => item.outside), false, 'outside files stay out by default');

  const withOutside = response();
  await routes.get('/artifact-panes/library').handler({ method: 'GET', url: '/artifact-panes/library?sessionId=sess-2&outside=1' }, withOutside.res);
  const expanded = JSON.parse(withOutside.out.body);
  assert.equal(expanded.outside, true);
  const outsideItem = expanded.artifacts.find((item) => item.outside);
  assert.ok(outsideItem, 'the recent HTML outside artifacts/ is listed');
  assert.ok(outsideItem.path.endsWith('recent-outside.html'));

  await rm(ws2, { recursive: true, force: true });
}

// The session-root metadata route: a live session answers with its cwd, an
// unknown id is 404, a missing id is 400, and only GET is allowed.
{
  const ask = async (query) => {
    const { out, res } = response();
    await routes.get('/artifact-panes/session-root').handler({ method: 'GET', url: '/artifact-panes/session-root' + query }, res);
    return { code: out.code, payload: JSON.parse(out.body) };
  };
  const live = await ask('?sessionId=sess-1');
  assert.equal(live.code, 200);
  assert.equal(live.payload.ok, true);
  assert.equal(live.payload.cwd, root);
  assert.equal((await ask('?sessionId=missing')).code, 404);
  assert.equal((await ask('')).code, 400);
  const wrong = response();
  await routes.get('/artifact-panes/session-root').handler({ method: 'POST' }, wrong.res);
  assert.equal(wrong.out.code, 405);
}

// A closed workspace: readable by path (`root`), never by session. The fake
// session index below is the only thing that makes it known, exactly like a
// session that was closed before this process started.
{
  const closedRoot = await mkdtemp(path.join(tmpdir(), 'artifact-panes-closed-'));
  const closedId = 'session-closed-fixture-0001';
  const indexDir = path.join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions');
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(indexDir, closedId + '.json'),
    JSON.stringify({ record: { identity: { cwd: closedRoot } } }), 'utf8');

  await mkdir(path.join(closedRoot, 'artifacts'), { recursive: true });
  await writeFile(path.join(closedRoot, 'artifacts', 'closed-demo.html'),
    '<!doctype html><html><head><title>Закрытый · артефакт</title></head><body>closed</body></html>', 'utf8');
  await writeFile(path.join(closedRoot, 'artifacts', 'notes.txt'), 'plain text is not an artifact', 'utf8');
  await writeFile(path.join(closedRoot, 'artifacts', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(closedRoot, 'recent-outside.html'),
    '<html><head><title>Closed · outside</title></head><body></body></html>', 'utf8');
  // Just over the 5 MB read cap: the host must refuse before encoding it.
  await writeFile(path.join(closedRoot, 'artifacts', 'big.html'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));

  const askLibrary = async (query) => {
    const { out, res } = response();
    await routes.get('/artifact-panes/library').handler({ method: 'GET', url: '/artifact-panes/library' + query }, res);
    return { code: out.code, payload: safeParse(out.body) };
  };
  const askFile = async (query) => {
    const { out, res } = response();
    await routes.get('/artifact-panes/file').handler({ method: 'GET', url: '/artifact-panes/file' + query }, res);
    return { code: out.code, payload: safeParse(out.body) };
  };
  const enc = (value) => encodeURIComponent(value);

  // The closed workspace is offered by the picker, without a session id.
  const ws = response();
  await routes.get('/artifact-panes/workspaces').handler({ method: 'GET' }, ws.res);
  const offered = JSON.parse(ws.out.body).workspaces.find((item) => item.cwd === closedRoot);
  assert.ok(offered, 'the closed workspace is offered');
  assert.equal(offered.live, false);
  assert.equal(offered.sessionId, null);
  assert.equal(offered.indexId, closedId);

  // /library?root= lists it through plain node:fs.
  const listed = await askLibrary('?root=' + enc(closedRoot));
  assert.equal(listed.code, 200);
  assert.equal(listed.payload.ok, true);
  assert.equal(listed.payload.root, closedRoot.replace(/[\\/]+$/, '') + '/artifacts');
  const titles = listed.payload.artifacts.map((item) => item.title);
  assert.ok(titles.includes('Закрытый · артефакт'), 'the closed workspace title is read');
  const rels = listed.payload.artifacts.map((item) => item.rel);
  assert.ok(rels.includes('artifacts/closed-demo.html'), 'entries keep a workspace-relative address');
  assert.equal(listed.payload.artifacts.some((item) => item.outside), false, 'outside stays out by default');

  const withOutside = await askLibrary('?root=' + enc(closedRoot) + '&outside=1');
  assert.equal(withOutside.payload.outside, true);
  const outsideItem = withOutside.payload.artifacts.find((item) => item.outside);
  assert.ok(outsideItem, 'the recent HTML outside artifacts/ is listed for a closed workspace too');
  assert.ok(outsideItem.rel.endsWith('recent-outside.html'));

  // A root that is neither live nor in the index is refused by both routes.
  const foreign = await mkdtemp(path.join(tmpdir(), 'artifact-panes-foreign-'));
  await mkdir(path.join(foreign, 'artifacts'), { recursive: true });
  await writeFile(path.join(foreign, 'artifacts', 'x.html'), '<html></html>', 'utf8');
  assert.equal((await askLibrary('?root=' + enc(foreign))).code, 403);
  const foreignFile = await askFile('?root=' + enc(foreign) + '&path=artifacts/x.html');
  assert.equal(foreignFile.code, 403);
  assert.equal(foreignFile.payload.error, 'root not allowed');

  // Allowed: the artifact itself, with its bytes and mime.
  const demo = await askFile('?root=' + enc(closedRoot) + '&path=artifacts/closed-demo.html');
  assert.equal(demo.code, 200);
  assert.equal(demo.payload.ok, true);
  assert.equal(demo.payload.mime, 'text/html; charset=utf-8');
  assert.match(Buffer.from(demo.payload.dataBase64, 'base64').toString('utf8'), /Закрытый · артефакт/);
  // Outside artifacts/ is readable too (the owner's decision), because the list
  // offers it and a row that cannot be opened is a dead end.
  const outsideRead = await askFile('?root=' + enc(closedRoot) + '&path=recent-outside.html');
  assert.equal(outsideRead.code, 200);
  assert.match(Buffer.from(outsideRead.payload.dataBase64, 'base64').toString('utf8'), /Closed · outside/);

  // Malformed paths: absolute, traversal, empty segments.
  for (const badPath of ['../outside.html', 'artifacts/../recent-outside.html', '/abs.html', 'C:/abs.html', 'artifacts//x.html']) {
    const result = await askFile('?root=' + enc(closedRoot) + '&path=' + enc(badPath));
    assert.equal(result.code, 400, 'malformed path: ' + badPath);
  }
  assert.equal((await askFile('?root=' + enc(closedRoot))).code, 400, 'path is required');
  assert.equal((await askFile('?path=artifacts/closed-demo.html')).code, 400, 'root is required');
  assert.equal((await askFile('?root=not-absolute&path=artifacts/closed-demo.html')).code, 400);

  // Only HTML: a text or image file with an HTML name would be fine, but another
  // extension is a different tab's job.
  assert.equal((await askFile('?root=' + enc(closedRoot) + '&path=artifacts/notes.txt')).code, 400);
  assert.equal((await askFile('?root=' + enc(closedRoot) + '&path=artifacts/pic.png')).code, 400);

  // Size cap, missing file and a directory that looks like an artifact.
  const big = await askFile('?root=' + enc(closedRoot) + '&path=artifacts/big.html');
  assert.equal(big.code, 413);
  assert.equal(big.payload.error, 'file too large');
  assert.equal((await askFile('?root=' + enc(closedRoot) + '&path=artifacts/missing.html')).code, 404);
  await mkdir(path.join(closedRoot, 'artifacts', 'looks-like.html'), { recursive: true });
  assert.equal((await askFile('?root=' + enc(closedRoot) + '&path=artifacts/looks-like.html')).code, 404);

  // A symlinked directory escaping the workspace resolves outside it and is
  // refused. Junction creation needs no privilege on Windows; a host without it
  // reports the check as skipped instead of failing the suite.
  let junctionMade = false;
  try {
    const escapeTarget = await mkdtemp(path.join(tmpdir(), 'artifact-panes-escape-'));
    await writeFile(path.join(escapeTarget, 'secret.html'), '<html>secret</html>', 'utf8');
    await symlink(escapeTarget, path.join(closedRoot, 'artifacts', 'escape'), 'junction');
    junctionMade = true;
  } catch (error) {
    console.log('  symlink containment check skipped:', String(error && error.code));
  }
  if (junctionMade) {
    const escaped = await askFile('?root=' + enc(closedRoot) + '&path=artifacts/escape/secret.html');
    assert.equal(escaped.code, 403, 'a symlink out of the workspace is refused');
    assert.equal(escaped.payload.error, 'outside workspace');
  }

  // Wrong method is rejected without touching the disk.
  const wrongMethod = response();
  await routes.get('/artifact-panes/file').handler({ method: 'POST' }, wrongMethod.res);
  assert.equal(wrongMethod.out.code, 405);

  // The fixture root is not a live session, so the session-scoped list is
  // unaffected and the known-root rule does not widen it.
  const liveScoped = await askLibrary('?sessionId=sess-1');
  assert.equal(liveScoped.code, 200);
  assert.ok(liveScoped.payload.artifacts.some((item) => item.title === 'Демо · артефакт'));

  await rm(foreign, { recursive: true, force: true });
  await rm(closedRoot, { recursive: true, force: true });
  await rm(process.env.DSH_HOME, { recursive: true, force: true });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (e) { return undefined; }
}

await rm(root, { recursive: true, force: true });
console.log('artifact-panes host module: OK');
console.log('  routes:', [...routes.keys()].join(', '));
