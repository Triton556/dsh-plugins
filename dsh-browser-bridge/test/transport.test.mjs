import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const packageDir = fileURLToPath(new URL('../plugin/', import.meta.url));
test('packed bundle ships the runtime CLI, entry point and Cordis patch', () => {
  const cache = mkdtempSync(join(tmpdir(), 'dsh-pack-'));
  let result;
  try {
    result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageDir, encoding: 'utf8', shell: process.platform === 'win32',
      env: { ...process.env, npm_config_cache: cache },
    });
  } finally { rmSync(cache, { recursive: true, force: true }); }
  assert.equal(result.status, 0, result.stderr);
  const paths = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  for (const path of ['package.json', 'index.js', 'bridge.mjs', 'cordis.patch.yml']) assert.ok(paths.includes(path), path);
});

test('setting a field to empty preserves the explicit value', async () => {
  const { TOOLS } = await import('../plugin/index.js');
  const request = TOOLS.find((tool) => tool.name === 'browser_value').build({ tabId: 2, index: 0, value: '' });
  assert.deepEqual(request, { cmd: 'ax.setValue', args: { tabId: 2, index: 0, value: '' } });
});

test('CLI rejects non-object input before connecting', () => {
  const child = spawnSync(process.execPath, [cli], { input: 'null', encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /invalid bridge request/);
});

test('CLI accepts fragmented replies and rejects early EOF or mismatched IDs', () => {
  const mock = new URL('./mock-pipe.mjs', import.meta.url).href;
  const driver = `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(spec, ctx, next) {
      return spec === 'node:net' ? {url: ${JSON.stringify(mock)}, shortCircuit: true} : next(spec, ctx);
    }});
    process.argv = [process.execPath, '', process.argv[1]];
    await import(${JSON.stringify(new URL('../bridge.mjs', import.meta.url).href)});
  `;
  const call = (cmd) => spawnSync(process.execPath, ['--input-type=module', '-e', driver, JSON.stringify({ cmd })],
    { timeout: 3500, encoding: 'utf8' });
  const valid = call('ping');
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).data.title, 'Проверка');
  const wrong = call('wrong-id');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /mismatched request ID/);
  const eof = call('eof');
  assert.equal(eof.status, 1);
  assert.match(eof.stderr, /closed before/);
});
