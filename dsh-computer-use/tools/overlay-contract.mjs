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
const tools = new Map(), starts = [], savedImages = [];
const ctx = {
  inject(names, setup) { if (names.includes('tools')) setup(this); },
  get(name) {
    if (name === 'tools') return { register: d => { tools.set(d.name, d); return () => tools.delete(d.name); } };
    if (name === 'attachments') return { async saveImage(value) { savedImages.push(value); return { attachmentId: 'fixture' }; } };
  },
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

// Exercise two overlapping calls against the registered tool wrappers, not
// just the state writer. Keep the drag open while a different call finishes.
let releaseDrag, dragStarted, oldGeometry;
const dragging = new Promise(resolve => { releaseDrag = resolve; });
const ready = new Promise(resolve => { dragStarted = resolve; });
let competingCalls = 0;
globalThis.dshTestEngine = async (opts, hooks) => {
  if (opts.action === 'overlay') return { ok: true, text: 'started' };
  if (opts.Action === 'drag') {
    oldGeometry = hooks.onLine;
    oldGeometry(marker);
    dragStarted();
    await dragging;
    return { ok: false, text: 'STOPPED' };
  }
  if (opts.Action === 'windows') return { ok: true, text: 'Fixture' };
  competingCalls++;
  return { ok: true, text: 'clicked' };
};
const drag = tools.get('computer_drag');
const moving = drag.execute({ window: 'Fixture', x: 100, y: 16, x2: 120, y2: 36 });
await ready;
const active = state();
assert.equal(active.target.hwnd, 122);
assert.ok(active.stopToken);
writeFileSync(join(tmpdir(), 'dsh-cua-stop.json'), JSON.stringify({ at: Date.now() }));
assert.equal((await tools.get('computer_windows').execute({})).ok, true);
assert.deepEqual(state(), active, 'window list cannot redraw or clear the active drag');
assert.match((await click.execute({ window: 'Fixture', x: 10, y: 20 })).text, /^BUSY/);
assert.equal(competingCalls, 0, 'overlapping input cannot reach the worker');
assert.deepEqual(state(), active, 'competing input must not replace the Escape token');
releaseDrag();
await moving;
assert.equal(state().ttlMs, 0);
assert.match((await click.execute({ window: 'Fixture', x: 10, y: 20 })).text, /^STOPPED/,
  'the next idle call reports Escape, which the observer did not consume');

globalThis.dshTestEngine = async (opts, hooks) => {
  if (opts.action === 'overlay') return { ok: true, text: 'started' };
  hooks.onLine('[overlay] hwnd=404 rect=0,0,100,100');
  const newer = state();
  assert.equal(newer.target.hwnd, 404);
  assert.notEqual(newer.stopToken, active.stopToken);
  oldGeometry(marker);
  assert.deepEqual(state(), newer, 'a stale driver callback cannot paint over the new input');
  return { ok: true, text: 'clicked' };
};
assert.equal((await click.execute({ window: 'Fixture', x: 10, y: 20 })).ok, true);
console.log('PASS: passive overlap, exclusive input, stale geometry callback');

// The production wrapper must attach the GIF itself, even when the caller
// supplies no path and the receipt contains spaces and parentheses.
const clip = join(tmpdir(), 'capture (test).gif');
writeFileSync(clip, 'fake GIF payload');
globalThis.dshTestEngine = async opts => {
  assert.equal(opts.Action, 'video');
  assert.equal(opts.Method, 'print');
  assert.equal(opts.Format, 'gif');
  assert.equal(opts.Path, undefined);
  return { ok: true, text: `video: ${clip} (1.2 KB, 2 frames @ 10 fps, gif)` };
};
const animation = await tools.get('computer_video').execute({ format: 'gif', window: 'Fixture' });
assert.equal(animation.image?.attachmentId, 'fixture');
assert.equal(savedImages[0]?.mediaType, 'image/gif');
assert.equal(savedImages[0]?.data.toString(), 'fake GIF payload');
console.log('PASS: pathless GIF attaches itself, not a PNG poster');

// Supplying partial or invalid crop arguments must never cause a full capture.
let shotCalls = 0;
globalThis.dshTestEngine = async () => { shotCalls++; return { ok: true, text: 'fixture.png' }; };
const shot = tools.get('computer_shot');
for (const args of [{ width: 75 }, { height: 40 }, { x: 20, y: 3 }, { width: 0, height: 20 }, { width: 40, height: -1 }]) {
  assert.match((await shot.execute(args)).text, /^INVALID_REGION:/);
}
assert.equal(shotCalls, 0);
assert.equal((await shot.execute({ window: 'Fixture' })).ok, true);
assert.equal((await shot.execute({ window: 'Fixture', width: 40, height: 25 })).ok, true);
assert.equal(shotCalls, 2);
console.log('PASS: malformed crops are refused before capture; full and valid crops still dispatch');
