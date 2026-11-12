// dsh-computer-use: first-class desktop control tools for DSH.
//
// Every tool answers { ok, text }; screenshots and clips also carry an inline
// attachment so the chat can show the picture without a second tool call.
import { appendFileSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const inject = [];

// Flash a click-through frame/marker over the window each tool touches.
const CUA_OVERLAY = true;

// ---------------------------------------------------------------- inline media
// A tool result shows an image only when it carries an attachment reference, the
// same way the core read_image tool does: commit the bytes to the attachment
// store, then return { type: 'image', attachment } from render().
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function mediaTypeOf(filePath) {
  return IMAGE_TYPES[String(extname(filePath)).toLowerCase()] || null;
}

function downscale(filePath, maxDimension) {
  // A full-screen PNG can exceed the deployment's image limits, so shrink it
  // with the ffmpeg that the recording path already depends on.
  try {
    const { execFileSync } = require('node:child_process');
    const target = filePath.replace(/\.(png|jpe?g|webp)$/i, '-small.$1');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', filePath,
      '-vf', `scale='min(${maxDimension},iw)':-1`, target], { timeout: 20000, windowsHide: true });
    return existsSync(target) ? target : null;
  } catch (error) {
    return null;
  }
}

async function attachImage(ctx, filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    const mediaType = mediaTypeOf(filePath);
    if (!mediaType) return null;
    const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : null;
    if (!attachments || typeof attachments.saveImage !== 'function') return null;
    const limits = attachments.imageLimits || {};
    const save = (path) => attachments.saveImage({ data: readFileSync(path), mediaType });
    try {
      const ref = await save(filePath);
      return ref ? { ...ref } : null;
    } catch (error) {
      const message = String(error && error.message || error);
      const tooBig = /TOO_LARGE|TOO_MANY_PIXELS|DIMENSION_TOO_LARGE|too large|exceeds/i.test(message);
      if (!tooBig || mediaType !== 'image/png') throw error;
      const smaller = downscale(filePath, Math.min(Number(limits.maxImageDimension) || 1600, 1600));
      if (!smaller) throw error;
      const ref = await save(smaller);
      return ref ? { ...ref } : null;
    }
  } catch (error) {
    console.warn('[dsh-computer-use] image attach failed:', String(error && error.message || error).slice(0, 200));
    return null;
  }
}

// Overlay control: the engine prints one geometry line per window call; the plugin
// turns it into state for the long-lived indicator process and strips the line.
const OVERLAY_SCRIPT = new URL('./tools/overlay.ps1', import.meta.url);
const OVERLAY_STATE = join(tmpdir(), 'dsh-cua-overlay-state.json');
const OVERLAY_PID = join(tmpdir(), 'dsh-cua-overlay.pid');
const OVERLAY_TTL_MS = 90000;
const OVERLAY_MARKER = /^\[overlay\] hwnd=(\d+) rect=(-?\d+,-?\d+,-?\d+,-?\d+)(?: click=(-?\d+,-?\d+))?\s*$/m;

