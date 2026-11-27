import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('annotation PNG storage and thumbnail requests stay with the originating workspace', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'artifact-annotations-'));
  const A = path.join(tmp, 'A'), B = path.join(tmp, 'B'), home = path.join(tmp, 'profile');
  await Promise.all([mkdir(A), mkdir(B), mkdir(home)]);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(async () => {
    Object.defineProperty(process, 'platform', platform);
    mock.restoreAll();
    syncBuiltinESMExports();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR34AAAAASUVORK5CYII=', 'base64');
  const targets = [];
  mock.method(childProcess, 'execFile', (program, args, options, cb) => {
    assert.equal(program, 'powershell.exe');
    const file = args[args.indexOf('-Out') + 1];
    targets.push(file);
    writeFile(file, png).then(() => cb(null), cb);
  });
  syncBuiltinESMExports();
  const { apply } = await import('../index.js');
  const routes = new Map();
  const sessionA = { id: 'session-a', header: { cwd: A, createdAt: 1 } };
  const sessions = [sessionA, { id: 'session-b', header: { cwd: B, createdAt: 2 } }];
  apply({
    effect(fn) { return fn(); },
    inject() { return () => {}; },
    get(name) {
      if (name === 'webServer') return { register(def) { routes.set(def.path, def); return () => {}; } };
      if (name === 'sessions') return { list: () => sessions };
      return undefined;
    },
  });
  async function call(name, method, { query, body } = {}) {
    const route = '/artifact-panes/' + name;
    const req = {
      url: query ? route + '?' + new URLSearchParams(query) : route,
      method,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
    };
    const out = {};
    await routes.get(route).handler(req, {
      writeHead(status, headers) { Object.assign(out, { status, headers }); },
      end(value) { out.body = value; },
    });
    return out;
  }
  const shot = (sessionId, relative) => call('shot', 'GET', { query: { path: relative, ...(sessionId ? { sessionId } : {}) } });
  const capture = (sessionId) => call('screenshot', 'POST', { body: { sessionId, rect: { x: 12, y: 12, w: 20, h: 20 } } });

  // Enter the Windows host branch on all CI platforms, but stub only the OS
  // capture helper itself. Route resolution and filesystem I/O are real.
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  assert.equal((await capture()).status, 400);
  assert.equal((await capture('session-missing')).status, 404);
  const saved = await capture(sessionA.id);
  assert.equal(saved.status, 200, String(saved.body));
  const relative = JSON.parse(saved.body).path;
  const dirA = path.join(A, '.dsh', 'artifact-panes', 'shots');
  const dirB = path.join(B, '.dsh', 'artifact-panes', 'shots');
  assert.equal(targets.length, 1);
  assert.deepEqual(await readFile(path.join(dirA, path.basename(relative))), png);
  assert.deepEqual(await readdir(B), []);
  assert.equal((await shot('session-b', relative)).status, 404);
  assert.equal((await shot('', relative)).status, 400);

  // Even an identically named file in a later workspace cannot shadow A.
  await mkdir(dirB, { recursive: true });
  await writeFile(path.join(dirB, path.basename(relative)), Buffer.from('B fixture'));
  const original = await shot(sessionA.id, relative);
  assert.equal(original.headers['Content-Type'], 'image/png');
  assert.deepEqual(original.body, png);
  assert.equal((await shot('session-missing', relative)).status, 404);

  const index = path.join(home, 'storages', 'session_projcache', 'sessions');
  await mkdir(index, { recursive: true });
  await writeFile(path.join(index, sessionA.id + '.json'), JSON.stringify({ record: { identity: { cwd: A } } }));
  sessions.shift();
  assert.deepEqual((await shot(sessionA.id, relative)).body, png, 'closed A retains its original thumbnail');
  assert.equal((await capture(sessionA.id)).status, 404, 'closed sessions are read-only');
  assert.equal(targets.length, 1);
});
