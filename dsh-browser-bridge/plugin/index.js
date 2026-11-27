// dsh-browser-bridge - DSH tools over the local browser bridge.
//
// Every tool is a thin wrapper over bridge.mjs: JSON goes in on stdin, the reply
// comes back as JSON. The extension and its native host do the actual work, so
// this package never touches a browser directly.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const inject = [];

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BRIDGE = join(HERE, 'bridge.mjs');

function runBridge(request, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], { windowsHide: true });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, text: 'bridge spawn failed: ' + error.message });
    });
    // Early child exit may close stdin before the request is written. Report the
    // child result rather than crashing the DSH host with an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (timedOut) resolve({ ok: false, text: 'Browser bridge timed out.' });
      else if (code === 0) resolve({ ok: true, text: out || err });
      else resolve({ ok: false, text: (out || err || `bridge exited (${code})`).slice(0, 4000) });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function spec(name, description, parameters, build) {
  return { name, description, parameters, build };
}

export const TOOLS = [
  spec('browser_ping', 'Check that the browser bridge is alive: host name, attached and claimed tabs.', {}, () => ({ cmd: 'ping' })),
  spec('browser_tabs', 'List open tabs with id, windowId, title, url, active, claimed.', {}, () => ({ cmd: 'tabs.list' })),
  spec('browser_claim', 'Claim one tab for this session. Refuses when title or url no longer match the expected snapshot.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string', description: 'Title or url substring' },
    expectTitle: { type: 'string' },
    expectUrl: { type: 'string' },
  }, (a) => ({ cmd: 'tabs.claim', args: pick(a) })),
  spec('browser_release', 'Release a claimed tab and detach the debugger.', { tabId: { type: 'integer' }, tabMatch: { type: 'string' } },
    (a) => ({ cmd: 'tabs.release', args: pick(a) })),
  spec('browser_ax', 'Accessibility snapshot of one tab: index, role, name, value, backendNodeId, optional bounds. The index feeds browser_click and browser_value.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    limit: { type: 'integer', description: 'Max nodes, default 400' },
    bounds: { type: 'boolean', description: 'Also compute element boxes (max 60 nodes)' },
  }, (a) => ({ cmd: 'ax.snapshot', args: pick(a) })),
  spec('browser_click', 'Click an accessibility node by its index from browser_ax. Real trusted click at the element centre.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    index: { type: 'integer' },
  }, (a) => ({ cmd: 'ax.click', args: pick(a) })),
  spec('browser_value', 'Set the value of a form field by accessibility index, firing input and change events.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    index: { type: 'integer' },
    value: { type: 'string' },
  }, (a) => ({ cmd: 'ax.setValue', args: pick(a) })),
  spec('browser_type', 'Type text into the focused element of a tab.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    text: { type: 'string' },
  }, (a) => ({ cmd: 'input.type', args: pick(a) })),
  spec('browser_key', 'Press key combination(s) in a tab; the tab is activated first because keyboard events only reach the active tab.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    keys: { type: 'string', description: 'Comma separated, e.g. "ENTER" or "CTRL+A"' },
  }, (a) => ({ cmd: 'input.key', args: pick(a) })),
  spec('browser_navigate', 'Navigate a tab to a URL and wait until the document is complete.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    url: { type: 'string' },
  }, (a) => ({ cmd: 'page.navigate', args: pick(a) })),
  spec('browser_shot', 'Screenshot the tab viewport (PNG or JPEG) and save it to a file.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    format: { type: 'string', enum: ['png', 'jpeg'] },
    out: { type: 'string' },
  }, (a) => ({ cmd: 'page.shot', args: pick(a) })),
  spec('browser_wait', 'Wait inside a tab for a selector or a text to appear.', {
    tabId: { type: 'integer' },
    tabMatch: { type: 'string' },
    selector: { type: 'string' },
    text: { type: 'string' },
    timeoutMs: { type: 'integer' },
  }, (a) => ({ cmd: 'page.wait', args: pick(a) })),
];

function pick(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined || value === null || (value === '' && key !== 'value')) continue;
    out[key] = value;
  }
  return out;
}

export function apply(ctx) {
  ctx.inject(['tools'], (toolCtx) => {
    return import('@deepseek-ai/dsh-tools').then((mod) => {
      const defineTool = mod.defineTool;
      const disposers = [];
      for (const tool of TOOLS) {
        disposers.push(toolCtx.get('tools').register(defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          timeoutMs: 90000,
          isConcurrencySafe: () => false,
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
            },
            render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
          },
          execute: async (args) => runBridge(tool.build(args || {})),
        })));
      }
      return () => { for (const dispose of disposers.reverse()) { try { dispose(); } catch {} } };
    });
  });
}
