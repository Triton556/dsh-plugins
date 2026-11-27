// Engine bridge: every computer-use tool ultimately drives the Windows
// PowerShell engine (tools/cua.ps1). It is bundled with the package so the
// plugin stays portable.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const COOPERATIVE_MOUSE_ACTIONS = new Set(['click', 'drag', 'hit']);
const ENGINE = fileURLToPath(new URL('./cua.ps1', import.meta.url));

function run(command, args, { timeoutMs = 30000, onLine, cooperative = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = cooperative ? undefined : setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    let lineBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!onLine) return;
      const lines = (lineBuffer + chunk).split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) { try { onLine(line.trimEnd()); } catch {} }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `spawn failed: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      const err = stderr.trim();
      if (code === 0) resolve({ ok: true, text: text || 'ok' });
      else resolve({ ok: false, text: [text, err].filter(Boolean).join('\n').slice(0, 4000) || `exit ${code}` });
    });
  });
}

// Only pass switches the caller actually supplied: the engine is strict about
// unknown parameter names and empty values would override its defaults.
function argv(options = {}) {
  const args = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (value === true) { args.push(`-${key}`); continue; }
    args.push(`-${key}`, String(value));
  }
  return args;
}

export async function engine(options, hooks) {
  // Free text goes through a UTF-8 file: quotes, backticks and semicolons then
  // survive any Windows/PowerShell command-line parsing untouched.
  const args = { ...options };
  const timeoutMs = hooks?.timeoutMs ?? 30000;
  const cooperative = COOPERATIVE_MOUSE_ACTIONS.has(String(args.Action ?? args.action).toLowerCase());
  // Never terminate the mouse worker on a deadline. While it owns a press,
  // termination would skip mouse-up. The worker checks the deadline itself.
  args.DeadlineMs = Date.now() + timeoutMs;
  let scratch = null;
  let usedScratch = false;
  for (const [key, fileKey] of [['Text', 'TextFile'], ['LaunchArgs', 'LaunchArgsFile'], ['Value', 'ValueFile']]) {
    const value = args[key];
    if (typeof value !== 'string' || (value.length === 0 && key !== 'Value')) continue;
    scratch = scratch || mkdtempSync(join(tmpdir(), 'dsh-cua-'));
    const file = join(scratch, `${key.toLowerCase()}.txt`);
    writeFileSync(file, value, { encoding: 'utf8' });
    delete args[key];
    args[fileKey] = file;
    usedScratch = true;
  }
  try {
    return await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ENGINE, ...argv(args)], { ...hooks, timeoutMs, cooperative });
  } finally {
    // The engine consumes the files; remove the directory so repeated calls do
    // not litter the temp folder.
    if (usedScratch && scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch {}
    }
  }
}

export const paths = { HERE, ENGINE };
