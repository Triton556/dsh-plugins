import { readFileSync, writeFileSync } from 'node:fs';
const target = 'C:/Users/Danil/Documents/deepseek-harness/default-workspace/dsh-computer-use/index.js';
let text = readFileSync(target, 'utf8');

// ---------------------------------------------------------------- stop marker
const stopHelpers = `
// ESC in the on-screen banner writes a stop marker; the next call refuses to act
// until the agent has asked the user and passed user_ready: true.
const STOP_MARKER = join(tmpdir(), 'dsh-cua-stop.json');
const STOP_FRESH_MS = 15 * 60 * 1000;

function stopRequested() {
  try {
    if (!existsSync(STOP_MARKER)) return false;
    const raw = JSON.parse(readFileSync(STOP_MARKER, 'utf8'));
    const at = Number(raw && raw.at) || 0;
    return at > 0 && Date.now() - at <= STOP_FRESH_MS;
  } catch (error) {
    return false;
  }
}

function clearStop() {
  try { if (existsSync(STOP_MARKER)) unlinkSync(STOP_MARKER); } catch (error) {}
}

// Screen-wide input (no window/pid) needs the user's go-ahead: the overlay banner
// says so, and the tool refuses until the agent confirmed it with the user.
const SCREEN_INPUT_TOOLS = new Set(['computer_click', 'computer_drag', 'computer_type', 'computer_key', 'computer_scroll']);
`;

const catalogueMarker = '// ------------------------------------------------------------------- catalogue';
text = text.replace(catalogueMarker, stopHelpers + '\n' + catalogueMarker);

// ---------------------------------------------------------------- imports
text = text.replace(
  "import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';",
  "import { appendFileSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';"
);

// ---------------------------------------------------------------- gate + mode
const oldExecute = `              const { engine, cdp } = await import('./tools/engine.mjs');
              const call = spec.run(args || {});`;
const newExecute = `              const { engine, cdp } = await import('./tools/engine.mjs');

              // Whole-screen input and a fresh ESC stop both require the user's consent.
              const screenWide = SCREEN_INPUT_TOOLS.has(spec.name) && !args.window && !args.pid;
              const consent = args.user_ready === true;
              if (screenWide && !consent) {
                return {
                  ok: false,
                  text: 'REFUSED: this acts on the whole screen. Ask the user to confirm (the on-screen banner "DeepSeek using your computer" shows while you work) and retry with user_ready: true. For a single app, pass window or pid instead - that needs no confirmation.'
                };
              }
              if (stopRequested() && !consent) {
                return {
                  ok: false,
                  text: 'STOPPED: the user pressed ESC. Ask whether to continue before touching the computer again; retry with user_ready: true if they agree.'
                };
              }
              if (consent) clearStop();

              const call = spec.run(args || {});`;
if (!text.includes(oldExecute)) { console.error('execute anchor missing'); process.exit(2); }
text = text.replace(oldExecute, newExecute);

// ---------------------------------------------------------------- mode in state
text = text.replace(
  'function pushOverlay(hwnd, rect, click, label) {',
  'function pushOverlay(hwnd, rect, click, label, mode) {'
);
text = text.replace(
  "      label: String(label || '').slice(0, 48)",
  "      label: String(label || '').slice(0, 48),\n      mode: mode === 'screen' ? 'screen' : 'window'"
);
text = text.replace(
  'pushOverlay(parsed.hwnd, parsed.rect, parsed.click, captionFor(spec.name, args));',
  'pushOverlay(parsed.hwnd, parsed.rect, parsed.click, captionFor(spec.name, args), screenWide || args.window === undefined && args.pid === undefined ? \'screen\' : \'window\');'
);

// ---------------------------------------------------------------- tool params
for (const tool of ['computer_click', 'computer_drag', 'computer_type', 'computer_key', 'computer_scroll']) {
  const marker = "    name: '" + tool + "',";
  const idx = text.indexOf(marker);
  if (idx < 0) continue;
  const paramsIdx = text.indexOf('parameters: {', idx);
  if (paramsIdx < 0) continue;
  text = text.slice(0, paramsIdx) + `parameters: {\n      user_ready: { type: 'boolean', description: 'Set true only after the user agreed to let the agent drive the whole screen (not needed when window/pid is given)' },` + text.slice(paramsIdx + 'parameters: {'.length);
}

writeFileSync(target, text, 'utf8');
console.log('consent gate, stop marker and screen mode wired');