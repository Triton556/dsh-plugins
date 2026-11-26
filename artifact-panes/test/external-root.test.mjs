// External artifacts root: a workspace declares the physical folder its
// logical `artifacts/` stands for in `.dsh/artifact-panes.json`. Without that
// declaration a junction pointing outside stays refused; with it, the same
// logical address must resolve, list and read through the new base.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = await mkdtemp(path.join(tmpdir(), 'artifact-panes-external-home-'));

const { apply } = await import('../index.js');
const { resolveArtifact, resolveArtifactLocation, listArtifacts } = await import('../tools/host.js');

const base = await mkdtemp(path.join(tmpdir(), 'artifact-panes-external-'));
const ws = path.join(base, 'workspace');
const ext = path.join(base, 'external-root');
const escape = path.join(base, 'escape-root');
const ws2 = path.join(base, 'workspace-declared-no-dir');
await mkdir(path.join(ws, '.dsh'), { recursive: true });
await mkdir(path.join(ext, 'island-gravity-audit-20261126'), { recursive: true });
await mkdir(path.join(ext, 'nested', 'deep'), { recursive: true });
await mkdir(escape, { recursive: true });
await mkdir(path.join(ws2, '.dsh'), { recursive: true });
await writeFile(path.join(ext, 'island-gravity-audit-20261126', 'index.html'),
  '<!doctype html><html><head><title>Остров · гравитация</title></head><body>island</body></html>', 'utf8');
await writeFile(path.join(ext, 'nested', 'deep', 'page.html'),
  '<!doctype html><html><head><title>Deep page</title></head><body>deep</body></html>', 'utf8');
