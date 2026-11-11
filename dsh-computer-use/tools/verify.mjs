// Offline verification of dsh-computer-use without booting the host:
//   1. the tool catalogue is complete and every entry has a schema and a runner;
//   2. the packaged engines actually work (PowerShell engine + CDP helper);
//   3. a tool runner maps arguments onto the engine correctly (live mode).
//
// Usage: node tools/verify.mjs [--live]
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { TOOLS } from '../index.js';
import { engine, cdp } from './engine.mjs';

const live = process.argv.includes('--live');
const EXPECTED = [
  'computer_cdp', 'computer_click', 'computer_clipboard', 'computer_drag', 'computer_ui_action', 'computer_video',
  'computer_focus', 'computer_key', 'computer_launch', 'computer_ocr',
  'computer_record', 'computer_scroll', 'computer_shot', 'computer_tab',
  'computer_tabs', 'computer_type', 'computer_uitree', 'computer_wait',
  'computer_window', 'computer_windows'
];

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
};

console.log('catalogue');
const names = TOOLS.map((t) => t.name).sort();
check('tool count 20', names.length === 20, `got ${names.length}`);
check('names match', EXPECTED.every((n) => names.includes(n)),
  EXPECTED.filter((n) => !names.includes(n)).join(','));
for (const tool of TOOLS) {
  check(`${tool.name}: description`, typeof tool.description === 'string' && tool.description.length > 20);
  check(`${tool.name}: parameters object`, tool.parameters && typeof tool.parameters === 'object');
  check(`${tool.name}: runner`, typeof tool.run === 'function');
}

console.log('runner mapping');
const shotSpec = TOOLS.find((t) => t.name === 'computer_shot');
const shotCall = shotSpec.run({ window: 'X', method: 'print', x: 1, y: 2, width: 3, height: 4, path: 'p.png' });
check('shot maps to action', shotCall.action === 'shot');
check('shot keeps region', shotCall.width === 3 && shotCall.height === 4 && shotCall.method === 'print');
const cdpSpec = TOOLS.find((t) => t.name === 'computer_cdp');
const cdpCall = cdpSpec.run({ action: 'list', port: 9333 });
check('cdp maps to helper call', !!cdpCall.cdp && cdpCall.cdp.action === 'list' && cdpCall.cdp.port === 9333);

console.log('engines');
const clipboard = await engine({ Action: 'clipboard', Text: 'verify-ping' });
check('powershell engine responds', clipboard.ok, clipboard.text);
const readBack = await engine({ Action: 'clipboard' });
check('clipboard round-trip', readBack.ok && readBack.text.includes('verify-ping'), readBack.text);
const deadPort = Number(process.env.CUA_DEAD_PORT || 39998);
const noPort = await cdp({ List: true, Port: deadPort });
check('cdp helper reports a closed port cleanly', !noPort.ok && /fetch failed|ECONNREFUSED|CDP list failed/i.test(noPort.text), noPort.text);

if (live) {
  console.log('live');
  const cdpPort = Number(process.env.CUA_CDP_PORT || 0);
  if (cdpPort) {
    const list = await cdp({ List: true, Port: cdpPort });
    check(`cdp lists targets on ${cdpPort}`, list.ok && list.text.includes('"id"'), list.text.slice(0, 160));
    const evalResult = await cdp({ Port: cdpPort, Eval: '1+1' });
    check('cdp eval round-trip', evalResult.ok && /(^2\s*$|"value":\s*2)/.test(evalResult.text), evalResult.text);
    const nav = await cdp({ Port: cdpPort, Navigate: 'data:text/html,<h1>bg</h1>' });
    check('cdp navigate', nav.ok, nav.text);
    const shotPath = `${process.env.TEMP || '.'}/dsh-computer-use-cdp.png`;
    const tabShot = await cdp({ Port: cdpPort, Shot: shotPath });
    check('cdp tab screenshot', tabShot.ok, tabShot.text);
    const tracePath = `${process.env.TEMP || '.'}/dsh-computer-use-trace.json`;
    const trace = await cdp({ Port: cdpPort, Trace: tracePath, Perf: 1200 });
    check('cdp trace writes a file', trace.ok && trace.text.includes('events'), trace.text.slice(0, 200));
  }
  const windows = await engine({ Action: 'windows' });
  check('computer_windows lists windows', windows.ok && windows.text.length > 20, windows.text.slice(0, 120));
  const target = (windows.text.match(/DeepSeek Harness/) || windows.text.match(/claude/) || [])[0];
  check('a known window is present', !!target, windows.text.slice(0, 200));
  const out = `${process.env.TEMP || '.'}/dsh-computer-use-verify.png`;
  const shot = await engine({ Action: 'shot', Window: 'DeepSeek Harness', Method: 'print', Path: out });
  check('computer_shot writes a PNG', shot.ok, shot.text);
  try {
    const size = statSync(out).size;
    check('screenshot is non-trivial', size > 5000, `${size} bytes`);
  } catch (error) {
    check('screenshot exists', false, error.message);
  }
}

console.log(failures ? `FAIL: ${failures} check(s)` : 'PASS: plugin catalogue and engines verified');
process.exit(failures ? 1 : 0);