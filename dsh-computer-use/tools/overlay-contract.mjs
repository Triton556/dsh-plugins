// Run with an isolated TMPDIR; never use the user's running indicator.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

assert.ok(process.env.DSH_CUA_TEST_TEMP && tmpdir() === process.env.DSH_CUA_TEST_TEMP, 'Set a dedicated DSH_CUA_TEST_TEMP and TMPDIR');
const stub = new URL('./dsh-tools-stub.mjs', import.meta.url).href;
const enginePath = new URL('./engine.mjs', import.meta.url).href;
const mock = 'data:text/javascript,' + encodeURIComponent('export const engine = (...a) => globalThis.dshTestEngine(...a);');
registerHooks({ resolve(spec, ctx, next) {
  if (spec === '@deepseek-ai/dsh-tools') return { url: stub, shortCircuit: true };
  if (spec === './tools/engine.mjs' && new URL(spec, ctx.parentURL).href === enginePath) return { url: mock, shortCircuit: true };
  return next(spec, ctx);
}});

const { apply } = await import('../index.js');
const tools = new Map(), starts = [];
const ctx = {
  inject(names, setup) { if (names.includes('tools')) setup(this); },
  get(name) { if (name === 'tools') return { register: d => { tools.set(d.name, d); return () => tools.delete(d.name); } }; },
  effect(start) { starts.push(start()); },
};
apply(ctx);
await Promise.all(starts);
const statePath = join(tmpdir(), 'dsh-cua-overlay-state.json');
const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
const marker = '[overlay] hwnd=122 rect=-1200,40,-500,690 click=-1100,56';
let calls = 0;
globalThis.dshTestEngine = async (opts, hooks) => {
  if (opts.action === 'overlay') return { ok: true, text: 'started' };
  calls++;
  if (opts.Action === 'click' && opts.Window === 'Fixture') {
    assert.equal(state().screen, false, 'old screen banner is cleared before a targeted call');
    assert.equal(state().target.hwnd, 0, 'old target is cleared before geometry arrives');
    hooks.onLine(marker);
    assert.deepEqual(state().cursor, { x: -1100, y: 56 }, 'while dispatching, overlay uses the actual absolute input point');
    assert.equal(state().target.hwnd, 122);
    return { ok: true, text: marker + '\nclicked -1100,56' };
  }
  if (opts.Action === 'click' && !opts.Window) {
    assert.equal(state().screen, true, 'desktop warning is present during desktop input');
    return { ok: true, text: 'clicked 30,40' };
  }
  return { ok: false, text: 'TARGET_NOT_FOREGROUND' };
};
const click = tools.get('computer_click');
assert.match((await click.execute({ x: 30, y: 40 })).text, /^REFUSED/);
assert.equal(calls, 0);
assert.equal((await click.execute({ x: 30, y: 40, user_ready: true })).ok, true);
assert.equal(state().ttlMs, 0, 'warning hides after whole-screen input');
assert.deepEqual(await click.execute({ window: 'Fixture', x: 100, y: 16 }), { ok: true, text: 'clicked -1100,56' });
assert.equal(state().ttlMs, 700, 'target highlight has a short completion linger');
assert.equal((await click.execute({ window: 'Wrong', x: 100, y: 16 })).ok, false);
assert.equal(state().ttlMs, 0, 'failure never lingers as success');
writeFileSync(join(tmpdir(), 'dsh-cua-stop.json'), JSON.stringify({ at: Date.now() }));
assert.match((await click.execute({ x: 30, y: 40, user_ready: true })).text, /^STOPPED/);
assert.equal(calls, 3);
console.log('PASS: consent, geometry streaming, target isolation, linger, error, STOP');
