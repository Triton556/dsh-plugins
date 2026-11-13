// Interactive acceptance for the ESC contract, runnable without restarting DSH
// (it imports the plugin from disk, so it exercises the current sources):
//
//   node tools/acceptance-live.mjs wait [ms]
//       starts a long window-scoped computer_wait, waits for the human to press
//       ESC, then proves that (a) the call was killed and (b) the NEXT call
//       reports STOPPED exactly once.
//
//   node tools/acceptance-live.mjs state
//       prints the overlay state file the indicator daemon reads.
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB = new URL('./dsh-tools-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const STATE = join(tmpdir(), 'dsh-cua-overlay-state.json');
const STOP = join(tmpdir(), 'dsh-cua-stop.json');
const mode = process.argv[2] || 'state';

if (mode === 'state') {
  console.log(existsSync(STATE) ? readFileSync(STATE, 'utf8') : 'no overlay state');
  process.exit(0);
}

if (mode === 'banner') {
  // Show the whole-screen banner exactly as a screen-wide action would: start
  // the daemon through a passive tool call, then hold a screen state.
  const { apply: boot } = await import('../index.js');
  const reg = []; const eff = []; const inj = [];
  const c = {
    get(name) { return name === 'tools' ? { register: (d) => { reg.push(d); return () => {}; } } : undefined; },
    effect(cb) { eff.push(cb); return () => {}; },
    inject(services, cb) { inj.push({ services, cb }); return () => {}; }
  };
  boot(c, {});
  inj.find((i) => i.services.includes('tools')).cb(c);
  for (const e of eff) await e();
  const shot = reg.find((x) => x.name === 'computer_shot');
  await shot.execute({ method: 'screen' });            // starts the daemon
  const seconds = Math.max(5, Math.round(Number(process.argv[3]) || 8));
  const state = { updated: Date.now(), ttlMs: 90000, screen: true, target: { hwnd: 0, rect: [0, 0, 0, 0] }, cursor: { x: 960, y: 520 }, label: 'screen wide action', mode: 'screen' };
  writeFileSync(join(tmpdir(), 'dsh-cua-overlay-state.json'), JSON.stringify(state), 'utf8');
  console.log('banner state pushed; holding ' + seconds + 's');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  writeFileSync(join(tmpdir(), 'dsh-cua-overlay-state.json'), JSON.stringify({ updated: Date.now(), ttlMs: 90000, screen: false, target: { hwnd: 0, rect: [0, 0, 0, 0] }, mode: 'window' }), 'utf8');
  console.log('banner state cleared');
  process.exit(0);
}

const { apply } = await import('../index.js');
const registered = [];
const effects = [];
const injections = [];
const ctx = {
  get(name) { return name === 'tools' ? { register: (d) => { registered.push(d); return () => {}; } } : undefined; },
  effect(callback) { effects.push(callback); return () => {}; },
  inject(services, callback) { injections.push({ services, callback }); return () => {}; }
};
apply(ctx, {});
injections.find((i) => i.services.includes('tools')).callback(ctx);
for (const effect of effects) await effect();

const wait = registered.find((t) => t.name === 'computer_wait');
const uitree = registered.find((t) => t.name === 'computer_uitree');
const seconds = Math.max(5, Math.round(Number(process.argv[3]) || 25));
const target = String(process.argv[4] || 'zzz-no-such-window');

try { if (existsSync(STOP)) unlinkSync(STOP); } catch (e) {}

// Read-only wait: with a window that does not exist it simply polls, which
// gives the human time to press ESC. Nothing is clicked.
console.log(`WAITING on window "${target}" for up to ${seconds}s.`);
console.log('PRESS ESC NOW to cancel the action.');
const started = Date.now();
const result = await wait.execute({ window: target, text: 'zzz-no-such-element', timeout: seconds * 1000 });
const took = ((Date.now() - started) / 1000).toFixed(1);
console.log(`wait finished in ${took}s -> ok=${result.ok}`);
console.log('text: ' + String(result.text || '').split('\n')[0].slice(0, 120));

// The next call must report the one-shot stop (ESC writes it), and only once.
const afterKill = await uitree.execute({ window: target });
console.log('next call: ' + String(afterKill.text || '').split('\n')[0].slice(0, 90));
const afterSecond = await uitree.execute({ window: target });
const stoppedTwice = /^STOPPED/.test(String(afterSecond.text || ''));
console.log('second call still STOPPED: ' + stoppedTwice + ' (must be false)');
console.log('marker left behind: ' + existsSync(STOP) + ' (must be false)');
