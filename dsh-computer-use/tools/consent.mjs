// Consent gate checks without the host:
//   * whole-screen input must be refused until the user agreed (user_ready);
//   * an ESC stop is consumed by exactly one call and reported once;
//   * an explicit but unresolved window target fails closed: it must never
//     degrade into whole-screen input (that bug clicked the desktop once).
//
// Every scoped check below drives `computer_uitree`, a read-only action: the
// suite must not be able to move the pointer even if the guard regresses.
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
const uitree = wired.registered.find((t) => t.name === 'computer_uitree');
check('computer_click registered', !!click);
check('computer_uitree registered', !!uitree);

// 1. whole-screen click without consent is refused and does not touch the desktop
const refused = await click.execute({ x: 1, y: 1 });
check('screen-wide click refused without user_ready', refused && refused.ok === false && /^REFUSED/.test(refused.text), refused && refused.text);
check('refusal explains the way out', refused && /user_ready: true/.test(refused.text));

// 2. the same gate leaves a window-scoped call alone
const scoped = await uitree.execute({ window: 'no-such-window-xyz' });
check('window-scoped call is not gated', scoped && !/^REFUSED/.test(scoped.text), scoped && scoped.text);

// 3. fail-closed: an explicit target that does not resolve must error instead of
//    falling back to the desktop (the regression that moved the user's cursor)
check('unresolved window target fails closed',
  scoped && scoped.ok === false && /window not found|refusing to fall back/i.test(scoped.text),
  scoped && scoped.text);
const scopedPid = await uitree.execute({ pid: 999999 });
check('unresolved pid target fails closed',
  scopedPid && scopedPid.ok === false && /window not found|refusing to fall back/i.test(scopedPid.text),
  scopedPid && scopedPid.text);

// 4. ESC is one-shot: the marker blocks exactly one call, then it is consumed
const marker = join(tmpdir(), 'dsh-cua-stop.json');
writeFileSync(marker, JSON.stringify({ at: Date.now() }), 'utf8');
const stopped = await uitree.execute({ window: 'no-such-window-xyz' });
check('ESC stop blocks the next call', stopped && stopped.ok === false && /^STOPPED/.test(stopped.text), stopped && stopped.text);
check('marker consumed by that call', !existsSync(marker));

// 5. the stop is reported even when the agent passes user_ready, and only once
writeFileSync(marker, JSON.stringify({ at: Date.now() }), 'utf8');
const stoppedConsent = await click.execute({ x: 1, y: 1, user_ready: true });
check('ESC stop is reported despite user_ready', stoppedConsent && /^STOPPED/.test(stoppedConsent.text), stoppedConsent && stoppedConsent.text);
check('user_ready call consumed the marker', !existsSync(marker));

const after = await uitree.execute({ window: 'no-such-window-xyz' });
check('no lockout - the call after STOPPED works', after && !/^STOPPED/.test(after.text), after && after.text);

try { if (existsSync(marker)) unlinkSync(marker); } catch (error) {}

console.log(failures ? `FAIL: ${failures}` : 'PASS: consent gate verified');
process.exit(failures ? 1 : 0);
