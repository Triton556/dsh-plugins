// The caption text must survive a CP1251 round trip: callers sometimes hand us
// UTF-8 that was already decoded as CP1251 ("снять" -> "СЃРЅСЏС‚СЊ").
//
// Usage: node tools/text-encoding.mjs
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = source.indexOf('const CP1251_BYTES');
const end = source.indexOf('// Caption shown next to the cursor');
if (start < 0 || end < 0) {
  console.error('FAIL: repairText block not found');
  process.exit(2);
}
const repairText = new Function(`${source.slice(start, end)}; return repairText;`)();

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
};

const broken = 'СЃРЅСЏС‚СЊ РѕРєРЅРѕ С‡Р°С‚Р°';
check('mojibake is repaired', repairText(broken) === 'снять окно чата', repairText(broken));
check('clean Cyrillic is left alone', repairText('снять окно чата') === 'снять окно чата');
check('English is left alone', repairText('open settings') === 'open settings');
check('mixed Latin + Cyrillic mojibake is repaired', repairText('click: РѕС‚РєСЂС‹С‚СЊ') === 'click: открыть', repairText('click: РѕС‚РєСЂС‹С‚СЊ'));
check('empty input stays empty', repairText('') === '');
check('undefined becomes empty', repairText(undefined) === '');

console.log(failures ? `FAIL: ${failures}` : 'PASS: caption text encoding verified');
process.exit(failures ? 1 : 0);