function overlayAlive() {
  try {
    if (!existsSync(OVERLAY_PID)) return false;
    const pid = Number(readFileSync(OVERLAY_PID, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function ensureOverlay() {
  if (overlayAlive()) return;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(OVERLAY_SCRIPT)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    console.warn('[dsh-computer-use] overlay start failed:', String(error && error.message || error).slice(0, 160));
  }
}

// Show the controlled window + action point; the indicator itself decides whether
// it is visible (only while that window is in the foreground, or the desktop is).
function pushOverlay(hwnd, rect, click, label, mode) {
  try {
    const point = String(click || '').split(',').map(Number);
    const state = {
      updated: Date.now(),
      ttlMs: OVERLAY_TTL_MS,
      screen: false,
      target: { hwnd: Number(hwnd) || 0, rect: String(rect).split(',').map(Number) },
      cursor: Number.isFinite(point[0]) && Number.isFinite(point[1]) ? { x: point[0], y: point[1] } : undefined,
      label: String(label || '').slice(0, 48),
      mode: mode === 'screen' ? 'screen' : 'window'
    };
    writeFileSync(OVERLAY_STATE, JSON.stringify(state), 'utf8');
    ensureOverlay();
  } catch (error) {
    console.warn('[dsh-computer-use] overlay state failed:', String(error && error.message || error).slice(0, 160));
  }
}

function stripOverlay(text) {
  const value = String(text || '');
  const match = OVERLAY_MARKER.exec(value);
  if (!match) return { text: value };
  const cleaned = value.replace(match[0], '').replace(/\n{2,}/g, '\n').trim();
  return { text: cleaned, hwnd: match[1], rect: match[2], click: match[3] || '' };
}


// Caption shown next to the cursor: what the agent is about to do, in a few words.
function captionFor(name, args = {}) {
  const target = args.window || (args.pid ? `pid ${args.pid}` : '');
  const where = target ? ` · ${String(target).slice(0, 34)}` : '';
  switch (name) {
    case 'computer_shot': return `screenshot${where}`;
    case 'computer_click': return `click ${args.x ?? '?'},${args.y ?? '?'}${where}`;
    case 'computer_drag': return `drag ${args.x ?? '?'},${args.y ?? '?'} → ${args.x2 ?? '?'},${args.y2 ?? '?'}`;
    case 'computer_type': return `type "${String(args.text || '').slice(0, 24)}"`;
    case 'computer_key': return `key ${String(args.text || '').slice(0, 20)}`;
    case 'computer_scroll': return `scroll ${args.delta ?? ''}${where}`;
    case 'computer_focus': return `focus${where}`;
    case 'computer_window': return `window ${args.op || 'normal'}${where}`;
    case 'computer_launch': return `launch ${String(args.path || '').split(/[\\/]/).pop()}`;
    case 'computer_tabs': return `browser tabs${where}`;
    case 'computer_tab': return `tab "${String(args.title || '').slice(0, 24)}"`;
    case 'computer_wait': return `wait ${args.window || args.text || ''}`.trim();
    case 'computer_record': return `record ${args.frames || 10} frames${where}`;
    case 'computer_video': return `record ${args.format || 'mp4'}${where}`;
    case 'computer_ocr': return 'read text (ocr)';
    case 'computer_uitree': return `ui tree${where}`;
    case 'computer_ui_action': return `ui ${args.kind || 'act'} "${String(args.name || '').slice(0, 20)}"`;
    case 'computer_cdp': return `browser ${args.action || ''}${args.target ? ` · ${String(args.target).slice(0, 24)}` : ''}`;
    default: return name.replace(/^computer_/, '');
  }
}


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


// ------------------------------------------------------------------ system prompt
const CUA_PROMPT = [
  'Computer use: the computer_* tools drive the real desktop (windows, clicks, typing,',
  'browser tabs, screenshots, recordings, OCR, Chrome DevTools).',
  '',
  'When to use them: anything that is only reachable through a GUI - an app with no CLI,',
  'a browser page that needs a login, a native dialog, a canvas or video frame that must be',
  'read. Prefer shell/file tools whenever they can do the job.',
  '',
  'Be proactive: if the user asks for something and the only way is the GUI, say so briefly',
  'and offer to do it with computer use instead of silently refusing.',
  '',
  'Consent rules:',
  '- Driving ONE app or ONE browser tab (pass window or pid / a CDP target) needs no special',
  '  permission; just do it and report what you touched.',
  '- Driving the WHOLE SCREEN (click/type/scroll without window or pid) takes the mouse and',
  '  keyboard away from the user. Before the first such call, ask whether they are ready to',
  '  leave the machine alone, then pass user_ready: true. A banner "DeepSeek using your',
  '  computer" appears on screen meanwhile.',
  '- If the user presses ESC, the next call fails with STOPPED and the marker stays for 15',
  '  minutes: ask whether to continue, then retry with user_ready: true.',
  '- Never fight the user for the cursor: if they take over, stop and ask.',
].join('\n');

// ------------------------------------------------------------------- catalogue
export const TOOLS = [
  {
    name: 'computer_windows',
    description: 'List top-level windows with pid, process, title, size and hwnd. Start here: pick a window by title, then act on it.',
    parameters: {},
    run: () => ({ action: 'windows' })
  },
  {
    name: 'computer_shot',
    description: 'Screenshot a window or the screen. method "print" captures the window even when it is covered by other apps (Chromium/Electron supported); "screen" copies visible pixels. With width+height it returns a cropped region. The image is attached to the result, so it appears in the chat.',
    parameters: {
      window: { type: 'string', description: 'Window title or process name substring' },
      pid: { type: 'integer', description: 'Target this process id instead of a title' },
      path: { type: 'string', description: 'Output PNG path (absolute recommended)' },
      method: { type: 'string', enum: ['print', 'screen'], description: 'print = occlusion-proof window render' },
      x: { type: 'integer', description: 'Region left, window-relative' },
      y: { type: 'integer', description: 'Region top, window-relative' },
      width: { type: 'integer', description: 'Region width' },
      height: { type: 'integer', description: 'Region height' }
    },
    run: (a) => ({ action: 'shot', window: a.window, processId: a.pid, path: a.path, method: a.method || 'print', x: a.x, y: a.y, width: a.width, height: a.height })
  },
  {
    name: 'computer_click',
    description: 'Click at a point. With "window" given, coordinates are window-relative and the window is focused first; otherwise they are screen coordinates.',
    parameters: {
      user_ready: { type: 'boolean', description: 'Set true only after the user agreed to let the agent drive the whole screen (not needed when window/pid is given)' },
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      double: { type: 'boolean', description: 'Double click' },
      right: { type: 'boolean', description: 'Right button' }
    },
    run: (a) => ({ action: 'click', window: a.window, processId: a.pid, x: a.x, y: a.y, double: a.double, right: a.right })
  },
  {
    name: 'computer_drag',
    description: 'Press, move and release between two points (coordinates are window-relative when "window" is given).',
    parameters: {
      user_ready: { type: 'boolean', description: 'Set true only after the user agreed to let the agent drive the whole screen (not needed when window/pid is given)' },
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      x: { type: 'integer', description: 'Start X' },
      y: { type: 'integer', description: 'Start Y' },
      x2: { type: 'integer', description: 'End X' },
      y2: { type: 'integer', description: 'End Y' },
      steps: { type: 'integer', description: 'Intermediate moves, default 18' }
    },
    run: (a) => ({ action: 'drag', window: a.window, processId: a.pid, x: a.x, y: a.y, x2: a.x2, y2: a.y2, steps: a.steps })
  },
  {
    name: 'computer_type',
    description: 'Type text into the focused control. Non-ASCII needs unicode: true (plain typing uses SendKeys and mangles it).',
    parameters: {
      user_ready: { type: 'boolean', description: 'Set true only after the user agreed to let the agent drive the whole screen (not needed when window/pid is given)' },
      text: { type: 'string', description: 'Text to type' },
      unicode: { type: 'boolean', description: 'SendInput with unicode codepoints (non-ASCII)' }
    },
    run: (a) => ({ action: 'type', text: a.text, unicode: a.unicode })
  },
  {
    name: 'computer_key',
    description: 'Send a key combination in SendKeys syntax: "^c" copy, "%{F4}" alt+F4, "{ENTER}", "^+{ESC}".',
    parameters: {
      user_ready: { type: 'boolean', description: 'Set true only after the user agreed to let the agent drive the whole screen (not needed when window/pid is given)' }, text: { type: 'string', description: 'SendKeys sequence' } },
    run: (a) => ({ action: 'key', text: a.text })
  },
  {
    name: 'computer_scroll',
    description: 'Scroll the mouse wheel at a point. Negative delta scrolls down.',
    parameters: {
      user_ready: { type: 'boolean', description: 'Set true only after the user agreed to let the agent drive the whole screen (not needed when window/pid is given)' },
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      delta: { type: 'integer', description: 'Wheel delta, e.g. -600' }
    },
    run: (a) => ({ action: 'scroll', window: a.window, processId: a.pid, x: a.x, y: a.y, delta: a.delta })
  },
  {
    name: 'computer_focus',
    description: 'Bring a window to the foreground (best effort: the Windows foreground lock may refuse).',
    parameters: {
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' }
    },
    run: (a) => ({ action: 'focus', window: a.window, processId: a.pid })
  },
  {
    name: 'computer_tabs',
    description: 'List the tabs of a Chrome/Edge window through UI Automation, with the active one marked.',
    parameters: { window: { type: 'string', description: 'Browser window title or process name' } },
    run: (a) => ({ action: 'tabs', window: a.window })
  },
  {
    name: 'computer_tab',
    description: 'Select a browser tab by title substring through UI Automation (no mouse, no focus).',
    parameters: {
      title: { type: 'string', description: 'Tab title substring' },
      window: { type: 'string', description: 'Browser window' }
    },
    run: (a) => ({ action: 'tab', text: a.title, window: a.window })
  },
  {
    name: 'computer_wait',
    description: 'Wait for a window or a UI element with matching text; returns window-ready or timeout instead of polling screenshots.',
    parameters: {
      window: { type: 'string', description: 'Window title substring' },
      text: { type: 'string', description: 'UI element name substring' },
      timeout: { type: 'integer', description: 'Timeout in ms' }
    },
    run: (a) => ({ action: 'wait', window: a.window, text: a.text, timeout: a.timeout })
  },
  {
    name: 'computer_clipboard',
    description: 'Read the clipboard, or set it when text is given. A quick way to pull text out of a console or field.',
    parameters: { text: { type: 'string', description: 'Text to put on the clipboard' } },
    run: (a) => ({ action: 'clipboard', text: a.text })
  },
  {
    name: 'computer_window',
    description: 'Window control: move, resize, min, max, normal (also clears always-on-top), topmost, untopmost, park (off every monitor) and unpark.',
    parameters: {
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      op: { type: 'string', enum: ['move', 'resize', 'min', 'max', 'normal', 'topmost', 'untopmost', 'park', 'unpark'], description: 'Operation' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' }
    },
    run: (a) => ({ action: 'window', window: a.window, processId: a.pid, op: a.op || 'normal', x: a.x, y: a.y, width: a.width, height: a.height })
  },
  {
    name: 'computer_launch',
    description: 'Start an application. park: true keeps it out of the way (Chromium gets --window-position=-6000,-6000, other apps are moved off-screen), so it never covers the users work.',
    parameters: {
      path: { type: 'string', description: 'Executable path' },
      args: { type: 'string', description: 'Command line arguments' },
      timeout: { type: 'integer', description: 'Window wait timeout ms' },
      park: { type: 'boolean', description: 'Launch silently off-screen' }
    },
    run: (a) => ({ action: 'launch', path: a.path, launchArgs: a.args, timeout: a.timeout, park: a.park })
  },
  {
    name: 'computer_record',
    description: 'Save a frame sequence of a window into a folder (occlusion-proof PNG frames) and return the directory.',
    parameters: {
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      frames: { type: 'integer', description: 'Frame count, default 10' },
      interval: { type: 'integer', description: 'Delay between frames ms' },
      dir: { type: 'string', description: 'Output directory' }
    },
    run: (a) => ({ action: 'record', window: a.window, processId: a.pid, frames: a.frames, interval: a.interval, path: a.dir })
  },
  {
    name: 'computer_video',
    description: 'Record a short clip of a window. Frames come from PrintWindow, so a covered Chromium/Electron window still records correctly. format "gif" produces an animated gif that the chat shows inline; mp4 returns the clip path plus a poster frame.',
    parameters: {
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      frames: { type: 'integer', description: 'Frame count, default 30' },
      interval: { type: 'integer', description: 'Delay between frames ms (sets fps)' },
      path: { type: 'string', description: 'Output path (.mp4 or .gif)' },
      format: { type: 'string', enum: ['mp4', 'gif'], description: 'mp4 (default) or an animated gif' }
    },
    run: (a) => ({ action: 'video', window: a.window, processId: a.pid, frames: a.frames, interval: a.interval, path: a.path, format: a.format || 'mp4' })
  },
  {
    name: 'computer_ocr',
    description: 'Read text from an image with the Windows OCR engine (offscreen canvas, video frames, games). No network involved.',
    parameters: { path: { type: 'string', description: 'PNG/JPEG path' } },
    run: (a) => ({ action: 'ocr', path: a.path })
  },
  {
    name: 'computer_uitree',
    description: 'Dump the UI Automation tree of a window: control type, name, bounds. Optional text filter and depth.',
    parameters: {
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      text: { type: 'string', description: 'Only nodes whose name or type contains this' },
      depth: { type: 'integer', description: 'Max depth, default 6' }
    },
    run: (a) => ({ action: 'uitree', window: a.window, processId: a.pid, text: a.text, depth: a.depth })
  },
  {
    name: 'computer_ui_action',
    description: 'Act on a native control through UI Automation without focusing the window: invoke, toggle, select, expand or set value.',
    parameters: {
      window: { type: 'string' },
      pid: { type: 'integer', description: 'Target this process id' },
      name: { type: 'string', description: 'Element name substring' },
      kind: { type: 'string', enum: ['invoke', 'toggle', 'select', 'expand', 'value'], description: 'Preferred pattern' },
      value: { type: 'string', description: 'Value for kind=value' }
    },
    run: (a) => ({ action: 'uiact', window: a.window, processId: a.pid, text: a.name,
      value: a.kind === 'value' ? (a.value || '') : '' })
  },
  {
    name: 'computer_cdp',
    description: 'Chrome DevTools Protocol for Chromium/Electron started with --remote-debugging-port: list targets, evaluate JS, dump DOM, screenshot a tab (no occlusion), drive input in the BACKGROUND (no focus, no cursor), sample frame timing or write a trace.',
    parameters: {
      port: { type: 'integer', description: 'Debug port, default 9222' },
      action: { type: 'string', enum: ['list', 'eval', 'dom', 'shot', 'perf', 'trace', 'navigate', 'click', 'drag', 'type', 'key', 'scroll'], description: 'Operation; click/type/key/scroll run in the background' },
      target: { type: 'string', description: 'Target id, url or title substring' },
      expression: { type: 'string', description: 'JS for eval' },
      path: { type: 'string', description: 'PNG path for shot, JSON path for trace' },
      duration: { type: 'integer', description: 'Perf/trace sampling window ms' },
      x: { type: 'integer', description: 'Click/scroll X inside the page' },
      y: { type: 'integer', description: 'Click/scroll Y inside the page' },
      x2: { type: 'integer', description: 'Drag end X' },
      y2: { type: 'integer', description: 'Drag end Y' },
      text: { type: 'string', description: 'Text for action=type' },
      keys: { type: 'string', description: 'Combo for action=key, e.g. CTRL+V' },
      delta: { type: 'integer', description: 'Wheel delta for action=scroll' },
      url: { type: 'string', description: 'URL for action=navigate' }
    },
    run: (a) => ({ cdp: { port: a.port, action: a.action, target: a.target, expression: a.expression, path: a.path, duration: a.duration, x: a.x, y: a.y, x2: a.x2, y2: a.y2, text: a.text, keys: a.keys, delta: a.delta, url: a.url } })
  }
];

// ---------------------------------------------------------------------- wiring
export function apply(ctx, config = {}) {
  // The tools service may not exist yet when the bundle applies; cordis injects it
  // and calls us once it does (same pattern as dsh-artifact-panes).
  if (typeof ctx.inject !== 'function') {
    console.warn('[dsh-computer-use] ctx.inject unavailable; nothing registered');
    return () => {};
  }
  // Tell every new session what these tools are for, and when to ask first.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], (promptCtx) => {
        try {
          promptCtx.effect(() => {
            const prompt = typeof promptCtx.get === 'function' ? promptCtx.get('systemPrompt') : null;
            if (!prompt || typeof prompt.section !== 'function') return () => {};
            const dispose = prompt.section({ name: 'tool:computer-use', order: 120, text: CUA_PROMPT });
            return () => { try { if (typeof dispose === 'function') dispose(); } catch (error) {} };
          }, 'dsh-computer-use: system prompt');
        } catch (error) {
          console.warn('[dsh-computer-use] system prompt section failed:', String(error && error.message || error).slice(0, 160));
        }
        return () => {};
      });
    } catch (error) {}
  }

  ctx.inject(['tools'], (toolCtx) => {
    const disposers = [];
    toolCtx.effect(() => {
      const tools = typeof toolCtx.get === 'function' ? toolCtx.get('tools') : null;
      if (!tools || typeof tools.register !== 'function') {
        console.warn('[dsh-computer-use] tools service unavailable');
        return () => {};
      }
      return import('@deepseek-ai/dsh-tools').then((mod) => {
        const defineTool = mod.defineTool;
        if (typeof defineTool !== 'function') throw new Error('defineTool missing');

        for (const spec of TOOLS) {
          disposers.push(tools.register(defineTool({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
            timeoutMs: 120000,
            isConcurrencySafe: () => false,
            output: {
              schema: {
                // The host value-schema DSL rejects `required` and demands an
                // explicit `additionalProperties` flag. `image` is the inline
                // attachment the chat renders.
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  text: { type: 'string' },
                  image: { type: 'object', additionalProperties: true, properties: {} }
                }
              },
              render: (_args, value) => {
                const blocks = [{ type: 'text', text: String(value && value.text || '') }];
                if (value && value.image && value.image.attachmentId) blocks.push({ type: 'image', attachment: value.image });
                return blocks;
              }
            },
            execute: async (args) => {
              const { engine, cdp } = await import('./tools/engine.mjs');

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

              const call = spec.run(args || {});
              if (call && call.cdp) {
                const c = call.cdp;
                return cdp({
                  port: c.port,
                  ...(c.action === 'list' ? { List: true } : {}),
                  ...(c.action === 'eval' ? { Eval: c.expression } : {}),
                  ...(c.action === 'dom' ? { Dom: true } : {}),
                  ...(c.action === 'shot' ? { Shot: c.path } : {}),
                  ...(c.action === 'perf' ? { Perf: c.duration || 3000 } : {}),
                  ...(c.action === 'trace' ? { Trace: c.path, Perf: c.duration || 3000 } : {}),
                  ...(c.action === 'navigate' ? { Navigate: c.url } : {}),
                  ...(c.action === 'click' ? { Click: `${c.x},${c.y}` } : {}),
                  ...(c.action === 'drag' ? { Drag: `${c.x},${c.y},${c.x2},${c.y2}` } : {}),
                  ...(c.action === 'type' ? { Type: c.text } : {}),
                  ...(c.action === 'key' ? { Key: c.keys } : {}),
                  ...(c.action === 'scroll' ? { Scroll: `${c.x},${c.y}`, Delta: c.delta || -300 } : {}),
                  ...(c.target ? { Target: c.target } : {})
                });
              }
              const engineArgs = {};
              for (const [key, value] of Object.entries(call)) {
                if (key === 'action') { engineArgs.Action = value; continue; }
                // ui tree depth travels on the engine's -Delta parameter.
                const name = key === 'depth' ? 'Delta' : key.charAt(0).toUpperCase() + key.slice(1);
                engineArgs[name] = value;
              }
              engineArgs.Overlay = true;
              const result = await engine(engineArgs);
              if (result && result.text) {
                const parsed = stripOverlay(result.text);
                if (parsed.rect && CUA_OVERLAY) pushOverlay(parsed.hwnd, parsed.rect, parsed.click, captionFor(spec.name, args), screenWide || args.window === undefined && args.pid === undefined ? 'screen' : 'window');
                if (parsed.rect) result.text = parsed.text;
              }
              try {
                if (result && result.ok && (spec.name === 'computer_shot' || spec.name === 'computer_video')) {
                  const produced = spec.name === 'computer_shot'
                    ? String(result.text || '').trim()
                    : ((String(result.text || '').match(/([A-Za-z]:[^\s()]+\.(?:mp4|gif))/i) || [])[1] || '');
                  // An mp4 cannot be shown inline, so attach its poster frame; a gif
                  // (animated) is attached as-is, like a screenshot.
                  const mediaPath = produced && produced.toLowerCase().endsWith('.mp4')
                    ? produced.replace(/\.mp4$/i, '.png')
                    : produced;
                  const image = await attachImage(toolCtx, mediaPath);
                  if (image) return { ok: true, text: result.text, image };
                }
              } catch (error) {}
              return result;
            }
          })));
        }
        // Boot receipt: after a restart this line proves the host registered the
        // tools, without needing a UI inspection.
        try {
          appendFileSync(`${tmpdir()}/dsh-computer-use.log`, `${new Date().toISOString()} pid=${process.pid} registered ${TOOLS.length} tools\n`);
        } catch (error) {}
        console.info(`[dsh-computer-use] registered ${TOOLS.length} tools`);
        return () => {};
      }).catch((error) => {
        console.warn('[dsh-computer-use] tool registration failed:', String(error && error.message || error).slice(0, 300));
      });
    }, 'dsh-computer-use: tools');

    // Disposal is owned by the injection: cordis releases the tools when the
    // scope goes away.
    return () => { for (const dispose of disposers.reverse()) { try { dispose(); } catch (error) {} } };
  });
}