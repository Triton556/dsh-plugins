// Engine bridge: every computer-use tool ultimately drives either the Windows
// PowerShell engine (tools/cua.ps1) or the Chrome DevTools Protocol helper
// (tools/cdp.mjs). Both are bundled in this package so the plugin is portable.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ENGINE = fileURLToPath(new URL('./cua.ps1', import.meta.url));
const CDP = fileURLToPath(new URL('./cdp.mjs', import.meta.url));

function run(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
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

export async function engine(options) {
  // Free text goes through a UTF-8 file: quotes, backticks and semicolons then
  // survive any Windows/PowerShell command-line parsing untouched.
  const args = { ...options };
  let scratch = null;
  let usedScratch = false;
  for (const [key, fileKey] of [['Text', 'TextFile'], ['LaunchArgs', 'LaunchArgsFile']]) {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    scratch = scratch || mkdtempSync(join(tmpdir(), 'dsh-cua-'));
    const file = join(scratch, `${key.toLowerCase()}.txt`);
    writeFileSync(file, value, { encoding: 'utf8' });
    delete args[key];
    args[fileKey] = file;
    usedScratch = true;
  }
  try {
    return await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ENGINE, ...argv(args)]);
  } finally {
    // The engine consumes the files; remove the directory so repeated calls do
    // not litter the temp folder.
    if (usedScratch && scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch {}
    }
  }
}

export function cdp(options) {
  // cdp.mjs reads -Port/-Target style switches; callers may pass lowercase
  // field names from the tool schema, so normalise the two that differ.
  const normalized = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (key === 'port') normalized.Port = value;
    else if (key === 'target') normalized.Target = value;
    else normalized[key] = value;
  }
  return run(process.execPath, [CDP, ...argv(normalized)], { timeoutMs: 60000 });
}

export const paths = { HERE, ENGINE, CDP };