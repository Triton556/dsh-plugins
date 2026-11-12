// Consent gate checks without the host: whole-screen input must be refused until
// the user agreed (user_ready), and a fresh ESC stop must block every tool.
//
// Usage: node tools/consent.mjs
import { registerHooks } from 'node:module';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB = new URL('./dsh-tools-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
const { apply } = await import('../index.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 200)}` : ''}`);
};

function makeContext() {
  const registered = [];
  const effects = [];
  const injections = [];
  const ctx = {
    get(name) { return name === 'tools' ? { register: (d) => { registered.push(d); return () => {}; } } : undefined; },
    effect(callback, label) { effects.push({ callback, label }); return () => {}; },
    inject(services, callback) { injections.push({ services, callback }); return () => {}; }
  };
  return { ctx, registered, effects, injections };
}

const wired = makeContext();
apply(wired.ctx, {});
const toolsInjection = wired.injections.find((i) => i.services.includes('tools'));
toolsInjection.callback(wired.ctx);
for (const effect of wired.effects) await effect.callback();
await new Promise((resolve) => setTimeout(resolve, 300));

const click = wired.registered.find((t) => t.name === 'computer_click');
check('computer_click registered', !!click);

// 1. whole-screen click without consent is refused and does not touch the desktop
const refused = await click.execute({ x: 1, y: 1 });
check('screen-wide click refused without user_ready', refused && refused.ok === false && /^REFUSED/.test(refused.text), refused && refused.text);
check('refusal explains the way out', refused && /user_ready: true/.test(refused.text));

// 2. the same tool scoped to a window is allowed through (the engine fails on a
//    bogus title, which is fine: the gate is what we are testing)
const scoped = await click.execute({ window: 'no-such-window-xyz', x: 1, y: 1 });
check('window-scoped click is not gated', scoped && !/^REFUSED/.test(scoped.text), scoped && scoped.text);

// 3. a fresh ESC marker blocks everything until the agent confirms
const marker = join(tmpdir(), 'dsh-cua-stop.json');
writeFileSync(marker, JSON.stringify({ at: Date.now() }), 'utf8');
const stopped = await click.execute({ window: 'no-such-window-xyz', x: 1, y: 1 });
check('fresh ESC stop blocks the next call', stopped && stopped.ok === false && /^STOPPED/.test(stopped.text), stopped && stopped.text);

const resumed = await click.execute({ window: 'no-such-window-xyz', x: 1, y: 1, user_ready: true });
check('user_ready clears the stop marker', resumed && !/^STOPPED/.test(resumed.text), resumed && resumed.text);
check('marker removed after consent', !existsSync(marker));

try { if (existsSync(marker)) unlinkSync(marker); } catch (error) {}

console.log(failures ? `FAIL: ${failures}` : 'PASS: consent gate verified');
process.exit(failures ? 1 : 0);