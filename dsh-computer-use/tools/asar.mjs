// Minimal read-only ASAR reader (Electron archive): list, grep and extract
// entries without touching the packaged app. Usage:
//   node asar.mjs list  <asar> [substring]
//   node asar.mjs grep  <asar> <substring> [regex] [limit]
//   node asar.mjs extract <asar> <substring> <outDir>
import fs from 'node:fs';
import path from 'node:path';

function open(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(8);
  const jsonLen2 = head.readUInt32LE(12);
  const tryParse = (off, len) => {
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, off);
    try { return JSON.parse(b.toString('utf8')); } catch { return null; }
  };
  let header = tryParse(16, jsonLen2) || tryParse(12, jsonLen2) || tryParse(16, jsonLen);
  if (!header) { header = tryParse(12, jsonLen) || tryParse(16, headerSize - 8); }
  if (!header) throw new Error('cannot parse asar header');
  const base = 8 + headerSize;
  const read = (entry) => {
    if (entry.unpacked) return null;
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
    return buf;
  };
  const walk = (node, prefix, out) => {
    for (const [name, value] of Object.entries(node.files || {})) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (value.files) walk(value, full, out);
      else out.push({ path: full, entry: value });
    }
  };
  const files = [];
  walk(header, '', files);
  return { size, files, read, close: () => fs.closeSync(fd) };
}

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || !file) { console.error('usage: asar.mjs <list|grep|extract> <asar> ...'); process.exit(2); }
const asar = open(file);

if (cmd === 'list') {
  const needle = (rest[0] || '').toLowerCase();
  const rows = asar.files.filter(f => f.path.toLowerCase().includes(needle));
  console.log(`${rows.length} entries`);
  for (const r of rows.slice(0, 200)) console.log(String(r.entry.size).padStart(9), r.path);
} else if (cmd === 'grep') {
  const needle = rest[0] || '';
  const re = rest[1] ? new RegExp(rest[1], 'g') : null;
  const limit = Number(rest[2] || 40);
  const hits = [];
  for (const f of asar.files) {
    if (!/\.(js|mjs|cjs|css|json|html)$/i.test(f.path)) continue;
    if (f.entry.size > 8 * 1024 * 1024) continue;
    let text;
    try { text = asar.read(f.entry)?.toString('utf8'); } catch { continue; }
    if (!text || !text.includes(needle)) continue;
    const idx = text.indexOf(needle);
    hits.push({ path: f.path, size: f.entry.size, at: idx, snippet: text.slice(Math.max(0, idx - 160), idx + 240).replace(/\s+/g, ' ') });
    if (hits.length >= limit) break;
  }
  console.log(`${hits.length} files contain "${needle}"`);
  for (const h of hits) { console.log(`\n--- ${h.path} (${h.size} bytes, at ${h.at})\n${h.snippet}`); }
  asar.close();
} else if (cmd === 'extract') {
  const needle = rest[0] || '';
  const outDir = rest[1] || 'asar-out';
  let n = 0;
  for (const f of asar.files) {
    if (!f.path.includes(needle)) continue;
    const buf = asar.read(f.entry);
    if (!buf) continue;
    const target = path.join(outDir, f.path.replace(/[\\/]/g, path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    n += 1;
  }
  console.log(`extracted ${n} entries to ${outDir}`);
  asar.close();
}