await writeFile(path.join(ext, 'notes.txt'), 'plain text is not an artifact', 'utf8');
await writeFile(path.join(ext, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
await writeFile(path.join(ext, 'big.html'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
await writeFile(path.join(escape, 'secret.html'), '<html><head><title>Secret</title></head></html>', 'utf8');
// A junction inside the declared root that points outside it must not be walked
// through or served.
await symlink(escape, path.join(ext, 'escape'), 'junction');
// A file symlink inside the declared root that points outside it: neither its
// bytes nor its <title> may be served or listed.
let fileLinkMade = false;
try {
  await symlink(path.join(escape, 'secret.html'), path.join(ext, 'leak.html'), 'file');
  fileLinkMade = true;
} catch (error) {
  console.log('  file symlink check skipped:', String(error && error.code));
}
// The workspace keeps its historical junction, and now declares the root.
await symlink(ext, path.join(ws, 'artifacts'), 'junction');
await writeFile(path.join(ws, '.dsh', 'artifact-panes.json'), JSON.stringify({ artifactsRoot: ext }), 'utf8');
await writeFile(path.join(ws2, '.dsh', 'artifact-panes.json'), JSON.stringify({ artifactsRoot: ext }), 'utf8');

const declaredPath = path.join(ws, '.dsh', 'artifact-panes.json');
const declaration = (value) => writeFile(declaredPath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

// A closed workspace is enough: both routes resolve `root=` through the index.
const indexDir = path.join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions');
await mkdir(indexDir, { recursive: true });
await writeFile(path.join(indexDir, 'session-external-0001.json'), JSON.stringify({ record: { identity: { cwd: ws } } }), 'utf8');
await writeFile(path.join(indexDir, 'session-external-0002.json'), JSON.stringify({ record: { identity: { cwd: ws2 } } }), 'utf8');
// An ordinary workspace with no artifacts folder at all: its root HTML must
// stay readable.
const noArtifacts = path.join(base, 'workspace-with-root-page');
await mkdir(noArtifacts, { recursive: true });
await writeFile(path.join(noArtifacts, 'root-page.html'),
  '<!doctype html><html><head><title>Root page</title></head><body>root</body></html>', 'utf8');
await writeFile(path.join(indexDir, 'session-external-0003.json'), JSON.stringify({ record: { identity: { cwd: noArtifacts } } }), 'utf8');
// A regular file named `artifacts` is not a folder to serve.
const fileRoot = path.join(base, 'workspace-artifacts-is-file');
await mkdir(fileRoot, { recursive: true });
await writeFile(path.join(fileRoot, 'artifacts'), 'not a folder', 'utf8');
await writeFile(path.join(indexDir, 'session-external-0004.json'), JSON.stringify({ record: { identity: { cwd: fileRoot } } }), 'utf8');

// The `/library?root=` and `/file` branches read through plain node:fs, so the
// fake `fs` service only has to answer the picker's `hasArtifacts` probe.
const fsService = {
  async resolve(p) { return { targetKey: 'key:' + p, path: p }; },
  async stat() { throw Object.assign(new Error('no local artifacts folder'), { code: 'ENOENT' }); },
  async listDir() { return []; },
  async readText() { return ''; },
  processPath(target) { return target.path; },
};
const routes = new Map();
const sessionsList = [];
const ctx = {
  effect(fn) { return fn(); },
  inject() { return () => {}; },
  get(name) {
    if (name === 'webServer') return { register(def) { routes.set(def.path, def); return () => routes.delete(def.path); } };
    if (name === 'fs') return fsService;
    if (name === 'sessions') return { list: () => sessionsList };
    if (name === 'sandboxPolicy') return { workspaceRoot: ws };
    return undefined;
  },
};
apply(ctx);
assert.ok(routes.has('/artifact-panes/library'));
assert.ok(routes.has('/artifact-panes/file'));

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
const askLibrary = async (query = '') => {
  const { out, res } = response();
  await routes.get('/artifact-panes/library').handler({ method: 'GET', url: '/artifact-panes/library' + query }, res);
  return { code: out.code, payload: JSON.parse(out.body) };
};
const askFile = async (query = '') => {
  const { out, res } = response();
  await routes.get('/artifact-panes/file').handler({ method: 'GET', url: '/artifact-panes/file' + query }, res);
  return { code: out.code, payload: JSON.parse(out.body) };
};
const enc = encodeURIComponent;
const session = { header: { cwd: ws } };
const extReal = await realpath(ext);

// ---- Tool functions: the host half used by dsh_artifact_* ----
{
  const resolved = await resolveArtifact(session, 'artifacts/island-gravity-audit-20261126/index.html');
  assert.equal(resolved.toLowerCase(), (await realpath(path.join(ext, 'island-gravity-audit-20261126', 'index.html'))).toLowerCase());
  assert.ok(path.isAbsolute(resolved));

  const location = await resolveArtifactLocation(session, 'artifacts/nested');
  assert.equal(location.toLowerCase(), (await realpath(path.join(ext, 'nested'))).toLowerCase());

  const listed = await listArtifacts(session, 50);
  const paths = listed.artifacts.map((item) => item.path);
  assert.ok(paths.includes('artifacts/island-gravity-audit-20261126/index.html'), 'the declared page is listed');
  assert.ok(paths.includes('artifacts/nested/deep/page.html'), 'nested pages are listed');
  assert.equal(paths.some((p) => p.includes('escape')), false, 'a junction inside the declared root is not walked');
  assert.equal(paths.some((p) => p.includes('leak')), false, 'a file link leaving the declared root is not listed');
  assert.equal(listed.truncated, false);

  // `..` is a malformed address before any filesystem access.
  await assert.rejects(resolveArtifact(session, 'artifacts/../outside.html'), (error) => error.code === 'PATH_OUT_OF_SCOPE');
  await assert.rejects(resolveArtifact(session, 'artifacts/island-gravity-audit-20261126/../../x.html'), (error) => error.code === 'PATH_OUT_OF_SCOPE');
  // Non-HTML is outside the logical namespace.
  await assert.rejects(resolveArtifact(session, 'artifacts/notes.txt'), (error) => error.code === 'PATH_OUT_OF_SCOPE');
}

// ---- The same workspace without a declaration keeps the old refusal ----
{
  await rm(declaredPath, { force: true });
  await assert.rejects(resolveArtifact(session, 'artifacts/island-gravity-audit-20261126/index.html'),
    (error) => error.code === 'PATH_OUT_OF_SCOPE' && /escapes workspace/.test(error.message));
  const file = await askFile('?root=' + enc(ws) + '&path=artifacts/island-gravity-audit-20261126/index.html');
  assert.equal(file.code, 403, 'junction out of the workspace stays 403 without a declaration');
  assert.equal(file.payload.error, 'outside workspace');
  const library = await askLibrary('?root=' + enc(ws));
  assert.equal(library.payload.ok, false);
  assert.equal(library.payload.error, 'artifacts root escapes workspace');
  await declaration({ artifactsRoot: ext });
}

// ---- Routes with the declaration: list, read, rel, titles ----
{
  const listed = await askLibrary('?root=' + enc(ws));
  assert.equal(listed.code, 200);
  assert.equal(listed.payload.ok, true);
  assert.equal(listed.payload.root, extReal, 'root is the declared physical folder');
  const rels = listed.payload.artifacts.map((item) => item.rel);
  assert.ok(rels.includes('artifacts/island-gravity-audit-20261126/index.html'), 'logical address stays artifacts/...');
  assert.ok(rels.includes('artifacts/nested/deep/page.html'));
  const big = listed.payload.artifacts.find((item) => /big\.html$/.test(item.path));
  assert.ok(big, 'the oversized page is listed');
  assert.equal(big.title, '', 'a 100 MB+ page is not decoded just to label the row');
  assert.equal(listed.payload.artifacts.some((item) => /escape/.test(item.path)), false, 'junction not walked');
  if (fileLinkMade) {
    assert.equal(listed.payload.artifacts.some((item) => /leak\.html$/.test(item.path)), false, 'a file link leaving the declared root is not listed');
    assert.equal(listed.payload.artifacts.some((item) => item.title === 'Secret'), false, 'its <title> is not read');
  }
  const island = listed.payload.artifacts.find((item) => /island/.test(item.path));
  assert.equal(island.title, 'Остров · гравитация');
  assert.ok(island.mtime > 0);

  const read = await askFile('?root=' + enc(ws) + '&path=artifacts/island-gravity-audit-20261126/index.html');
  assert.equal(read.code, 200);
  assert.equal(read.payload.mime, 'text/html; charset=utf-8');
  assert.match(Buffer.from(read.payload.dataBase64, 'base64').toString('utf8'), /island/);
  assert.equal(read.payload.path, 'artifacts/island-gravity-audit-20261126/index.html');
}

// ---- Negative cases ----
{
  const escapeRead = await askFile('?root=' + enc(ws) + '&path=artifacts/escape/secret.html');
  assert.equal(escapeRead.code, 403, 'realpath leaving the declared root is refused');
  assert.equal(escapeRead.payload.error, 'outside workspace');
  if (fileLinkMade) {
    const leakRead = await askFile('?root=' + enc(ws) + '&path=artifacts/leak.html');
    assert.equal(leakRead.code, 403, 'a file link leaving the declared root is refused');
  }

  for (const badPath of ['artifacts/../outside.html', '../outside.html', 'artifacts/../../x.html']) {
    assert.equal((await askFile('?root=' + enc(ws) + '&path=' + enc(badPath))).code, 400, 'traversal: ' + badPath);
  }
  assert.equal((await askFile('?root=' + enc(ws) + '&path=artifacts/notes.txt')).code, 400);
  assert.equal((await askFile('?root=' + enc(ws) + '&path=artifacts/pic.png')).code, 400);
  const big = await askFile('?root=' + enc(ws) + '&path=artifacts/big.html');
  assert.equal(big.code, 413);
  assert.equal(big.payload.error, 'file too large');
  assert.equal((await askFile('?root=' + enc(ws) + '&path=artifacts/missing.html')).code, 404);
  // A path that is not artifacts/... still reads inside the workspace only.
  assert.equal((await askFile('?root=' + enc(ws) + '&path=' + enc(path.join('..', 'x.html')))).code, 400);
}

// ---- A workspace without artifacts/ keeps serving its ordinary HTML ----
{
  const file = await askFile('?root=' + enc(noArtifacts) + '&path=root-page.html');
  assert.equal(file.code, 200, 'workspace HTML outside artifacts/ needs no artifacts folder');
  assert.match(Buffer.from(file.payload.dataBase64, 'base64').toString('utf8'), /Root page/);
  const library = await askLibrary('?root=' + enc(noArtifacts) + '&outside=1');
  assert.equal(library.code, 200);
  assert.equal(library.payload.ok, true);
  assert.ok(library.payload.artifacts.some((item) => /root-page\.html$/.test(item.path) && item.outside), 'outside=1 still lists it');
  const plain = await askLibrary('?root=' + enc(noArtifacts));
  assert.equal(plain.code, 200);
  assert.equal(plain.payload.ok, true);
  assert.deepEqual(plain.payload.artifacts, [], 'no artifacts folder means no artifact rows');
}

// ---- A regular file named artifacts is refused, not served ----
{
  const library = await askLibrary('?root=' + enc(fileRoot));
  assert.equal(library.code, 200);
  assert.equal(library.payload.ok, false);
  assert.equal(library.payload.error, 'artifacts root is not a directory');
  assert.equal((await askFile('?root=' + enc(fileRoot) + '&path=artifacts/x.html')).code, 403);
}

// ---- The declaration is strict: every broken form is an error, not a fallback ----
{
  const cases = [
    ['not json', '{nope'],
    ['an array', [ext]],
    ['an empty object', {}],
    ['an unknown field', { artifactsRoot: ext, extra: true }],
    ['a relative path', { artifactsRoot: 'external-root' }],
    ['a non-string path', { artifactsRoot: 42 }],
    ['a missing directory', { artifactsRoot: path.join(base, 'does-not-exist') }],
    ['a file instead of a directory', { artifactsRoot: path.join(ext, 'notes.txt') }],
  ];
  for (const [label, value] of cases) {
    await declaration(value);
    const file = await askFile('?root=' + enc(ws) + '&path=artifacts/island-gravity-audit-20261126/index.html');
    assert.equal(file.code, 500, 'invalid declaration: ' + label);
    assert.equal(file.payload.error, 'artifacts root declaration is invalid');
    const library = await askLibrary('?root=' + enc(ws));
    assert.equal(library.payload.ok, false);
    assert.equal(library.payload.error, 'artifacts root declaration is invalid');
  }
  if (process.platform === 'win32') {
    // A rooted path without a drive names no folder on its own.
    for (const value of ['\\archive', '/archive']) {
      await declaration({ artifactsRoot: value });
      const file = await askFile('?root=' + enc(ws) + '&path=artifacts/island-gravity-audit-20261126/index.html');
      assert.equal(file.code, 500, 'drive-less declaration: ' + value);
    }
  }
  // Larger than the 4 KiB declaration cap.
  await writeFile(declaredPath, JSON.stringify({ artifactsRoot: 'C:\\' + 'x'.repeat(5000) }), 'utf8');
  assert.equal((await askFile('?root=' + enc(ws) + '&path=artifacts/island/index.html')).code, 500);

  // A directory where the declaration should be a file.
  await rm(declaredPath, { force: true });
  await mkdir(declaredPath, { recursive: true });
  assert.equal((await askFile('?root=' + enc(ws) + '&path=artifacts/island/index.html')).code, 500);
  await rm(declaredPath, { recursive: true, force: true });

  // A symlink (when the platform/developer mode allows creating one) is not a
  // regular file and is refused; the same path is then restored as a real file.
  let symlinkMade = false;
  try {
    await symlink(path.join(ext, 'notes.txt'), declaredPath, 'file');
    symlinkMade = true;
  } catch (error) {
    console.log('  declaration symlink check skipped:', String(error && error.code));
  }
  if (symlinkMade) {
    const info = await lstat(declaredPath);
    assert.equal(info.isSymbolicLink(), true);
    assert.equal((await askFile('?root=' + enc(ws) + '&path=artifacts/island/index.html')).code, 500);
    await rm(declaredPath, { force: true });
  }
  await declaration({ artifactsRoot: ext });
}

// ---- /workspaces keeps its shape, and a declared root counts as artifacts ----
{
  const { out, res } = response();
  await routes.get('/artifact-panes/workspaces').handler({ method: 'GET' }, res);
  const payload = JSON.parse(out.body);
  assert.equal(out.code, 200);
  assert.equal(payload.ok, true);
  const offered = new Map(payload.workspaces.map((item) => [item.cwd, item]));
  const declared = offered.get(ws);
  assert.ok(declared, 'the declared workspace is offered');
  assert.deepEqual(Object.keys(declared).sort(), ['cwd', 'hasArtifacts', 'indexId', 'label', 'live', 'sessionId'].sort());
  assert.equal(declared.live, false);
  assert.equal(declared.sessionId, null);
  assert.equal(declared.hasArtifacts, true, 'the declared root counts even without a local artifacts/ folder');
  const noDir = offered.get(ws2);
  assert.ok(noDir, 'a declared root without artifacts/ is still offered');
  assert.equal(noDir.hasArtifacts, true);
  assert.equal(offered.has(fileRoot), false, 'a file named artifacts is not advertised');
}

// Cleanup: temp roots and the fake session index.
await rm(base, { recursive: true, force: true });
await rm(process.env.DSH_HOME, { recursive: true, force: true });
console.log('artifact-panes external artifacts root: OK');
