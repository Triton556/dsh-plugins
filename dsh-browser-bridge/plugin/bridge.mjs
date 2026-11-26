// DSH Browser Bridge - local client.
//
// Sends one JSON request to the native host over the named pipe and prints the
// JSON reply. The request comes from argv[2] or stdin, so callers never fight
// with shell quoting:
//
//   node bridge.mjs '{"cmd":"ping"}'
//   node bridge.mjs '{"cmd":"tabs.list"}'
//   echo '{"cmd":"ax.snapshot","args":{"tabMatch":"yourvm","limit":80,"bounds":true}}' | node bridge.mjs
//
// Optional args: out (write page.shot to this path), raw (compact JSON).

import { connect } from 'node:net';
import { writeFileSync } from 'node:fs';

const PIPE = '\\\\.\\pipe\\dsh-browser-bridge';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

const argRequest = process.argv[2] && process.argv[2].trim().startsWith('{') ? process.argv[2] : null;
const payload = (argRequest || (await readStdin())).trim();
if (!payload) {
  console.error('usage: node bridge.mjs \'{"cmd":"ping"}\'   (or JSON on stdin)');
  process.exit(2);
}

let request;
try { request = JSON.parse(payload); } catch (error) { console.error('invalid JSON request: ' + error.message); process.exit(2); }

if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.cmd !== 'string' || !request.cmd.trim() ||
    (request.args != null && (typeof request.args !== 'object' || Array.isArray(request.args)))) {
  console.error('invalid bridge request: expected an object with cmd and optional object args');
  process.exit(2);
}
request.id = request.id || 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
if (!request.args) request.args = {};

const outPath = request.args.out;
const wantRaw = request.args.raw;
delete request.args.out;
delete request.args.raw;

const reply = await new Promise((resolve, reject) => {
  const socket = connect(PIPE);
  let buffer = '';
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error('bridge timeout (60s): is the DSH Browser Bridge extension loaded and its native host registered?'));
  }, 60000);
  socket.setEncoding('utf8');
  socket.on('connect', () => { socket.write(JSON.stringify(request) + '\n'); });
  socket.on('data', (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline >= 0) {
      clearTimeout(timer);
      socket.end();
      resolve(buffer.slice(0, newline));
    }
  });
  socket.on('error', (error) => { clearTimeout(timer); reject(new Error('bridge pipe error: ' + error.message)); });
  socket.on('end', () => { clearTimeout(timer); reject(new Error('browser bridge closed before sending a reply')); });
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
  return null;
});
if (reply === null) process.exit(1);

let parsed;
try { parsed = JSON.parse(reply); } catch (error) { console.error('invalid reply from bridge: ' + reply.slice(0, 200)); process.exit(1); }

if (!parsed || typeof parsed !== 'object' || parsed.id !== request.id || typeof parsed.ok !== 'boolean') {
  console.error('invalid reply from browser bridge: mismatched request ID or missing status');
  process.exit(1);
}

if (outPath && parsed.ok && parsed.data && parsed.data.data) {
  const bytes = Buffer.from(parsed.data.data, 'base64');
  writeFileSync(outPath, bytes);
  parsed.data = { tabId: parsed.data.tabId, format: parsed.data.format, saved: outPath, bytes: bytes.length };
}

process.stdout.write(JSON.stringify(parsed, null, wantRaw ? 0 : 2) + '\n');
if (!parsed.ok) process.exitCode = 1;
