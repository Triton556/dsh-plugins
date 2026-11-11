// Round-trip safety check: free text must survive the engine untouched.
// Usage: node tools/text-safety.mjs
import { engine } from './engine.mjs';

const CASES = [
  'plain',
  'a"b',
  "single'quote",
  'semi;colon $(calc); `backtick`',
  'dollar $env:PATH %PATH%',
  'unicode: привет мир — ✓',
  'newlines\nsecond line\ttab',
  'amp & pipe | redirect > nul'
];

let failures = 0;
for (const value of CASES) {
  await engine({ Action: 'clipboard', Text: '' });
  const set = await engine({ Action: 'clipboard', Text: value });
  const back = await engine({ Action: 'clipboard' });
  const ok = set.ok && back.ok && back.text === value;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(value.slice(0, 40))} -> ${JSON.stringify((back.text || '').slice(0, 40))}`);
}
console.log(failures ? `FAIL: ${failures} case(s)` : 'PASS: free text survives the engine');
process.exit(failures ? 1 : 0);