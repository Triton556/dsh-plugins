// Caption text must survive a CP1251 round trip: some callers hand us UTF-8 that was
// already decoded as CP1251, which turns any non-ASCII title into mojibake.
// The fixtures are escapes so this file stays plain ASCII.
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

// mojibake of "\u0441\u043d\u044f\u0442\u044c \u043e\u043a\u043d\u043e" (a window title)
const broken = '\u0421\u0403\u0420\u0405\u0421\u040f\u0421\u201a\u0421\u040a \u0420\u0455\u0420\u0454\u0420\u0405\u0420\u0455';
const expected = '\u0441\u043d\u044f\u0442\u044c \u043e\u043a\u043d\u043e';

check('mojibake is repaired', repairText(broken) === expected, repairText(broken));
check('clean text is left alone', repairText(expected) === expected);
check('English is never touched', repairText('screenshot: chat window') === 'screenshot: chat window');
check('mixed English + mojibake is repaired', repairText(`click: ${broken}`) === `click: ${expected}`, repairText(`click: ${broken}`));
check('empty input stays empty', repairText('') === '');
check('undefined becomes empty', repairText(undefined) === '');

console.log(failures ? `FAIL: ${failures}` : 'PASS: caption text encoding verified');
process.exit(failures ? 1 : 0);