import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const mock = `import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
export function spawn(command, args) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const sample = { args, killed: false };
  globalThis.cuaDeadlineCalls.push(sample);
  child.kill = () => { sample.killed = true; };
  setTimeout(() => child.emit('close', 0), 30);
  return child;
}`;
globalThis.cuaDeadlineCalls = [];
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'node:child_process' && ctx.parentURL.endsWith('/engine.mjs')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(mock), shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const { engine } = await import('./engine.mjs');
for (const Action of ['click', 'drag', 'hit', 'shot']) {
  await engine({ Action }, { timeoutMs: 1 });
  const { args, killed } = globalThis.cuaDeadlineCalls.at(-1);
  assert.ok(Number(args[args.indexOf('-DeadlineMs') + 1]) > 0, Action + ' gets an explicit worker deadline');
  assert.equal(killed, Action === 'shot', Action + ' forced termination policy');
}
console.log('PASS: mouse workers receive deadlines without forced termination');
