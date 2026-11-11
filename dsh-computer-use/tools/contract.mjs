// Verify the cordis contract of the plugin WITHOUT the host: a fake context
// proves apply() asks for the tools service via inject() and that registration
// happens when the service appears later (the real boot order).
//
// Usage: node tools/contract.mjs
import { registerHooks } from 'node:module';

// The plugin imports the host package lazily; map it to the stub for this run so
// the registration path is exercised exactly as it would be in the host.
const STUB = new URL('./dsh-tools-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const { apply, inject, TOOLS } = await import('../index.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 200)}` : ''}`);
};

// Minimal cordis-shaped context.
function makeContext() {
  const registered = [];
  const effects = [];
  const injections = [];
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (definition) => { registered.push(definition); return () => {}; } };
      return undefined;
    },
    effect(callback, label) { effects.push({ callback, label }); return () => {}; },
    inject(services, callback) {
      injections.push({ services, callback });
      return () => {};
    }
  };
  return { ctx, registered, effects, injections };
}

console.log('contract');
check('module exports apply', typeof apply === 'function');
check('module exports inject list', Array.isArray(inject));
check('tool catalogue non-empty', TOOLS.length === 20, `${TOOLS.length}`);

const { ctx, registered, effects, injections } = makeContext();
const applyDisposer = apply(ctx, {});
check('apply declares an injection', injections.length === 1, JSON.stringify(injections.map((i) => i.services)));
check('injection requests tools', !!injections[0] && injections[0].services.includes('tools'));
check('no tools registered before the service arrives', registered.length === 0, `${registered.length}`);

// Calling apply's own disposer must not throw: an out-of-scope reference there
// would break the plugin at boot.
let applyDisposeThrew = null;
try { if (typeof applyDisposer === 'function') applyDisposer(); } catch (error) { applyDisposeThrew = error.message; }
check('apply disposer runs', !applyDisposeThrew, applyDisposeThrew);

// Host calls the injection callback once the service is available.
const injectDisposer = injections[0].callback(ctx);
check('effect registered after injection', effects.length === 1, `${effects.length}`);
check('effect has a label', typeof effects[0].label === 'string' && effects[0].label.length > 0);

// Run the effect the way cordis does (it may return a promise).
const result = effects[0].callback();
if (result && typeof result.then === 'function') await result.catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 300));

check('all tools registered once the service exists', registered.length === TOOLS.length, `${registered.length}`);
check('definitions carry name/description/parameters/execute',
  registered.every((d) => typeof d.name === 'string' && typeof d.description === 'string'
    && d.parameters && typeof d.execute === 'function'));

// The injection's disposer is what cordis calls on unload; it must run cleanly.
let injectDisposeThrew = null;
try { if (typeof injectDisposer === 'function') injectDisposer(); } catch (error) { injectDisposeThrew = error.message; }
check('injection disposer runs', !injectDisposeThrew, injectDisposeThrew);

// A context without inject must not throw (defensive boot path).
let threw = false;
try { apply({ get() { return undefined; }, effect() { return () => {}; } }, {}); }
catch { threw = true; }
check('apply survives a context without inject', !threw);

console.log(failures ? `FAIL: ${failures}` : 'PASS: cordis contract satisfied');
process.exit(failures ? 1 : 0);