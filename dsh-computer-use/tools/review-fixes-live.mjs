// Live verification of the review fixes through the real plugin wiring:
//   F05 passive call clears the screen banner state,
//   F09/F10 badge on -> title marker, badge off -> favicon AND title restored,
//   F04 the stop is reported even with user_ready, then consumed once.
import { registerHooks } from 'node:module';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB = 'file:///C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/tools/dsh-tools-stub.mjs';
registerHooks({ resolve(spec, ctx, next) { if (spec === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true }; return next(spec, ctx); } });
const { apply } = await import('file:///C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/index.js');
const { cdp } = await import('file:///C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/tools/engine.mjs');

const registered = []; const effects = []; const injections = [];
const ctx = {
  get(name) { return name === 'tools' ? { register: (d) => { registered.push(d); return () => {}; } } : undefined; },
  effect(cb, label) { effects.push({ cb, label }); return () => {}; },
  inject(services, callback) { injections.push({ services, callback }); return () => {}; }
};
apply(ctx, {});
injections.find((i) => i.services.includes('tools')).callback(ctx);
for (const e of effects) await e.cb();
const tool = (n) => registered.find((t) => t.name === n);
const STATE = join(tmpdir(), 'dsh-cua-overlay-state.json');
const STOP = join(tmpdir(), 'dsh-cua-stop.json');

// 1. screen-wide input without consent is refused and writes no overlay state
if (existsSync(STATE)) {
  // overwrite with a screen state to prove the passive call clears it
  writeFileSync(STATE, JSON.stringify({ updated: Date.now(), ttlMs: 90000, screen: true, mode: 'screen', target: { hwnd: 0, rect: [0, 0, 0, 0] } }), 'utf8');
}
const refused = await tool('computer_click').execute({ x: 10, y: 10 });
console.log('gate:', refused.text.split('\n')[0].slice(0, 60));

// 2. passive whole-screen shot must clear the screen banner state
const shot = await tool('computer_shot').execute({ method: 'screen' });
const state = JSON.parse(readFileSync(STATE, 'utf8'));
console.log('passive shot ok:', shot.ok, '| state mode:', state.mode, '| screen:', state.screen);

// 3. badge: on, then restore after the linger
const badgeOnCall = await tool('computer_cdp').execute({ action: 'eval', expression: 'document.title', target: 'deepseek' });
const during = await cdp({ Eval: "(function(){ const l = document.querySelector('link[rel*=\"icon\"]'); return (l ? l.href.slice(0, 20) : 'none') + ' | ' + document.title; })()", Target: 'deepseek', Port: 9222 });
console.log('during call:', String(during.text || '').trim());
await new Promise((r) => setTimeout(r, 9000));
const after = await cdp({ Eval: "(function(){ const l = document.querySelector('link[rel*=\"icon\"]'); return (l ? l.href.slice(0, 22) : 'none') + ' | ' + document.title.slice(0, 24); })()", Target: 'deepseek', Port: 9222 });
console.log('after linger:', String(after.text || '').trim());
console.log('badge call ok:', badgeOnCall.ok);

// 4. stop is reported even when user_ready is passed, and consumed once
writeFileSync(STOP, JSON.stringify({ at: Date.now() }), 'utf8');
const withConsent = await tool('computer_click').execute({ x: 10, y: 10, user_ready: true });
console.log('stop with user_ready:', withConsent.text.split('\n')[0].slice(0, 50), '| marker left:', existsSync(STOP));
